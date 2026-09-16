import { stepCountIs, streamText } from 'ai';
import { NextResponse } from 'next/server';

import {
  createClient,
  getServiceRoleSupabaseClient,
  verifyPackageOnline,
} from '@nextblock-cms/db/server';
import {
  buildCortexAiRoutingPolicy,
  buildVisibleContactIntroActionPlan,
  cortexAiPageContextSchema,
  createCortexGlobalAgentTools,
  createCortexAiOpenRouterClient,
  executeCmsActionPlan,
  executeCreateCmsPage,
  executeCreateCmsPost,
  executeCreateCmsProduct,
  executeDatabaseActionPlan,
  executeDatabaseMutation,
  executeDeleteCmsItem,
  executeDeleteCustomBlock,
  executeFinishSiteBuild,
  executeGetSiteOverview,
  executeInsertContentBlock,
  executeResetSiteContent,
  executeRewritePageDraft,
  executeSetContentImages,
  executeStartSiteBuild,
  executeTranslatePage,
  executeUpdateContentBlock,
  executeUpdateCmsItemField,
  executeUpdateCurrentCmsFields,
  executeUpdateFooter,
  executeUpdateNavigationBar,
  executeUpdateSectionColumnBlock,
  executeUpdateSiteIdentity,
  formatCortexSiteBriefForPrompt,
  formatCortexSiteOverviewForPrompt,
  getOpenRouterErrorStatus,
  isOpenRouterRateLimitError,
  isOpenRouterRecoverableRoutingError,
  omitUnsupportedCortexAiModelOptions,
  isCortexSiteBriefComplete,
  readCortexSiteBrief,
  resolveCortexAiAgentSettings,
  resolveCortexAiStockPhotoProvider,
  resolveCortexBuildSession,
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
  type CortexAiPageContext,
  type CortexBuildSession,
  type CortexSiteBrief,
  type CortexSiteOverview,
  z,
} from '@nextblock-cms/cortex';
import { validateBlockContent } from '../../../../lib/blocks/blockRegistry';
import { importExternalImageToMedia } from '../../../cms/media/import-external-image';
import {
  captureRevisionBaseline,
  commitRevisionFromBaseline,
} from '../../../cms/revisions/service';
import type { AnyFullContent } from '../../../cms/revisions/utils';

export const dynamic = 'force-dynamic';

// Idle (not absolute) timeout: the attempt is only aborted after this many ms
// with NO stream activity. A slow-but-progressing generation (e.g. building a
// full multi-section page, which streams tool-input deltas for a while) keeps
// resetting the timer instead of being killed mid-answer.
const GLOBAL_AGENT_MODEL_IDLE_TIMEOUT_MS = 120000;

// Heartbeat sent to the browser every few seconds while an attempt streams, so a
// long tool-call generation (which produces no client-facing events) keeps the
// client's idle timer alive and shows a "working" indicator instead of looking
// frozen.
const GLOBAL_AGENT_HEARTBEAT_INTERVAL_MS = 5000;

// Bridges the app-side media importer (sharp + storage, request-scoped auth) into
// the Cortex tool context so image tools can turn an external URL (e.g. a stock
// photo) into a media library id for feature_image_id / product_media.
async function importExternalImageForCortex(input: {
  url: string;
  altText?: string;
}): Promise<{ id: string } | { error: string }> {
  const result = await importExternalImageToMedia({ altText: input.altText, url: input.url });

  if ('error' in result) {
    return { error: result.error };
  }

  return { id: result.media.id };
}

/**
 * Bridges the app's revision engine into the Cortex tool context so that content the agent
 * writes straight to the live tables lands in Revision History like any other edit.
 *
 * Every AI write goes through here, including the ones inside a multi-step action plan —
 * the callback lives on the tool context, not on the route, so it also covers the executors
 * that run in-stream rather than via the Confirm button.
 *
 * `authorId` is the admin whose session authorised the request; the agent's Supabase client
 * is service-role, so without this the revision row would land with a null author.
 */
function createCortexRevisionRecorder(authorId: string | null) {
  return async function recordRevision(input: {
    baseline?: unknown;
    contentType: 'page' | 'post' | 'product';
    entityId: number | string;
    phase: 'capture' | 'commit';
  }): Promise<unknown> {
    if (input.phase === 'capture') {
      return captureRevisionBaseline(input.contentType, input.entityId);
    }

    const result = await commitRevisionFromBaseline(
      input.contentType,
      input.entityId,
      authorId,
      (input.baseline ?? null) as AnyFullContent | null
    );

    if ('error' in result) {
      console.error('Cortex AI: revision not recorded —', result.error);
    }

    return undefined;
  };
}

const globalAgentMessageSchema = z.strictObject({
  content: z.string().min(1).max(8000),
  role: z.enum(['system', 'user', 'assistant']),
});

const confirmedToolCallSchema = z.strictObject({
  confirmationPhrase: z.string().min(1).max(500),
  input: z.unknown(),
  toolName: z.enum([
    'create_cms_page',
    'create_cms_post',
    'create_cms_product',
    'delete_cms_item',
    'delete_custom_block',
    'execute_database_action_plan',
    'execute_database_mutation',
    'execute_cms_action_plan',
    'insert_content_block',
    'reset_site_content',
    'rewrite_page_draft',
    'set_content_images',
    'start_site_build',
    'translate_page',
    'update_cms_item_field',
    'update_content_block',
    'update_current_cms_fields',
    'update_footer',
    'update_navigation_bar',
    'update_section_column_block',
    'update_site_identity',
  ]),
});

const globalAgentRequestSchema = z.strictObject({
  /**
   * The build session the client believes is open (from a start_site_build result).
   * Honoured only when it matches the session stored server-side for THIS admin and
   * has not expired; a stale or foreign id simply runs the request in normal mode.
   */
  buildSessionId: z.string().min(1).max(120).optional(),
  confirmedToolCall: confirmedToolCallSchema.optional(),
  /** Stop button: close the build session without a model call. */
  endBuildSession: z.boolean().optional(),
  messages: z.array(globalAgentMessageSchema).min(1).max(40),
  /** "site-builder" = the guided interview -> plan -> build flow. */
  mode: z.enum(['default', 'site-builder']).optional(),
  pageContext: cortexAiPageContextSchema.nullable().optional(),
});

const GLOBAL_AGENT_SYSTEM_PROMPT = [
  'You are NextBlock Cortex AI, the global dashboard agent for a block-based CMS.',
  'Operate as a Planner, Executor, and Evaluator.',
  'Plan the smallest safe change, execute only through typed tools, evaluate the tool result, then answer concisely.',
  'SCOPE THE WHOLE REQUEST BEFORE YOU PICK A TOOL: list every outcome the user described (each created item, each image, each piece of copied content), then choose tools that cover ALL of them. Count outcomes, not tool names — "create a product with their main image and their content" is one product outcome PLUS an image outcome PLUS a body-copy outcome.',
  'CRITICAL — CONFIRMATION IS ONE SHOT: when the user presses Confirm, the system executes exactly the ONE tool call you proposed and nothing else. You do not get another turn to finish the job. So whatever you put in that call is the entire result. Never propose a confirmation that covers only part of what the user asked for; fold every outcome into a single tool call, or into one execute_cms_action_plan.',
  'If the user asks for multiple CMS mutations in one prompt, such as creating a page and adding a navigation link, use execute_cms_action_plan so the user sees one combined confirmation and one Confirm button. The action plan must include every requested mutation; do not fall back to confirming only the first task. execute_cms_action_plan actions may include set_content_images, so images can be part of the same confirmed plan.',
  'For execute_cms_action_plan, actions must be JSON objects, for example { "tool": "create_cms_page", "input": { "title": "Contact Us" } }, never strings like create_cms_page(...).',
  'Every mutating tool is confirmed two-step. First call the right tool with the exact normalized payload. If the tool returns requiresConfirmation, do not say the work is done; say "Please confirm for me to complete:" and summarize the requested change. Do not print confirmationPhrase unless the user explicitly asks for the raw phrase.',
  'When the latest user message is an exact confirmation phrase, call the same mutating tool again with the same payload so the tool can execute. Only report success after the tool result has mutationExecuted=true.',
  'Use create_cms_page, create_cms_post, and create_cms_product for CMS creation. New pages, posts, and products default to draft unless the user explicitly asks for a public/active status.',
  'Use update_cms_item_field for one precise field update at a time, such as price, stock, sale_price, title, slug, status, or SEO metadata. Interpret "public" as published for pages/posts and active for products.',
  'Use prepare_delete_cms_item or delete_cms_item for delete requests. Do not delete anything until the user sends the exact confirmation phrase returned by the tool.',
  'If a user asks for sale start/end dates or scheduled specials, explain that scheduled specials are not supported by the current schema; you may offer to set or clear sale_price only.',
  'Use update_navigation_bar for public header navigation changes. For requests that ask to add a header link, use update_navigation_bar with mode "append" unless the user clearly asks to replace the whole menu.',
  'For requests that ask to rename or change one existing navigation link, use update_navigation_bar with mode "update" and identify the existing item with match.label or match.url. Never use mode "replace" for a one-link rename.',
  'Use mode "replace" only when the user explicitly asks to rebuild or replace the entire navigation menu and you provide the full menu.',
  'Use update_footer for public footer links or copyright settings.',
  'For custom/reusable block types (a "custom block", "block type", "widget", or a request to design a new kind of block such as a product card, testimonial, or feature card), use the global custom block tools, which do NOT need an open page/post/product: create_custom_block to build a new block from a description, update_custom_block to edit one by slug, delete_custom_block to remove one, and list_custom_blocks to find a slug. Never tell the user to open a page first for these; never use insert_content_block or page-aware tools to define a new block type. create_custom_block and update_custom_block run immediately; after success, tell the user the block was added to their Custom Blocks library and can now be dropped onto any page.',
  'Distinguish adding content to the current page (page-aware tools, needs page context) from defining a reusable block type (custom block tools, global, no page context).',
  'PLACING A CUSTOM BLOCK: once a custom block definition exists (list_custom_blocks), put an instance on a page like any other block — blockType is the definition slug and content is the flat { field_key: value } map of its fields (text and rich-text fields take strings, image fields take an uploaded media object or null, relation fields take record ids). This works at the top level of create_cms_page / rewrite_page_draft / insert_content_block and nested inside a section\'s column_blocks; the content is validated against the definition before anything is written.',
  'When editing a CMS page, post, product, or block, use page-aware tools only. Use read_current_cms_item before updating content unless the user provided exact field/block data.',
  'Use update_current_cms_fields for current page/post/product metadata and product description_json. Use update_content_block for top-level page/post blocks. Use update_section_column_block for nested blocks inside section or hero blocks.',
  'When the user asks to add a visible title, heading, intro, description, or copy above/below a form or other block, use insert_content_block with a text or heading block. Do not treat visible page copy as meta_title, meta_description, or SEO metadata unless the user explicitly says SEO/meta.',
  'For requests like "add a title and description to both pages and incite them to contact us", use execute_cms_action_plan with one insert_content_block action per translated page, usually a text block before the form with localized heading and paragraph HTML.',
  'Do not use update_section_column_block to change an existing nested block from one block type to another. That tool edits only the content of the existing nested block type.',
  'When the user asks to add a new nested block inside a hero or section, such as adding a button to a hero, use update_content_block on the parent hero/section block. Prefer content.append_block, for example { block_type: "button", content: { text: "Contact Us", url: "/contact" } }, so the tool preserves existing column_blocks and layout fields.',
  'When a user names a language, pass that language name or its locale code in languageCode; examples: French maps to fr, English maps to en.',
  'For follow-up requests like "also add it in French", use the prior requested item and apply it to the named language. For page/post/product translations, pass the current translationGroupId into the creation tool so the backend links the language versions.',
  'Use search_documentation before answering implementation or CMS usage questions that require factual project context.',
  'Use describe_database_schema, read_database_records, execute_database_mutation, and execute_database_action_plan for direct database tasks that are not covered by a more specific CMS tool. Use typed CRUD tools only; never ask for or invent raw SQL.',
  'For direct database mutations, always return the confirmation preview first. Never claim a database mutation is complete until the confirmed tool result has mutationExecuted=true. Do not edit auth users, profiles, user addresses, password fields, API keys, tokens, secrets, private keys, credentials, or the cortex_ai_openrouter_api_key site setting.',
  'Use fetch_ecommerce_stats for quantitative questions about revenue, products, or order counts. This tool is read-only.',
  'PAGE DESIGN: when building or redesigning a page layout (a landing page, home page, hero, or marketing sections), compose it from section blocks. A section is a full-width horizontal band; place nested heading, text, button, and image blocks inside its column_blocks, which is an array of columns (each column is a list of blocks).',
  'You only need to supply each section\'s column_blocks plus intent: set is_hero:true on the first/hero section (the editor checkbox "Hero Section (Prioritized image loading)": its background image loads with priority and its content is vertically centred) and optionally a background such as { "type": "gradient" } or { "type": "theme", "theme": "primary" } or { "type": "theme", "theme": "muted" }. Cortex fills every other layout field (container, padding, gaps, responsive columns, alignment) with good defaults and sets the grid to the number of columns you provide, so provide exactly as many columns as you want across.',
  'For an attractive page: make the hero one centered column with a level-1 heading, a short text paragraph, and a button, over a gradient or theme:"primary" background. Then alternate section backgrounds for rhythm (none, then theme:"muted", then none, then a theme:"primary" call-to-action band). Use a 3-column section for feature cards and a 4-column section for stats.',
  'SLIDERS: a section with slider:true and a `slides` array (the editor checkbox "Enable Slider (Carousel layout)") renders as a carousel of full sections: each slide is { background, column_blocks } with its own background and its own block content, and autoplay:true with timeframe (seconds, default 5) rotates it. Use it when the client asks for a rotating banner or the reference site has one, and set is_hero:true on a hero slider so its first slide loads with priority. IMPORTANT: the grid track count is a SECTION-level setting taken from the top-level column_blocks, so still send that many top-level columns (empty ones are fine) even though only the slides are drawn — one top-level column for a single-column banner, two if every slide shows two columns side by side. Give every slide the same number of columns as you sent at the top level.',
  'FEATURE IMAGES: a page or post feature_image_id is not a hidden thumbnail. On a page it renders as a full-width title banner ABOVE the blocks (the image dimmed as a cover background, the page title centred over it in white); on a post it is the article hero image; and it is the social/OG preview and the listing thumbnail. Give posts one, wide and landscape. NEVER give the home page one, nor any page that opens with its own hero section: the banner would sit above the hero and repeat the title. For the share preview of such pages set the site-wide `social_image` with update_site_identity (a media id, or an https URL that is hotlinked).',
  'Use discrete heading blocks for headings (not <h2> inside text HTML). A text block\'s html_content accepts rich HTML with inline styles and <style> tags, so use a text block for any fully custom styled section.',
  'IMAGES: for real photos, call search_stock_photos with a short descriptive query (e.g. "herbal supplements") and use a returned photo `url`. Put it into an image block as { "external_url": "<url>", "alt_text": "..." }, or into a section image background as { "type": "image", "image": { "external_url": "<url>", "size": "cover", "position": "center", "alt_text": "..." } } — great for hero backgrounds; pair a hero image background with a dark gradient overlay so text stays legible. Prefer landscape orientation for backgrounds. If no stock provider is configured or you have no real image URL, use gradient or theme backgrounds instead of image backgrounds; never invent an image URL or a media_id.',
  'STOCK PHOTO ATTRIBUTION (required): whenever you use a photo from search_stock_photos, copy that photo\'s attribution fields verbatim into the same image content as `attribution`: { "provider": "...", "photographer": "...", "photographerUrl": "...", "sourceUrl": "...", "downloadLocation": "...", "utmSource": "..." }. For an image block also set `caption` to the photo\'s `credit` string. Keep stock photos hotlinked (put `url` in external_url); never save an Unsplash photo to the media library. Unsplash attribution is mandatory; Pexels is recommended.',
  'To rewrite or redesign an ENTIRE existing page or post (for example "rewrite my home page with 5 sections"), use rewrite_page_draft with the COMPLETE new list of top-level blocks (usually section blocks). This stages a Live Draft the user previews and publishes; it does not overwrite the live page and is fully reversible, so prefer it over deleting and recreating a page. You may call read_current_cms_item first to see the current structure. For a brand-new page from scratch, use create_cms_page (up to 20 blocks).',
  'When the user references an external website or URL to base content on (for example "based on https://example.com"), call fetch_url_content with that URL FIRST to read its title, description, headings, and body text, then use that material to write the new sections. Never invent facts about an external site you have not fetched.',
  'A typical "rewrite my home page based on <url>" request is: (1) fetch_url_content(<url>); (2) search_stock_photos for imagery; (3) design a hero plus several content sections from the fetched content following the PAGE DESIGN rules; (4) call rewrite_page_draft for the home page with all the new section blocks. Then tell the user to preview and publish the draft.',
  'IMPORTANT: never stop after only reading a URL or searching photos — those are preparation steps that accomplish nothing the user asked for. In the SAME turn, always continue and call the tool that actually creates or changes content (rewrite_page_draft for a full-page rewrite, create_cms_page for a new page, create_cms_product for a new product).',
  'fetch_url_content also returns the page\'s images: `mainImage` (its subject image, taken from schema.org Product data, og:image, or the best in-body <img>) and a ranked `images` list, all absolute URLs. When the user asks to reuse "their image", "the same main image", or "the image they are using", pass `mainImage` directly into create_cms_product `images` or a page/post `feature_image_id` — external URLs are imported into the media library automatically. If `mainImage` is null the page had no usable image: say so instead of inventing a URL or silently skipping it.',
  'PRODUCTS HAVE CONTENT BLOCKS, exactly like pages and posts. A product\'s body is its "Product Description Blocks" — pass `blocks` to create_cms_product using the same block vocabulary and the same PAGE DESIGN rules (section blocks with nested heading/text/image/button blocks in column_blocks). insert_content_block, update_content_block and read_current_cms_item all work on a product too. Build a product body the way you would build a page: alternating sections, a feature/benefit section with 2-4 columns, real copy in each. `short_description` is only the one-line card summary, and `description_html` is a plain-HTML fallback used when you supply no blocks — neither is a substitute for blocks.',
  'CLONE AN EXTERNAL PRODUCT PAGE: for a request like "copy the content from <url> and create a product with the same main image, price 25", do it as ONE create_cms_product call: (1) fetch_url_content(<url>); (2) call create_cms_product with title and slug from the fetched page, the price the user gave, `images: [mainImage]` when one was found, `short_description` for the one-line summary, and `blocks` holding the page content laid out as sections. All of it goes in the SAME call. "Copy the content" ALWAYS means `blocks` must be present and substantial — a product created without a body is an incomplete answer. If the user ALSO asked for a separate page, use execute_cms_action_plan containing both create_cms_product and create_cms_page so one Confirm covers everything.',
  'Build those product blocks from the `text` and `headings` returned by fetch_url_content, organised into sections: for example a section with a heading + intro paragraph, then a 3-column section of benefit cards, then a section with usage/ingredient details. Copy the substance of the source content faithfully; never pad it with invented claims. If you genuinely have only a short paragraph of copy, `description_html` (a plain HTML fragment such as "<h2>Benefits</h2><p>...</p><ul><li>...</li></ul>") is acceptable — never markdown and never editor/Tiptap JSON.',
  'TRANSLATION: to translate the CURRENT page or post into another language (e.g. "translate this page to French"), use the translate_page tool — NOT rewrite_page_draft, NOT create_cms_page, and NEVER search_stock_photos (a translation reuses the same layout and images). First call read_current_cms_item with includeBlockContent to see the exact source text, then call translate_page with targetLanguageCode (e.g. "fr") and a `translations` map of EVERY visible source string to its translation: headings, paragraph and HTML text, button labels, image alt text, captions, and form labels. translate_page copies the page structure and images automatically and links the new page to the original as a translation — you only supply the text translations.',
  'IMAGES: to set a page or post FEATURE image, or a PRODUCT\'s images, on an item that ALREADY exists, call set_content_images with `images` — a list of image URLs (use `mainImage` from fetch_url_content or the `url` values from search_stock_photos) and/or existing media library ids. It targets the open page/post/product by default; pass contentType plus slug/entityId/title to target any other item with no editor open. When you are CREATING the item, do not call it separately — pass `images` to create_cms_product, or feature_image_id to create_cms_page/create_cms_post, in the same call. The FIRST image is the feature image (pages/posts) or the main product image (products); for a product the remaining images become its gallery in order. External URLs are imported into the media library automatically: the CMS tools (create_cms_page, create_cms_post, update_cms_item_field) accept either a media library id or an https URL for feature_image_id and import it for you. The one exception is execute_database_mutation, which writes raw columns with no import step — never put an image URL into a feature_image_id column there, only a media id. A section hero/background image is different — that belongs to the section block and is set with update_content_block or update_section_column_block using an external image URL, not set_content_images.',
  'The home page is the page whose slug is "home" (served at "/"). When the user says "my home page" and no page context is supplied, target rewrite_page_draft with contentType "page" and slug "home".',
  'For order-status questions like "how many pending orders" or "how many trial orders", use the tool result report.matchingOrderStatus or report.orderStatusCounts, and use all_time unless the user names a specific time period.',
  'SITE-LEVEL REQUESTS: for anything about the site as a whole ("build my website", "set up my site", "update the whole website to…", "what pages do I have?", "make everything match our brand"), call get_site_overview FIRST, then plan across pages. The site tools are update_site_identity (site title, description, keywords, per-language copyright, active logo, and the "Published with NextBlock" footer credit), save_site_brief (remember what the client wants), reset_site_content (remove the NextBlock demo content), start_site_build (approve a whole plan with ONE confirmation, then build unattended) and finish_site_build. A fresh install ships with NextBlock demo pages, posts, menus, images, a logo and the "NextBlock™ CMS" title — "remove the NextBlock content" or "start from scratch" means reset_site_content, or start_site_build with `reset` when a rebuild follows.',
  'When a SITE BRIEF is present below, it is the client\'s intent for every site-wide change: keep names, copy, tone, colours and languages consistent with it, and update it with save_site_brief when the client changes their mind.',
  'LANGUAGE PARITY: when more than one language is active, every page you create or rewrite gets its counterpart in each other active language (translate_page or translate_content_bulk with complete translations of every visible string), and the header and footer are updated for every language. Never leave one language with a missing page or a stale menu.',
  'A one-page landing site is a valid outcome: the whole site is then the "home" page (rewrite_page_draft then publish_content_draft), a header with a few in-page or contact links, and a footer with the copyright line.',
  'Never invent database fields, raw SQL, markdown content, or unsupported tool arguments.',
].join(' ');

/**
 * The guided flow behind "Build your site with Cortex": interview, plan, build.
 * Appended to the system prompt when the client opens the chat in site-builder mode.
 */
const SITE_BUILDER_INTERVIEW_QUESTIONS =
  'Ask the discovery questions in ONE message as a short numbered list, and say that short answers or "you decide" are fine: (1) the business or project name and what it does, in one or two sentences; (2) who the visitors are and the one thing they should do (call, book, buy, read, sign up); (3) the site shape: a single landing page, or several pages — and which ones (home, about, services, menu, pricing, contact, blog, shop…); (4) the languages the public site must offer (name the ones currently active); (5) brand: colours (or "pick for me"), light or dark, tone of voice, and whether they have a logo to upload later; (6) contact details and social links to show (email, phone, address, hours); (7) whether anything already on the site should be kept, or everything replaced; (8) a reference or competitor site to draw inspiration from (a URL, fetch it with fetch_url_content), and whether they sell products online. Save every answer with save_site_brief as soon as you have it (mode "merge"). Ask at most one short follow-up round for what is still missing, then choose sensible defaults for the rest and say which defaults you chose.';

/**
 * PHASE 1 depends on what the CMS already did for the model: when the operator
 * filled in the site-brief form, the interview is over before the chat starts; when
 * the route fetched the site overview itself, the model must not fetch it again.
 */
function buildSiteBuilderModePrompt(params: { briefComplete: boolean; overviewInjected: boolean }) {
  const phaseOne = params.briefComplete
    ? 'PHASE 1 — BRIEF ALREADY COLLECTED. The operator filled in the site brief in a form (see SITE BRIEF below). Do NOT ask the discovery questions. Fill any gaps with sensible defaults and say which defaults you chose in one line. Go straight to PHASE 2 and present the plan in your first message.'
    : `PHASE 1 — INTERVIEW. ${
        params.overviewInjected
          ? 'Use the CURRENT SITE STATE below to learn what exists, which languages are active, and whether the NextBlock demo content is still present; do not call get_site_overview for that.'
          : 'Call get_site_overview first to learn what exists, which languages are active, and whether the NextBlock demo content is still present.'
      } Then ${SITE_BUILDER_INTERVIEW_QUESTIONS}`;

  return [SITE_BUILDER_MODE_INTRO, phaseOne, ...SITE_BUILDER_MODE_LATER_PHASES].join(' ');
}

const SITE_BUILDER_MODE_INTRO =
  'SITE BUILDER MODE. The operator opened this chat to set up their website from scratch with you, the way an AI website builder works. Run it in three phases and keep every message short and friendly.';

const SITE_BUILDER_MODE_LATER_PHASES = [
  'PHASE 2 — PLAN. Present the plan in plain language: what will be removed (the demo pages, posts, menus, images, logo and NextBlock title — unless they keep content), then each page with its sections top to bottom, the header and footer menus, the copyright line, the theme colours, and the languages. End with "Shall I build it?". When they agree, call start_site_build with `summary` = that plan, `brief` = the complete brief, and `reset` = { keepLanguages: [the languages they want] } unless they keep existing content (then omit reset). Do not call reset_site_content separately in this mode; start_site_build runs the reset and opens the build session with a single confirmation.',
  'PHASE 3 — BUILD, as soon as start_site_build succeeds or whenever a build session is active. Work through the plan without pausing and without asking "shall I continue": (a) update_site_identity with site_title, site_description, site_keywords, footer_copyright for every language ("© {year} <name>"), footer_show_attribution false if they want no NextBlock mention, and social_image (the share preview for every page without a feature image: a wide photo `url` from search_stock_photos, ideally the hero background, or a media id); (b) manage_language for any language that must exist; (c) manage_site_theme with the brand colours as HSL channel triplets, plus update_global_css only if a custom effect is needed; (d) if stock photos are available, search_stock_photos once per page theme and reuse the results; (e) the home page: rewrite_page_draft on contentType "page", slug "home" (it exists and is empty after the reset) with a hero section (is_hero:true) and the agreed sections and NO feature_image_id (on a page it renders a title banner above the hero), then publish_content_draft; (f) every other page: create_cms_page with status "published" and full section blocks, a contact page with a form block; (g) update_navigation_bar with mode "replace" and update_footer for EVERY active language, linking the pages you created (home is "/"); (h) for each extra language, translate_content_bulk with complete translations of every visible string on every page; (i) finish_site_build with a one-paragraph summary, then tell the operator what was built with a link to each page and to /cms/pages, and remind them to upload their logo at /cms/settings/logos. Write real, specific copy from the brief — never lorem ipsum, never placeholders such as "[Your text here]".',
];

/**
 * Tools that keep their confirmation step even inside an approved build session:
 * the irreversible ones, and the generic database tools whose payload the plan
 * could not have described up front.
 */
const ALWAYS_CONFIRM_TOOL_NAMES = new Set([
  'delete_cms_item',
  'delete_custom_block',
  'execute_database_action_plan',
  'execute_database_mutation',
  'manage_site_script',
  'reset_site_content',
  'revert_site_script',
  'start_site_build',
]);

/**
 * A whole-site build needs far more tool rounds than an ordinary edit (identity,
 * theme, one call per page, publish, navigation per language, translations, finish),
 * so an active session raises the admin's step budget to at least this.
 */
const BUILD_MODE_MIN_STEPS = 40;

function buildBuildSessionPrompt(session: CortexBuildSession) {
  return [
    `AUTONOMOUS BUILD SESSION ACTIVE until ${session.expiresAt}. The operator already approved this plan: "${session.summary}".`,
    'Every mutating tool now executes immediately, without a confirmation phrase, except destructive resets, deletions, site scripts, and raw database mutations, which still confirm.',
    'Do not ask whether to continue — continue. Complete every remaining step of the plan in this turn, calling tools one after another. If a tool fails, correct the input and retry once, then move on and report it at the end. Never repeat a step that already succeeded (check get_site_overview if unsure). When the plan is complete, call finish_site_build and summarize what was built with links.',
  ].join(' ');
}

type CortexAgentStreamEvent =
  | {
      active: boolean;
      expiresAt?: string;
      type: 'build-session';
    }
  | {
      credentialSource: string;
      modelId: string;
      type: 'meta';
    }
  | {
      text: string;
      type: 'text-delta';
    }
  | {
      input?: unknown;
      toolCallId?: string;
      toolName: string;
      type: 'tool-call';
    }
  | {
      output?: unknown;
      toolCallId?: string;
      toolName: string;
      type: 'tool-result';
    }
  | {
      message: string;
      toolCallId?: string;
      toolName?: string;
      type: 'tool-error';
    }
  | {
      message: string;
      type: 'error';
    }
  | {
      type: 'status';
    }
  | {
      type: 'finish';
    };

type CortexAgentStreamPart = {
  error?: unknown;
  id?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  type: string;
};

async function requireAdminAccess() {
  const supabase = createClient();

  // This route has no middleware refreshing the session per request, and getUser()
  // only validates the *current* access token — it does not refresh an expired one.
  // So when the access token lapses between two requests (classically: a tool-call
  // preview and its confirmation a minute or two later), getUser() fails and a
  // legitimate admin gets a spurious 403 ("You do not have permission…"). getSession()
  // refreshes an expired token from the refresh-token cookie and persists the rotated
  // token via setAll (this handler runs it before the stream response is returned, so
  // the Set-Cookie still lands), and we retry once to smooth over a transient read.
  let userId: string | null = null;

  for (let attempt = 0; attempt < 2 && !userId; attempt += 1) {
    await supabase.auth.getSession().catch(() => undefined);
    const { data, error } = await supabase.auth.getUser();

    if (!error && data?.user) {
      userId = data.user.id;
    }
  }

  if (!userId) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  return !profileError && profile?.role === 'ADMIN' ? { userId } : null;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const encoder = new TextEncoder();

function encodeStreamEvent(event: CortexAgentStreamEvent) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function formatPageContextForPrompt(pageContext: CortexAiPageContext | null | undefined) {
  if (!pageContext) {
    return 'No current CMS edit context was supplied. Ask the user to open the relevant edit screen before using page-aware editing tools.';
  }

  return [
    `Current CMS edit context: contentType=${pageContext.contentType}`,
    `entityId=${String(pageContext.entityId)}`,
    pageContext.slug ? `slug=${pageContext.slug}` : null,
    pageContext.title ? `title=${pageContext.title}` : null,
    pageContext.translationGroupId ? `translationGroupId=${pageContext.translationGroupId}` : null,
    pageContext.languageId ? `languageId=${pageContext.languageId}` : null,
    pageContext.currentEditor?.field ? `currentField=${pageContext.currentEditor.field}` : null,
    pageContext.currentEditor?.blockId ? `currentBlockId=${pageContext.currentEditor.blockId}` : null,
    pageContext.currentEditor?.blockType ? `currentBlockType=${pageContext.currentEditor.blockType}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function buildGlobalAgentSystemPrompt(
  pageContext: CortexAiPageContext | null | undefined,
  stockPhotoProvider: { provider: string } | null,
  site: {
    brief: CortexSiteBrief | null;
    buildSession: CortexBuildSession | null;
    mode: 'default' | 'site-builder';
    /** Fetched by the route itself (site-builder mode, no build session yet). */
    overview?: CortexSiteOverview | null;
  }
) {
  const overview = site.overview ?? null;

  return [
    GLOBAL_AGENT_SYSTEM_PROMPT,
    site.mode === 'site-builder'
      ? buildSiteBuilderModePrompt({
          briefComplete: isCortexSiteBriefComplete(site.brief),
          overviewInjected: Boolean(overview),
        })
      : null,
    site.buildSession ? buildBuildSessionPrompt(site.buildSession) : null,
    site.brief
      ? `SITE BRIEF (what the client wants their website to be; the source of truth for names, copy, languages and style):\n${formatCortexSiteBriefForPrompt(site.brief)}`
      : 'No site brief is saved yet. If the user describes their business or what the site is for, record it with save_site_brief.',
    overview
      ? `CURRENT SITE STATE (fetched by the CMS just now — do not call get_site_overview again this turn unless you have changed something):\n${formatCortexSiteOverviewForPrompt(overview)}`
      : null,
    formatPageContextForPrompt(pageContext),
    stockPhotoProvider
      ? `Stock photos ARE available (provider: ${stockPhotoProvider.provider}). Use search_stock_photos for real hero and section imagery.`
      : 'No stock photo provider is configured, so DO NOT call search_stock_photos. Use gradient or theme section backgrounds instead, and only add image blocks or image backgrounds when the user supplies an image URL.',
    'When the user says "this page", "this post", "this product", "this field", or "this block", interpret that through the supplied current CMS edit context.',
    'Do not update content outside the supplied current CMS context, except for site-level tools, which act on the whole site by design.',
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

/**
 * The tool registry for one request. Inside an approved build session every tool
 * executes without the confirmation phrase — except the always-confirm set, which is
 * built from a second context that keeps the phrase protocol on.
 */
function createRequestTools(
  context: Parameters<typeof createCortexGlobalAgentTools>[0],
  buildSessionActive: boolean
) {
  if (!buildSessionActive) {
    return createCortexGlobalAgentTools(context);
  }

  const unattended = createCortexGlobalAgentTools({ ...context, skipConfirmation: true });
  const confirming = createCortexGlobalAgentTools(context);

  for (const name of ALWAYS_CONFIRM_TOOL_NAMES) {
    if (name in confirming) {
      (unattended as Record<string, unknown>)[name] = (confirming as Record<string, unknown>)[name];
    }
  }

  return unattended;
}

function serializeStreamError(error: unknown) {
  return summarizeCortexAiRoutingError(
    error,
    error instanceof Error ? error.message : 'Cortex AI global agent failed.'
  );
}

function getToolCallId(part: CortexAgentStreamPart) {
  return part.toolCallId || part.id;
}

function looksLikeRawToolCallLeak(value: string) {
  const normalized = value.toLowerCase();

  // Only treat STRUCTURAL markers of a raw tool-call payload as a leak. The
  // previous version flagged any prose that merely quoted a tool name or the
  // bare word "arguments", which discarded legitimate summaries (e.g. a model
  // describing what read_current_cms_item returned) and fell through to a
  // canned "interrupted" message. Genuine leaked payloads carry a <toolcall>
  // wrapper or a JSON object with both "name" and "arguments" keys.
  return (
    normalized.includes('<toolcall') ||
    normalized.includes('</toolcall') ||
    normalized.includes('<tool_call') ||
    normalized.includes('</tool_call') ||
    normalized.includes('<function_call') ||
    (normalized.includes('"arguments"') &&
      (normalized.includes('"name"') || normalized.includes('"tool"')))
  );
}

function looksLikeRateLimitText(value: string) {
  const normalized = value.toLowerCase();

  return (
    normalized.includes('rate limit exceeded') ||
    normalized.includes('free-models-per-day') ||
    normalized.includes('too many requests')
  );
}

function readNumberField(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null;
  }

  const parsed = Number((value as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readStringField(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const fieldValue = value[key];

  return typeof fieldValue === 'string' ? fieldValue : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getConfirmationSummary(toolName?: string, output?: unknown) {
  if (!isRecord(output) || !isRecord(output.preview)) {
    return 'Complete the requested CMS change.';
  }

  const preview = output.preview;
  const summary = readStringField(preview, 'summary');

  if (summary) {
    const actionSummaries = Array.isArray(preview.actionSummaries)
      ? preview.actionSummaries.filter((item): item is string => typeof item === 'string')
      : [];

    return actionSummaries.length > 0
      ? `${summary}\n\n${actionSummaries.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : summary;
  }

  const title = readStringField(preview, 'title');
  const slug = readStringField(preview, 'slug');
  const status = readStringField(preview, 'status');
  const contentType = readStringField(preview, 'contentType');
  const field = readStringField(preview, 'field');
  const mode = readStringField(preview, 'mode');
  const languageCode = readStringField(preview, 'languageCode');
  const blockCount = readNumberField(preview, 'blockCount');
  const itemCount = readNumberField(preview, 'itemCount');
  const affectedCount = readNumberField(preview, 'affectedCount');

  if (toolName === 'create_cms_page' || toolName === 'create_cms_post') {
    return `Create ${status || 'draft'} ${toolName === 'create_cms_page' ? 'page' : 'post'} "${title || slug || 'Untitled'}"${slug ? ` at slug "${slug}"` : ''}${blockCount !== null ? ` with ${pluralize(blockCount, 'content block')}` : ''}.`;
  }

  if (toolName === 'create_cms_product') {
    // Spell out images/body so a partial plan is visible BEFORE the user
    // confirms — confirming runs this one call and nothing else.
    const imageCount = readNumberField(preview, 'imageCount');
    const extras = [
      imageCount ? pluralize(imageCount, 'image') : null,
      blockCount
        ? pluralize(blockCount, 'description block')
        : readNumberField(preview, 'descriptionLength')
          ? 'a full description'
          : null,
    ].filter(Boolean);

    return `Create ${status || 'draft'} product "${title || slug || 'Untitled'}"${slug ? ` at slug "${slug}"` : ''}${extras.length ? ` with ${extras.join(' and ')}` : ''}.`;
  }

  if (toolName === 'update_cms_item_field') {
    return `Update ${field || 'one field'} on the ${contentType || 'CMS item'} "${title || slug || 'selected item'}".`;
  }

  if (toolName === 'update_navigation_bar') {
    return `${mode === 'append' ? 'Add' : mode === 'update' ? 'Update' : 'Replace'} ${itemCount !== null ? pluralize(itemCount, 'navigation item') : 'navigation items'} in the ${languageCode || 'selected'} header navigation.`;
  }

  if (toolName === 'update_footer') {
    const linkCount = readNumberField(preview, 'linkCount');
    return `Update the ${languageCode || 'selected'} footer${linkCount !== null ? ` with ${pluralize(linkCount, 'link')}` : ''}.`;
  }

  if (toolName === 'update_content_block') {
    return `Update the selected ${readStringField(preview, 'blockType') || 'content'} block.`;
  }

  if (toolName === 'insert_content_block') {
    return `Insert ${readStringField(preview, 'blockType') || 'content'} block on the ${contentType || 'CMS item'} "${title || slug || 'selected item'}".`;
  }

  if (toolName === 'update_section_column_block') {
    return `Update the selected nested ${readStringField(preview, 'nestedBlockType') || 'section'} block.`;
  }

  if (toolName === 'delete_cms_item' || toolName === 'prepare_delete_cms_item') {
    return `Delete ${affectedCount !== null ? pluralize(affectedCount, contentType || 'CMS item') : `the selected ${contentType || 'CMS item'}`}${title || slug ? ` for "${title || slug}"` : ''}.`;
  }

  return 'Complete the requested CMS change.';
}

function describeBlockTypeCounts(blocks: unknown) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return '';
  }

  const counts = new Map<string, number>();

  for (const block of blocks) {
    if (isRecord(block)) {
      const type = typeof block.blockType === 'string' ? block.blockType : 'block';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([type, count]) => pluralize(count, `${type} block`)).join(', ');
}

// Deterministic, truthful summary for a read of the current CMS item. Read
// tools have no side effects, so if the model does not narrate the result
// (empty text, token/step exhaustion, idle timeout), the route can still hand
// the user a real answer instead of a canned "the model was interrupted" line.
function summarizeReadCurrentCmsItemOutput(output: unknown) {
  if (!isRecord(output) || output.success !== true) {
    return null;
  }

  const context = isRecord(output.context) ? output.context : null;
  const contentType =
    context && typeof context.contentType === 'string' ? context.contentType : 'item';
  const item = isRecord(output.item) ? output.item : null;
  const title = item && typeof item.title === 'string' ? item.title : null;
  const slug = item && typeof item.slug === 'string' ? item.slug : null;
  const status = item && typeof item.status === 'string' ? item.status : null;
  const blocks = Array.isArray(output.blocks) ? output.blocks : [];

  const identity = title ? `the ${contentType} "${title}"` : `the current ${contentType}`;
  const meta = [slug ? `slug "${slug}"` : null, status ? `status ${status}` : null]
    .filter(Boolean)
    .join(', ');

  if (contentType === 'product') {
    return `Here is ${identity}${meta ? ` (${meta})` : ''}.`;
  }

  const breakdown = describeBlockTypeCounts(blocks);

  return `Here is ${identity}${meta ? ` (${meta})` : ''}. It currently has ${pluralize(
    blocks.length,
    'content block'
  )}${breakdown ? `: ${breakdown}` : ''}.`;
}

function summarizeSearchDocumentationOutput(output: unknown) {
  if (!isRecord(output)) {
    return null;
  }

  const results = Array.isArray(output.results) ? output.results : [];

  if (results.length === 0) {
    return 'I searched the published pages and posts but did not find a relevant match.';
  }

  const titles = results
    .map((result) => (isRecord(result) && typeof result.title === 'string' ? result.title : null))
    .filter((value): value is string => Boolean(value))
    .slice(0, 5);

  return `I searched the published content and found ${pluralize(
    results.length,
    'relevant result'
  )}${titles.length > 0 ? `: ${titles.join(', ')}` : ''}.`;
}

function getToolCompletionMessage(toolName?: string, output?: unknown) {
  if (isRecord(output)) {
    if (output.requiresConfirmation === true) {
      return `Please confirm for me to complete:\n\n${getConfirmationSummary(toolName, output)}`;
    }

    if (output.unsupported === true || output.success === false) {
      return readStringField(output, 'message') || 'I could not complete that request.';
    }
  }

  const mutationExecuted = isRecord(output) && output.mutationExecuted === true;

  if (toolName === 'update_navigation_bar') {
    const insertedCount = readNumberField(output, 'insertedCount');
    const skippedCount = readNumberField(output, 'skippedCount');

    if ((insertedCount ?? 0) === 0 && (skippedCount ?? 0) > 0) {
      return 'That navigation link already exists, so I left the header unchanged.';
    }

    return 'Done. I updated the navigation bar.';
  }

  if (toolName === 'update_footer') {
    return 'Done. I updated the footer.';
  }

  if (toolName === 'search_documentation') {
    return summarizeSearchDocumentationOutput(output) || 'I searched the documentation for you.';
  }

  if (toolName === 'read_current_cms_item') {
    return summarizeReadCurrentCmsItemOutput(output) || 'I read the current CMS item for you.';
  }

  if (toolName === 'fetch_ecommerce_stats') {
    return 'I fetched the latest ecommerce statistics for you.';
  }

  if (toolName === 'describe_database_schema') {
    return 'I inspected the available database schema.';
  }

  if (toolName === 'read_database_records') {
    return 'I read the requested database records.';
  }

  if (toolName === 'execute_database_mutation') {
    const affectedCount = readNumberField(output, 'affectedCount');
    const table = readStringField(output, 'table');
    const auditLogged = isRecord(output) && output.auditLogged === true;

    return mutationExecuted
      ? `Done. I updated ${affectedCount ? pluralize(affectedCount, 'database row') : 'the database'}${table ? ` in ${table}` : ''}.${auditLogged ? ' Audit logged.' : ''}`
      : 'I prepared the database mutation.';
  }

  if (toolName === 'execute_database_action_plan') {
    const actionCount = readNumberField(output, 'actionCount');
    const auditLogged = isRecord(output) && output.auditLogged === true;

    return mutationExecuted
      ? `Done. I completed ${actionCount ? pluralize(actionCount, 'database action') : 'the database action plan'}.${auditLogged ? ' Audit logged.' : ''}`
      : 'I prepared the database action plan.';
  }

  if (toolName === 'update_current_cms_fields') {
    return 'Done. I updated the current CMS fields.';
  }

  if (toolName === 'update_cms_item_field') {
    return mutationExecuted
      ? 'Done. I updated that CMS field.'
      : 'I prepared the CMS field update.';
  }

  if (toolName === 'update_content_block') {
    return 'Done. I updated the current content block.';
  }

  if (toolName === 'insert_content_block') {
    return 'Done. I inserted the content block.';
  }

  if (toolName === 'fetch_url_content') {
    const title = readStringField(output, 'title');
    return title ? `I read the page "${title}".` : 'I read the requested URL.';
  }

  if (toolName === 'search_stock_photos') {
    if (isRecord(output) && output.success === false) {
      return readStringField(output, 'message') || 'I could not search for stock photos.';
    }

    const count = Array.isArray((output as { photos?: unknown[] })?.photos)
      ? (output as { photos: unknown[] }).photos.length
      : 0;

    return count > 0
      ? `I found ${pluralize(count, 'stock photo')} to use.`
      : 'I did not find matching stock photos.';
  }

  if (toolName === 'translate_page') {
    if (!mutationExecuted) {
      return 'I prepared the translation.';
    }

    const languageCode = readStringField(output, 'languageCode');
    return `Done — I published the${languageCode ? ` ${languageCode.toUpperCase()}` : ''} translation and linked it to the original. It's live now — open the page and switch languages to see it. You can still edit the wording anytime.`;
  }

  if (toolName === 'set_content_images') {
    if (!mutationExecuted) {
      return 'I prepared the image update.';
    }

    const contentType = readStringField(output, 'contentType');
    return contentType === 'product'
      ? 'Done — I updated the product images. The first is the main image and the rest are the gallery.'
      : 'Done — I set the feature image. Reload the editor to see it.';
  }

  if (toolName === 'rewrite_page_draft') {
    if (!mutationExecuted) {
      return 'I prepared the page rewrite draft.';
    }

    const contentType = readStringField(output, 'contentType') || 'page';
    const draftPreviewPath = readStringField(output, 'draftPreviewPath');

    return `Done — I staged a Live Draft rewrite of your ${contentType}. It is NOT live yet. Open the ${contentType} edit screen to preview the draft${draftPreviewPath ? ` (preview it live at ${draftPreviewPath})` : ''}, then click Publish to go live. Publishing also saves a revision snapshot you can restore if you change your mind.`;
  }

  if (toolName === 'update_section_column_block') {
    return 'Done. I updated the nested section block.';
  }

  if (toolName === 'create_cms_page') {
    return mutationExecuted ? 'Done. I created the page.' : 'I prepared the page creation.';
  }

  if (toolName === 'create_cms_post') {
    return mutationExecuted ? 'Done. I created the post.' : 'I prepared the post creation.';
  }

  if (toolName === 'create_cms_product') {
    if (!mutationExecuted) {
      return 'I prepared the product creation.';
    }

    const imageCount = readNumberField(output, 'imageCount');
    const productBlockCount = readNumberField(output, 'blockCount');
    // An image that failed to import must be reported, not swallowed — the
    // confirm turn is the last step, so silence here reads as full success.
    const imageError = readStringField(output, 'imageError');
    const parts = [
      imageCount ? pluralize(imageCount, 'image') : null,
      productBlockCount ? pluralize(productBlockCount, 'description block') : null,
    ].filter(Boolean);

    return [
      'Done. I created the product',
      parts.length > 0 ? ` with ${parts.join(' and ')}` : '',
      '.',
      imageError ? ` I could not attach the images, though: ${imageError}` : '',
    ].join('');
  }

  if (toolName === 'prepare_delete_cms_item') {
    return getToolCompletionMessage('delete_cms_item', output);
  }

  if (toolName === 'delete_cms_item') {
    return mutationExecuted ? 'Done. I deleted that CMS item.' : 'I prepared the delete request.';
  }

  if (toolName === 'execute_cms_action_plan') {
    const actionCount = readNumberField(output, 'actionCount');

    return mutationExecuted
      ? `Done. I completed ${actionCount ? pluralize(actionCount, 'CMS action') : 'the CMS action plan'}.`
      : 'I prepared the CMS action plan.';
  }

  if (toolName === 'get_site_overview') {
    return 'I reviewed the whole site.';
  }

  if (toolName === 'save_site_brief') {
    return 'I saved that to the site brief.';
  }

  if (toolName === 'update_site_identity') {
    return mutationExecuted ? 'Done. I updated the site identity.' : 'I prepared the site identity update.';
  }

  if (toolName === 'reset_site_content') {
    if (isRecord(output) && output.dryRun === true) {
      return 'Here is what a reset would remove. Nothing was changed.';
    }

    return mutationExecuted ? 'Done. I removed the content as planned.' : 'I prepared the site reset.';
  }

  if (toolName === 'start_site_build') {
    return mutationExecuted
      ? 'The plan is approved and the build session is open. Continuing with the build now.'
      : 'I prepared the site build plan.';
  }

  if (toolName === 'finish_site_build') {
    return 'The build session is closed.';
  }

  return 'Done. I completed the requested update.';
}

function completeToolBackedText(text: string, toolName?: string, output?: unknown) {
  const trimmedText = text.trim();

  if (!isRecord(output)) {
    return trimmedText || getToolCompletionMessage(toolName, output);
  }

  if (output.requiresConfirmation === true) {
    return getToolCompletionMessage(toolName, output);
  }

  if ((output.unsupported === true || output.success === false) && !trimmedText) {
    return getToolCompletionMessage(toolName, output);
  }

  return trimmedText || getToolCompletionMessage(toolName, output);
}

async function executeConfirmedToolCall(params: {
  context: Parameters<typeof createCortexGlobalAgentTools>[0];
  input: unknown;
  toolName: z.infer<typeof confirmedToolCallSchema>['toolName'];
}) {
  switch (params.toolName) {
    case 'create_cms_page':
      return executeCreateCmsPage(params.input as any, params.context);
    case 'create_cms_post':
      return executeCreateCmsPost(params.input as any, params.context);
    case 'create_cms_product':
      return executeCreateCmsProduct(params.input as any, params.context);
    case 'delete_cms_item':
      return executeDeleteCmsItem(params.input as any, params.context);
    case 'delete_custom_block':
      return executeDeleteCustomBlock(params.input as any, params.context);
    case 'execute_database_action_plan':
      return executeDatabaseActionPlan(params.input as any, params.context);
    case 'execute_database_mutation':
      return executeDatabaseMutation(params.input as any, params.context);
    case 'execute_cms_action_plan':
      return executeCmsActionPlan(params.input as any, params.context);
    case 'update_cms_item_field':
      return executeUpdateCmsItemField(params.input as any, params.context);
    case 'update_content_block':
      return executeUpdateContentBlock(params.input as any, params.context);
    case 'insert_content_block':
      return executeInsertContentBlock(params.input as any, params.context);
    case 'rewrite_page_draft':
      return executeRewritePageDraft(params.input as any, params.context);
    case 'set_content_images':
      return executeSetContentImages(params.input as any, params.context);
    case 'translate_page':
      return executeTranslatePage(params.input as any, params.context);
    case 'update_current_cms_fields':
      return executeUpdateCurrentCmsFields(params.input as any, params.context);
    case 'update_footer':
      return executeUpdateFooter(params.input as any, params.context);
    case 'update_navigation_bar':
      return executeUpdateNavigationBar(params.input as any, params.context);
    case 'update_section_column_block':
      return executeUpdateSectionColumnBlock(params.input as any, params.context);
    case 'reset_site_content':
      return executeResetSiteContent(params.input as any, params.context);
    case 'start_site_build':
      return executeStartSiteBuild(params.input as any, params.context);
    case 'update_site_identity':
      return executeUpdateSiteIdentity(params.input as any, params.context);
  }
}

function createConfirmedToolCallStream(params: {
  context: Parameters<typeof createCortexGlobalAgentTools>[0];
  input: unknown;
  toolName: z.infer<typeof confirmedToolCallSchema>['toolName'];
}) {
  return new ReadableStream({
    async start(controller) {
      const toolCallId = `confirmed-${Date.now()}`;

      controller.enqueue(
        encodeStreamEvent({
          input: params.input,
          toolCallId,
          toolName: params.toolName,
          type: 'tool-call',
        })
      );

      try {
        const output = await executeConfirmedToolCall(params);

        controller.enqueue(
          encodeStreamEvent({
            output,
            toolCallId,
            toolName: params.toolName,
            type: 'tool-result',
          })
        );
        controller.enqueue(
          encodeStreamEvent({
            text: getToolCompletionMessage(params.toolName, output),
            type: 'text-delta',
          })
        );
      } catch (error) {
        controller.enqueue(
          encodeStreamEvent({
            message: serializeStreamError(error),
            toolCallId,
            toolName: params.toolName,
            type: 'tool-error',
          })
        );
        controller.enqueue(
          encodeStreamEvent({
            message: serializeStreamError(error),
            type: 'error',
          })
        );
      }

      controller.enqueue(encodeStreamEvent({ type: 'finish' }));
      controller.close();
    },
  });
}

function getRetryableStreamError(
  error: unknown,
  sawRawToolCallLeak: boolean,
  sawRateLimitText: boolean
) {
  if (sawRawToolCallLeak) {
    return new Error('OpenRouter returned an invalid raw tool-call payload.');
  }

  if (sawRateLimitText) {
    return new Error('OpenRouter rate limit exceeded.');
  }

  return error;
}

function createAttemptAbortSignal(
  requestSignal: AbortSignal,
  idleTimeoutMs: number = GLOBAL_AGENT_MODEL_IDLE_TIMEOUT_MS
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout>;

  const armIdleTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort(new Error('Cortex AI response timed out. Please try again.'));
    }, idleTimeoutMs);
  };

  armIdleTimeout();

  const abortFromRequest = () => controller.abort(requestSignal.reason);

  if (requestSignal.aborted) {
    abortFromRequest();
  } else {
    requestSignal.addEventListener('abort', abortFromRequest, { once: true });
  }

  return {
    // Called on every stream part to reset the idle timer.
    bump: armIdleTimeout,
    cleanup: () => {
      clearTimeout(timeoutId);
      requestSignal.removeEventListener('abort', abortFromRequest);
    },
    signal: controller.signal,
  };
}

export async function POST(request: Request) {
  try {
    const adminAccess = await requireAdminAccess();

    if (!adminAccess) {
      return jsonError('You do not have permission to use the global Cortex AI agent.', 403);
    }

    const isCortexAiActive = await verifyPackageOnline('cortex-ai');

    if (!isCortexAiActive) {
      return jsonError('NextBlock Cortex AI is not active for this workspace.', 403);
    }

    const body = await request.json().catch(() => null);
    const parsedRequest = globalAgentRequestSchema.safeParse(body);

    if (!parsedRequest.success) {
      return jsonError('Invalid Cortex AI global-agent request.', 400);
    }

    const pageContext = parsedRequest.data.pageContext ?? null;
    const latestUserMessage =
      [...parsedRequest.data.messages].reverse().find((message) => message.role === 'user')
        ?.content ?? '';
    const serviceClient = getServiceRoleSupabaseClient();
    const mode = parsedRequest.data.mode ?? 'default';

    // Stop button: close the build session deterministically, no model in the loop.
    if (parsedRequest.data.endBuildSession) {
      await executeFinishSiteBuild(
        { outcome: 'stopped' },
        { actorUserId: adminAccess.userId, skipConfirmation: true, supabase: serviceClient }
      );

      return NextResponse.json({ buildSession: null, ok: true });
    }

    // A session is only honoured when the client presents the id the server issued
    // to this admin and it has not expired. Anything else is normal mode.
    const storedBuildSession = parsedRequest.data.buildSessionId
      ? await resolveCortexBuildSession(serviceClient, adminAccess.userId)
      : null;
    const buildSession =
      storedBuildSession && storedBuildSession.id === parsedRequest.data.buildSessionId
        ? storedBuildSession
        : null;

    if (parsedRequest.data.confirmedToolCall) {
      const confirmedToolCall = parsedRequest.data.confirmedToolCall;
      const stream = createConfirmedToolCallStream({
        context: {
          actorUserId: adminAccess.userId,
          importExternalImage: importExternalImageForCortex,
          latestUserMessage: confirmedToolCall.confirmationPhrase,
          pageContext,
          recordRevision: createCortexRevisionRecorder(adminAccess.userId),
          supabase: getServiceRoleSupabaseClient(),
          validateBlockContent,
        },
        input: confirmedToolCall.input,
        toolName: confirmedToolCall.toolName,
      });

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const directActionPlan = buildVisibleContactIntroActionPlan(latestUserMessage);

    if (directActionPlan) {
      const stream = createConfirmedToolCallStream({
        context: {
          actorUserId: adminAccess.userId,
          importExternalImage: importExternalImageForCortex,
          latestUserMessage,
          pageContext,
          recordRevision: createCortexRevisionRecorder(adminAccess.userId),
          supabase: getServiceRoleSupabaseClient(),
          validateBlockContent,
        },
        input: directActionPlan,
        toolName: 'execute_cms_action_plan',
      });

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const sandboxKey = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? request.headers.get('x-sandbox-openrouter-key') : null;
    const sandboxModelRaw = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? request.headers.get('x-sandbox-openrouter-model') : null;
    
    let modelSelection = null;
    if (sandboxModelRaw) {
      try {
        modelSelection = safeParseCortexAiModelSelection(JSON.parse(sandboxModelRaw));
      } catch {
        // Ignore parse errors from headers
      }
    }

    const client = await createCortexAiOpenRouterClient({
      apiKey: sandboxKey || undefined,
      modelSelection: sandboxKey && modelSelection ? modelSelection : undefined,
    });
    const routingPolicy = buildCortexAiRoutingPolicy({
      credentialSource: client.credentialSource,
      selectedModel: client.modelSelection,
    });
    const modelIds = routingPolicy.modelIds;
    const tools = createRequestTools(
      {
        actorUserId: adminAccess.userId,
        cortexAiApiKey: sandboxKey,
        cortexAiModelSelection: sandboxKey && modelSelection ? modelSelection : undefined,
        importExternalImage: importExternalImageForCortex,
        latestUserMessage,
        pageContext,
        recordRevision: createCortexRevisionRecorder(adminAccess.userId),
        supabase: serviceClient,
        validateBlockContent,
      },
      Boolean(buildSession)
    );
    // In site-builder mode the "what does the site have now" check is done here, in
    // code, so the model's first turn can be the plan rather than a tool round-trip.
    // Skipped once a build session is active: the model is then mid-build and the
    // snapshot would be stale by its next tool call anyway.
    const shouldInjectOverview = mode === 'site-builder' && !buildSession;
    const [stockPhotoProvider, agentSettings, siteBrief, siteOverview] = await Promise.all([
      resolveCortexAiStockPhotoProvider(serviceClient),
      resolveCortexAiAgentSettings(serviceClient),
      readCortexSiteBrief(serviceClient),
      shouldInjectOverview
        ? executeGetSiteOverview(
            { includeMedia: false, includeNavigation: false, limit: 60 },
            { supabase: serviceClient }
          ).catch((error: unknown) => {
            console.warn('[Cortex AI] Could not fetch the site overview for the site builder:', error);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const systemPrompt = buildGlobalAgentSystemPrompt(pageContext, stockPhotoProvider, {
      brief: siteBrief,
      buildSession,
      mode,
      overview: siteOverview,
    });
    const maxSteps = buildSession
      ? Math.max(agentSettings.maxSteps, BUILD_MODE_MIN_STEPS)
      : agentSettings.maxSteps;

    const stream = new ReadableStream({
      async start(controller) {
        let completed = false;
        let lastError: unknown = null;

        // Tell the client whether the session it presented is still honoured, so a
        // stale one is dropped from the thread instead of lingering in the banner.
        if (parsedRequest.data.buildSessionId) {
          controller.enqueue(
            encodeStreamEvent(
              buildSession
                ? { active: true, expiresAt: buildSession.expiresAt, type: 'build-session' }
                : { active: false, type: 'build-session' }
            )
          );
        }

        for (const [index, modelId] of modelIds.entries()) {
          let textBuffer = '';
          let sawRawToolCallLeak = false;
          let sawRateLimitText = false;
          let hasToolCall = false;
          let hasSuccessfulToolResult = false;
          let lastToolName: string | undefined;
          let lastToolOutput: unknown;

          controller.enqueue(
            encodeStreamEvent({
              credentialSource: client.credentialSource,
              modelId,
              type: 'meta',
            })
          );

          try {
            const attemptAbort = createAttemptAbortSignal(
              request.signal,
              agentSettings.responseTimeoutMs
            );
            const baseOptions: Record<string, unknown> = {
              abortSignal: attemptAbort.signal,
              messages: parsedRequest.data.messages,
              maxRetries: 0,
              // Admin-tunable step budget (Advanced settings): room for
              // read -> plan -> build/confirm multi-tool sequences.
              stopWhen: stepCountIs(maxSteps),
              system: systemPrompt,
              temperature: agentSettings.temperature,
              tools,
            };

            // maxOutputTokens is a per-step cap that also counts the JSON of a tool
            // call, so a whole-page rewrite needs plenty of room. `null` = Unlimited:
            // omit the cap entirely so the model uses its own full output budget.
            if (agentSettings.maxOutputTokens !== null) {
              baseOptions.maxOutputTokens = agentSettings.maxOutputTokens;
            }

            const attemptOptions = omitUnsupportedCortexAiModelOptions(baseOptions, {
              modelId,
              modelSelection: routingPolicy.modelSelection,
            });
            const result = streamText({
              ...attemptOptions,
              model: client.model(modelId),
            } as Parameters<typeof streamText>[0]);

            // Keep the browser's connection + idle timer alive and show a "working"
            // indicator while a big tool call is generated with no client events.
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encodeStreamEvent({ type: 'status' }));
              } catch {
                // Controller already closed; nothing to send.
              }
            }, GLOBAL_AGENT_HEARTBEAT_INTERVAL_MS);

            try {
              for await (const rawPart of result.fullStream) {
                attemptAbort.bump();
                const part = rawPart as CortexAgentStreamPart;

                if (part.type === 'text-delta' && part.text) {
                  textBuffer = `${textBuffer}${part.text}`;
                  sawRawToolCallLeak = sawRawToolCallLeak || looksLikeRawToolCallLeak(textBuffer);
                  sawRateLimitText = sawRateLimitText || looksLikeRateLimitText(textBuffer);
                }

                if (part.type === 'tool-call' && part.toolName) {
                  hasToolCall = true;
                  lastToolName = part.toolName;
                  controller.enqueue(
                    encodeStreamEvent({
                      input: part.input,
                      toolCallId: getToolCallId(part),
                      toolName: part.toolName,
                      type: 'tool-call',
                    })
                  );
                }

                if (part.type === 'tool-result' && part.toolName) {
                  hasSuccessfulToolResult = true;
                  lastToolName = part.toolName;
                  lastToolOutput = part.output;
                  controller.enqueue(
                    encodeStreamEvent({
                      output: part.output,
                      toolCallId: getToolCallId(part),
                      toolName: part.toolName,
                      type: 'tool-result',
                    })
                  );
                }

                if (part.type === 'tool-error') {
                  hasToolCall = true;
                  controller.enqueue(
                    encodeStreamEvent({
                      message: serializeStreamError(part.error),
                      toolCallId: getToolCallId(part),
                      toolName: part.toolName,
                      type: 'tool-error',
                    })
                  );
                }

                if (part.type === 'error') {
                  throw part.error || new Error('Cortex AI stream failed.');
                }
              }
            } finally {
              clearInterval(heartbeat);
              attemptAbort.cleanup();
            }

            if ((sawRawToolCallLeak || sawRateLimitText) && !hasToolCall) {
              lastError = getRetryableStreamError(
                null,
                sawRawToolCallLeak,
                sawRateLimitText
              );

              if (index < modelIds.length - 1) {
                continue;
              }

              throw lastError;
            }

            if ((sawRawToolCallLeak || sawRateLimitText) && !hasSuccessfulToolResult) {
              lastError = getRetryableStreamError(
                null,
                sawRawToolCallLeak,
                sawRateLimitText
              );
              throw lastError;
            }

            if ((sawRawToolCallLeak || sawRateLimitText) && hasSuccessfulToolResult) {
              controller.enqueue(
                encodeStreamEvent({
                  text: getToolCompletionMessage(lastToolName, lastToolOutput),
                  type: 'text-delta',
                })
              );
            } else if (textBuffer.trim() && !looksLikeRawToolCallLeak(textBuffer)) {
              controller.enqueue(
                encodeStreamEvent({
                  text: hasSuccessfulToolResult
                    ? completeToolBackedText(textBuffer, lastToolName, lastToolOutput)
                    : textBuffer,
                  type: 'text-delta',
                })
              );
            } else if (hasSuccessfulToolResult) {
              controller.enqueue(
                encodeStreamEvent({
                  text: getToolCompletionMessage(lastToolName, lastToolOutput),
                  type: 'text-delta',
                })
              );
            }

            controller.enqueue(encodeStreamEvent({ type: 'finish' }));
            completed = true;
            break;
          } catch (error) {
            lastError = getRetryableStreamError(error, sawRawToolCallLeak, sawRateLimitText);

            if (hasSuccessfulToolResult) {
              controller.enqueue(
                encodeStreamEvent({
                  text: completeToolBackedText(textBuffer, lastToolName, lastToolOutput),
                  type: 'text-delta',
                })
              );
              controller.enqueue(encodeStreamEvent({ type: 'finish' }));
              completed = true;
              break;
            }

            if (
              !hasToolCall &&
              isOpenRouterRateLimitError(lastError) &&
              index < modelIds.length - 1
            ) {
              continue;
            }

            // A model that OpenRouter can no longer route ("No endpoints found",
            // "no longer available", withdrawn free tier, 404) is an outage, not an
            // answer: log it for the operator and try the next model in the chain.
            if (
              !hasToolCall &&
              isOpenRouterRecoverableRoutingError(lastError) &&
              index < modelIds.length - 1
            ) {
              console.warn('[Cortex AI] model unavailable, falling back', {
                message: serializeStreamError(lastError),
                status: getOpenRouterErrorStatus(lastError),
                modelId,
              });
              continue;
            }

            if (
              !hasToolCall &&
              (sawRawToolCallLeak || sawRateLimitText) &&
              index < modelIds.length - 1
            ) {
              continue;
            }

            controller.enqueue(
              encodeStreamEvent({
                message: serializeStreamError(lastError),
                type: 'error',
              })
            );
            controller.enqueue(encodeStreamEvent({ type: 'finish' }));
            completed = true;
            break;
          }

          if (completed) {
            break;
          }
        }

        if (!completed) {
          controller.enqueue(
            encodeStreamEvent({
              message: serializeStreamError(lastError),
              type: 'error',
            })
          );
          controller.enqueue(encodeStreamEvent({ type: 'finish' }));
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[Cortex AI] Global agent failed:', error);
    return jsonError(error instanceof Error ? error.message : 'Global agent failed.', 500);
  }
}
