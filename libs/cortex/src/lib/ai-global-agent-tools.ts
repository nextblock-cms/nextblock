import { tool } from 'ai';
import { createCortexDatabaseAgentTools } from './ai-global-agent-db-tools';
import { createCortexCustomBlockTools } from './ai-global-agent-custom-block-tools';
import { createCortexContentOpsTools } from './ai-global-agent-content-ops-tools';
import { createCortexThemingTools } from './ai-global-agent-theming-tools';
import { createCortexSiteTools } from './ai-global-agent-site-tools';
import { editorDocumentFromHtml } from './editor-document-from-html';
import { z } from './zod-config';

import {
  availableCortexAiBlockTypes,
  isValidBlockType,
  loadCustomBlockDefinitions,
  readCustomBlockFields,
  validateCortexBlockContent,
  validateCustomBlockInstanceContent,
  type BlockContentValidator,
  type BlockType,
  type CustomBlockDefinitionLike,
} from './block-content-schemas';

type ColumnBlock = { block_type: BlockType; content: Record<string, unknown>; temp_id?: string };
type SectionBlockContent = Record<string, any> & {
  column_blocks: Array<Array<ColumnBlock>>;
};

type SupabaseLike = {
  from: (table: string) => any;
};

type RevalidateFn = (path: string, type?: 'layout' | 'page') => void;
type MenuKey = 'HEADER' | 'FOOTER';
type CmsContentType = 'page' | 'post' | 'product';

/**
 * Imports an external image URL into the NextBlock media library and returns the
 * new media row id (a UUID). Injected by the app (which owns storage + sharp);
 * the lib can't import the app-side importer directly. Absent in tests/CLI.
 */
type ImportExternalImageFn = (input: {
  url: string;
  altText?: string;
}) => Promise<{ id: string } | { error: string }>;

/**
 * Records a revision for a live CMS write the agent is about to make.
 *
 * Two-phase so this lib never has to know the revision format: `capture` snapshots the
 * current state and returns it opaquely, `commit` diffs that baseline against whatever the
 * write left behind. Injected by the app — the revision service is a server action holding
 * the snapshot shape, the diff cadence and the version bookkeeping, and forking it in here
 * would give NextBlock two revision writers that drift apart.
 *
 * Absent in tests/CLI, in which case writes proceed unrecorded exactly as before.
 */
type RecordRevisionFn = (input: {
  baseline?: unknown;
  contentType: CmsContentType;
  entityId: number | string;
  phase: 'capture' | 'commit';
}) => Promise<unknown>;

type ToolExecutionContext = {
  actorUserId?: string | null;
  cortexAiApiKey?: string | null;
  cortexAiModelSelection?: unknown;
  /**
   * Custom block definitions a `block_type` slug may resolve to. Loaded on demand by
   * `withCustomBlockDefinitions` when an input (or a stored block) references a
   * type that is not built in, so requests that only use built-ins pay nothing.
   */
  customBlockDefinitions?: CustomBlockDefinitionLike[];
  importExternalImage?: ImportExternalImageFn;
  latestUserMessage?: string | null;
  pageContext?: CortexAiPageContext | null;
  recordRevision?: RecordRevisionFn;
  /**
   * Set by the MCP route when a bearer token outlived the account that created it,
   * so `actorUserId` is a substituted stand-in. Usable for attribution, never for
   * authorization — see the role checks in ai-global-agent-theming-tools.ts.
   */
  actorFromOrphanedToken?: boolean;
  revalidatePath?: RevalidateFn;
  skipConfirmation?: boolean;
  supabase?: SupabaseLike;
  validateBlockContent?: BlockContentValidator;
};

/**
 * Snapshot the current state of a CMS item before the agent overwrites it.
 *
 * Never throws: a revision that cannot be recorded must not block the edit the user asked
 * for. Returns undefined when no recorder is injected or the capture failed, which makes
 * the matching commitCmsRevision call a no-op.
 */
async function captureCmsRevision(
  context: ToolExecutionContext | undefined,
  contentType: CmsContentType,
  entityId: number | string
): Promise<unknown> {
  if (!context?.recordRevision) return undefined;
  try {
    return await context.recordRevision({ contentType, entityId, phase: 'capture' });
  } catch (error) {
    console.error('Cortex AI: failed to capture revision baseline', error);
    return undefined;
  }
}

/** Commit the revision opened by captureCmsRevision. Never throws — see above. */
async function commitCmsRevision(
  context: ToolExecutionContext | undefined,
  contentType: CmsContentType,
  entityId: number | string,
  baseline: unknown
): Promise<void> {
  if (!context?.recordRevision || baseline === undefined) return;
  try {
    await context.recordRevision({ baseline, contentType, entityId, phase: 'commit' });
  } catch (error) {
    console.error('Cortex AI: failed to record revision', error);
  }
}

const SEARCH_DOCUMENTATION_TIMEOUT_MS = 10000;

const LANGUAGE_NAME_ALIASES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  dutch: 'nl',
  english: 'en',
  french: 'fr',
  francaise: 'fr',
  francais: 'fr',
  german: 'de',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  portuguese: 'pt',
  russian: 'ru',
  spanish: 'es',
};

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith('/') ||
      value.startsWith('#') ||
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('mailto:') ||
      value.startsWith('tel:'),
    'URL must be a relative path, hash link, http(s) URL, mailto URL, or tel URL.'
  );

const navigationChildItemSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  target: z.enum(['_self', '_blank']).optional(),
  url: urlSchema,
});

export const navigationItemInputSchema = navigationChildItemSchema.extend({
  children: z.array(navigationChildItemSchema).max(20).optional(),
});

const navigationItemMatchSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(120).optional(),
    url: urlSchema.optional(),
  })
  .refine((value) => Boolean(value.label || value.url), {
    message: 'Navigation item match requires label or url.',
  });

export const updateNavigationBarInputSchema = z.strictObject({
  items: z.array(navigationItemInputSchema).min(1).max(30),
  languageCode: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .default('en')
    .describe('Locale code or language name, for example "en", "fr", "English", or "French".'),
  match: navigationItemMatchSchema
    .optional()
    .describe('For mode "update", identifies the existing navigation item to update.'),
  mode: z.enum(['append', 'replace', 'update']).default('append'),
});

export const updateFooterInputSchema = z.strictObject({
  copyright: z.record(z.string().trim().min(2).max(12), z.string().trim().min(1).max(500)).optional(),
  languageCode: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .default('en')
    .describe('Locale code or language name, for example "en", "fr", "English", or "French".'),
  links: z.array(navigationItemInputSchema).min(1).max(30).optional(),
});

export const searchDocumentationInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(8).default(4),
  query: z.string().trim().min(2).max(300),
});

export const fetchEcommerceStatsInputSchema = z.object({
  currency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .optional()
    .describe(
      'Optional currency code for currency-specific monetary reports (e.g., USD, CAD). Do not set this for plain order-status counts unless the user asks for a currency.'
    ),
  query: z.string().describe('The analytical question about orders, products, or revenue.'),
  reportType: z
    .enum(['revenue', 'orders', 'products', 'general'])
    .optional()
    .default('general')
    .describe('The focus area of the statistical report.'),
  timeRange: z
    .enum(['today', 'this_month', 'last_7_days', 'last_30_days', 'last_month', 'last_90_days', 'all_time'])
    .optional()
    .default('all_time')
    .describe('The time period for the report. Use all_time for current order-status counts unless the user names a specific period.'),
});

export const cortexAiPageContextSchema = z.strictObject({
  contentType: z.enum(['page', 'post', 'product']),
  currentEditor: z
    .strictObject({
      blockId: z.union([z.number().int().positive(), z.string().trim().min(1).max(120)]).nullable().optional(),
      blockType: z.string().trim().min(1).max(80).nullable().optional(),
      field: z.string().trim().min(1).max(120).nullable().optional(),
    })
    .optional(),
  entityId: z.union([z.number().int().positive(), z.string().trim().min(1).max(120)]),
  languageId: z.number().int().positive().nullable().optional(),
  slug: z.string().trim().min(1).max(300).nullable().optional(),
  title: z.string().trim().min(1).max(300).nullable().optional(),
  translationGroupId: z.string().trim().min(1).max(120).nullable().optional(),
});

const cmsContentTypeSchema = z.enum(['page', 'post', 'product']);
const cmsTargetInputSchema = z.strictObject({
  contentType: cmsContentTypeSchema.optional(),
  entityId: z.union([z.number().int().positive(), z.string().trim().min(1).max(120)]).optional(),
  slug: z.string().trim().min(1).max(300).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

/**
 * Names the item an "current item" tool acts on when there is no open editor.
 *
 * The dashboard agent inherits its target from the editor the user has open. An MCP
 * client has no editor, so without this every tool below is unreachable from an
 * external host. Optional everywhere, so in-app calls are unchanged.
 */
const cmsTargetOverrideSchema = cmsTargetInputSchema
  .optional()
  .describe(
    'Names the page, post, or product to act on when no CMS editor is open (MCP clients). Pass contentType plus one of slug, entityId, or title. Ignored when an editor is already open.'
  );

export const readCurrentCmsItemInputSchema = z.strictObject({
  cmsTarget: cmsTargetOverrideSchema,
  includeBlockContent: z.boolean().default(false),
  includeBlocks: z.boolean().default(true),
});

/**
 * What `feature_image_id` does, spelled out for the model, because the field name
 * suggests a harmless thumbnail. On a page it renders as a full-width title banner
 * ABOVE the page's blocks (PageClientContent: the image as a dimmed cover background,
 * about 200-300px tall, with the page title centred over it in white); on a post it is
 * the article's hero image above the header; and it is the social/OG preview image
 * and the listing-card thumbnail. So a page that opens with its own hero section must
 * NOT get one, or the banner stacks above the hero and repeats the title — which is
 * what the site builder did to a client's home page before this text existed.
 */
const FEATURE_IMAGE_DESCRIPTION =
  'The feature image: an existing media library id OR an external https:// image URL, which is downloaded into the media library automatically (pass `mainImage` from fetch_url_content or a `url` from search_stock_photos straight in). WHAT IT DOES: on a page it renders as a full-width title banner ABOVE the page\'s blocks (the image as a dimmed cover background, about 200-300px tall, with the page title centred over it in white); on a post it is the article\'s hero image above the header. It is also the social/OG preview image and the card thumbnail in post listings. RULES: give every post one. Give a page one only when a title banner above its content is wanted; NEVER set one on the home page or on any page that opens with its own hero section (the banner would stack above the hero and repeat the title) — set the site-wide social preview with update_site_identity `social_image` instead. Pick a very wide landscape image (about 3:1, at least 1600px wide): the banner crops it to a short full-width band.';

export const updateCurrentCmsFieldsInputSchema = z.strictObject({
  cmsTarget: cmsTargetOverrideSchema,
  fields: z
    .strictObject({
      // Accepts an HTML string as well as an editor document — see
      // validateProductDescriptionJson.
      description_json: z.unknown().optional(),
      excerpt: z.string().max(2000).nullable().optional(),
      feature_image_id: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .nullable()
    .optional()
    .describe(FEATURE_IMAGE_DESCRIPTION),
      label: z.string().max(120).nullable().optional(),
      meta_description: z.string().max(500).nullable().optional(),
      meta_title: z.string().max(160).nullable().optional(),
      published_at: z.string().max(80).nullable().optional(),
      short_description: z.string().max(2000).nullable().optional(),
      slug: z.string().trim().min(1).max(300).optional(),
      status: z.enum(['draft', 'published', 'active', 'archived']).optional(),
      subtitle: z.string().max(300).nullable().optional(),
      title: z.string().trim().min(1).max(300).optional(),
    })
    .partial(),
});

/**
 * A built-in block type, or the slug of a custom block definition. Custom slugs are
 * resolved at execution time against `custom_block_definitions` (see
 * `withCustomBlockDefinitions`), so the schema stays a plain string for the model
 * while unknown types are still refused before anything is written.
 */
const blockTypeInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe(
    `A built-in block type (${availableCortexAiBlockTypes.join(', ')}) or the slug of a custom block definition from list_custom_blocks, whose content is the flat { field_key: value } map its fields describe.`
  );

export const updateContentBlockInputSchema = z.strictObject({
  blockId: z.number().int().positive(),
  blockType: blockTypeInputSchema.optional(),
  cmsTarget: cmsTargetOverrideSchema,
  content: z.record(z.string(), z.unknown()),
});

export const updateSectionColumnBlockInputSchema = z.strictObject({
  blockIndex: z.number().int().min(0),
  blockType: blockTypeInputSchema.optional(),
  cmsTarget: cmsTargetOverrideSchema,
  columnIndex: z.number().int().min(0),
  content: z.record(z.string(), z.unknown()),
  parentBlockId: z.number().int().positive(),
});

const createCmsBlockInputSchema = z.strictObject({
  blockType: blockTypeInputSchema,
  content: z
    .record(z.string(), z.unknown())
    .describe(
      'The block content, matching that block type\'s schema. For a `text` block, `html_content` is rendered as real HTML and may include an inline <style> and an inline <script> — so you can add scroll reveals, counters, hover effects, and other motion directly in a block. Inline scripts are stamped with the site CSP nonce automatically. Three rules. (1) THE PAGE IS REACT-HYDRATED. Do not change the text, classes, or attributes of surrounding server-rendered markup: React reconciles afterwards and reverts your change (a counter animates then snaps back) or logs a hydration mismatch. Waiting for `load` is NOT sufficient — hydration can still be in flight. Safe patterns instead: animate with the Web Animations API (el.animate() touches no attribute); append your own new elements and style those; use CSS for anything CSS can do; and if you must set text, render the FINAL value server-side and only animate toward it once the element scrolls into view. (2) `on*` attributes (onclick, onload, …) are stripped, so bind with addEventListener. (3) The script runs once per full page load, not on client-side navigation — for site-wide behaviour use manage_site_script. For a `section` block: `is_hero: true` marks the page hero (the editor checkbox "Hero Section (Prioritized image loading)": its background image loads with priority and its content is vertically centred); `slider: true` with a `slides` array ([{ background, column_blocks }, …], the editor checkbox "Enable Slider (Carousel layout)") renders a carousel of full sections: only the slides are drawn, but the grid track count still comes from the top-level `column_blocks`, so send one top-level column per column you want inside each slide (empty columns are fine) and give every slide that same number of columns. Add `autoplay: true` and `timeframe` in seconds (default 5) to rotate it.'
    ),
  order: z.number().int().min(0).optional(),
});

// Declared here (not next to executeSetContentImages) because the CMS action-plan
// union below references it, and module-level consts are not hoisted.
export const setContentImagesInputSchema = cmsTargetInputSchema.extend({
  images: z
    .array(z.string().trim().min(1).max(2048))
    .min(1)
    .max(12)
    .describe(
      'External https image URLs (imported into the media library automatically) and/or existing media library ids. The first entry is the feature image (pages/posts) or the main product image (products).'
    ),
});
type SetContentImagesInput = z.input<typeof setContentImagesInputSchema>;

export const insertContentBlockInputSchema = cmsTargetInputSchema.extend({
  anchorBlockId: z.number().int().positive().optional(),
  anchorBlockType: blockTypeInputSchema.optional(),
  block: createCmsBlockInputSchema,
  position: z.enum(['before', 'after', 'start', 'end']).default('end'),
});

export const createCmsPageInputSchema = z.strictObject({
  blocks: z.array(createCmsBlockInputSchema).max(20).optional(),
  contactEmail: z.string().email().optional(),
  feature_image_id: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .nullable()
    .optional()
    .describe(FEATURE_IMAGE_DESCRIPTION),
  languageCode: z.string().trim().min(2).max(80).optional(),
  meta_description: z.string().max(500).nullable().optional(),
  meta_title: z.string().max(160).nullable().optional(),
  slug: z.string().trim().min(1).max(300).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  title: z.string().trim().min(1).max(300),
  translationGroupId: z.string().trim().min(1).max(120).optional(),
});

export const createCmsPostInputSchema = z.strictObject({
  blocks: z.array(createCmsBlockInputSchema).max(20).optional(),
  excerpt: z.string().max(2000).nullable().optional(),
  feature_image_id: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .nullable()
    .optional()
    .describe(FEATURE_IMAGE_DESCRIPTION),
  label: z.string().max(120).nullable().optional(),
  languageCode: z.string().trim().min(2).max(80).optional(),
  meta_description: z.string().max(500).nullable().optional(),
  meta_title: z.string().max(160).nullable().optional(),
  published_at: z.string().max(80).nullable().optional(),
  slug: z.string().trim().min(1).max(300).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  subtitle: z.string().max(300).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  translationGroupId: z.string().trim().min(1).max(120).optional(),
});

export const createCmsProductInputSchema = z.strictObject({
  // Products render "Product Description Blocks" exactly like pages/posts render
  // their blocks (blocks.product_id). This is the richest body and takes
  // precedence over description_html on the public product page.
  blocks: z
    .array(createCmsBlockInputSchema)
    .max(20)
    .optional()
    .describe(
      'Content blocks for the product description area, same block vocabulary as create_cms_page. Rendered on the public product page in place of the plain description.'
    ),
  // Fallback body input. A plain string is something every model can produce
  // under a strict tool schema, unlike the untyped description_json below.
  description_html: z
    .string()
    .max(60000)
    .optional()
    .describe(
      'The product body as an HTML fragment (headings, paragraphs, lists, bold/italic/links). Converted to the editor document automatically. Prefer this over description_json.'
    ),
  description_json: z.unknown().optional(),
  freemius_plan_id: z.string().optional(),
  freemius_product_id: z.string().optional(),
  images: z
    .array(z.string().trim().min(1).max(2048))
    .max(12)
    .optional()
    .describe(
      'Product images, in order: the first becomes the main product image and the rest the gallery. Each entry is either an external https image URL (imported into the media library automatically) or an existing media library id.'
    ),
  is_taxable: z.boolean().default(true),
  languageCode: z.string().trim().min(2).max(80).optional(),
  meta_description: z.string().max(500).nullable().optional(),
  meta_title: z.string().max(160).nullable().optional(),
  payment_provider: z.enum(['stripe', 'freemius']).default('stripe'),
  price: z.number().min(0).default(0),
  prices: z.record(z.string(), z.number().min(0)).optional(),
  product_type: z.enum(['physical', 'digital']).default('physical'),
  sale_price: z.number().min(0).nullable().optional(),
  sale_prices: z.record(z.string(), z.number().min(0).nullable()).optional(),
  short_description: z.string().max(2000).nullable().optional(),
  sku: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(300).optional(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  stock: z.number().int().min(0).default(0),
  title: z.string().trim().min(1).max(300),
  trial_period_days: z.number().int().min(0).default(0),
  trial_requires_payment_method: z.boolean().default(false),
  translationGroupId: z.string().trim().min(1).max(120).optional(),
  upc: z.string().max(120).nullable().optional(),
});

export const updateCmsItemFieldInputSchema = cmsTargetInputSchema.extend({
  currencyCode: z.string().trim().min(3).max(3).optional(),
  endsAt: z.string().max(80).nullable().optional(),
  field: z.string().trim().min(1).max(120),
  startsAt: z.string().max(80).nullable().optional(),
  value: z.unknown(),
});

export const prepareDeleteCmsItemInputSchema = cmsTargetInputSchema;
export const deleteCmsItemInputSchema = cmsTargetInputSchema;

const wrappedCmsActionPlanActionSchema = z.discriminatedUnion('tool', [
  z.strictObject({ input: createCmsPageInputSchema, tool: z.literal('create_cms_page') }),
  z.strictObject({ input: createCmsPostInputSchema, tool: z.literal('create_cms_post') }),
  z.strictObject({ input: createCmsProductInputSchema, tool: z.literal('create_cms_product') }),
  z.strictObject({ input: deleteCmsItemInputSchema, tool: z.literal('delete_cms_item') }),
  z.strictObject({ input: updateCmsItemFieldInputSchema, tool: z.literal('update_cms_item_field') }),
  z.strictObject({ input: updateContentBlockInputSchema, tool: z.literal('update_content_block') }),
  z.strictObject({ input: insertContentBlockInputSchema, tool: z.literal('insert_content_block') }),
  z.strictObject({ input: updateCurrentCmsFieldsInputSchema, tool: z.literal('update_current_cms_fields') }),
  z.strictObject({ input: updateFooterInputSchema, tool: z.literal('update_footer') }),
  z.strictObject({ input: updateNavigationBarInputSchema, tool: z.literal('update_navigation_bar') }),
  z.strictObject({ input: updateSectionColumnBlockInputSchema, tool: z.literal('update_section_column_block') }),
  z.strictObject({ input: setContentImagesInputSchema, tool: z.literal('set_content_images') }),
]);

const flatCmsActionPlanActionSchema = z.union([
  createCmsPageInputSchema
    .extend({ tool: z.literal('create_cms_page') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  createCmsPostInputSchema
    .extend({ tool: z.literal('create_cms_post') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  createCmsProductInputSchema
    .extend({ tool: z.literal('create_cms_product') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  deleteCmsItemInputSchema
    .extend({ tool: z.literal('delete_cms_item') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateCmsItemFieldInputSchema
    .extend({ tool: z.literal('update_cms_item_field') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateContentBlockInputSchema
    .extend({ tool: z.literal('update_content_block') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  insertContentBlockInputSchema
    .extend({ tool: z.literal('insert_content_block') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateCurrentCmsFieldsInputSchema
    .extend({ tool: z.literal('update_current_cms_fields') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateFooterInputSchema
    .extend({ tool: z.literal('update_footer') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateNavigationBarInputSchema
    .extend({ tool: z.literal('update_navigation_bar') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  updateSectionColumnBlockInputSchema
    .extend({ tool: z.literal('update_section_column_block') })
    .transform(({ tool, ...input }) => ({ input, tool })),
  setContentImagesInputSchema
    .extend({ tool: z.literal('set_content_images') })
    .transform(({ tool, ...input }) => ({ input, tool })),
]);

const commandStringCmsActionPlanActionSchema = z.string().transform((value, context) => {
  const parsed = parseCmsActionPlanCommandString(value);

  if (!parsed.success) {
    context.addIssue({
      code: 'custom',
      message: parsed.message,
    });

    return z.NEVER;
  }

  return parsed.action;
});

const cmsActionPlanActionSchema = z.union([
  wrappedCmsActionPlanActionSchema,
  flatCmsActionPlanActionSchema,
  commandStringCmsActionPlanActionSchema,
]);

export const executeCmsActionPlanInputSchema = z.strictObject({
  actions: z.array(cmsActionPlanActionSchema).min(1).max(8),
  summary: z.string().trim().min(1).max(500).optional(),
});

function splitTopLevelValues(value: string) {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (quote) {
      current += char;

      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '[' || char === '{' || char === '(') {
      depth++;
      current += char;
      continue;
    }

    if (char === ']' || char === '}' || char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }

      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function convertSingleQuotedJsonLikeToJson(value: string) {
  let output = '';

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (char !== "'") {
      output += char;
      continue;
    }

    let content = '';
    let escaping = false;
    index++;

    for (; index < value.length; index++) {
      const innerChar = value[index];

      if (escaping) {
        content += innerChar;
        escaping = false;
        continue;
      }

      if (innerChar === '\\') {
        escaping = true;
        continue;
      }

      if (innerChar === "'") {
        break;
      }

      content += innerChar;
    }

    output += JSON.stringify(content);
  }

  return output
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
}

function parseCmsActionPlanCommandValue(value: string) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return JSON.parse(convertSingleQuotedJsonLikeToJson(trimmed));
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return JSON.parse(convertSingleQuotedJsonLikeToJson(trimmed));
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed === 'true' || trimmed === 'True') {
    return true;
  }

  if (trimmed === 'false' || trimmed === 'False') {
    return false;
  }

  if (trimmed === 'null' || trimmed === 'None') {
    return null;
  }

  return trimmed;
}

function parseCmsActionPlanCommandArguments(value: string) {
  const input: Record<string, unknown> = {};

  for (const part of splitTopLevelValues(value)) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex <= 0) {
      throw new Error(`Expected key=value argument, received "${part}".`);
    }

    const key = part.slice(0, separatorIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid argument name "${key}".`);
    }

    input[key] = parseCmsActionPlanCommandValue(part.slice(separatorIndex + 1));
  }

  return input;
}

function parseCmsActionPlanCommandString(value: string):
  | { action: z.infer<typeof wrappedCmsActionPlanActionSchema>; success: true }
  | { message: string; success: false } {
  const trimmed = value.trim();
  const match = trimmed.match(/^([a-z_]+)\(([\s\S]*)\)$/);

  if (!match) {
    return {
      message:
        'Action plan actions must be JSON objects like { "tool": "create_cms_page", "input": { ... } }, not freeform text.',
      success: false,
    };
  }

  const toolName = match[1];
  let input: Record<string, unknown>;

  try {
    input = parseCmsActionPlanCommandArguments(match[2]);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Could not parse action-plan command arguments.',
      success: false,
    };
  }

  const action = { input, tool: toolName };
  const parsedAction = wrappedCmsActionPlanActionSchema.safeParse(action);

  if (!parsedAction.success) {
    return {
      message: `Invalid action-plan command "${toolName}": ${parsedAction.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
      success: false,
    };
  }

  return {
    action: parsedAction.data,
    success: true,
  };
}

export type NavigationItemInput = z.infer<typeof navigationItemInputSchema>;
export type UpdateNavigationBarInput = z.infer<typeof updateNavigationBarInputSchema>;
export type UpdateFooterInput = z.infer<typeof updateFooterInputSchema>;
export type SearchDocumentationInput = z.infer<typeof searchDocumentationInputSchema>;
export type FetchEcommerceStatsInput = z.input<typeof fetchEcommerceStatsInputSchema>;
export type CortexAiPageContext = z.infer<typeof cortexAiPageContextSchema>;
export type ReadCurrentCmsItemInput = z.infer<typeof readCurrentCmsItemInputSchema>;
export type UpdateCurrentCmsFieldsInput = z.infer<typeof updateCurrentCmsFieldsInputSchema>;
export type UpdateContentBlockInput = z.infer<typeof updateContentBlockInputSchema>;
export type InsertContentBlockInput = z.infer<typeof insertContentBlockInputSchema>;
export type UpdateSectionColumnBlockInput = z.infer<typeof updateSectionColumnBlockInputSchema>;
export type CreateCmsPageInput = z.infer<typeof createCmsPageInputSchema>;
export type CreateCmsPostInput = z.infer<typeof createCmsPostInputSchema>;
// Pre-parse shape: executeCreateCmsProduct parses its own argument, so callers
// may omit the eight .default() fields (is_taxable, payment_provider, price,
// product_type, status, stock, trial_*) that z.infer would demand.
export type CreateCmsProductInput = z.input<typeof createCmsProductInputSchema>;
export type UpdateCmsItemFieldInput = z.infer<typeof updateCmsItemFieldInputSchema>;
export type PrepareDeleteCmsItemInput = z.infer<typeof prepareDeleteCmsItemInputSchema>;
export type DeleteCmsItemInput = z.infer<typeof deleteCmsItemInputSchema>;
export type ExecuteCmsActionPlanInput = z.infer<typeof executeCmsActionPlanInputSchema>;

function normalizePlannerText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function mentionsAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

export function buildVisibleContactIntroActionPlan(message: string): ExecuteCmsActionPlanInput | null {
  const normalized = normalizePlannerText(message);
  const asksToAdd = mentionsAny(normalized, ['add ', 'insert ', 'put ', 'create ']);
  const asksVisibleCopy = mentionsAny(normalized, [
    'title',
    'heading',
    'description',
    'intro',
    'copy',
    'paragraph',
  ]);
  const asksAboveForm =
    normalized.includes('form') && mentionsAny(normalized, ['above', 'before']);
  const asksContactPages =
    normalized.includes('contact page') ||
    normalized.includes('contact pages') ||
    normalized.includes('contact us') ||
    normalized.includes('contactez-nous');
  const asksEnglishAndFrench =
    normalized.includes('english') &&
    mentionsAny(normalized, ['french', 'francais', 'francaise']);

  if (!asksToAdd || !asksVisibleCopy || !asksAboveForm || !asksContactPages || !asksEnglishAndFrench) {
    return null;
  }

  return {
    actions: [
      {
        input: {
          anchorBlockType: 'form',
          block: {
            blockType: 'text',
            content: {
              html_content:
                '<h2>Let us help you move faster</h2><p>Have a question, project idea, or need help choosing the right next step? Send us a message and the NextBlock team will get back to you soon.</p>',
            },
          },
          contentType: 'page',
          position: 'before',
          slug: 'contact-us',
        },
        tool: 'insert_content_block',
      },
      {
        input: {
          anchorBlockType: 'form',
          block: {
            blockType: 'text',
            content: {
              html_content:
                "<h2>Parlons de votre projet</h2><p>Vous avez une question, une idee de projet ou besoin d'aide pour avancer? Envoyez-nous un message et l'equipe NextBlock vous repondra rapidement.</p>",
            },
          },
          contentType: 'page',
          position: 'before',
          slug: 'contactez-nous',
        },
        tool: 'insert_content_block',
      },
    ],
    summary:
      'Add visible title and description copy above the forms on the English and French Contact pages.',
  };
}

type DocumentationSnippet = {
  excerpt: string;
  source: 'page' | 'post';
  title: string;
  url: string;
};


function getEditorBlockDocumentSchema() {
  return z.object({
    content: z.array(z.any()).optional(),
    type: z.literal('doc'),
  });
}

function getDefaultRevalidatePath(): RevalidateFn | null {
  try {
    const { revalidatePath } = require('next/cache') as typeof import('next/cache');
    return revalidatePath;
  } catch {
    return null;
  }
}

function getSupabase(context?: ToolExecutionContext) {
  if (!context?.supabase) {
    throw new Error('A Supabase service client is required to execute Cortex AI global tools.');
  }

  return context.supabase;
}

function withTimeoutFallback<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createFallback: () => T
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(createFallback()), timeoutMs);
  });

  return Promise.race([
    promise.finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }),
    timeoutPromise,
  ]);
}

function getCurrentCmsContext(context?: ToolExecutionContext) {
  const parsed = cortexAiPageContextSchema.safeParse(context?.pageContext);

  if (!parsed.success) {
    throw new Error(
      'No current CMS page context is available. Open a page, post, or product edit screen before using this editing tool.'
    );
  }

  return parsed.data;
}

function getNumericEntityId(pageContext: CortexAiPageContext) {
  const id =
    typeof pageContext.entityId === 'number'
      ? pageContext.entityId
      : Number.parseInt(pageContext.entityId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Current ${pageContext.contentType} id must be a positive integer.`);
  }

  return id;
}

function getStringEntityId(pageContext: CortexAiPageContext) {
  const id = String(pageContext.entityId || '').trim();

  if (!id) {
    throw new Error(`Current ${pageContext.contentType} id is missing.`);
  }

  return id;
}

function getCmsEntityId(pageContext: CortexAiPageContext) {
  return pageContext.contentType === 'product'
    ? getStringEntityId(pageContext)
    : getNumericEntityId(pageContext);
}

const EXTERNAL_IMAGE_URL_RE = /^https?:\/\//i;
const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an image reference to a media library id (UUID). A media id is
 * returned as-is; an external http(s) URL (e.g. a search_stock_photos result)
 * is imported into the media library first via the injected importer, and the
 * new media id is returned. `feature_image_id` and `product_media.media_id` are
 * UUID FKs, so a raw URL would fail with "invalid input syntax for type uuid".
 */
async function resolveMediaReference(
  value: unknown,
  context: ToolExecutionContext | undefined,
  altText?: string
): Promise<string | null> {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (!EXTERNAL_IMAGE_URL_RE.test(trimmed)) {
    // Not a URL: it must be a media library id (a UUID). Reject anything else
    // (data: URIs, protocol-relative //host, ftp:, blob:, …) with a clear message
    // rather than passing a bogus value into a uuid FK column.
    if (MEDIA_ID_RE.test(trimmed)) {
      return trimmed;
    }

    throw new Error(
      `"${trimmed}" is not a usable image reference — provide an https:// image URL or a media library id.`
    );
  }

  const importFn = context?.importExternalImage;

  if (!importFn) {
    throw new Error(
      'I can only attach an image from a URL when media import is available here. Please pick an image from the media library instead.'
    );
  }

  const result = await importFn({ altText, url: trimmed });

  if ('error' in result) {
    throw new Error(`I could not import the image from that URL: ${result.error}`);
  }

  return result.id;
}

/**
 * Resolve a list of image references (external https URLs and/or media library
 * ids) to media ids, importing external URLs as needed. Order is preserved so
 * the caller can treat the first entry as the main image.
 */
async function resolveMediaReferences(
  images: readonly string[],
  context: ToolExecutionContext | undefined,
  label: string
) {
  const mediaIds: string[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const mediaId = await resolveMediaReference(
      images[index],
      context,
      `${label} image ${index + 1}`
    );

    if (mediaId) {
      mediaIds.push(mediaId);
    }
  }

  return mediaIds;
}

/**
 * Replace a product's gallery by writing the `product_media` join table
 * DIRECTLY. We must NOT route this through updateProduct /
 * upsert_product_with_variants: that is a full product rewrite that (because it
 * re-serializes the whole row) would wipe the product's variants, clear its
 * scheduled sale window and custom canonical, re-round-trip prices (corrupting
 * zero-decimal currencies), and hard-delete the previous images from storage.
 * Images live in a separate join table, so touch only that.
 */
async function replaceProductMediaRows(params: {
  mediaIds: readonly string[];
  productId: string | number;
  supabase: SupabaseLike;
}) {
  // Dedupe: product_media's PK is (product_id, media_id); a repeated id would
  // violate it and leave the product with no images after the delete.
  const uniqueMediaIds = [...new Set(params.mediaIds)];

  const { error: deleteError } = await params.supabase
    .from('product_media')
    .delete()
    .eq('product_id', params.productId);

  if (deleteError) {
    throw new Error(
      `Could not clear the product's existing images: ${serializeError(deleteError)}`
    );
  }

  if (uniqueMediaIds.length > 0) {
    const { error: insertError } = await params.supabase.from('product_media').insert(
      uniqueMediaIds.map((media_id, mediaIndex) => ({
        media_id,
        product_id: params.productId,
        sort_order: mediaIndex,
      }))
    );

    if (insertError) {
      throw new Error(`Could not save the product images: ${serializeError(insertError)}`);
    }
  }

  return uniqueMediaIds;
}

/**
 * Mirror a live product write into the product's open draft, if it has one.
 *
 * The product editor keeps its working copy in `product_drafts`: the edit page
 * renders `product_drafts.blocks` instead of the live rows whenever a draft
 * exists, and publishing deletes every live block for the product and reinserts
 * that snapshot. Cortex writes product content live, so a live-only write is
 * invisible in the editor and is destroyed by the next publish. Keeping both
 * stores in agreement is what stops an agent edit from silently disappearing.
 *
 * Returns false when the product has no open draft (the common case).
 */
async function patchOpenProductDraft(params: {
  patch: (draft: { blocks: any[]; meta: Record<string, unknown> }) => {
    blocks?: any[];
    meta?: Record<string, unknown>;
  };
  productId: string | number | null | undefined;
  supabase: SupabaseLike;
}) {
  if (!params.productId) {
    return false;
  }

  const { data: draft, error } = await params.supabase
    .from('product_drafts')
    .select('id, blocks, meta')
    .eq('product_id', params.productId)
    .maybeSingle();

  // No draft (or no draft storage at all in an older database) — nothing to sync.
  if (error || !draft) {
    return false;
  }

  const next = params.patch({
    blocks: Array.isArray(draft.blocks) ? cloneJsonValue(draft.blocks) : [],
    meta: isPlainJsonRecord(draft.meta) ? cloneJsonValue(draft.meta) : {},
  });
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (next.blocks) {
    update['blocks'] = next.blocks;
  }

  if (next.meta) {
    update['meta'] = next.meta;
  }

  if (Object.keys(update).length === 1) {
    return false;
  }

  const { error: updateError } = await params.supabase
    .from('product_drafts')
    .update(update)
    .eq('id', draft.id);

  if (updateError) {
    throw new Error(
      `The product was updated, but its open draft could not be kept in sync: ${serializeError(
        updateError
      )}. Publishing that draft would undo this change — publish or discard it in the product editor first.`
    );
  }

  return true;
}

function normalizePublicSlug(slug: unknown) {
  return typeof slug === 'string' ? slug.trim().replace(/^\/+|\/+$/g, '') : '';
}

function getPublicCmsPath(pageContext: CortexAiPageContext, slugOverride?: unknown) {
  const slug = normalizePublicSlug(slugOverride ?? pageContext.slug);

  if (!slug) {
    return null;
  }

  if (pageContext.contentType === 'page') {
    return slug === 'home' ? '/' : `/${slug}`;
  }

  if (pageContext.contentType === 'post') {
    return `/article/${slug}`;
  }

  return `/product/${slug}`;
}

function getCmsEditPath(pageContext: CortexAiPageContext) {
  const entityId = String(pageContext.entityId);

  if (pageContext.contentType === 'page') {
    return `/cms/pages/${entityId}/edit`;
  }

  if (pageContext.contentType === 'post') {
    return `/cms/posts/${entityId}/edit`;
  }

  return `/cms/products/${entityId}/edit`;
}

function revalidateCurrentCmsSurfaces(
  context: ToolExecutionContext | undefined,
  pageContext: CortexAiPageContext,
  slugOverride?: unknown
) {
  const revalidatePath = context?.revalidatePath ?? getDefaultRevalidatePath();

  if (!revalidatePath) {
    return;
  }

  revalidatePath(getCmsEditPath(pageContext));

  const publicPath = getPublicCmsPath(pageContext, slugOverride);

  if (publicPath) {
    revalidatePath(publicPath);
  }

  // Every language variation of the homepage is served at "/" (its slug may be
  // "home", "accueil", "startseite", …), so getPublicCmsPath only maps the
  // default-language "home" to "/". Bust "/" for any page edit so a translated
  // homepage stays fresh there too — it's a cheap no-op re-render for ordinary
  // (non-homepage) pages.
  if (pageContext.contentType === 'page' && publicPath !== '/') {
    revalidatePath('/');
  }

  if (pageContext.contentType === 'product') {
    revalidatePath('/cms/products');
  }
}

function revalidateGlobalCmsSurfaces(context?: ToolExecutionContext) {
  const revalidatePath = context?.revalidatePath ?? getDefaultRevalidatePath();

  if (!revalidatePath) {
    return;
  }

  revalidatePath('/', 'layout');
  revalidatePath('/cms/navigation');
}

function serializeError(error: unknown) {
  if (!error) {
    return 'Unknown database error.';
  }

  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || 'Unknown database error.');
  }

  return String(error);
}

async function getEcommerceProductModule() {
  return import('./ai-global-agent-ecommerce');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .filter((key) => key !== 'temp_id')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashConfirmationPayload(value: unknown) {
  let hash = 0x811c9dc5;
  const serialized = stableStringify(value);

  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeConfirmationToken(value: string) {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

function buildConfirmationPhrase(action: string, subject: string, payload: unknown) {
  return `${normalizeConfirmationToken(`CONFIRM ${action} ${subject}`)} #${hashConfirmationPayload(payload)}`;
}

function buildConfirmationPreview(params: {
  action: string;
  payload: unknown;
  preview: Record<string, unknown>;
  subject: string;
}) {
  const confirmationPhrase = buildConfirmationPhrase(
    params.action,
    params.subject,
    params.payload
  );

  return {
    confirmationPhrase,
    mutationExecuted: false,
    preview: params.preview,
    requiresConfirmation: true,
    success: true,
  };
}

function readPreviewString(preview: Record<string, unknown>, key: string) {
  const value = preview[key];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPreviewNumber(preview: Record<string, unknown>, key: string) {
  const value = Number(preview[key]);

  return Number.isFinite(value) ? value : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeCmsMutationPreview(toolName: string, preview: Record<string, unknown>) {
  const explicitSummary = readPreviewString(preview, 'summary');

  if (explicitSummary) {
    return explicitSummary;
  }

  const title = readPreviewString(preview, 'title');
  const slug = readPreviewString(preview, 'slug');
  const status = readPreviewString(preview, 'status');
  const contentType = readPreviewString(preview, 'contentType');
  const field = readPreviewString(preview, 'field');
  const mode = readPreviewString(preview, 'mode');
  const languageCode = readPreviewString(preview, 'languageCode');
  const blockCount = readPreviewNumber(preview, 'blockCount');
  const itemCount = readPreviewNumber(preview, 'itemCount');
  const affectedCount = readPreviewNumber(preview, 'affectedCount');

  if (toolName === 'create_cms_page' || toolName === 'create_cms_post') {
    return `Create ${status || 'draft'} ${toolName === 'create_cms_page' ? 'page' : 'post'} "${title || slug || 'Untitled'}"${slug ? ` at slug "${slug}"` : ''}${blockCount !== null ? ` with ${pluralize(blockCount, 'content block')}` : ''}.`;
  }

  if (toolName === 'create_cms_product') {
    // Spell out images/body so a partial plan is obvious BEFORE the user
    // confirms — the confirm turn executes this call and nothing else.
    const imageCount = readPreviewNumber(preview, 'imageCount');
    const productBlockCount = readPreviewNumber(preview, 'blockCount');
    const extras = [
      imageCount ? pluralize(imageCount, 'image') : null,
      productBlockCount
        ? pluralize(productBlockCount, 'description block')
        : readPreviewNumber(preview, 'descriptionLength')
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
    const linkCount = readPreviewNumber(preview, 'linkCount');
    return `Update the ${languageCode || 'selected'} footer${linkCount !== null ? ` with ${pluralize(linkCount, 'link')}` : ''}.`;
  }

  if (toolName === 'update_content_block') {
    return `Update the selected ${readPreviewString(preview, 'blockType') || 'content'} block.`;
  }

  if (toolName === 'insert_content_block') {
    return `Insert ${readPreviewString(preview, 'blockType') || 'content'} block on the ${contentType || 'CMS item'} "${title || slug || 'selected item'}".`;
  }

  if (toolName === 'update_section_column_block') {
    return `Update the selected nested ${readPreviewString(preview, 'nestedBlockType') || 'section'} block.`;
  }

  if (toolName === 'delete_cms_item' || toolName === 'prepare_delete_cms_item') {
    return `Delete ${affectedCount !== null ? pluralize(affectedCount, contentType || 'CMS item') : `the selected ${contentType || 'CMS item'}`}${title || slug ? ` for "${title || slug}"` : ''}.`;
  }

  return 'Complete the requested CMS change.';
}

function getConfirmationPreview(params: {
  action: string;
  context?: ToolExecutionContext;
  payload: unknown;
  preview: Record<string, unknown>;
  subject: string;
}) {
  if (params.context?.skipConfirmation) {
    return null;
  }

  const preview = buildConfirmationPreview(params);
  const latestUserMessage = normalizeConfirmationToken(params.context?.latestUserMessage || '');
  const expectedPhrase = normalizeConfirmationToken(preview.confirmationPhrase);

  return latestUserMessage.includes(expectedPhrase) ? null : preview;
}

function getActorUserId(context?: ToolExecutionContext) {
  const actorUserId = context?.actorUserId;

  if (!actorUserId) {
    throw new Error('A confirmed CMS mutation requires an authenticated admin actor.');
  }

  return actorUserId;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build a URL slug, folding accents to their base letter.
 *
 * The NFD pass matters for every non-English site: decomposing "é" into "e" plus a
 * combining accent lets the strip below remove only the accent, giving
 * "demostracion". Without it the whole character failed the `[^a-z0-9-]` filter and
 * vanished, so a Spanish page became "demostracin" and a French one "indpendant" —
 * mangled, unsearchable URLs on exactly the content that needs them most.
 */
function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 300);
}

function normalizeCurrencyCode(value: string | undefined) {
  return (value || 'USD').trim().toUpperCase();
}

const ZERO_DECIMAL_CURRENCY_CODES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

function currencyMinorUnitPrecision(currencyCode: string) {
  return ZERO_DECIMAL_CURRENCY_CODES.has(normalizeCurrencyCode(currencyCode)) ? 0 : 2;
}

// Major units (e.g. dollars) -> minor units (e.g. cents), precision-aware so
// zero-decimal currencies (JPY, KRW, …) are NOT multiplied by 100.
function majorUnitAmountToMinor(value: number, currencyCode: string) {
  return Math.round(value * 10 ** currencyMinorUnitPrecision(currencyCode));
}

function serializeMajorPriceMapToMinor(value: unknown, fallbackCurrencyCode: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>(
    (prices, [currencyCode, amount]) => {
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        const code = normalizeCurrencyCode(currencyCode || fallbackCurrencyCode);
        prices[code] = majorUnitAmountToMinor(amount, code);
      }

      return prices;
    },
    {}
  );
}

function cloneJsonRecord(value: unknown, label: string) {
  if (!isPlainJsonRecord(value)) {
    throw new Error(`${label} content must be a JSON object.`);
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeJsonRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = cloneJsonValue(base);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }

    if (isPlainJsonRecord(value) && isPlainJsonRecord(merged[key])) {
      merged[key] = mergeJsonRecords(merged[key], value);
      continue;
    }

    merged[key] = cloneJsonValue(value);
  }

  return merged;
}

function assertBlockBelongsToCurrentContext(block: any, pageContext: CortexAiPageContext) {
  // Products own "Product Description Blocks" via blocks.product_id, keyed by
  // uuid rather than the bigint ids pages and posts use.
  if (pageContext.contentType === 'product') {
    if (String(block.product_id ?? '') !== String(getStringEntityId(pageContext))) {
      throw new Error(`Block ${block.id} does not belong to the current product being edited.`);
    }

    return;
  }

  const parentId = getNumericEntityId(pageContext);
  const actualParentId =
    pageContext.contentType === 'page' ? Number(block.page_id) : Number(block.post_id);

  if (actualParentId !== parentId) {
    throw new Error(
      `Block ${block.id} does not belong to the current ${pageContext.contentType} being edited.`
    );
  }
}

function findCustomBlockDefinition(slug: string, context?: ToolExecutionContext) {
  return context?.customBlockDefinitions?.find((definition) => definition.slug === slug) ?? null;
}

/** Every block_type / blockType / anchorBlockType string inside an arbitrary JSON value. */
function collectReferencedBlockTypes(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || !value) {
    return found;
  }

  if (typeof value === 'string') {
    found.add(value);
    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferencedBlockTypes(item, found, depth + 1);
    }
    return found;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'block_type' || key === 'blockType' || key === 'anchorBlockType') && typeof nested === 'string') {
        found.add(nested);
      } else if (nested && typeof nested === 'object') {
        collectReferencedBlockTypes(nested, found, depth + 1);
      }
    }
  }

  return found;
}

/**
 * Load the custom block definitions once, and only when something in `candidates`
 * (tool input, stored block rows, nested column blocks) names a block type that is
 * not built in. Returns the same context otherwise, so built-in-only requests never
 * touch `custom_block_definitions`.
 */
async function withCustomBlockDefinitions(
  context: ToolExecutionContext | undefined,
  candidates: unknown
): Promise<ToolExecutionContext | undefined> {
  if (context?.customBlockDefinitions || !context?.supabase) {
    return context;
  }

  const referenced = collectReferencedBlockTypes(candidates);
  const needsDefinitions = [...referenced].some((type) => !isValidBlockType(type));

  if (!needsDefinitions) {
    return context;
  }

  return {
    ...context,
    customBlockDefinitions: await loadCustomBlockDefinitions(context.supabase),
  };
}

function resolveExistingBlockType(
  blockType: unknown,
  label: string,
  context?: ToolExecutionContext
): BlockType {
  const normalizedBlockType = typeof blockType === 'string' ? blockType.trim() : '';

  if (isValidBlockType(normalizedBlockType)) {
    return normalizedBlockType;
  }

  if (normalizedBlockType && findCustomBlockDefinition(normalizedBlockType, context)) {
    // A custom block slug travels through the same code paths as a built-in type.
    // Every consumer that must tell them apart asks isValidBlockType first.
    return normalizedBlockType as BlockType;
  }

  throw new Error(
    `${label} has unsupported block type "${normalizedBlockType || 'unknown'}". Built-in types: ${availableCortexAiBlockTypes.join(
      ', '
    )}; a custom block must use a slug returned by list_custom_blocks.`
  );
}

function assertRequestedBlockTypeMatches(
  requestedBlockType: string | undefined,
  existingBlockType: BlockType,
  label: string
) {
  if (requestedBlockType && requestedBlockType !== existingBlockType) {
    throw new Error(
      `${label} is a "${existingBlockType}" block. Refusing to update it as "${requestedBlockType}".`
    );
  }
}

function assertValidBlockContent(
  blockType: BlockType,
  content: Record<string, unknown>,
  label: string,
  context?: ToolExecutionContext
) {
  if (!isValidBlockType(blockType)) {
    const definition = findCustomBlockDefinition(blockType, context);

    if (!definition) {
      throw new Error(`${label} references custom block "${blockType}", which does not exist.`);
    }

    const validation = validateCustomBlockInstanceContent(definition, content);

    if (!validation.isValid) {
      throw new Error(
        `${label} content is invalid for custom block "${blockType}": ${validation.errors.join('; ')}`
      );
    }

    return;
  }

  const validation = validateCortexBlockContent(blockType, content, context);

  if (!validation.isValid) {
    throw new Error(
      `${label} content is invalid for block type "${blockType}": ${validation.errors.join('; ')}`
    );
  }
}

function isSectionLikeBlock(blockType: BlockType) {
  return blockType === 'section';
}

function inferNestedBlockTypeFromContent(content: Record<string, unknown>): BlockType | null {
  if (typeof content.html_content === 'string') {
    return 'text';
  }

  if (typeof content.text === 'string' && typeof content.url === 'string') {
    return 'button';
  }

  if (typeof content.text_content === 'string') {
    return 'heading';
  }

  if ('media_id' in content || 'object_key' in content || 'external_url' in content) {
    return 'image';
  }

  if (typeof content.quote === 'string' && typeof content.author_name === 'string') {
    return 'testimonial';
  }

  if (typeof content.url === 'string' && ('controls' in content || 'autoplay' in content || 'title' in content)) {
    return 'video_embed';
  }

  if (
    Array.isArray(content.fields) ||
    typeof content.form_key === 'string' ||
    typeof content.recipient_email === 'string'
  ) {
    return 'form';
  }

  if ('postsPerPage' in content || 'showPagination' in content) {
    return 'posts_grid';
  }

  if (typeof content.productId === 'string') {
    return 'featured_product';
  }

  if ('limit' in content && 'type' in content) {
    return 'product_grid';
  }

  return null;
}

function createNestedTempId(blockType: BlockType) {
  return `ai-${blockType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeNestedColumnBlock(
  value: unknown,
  label: string,
  context?: ToolExecutionContext
): ColumnBlock {
  if (!isPlainJsonRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const rawBlockType = value.block_type ?? value.blockType;
  const blockType = resolveExistingBlockType(rawBlockType, label, context);

  if (isSectionLikeBlock(blockType)) {
    throw new Error(`${label} cannot be a nested ${blockType} block.`);
  }

  const content = normalizeBlockContentForType(
    blockType,
    cloneJsonRecord(value.content, label),
    label,
    context
  );

  const rawTempId = value.temp_id ?? value.tempId;
  const tempId = typeof rawTempId === 'string' && rawTempId.trim() ? rawTempId : createNestedTempId(blockType);

  return {
    block_type: blockType,
    content,
    temp_id: tempId,
  };
}

function normalizeNestedBlocksToAppend(
  contentPatch: Record<string, unknown>,
  context?: ToolExecutionContext
): ColumnBlock[] {
  const blocks: ColumnBlock[] = [];

  if ('append_block' in contentPatch) {
    blocks.push(normalizeNestedColumnBlock(contentPatch.append_block, 'Nested block to append', context));
  }

  if ('append_blocks' in contentPatch) {
    const appendBlocks = contentPatch.append_blocks;

    if (!Array.isArray(appendBlocks)) {
      throw new Error('append_blocks must be an array of nested block objects.');
    }

    appendBlocks.forEach((block, index) => {
      blocks.push(normalizeNestedColumnBlock(block, `Nested block to append ${index}`, context));
    });
  }

  return blocks;
}

function maybeInferSingleNestedBlockToAppend(
  contentPatch: Record<string, unknown>,
  context?: ToolExecutionContext
): ColumnBlock | null {
  if (
    'append_block' in contentPatch ||
    'append_blocks' in contentPatch ||
    'background' in contentPatch ||
    'column_blocks' in contentPatch ||
    'column_gap' in contentPatch ||
    'container_type' in contentPatch ||
    'padding' in contentPatch ||
    'responsive_columns' in contentPatch ||
    'vertical_alignment' in contentPatch
  ) {
    return null;
  }

  const blockType = inferNestedBlockTypeFromContent(contentPatch);

  if (!blockType) {
    return null;
  }

  const content = cloneJsonRecord(contentPatch, `Nested ${blockType} block`);
  assertValidBlockContent(blockType, content, `Nested ${blockType} block`, context);

  return {
    block_type: blockType,
    content,
    temp_id: createNestedTempId(blockType),
  };
}

function getAppendColumnIndex(contentPatch: Record<string, unknown>, existingColumnCount: number) {
  const rawColumnIndex = contentPatch.append_column_index ?? contentPatch.column_index;

  if (rawColumnIndex === undefined) {
    return 0;
  }

  if (typeof rawColumnIndex !== 'number' || !Number.isInteger(rawColumnIndex) || rawColumnIndex < 0) {
    throw new Error('append_column_index must be a non-negative integer.');
  }

  if (existingColumnCount > 0 && rawColumnIndex >= existingColumnCount) {
    throw new Error(
      `append_column_index ${rawColumnIndex} is outside the existing ${existingColumnCount} column(s).`
    );
  }

  return rawColumnIndex;
}

function buildNextTopLevelBlockContent(
  blockType: BlockType,
  existingContent: Record<string, unknown>,
  contentPatch: Record<string, unknown>,
  context?: ToolExecutionContext
) {
  if (!isSectionLikeBlock(blockType)) {
    return mergeJsonRecords(existingContent, contentPatch);
  }

  const nextContentPatch = { ...contentPatch };
  const blocksToAppend = normalizeNestedBlocksToAppend(nextContentPatch, context);
  const inferredBlock = maybeInferSingleNestedBlockToAppend(nextContentPatch, context);

  if (inferredBlock) {
    blocksToAppend.push(inferredBlock);
  }

  delete nextContentPatch.append_block;
  delete nextContentPatch.append_blocks;
  delete nextContentPatch.append_column_index;
  delete nextContentPatch.column_index;

  const nextContent = mergeJsonRecords(existingContent, nextContentPatch) as SectionBlockContent;

  if (blocksToAppend.length > 0) {
    const existingColumns = Array.isArray(existingContent.column_blocks)
      ? cloneJsonValue(existingContent.column_blocks)
      : [];
    const targetColumnIndex = getAppendColumnIndex(contentPatch, existingColumns.length);
    const nextColumnBlocks = existingColumns.length > 0 ? existingColumns : [[]];

    while (nextColumnBlocks.length <= targetColumnIndex) {
      nextColumnBlocks.push([]);
    }

    nextColumnBlocks[targetColumnIndex] = [
      ...(nextColumnBlocks[targetColumnIndex] || []),
      ...blocksToAppend,
    ];
    nextContent.column_blocks = nextColumnBlocks;
  }

  return nextContent;
}

function summarizeBlockRow(block: any, includeContent: boolean) {
  return {
    blockType: block.block_type,
    content: includeContent ? block.content : undefined,
    id: block.id,
    languageId: block.language_id,
    order: block.order,
    pageId: block.page_id,
    postId: block.post_id,
  };
}

function normalizeNavigationUrl(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeNavigationLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function countNavigationInputItems(items: NavigationItemInput[]) {
  return items.reduce((count, item) => count + 1 + (item.children?.length || 0), 0);
}

function normalizeLanguageLookup(value: unknown) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
    : '';
}

async function getLanguageRecord(supabase: SupabaseLike, languageCode: string) {
  const requestedLanguage = languageCode.trim();
  const normalizedRequestedLanguage = normalizeLanguageLookup(requestedLanguage);
  const aliasCode = LANGUAGE_NAME_ALIASES[normalizedRequestedLanguage];
  const { data, error } = await supabase
    .from('languages')
    .select('id, code, name, is_active');

  if (error) {
    throw new Error(`Failed to load language "${languageCode}": ${serializeError(error)}`);
  }

  const languages = Array.isArray(data) ? data : [];
  const activeLanguages = languages.filter((language: any) => language.is_active !== false);
  const matchedLanguage = activeLanguages.find((language: any) => {
    const normalizedCode = normalizeLanguageLookup(language.code);
    const normalizedName = normalizeLanguageLookup(language.name);

    return (
      normalizedCode === normalizedRequestedLanguage ||
      normalizedCode === aliasCode ||
      normalizedName === normalizedRequestedLanguage
    );
  });

  if (!matchedLanguage?.id || !matchedLanguage?.code) {
    const availableLanguages = activeLanguages
      .map((language: any) => language.code)
      .filter(Boolean)
      .join(', ');

    throw new Error(
      `Language "${languageCode}" was not found.${availableLanguages ? ` Available languages: ${availableLanguages}.` : ''}`
    );
  }

  return {
    code: String(matchedLanguage.code),
    id: Number(matchedLanguage.id),
  };
}

async function getDefaultLanguageRecord(supabase: SupabaseLike, languageCode?: string) {
  if (languageCode) {
    return getLanguageRecord(supabase, languageCode);
  }

  const { data, error } = await supabase
    .from('languages')
    .select('id, code, name, is_active, is_default');

  if (error) {
    throw new Error(`Failed to load active languages: ${serializeError(error)}`);
  }

  const activeLanguages = (Array.isArray(data) ? data : []).filter(
    (language: any) => language.is_active !== false
  );
  const language =
    activeLanguages.find((item: any) => item.is_default) ||
    activeLanguages.find((item: any) => normalizeLanguageLookup(item.code) === 'en') ||
    activeLanguages[0];

  if (!language?.id || !language?.code) {
    throw new Error('No active CMS language is available for Cortex AI content creation.');
  }

  return {
    code: String(language.code),
    id: Number(language.id),
  };
}

async function getDefaultCurrencyCode(supabase: SupabaseLike) {
  try {
    const { data, error } = await supabase
      .from('currencies')
      .select('code, is_default, is_active')
      .eq('is_active', true);

    if (error) {
      return 'USD';
    }

    const currencies = Array.isArray(data) ? data : [];
    const currency = currencies.find((item: any) => item.is_default) || currencies[0];

    return normalizeCurrencyCode(currency?.code || 'USD');
  } catch {
    return 'USD';
  }
}

async function findSingleCmsItem(params: {
  contentType: CmsContentType;
  entityId?: string | number;
  slug?: string;
  supabase: SupabaseLike;
  title?: string;
}) {
  const table =
    params.contentType === 'page'
      ? 'pages'
      : params.contentType === 'post'
        ? 'posts'
        : 'products';
  let column = 'id';
  let value: unknown = params.entityId;

  if (value === undefined && params.slug) {
    column = 'slug';
    value = params.slug;
  }

  if (value === undefined && params.title) {
    column = 'title';
    value = params.title;
  }

  if (value === undefined) {
    throw new Error(`A ${params.contentType} target requires an id, slug, title, or current edit context.`);
  }

  const { data, error } = await params.supabase.from(table).select('*').eq(column, value);

  if (error) {
    throw new Error(`Failed to resolve ${params.contentType}: ${serializeError(error)}`);
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];

  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `No ${params.contentType} matched ${column} "${String(value)}".`
        : `Multiple ${params.contentType}s matched ${column} "${String(value)}"; use an exact id.`
    );
  }

  return rows[0];
}

async function resolveCmsTarget(
  input: z.infer<typeof cmsTargetInputSchema>,
  context?: ToolExecutionContext
) {
  const pageContext = cortexAiPageContextSchema.safeParse(context?.pageContext).success
    ? (context?.pageContext as CortexAiPageContext)
    : null;
  const contentType = input.contentType || pageContext?.contentType;

  if (!contentType) {
    throw new Error('Target contentType is required when no current CMS edit context exists.');
  }

  const hasExplicitTarget =
    input.entityId !== undefined || Boolean(input.slug) || Boolean(input.title);
  const entityId = input.entityId ?? (hasExplicitTarget ? undefined : pageContext?.entityId);
  const slug = input.slug ?? (hasExplicitTarget ? undefined : pageContext?.slug ?? undefined);
  const title = input.title ?? (hasExplicitTarget ? undefined : pageContext?.title ?? undefined);
  const item = await findSingleCmsItem({
    contentType,
    entityId,
    slug: entityId === undefined ? slug || undefined : undefined,
    supabase: getSupabase(context),
    title: entityId === undefined && !slug ? title || undefined : undefined,
  });

  return {
    contentType,
    item,
  };
}

/**
 * Resolve the item an "current item" editing tool should act on.
 *
 * Two ways in. The dashboard passes `pageContext`, taken from the editor the user
 * has open. An MCP client has no editor — the transport hands the model a tool call
 * and nothing else — so it names the item with `cmsTarget` instead, the same
 * contentType/slug/entityId/title shape the already-targetable tools accept.
 *
 * `pageContext` wins when both exist, so in-app behaviour is untouched and a stale
 * `cmsTarget` can never redirect an edit away from the open editor.
 */
async function resolveEditingCmsContext(
  target: z.infer<typeof cmsTargetInputSchema> | undefined,
  context?: ToolExecutionContext
): Promise<CortexAiPageContext> {
  const parsed = cortexAiPageContextSchema.safeParse(context?.pageContext);

  if (parsed.success) {
    return parsed.data;
  }

  const hasTarget =
    target !== undefined &&
    (target.entityId !== undefined || Boolean(target.slug) || Boolean(target.title));

  if (!hasTarget) {
    throw new Error(
      'No current CMS page context is available. Open a page, post, or product edit screen, or pass `cmsTarget` naming the item — contentType plus one of slug, entityId, or title.'
    );
  }

  const resolved = await resolveCmsTarget(target, context);
  const item = resolved.item as Record<string, unknown>;

  return {
    contentType: resolved.contentType,
    // Verbatim: coercing would break integer-keyed pages/posts while being a no-op
    // for uuid-keyed products.
    entityId: item['id'] as string | number,
    slug: typeof item['slug'] === 'string' ? item['slug'] : '',
    title: typeof item['title'] === 'string' ? item['title'] : '',
  } as CortexAiPageContext;
}

async function insertNavigationItem(params: {
  item: NavigationItemInput;
  languageId: number;
  menuKey: MenuKey;
  order: number;
  parentId?: number | null;
  supabase: SupabaseLike;
}) {
  const linkedPage = await resolveLinkedPageForNavigationItem({
    item: params.item,
    languageId: params.languageId,
    menuKey: params.menuKey,
    supabase: params.supabase,
  });
  const insertPayload = {
    label: params.item.label,
    language_id: params.languageId,
    menu_key: params.menuKey,
    order: params.order,
    page_id: linkedPage?.pageId ?? null,
    parent_id: params.parentId ?? null,
    ...(linkedPage?.navigationTranslationGroupId
      ? { translation_group_id: linkedPage.navigationTranslationGroupId }
      : {}),
    url: params.item.url,
  };
  const { data, error } = await params.supabase
    .from('navigation_items')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to insert ${params.menuKey} navigation item: ${serializeError(error)}`);
  }

  return Number(data.id);
}

function getNavigationPageSlug(url: string) {
  const trimmedUrl = url.trim();

  if (!trimmedUrl.startsWith('/') || trimmedUrl.startsWith('//')) {
    return null;
  }

  const path = trimmedUrl.split('?')[0]?.split('#')[0] || '';
  const slug = path === '/' ? 'home' : path.replace(/^\/+|\/+$/g, '');

  return slug && !slug.includes('/') ? slug : null;
}

async function resolveLinkedPageForNavigationItem(params: {
  item: NavigationItemInput;
  languageId: number;
  menuKey: MenuKey;
  supabase: SupabaseLike;
}) {
  const slug = getNavigationPageSlug(params.item.url);

  if (!slug) {
    return null;
  }

  const { data: pageData, error: pageError } = await params.supabase
    .from('pages')
    .select('id, slug, translation_group_id, language_id')
    .eq('slug', slug)
    .eq('language_id', params.languageId);

  if (pageError) {
    throw new Error(`Failed to resolve linked page for navigation item: ${serializeError(pageError)}`);
  }

  const page = Array.isArray(pageData) ? pageData[0] : pageData;

  if (!page?.id) {
    return null;
  }

  let navigationTranslationGroupId = createId();

  if (page.translation_group_id) {
    const { data: relatedPages, error: relatedPagesError } = await params.supabase
      .from('pages')
      .select('id')
      .eq('translation_group_id', page.translation_group_id);

    if (relatedPagesError) {
      throw new Error(
        `Failed to inspect linked page translations for navigation item: ${serializeError(relatedPagesError)}`
      );
    }

    const relatedPageIds = new Set(
      (Array.isArray(relatedPages) ? relatedPages : [])
        .map((relatedPage: any) => String(relatedPage.id))
        .filter(Boolean)
    );

    const { data: relatedNavigationItems, error: relatedNavigationItemsError } = await params.supabase
      .from('navigation_items')
      .select('id, page_id, translation_group_id, menu_key')
      .eq('menu_key', params.menuKey);

    if (relatedNavigationItemsError) {
      throw new Error(
        `Failed to inspect related navigation translations: ${serializeError(relatedNavigationItemsError)}`
      );
    }

    const relatedNavigationItem = (Array.isArray(relatedNavigationItems)
      ? relatedNavigationItems
      : []
    ).find((item: any) => item.translation_group_id && relatedPageIds.has(String(item.page_id)));

    if (relatedNavigationItem?.translation_group_id) {
      navigationTranslationGroupId = relatedNavigationItem.translation_group_id;
    }
  }

  return {
    navigationTranslationGroupId,
    pageId: Number(page.id),
  };
}

async function replaceNavigationMenu<TMenuKey extends MenuKey>(params: {
  items: NavigationItemInput[];
  languageCode: string;
  menuKey: TMenuKey;
  supabase: SupabaseLike;
}) {
  const language = await getLanguageRecord(params.supabase, params.languageCode);
  const { data: existingItems, error: existingItemsError } = await params.supabase
    .from('navigation_items')
    .select('id, parent_id')
    .eq('menu_key', params.menuKey)
    .eq('language_id', language.id);

  if (existingItemsError) {
    throw new Error(
      `Failed to inspect existing ${params.menuKey} navigation items: ${serializeError(existingItemsError)}`
    );
  }

  const existingRows = Array.isArray(existingItems) ? existingItems : [];
  const existingTopLevelCount = existingRows.filter((item: any) => item.parent_id == null).length;
  const replacementItemCount = countNavigationInputItems(params.items);

  assertNavigationReplacementIsSafe({
    existingItemCount: existingRows.length,
    existingTopLevelCount,
    languageCode: language.code,
    menuKey: params.menuKey,
    replacementItemCount,
  });

  const { error: deleteError } = await params.supabase
    .from('navigation_items')
    .delete()
    .eq('menu_key', params.menuKey)
    .eq('language_id', language.id);

  if (deleteError) {
    throw new Error(`Failed to clear ${params.menuKey} navigation items: ${serializeError(deleteError)}`);
  }

  let insertedCount = 0;

  for (const [index, item] of params.items.entries()) {
    const parentId = await insertNavigationItem({
      item,
      languageId: language.id,
      menuKey: params.menuKey,
      order: index,
      supabase: params.supabase,
    });
    insertedCount++;

    for (const [childIndex, child] of (item.children ?? []).entries()) {
      await insertNavigationItem({
        item: child,
        languageId: language.id,
        menuKey: params.menuKey,
        order: childIndex,
        parentId,
        supabase: params.supabase,
      });
      insertedCount++;
    }
  }

  return {
    insertedCount,
    languageCode: language.code,
    menuKey: params.menuKey,
    skippedCount: 0,
    updatedCount: 0,
  };
}

function assertNavigationReplacementIsSafe(params: {
  existingItemCount: number;
  existingTopLevelCount: number;
  languageCode: string;
  menuKey: MenuKey;
  replacementItemCount: number;
}) {
  if (params.existingItemCount === 0 || params.replacementItemCount >= params.existingItemCount) {
    return;
  }

  throw new Error(
    `Refusing destructive ${params.menuKey} navigation replacement for ${params.languageCode}: existing menu has ${params.existingItemCount} items (${params.existingTopLevelCount} top-level), but the replacement only contains ${params.replacementItemCount}. Use mode "update" for renaming or changing a single link, or provide the full menu.`
  );
}

async function assertNavigationReplacementInputIsSafe(params: {
  items: NavigationItemInput[];
  languageCode: string;
  menuKey: MenuKey;
  supabase: SupabaseLike;
}) {
  const language = await getLanguageRecord(params.supabase, params.languageCode);
  const { data: existingItems, error: existingItemsError } = await params.supabase
    .from('navigation_items')
    .select('id, parent_id')
    .eq('menu_key', params.menuKey)
    .eq('language_id', language.id);

  if (existingItemsError) {
    throw new Error(
      `Failed to inspect existing ${params.menuKey} navigation items: ${serializeError(existingItemsError)}`
    );
  }

  const existingRows = Array.isArray(existingItems) ? existingItems : [];

  assertNavigationReplacementIsSafe({
    existingItemCount: existingRows.length,
    existingTopLevelCount: existingRows.filter((item: any) => item.parent_id == null).length,
    languageCode: language.code,
    menuKey: params.menuKey,
    replacementItemCount: countNavigationInputItems(params.items),
  });
}

async function updateNavigationMenuItem(params: {
  items: NavigationItemInput[];
  languageCode: string;
  match?: z.infer<typeof navigationItemMatchSchema>;
  menuKey: MenuKey;
  supabase: SupabaseLike;
}) {
  if (params.items.length !== 1) {
    throw new Error('mode "update" requires exactly one navigation item.');
  }

  const language = await getLanguageRecord(params.supabase, params.languageCode);
  const item = params.items[0];
  const matchUrl = normalizeNavigationUrl(params.match?.url) || normalizeNavigationUrl(item.url);
  const matchLabel = normalizeNavigationLabel(params.match?.label);
  const { data: existingItems, error: existingItemsError } = await params.supabase
    .from('navigation_items')
    .select('id, label, url, parent_id, order')
    .eq('menu_key', params.menuKey)
    .eq('language_id', language.id);

  if (existingItemsError) {
    throw new Error(
      `Failed to load existing ${params.menuKey} navigation items: ${serializeError(existingItemsError)}`
    );
  }

  const existingRows = Array.isArray(existingItems) ? existingItems : [];
  const matchedItem = existingRows.find((row: any) => {
    const rowUrl = normalizeNavigationUrl(row.url);
    const rowLabel = normalizeNavigationLabel(row.label);

    return Boolean(
      (matchUrl && rowUrl === matchUrl) ||
        (matchLabel && rowLabel === matchLabel)
    );
  });

  if (!matchedItem?.id) {
    throw new Error(
      `Could not find a ${params.menuKey} navigation item to update in ${language.code}. Use a matching label or url.`
    );
  }

  const { error: updateError } = await params.supabase
    .from('navigation_items')
    .update({
      label: item.label,
      url: item.url,
    })
    .eq('id', matchedItem.id);

  if (updateError) {
    throw new Error(`Failed to update ${params.menuKey} navigation item: ${serializeError(updateError)}`);
  }

  return {
    insertedCount: 0,
    languageCode: language.code,
    menuKey: params.menuKey,
    skippedCount: 0,
    updatedCount: 1,
  };
}

async function appendNavigationMenuItems(params: {
  items: NavigationItemInput[];
  languageCode: string;
  menuKey: MenuKey;
  supabase: SupabaseLike;
}) {
  const language = await getLanguageRecord(params.supabase, params.languageCode);
  const { data: existingItems, error: existingItemsError } = await params.supabase
    .from('navigation_items')
    .select('id, url, parent_id, order')
    .eq('menu_key', params.menuKey)
    .eq('language_id', language.id);

  if (existingItemsError) {
    throw new Error(
      `Failed to load existing ${params.menuKey} navigation items: ${serializeError(existingItemsError)}`
    );
  }

  let insertedCount = 0;
  let skippedCount = 0;
  const existingRows = Array.isArray(existingItems) ? existingItems : [];
  const existingUrls = new Set(
    existingRows.map((item: any) => normalizeNavigationUrl(item.url)).filter(Boolean)
  );
  const topLevelOrders = existingRows
    .filter((item: any) => item.parent_id == null)
    .map((item: any) => Number(item.order))
    .filter(Number.isFinite);
  let nextOrder = topLevelOrders.length > 0 ? Math.max(...topLevelOrders) + 1 : existingRows.length;

  for (const item of params.items) {
    const itemUrl = normalizeNavigationUrl(item.url);

    if (itemUrl && existingUrls.has(itemUrl)) {
      skippedCount++;
      continue;
    }

    const parentId = await insertNavigationItem({
      item,
      languageId: language.id,
      menuKey: params.menuKey,
      order: nextOrder,
      supabase: params.supabase,
    });
    insertedCount++;
    nextOrder++;

    if (itemUrl) {
      existingUrls.add(itemUrl);
    }

    let nextChildOrder = 0;

    for (const child of item.children ?? []) {
      const childUrl = normalizeNavigationUrl(child.url);

      if (childUrl && existingUrls.has(childUrl)) {
        skippedCount++;
        continue;
      }

      await insertNavigationItem({
        item: child,
        languageId: language.id,
        menuKey: params.menuKey,
        order: nextChildOrder,
        parentId,
        supabase: params.supabase,
      });
      insertedCount++;
      nextChildOrder++;

      if (childUrl) {
        existingUrls.add(childUrl);
      }
    }
  }

  return {
    insertedCount,
    languageCode: language.code,
    menuKey: params.menuKey,
    skippedCount,
    updatedCount: 0,
  };
}

function stringifyContentValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeFormFieldType(field: Record<string, unknown>) {
  const rawType = stringifyContentValue(field.field_type ?? field.fieldType ?? field.type ?? field.input_type)
    .toLowerCase()
    .replace(/\s+/g, '_');
  const label = stringifyContentValue(field.label ?? field.name ?? field.placeholder).toLowerCase();

  if (['email', 'tel', 'url', 'number', 'textarea', 'select', 'radio', 'checkbox', 'text'].includes(rawType)) {
    return rawType;
  }

  // What an agent is likely to write for the same thing.
  if (['phone', 'telephone', 'phone_number', 'mobile'].includes(rawType)) {
    return 'tel';
  }

  if (['website', 'link', 'uri'].includes(rawType)) {
    return 'url';
  }

  if (['numeric', 'integer', 'quantity'].includes(rawType)) {
    return 'number';
  }

  if (label.includes('email') || label.includes('courriel')) {
    return 'email';
  }

  if (label.includes('phone') || label.includes('téléphone') || label.includes('telephone')) {
    return 'tel';
  }

  if (label.includes('website') || label.includes('site web')) {
    return 'url';
  }

  if (label.includes('message') || label.includes('comment') || label.includes('details')) {
    return 'textarea';
  }

  return 'text';
}

function normalizeFormFields(fields: unknown) {
  const sourceFields =
    Array.isArray(fields) && fields.length > 0
      ? fields
      : [
          { field_type: 'text', is_required: true, label: 'Name', placeholder: 'Your name' },
          { field_type: 'email', is_required: true, label: 'Email', placeholder: 'you@example.com' },
          { field_type: 'textarea', is_required: true, label: 'Message', placeholder: 'How can we help?' },
        ];

  return sourceFields.map((field, index) => {
    const fieldRecord = isPlainJsonRecord(field) ? field : {};
    const label =
      stringifyContentValue(fieldRecord.label ?? fieldRecord.name) ||
      (index === 0 ? 'Name' : index === 1 ? 'Email' : 'Message');
    const fieldType = normalizeFormFieldType({ ...fieldRecord, label });
    const rawRequired = fieldRecord.is_required ?? fieldRecord.isRequired ?? fieldRecord.required;

    return {
      field_type: fieldType,
      is_required: typeof rawRequired === 'boolean' ? rawRequired : true,
      label,
      options: Array.isArray(fieldRecord.options) ? fieldRecord.options : undefined,
      placeholder: stringifyContentValue(fieldRecord.placeholder) || undefined,
      temp_id:
        stringifyContentValue(fieldRecord.temp_id ?? fieldRecord.tempId ?? fieldRecord.id) ||
        `field-${index + 1}`,
    };
  });
}

const SECTION_GAP_VALUES = new Set(['none', 'sm', 'md', 'lg', 'xl']);
const SECTION_PADDING_VALUES = new Set(['none', 'sm', 'md', 'lg', 'xl']);
const SECTION_CONTAINER_VALUES = new Set([
  'full-width',
  'container',
  'container-sm',
  'container-lg',
  'container-xl',
]);
const SECTION_ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch']);
const SECTION_BACKGROUND_TYPES = new Set(['none', 'theme', 'solid', 'gradient', 'image']);
const SECTION_THEME_VALUES = new Set(['primary', 'secondary', 'muted', 'accent', 'destructive']);
const SECTION_IMAGE_POSITION_VALUES = new Set(['center', 'top', 'bottom', 'left', 'right']);

function isExternalImageUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function pickEnumValue(value: unknown, allowed: Set<string>, fallback: string) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function clampSectionColumnCount(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(4, Math.max(1, Math.round(value)));
}

function normalizeSectionGradient(rawGradient: unknown): Record<string, unknown> {
  const defaultStops = [
    { color: '#1e3a8a', position: 0 },
    { color: '#3b82f6', position: 100 },
  ];

  if (!isPlainJsonRecord(rawGradient)) {
    return { direction: 'to bottom right', stops: defaultStops, type: 'linear' };
  }

  const gradientType = rawGradient.type === 'radial' ? 'radial' : 'linear';
  const stops =
    Array.isArray(rawGradient.stops) && rawGradient.stops.length >= 2
      ? rawGradient.stops
      : defaultStops;
  const direction =
    typeof rawGradient.direction === 'string' && rawGradient.direction.trim()
      ? rawGradient.direction
      : gradientType === 'radial'
        ? 'circle at center'
        : 'to bottom right';

  return { direction, stops, type: gradientType };
}

function normalizeSectionBackground(rawBackground: unknown): Record<string, unknown> {
  if (!isPlainJsonRecord(rawBackground)) {
    return { type: 'none' };
  }

  const type = pickEnumValue(rawBackground.type, SECTION_BACKGROUND_TYPES, 'none');
  const minHeight =
    typeof rawBackground.min_height === 'string' && rawBackground.min_height.trim()
      ? { min_height: rawBackground.min_height }
      : {};

  if (type === 'theme') {
    return { theme: pickEnumValue(rawBackground.theme, SECTION_THEME_VALUES, 'muted'), type, ...minHeight };
  }

  if (type === 'solid') {
    return typeof rawBackground.solid_color === 'string' && rawBackground.solid_color.trim()
      ? { solid_color: rawBackground.solid_color, type, ...minHeight }
      : { type: 'none' };
  }

  if (type === 'gradient') {
    return { gradient: normalizeSectionGradient(rawBackground.gradient), type, ...minHeight };
  }

  if (type === 'image') {
    const image = isPlainJsonRecord(rawBackground.image) ? rawBackground.image : null;
    const externalUrl = image && isExternalImageUrl(image.external_url) ? image.external_url.trim() : null;
    const hasStoredMedia = Boolean(
      image &&
        typeof image.media_id === 'string' &&
        image.media_id.trim() &&
        typeof image.object_key === 'string' &&
        image.object_key.trim()
    );

    // Accept an external image URL (e.g. an AI-inserted stock photo) OR a stored
    // media reference. Fill the required size/position defaults so it validates
    // and renders as a cover background. Only downgrade when neither is usable.
    if (image && (externalUrl || hasStoredMedia)) {
      return {
        image: {
          ...image,
          ...(externalUrl ? { external_url: externalUrl } : {}),
          position: pickEnumValue(image.position, SECTION_IMAGE_POSITION_VALUES, 'center'),
          size: image.size === 'contain' ? 'contain' : 'cover',
        },
        type,
        ...minHeight,
      };
    }

    return { type: 'none' };
  }

  return { type: 'none', ...minHeight };
}

// Fills every required section layout field with sensible defaults, keeps the
// grid column count (responsive_columns.desktop) in sync with the number of
// columns actually provided, and deep-normalizes each nested column block. This
// lets a cheap model emit a section with just intent + content (columns, an
// optional background, is_hero) and still pass strict validation and render well.
function normalizeSectionContent(
  rawContent: Record<string, unknown>,
  label: string,
  context?: ToolExecutionContext
): SectionBlockContent {
  const isHero = rawContent.is_hero === true;

  let rawColumns = Array.isArray(rawContent.column_blocks) ? rawContent.column_blocks : [];

  // Leniency: a model that flattens the columns into a single list of blocks
  // ([blockA, blockB]) instead of an array-of-columns ([[blockA],[blockB]]) gets
  // treated as one column rather than silently dropping its blocks.
  if (rawColumns.length > 0 && rawColumns.every((column) => isPlainJsonRecord(column) && !Array.isArray(column))) {
    rawColumns = [rawColumns];
  }

  const normalizedColumns: ColumnBlock[][] = rawColumns.map((column, columnIndex) => {
    const blocks = Array.isArray(column) ? column : [];

    return blocks.map((nested, blockIndex) =>
      normalizeNestedColumnBlock(nested, `${label} column ${columnIndex} block ${blockIndex}`, context)
    );
  });

  const columns = normalizedColumns.length > 0 ? normalizedColumns : [[]];
  const desktop = clampSectionColumnCount(columns.length);
  const requestedColumns = isPlainJsonRecord(rawContent.responsive_columns)
    ? rawContent.responsive_columns
    : {};
  const requestedTablet = Number((requestedColumns as Record<string, unknown>).tablet);
  const requestedMobile = Number((requestedColumns as Record<string, unknown>).mobile);
  const tablet = Number.isFinite(requestedTablet)
    ? Math.min(3, Math.max(1, Math.min(desktop, requestedTablet)))
    : Math.min(3, desktop);
  const mobile = Number.isFinite(requestedMobile) ? Math.min(2, Math.max(1, requestedMobile)) : 1;
  const padding = isPlainJsonRecord(rawContent.padding) ? rawContent.padding : {};

  const normalized: Record<string, unknown> = {
    ...rawContent,
    background: normalizeSectionBackground(rawContent.background),
    column_blocks: columns,
    column_gap: pickEnumValue(rawContent.column_gap, SECTION_GAP_VALUES, 'lg'),
    container_type: pickEnumValue(rawContent.container_type, SECTION_CONTAINER_VALUES, 'container'),
    padding: {
      bottom: pickEnumValue((padding as Record<string, unknown>).bottom, SECTION_PADDING_VALUES, 'xl'),
      top: pickEnumValue((padding as Record<string, unknown>).top, SECTION_PADDING_VALUES, 'xl'),
    },
    responsive_columns: { desktop, mobile, tablet },
    vertical_alignment: pickEnumValue(
      rawContent.vertical_alignment,
      SECTION_ALIGN_VALUES,
      isHero ? 'center' : 'start'
    ),
  };

  // A carousel's slides are section bodies of their own: normalize each one the same
  // way (background defaults, nested block normalization and validation), or a slider
  // would carry the only unvalidated nested blocks on the page.
  if (Array.isArray(rawContent.slides)) {
    normalized.slides = rawContent.slides
      .filter((slide): slide is Record<string, unknown> => isPlainJsonRecord(slide))
      .map((slide, slideIndex) => {
        let slideColumns = Array.isArray(slide.column_blocks) ? slide.column_blocks : [];

        if (slideColumns.length > 0 && slideColumns.every((column) => isPlainJsonRecord(column) && !Array.isArray(column))) {
          slideColumns = [slideColumns];
        }

        return {
          background: normalizeSectionBackground(slide.background),
          column_blocks: slideColumns.map((column, columnIndex) => {
            const blocks = Array.isArray(column) ? column : [];

            return blocks.map((nested, blockIndex) =>
              normalizeNestedColumnBlock(
                nested,
                `${label} slide ${slideIndex} column ${columnIndex} block ${blockIndex}`,
                context
              )
            );
          }),
        };
      });
  }

  // Avoid an empty carousel render: only keep slider mode if real slides exist.
  if (normalized.slider === true && !(Array.isArray(normalized.slides) && normalized.slides.length > 0)) {
    normalized.slider = false;
  }

  return normalized as SectionBlockContent;
}

function normalizeBlockContentForType(
  blockType: BlockType,
  rawContent: Record<string, unknown>,
  label: string,
  context?: ToolExecutionContext
) {
  if (!isValidBlockType(blockType)) {
    // Custom block instance: the content is the flat field map its definition
    // describes; nothing to normalize, only to validate.
    const content = cloneJsonValue(rawContent);
    assertValidBlockContent(blockType, content, label, context);

    return content;
  }

  if (blockType === 'section') {
    const normalizedSection = normalizeSectionContent(rawContent, label, context);
    assertValidBlockContent(blockType, normalizedSection, label, context);

    return normalizedSection;
  }

  const content = cloneJsonValue(rawContent);

  if (blockType === 'heading') {
    content.text_content =
      stringifyContentValue(content.text_content) ||
      stringifyContentValue(content.text) ||
      stringifyContentValue(content.title) ||
      stringifyContentValue(content.heading) ||
      'Untitled';
    content.level = typeof content.level === 'number' ? content.level : 1;
  }

  if (blockType === 'text') {
    const htmlContent =
      stringifyContentValue(content.html_content) ||
      stringifyContentValue(content.html) ||
      stringifyContentValue(content.content) ||
      stringifyContentValue(content.text);

    if (htmlContent) {
      content.html_content = /<\/?[a-z][\s\S]*>/i.test(htmlContent)
        ? htmlContent
        : `<p>${escapeHtml(htmlContent)}</p>`;
    }
  }

  if (blockType === 'button') {
    content.text =
      stringifyContentValue(content.text) ||
      stringifyContentValue(content.label) ||
      stringifyContentValue(content.title) ||
      'Learn More';
    content.url =
      stringifyContentValue(content.url) ||
      stringifyContentValue(content.href) ||
      stringifyContentValue(content.link) ||
      '#';
  }

  if (blockType === 'form') {
    content.fields = normalizeFormFields(content.fields);
    content.submit_button_text =
      stringifyContentValue(content.submit_button_text ?? content.submitButtonText ?? content.button_text) ||
      'Send Message';
    content.success_message =
      stringifyContentValue(content.success_message ?? content.successMessage) ||
      'Thanks for reaching out. We will reply as soon as possible.';
  }

  assertValidBlockContent(blockType, content, label, context);

  return content;
}

function normalizeCreateBlock(
  input: z.infer<typeof createCmsBlockInputSchema>,
  index: number,
  context?: ToolExecutionContext
) {
  const blockType = resolveExistingBlockType(input.blockType, `Block ${index}`, context);
  const content = normalizeBlockContentForType(
    blockType,
    cloneJsonRecord(input.content, `Block ${index}`),
    `Block ${index}`,
    context
  );

  return {
    block_type: blockType,
    content,
    order: input.order ?? index,
  };
}

function buildContactPageBlocks(
  contactEmail: string,
  title = 'Contact Us',
  context?: ToolExecutionContext
) {
  return [
    normalizeCreateBlock(
      {
        blockType: 'section',
        content: {
          is_hero: true,
          background: { type: 'none' },
          column_blocks: [
            [
              {
                block_type: 'heading',
                content: {
                  level: 1,
                  textAlign: 'center',
                  text_content: title,
                },
                temp_id: createNestedTempId('heading'),
              },
              {
                block_type: 'text',
                content: {
                  html_content:
                    '<p>Have a question, project, or support request? Send us a note and we will get back to you soon.</p>',
                },
                temp_id: createNestedTempId('text'),
              },
            ],
          ],
          column_gap: 'lg',
          container_type: 'container',
          padding: { bottom: 'xl', top: 'xl' },
          responsive_columns: { desktop: 1, mobile: 1, tablet: 1 },
          vertical_alignment: 'center',
        },
      },
      0,
      context
    ),
    normalizeCreateBlock(
      {
        blockType: 'form',
        content: {
          fields: [
            {
              field_type: 'text',
              is_required: true,
              label: 'Name',
              placeholder: 'Your name',
              temp_id: 'field-name',
            },
            {
              field_type: 'email',
              is_required: true,
              label: 'Email',
              placeholder: 'you@example.com',
              temp_id: 'field-email',
            },
            {
              field_type: 'textarea',
              is_required: true,
              label: 'Message',
              placeholder: 'How can we help?',
              temp_id: 'field-message',
            },
          ],
          // Deliberately no address here: block content is serialized into the page
          // payload, so an address stored on the block would be published. A generated
          // form with no form_key falls back to the site contact address, which the
          // owner sets once in CMS → Messages.
          submit_button_text: 'Send Message',
          success_message: 'Thanks for reaching out. We will reply as soon as possible.',
        },
      },
      1,
      context
    ),
  ];
}

function normalizeCreateBlocks(
  blocks: Array<z.infer<typeof createCmsBlockInputSchema>> | undefined,
  fallbackContactEmail?: string,
  title?: string,
  context?: ToolExecutionContext
) {
  if ((!blocks || blocks.length === 0) && fallbackContactEmail) {
    return buildContactPageBlocks(fallbackContactEmail, title, context);
  }

  return (blocks || []).map((block, index) => normalizeCreateBlock(block, index, context));
}

async function assertUniqueSlug(params: {
  contentType: CmsContentType;
  languageId: number;
  slug: string;
  supabase: SupabaseLike;
}) {
  const table =
    params.contentType === 'page'
      ? 'pages'
      : params.contentType === 'post'
        ? 'posts'
        : 'products';
  const { data, error } = await params.supabase
    .from(table)
    .select('id, title, slug, language_id')
    .eq('slug', params.slug)
    .eq('language_id', params.languageId);

  if (error) {
    throw new Error(`Failed to check ${params.contentType} slug uniqueness: ${serializeError(error)}`);
  }

  const existingItems = Array.isArray(data) ? data : [];

  if (existingItems.length > 0) {
    return {
      duplicate: true,
      existingItem: existingItems[0],
      mutationExecuted: false,
      success: false,
      message: `A ${params.contentType} with slug "${params.slug}" already exists for this language.`,
    };
  }

  return null;
}

async function resolveCreateTranslationGroup(params: {
  contentType: CmsContentType;
  languageCode: string;
  languageId: number;
  suppliedTranslationGroupId?: string;
  supabase: SupabaseLike;
}) {
  if (!params.suppliedTranslationGroupId) {
    return {
      translationGroupId: undefined,
    };
  }

  const table =
    params.contentType === 'page'
      ? 'pages'
      : params.contentType === 'post'
        ? 'posts'
        : 'products';
  const { data, error } = await params.supabase
    .from(table)
    .select('id, title, slug, language_id, translation_group_id')
    .eq('translation_group_id', params.suppliedTranslationGroupId);

  if (error) {
    throw new Error(
      `Failed to inspect ${params.contentType} translation group: ${serializeError(error)}`
    );
  }

  const rows = Array.isArray(data) ? data : [];

  if (rows.length === 0) {
    return {
      result: {
        message: `The ${params.contentType} translation group "${params.suppliedTranslationGroupId}" was not found.`,
        mutationExecuted: false,
        success: false,
      },
      translationGroupId: params.suppliedTranslationGroupId,
    };
  }

  const existingTranslation = rows.find(
    (row: any) => Number(row.language_id) === params.languageId
  );

  if (existingTranslation) {
    return {
      result: {
        duplicateTranslation: true,
        existingItem: existingTranslation,
        message: `A ${params.contentType} translation already exists for ${params.languageCode} in this translation group.`,
        mutationExecuted: false,
        success: false,
      },
      translationGroupId: params.suppliedTranslationGroupId,
    };
  }

  return {
    translationGroupId: params.suppliedTranslationGroupId,
  };
}

async function insertContentBlocks(params: {
  blocks: Array<{ block_type: BlockType; content: Record<string, unknown>; order: number }>;
  contentType: CmsContentType;
  // Products are uuid-keyed; pages and posts are bigint-keyed.
  itemId: number | string;
  languageId: number;
  supabase: SupabaseLike;
}) {
  if (params.blocks.length === 0) {
    return [];
  }

  // blocks has a check_exactly_one_parent constraint: exactly one of page_id,
  // post_id, product_id may be set.
  const blockRows = params.blocks.map((block, index) => ({
    block_type: block.block_type,
    content: block.content,
    language_id: params.languageId,
    order: block.order ?? index,
    page_id: params.contentType === 'page' ? params.itemId : null,
    post_id: params.contentType === 'post' ? params.itemId : null,
    product_id: params.contentType === 'product' ? params.itemId : null,
  }));
  const { data, error } = await params.supabase.from('blocks').insert(blockRows).select('*');

  if (error) {
    throw new Error(`Failed to insert ${params.contentType} blocks: ${serializeError(error)}`);
  }

  void maybeTriggerStockPhotoDownloads(params.blocks, params.supabase);

  return Array.isArray(data) ? data : [];
}

async function rollbackCreatedCmsItem(params: {
  contentType: CmsContentType;
  itemId: number | string;
  supabase: SupabaseLike;
}) {
  const table =
    params.contentType === 'page'
      ? 'pages'
      : params.contentType === 'post'
        ? 'posts'
        : 'products';

  await params.supabase.from(table).delete().eq('id', params.itemId);
}

function getCreateEditPath(contentType: CmsContentType, entityId: string | number) {
  if (contentType === 'page') {
    return `/cms/pages/${entityId}/edit`;
  }

  if (contentType === 'post') {
    return `/cms/posts/${entityId}/edit`;
  }

  return `/cms/products/${entityId}/edit`;
}

function getCollectionPath(contentType: CmsContentType) {
  if (contentType === 'page') {
    return '/cms/pages';
  }

  if (contentType === 'post') {
    return '/cms/posts';
  }

  return '/cms/products';
}

export async function executeUpdateNavigationBar(
  input: UpdateNavigationBarInput,
  context?: ToolExecutionContext
) {
  const parsed = updateNavigationBarInputSchema.parse(input);
  const supabase = getSupabase(context);

  if (parsed.mode === 'replace') {
    await assertNavigationReplacementInputIsSafe({
      items: parsed.items,
      languageCode: parsed.languageCode,
      menuKey: 'HEADER',
      supabase,
    });
  }

  const confirmation = getConfirmationPreview({
    action: 'UPDATE NAVIGATION',
    context,
    payload: { input: parsed, tool: 'update_navigation_bar' },
    preview: {
      itemCount: parsed.items.length,
      languageCode: parsed.languageCode,
      mode: parsed.mode,
      target: 'header navigation',
    },
    subject: `${parsed.mode} header`,
  });

  if (confirmation) {
    return confirmation;
  }

  const result =
    parsed.mode === 'update'
      ? await updateNavigationMenuItem({
          items: parsed.items,
          languageCode: parsed.languageCode,
          match: parsed.match,
          menuKey: 'HEADER',
          supabase,
        })
      : parsed.mode === 'append'
        ? await appendNavigationMenuItems({
            items: parsed.items,
            languageCode: parsed.languageCode,
            menuKey: 'HEADER',
            supabase,
          })
        : await replaceNavigationMenu({
            items: parsed.items,
            languageCode: parsed.languageCode,
            menuKey: 'HEADER',
            supabase,
          });

  revalidateGlobalCmsSurfaces(context);

  return {
    ...result,
    mutationExecuted: true,
    mode: parsed.mode,
    success: true,
  };
}

export async function executeUpdateFooter(input: UpdateFooterInput, context?: ToolExecutionContext) {
  const parsed = updateFooterInputSchema.parse(input);

  if (!parsed.links?.length && !parsed.copyright) {
    throw new Error('update_footer requires links or copyright.');
  }

  const supabase = getSupabase(context);
  const confirmation = getConfirmationPreview({
    action: 'UPDATE FOOTER',
    context,
    payload: { input: parsed, tool: 'update_footer' },
    preview: {
      copyrightUpdated: Boolean(parsed.copyright),
      linkCount: parsed.links?.length || 0,
      languageCode: parsed.languageCode,
      target: 'footer',
    },
    subject: parsed.languageCode,
  });

  if (confirmation) {
    return confirmation;
  }

  let footerNavigation:
    | {
        insertedCount: number;
        languageCode: string;
        menuKey: 'FOOTER';
        skippedCount: number;
        updatedCount: number;
      }
    | null = null;

  if (parsed.links?.length) {
    footerNavigation = await replaceNavigationMenu({
      items: parsed.links,
      languageCode: parsed.languageCode,
      menuKey: 'FOOTER',
      supabase,
    });
  }

  if (parsed.copyright) {
    const { error } = await supabase.from('site_settings').upsert({
      key: 'footer_copyright',
      value: parsed.copyright,
    });

    if (error) {
      throw new Error(`Failed to update footer copyright: ${serializeError(error)}`);
    }
  }

  revalidateGlobalCmsSurfaces(context);

  return {
    copyrightUpdated: Boolean(parsed.copyright),
    footerNavigation,
    mutationExecuted: true,
    success: true,
  };
}

function normalizeSearchText(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function scoreDocument(queryTerms: string[], values: string[]) {
  const haystack = values.map(normalizeSearchText).join(' ');

  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function pickSnippet(values: string[], queryTerms: string[]) {
  return (
    values.find((value) =>
      queryTerms.some((term) => normalizeSearchText(value).includes(term))
    ) ||
    values.find((value) => value.trim().length > 0) ||
    'No excerpt available.'
  ).slice(0, 500);
}

export async function executeSearchDocumentation(
  input: SearchDocumentationInput,
  context?: ToolExecutionContext
) {
  const parsed = searchDocumentationInputSchema.parse(input);
  const supabase = getSupabase(context);
  const queryTerms = parsed.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const [postsResult, pagesResult] = await Promise.all([
    supabase
      .from('posts')
      .select('id, title, slug, excerpt, subtitle, meta_description, status, updated_at')
      .eq('status', 'published')
      .limit(100),
    supabase
      .from('pages')
      .select('id, title, slug, meta_description, status, updated_at')
      .eq('status', 'published')
      .limit(100),
  ]);

  if (postsResult.error) {
    throw new Error(`Failed to search documentation posts: ${serializeError(postsResult.error)}`);
  }

  if (pagesResult.error) {
    throw new Error(`Failed to search documentation pages: ${serializeError(pagesResult.error)}`);
  }

  const postSnippets: DocumentationSnippet[] = (postsResult.data ?? []).map((post: any) => ({
    excerpt: pickSnippet(
      [post.excerpt, post.subtitle, post.meta_description, post.slug].filter(Boolean),
      queryTerms
    ),
    source: 'post',
    title: post.title,
    url: `/article/${post.slug}`,
  }));

  const pageSnippets: DocumentationSnippet[] = (pagesResult.data ?? []).map((page: any) => ({
    excerpt: pickSnippet([page.meta_description, page.slug].filter(Boolean), queryTerms),
    source: 'page',
    title: page.title,
    url: page.slug === 'home' ? '/' : `/${page.slug}`,
  }));

  const results = [...postSnippets, ...pageSnippets]
    .map((snippet) => ({
      ...snippet,
      score: scoreDocument(queryTerms, [snippet.title, snippet.excerpt, snippet.url]),
    }))
    .filter((snippet) => snippet.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, parsed.limit)
    .map((snippet) => ({
      excerpt: snippet.excerpt,
      source: snippet.source,
      title: snippet.title,
      url: snippet.url,
    }));

  return {
    query: parsed.query,
    results,
    success: true,
  };
}

export async function executeSearchDocumentationWithTimeout(
  input: SearchDocumentationInput,
  context?: ToolExecutionContext,
  timeoutMs = SEARCH_DOCUMENTATION_TIMEOUT_MS
) {
  const parsed = searchDocumentationInputSchema.safeParse(input);
  const query = parsed.success ? parsed.data.query : '';

  return withTimeoutFallback(
    executeSearchDocumentation(input, context),
    timeoutMs,
    () => ({
      message:
        'Documentation search took too long to respond. Please try again or ask a more specific question.',
      query,
      results: [],
      success: false,
      timedOut: true,
    })
  );
}

const knownOrderStatuses = [
  'pending',
  'trial',
  'paid',
  'shipped',
  'cancelled',
  'refunded',
  'failed',
] as const;

type KnownOrderStatus = (typeof knownOrderStatuses)[number];

const orderStatusAliases: Record<string, KnownOrderStatus> = {
  awaiting: 'pending',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  complete: 'paid',
  completed: 'paid',
  failed: 'failed',
  paid: 'paid',
  payment_pending: 'pending',
  pending: 'pending',
  refund: 'refunded',
  refunded: 'refunded',
  refunds: 'refunded',
  shipped: 'shipped',
  trial: 'trial',
  trials: 'trial',
};

function normalizeOrderStatus(value: unknown) {
  const normalized = String(value ?? 'unknown').trim().toLowerCase();
  return normalized || 'unknown';
}

function buildOrderStatusCounts(rows: any[]) {
  const counts: Record<string, number> = Object.fromEntries(
    knownOrderStatuses.map((status) => [status, 0])
  );

  for (const row of rows) {
    const status = normalizeOrderStatus(row.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return counts;
}

function inferRequestedOrderStatus(query: string) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9_]+/g, ' ');
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  for (const term of terms) {
    const status = orderStatusAliases[term];

    if (status) {
      return status;
    }
  }

  return null;
}

function toFiniteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function executeFetchEcommerceStats(
  input: FetchEcommerceStatsInput,
  context?: ToolExecutionContext
) {
  const parsed = fetchEcommerceStatsInputSchema.parse(input);
  const supabase = getSupabase(context);

  const now = new Date();
  let startDate: Date | null = null;
  let endDate: Date | null = null;

  switch (parsed.timeRange) {
    case 'today':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'this_month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_7_days':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'last_30_days':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      break;
    case 'last_90_days':
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case 'all_time':
      startDate = null;
      break;
  }

  const currency = parsed.currency?.toUpperCase();
  const requestedStatus = inferRequestedOrderStatus(parsed.query);
  const orderQueryBuilder = supabase
    .from('orders')
    .select('id, status, total, currency, created_at, paid_at');

  if (currency) {
    orderQueryBuilder.eq('currency', currency);
  }
  if (startDate) {
    orderQueryBuilder.gte('created_at', startDate.toISOString());
  }
  if (endDate) {
    orderQueryBuilder.lte('created_at', endDate.toISOString());
  }

  const shouldFetchLineItems =
    parsed.reportType === 'products' ||
    parsed.reportType === 'revenue' ||
    parsed.reportType === 'general';
  const lineItemsQueryBuilder = shouldFetchLineItems
    ? supabase
        .from('order_items')
        .select(`
          quantity,
          price_at_purchase,
          products!inner (
            id,
            title,
            product_type
          ),
          orders!inner (
            id,
            status,
            paid_at,
            currency
          )
        `)
        .eq('orders.status', 'paid')
    : null;

  if (lineItemsQueryBuilder) {
    if (currency) {
      lineItemsQueryBuilder.eq('orders.currency', currency);
    }
    if (startDate) {
      lineItemsQueryBuilder.gte('orders.paid_at', startDate.toISOString());
    }
    if (endDate) {
      lineItemsQueryBuilder.lte('orders.paid_at', endDate.toISOString());
    }
  }

  const shouldFetchAllTimeOrderStatuses =
    parsed.timeRange !== 'all_time' && (parsed.reportType === 'orders' || requestedStatus);
  const allTimeOrderQueryBuilder = shouldFetchAllTimeOrderStatuses
    ? supabase.from('orders').select('id, status, currency')
    : null;

  if (allTimeOrderQueryBuilder && currency) {
    allTimeOrderQueryBuilder.eq('currency', currency);
  }

  const [
    { data: orderData, error: orderError },
    { data: lineItemData, error: lineItemError },
    allTimeOrderResult,
  ] = await Promise.all([
    orderQueryBuilder,
    lineItemsQueryBuilder ?? Promise.resolve({ data: [], error: null }),
    allTimeOrderQueryBuilder ?? Promise.resolve({ data: null, error: null }),
  ]);

  if (orderError) {
    throw new Error(`Failed to fetch ecommerce stats: ${serializeError(orderError)}`);
  }

  if (lineItemError) {
    throw new Error(`Failed to fetch ecommerce stats: ${serializeError(lineItemError)}`);
  }

  if (allTimeOrderResult.error) {
    throw new Error(`Failed to fetch ecommerce stats: ${serializeError(allTimeOrderResult.error)}`);
  }

  const orderRows = Array.isArray(orderData) ? orderData : [];
  const rows = Array.isArray(lineItemData) ? lineItemData : [];
  const orderStatusCounts = buildOrderStatusCounts(orderRows);
  const allTimeOrderRows = Array.isArray(allTimeOrderResult.data) ? allTimeOrderResult.data : null;
  const allTimeOrderStatusCounts = allTimeOrderRows ? buildOrderStatusCounts(allTimeOrderRows) : null;
  const revenueByCurrency: Record<string, number> = {};

  for (const row of rows) {
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const orderCurrency = String(order?.currency || currency || 'unknown').toUpperCase();
    revenueByCurrency[orderCurrency] =
      (revenueByCurrency[orderCurrency] ?? 0) +
      (toFiniteNumber(row.quantity) * toFiniteNumber(row.price_at_purchase)) / 100;
  }

  const report: Record<string, any> = {
    currency: currency ?? null,
    currencyFiltered: Boolean(currency),
    orderStatusCounts,
    paidOrderCount: orderStatusCounts.paid ?? 0,
    query: parsed.query,
    reportType: parsed.reportType,
    revenueByCurrency,
    timeRange: parsed.timeRange,
    totalOrders: orderRows.length,
    totalRevenue: Object.values(revenueByCurrency).reduce(
      (sum: number, revenue: number) => sum + revenue,
      0
    ),
  };

  if (allTimeOrderStatusCounts) {
    report.allTimeOrderStatusCounts = allTimeOrderStatusCounts;
  }

  if (requestedStatus) {
    report.matchingOrderStatus = {
      allTimeCount: allTimeOrderStatusCounts?.[requestedStatus] ?? orderStatusCounts[requestedStatus] ?? 0,
      count: orderStatusCounts[requestedStatus] ?? 0,
      status: requestedStatus,
      timeRange: parsed.timeRange,
    };
  }

  if (parsed.reportType === 'products' || parsed.reportType === 'revenue' || parsed.reportType === 'general') {
    const productStats: Record<string, { id: string; revenue: number; quantity: number; title: string; type: string }> = {};

    for (const row of rows) {
      const product = Array.isArray(row.products) ? row.products[0] : row.products;

      if (!product?.id) {
        continue;
      }

      const productId = product.id;
      if (!productStats[productId]) {
        productStats[productId] = {
          id: productId,
          quantity: 0,
          revenue: 0,
          title: product.title,
          type: product.product_type,
        };
      }
      productStats[productId].quantity += toFiniteNumber(row.quantity);
      productStats[productId].revenue +=
        (toFiniteNumber(row.quantity) * toFiniteNumber(row.price_at_purchase)) / 100;
    }

    report.topProducts = Object.values(productStats)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }

  return {
    report,
    success: true,
  };
}

export async function executeReadCurrentCmsItem(
  input: ReadCurrentCmsItemInput,
  context?: ToolExecutionContext
) {
  const parsed = readCurrentCmsItemInputSchema.parse(input);
  const supabase = getSupabase(context);
  const pageContext = await resolveEditingCmsContext(parsed.cmsTarget, context);
  const entityId = getCmsEntityId(pageContext);
  const table =
    pageContext.contentType === 'page'
      ? 'pages'
      : pageContext.contentType === 'post'
        ? 'posts'
        : 'products';
  const { data: item, error: itemError } = await supabase
    .from(table)
    .select('*')
    .eq('id', entityId)
    .single();

  if (itemError || !item) {
    throw new Error(
      `Failed to read current ${pageContext.contentType}: ${serializeError(itemError)}`
    );
  }

  let blocks: ReturnType<typeof summarizeBlockRow>[] = [];

  if (parsed.includeBlocks) {
    const blockParentColumn =
      pageContext.contentType === 'page'
        ? 'page_id'
        : pageContext.contentType === 'post'
          ? 'post_id'
          : 'product_id';
    const { data: blockRows, error: blocksError } = await supabase
      .from('blocks')
      .select('id, page_id, post_id, product_id, language_id, block_type, content, order')
      .eq(blockParentColumn, entityId);

    if (blocksError) {
      throw new Error(`Failed to read current ${pageContext.contentType} blocks: ${serializeError(blocksError)}`);
    }

    blocks = (Array.isArray(blockRows) ? blockRows : [])
      .slice()
      .sort((a: any, b: any) => Number(a.order) - Number(b.order))
      .map((block: any) => summarizeBlockRow(block, parsed.includeBlockContent));
  }

  return {
    blocks,
    context: pageContext,
    item,
    success: true,
  };
}

const PAGE_FIELD_NAMES = new Set([
  'feature_image_id',
  'language_id',
  'meta_description',
  'meta_title',
  'slug',
  'status',
  'title',
]);
const POST_FIELD_NAMES = new Set([
  'excerpt',
  'feature_image_id',
  'label',
  'language_id',
  'meta_description',
  'meta_title',
  'published_at',
  'slug',
  'status',
  'subtitle',
  'title',
]);
const PRODUCT_FIELD_NAMES = new Set([
  'description_json',
  'language_id',
  'meta_description',
  'meta_title',
  'short_description',
  'slug',
  'status',
  'title',
]);
const NULLABLE_TEXT_FIELD_NAMES = new Set([
  'excerpt',
  'feature_image_id',
  'label',
  'meta_description',
  'meta_title',
  'published_at',
  'short_description',
  'subtitle',
]);

function getAllowedFieldNames(contentType: CortexAiPageContext['contentType']) {
  if (contentType === 'page') {
    return PAGE_FIELD_NAMES;
  }

  if (contentType === 'post') {
    return POST_FIELD_NAMES;
  }

  return PRODUCT_FIELD_NAMES;
}

function normalizeCmsFieldValue(fieldName: string, value: unknown) {
  if (NULLABLE_TEXT_FIELD_NAMES.has(fieldName) && value === '') {
    return null;
  }

  return value;
}

function assertValidStatusForContentType(
  contentType: CortexAiPageContext['contentType'],
  status: unknown
) {
  if (typeof status !== 'string') {
    return;
  }

  const allowedStatuses =
    contentType === 'product'
      ? ['active', 'archived', 'draft']
      : ['archived', 'draft', 'published'];

  if (!allowedStatuses.includes(status)) {
    throw new Error(
      `Status "${status}" is not valid for ${contentType}. Allowed statuses: ${allowedStatuses.join(', ')}.`
    );
  }
}

function buildCurrentCmsFieldUpdate(
  fields: UpdateCurrentCmsFieldsInput['fields'],
  pageContext: CortexAiPageContext
) {
  const allowedFieldNames = getAllowedFieldNames(pageContext.contentType);
  const updatePayload: Record<string, unknown> = {};

  for (const [fieldName, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) {
      continue;
    }

    if (!allowedFieldNames.has(fieldName)) {
      throw new Error(
        `Field "${fieldName}" cannot be updated for ${pageContext.contentType} content.`
      );
    }

    if (fieldName === 'status') {
      assertValidStatusForContentType(pageContext.contentType, rawValue);
    }



    updatePayload[fieldName] = normalizeCmsFieldValue(fieldName, rawValue);
  }

  return updatePayload;
}

export async function executeUpdateCurrentCmsFields(
  input: UpdateCurrentCmsFieldsInput,
  context?: ToolExecutionContext
) {
  const parsed = updateCurrentCmsFieldsInputSchema.parse(input);
  const supabase = getSupabase(context);
  const pageContext = await resolveEditingCmsContext(parsed.cmsTarget, context);
  const entityId = getCmsEntityId(pageContext);
  const updatePayload = buildCurrentCmsFieldUpdate(parsed.fields, pageContext);
  const updatedFields = Object.keys(updatePayload);

  if (updatedFields.length === 0) {
    throw new Error('update_current_cms_fields requires at least one supported field.');
  }

  const confirmation = getConfirmationPreview({
    action: 'UPDATE CMS FIELDS',
    context,
    payload: {
      contentType: pageContext.contentType,
      entityId,
      fields: updatePayload,
      tool: 'update_current_cms_fields',
    },
    preview: {
      contentType: pageContext.contentType,
      entityId,
      fields: updatedFields,
      slug: pageContext.slug,
      title: pageContext.title,
    },
    subject: `${pageContext.contentType} ${String(entityId)}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const revisionBaseline = await captureCmsRevision(context, pageContext.contentType, entityId);

  // A feature image supplied as an external URL (e.g. a stock photo) must be
  // imported into the media library first — feature_image_id is a UUID FK.
  if (typeof updatePayload.feature_image_id === 'string') {
    updatePayload.feature_image_id = await resolveMediaReference(
      updatePayload.feature_image_id,
      context,
      typeof pageContext.title === 'string' ? pageContext.title : undefined
    );
  }

  const table =
    pageContext.contentType === 'page'
      ? 'pages'
      : pageContext.contentType === 'post'
        ? 'posts'
        : 'products';
  const { data: item, error } = await supabase
    .from(table)
    .update({
      ...updatePayload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entityId)
    .select('id, language_id, slug, status, title')
    .single();

  if (error || !item) {
    throw new Error(
      `Failed to update current ${pageContext.contentType}: ${serializeError(error)}`
    );
  }

  await commitCmsRevision(context, pageContext.contentType, entityId, revisionBaseline);

  revalidateCurrentCmsSurfaces(context, pageContext, item.slug);

  return {
    contentType: pageContext.contentType,
    entityId,
    mutationExecuted: true,
    slug: item.slug,
    success: true,
    updatedFields,
  };
}

export async function executeUpdateContentBlock(
  input: UpdateContentBlockInput,
  context?: ToolExecutionContext
) {
  const parsed = updateContentBlockInputSchema.parse(input);
  const supabase = getSupabase(context);
  const pageContext = await resolveEditingCmsContext(parsed.cmsTarget, context);
  const { data: block, error: blockError } = await supabase
    .from('blocks')
    .select('id, page_id, post_id, product_id, language_id, block_type, content, order')
    .eq('id', parsed.blockId)
    .single();

  if (blockError || !block) {
    throw new Error(`Failed to read block ${parsed.blockId}: ${serializeError(blockError)}`);
  }

  assertBlockBelongsToCurrentContext(block, pageContext);
  context = await withCustomBlockDefinitions(context, [block.block_type, block.content, parsed.content]);

  const existingBlockType = resolveExistingBlockType(block.block_type, `Block ${parsed.blockId}`, context);
  assertRequestedBlockTypeMatches(parsed.blockType, existingBlockType, `Block ${parsed.blockId}`);
  const existingContent = cloneJsonRecord(block.content, `Block ${parsed.blockId}`);
  const nextContent = buildNextTopLevelBlockContent(
    existingBlockType,
    existingContent,
    parsed.content,
    context
  );
  assertValidBlockContent(existingBlockType, nextContent, `Block ${parsed.blockId}`, context);

  const confirmation = getConfirmationPreview({
    action: 'UPDATE CONTENT BLOCK',
    context,
    payload: {
      blockId: parsed.blockId,
      blockType: existingBlockType,
      content: nextContent,
      tool: 'update_content_block',
    },
    preview: {
      blockId: parsed.blockId,
      blockType: existingBlockType,
      contentType: pageContext.contentType,
      entityId: getCmsEntityId(pageContext),
    },
    subject: `${existingBlockType} block ${parsed.blockId}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const revisionBaseline = await captureCmsRevision(
    context,
    pageContext.contentType,
    getCmsEntityId(pageContext)
  );

  const { data: updatedBlock, error: updateError } = await supabase
    .from('blocks')
    .update({
      content: nextContent,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.blockId)
    .select('id, block_type, order')
    .single();

  if (updateError || !updatedBlock) {
    throw new Error(`Failed to update block ${parsed.blockId}: ${serializeError(updateError)}`);
  }

  await commitCmsRevision(
    context,
    pageContext.contentType,
    getCmsEntityId(pageContext),
    revisionBaseline
  );

  await patchOpenProductDraft({
    patch: ({ blocks }) => ({
      blocks: blocks.map((draftBlock: any) =>
        String(draftBlock?.id) === String(parsed.blockId)
          ? { ...draftBlock, content: nextContent }
          : draftBlock
      ),
    }),
    productId: block.product_id,
    supabase,
  });

  void maybeTriggerStockPhotoDownloads([{ content: nextContent }], supabase);

  revalidateCurrentCmsSurfaces(context, pageContext);

  return {
    blockId: updatedBlock.id,
    blockType: updatedBlock.block_type,
    contentUpdated: true,
    mutationExecuted: true,
    success: true,
  };
}

export async function executeInsertContentBlock(
  input: InsertContentBlockInput,
  context?: ToolExecutionContext
) {
  const parsed = insertContentBlockInputSchema.parse(input);
  context = await withCustomBlockDefinitions(context, parsed.block);
  const supabase = getSupabase(context);
  const target = await resolveCmsTarget(parsed, context);

  // Products have their own "Product Description Blocks" (blocks.product_id),
  // uuid-keyed rather than bigint-keyed like pages/posts.
  const itemId = target.contentType === 'product' ? target.item.id : Number(target.item.id);
  const parentColumn =
    target.contentType === 'page'
      ? 'page_id'
      : target.contentType === 'post'
        ? 'post_id'
        : 'product_id';
  const loadBlocks = async () => {
    const { data, error } = await supabase
      .from('blocks')
      .select('id, page_id, post_id, product_id, language_id, block_type, content, order')
      .eq(parentColumn, itemId);

    if (error) {
      throw new Error(`Failed to read ${target.contentType} blocks: ${serializeError(error)}`);
    }

    return (Array.isArray(data) ? data : []).sort(
      (a: any, b: any) => Number(a.order) - Number(b.order)
    );
  };
  const resolveOrder = (blocks: any[]) => {
    if (parsed.position === 'start') {
      return 0;
    }

    if (parsed.position === 'end') {
      const orders = blocks.map((block: any) => Number(block.order)).filter(Number.isFinite);
      return orders.length > 0 ? Math.max(...orders) + 1 : 0;
    }

    const anchorBlock = parsed.anchorBlockId
      ? blocks.find((block: any) => Number(block.id) === parsed.anchorBlockId)
      : parsed.anchorBlockType
        ? blocks.find((block: any) => block.block_type === parsed.anchorBlockType)
        : null;

    if (!anchorBlock) {
      throw new Error(
        parsed.anchorBlockType
          ? `Could not find a ${parsed.anchorBlockType} block to insert ${parsed.position}.`
          : `Could not find block ${parsed.anchorBlockId} to insert ${parsed.position}.`
      );
    }

    const anchorOrder = Number(anchorBlock.order);

    return parsed.position === 'before' ? anchorOrder : anchorOrder + 1;
  };
  const normalizedBlock = normalizeCreateBlock(parsed.block, 0, context);
  const blocks = await loadBlocks();
  const newOrder = resolveOrder(blocks);
  const targetContext: CortexAiPageContext = {
    contentType: target.contentType,
    entityId: target.item.id,
    languageId: target.item.language_id,
    slug: target.item.slug,
    title: target.item.title,
    translationGroupId: target.item.translation_group_id,
  };
  const confirmation = getConfirmationPreview({
    action: 'INSERT CONTENT BLOCK',
    context,
    payload: {
      block: normalizedBlock,
      order: newOrder,
      target: {
        contentType: target.contentType,
        id: target.item.id,
        slug: target.item.slug,
      },
      tool: 'insert_content_block',
    },
    preview: {
      anchorBlockId: parsed.anchorBlockId,
      anchorBlockType: parsed.anchorBlockType,
      blockType: normalizedBlock.block_type,
      contentType: target.contentType,
      entityId: target.item.id,
      position: parsed.position,
      slug: target.item.slug,
      summary: `Insert ${normalizedBlock.block_type} block ${parsed.position} ${parsed.anchorBlockType ? `the first ${parsed.anchorBlockType} block` : parsed.anchorBlockId ? `block ${parsed.anchorBlockId}` : 'the content'} on ${target.contentType} "${target.item.title || target.item.slug}".`,
      title: target.item.title,
    },
    subject: `${normalizedBlock.block_type} block on ${target.contentType} ${target.item.id}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const latestBlocks = await loadBlocks();
  const latestOrder = resolveOrder(latestBlocks);
  const blocksToShift = latestBlocks
    .filter((block: any) => Number(block.order) >= latestOrder)
    .sort((a: any, b: any) => Number(b.order) - Number(a.order));

  const revisionBaseline = await captureCmsRevision(context, target.contentType, itemId);

  for (const block of blocksToShift) {
    const { error } = await supabase
      .from('blocks')
      .update({
        order: Number(block.order) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', block.id);

    if (error) {
      throw new Error(`Failed to shift block ${block.id}: ${serializeError(error)}`);
    }
  }

  const { data: insertedBlock, error: insertError } = await supabase
    .from('blocks')
    .insert({
      block_type: normalizedBlock.block_type,
      content: normalizedBlock.content,
      language_id: target.item.language_id,
      order: latestOrder,
      page_id: target.contentType === 'page' ? itemId : null,
      post_id: target.contentType === 'post' ? itemId : null,
      product_id: target.contentType === 'product' ? itemId : null,
    })
    .select('id, block_type, order')
    .single();

  if (insertError || !insertedBlock) {
    throw new Error(`Failed to insert content block: ${serializeError(insertError)}`);
  }

  if (target.contentType === 'product') {
    await patchOpenProductDraft({
      patch: ({ blocks }) => ({
        blocks: [
          ...blocks.map((draftBlock: any) =>
            Number(draftBlock?.order) >= latestOrder
              ? { ...draftBlock, order: Number(draftBlock.order) + 1 }
              : draftBlock
          ),
          {
            block_type: normalizedBlock.block_type,
            content: normalizedBlock.content,
            id: insertedBlock.id,
            language_id: target.item.language_id,
            order: latestOrder,
            page_id: null,
            post_id: null,
            product_id: itemId,
          },
        ].sort((a: any, b: any) => Number(a.order) - Number(b.order)),
      }),
      productId: itemId,
      supabase,
    });
  }

  await commitCmsRevision(context, target.contentType, itemId, revisionBaseline);

  void maybeTriggerStockPhotoDownloads([normalizedBlock], supabase);

  revalidateCurrentCmsSurfaces(context, targetContext);

  return {
    blockId: insertedBlock.id,
    blockType: insertedBlock.block_type,
    contentType: target.contentType,
    entityId: target.item.id,
    mutationExecuted: true,
    order: insertedBlock.order,
    success: true,
  };
}

export async function executeUpdateSectionColumnBlock(
  input: UpdateSectionColumnBlockInput,
  context?: ToolExecutionContext
) {
  const parsed = updateSectionColumnBlockInputSchema.parse(input);
  const supabase = getSupabase(context);
  const pageContext = await resolveEditingCmsContext(parsed.cmsTarget, context);
  const { data: parentBlock, error: blockError } = await supabase
    .from('blocks')
    .select('id, page_id, post_id, product_id, language_id, block_type, content, order')
    .eq('id', parsed.parentBlockId)
    .single();

  if (blockError || !parentBlock) {
    throw new Error(
      `Failed to read parent block ${parsed.parentBlockId}: ${serializeError(blockError)}`
    );
  }

  assertBlockBelongsToCurrentContext(parentBlock, pageContext);
  context = await withCustomBlockDefinitions(context, [parentBlock.block_type, parentBlock.content, parsed.content]);

  const parentBlockType = resolveExistingBlockType(
    parentBlock.block_type,
    `Parent block ${parsed.parentBlockId}`,
    context
  );

  if (parentBlockType !== 'section') {
    throw new Error(
      `Parent block ${parsed.parentBlockId} must be a section block, not "${parentBlockType}".`
    );
  }

  const parentContent = cloneJsonRecord(
    parentBlock.content,
    `Parent block ${parsed.parentBlockId}`
  ) as SectionBlockContent;
  assertValidBlockContent(
    parentBlockType,
    parentContent,
    `Parent block ${parsed.parentBlockId}`,
    context
  );

  const targetColumn = parentContent.column_blocks?.[parsed.columnIndex];
  const targetNestedBlock = targetColumn?.[parsed.blockIndex];

  if (!targetNestedBlock) {
    throw new Error(
      `Nested block was not found at column ${parsed.columnIndex}, index ${parsed.blockIndex}.`
    );
  }

  const nestedBlockType = resolveExistingBlockType(
    targetNestedBlock.block_type,
    `Nested block ${parsed.columnIndex}:${parsed.blockIndex}`,
    context
  );
  assertRequestedBlockTypeMatches(
    parsed.blockType,
    nestedBlockType,
    `Nested block ${parsed.columnIndex}:${parsed.blockIndex}`
  );
  assertValidBlockContent(
    nestedBlockType,
    parsed.content,
    `Nested block ${parsed.columnIndex}:${parsed.blockIndex}`,
    context
  );

  const nextColumnBlocks = parentContent.column_blocks.map((column, columnIndex) =>
    columnIndex === parsed.columnIndex
      ? column.map((nestedBlock, blockIndex) =>
          blockIndex === parsed.blockIndex
            ? {
                ...nestedBlock,
                content: parsed.content,
              }
            : nestedBlock
        )
      : column
  );
  const nextParentContent: SectionBlockContent = {
    ...parentContent,
    column_blocks: nextColumnBlocks,
  };
  assertValidBlockContent(
    parentBlockType,
    nextParentContent,
    `Updated parent block ${parsed.parentBlockId}`,
    context
  );

  const confirmation = getConfirmationPreview({
    action: 'UPDATE NESTED BLOCK',
    context,
    payload: {
      blockIndex: parsed.blockIndex,
      columnIndex: parsed.columnIndex,
      content: parsed.content,
      nestedBlockType,
      parentBlockId: parsed.parentBlockId,
      tool: 'update_section_column_block',
    },
    preview: {
      blockIndex: parsed.blockIndex,
      columnIndex: parsed.columnIndex,
      nestedBlockType,
      parentBlockId: parsed.parentBlockId,
      parentBlockType,
    },
    subject: `${nestedBlockType} nested block ${parsed.columnIndex}:${parsed.blockIndex}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const revisionBaseline = await captureCmsRevision(
    context,
    pageContext.contentType,
    getCmsEntityId(pageContext)
  );

  const { data: updatedParentBlock, error: updateError } = await supabase
    .from('blocks')
    .update({
      content: nextParentContent,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.parentBlockId)
    .select('id, block_type')
    .single();

  if (updateError || !updatedParentBlock) {
    throw new Error(
      `Failed to update parent block ${parsed.parentBlockId}: ${serializeError(updateError)}`
    );
  }

  await patchOpenProductDraft({
    patch: ({ blocks }) => ({
      blocks: blocks.map((draftBlock: any) =>
        String(draftBlock?.id) === String(parsed.parentBlockId)
          ? { ...draftBlock, content: nextParentContent }
          : draftBlock
      ),
    }),
    productId: parentBlock.product_id,
    supabase,
  });

  await commitCmsRevision(
    context,
    pageContext.contentType,
    getCmsEntityId(pageContext),
    revisionBaseline
  );

  revalidateCurrentCmsSurfaces(context, pageContext);

  return {
    blockIndex: parsed.blockIndex,
    columnIndex: parsed.columnIndex,
    mutationExecuted: true,
    nestedBlockType,
    parentBlockId: updatedParentBlock.id,
    parentBlockType: updatedParentBlock.block_type,
    success: true,
  };
}

export async function executeCreateCmsPage(
  input: z.input<typeof createCmsPageInputSchema>,
  context?: ToolExecutionContext
) {
  const parsed = createCmsPageInputSchema.parse(input);
  context = await withCustomBlockDefinitions(context, parsed.blocks);
  const supabase = getSupabase(context);
  const actorUserId = getActorUserId(context);
  const language = await getDefaultLanguageRecord(supabase, parsed.languageCode);
  const slug = slugify(parsed.slug || parsed.title);
  const blocks = normalizeCreateBlocks(parsed.blocks, parsed.contactEmail, parsed.title, context);
  const duplicate = await assertUniqueSlug({
    contentType: 'page',
    languageId: language.id,
    slug,
    supabase,
  });

  if (duplicate) {
    return duplicate;
  }

  const translationGroup = await resolveCreateTranslationGroup({
    contentType: 'page',
    languageCode: language.code,
    languageId: language.id,
    suppliedTranslationGroupId: parsed.translationGroupId,
    supabase,
  });

  if (translationGroup.result) {
    return translationGroup.result;
  }

  const payload = {
    blocks,
    item: {
      feature_image_id: parsed.feature_image_id ?? null,
      language_id: language.id,
      meta_description: parsed.meta_description ?? null,
      meta_title: parsed.meta_title ?? null,
      slug,
      status: parsed.status,
      title: parsed.title,
      translation_group_id: translationGroup.translationGroupId,
    },
    tool: 'create_cms_page',
  };
  const confirmation = getConfirmationPreview({
    action: 'CREATE PAGE',
    context,
    payload,
    preview: {
      blockCount: blocks.length,
      languageCode: language.code,
      slug,
      status: parsed.status,
      title: parsed.title,
      translationGroupId: translationGroup.translationGroupId,
    },
    subject: slug,
  });

  if (confirmation) {
    return confirmation;
  }

  const translationGroupId = translationGroup.translationGroupId || createId();
  const resolvedFeatureImageId = await resolveMediaReference(
    payload.item.feature_image_id,
    context,
    parsed.title
  );
  const { data: page, error } = await supabase
    .from('pages')
    .insert({
      ...payload.item,
      author_id: actorUserId,
      feature_image_id: resolvedFeatureImageId,
      translation_group_id: translationGroupId,
    })
    .select('id, language_id, slug, status, title, translation_group_id')
    .single();

  if (error || !page?.id) {
    throw new Error(`Failed to create page: ${serializeError(error)}`);
  }

  try {
    await insertContentBlocks({
      blocks,
      contentType: 'page',
      itemId: Number(page.id),
      languageId: language.id,
      supabase,
    });
  } catch (error) {
    await rollbackCreatedCmsItem({ contentType: 'page', itemId: Number(page.id), supabase });
    throw error;
  }

  revalidateCurrentCmsSurfaces(
    context,
    { contentType: 'page', entityId: Number(page.id), languageId: language.id, slug, title: parsed.title },
    slug
  );
  context?.revalidatePath?.('/cms/pages');

  return {
    blockCount: blocks.length,
    contentType: 'page',
    editPath: getCreateEditPath('page', page.id),
    entityId: page.id,
    mutationExecuted: true,
    slug,
    success: true,
    title: parsed.title,
    translationGroupId: page.translation_group_id,
  };
}

export async function executeCreateCmsPost(input: CreateCmsPostInput, context?: ToolExecutionContext) {
  const parsed = createCmsPostInputSchema.parse(input);
  context = await withCustomBlockDefinitions(context, parsed.blocks);
  const supabase = getSupabase(context);
  const actorUserId = getActorUserId(context);
  const language = await getDefaultLanguageRecord(supabase, parsed.languageCode);
  const slug = slugify(parsed.slug || parsed.title);
  const blocks = normalizeCreateBlocks(parsed.blocks, undefined, undefined, context);
  const duplicate = await assertUniqueSlug({
    contentType: 'post',
    languageId: language.id,
    slug,
    supabase,
  });

  if (duplicate) {
    return duplicate;
  }

  const translationGroup = await resolveCreateTranslationGroup({
    contentType: 'post',
    languageCode: language.code,
    languageId: language.id,
    suppliedTranslationGroupId: parsed.translationGroupId,
    supabase,
  });

  if (translationGroup.result) {
    return translationGroup.result;
  }

  const publishedAt =
    parsed.published_at && !Number.isNaN(new Date(parsed.published_at).getTime())
      ? new Date(parsed.published_at).toISOString()
      : parsed.published_at ?? null;
  const payload = {
    blocks,
    item: {
      excerpt: parsed.excerpt ?? null,
      feature_image_id: parsed.feature_image_id ?? null,
      label: parsed.label ?? null,
      language_id: language.id,
      meta_description: parsed.meta_description ?? null,
      meta_title: parsed.meta_title ?? null,
      published_at: publishedAt,
      slug,
      status: parsed.status,
      subtitle: parsed.subtitle ?? null,
      title: parsed.title,
      translation_group_id: translationGroup.translationGroupId,
    },
    tool: 'create_cms_post',
  };
  const confirmation = getConfirmationPreview({
    action: 'CREATE POST',
    context,
    payload,
    preview: {
      blockCount: blocks.length,
      languageCode: language.code,
      slug,
      status: parsed.status,
      title: parsed.title,
      translationGroupId: translationGroup.translationGroupId,
    },
    subject: slug,
  });

  if (confirmation) {
    return confirmation;
  }

  const translationGroupId = translationGroup.translationGroupId || createId();
  const resolvedFeatureImageId = await resolveMediaReference(
    payload.item.feature_image_id,
    context,
    parsed.title
  );
  const { data: post, error } = await supabase
    .from('posts')
    .insert({
      ...payload.item,
      author_id: actorUserId,
      feature_image_id: resolvedFeatureImageId,
      translation_group_id: translationGroupId,
    })
    .select('id, language_id, slug, status, title, translation_group_id')
    .single();

  if (error || !post?.id) {
    throw new Error(`Failed to create post: ${serializeError(error)}`);
  }

  try {
    await insertContentBlocks({
      blocks,
      contentType: 'post',
      itemId: Number(post.id),
      languageId: language.id,
      supabase,
    });
  } catch (error) {
    await rollbackCreatedCmsItem({ contentType: 'post', itemId: Number(post.id), supabase });
    throw error;
  }

  revalidateCurrentCmsSurfaces(
    context,
    { contentType: 'post', entityId: Number(post.id), languageId: language.id, slug, title: parsed.title },
    slug
  );
  context?.revalidatePath?.('/cms/posts');
  context?.revalidatePath?.('/articles');

  return {
    blockCount: blocks.length,
    contentType: 'post',
    editPath: getCreateEditPath('post', post.id),
    entityId: post.id,
    mutationExecuted: true,
    slug,
    success: true,
    title: parsed.title,
    translationGroupId: post.translation_group_id,
  };
}

function buildGeneratedSku(title: string, slug: string) {
  return (slug || slugify(title) || 'product')
    .replace(/-/g, '')
    .slice(0, 24)
    .toUpperCase();
}

/**
 * Coerce whatever a model produced for a product body into a valid editor
 * document. Models — especially cheap ones — reliably emit HTML but frequently
 * get nested editor JSON wrong, so every plausible shape is accepted rather than
 * thrown back: an HTML/text string, a bare array of nodes, `{ content: [...] }`
 * without the `doc` type, or a correct document. Only genuinely unusable input
 * raises, and the message tells the model exactly what to send instead.
 */
function validateProductDescriptionJson(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  // The single most common model output: an HTML fragment (or plain prose).
  if (typeof value === 'string') {
    return editorDocumentFromHtml(value) ?? undefined;
  }

  // A bare node array, or a document missing its `type: 'doc'` wrapper.
  const candidate = Array.isArray(value)
    ? { content: value, type: 'doc' }
    : isPlainJsonRecord(value) && value['type'] !== 'doc' && Array.isArray(value['content'])
      ? { ...value, type: 'doc' }
      : value;

  const validation = getEditorBlockDocumentSchema().safeParse(candidate);

  if (!validation.success) {
    // A single-node object such as { type: 'paragraph', content: [...] }.
    if (isPlainJsonRecord(value) && typeof value['type'] === 'string') {
      const wrapped = getEditorBlockDocumentSchema().safeParse({
        content: [value],
        type: 'doc',
      });

      if (wrapped.success) {
        return wrapped.data;
      }
    }

    throw new Error(
      `Product description_json must be an editor document like { "type": "doc", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "..." } ] } ] }, or simply an HTML string. Received: ${validation.error.issues
        .map((issue) => issue.message)
        .join('; ')}`
    );
  }

  return validation.data;
}

/**
 * Resolve the product body from either input: `description_html` (preferred —
 * a plain string a model can always produce under a strict tool schema) or
 * `description_json`. HTML wins when both are supplied and the JSON is empty.
 */
function resolveProductDescription(input: {
  description_html?: string;
  description_json?: unknown;
}) {
  const hasBlocks = (document: { content?: unknown } | null | undefined) =>
    Boolean(document && Array.isArray(document.content) && document.content.length > 0);

  const fromJson = validateProductDescriptionJson(input.description_json);

  if (hasBlocks(fromJson)) {
    return fromJson;
  }

  const fromHtml = input.description_html ? editorDocumentFromHtml(input.description_html) : null;

  // Never store an empty document: `{ type: 'doc', content: [] }` passes
  // validation but renders as a blank slab AND suppresses the storefront's
  // "no description" fallback. Undefined leaves the column null instead.
  return hasBlocks(fromHtml) ? fromHtml : undefined;
}

export async function executeCreateCmsProduct(input: CreateCmsProductInput, context?: ToolExecutionContext) {
  const parsed = createCmsProductInputSchema.parse(input);
  context = await withCustomBlockDefinitions(context, parsed.blocks);
  const supabase = getSupabase(context);
  const language = await getDefaultLanguageRecord(supabase, parsed.languageCode);
  const slug = slugify(parsed.slug || parsed.title);
  const blocks = normalizeCreateBlocks(parsed.blocks, undefined, undefined, context);
  const duplicate = await assertUniqueSlug({
    contentType: 'product',
    languageId: language.id,
    slug,
    supabase,
  });

  if (duplicate) {
    return duplicate;
  }

  const translationGroup = await resolveCreateTranslationGroup({
    contentType: 'product',
    languageCode: language.code,
    languageId: language.id,
    suppliedTranslationGroupId: parsed.translationGroupId,
    supabase,
  });

  if (translationGroup.result) {
    return translationGroup.result;
  }

  const { createProduct: createEcommerceProduct, productSchema } = await getEcommerceProductModule();
  const isFreemiusProduct =
    parsed.product_type === 'digital' && parsed.payment_provider === 'freemius';
  const trialPeriodDays = isFreemiusProduct ? parsed.trial_period_days : 0;
  const productPayload = productSchema.parse({
    description_json: resolveProductDescription(parsed),
    freemius_plan_id: parsed.freemius_plan_id || '',
    freemius_product_id: parsed.freemius_product_id || '',
    is_taxable: parsed.is_taxable,
    language_id: language.id,
    meta_description: parsed.meta_description ?? '',
    meta_title: parsed.meta_title ?? '',
    payment_provider: parsed.payment_provider,
    price: parsed.price,
    prices: parsed.prices || {},
    product_media: [],
    product_type: parsed.product_type,
    sale_price: parsed.sale_price ?? null,
    sale_prices: parsed.sale_prices || {},
    short_description: parsed.short_description ?? '',
    sku: parsed.sku || buildGeneratedSku(parsed.title, slug),
    slug,
    status: parsed.status,
    stock: parsed.stock,
    title: parsed.title,
    trial_period_days: trialPeriodDays,
    trial_requires_payment_method:
      trialPeriodDays > 0 ? parsed.trial_requires_payment_method : false,
    translation_group_id: translationGroup.translationGroupId,
    upc: parsed.upc ?? '',
    variation_attributes: [],
    variants: [],
  });
  const images = parsed.images ?? [];
  const confirmation = getConfirmationPreview({
    action: 'CREATE PRODUCT',
    context,
    payload: { blocks, images, item: productPayload, tool: 'create_cms_product' },
    preview: {
      blockCount: blocks.length,
      descriptionLength: productPayload.description_json
        ? JSON.stringify(productPayload.description_json).length
        : 0,
      imageCount: images.length,
      languageCode: language.code,
      price: productPayload.price,
      sku: productPayload.sku,
      slug,
      status: productPayload.status,
      stock: productPayload.stock,
      title: productPayload.title,
      translationGroupId: translationGroup.translationGroupId,
    },
    subject: slug,
  });

  if (confirmation) {
    return confirmation;
  }

  // Import external image URLs into the media library BEFORE creating the row so
  // createProduct can persist product_media in its own canonical path. A bad
  // image URL must not cost the user the product and its copied body, so image
  // failures are reported rather than thrown.
  let mediaIds: string[] = [];
  let imageError: string | null = null;

  if (images.length > 0) {
    try {
      mediaIds = [...new Set(await resolveMediaReferences(images, context, parsed.title))];

      if (mediaIds.length === 0) {
        throw new Error('None of the provided images could be resolved to a media item.');
      }
    } catch (error) {
      imageError = error instanceof Error ? error.message : String(error);
    }
  }

  const product = await createEcommerceProduct(supabase as any, {
    ...productPayload,
    // First entry is the main product image; the rest become the gallery in order.
    product_media: mediaIds.map((media_id) => ({ media_id })),
  });

  if (!product?.id) {
    throw new Error('Failed to create product.');
  }

  // "Product Description Blocks" — the same block vocabulary pages/posts use,
  // parented by blocks.product_id and rendered by ProductDetailsBlockRenderer.
  try {
    await insertContentBlocks({
      blocks,
      contentType: 'product',
      itemId: product.id,
      languageId: language.id,
      supabase,
    });
  } catch (error) {
    await rollbackCreatedCmsItem({ contentType: 'product', itemId: product.id, supabase });
    throw error;
  }

  revalidateCurrentCmsSurfaces(
    context,
    { contentType: 'product', entityId: product.id, languageId: language.id, slug, title: parsed.title },
    slug
  );
  context?.revalidatePath?.('/cms/products');

  return {
    blockCount: blocks.length,
    contentType: 'product',
    editPath: getCreateEditPath('product', product.id),
    entityId: product.id,
    imageCount: mediaIds.length,
    ...(imageError ? { imageError } : {}),
    mutationExecuted: true,
    slug,
    success: true,
    title: parsed.title,
    translationGroupId: product.translation_group_id,
  };
}

function normalizeFieldName(value: string) {
  return value.trim().replace(/[\s-]+/g, '_').toLowerCase();
}

function normalizeStatusValue(contentType: CmsContentType, value: unknown) {
  const normalized = typeof value === 'string' ? normalizeFieldName(value) : value;

  if (contentType === 'product') {
    if (normalized === 'public' || normalized === 'publish' || normalized === 'published') {
      return 'active';
    }

    return normalized;
  }

  if (normalized === 'public' || normalized === 'active' || normalized === 'publish') {
    return 'published';
  }

  return normalized;
}

function isUnsupportedDatedSpecial(input: UpdateCmsItemFieldInput) {
  const field = normalizeFieldName(input.field);

  return Boolean(
    input.startsAt ||
      input.endsAt ||
      field.includes('start') ||
      field.includes('end') ||
      field.includes('schedule') ||
      field.includes('special_date')
  );
}

/**
 * Build the exact `products` column patch for a single-field product update.
 * Price-family fields are converted from major units (what the model supplies)
 * to the precision-aware minor units the DB stores; every other field maps to
 * its column verbatim. This patch is applied DIRECTLY to the products row — it
 * never reconstructs the whole product, so variants, sale schedule, custom
 * canonical, and unrelated currency prices are left untouched.
 */
async function buildProductColumnUpdate(
  field: string,
  value: unknown,
  supabase: SupabaseLike
): Promise<Record<string, unknown>> {
  if (field === 'price' || field === 'sale_price') {
    if (value === null || value === undefined) {
      return { [field]: null };
    }

    const currency = await getDefaultCurrencyCode(supabase);
    return { [field]: majorUnitAmountToMinor(Number(value), currency) };
  }

  if (field === 'prices' || field === 'sale_prices') {
    const currency = await getDefaultCurrencyCode(supabase);
    return { [field]: serializeMajorPriceMapToMinor(value, currency) };
  }

  if (field === 'description_json') {
    return { description_json: validateProductDescriptionJson(value) };
  }

  return { [field]: value };
}

/** Fields whose executor checks demand a real `number`. */
const NUMERIC_CMS_FIELD_NAMES = new Set([
  'language_id',
  'price',
  'sale_price',
  'stock',
  'trial_period_days',
]);

/** Fields whose executor checks demand a real `boolean`. */
const BOOLEAN_CMS_FIELD_NAMES = new Set(['is_taxable', 'trial_requires_payment_method']);

/**
 * Coerce string-encoded scalars for fields that require a number or boolean.
 *
 * `value` is `z.any()`, which serializes to an untyped `{}` in the JSON Schema MCP
 * puts on the wire — so an external client has no type to marshal against and
 * commonly sends `"29.99"` or `"true"` where the executor demands `29.99` / `true`.
 * Without this, setting a price, stock level, or boolean flag is simply impossible
 * over MCP, for no safety gain: the range and integer checks downstream still run
 * against the coerced value.
 *
 * Deliberately conservative — only unambiguous conversions happen. Anything else is
 * returned untouched so the existing validation still raises its own error rather
 * than this silently inventing a value.
 */
function coerceScalarCmsFieldValue(field: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (NUMERIC_CMS_FIELD_NAMES.has(field)) {
    if (trimmed.toLowerCase() === 'null') {
      return null;
    }

    if (trimmed === '') {
      return value;
    }

    const parsed = Number(trimmed);

    return Number.isFinite(parsed) ? parsed : value;
  }

  if (BOOLEAN_CMS_FIELD_NAMES.has(field)) {
    const lowered = trimmed.toLowerCase();

    if (lowered === 'true') {
      return true;
    }

    if (lowered === 'false') {
      return false;
    }
  }

  return value;
}

function buildSingleFieldUpdatePayload(
  input: UpdateCmsItemFieldInput,
  target: { contentType: CmsContentType; item: any }
) {
  const field = normalizeFieldName(input.field);
  const aliases: Record<string, string> = {
    description: 'description_json',
    feature_image: 'feature_image_id',
    feature_image_id: 'feature_image_id',
    language: 'language_id',
    meta_description: 'meta_description',
    meta_title: 'meta_title',
    payment: 'payment_provider',
    provider: 'payment_provider',
    regular_price: 'price',
    sale: 'sale_price',
    sale_price: 'sale_price',
    short_description: 'short_description',
    taxable: 'is_taxable',
    trial: 'trial_period_days',
    trial_days: 'trial_period_days',
    trial_payment_method_required: 'trial_requires_payment_method',
    type: 'product_type',
  };
  const normalizedField = aliases[field] || field;
  // 'status' carries no alias, so resolving the alias first does not change which
  // branch this takes — it only lets the coercion see the real column name.
  const value =
    normalizedField === 'status'
      ? normalizeStatusValue(target.contentType, input.value)
      : coerceScalarCmsFieldValue(normalizedField, input.value);

  if (target.contentType !== 'product') {
    const pagePostFields = target.contentType === 'page' ? PAGE_FIELD_NAMES : POST_FIELD_NAMES;

    if (!pagePostFields.has(normalizedField)) {
      throw new Error(`Field "${input.field}" cannot be updated for ${target.contentType}.`);
    }

    if (normalizedField === 'status') {
      assertValidStatusForContentType(target.contentType, value);
    }

    return {
      field: normalizedField,
      payload: {
        [normalizedField]: normalizeCmsFieldValue(normalizedField, value),
      },
    };
  }

  const productFieldNames = new Set([
    'description_json',
    'freemius_plan_id',
    'freemius_product_id',
    'is_taxable',
    'language_id',
    'meta_description',
    'meta_title',
    'payment_provider',
    'price',
    'prices',
    'product_type',
    'sale_price',
    'sale_prices',
    'short_description',
    'sku',
    'slug',
    'status',
    'stock',
    'title',
    'trial_period_days',
    'trial_requires_payment_method',
    'upc',
  ]);

  if (!productFieldNames.has(normalizedField)) {
    throw new Error(`Field "${input.field}" cannot be updated for product.`);
  }

  if (normalizedField === 'status') {
    assertValidStatusForContentType('product', value);
  }

  if (normalizedField === 'price' || normalizedField === 'sale_price') {
    if (value !== null && (typeof value !== 'number' || value < 0)) {
      throw new Error(`${normalizedField} must be a non-negative number or null.`);
    }
  }

  if (normalizedField === 'stock' && (!Number.isInteger(value) || Number(value) < 0)) {
    throw new Error('stock must be a non-negative integer.');
  }

  if (normalizedField === 'trial_period_days' && (!Number.isInteger(value) || Number(value) < 0)) {
    throw new Error('trial_period_days must be a non-negative integer.');
  }

  if (normalizedField === 'trial_requires_payment_method' && typeof value !== 'boolean') {
    throw new Error('trial_requires_payment_method must be a boolean.');
  }

  return {
    field: normalizedField,
    payload: {
      [normalizedField]: value,
    },
  };
}

export async function executeUpdateCmsItemField(
  input: UpdateCmsItemFieldInput,
  context?: ToolExecutionContext
) {
  const parsed = updateCmsItemFieldInputSchema.parse(input);

  if (isUnsupportedDatedSpecial(parsed)) {
    return {
      message:
        'Scheduled product specials are not supported by the current product schema yet. I can set or clear sale_price now, but not start/end dates.',
      mutationExecuted: false,
      success: false,
      unsupported: true,
    };
  }

  const target = await resolveCmsTarget(parsed, context);
  const fieldUpdate = buildSingleFieldUpdatePayload(parsed, target);
  const field = fieldUpdate.field;
  let payload = fieldUpdate.payload;

  if (field === 'language_id' && typeof payload.language_id === 'string') {
    const language = await getLanguageRecord(getSupabase(context), payload.language_id);
    payload = {
      ...payload,
      language_id: language.id,
    };
  }

  const confirmation = getConfirmationPreview({
    action: 'UPDATE FIELD',
    context,
    payload: {
      contentType: target.contentType,
      entityId: target.item.id,
      field,
      payload,
      tool: 'update_cms_item_field',
    },
    preview: {
      contentType: target.contentType,
      field,
      from: target.item[field],
      slug: target.item.slug,
      title: target.item.title,
      to: payload[field],
    },
    subject: `${target.contentType} ${target.item.slug || target.item.id} ${field}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const revisionBaseline = await captureCmsRevision(
    context,
    target.contentType,
    target.item.id
  );

  if (target.contentType === 'product') {
    // Patch ONLY the requested column on the products row. We deliberately do NOT
    // route single-field product edits through the ecommerce updateProduct /
    // upsert_product_with_variants path: that full-product rewrite wipes the
    // product's variants + variant_attribute_mapping, clears its scheduled sale
    // window and custom canonical, and (via a non-precision-aware ×100) corrupts
    // zero-decimal-currency prices — all as a side effect of changing e.g. the
    // price, stock, or title.
    const supabase = getSupabase(context);
    const productUpdate = await buildProductColumnUpdate(field, payload[field], supabase);
    const { data: product, error } = await supabase
      .from('products')
      .update({
        ...productUpdate,
        updated_at: new Date().toISOString(),
      })
      .eq('id', target.item.id)
      .select('id, language_id, slug, status, title')
      .single();

    if (error || !product) {
      throw new Error(`Failed to update product: ${serializeError(error)}`);
    }

    revalidateCurrentCmsSurfaces(
      context,
      {
        contentType: 'product',
        entityId: String(product.id),
        languageId: product.language_id,
        slug: product.slug,
        title: product.title,
      },
      product.slug
    );

    await commitCmsRevision(context, 'product', product.id, revisionBaseline);

    return {
      contentType: 'product',
      entityId: product.id,
      field,
      mutationExecuted: true,
      slug: product.slug,
      success: true,
      updatedFields: [field],
    };
  }

  // A feature image passed as an external URL must be imported into the media
  // library first — feature_image_id is a UUID FK, not a URL.
  if (field === 'feature_image_id' && typeof payload.feature_image_id === 'string') {
    payload = {
      ...payload,
      feature_image_id: await resolveMediaReference(
        payload.feature_image_id,
        context,
        typeof target.item.title === 'string' ? target.item.title : undefined
      ),
    };
  }

  const table = target.contentType === 'page' ? 'pages' : 'posts';
  const { data: item, error } = await getSupabase(context)
    .from(table)
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', target.item.id)
    .select('id, language_id, slug, status, title')
    .single();

  if (error || !item) {
    throw new Error(`Failed to update ${target.contentType}: ${serializeError(error)}`);
  }

  revalidateCurrentCmsSurfaces(
    context,
    {
      contentType: target.contentType,
      entityId: Number(item.id),
      languageId: item.language_id,
      slug: item.slug,
      title: item.title,
    },
    item.slug
  );

  await commitCmsRevision(context, target.contentType, item.id, revisionBaseline);

  return {
    contentType: target.contentType,
    entityId: item.id,
    field,
    mutationExecuted: true,
    slug: item.slug,
    success: true,
    updatedFields: [field],
  };
}

async function buildDeletePreview(
  input: PrepareDeleteCmsItemInput | DeleteCmsItemInput,
  context?: ToolExecutionContext
) {
  const parsed = prepareDeleteCmsItemInputSchema.parse(input);
  const target = await resolveCmsTarget(parsed, context);

  if (target.contentType === 'product') {
    return {
      affectedCount: 1,
      collectionPath: getCollectionPath('product'),
      contentType: 'product' as const,
      item: target.item,
      navigationLinkCount: 0,
      publicPaths: target.item.slug ? [`/product/${target.item.slug}`] : [],
      targetIds: [target.item.id],
    };
  }

  const table = target.contentType === 'page' ? 'pages' : 'posts';
  const { data, error } = await getSupabase(context)
    .from(table)
    .select('id, slug, title, translation_group_id')
    .eq('translation_group_id', target.item.translation_group_id);

  if (error) {
    throw new Error(`Failed to inspect related ${target.contentType}s: ${serializeError(error)}`);
  }

  const rows = Array.isArray(data) ? data : [];
  const publicPaths = rows
    .map((row: any) =>
      target.contentType === 'page'
        ? row.slug === 'home'
          ? '/'
          : `/${row.slug}`
        : `/article/${row.slug}`
    )
    .filter(Boolean);
  const publicPathSet = new Set(publicPaths);
  const { data: navigationItems, error: navigationItemsError } = await getSupabase(context)
    .from('navigation_items')
    .select('id, url');

  if (navigationItemsError) {
    throw new Error(`Failed to inspect related navigation links: ${serializeError(navigationItemsError)}`);
  }

  const navigationLinkCount = (Array.isArray(navigationItems) ? navigationItems : []).filter(
    (item: any) => publicPathSet.has(item.url)
  ).length;

  return {
    affectedCount: rows.length,
    collectionPath: getCollectionPath(target.contentType),
    contentType: target.contentType,
    item: target.item,
    navigationLinkCount,
    publicPaths,
    targetIds: rows.map((row: any) => row.id),
  };
}

function summarizeDeletePreview(preview: Awaited<ReturnType<typeof buildDeletePreview>>) {
  const title = preview.item.title || preview.item.slug || 'selected item';
  const slug = preview.item.slug ? ` (${preview.item.slug})` : '';

  if (preview.contentType === 'product') {
    return `Delete product "${title}"${slug}.`;
  }

  const details = [
    `${pluralize(preview.affectedCount, 'language version')}`,
    preview.navigationLinkCount > 0
      ? `${pluralize(preview.navigationLinkCount, 'navigation link')}`
      : null,
  ].filter(Boolean);

  return `Delete ${preview.contentType} "${title}"${slug}, including ${details.join(' and ')}.`;
}

export async function executePrepareDeleteCmsItem(
  input: PrepareDeleteCmsItemInput,
  context?: ToolExecutionContext
) {
  const preview = await buildDeletePreview(input, context);
  const confirmation = buildConfirmationPreview({
    action: `DELETE ${preview.contentType}`,
    payload: {
      affectedCount: preview.affectedCount,
      contentType: preview.contentType,
      targetIds: preview.targetIds,
      tool: 'delete_cms_item',
    },
    preview: {
      affectedCount: preview.affectedCount,
      collectionPath: preview.collectionPath,
      contentType: preview.contentType,
      navigationLinkCount: preview.navigationLinkCount,
      publicPaths: preview.publicPaths,
      slug: preview.item.slug,
      summary: summarizeDeletePreview(preview),
      title: preview.item.title,
    },
    subject: `${preview.item.id} ${preview.item.slug || ''}`,
  });

  return {
    ...confirmation,
    preparedDelete: true,
  };
}

export async function executeDeleteCmsItem(input: DeleteCmsItemInput, context?: ToolExecutionContext) {
  const parsed = deleteCmsItemInputSchema.parse(input);
  const preview = await buildDeletePreview(parsed, context);
  const confirmation = getConfirmationPreview({
    action: `DELETE ${preview.contentType}`,
    context,
    payload: {
      affectedCount: preview.affectedCount,
      contentType: preview.contentType,
      targetIds: preview.targetIds,
      tool: 'delete_cms_item',
    },
    preview: {
      affectedCount: preview.affectedCount,
      collectionPath: preview.collectionPath,
      contentType: preview.contentType,
      navigationLinkCount: preview.navigationLinkCount,
      publicPaths: preview.publicPaths,
      slug: preview.item.slug,
      summary: summarizeDeletePreview(preview),
      title: preview.item.title,
    },
    subject: `${preview.item.id} ${preview.item.slug || ''}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const supabase = getSupabase(context);

  if (preview.contentType === 'product') {
    const { error } = await supabase.from('products').delete().eq('id', preview.item.id);

    if (error) {
      throw new Error(`Failed to delete product: ${serializeError(error)}`);
    }
  } else {
    for (const publicPath of preview.publicPaths) {
      await supabase.from('navigation_items').delete().eq('url', publicPath);
    }

    const table = preview.contentType === 'page' ? 'pages' : 'posts';
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('translation_group_id', preview.item.translation_group_id);

    if (error) {
      throw new Error(`Failed to delete ${preview.contentType}: ${serializeError(error)}`);
    }
  }

  const revalidatePath = context?.revalidatePath ?? getDefaultRevalidatePath();

  if (revalidatePath) {
    revalidatePath(preview.collectionPath);
    revalidatePath('/cms/navigation');
    preview.publicPaths.forEach((path) => revalidatePath(path));
  }

  return {
    affectedCount: preview.affectedCount,
    collectionPath: preview.collectionPath,
    contentType: preview.contentType,
    mutationExecuted: true,
    redirectPath: preview.collectionPath,
    success: true,
  };
}

async function executeActionPlanChild(
  action: z.infer<typeof cmsActionPlanActionSchema>,
  context?: ToolExecutionContext
) {
  switch (action.tool) {
    case 'create_cms_page':
      return executeCreateCmsPage(action.input, context);
    case 'create_cms_post':
      return executeCreateCmsPost(action.input, context);
    case 'create_cms_product':
      return executeCreateCmsProduct(action.input, context);
    case 'delete_cms_item':
      return executeDeleteCmsItem(action.input, context);
    case 'update_cms_item_field':
      return executeUpdateCmsItemField(action.input, context);
    case 'update_content_block':
      return executeUpdateContentBlock(action.input, context);
    case 'insert_content_block':
      return executeInsertContentBlock(action.input, context);
    case 'update_current_cms_fields':
      return executeUpdateCurrentCmsFields(action.input, context);
    case 'update_footer':
      return executeUpdateFooter(action.input, context);
    case 'update_navigation_bar':
      return executeUpdateNavigationBar(action.input, context);
    case 'update_section_column_block':
      return executeUpdateSectionColumnBlock(action.input, context);
    case 'set_content_images':
      return executeSetContentImages(action.input, context);
  }
}

function withActionPlanTranslationGroup(
  action: z.infer<typeof cmsActionPlanActionSchema>,
  translationGroupsByCreateTool: Partial<Record<'create_cms_page' | 'create_cms_post' | 'create_cms_product', string>>
) {
  if (
    action.tool !== 'create_cms_page' &&
    action.tool !== 'create_cms_post' &&
    action.tool !== 'create_cms_product'
  ) {
    return action;
  }

  if (action.input.translationGroupId || !action.input.languageCode) {
    return action;
  }

  const translationGroupId = translationGroupsByCreateTool[action.tool];

  if (!translationGroupId) {
    return action;
  }

  return {
    ...action,
    input: {
      ...action.input,
      translationGroupId,
    },
  } as z.infer<typeof cmsActionPlanActionSchema>;
}

function planCreateContentType(
  tool: 'create_cms_page' | 'create_cms_post' | 'create_cms_product'
): CmsContentType {
  return tool === 'create_cms_page' ? 'page' : tool === 'create_cms_post' ? 'post' : 'product';
}

/**
 * Point a set_content_images action at an item an earlier action in the same
 * plan just created, so "create the product, then give it this image" works as
 * one confirmed plan. An explicit entityId always wins.
 */
function withActionPlanImageTarget(
  action: z.infer<typeof cmsActionPlanActionSchema>,
  createdItemsBySlug: Map<string, { contentType: CmsContentType; entityId: string | number }>,
  lastCreatedItem: { contentType: CmsContentType; entityId: string | number } | null
) {
  if (action.tool !== 'set_content_images') {
    return action;
  }

  const imageInput = action.input as {
    contentType?: CmsContentType;
    entityId?: string | number;
    slug?: string;
  };

  if (imageInput.entityId !== undefined) {
    return action;
  }

  const created = imageInput.slug
    ? createdItemsBySlug.get(
        `${imageInput.contentType || 'product'}:${slugify(imageInput.slug)}`
      )
    : lastCreatedItem;

  if (!created) {
    return action;
  }

  return {
    ...action,
    input: {
      ...imageInput,
      contentType: created.contentType,
      entityId: created.entityId,
    },
  } as z.infer<typeof cmsActionPlanActionSchema>;
}

export async function executeCmsActionPlan(
  input: z.input<typeof executeCmsActionPlanInputSchema>,
  context?: ToolExecutionContext
) {
  const parsed = executeCmsActionPlanInputSchema.parse(input);

  // An item created earlier in the same plan does not exist yet while the plan
  // is being previewed, so a later set_content_images that targets it cannot be
  // resolved against the database. Track what this plan will create and preview
  // those image actions from the plan itself instead of failing the whole plan.
  const plannedCreateSlugs = new Set(
    parsed.actions
      .filter(
        (action) =>
          action.tool === 'create_cms_page' ||
          action.tool === 'create_cms_post' ||
          action.tool === 'create_cms_product'
      )
      .map((action) => {
        const createInput = action.input as { slug?: string; title?: string };

        return `${planCreateContentType(action.tool)}:${slugify(createInput.slug || createInput.title || '')}`;
      })
  );

  const targetsAPlannedCreate = (action: z.infer<typeof cmsActionPlanActionSchema>) => {
    if (action.tool !== 'set_content_images') {
      return false;
    }

    const imageInput = action.input as { contentType?: string; slug?: string };

    // No explicit target at all -> it will inherit the item this plan created.
    if (!imageInput.slug) {
      return plannedCreateSlugs.size > 0;
    }

    return plannedCreateSlugs.has(
      `${imageInput.contentType || 'product'}:${slugify(imageInput.slug)}`
    );
  };

  if (!context?.skipConfirmation) {
    const actionSummaries: string[] = [];

    for (const action of parsed.actions) {
      if (targetsAPlannedCreate(action)) {
        const imageInput = action.input as { images: string[]; slug?: string };

        actionSummaries.push(
          `Set ${pluralize(imageInput.images.length, 'image')} on the ${
            imageInput.slug ? `"${imageInput.slug}"` : 'new'
          } item created in this plan.`
        );
        continue;
      }

      const result = await executeActionPlanChild(action, {
        ...context,
        latestUserMessage: null,
      });

      if (!result || typeof result !== 'object') {
        return {
          message: `Could not prepare action ${actionSummaries.length + 1}.`,
          mutationExecuted: false,
          success: false,
        };
      }

      if ((result as any).success === false || (result as any).unsupported === true) {
        return result;
      }

      if ((result as any).requiresConfirmation === true && (result as any).preview) {
        actionSummaries.push(
          summarizeCmsMutationPreview(action.tool, (result as any).preview)
        );
      } else {
        actionSummaries.push(`Run ${action.tool.replace(/_/g, ' ')}.`);
      }
    }

    const summary =
      parsed.summary ||
      `Complete ${pluralize(parsed.actions.length, 'CMS action')}.`;
    const confirmation = getConfirmationPreview({
      action: 'EXECUTE CMS ACTION PLAN',
      context,
      payload: { actions: parsed.actions, tool: 'execute_cms_action_plan' },
      preview: {
        actionCount: parsed.actions.length,
        actionSummaries,
        summary,
      },
      subject: `${parsed.actions.length} actions`,
    });

    if (confirmation) {
      return confirmation;
    }
  }

  const childContext = {
    ...context,
    skipConfirmation: true,
  };
  const results: Array<{ output: unknown; tool: string }> = [];
  let mutationExecuted = false;
  let editPath: string | null = null;
  let redirectPath: string | null = null;
  const translationGroupsByCreateTool: Partial<Record<'create_cms_page' | 'create_cms_post' | 'create_cms_product', string>> = {};
  const createdItemsBySlug = new Map<
    string,
    { contentType: CmsContentType; entityId: string | number }
  >();
  let lastCreatedItem: { contentType: CmsContentType; entityId: string | number } | null = null;

  for (const [index, action] of parsed.actions.entries()) {
    const actionToExecute = withActionPlanImageTarget(
      withActionPlanTranslationGroup(action, translationGroupsByCreateTool),
      createdItemsBySlug,
      lastCreatedItem
    );
    const output = await executeActionPlanChild(actionToExecute, childContext);

    results.push({ output, tool: actionToExecute.tool });

    if (output && typeof output === 'object') {
      const record = output as Record<string, unknown>;

      if (record.mutationExecuted === true) {
        mutationExecuted = true;
      }

      if (!editPath && typeof record.editPath === 'string') {
        editPath = record.editPath;
      }

      if (typeof record.redirectPath === 'string') {
        redirectPath = record.redirectPath;
      }

      if (
        actionToExecute.tool === 'create_cms_page' ||
        actionToExecute.tool === 'create_cms_post' ||
        actionToExecute.tool === 'create_cms_product'
      ) {
        if (typeof record.translationGroupId === 'string') {
          translationGroupsByCreateTool[actionToExecute.tool] = record.translationGroupId;
        }

        // Remember what we just created so a later set_content_images in this
        // same plan can attach images to it.
        if (record.entityId !== undefined && record.entityId !== null) {
          const contentType = planCreateContentType(actionToExecute.tool);
          const createdItem = {
            contentType,
            entityId: record.entityId as string | number,
          };

          lastCreatedItem = createdItem;

          if (typeof record.slug === 'string') {
            createdItemsBySlug.set(`${contentType}:${record.slug}`, createdItem);
          }
        }
      }

      if (record.success === false || record.unsupported === true) {
        return {
          actionCount: parsed.actions.length,
          failedActionIndex: index,
          failedTool: actionToExecute.tool,
          message:
            typeof record.message === 'string'
              ? record.message
              : `Action ${index + 1} failed.`,
          mutationExecuted,
          results,
          success: false,
          ...(editPath ? { editPath } : {}),
          ...(redirectPath ? { redirectPath } : {}),
        };
      }
    }
  }

  return {
    actionCount: parsed.actions.length,
    editPath: redirectPath ? undefined : editPath ?? undefined,
    mutationExecuted,
    redirectPath: redirectPath ?? undefined,
    results,
    success: true,
    summary: parsed.summary ?? null,
  };
}

// ---------------------------------------------------------------------------
// fetch_url_content: read an external web page's readable content so the agent
// can base new CMS content on it (e.g. "rewrite my home page based on <url>").
// Read-only, no confirmation.
// ---------------------------------------------------------------------------

export const fetchUrlContentInputSchema = z.strictObject({
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .default(8000)
    .describe('Maximum characters of readable body text to return.'),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://.'),
});

export type FetchUrlContentInput = z.input<typeof fetchUrlContentInputSchema>;

const FETCH_URL_CONTENT_TIMEOUT_MS = 12000;
const FETCH_URL_CONTENT_MAX_BYTES = 2_000_000;

/**
 * Unwrap an IPv4-mapped IPv6 address to its dotted-quad form.
 *
 * `http://[::ffff:127.0.0.1]/` reaches loopback just as `http://127.0.0.1/` does,
 * but the WHATWG URL parser normalises it to `::ffff:7f00:1` — which matches none of
 * the IPv4 private-range checks below. Without this, the mapped form is a working
 * bypass of the entire SSRF blocklist. Decimal and hex hosts (`http://2130706433/`)
 * need no special handling: the URL parser already normalises those to dotted-quad.
 */
function unwrapMappedIpv4(host: string): string | null {
  const mapped = host.match(/^::ffff:(.+)$/i);

  if (!mapped) {
    return null;
  }

  const rest = mapped[1] as string;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
    return rest;
  }

  const hextets = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);

  if (!hextets) {
    return null;
  }

  const high = Number.parseInt(hextets[1] as string, 16);
  const low = Number.parseInt(hextets[2] as string, 16);

  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

/** Exported for the SSRF regression tests in ai-global-agent-ssrf.test.ts. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  // `::` is the unspecified address and reaches loopback on most stacks.
  if (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  const mappedIpv4 = unwrapMappedIpv4(host);

  if (mappedIpv4) {
    return isBlockedFetchHost(mappedIpv4);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);

    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return true;
    }
  }

  return false;
}

function decodeHtmlEntitiesToText(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntitiesInUrl(value: string) {
  return value
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

// Only bitmap formats a media library can actually store. SVG is excluded on
// purpose: site logos/icons are overwhelmingly SVG, and importing one as a
// product's main image is never what the user meant.
const CONTENT_IMAGE_EXTENSION_RE = /\.(avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

// Chrome that appears on nearly every page and is never the subject image.
const CHROME_IMAGE_HINT_RE =
  /(?:^|[/_-])(?:sprite|icon|favicon|logo|placeholder|pixel|spacer|blank|avatar|badge|flag|loader|spinner|1x1|transparent|watermark|payment|visa|mastercard|paypal|amex|social|share|facebook|twitter|instagram|youtube|pinterest|linkedin)(?:[/_.-]|$)/i;

function absolutizeImageUrl(value: string | undefined | null, baseUrl: string) {
  if (typeof value !== 'string') {
    return null;
  }

  const decoded = decodeHtmlEntitiesInUrl(value);

  if (!decoded || decoded.startsWith('data:')) {
    return null;
  }

  try {
    const resolved = new URL(decoded, baseUrl);

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

// "a.jpg 400w, b.jpg 1200w" / "a.jpg 1x, b.jpg 2x" -> the highest-resolution
// candidate, which is the one worth importing.
function pickLargestSrcsetCandidate(srcset: string) {
  let best: { url: string; weight: number } | null = null;

  for (const entry of srcset.split(',')) {
    const parts = entry.trim().split(/\s+/);
    const url = parts[0];

    if (!url) {
      continue;
    }

    const descriptor = parts[1] || '';
    const widthMatch = descriptor.match(/^(\d+(?:\.\d+)?)w$/i);
    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);
    const weight = widthMatch
      ? Number(widthMatch[1])
      : densityMatch
        ? Number(densityMatch[1]) * 1000
        : 1;

    if (!best || weight > best.weight) {
      best = { url, weight };
    }
  }

  return best?.url ?? null;
}

function readTagAttribute(tag: string, attribute: string) {
  const match = tag.match(
    new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  );

  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function collectJsonLdImageUrls(html: string, baseUrl: string) {
  const productImages: string[] = [];
  const otherImages: string[] = [];

  const pushImageValue = (value: unknown, target: string[]) => {
    if (typeof value === 'string') {
      const absolute = absolutizeImageUrl(value, baseUrl);

      if (absolute) {
        target.push(absolute);
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        pushImageValue(entry, target);
      }

      return;
    }

    if (value && typeof value === 'object') {
      pushImageValue((value as { url?: unknown }).url, target);
      pushImageValue((value as { contentUrl?: unknown }).contentUrl, target);
    }
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || !node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, depth + 1);
      }

      return;
    }

    const record = node as Record<string, unknown>;
    const rawType = record['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase());
    // schema.org Product is the strongest possible signal on a shop page.
    const isProduct = types.some(
      (entry) => entry === 'product' || entry === 'productgroup' || entry === 'itempage'
    );

    if ('image' in record) {
      pushImageValue(record['image'], isProduct ? productImages : otherImages);
    }

    for (const value of Object.values(record)) {
      walk(value, depth + 1);
    }
  };

  const blocks = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const block of blocks) {
    const raw = (block[1] || '').trim();

    if (!raw) {
      continue;
    }

    try {
      walk(JSON.parse(raw), 0);
    } catch {
      // A malformed JSON-LD block is common in the wild; skip it silently and
      // fall back to the og:/<img> passes below.
    }
  }

  return [...productImages, ...otherImages];
}

// Path segments that mark a downscaled derivative rather than the real asset.
const THUMBNAIL_PATH_HINT_RE = /(?:^|[/_-])(?:thumbnails?|thumbs?|small|mini)(?:[/_.-]|$)/i;

function imageBasenameKey(url: string) {
  try {
    const { pathname } = new URL(url);
    const file = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));

    return file.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Index full-resolution images the page links to directly, keyed by file name.
 * The near-universal shop/lightbox pattern (Fancybox, PhotoSwipe, WooCommerce…)
 * renders a downscaled <img> next to an <a href> pointing at the original —
 * and such sites often declare the thumbnail as their og:image too. Mapping
 * them lets us upgrade a thumbnail to the real asset using ONLY URLs that
 * literally appear on the page; nothing is guessed or rewritten by hand.
 */
function collectLinkedFullSizeImages(html: string, baseUrl: string) {
  const byBasename = new Map<string, string>();

  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const absolute = absolutizeImageUrl(readTagAttribute(match[0], 'href'), baseUrl);

    if (
      !absolute ||
      !CONTENT_IMAGE_EXTENSION_RE.test(absolute) ||
      THUMBNAIL_PATH_HINT_RE.test(absolute) ||
      CHROME_IMAGE_HINT_RE.test(absolute)
    ) {
      continue;
    }

    const key = imageBasenameKey(absolute);

    if (key && !byBasename.has(key)) {
      byBasename.set(key, absolute);
    }
  }

  return byBasename;
}

function extractImageUrlsFromHtml(html: string, baseUrl: string) {
  // Ranked best-first: structured product data, then social preview metadata,
  // then in-body <img> tags. The first entry becomes `mainImage`.
  const ranked: string[] = [...collectJsonLdImageUrls(html, baseUrl)];

  const metaPatterns = [
    /<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:image:secure_url|og:image:url|og:image)["'][^>]*>/gi,
    /<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:twitter:image:src|twitter:image)["'][^>]*>/gi,
    /<meta\b[^>]*\bitemprop\s*=\s*["']image["'][^>]*>/gi,
    /<link\b[^>]*\brel\s*=\s*["']image_src["'][^>]*>/gi,
  ];

  for (const pattern of metaPatterns) {
    for (const match of html.matchAll(pattern)) {
      const tag = match[0];
      const absolute = absolutizeImageUrl(
        readTagAttribute(tag, 'content') || readTagAttribute(tag, 'href'),
        baseUrl
      );

      if (absolute) {
        ranked.push(absolute);
      }
    }
  }

  const bodyImages: string[] = [];

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const srcset = readTagAttribute(tag, 'srcset') || readTagAttribute(tag, 'data-srcset');
    // Try every candidate in order and keep the first that resolves. Lazy-loading
    // themes ship a data: URI placeholder in src and park the real URL in a
    // data-* attribute, so a rejected src must fall through, not skip the tag.
    const candidates = [
      srcset ? pickLargestSrcsetCandidate(srcset) : null,
      readTagAttribute(tag, 'src'),
      readTagAttribute(tag, 'data-src'),
      readTagAttribute(tag, 'data-original'),
      readTagAttribute(tag, 'data-lazy-src'),
      readTagAttribute(tag, 'data-image'),
    ];

    let absolute: string | null = null;

    for (const candidate of candidates) {
      absolute = absolutizeImageUrl(candidate, baseUrl);

      if (absolute) {
        break;
      }
    }

    if (!absolute || CHROME_IMAGE_HINT_RE.test(absolute)) {
      continue;
    }

    // Skip declared thumbnails; a product hero is rarely under ~200px.
    const width = Number(readTagAttribute(tag, 'width'));

    if (Number.isFinite(width) && width > 0 && width < 200) {
      continue;
    }

    bodyImages.push(absolute);
  }

  const looksLikeImage = (url: string) => CONTENT_IMAGE_EXTENSION_RE.test(url);
  // Extension-less CDN URLs (…/image/upload/abc123) are real images too, so keep
  // them — just after the ones we can positively identify.
  ranked.push(...bodyImages.filter(looksLikeImage), ...bodyImages.filter((url) => !looksLikeImage(url)));

  const fullSizeByBasename = collectLinkedFullSizeImages(html, baseUrl);
  const upgradeThumbnail = (url: string) => {
    if (!THUMBNAIL_PATH_HINT_RE.test(url)) {
      return url;
    }

    const key = imageBasenameKey(url);

    return (key && fullSizeByBasename.get(key)) || url;
  };

  const seen = new Set<string>();
  const images: string[] = [];

  for (const rawUrl of ranked) {
    const url = upgradeThumbnail(rawUrl);

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    images.push(url);

    if (images.length >= 12) {
      break;
    }
  }

  return { images, mainImage: images[0] ?? null };
}

function extractReadableTextFromHtml(html: string, maxChars: number, baseUrl: string) {
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  // Run image extraction on the RAW html: JSON-LD lives inside a <script> tag
  // that `cleaned` has already stripped.
  const { images, mainImage } = extractImageUrlsFromHtml(html, baseUrl);

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const descriptionMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);

  const headings = [...cleaned.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => decodeHtmlEntitiesToText(match[2]))
    .filter(Boolean)
    .slice(0, 40);

  const bodyMatch = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyText = decodeHtmlEntitiesToText(bodyMatch?.[1] ?? cleaned);

  return {
    description: descriptionMatch ? decodeHtmlEntitiesToText(descriptionMatch[1]) : '',
    headings,
    images,
    mainImage,
    text: bodyText.slice(0, maxChars),
    title: titleMatch ? decodeHtmlEntitiesToText(titleMatch[1]) : '',
    truncated: bodyText.length > maxChars,
  };
}

export async function executeFetchUrlContent(input: FetchUrlContentInput) {
  const parsed = fetchUrlContentInputSchema.parse(input);

  let target: URL;

  try {
    target = new URL(parsed.url);
  } catch {
    return { message: `"${parsed.url}" is not a valid URL.`, success: false, url: parsed.url };
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { message: 'Only http and https URLs can be fetched.', success: false, url: parsed.url };
  }

  if (isBlockedFetchHost(target.hostname)) {
    return {
      message: 'Refusing to fetch a local, private, or internal address.',
      success: false,
      url: parsed.url,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_URL_CONTENT_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain',
        'user-agent': 'NextBlockCortexAI/1.0 (+https://nextblock.dev)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        message: `The URL responded with HTTP ${response.status}.`,
        status: response.status,
        success: false,
        url: parsed.url,
      };
    }

    const finalUrl = response.url || target.toString();

    try {
      if (isBlockedFetchHost(new URL(finalUrl).hostname)) {
        return {
          message: 'The URL redirected to a blocked internal address.',
          success: false,
          url: parsed.url,
        };
      }
    } catch {
      // Keep the original URL if the resolved URL cannot be parsed.
    }

    const contentType = response.headers.get('content-type') || '';

    if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return {
        contentType,
        message: `The URL is not an HTML or text page (content-type: ${contentType || 'unknown'}).`,
        success: false,
        url: parsed.url,
      };
    }

    const raw = await response.text();
    const boundedRaw =
      raw.length > FETCH_URL_CONTENT_MAX_BYTES ? raw.slice(0, FETCH_URL_CONTENT_MAX_BYTES) : raw;
    const extracted = extractReadableTextFromHtml(boundedRaw, parsed.maxChars, finalUrl);

    if (!extracted.text && !extracted.title) {
      return { message: 'The URL returned no readable text content.', success: false, url: parsed.url };
    }

    return {
      description: extracted.description,
      finalUrl,
      headings: extracted.headings,
      // Ranked best-first (schema.org Product image > og:image > in-body <img>).
      // `mainImage` is the page's subject image and can be passed straight into
      // create_cms_product `images` / feature_image_id — it is imported into the
      // media library automatically.
      images: extracted.images,
      mainImage: extracted.mainImage,
      success: true,
      text: extracted.text,
      title: extracted.title,
      truncated: extracted.truncated,
      url: parsed.url,
    };
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));

    return {
      message: aborted
        ? 'Fetching the URL timed out.'
        : `Failed to fetch the URL: ${serializeError(error)}`,
      success: false,
      url: parsed.url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// search_stock_photos: find relevant free stock photos (Pexels/Unsplash) whose
// URLs the agent can drop straight into image blocks or section backgrounds.
// Read-only, zero inference cost. Provider auto-detected by which API key is set.
// ---------------------------------------------------------------------------

export const searchStockPhotosInputSchema = z.strictObject({
  count: z.number().int().min(1).max(15).default(6),
  orientation: z
    .enum(['landscape', 'portrait', 'square'])
    .optional()
    .describe('Preferred image orientation. Use landscape for hero/section backgrounds.'),
  query: z.string().trim().min(2).max(200).describe('What the photos should depict, e.g. "herbal supplements".'),
});

export type SearchStockPhotosInput = z.input<typeof searchStockPhotosInputSchema>;

const STOCK_PHOTO_TIMEOUT_MS = 12000;

type CortexAiStockPhotoProvider = { apiKey: string; provider: 'pexels' | 'unsplash' };

/**
 * Resolve ALL configured stock-photo providers, ordered by preference: Pexels
 * first, then Unsplash. Each provider's key comes from an admin-stored, encrypted
 * site_settings row (read via the service-role client) if present, else the
 * PEXELS_API_KEY / UNSPLASH_ACCESS_KEY env var. The tool tries them in order,
 * falling back to the next provider when one is rate-limited or errors.
 *
 * ai-config (which pulls in server-only secret crypto) is imported lazily so this
 * module's static graph stays test-friendly; the DB branch only runs server-side.
 */
export async function resolveCortexAiStockPhotoProviders(
  supabase?: SupabaseLike
): Promise<CortexAiStockPhotoProvider[]> {
  let pexelsKey: string | null = null;
  let unsplashKey: string | null = null;

  if (supabase) {
    try {
      const { CORTEX_AI_PEXELS_SETTING_KEY, CORTEX_AI_UNSPLASH_SETTING_KEY, decryptStoredOpenRouterApiKey } =
        await import('./ai-config');

      const decrypt = (value: unknown): string | null => {
        if (!value) {
          return null;
        }

        try {
          const decrypted = decryptStoredOpenRouterApiKey(value);
          return typeof decrypted === 'string' && decrypted.trim() ? decrypted.trim() : null;
        } catch {
          return null;
        }
      };

      const { data } = await supabase
        .from('site_settings')
        .select('key, value')
        .in('key', [CORTEX_AI_PEXELS_SETTING_KEY, CORTEX_AI_UNSPLASH_SETTING_KEY]);
      const rows = Array.isArray(data) ? data : [];
      pexelsKey = decrypt(rows.find((row: any) => row.key === CORTEX_AI_PEXELS_SETTING_KEY)?.value);
      unsplashKey = decrypt(rows.find((row: any) => row.key === CORTEX_AI_UNSPLASH_SETTING_KEY)?.value);
    } catch {
      // Fall through to env vars if the settings read/decrypt fails.
    }
  }

  if (!pexelsKey) {
    pexelsKey = process.env.PEXELS_API_KEY?.trim() || null;
  }

  if (!unsplashKey) {
    unsplashKey = process.env.UNSPLASH_ACCESS_KEY?.trim() || null;
  }

  const providers: CortexAiStockPhotoProvider[] = [];

  if (pexelsKey) {
    providers.push({ apiKey: pexelsKey, provider: 'pexels' });
  }

  if (unsplashKey) {
    providers.push({ apiKey: unsplashKey, provider: 'unsplash' });
  }

  return providers;
}

/** The primary (first-preference) stock-photo provider, or null when none configured. */
export async function resolveCortexAiStockPhotoProvider(
  supabase?: SupabaseLike
): Promise<CortexAiStockPhotoProvider | null> {
  const providers = await resolveCortexAiStockPhotoProviders(supabase);
  return providers[0] ?? null;
}

/**
 * The operator's registered Unsplash application name (for attribution utm_source).
 * Read from the CMS setting first, then the UNSPLASH_APP_NAME env var. Never
 * hardcoded — it must match the operator's own Unsplash app registration.
 */
async function resolveUnsplashAppName(supabase?: SupabaseLike): Promise<string | null> {
  if (supabase) {
    try {
      const { CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY } = await import('./ai-config');
      const { data } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY)
        .maybeSingle();
      const value = (data as { value?: unknown } | null)?.value;

      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    } catch {
      // Fall through to env.
    }
  }

  return process.env.UNSPLASH_APP_NAME?.trim() || null;
}

async function fetchStockProviderJson(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STOCK_PHOTO_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Stock photo provider responded with HTTP ${response.status}.`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function toFiniteOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function collectUnsplashDownloadLocations(content: unknown, out: Set<string>) {
  if (!isPlainJsonRecord(content)) {
    return;
  }

  const readDownload = (attribution: unknown) => {
    if (
      isPlainJsonRecord(attribution) &&
      attribution.provider === 'unsplash' &&
      typeof attribution.downloadLocation === 'string' &&
      attribution.downloadLocation.trim()
    ) {
      out.add(attribution.downloadLocation.trim());
    }
  };

  readDownload(content.attribution);

  if (isPlainJsonRecord(content.background) && isPlainJsonRecord(content.background.image)) {
    readDownload(content.background.image.attribution);
  }

  if (Array.isArray(content.column_blocks)) {
    for (const column of content.column_blocks) {
      if (Array.isArray(column)) {
        for (const nested of column) {
          if (isPlainJsonRecord(nested)) {
            collectUnsplashDownloadLocations(nested.content, out);
          }
        }
      }
    }
  }

  if (Array.isArray(content.slides)) {
    for (const slide of content.slides) {
      collectUnsplashDownloadLocations(slide, out);
    }
  }
}

/**
 * Fire the Unsplash download-trigger endpoint for every Unsplash photo placed in
 * the given blocks. Required by the Unsplash API Guidelines when a photo is used.
 * Best-effort and fire-and-forget: it resolves the Unsplash key, dedupes, and
 * never blocks or fails the mutation.
 */
export async function maybeTriggerStockPhotoDownloads(
  blocks: Array<{ content?: unknown } | null | undefined>,
  supabase?: SupabaseLike
) {
  try {
    const locations = new Set<string>();

    for (const block of blocks) {
      collectUnsplashDownloadLocations(block?.content, locations);
    }

    if (locations.size === 0) {
      return;
    }

    const providers = await resolveCortexAiStockPhotoProviders(supabase);
    const unsplash = providers.find((provider) => provider.provider === 'unsplash');

    if (!unsplash) {
      return;
    }

    await Promise.all(
      [...locations].map((location) =>
        fetch(location, { headers: { Authorization: `Client-ID ${unsplash.apiKey}` } }).catch(
          () => undefined
        )
      )
    );
  } catch {
    // Never let attribution telemetry break a CMS mutation.
  }
}

async function searchStockPhotosViaProvider(
  provider: CortexAiStockPhotoProvider,
  parsed: z.infer<typeof searchStockPhotosInputSchema>,
  unsplashAppName?: string | null
) {
  const params = new URLSearchParams({
    per_page: String(parsed.count),
    query: parsed.query,
  });

  if (parsed.orientation) {
    params.set('orientation', parsed.orientation);
  }

  if (provider.provider === 'pexels') {
    const data = await fetchStockProviderJson(
      `https://api.pexels.com/v1/search?${params.toString()}`,
      { Authorization: provider.apiKey }
    );

    return (Array.isArray(data?.photos) ? data.photos : [])
      .map((photo: any) => {
        const photographer = typeof photo?.photographer === 'string' ? photo.photographer : null;

        return {
          alt: typeof photo?.alt === 'string' && photo.alt.trim() ? photo.alt.trim() : parsed.query,
          credit: photographer ? `Photo by ${photographer} on Pexels` : 'Photo on Pexels',
          downloadLocation: null,
          height: toFiniteOrNull(photo?.height),
          photographer,
          photographerUrl: typeof photo?.photographer_url === 'string' ? photo.photographer_url : null,
          provider: 'pexels' as const,
          sourceUrl: typeof photo?.url === 'string' ? photo.url : null,
          thumbnailUrl: photo?.src?.medium || photo?.src?.large || null,
          url: photo?.src?.large2x || photo?.src?.large || photo?.src?.original || null,
          width: toFiniteOrNull(photo?.width),
        };
      })
      .filter((photo: { url: unknown }) => typeof photo.url === 'string');
  }

  const data = await fetchStockProviderJson(
    `https://api.unsplash.com/search/photos?${params.toString()}`,
    { Authorization: `Client-ID ${provider.apiKey}` }
  );

  return (Array.isArray(data?.results) ? data.results : [])
    .map((photo: any) => {
      const photographer = typeof photo?.user?.name === 'string' ? photo.user.name : null;

      return {
        alt:
          (typeof photo?.alt_description === 'string' && photo.alt_description.trim()) ||
          (typeof photo?.description === 'string' && photo.description.trim()) ||
          parsed.query,
        credit: photographer ? `Photo by ${photographer} on Unsplash` : 'Photo on Unsplash',
        // Unsplash requires triggering this endpoint when the photo is actually
        // used; carry it so the block-persist path can fire it.
        downloadLocation:
          typeof photo?.links?.download_location === 'string' ? photo.links.download_location : null,
        height: toFiniteOrNull(photo?.height),
        photographer,
        photographerUrl: typeof photo?.user?.links?.html === 'string' ? photo.user.links.html : null,
        provider: 'unsplash' as const,
        sourceUrl: typeof photo?.links?.html === 'string' ? photo.links.html : null,
        thumbnailUrl: photo?.urls?.small || photo?.urls?.thumb || null,
        url: photo?.urls?.regular || photo?.urls?.full || photo?.urls?.raw || null,
        // The operator's registered Unsplash app name for the attribution utm_source.
        utmSource: unsplashAppName || null,
        width: toFiniteOrNull(photo?.width),
      };
    })
    .filter((photo: { url: unknown }) => typeof photo.url === 'string');
}

export async function executeSearchStockPhotos(
  input: SearchStockPhotosInput,
  context?: ToolExecutionContext
) {
  const parsed = searchStockPhotosInputSchema.parse(input);
  const providers = await resolveCortexAiStockPhotoProviders(context?.supabase);

  if (providers.length === 0) {
    return {
      message:
        'No stock photo provider is configured. Add a free Pexels or Unsplash API key in /cms/settings/cortex-ai (or set PEXELS_API_KEY / UNSPLASH_ACCESS_KEY).',
      photos: [],
      success: false,
    };
  }

  // Try each configured provider in order (Pexels, then Unsplash). Falls through
  // to the next provider when one errors — e.g. a 429 when the free-tier quota is
  // exhausted — or returns no matches, so a rate-limited Pexels never blocks results.
  const unsplashAppName = providers.some((provider) => provider.provider === 'unsplash')
    ? await resolveUnsplashAppName(context?.supabase)
    : null;
  const attemptedProviders: string[] = [];
  let lastError: unknown = null;

  for (const provider of providers) {
    attemptedProviders.push(provider.provider);

    try {
      const photos = await searchStockPhotosViaProvider(provider, parsed, unsplashAppName);

      if (photos.length > 0) {
        return {
          attemptedProviders,
          photos,
          provider: provider.provider,
          query: parsed.query,
          success: true,
          usageGuidance:
            provider.provider === 'unsplash'
              ? 'Unsplash photos: keep them hotlinked (use `url` as external_url; never save an Unsplash photo to the media library) and attribute each one — copy the photo\'s attribution fields into the image content\'s `attribution` (photographer, photographerUrl, sourceUrl, downloadLocation, utmSource, provider "unsplash"). The site renders the "Photo by … on Unsplash" credit from `attribution` automatically, so do NOT also copy the credit into `caption` (leave caption empty unless you have a genuine descriptive caption). Also copy the photo\'s `width` and `height` into the image content: the page then reserves the right space before the file loads instead of shifting.'
              : 'Set the image content\'s `attribution` (photographer, photographerUrl, sourceUrl, provider "pexels"). The site renders the "Photo by … on Pexels" credit from `attribution` automatically, so do NOT also copy the credit into `caption` (leave caption empty unless you have a genuine descriptive caption). Pexels attribution is appreciated but optional. Also copy each photo `width` and `height` into the image content: the page then reserves the right space before the file loads instead of shifting.',
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  return {
    attemptedProviders,
    message: lastError
      ? `Stock photo search failed across ${attemptedProviders.join(', ')}: ${serializeError(lastError)}`
      : `No matching stock photos found for "${parsed.query}".`,
    photos: [],
    success: false,
  };
}

// ---------------------------------------------------------------------------
// rewrite_page_draft: replace ALL blocks of a page/post with a new set, staged
// into Live Draft Mode (content_drafts) so the user previews before publishing.
// Publishing the draft applies it live AND auto-snapshots a revision.
// ---------------------------------------------------------------------------

export const rewritePageDraftInputSchema = cmsTargetInputSchema.extend({
  blocks: z.array(createCmsBlockInputSchema).min(1).max(20),
  meta: z
    .strictObject({
      meta_description: z.string().max(500).nullable().optional(),
      meta_title: z.string().max(160).nullable().optional(),
      slug: z.string().trim().min(1).max(300).optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      title: z.string().trim().min(1).max(300).optional(),
    })
    .partial()
    .optional(),
});

export type RewritePageDraftInput = z.infer<typeof rewritePageDraftInputSchema>;

const DRAFT_META_CARRYOVER_FIELDS = [
  'custom_canonical',
  'excerpt',
  'feature_image_id',
  'label',
  'language_id',
  'meta_description',
  'meta_title',
  'published_at',
  'slug',
  'status',
  'subtitle',
  'title',
  'translation_group_id',
] as const;

function buildDraftMetaFromItem(item: Record<string, any>) {
  const meta: Record<string, unknown> = {};

  for (const field of DRAFT_META_CARRYOVER_FIELDS) {
    if (field in item && item[field] !== undefined) {
      meta[field] = item[field];
    }
  }

  return meta;
}

function buildDraftPreviewPath(contentType: 'page' | 'post', publicSlug: string) {
  if (!publicSlug) {
    return null;
  }

  const path =
    contentType === 'page' ? (publicSlug === 'home' ? '/' : `/${publicSlug}`) : `/article/${publicSlug}`;

  return `/api/draft/start?path=${encodeURIComponent(path)}`;
}

export async function executeRewritePageDraft(
  input: RewritePageDraftInput,
  context?: ToolExecutionContext
) {
  const parsed = rewritePageDraftInputSchema.parse(input);
  context = await withCustomBlockDefinitions(context, parsed.blocks);
  const supabase = getSupabase(context);
  const actorUserId = getActorUserId(context);
  const target = await resolveCmsTarget(parsed, context);

  if (target.contentType === 'product') {
    throw new Error(
      'rewrite_page_draft supports pages and posts only. Products use description_json, not page blocks.'
    );
  }

  const parentType = target.contentType;
  const parentId = Number(target.item.id);

  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw new Error('Could not resolve a valid page/post id for the draft rewrite.');
  }

  const languageId = Number(target.item.language_id);

  if (!Number.isInteger(languageId) || languageId <= 0) {
    throw new Error('The target page/post is missing a language id.');
  }

  const normalizedBlocks = normalizeCreateBlocks(parsed.blocks, undefined, undefined, context);
  const draftBlocks = normalizedBlocks.map((block, index) => ({
    block_type: block.block_type,
    content: block.content,
    language_id: languageId,
    order: index,
    page_id: parentType === 'page' ? parentId : null,
    post_id: parentType === 'post' ? parentId : null,
    product_id: null,
  }));

  const meta = buildDraftMetaFromItem(target.item as Record<string, any>);

  if (parsed.meta) {
    for (const [key, value] of Object.entries(parsed.meta)) {
      if (value !== undefined) {
        meta[key] = value;
      }
    }
  }

  const publicSlug = normalizePublicSlug(
    typeof meta.slug === 'string' ? meta.slug : target.item.slug
  );
  const title =
    typeof meta.title === 'string' && meta.title.trim()
      ? meta.title
      : String(target.item.title || publicSlug || 'Untitled');
  const editPath =
    parentType === 'page' ? `/cms/pages/${parentId}/edit` : `/cms/posts/${parentId}/edit`;
  const draftPreviewPath = buildDraftPreviewPath(parentType, publicSlug);

  const payload = {
    blocks: draftBlocks,
    meta,
    parent_id: parentId,
    parent_type: parentType,
    tool: 'rewrite_page_draft',
  };

  const confirmation = getConfirmationPreview({
    action: 'REWRITE DRAFT',
    context,
    payload,
    preview: {
      blockCount: draftBlocks.length,
      contentType: parentType,
      slug: publicSlug,
      summary: `Stage a Live Draft that replaces the ${parentType} "${title}" with ${pluralize(
        draftBlocks.length,
        'new block'
      )}. Nothing goes live until you review the draft and click Publish (which also saves a revision snapshot).`,
      title,
    },
    subject: `${parentType}-${parentId}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const baseVersion = Number(target.item.version) || 1;

  const { error: deleteError } = await supabase
    .from('content_drafts')
    .delete()
    .eq('parent_type', parentType)
    .eq('parent_id', parentId);

  if (deleteError) {
    throw new Error(`Failed to clear the existing draft: ${serializeError(deleteError)}`);
  }

  const { error: insertError } = await supabase.from('content_drafts').insert({
    author_id: actorUserId,
    base_version: baseVersion,
    blocks: draftBlocks,
    meta,
    parent_id: parentId,
    parent_type: parentType,
  });

  if (insertError) {
    throw new Error(`Failed to save the draft: ${serializeError(insertError)}`);
  }

  void maybeTriggerStockPhotoDownloads(draftBlocks, supabase);

  revalidateCurrentCmsSurfaces(
    context,
    { contentType: parentType, entityId: parentId, languageId, slug: publicSlug, title },
    publicSlug
  );

  return {
    blockCount: draftBlocks.length,
    contentType: parentType,
    draftPreviewPath,
    editPath,
    entityId: parentId,
    isDraft: true,
    mutationExecuted: true,
    slug: publicSlug,
    success: true,
    title,
  };
}

// ---------------------------------------------------------------------------
// manage_product_variants: sellable options (size, flavour, colour) for a product.
//
// Deliberately NOT routed through the `upsert_product_with_variants` RPC. That RPC
// re-serializes the entire product, so calling it with a partial payload silently
// wipes SEO fields, categories, media, and the sale schedule — the same reason the
// product image tool writes `product_media` directly. This writes only the four
// variant tables and the derived stock total.
// ---------------------------------------------------------------------------

export const manageProductVariantsInputSchema = z.strictObject({
  attributes: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(120).describe('Attribute name, e.g. "Size" or "Flavour".'),
        terms: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(50)
          .describe('Every possible value for this attribute, e.g. ["100 ml", "500 ml"].'),
      })
    )
    .max(5)
    .optional()
    .describe(
      'The option axes this product varies on. Attributes and terms are global and reused across products: an existing one with the same name is matched, never duplicated. Omit if the attributes already exist.'
    ),
  entityId: z.union([z.number().int().positive(), z.string().trim().min(1).max(120)]).optional(),
  mode: z
    .enum(['replace', 'append'])
    .default('replace')
    .describe('"replace" removes the product\'s existing variants first; "append" keeps them and adds these.'),
  slug: z.string().trim().min(1).max(300).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  variants: z
    .array(
      z.strictObject({
        image: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .optional()
          .describe('Variant-specific image: an https:// URL (imported automatically) or a media library id.'),
        options: z
          .record(z.string(), z.string())
          .describe('Which term this variant is, per attribute, e.g. { "Size": "500 ml" }. Every attribute must be given a value.'),
        price: z.number().min(0).optional().describe('Price in major units (25 = $25.00). Defaults to the product price.'),
        sale_price: z.number().min(0).nullable().optional().describe('Sale price in major units, or null for none.'),
        sku: z.string().trim().min(1).max(120).describe('Unique SKU for this variant.'),
        stock: z.number().int().min(0).default(0),
        upc: z.string().trim().max(120).nullable().optional(),
      })
    )
    .min(1)
    .max(50),
});

export type ManageProductVariantsInput = z.infer<typeof manageProductVariantsInputSchema>;

/** Find-or-create a global attribute and its terms, returning value -> term id. */
async function ensureAttributeTerms(
  supabase: SupabaseLike,
  attribute: { name: string; terms: string[] }
): Promise<{ attributeId: string; termIdByValue: Map<string, string> }> {
  const attributeSlug = slugify(attribute.name);

  const { data: existing } = await supabase
    .from('product_attributes')
    .select('id')
    .eq('slug', attributeSlug)
    .maybeSingle();

  let attributeId = existing?.id as string | undefined;

  if (!attributeId) {
    const { data: created, error } = await supabase
      .from('product_attributes')
      .insert({ name: attribute.name, slug: attributeSlug })
      .select('id')
      .single();

    if (error || !created?.id) {
      throw new Error(`Could not create the "${attribute.name}" attribute: ${serializeError(error)}`);
    }

    attributeId = created.id as string;
  }

  const termIdByValue = new Map<string, string>();

  for (let index = 0; index < attribute.terms.length; index += 1) {
    const value = attribute.terms[index] as string;
    const termSlug = slugify(value);

    const { data: existingTerm } = await supabase
      .from('product_attribute_terms')
      .select('id')
      .eq('attribute_id', attributeId)
      .eq('slug', termSlug)
      .maybeSingle();

    if (existingTerm?.id) {
      termIdByValue.set(value, existingTerm.id as string);
      continue;
    }

    const { data: createdTerm, error: termError } = await supabase
      .from('product_attribute_terms')
      .insert({ attribute_id: attributeId, slug: termSlug, sort_order: index, value })
      .select('id')
      .single();

    if (termError || !createdTerm?.id) {
      throw new Error(`Could not create the "${value}" option: ${serializeError(termError)}`);
    }

    termIdByValue.set(value, createdTerm.id as string);
  }

  return { attributeId, termIdByValue };
}

export async function executeManageProductVariants(
  input: ManageProductVariantsInput,
  context?: ToolExecutionContext
) {
  const parsed = manageProductVariantsInputSchema.parse(input);
  const supabase = getSupabase(context);
  const target = await resolveCmsTarget(
    {
      contentType: 'product',
      ...(parsed.entityId !== undefined ? { entityId: parsed.entityId } : {}),
      ...(parsed.slug ? { slug: parsed.slug } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
    },
    context
  );
  const product = target.item as Record<string, any>;
  const productId = String(product['id']);

  const confirmation = getConfirmationPreview({
    action: 'SET VARIANTS',
    context,
    payload: { entityId: productId, mode: parsed.mode, variantCount: parsed.variants.length },
    preview: {
      contentType: 'product',
      slug: product['slug'],
      summary: `${parsed.mode === 'replace' ? 'Replace' : 'Add'} ${pluralize(
        parsed.variants.length,
        'variant'
      )} on "${product['title']}". Product stock becomes the sum of variant stock.`,
      title: product['title'],
    },
    subject: `product-${productId}-variants`,
  });

  if (confirmation) {
    return confirmation;
  }

  // Resolve every option axis up front so a typo fails before anything is written.
  const termIdByAttributeAndValue = new Map<string, Map<string, string>>();

  for (const attribute of parsed.attributes ?? []) {
    const { termIdByValue } = await ensureAttributeTerms(supabase, attribute);
    termIdByAttributeAndValue.set(attribute.name, termIdByValue);
  }

  // Variants may reference attributes defined on an earlier call, so anything not
  // supplied in `attributes` is looked up rather than treated as an error.
  for (const variant of parsed.variants) {
    for (const [attributeName, value] of Object.entries(variant.options)) {
      if (termIdByAttributeAndValue.get(attributeName)?.has(value)) {
        continue;
      }

      const { data: attributeRow } = await supabase
        .from('product_attributes')
        .select('id')
        .eq('slug', slugify(attributeName))
        .maybeSingle();

      if (!attributeRow?.id) {
        throw new Error(
          `Unknown attribute "${attributeName}". Pass it in \`attributes\` with its full list of terms.`
        );
      }

      const { data: termRow } = await supabase
        .from('product_attribute_terms')
        .select('id')
        .eq('attribute_id', attributeRow.id)
        .eq('slug', slugify(value))
        .maybeSingle();

      if (!termRow?.id) {
        throw new Error(
          `Unknown option "${value}" for attribute "${attributeName}". Add it to that attribute's \`terms\`.`
        );
      }

      const existingMap = termIdByAttributeAndValue.get(attributeName) ?? new Map<string, string>();
      existingMap.set(value, termRow.id as string);
      termIdByAttributeAndValue.set(attributeName, existingMap);
    }
  }

  if (parsed.mode === 'replace') {
    const { error: clearError } = await supabase
      .from('product_variants')
      .delete()
      .eq('product_id', productId);

    if (clearError) {
      throw new Error(`Could not clear the existing variants: ${serializeError(clearError)}`);
    }
  }

  const currency = await getDefaultCurrencyCode(supabase);
  const productPriceMinor = Number(product['price']) || 0;
  const createdSkus: string[] = [];

  for (const variant of parsed.variants) {
    const mainMediaId = variant.image
      ? await resolveMediaReference(variant.image, context, `${product['title']} ${variant.sku}`)
      : null;

    const { data: variantRow, error: variantError } = await supabase
      .from('product_variants')
      .insert({
        main_media_id: mainMediaId,
        price:
          variant.price === undefined
            ? productPriceMinor
            : majorUnitAmountToMinor(variant.price, currency),
        product_id: productId,
        sale_price:
          variant.sale_price === undefined || variant.sale_price === null
            ? null
            : majorUnitAmountToMinor(variant.sale_price, currency),
        sku: variant.sku,
        stock_quantity: variant.stock,
        upc: variant.upc ?? null,
      })
      .select('id')
      .single();

    if (variantError || !variantRow?.id) {
      throw new Error(`Could not create variant "${variant.sku}": ${serializeError(variantError)}`);
    }

    const mappingRows = Object.entries(variant.options).map(([attributeName, value]) => ({
      attribute_term_id: termIdByAttributeAndValue.get(attributeName)?.get(value),
      variant_id: variantRow.id,
    }));

    if (mappingRows.length > 0) {
      const { error: mappingError } = await supabase
        .from('variant_attribute_mapping')
        .insert(mappingRows);

      if (mappingError) {
        throw new Error(
          `Could not link variant "${variant.sku}" to its options: ${serializeError(mappingError)}`
        );
      }
    }

    createdSkus.push(variant.sku);
  }

  // Mirror the RPC: a product with variants derives its stock from them, so the
  // storefront's availability check does not read a stale parent number.
  const { data: allVariants } = await supabase
    .from('product_variants')
    .select('stock_quantity')
    .eq('product_id', productId);

  const totalStock = (allVariants ?? []).reduce(
    (sum: number, row: any) => sum + (Number(row?.stock_quantity) || 0),
    0
  );

  const { error: stockError } = await supabase
    .from('products')
    .update({ stock: totalStock })
    .eq('id', productId);

  if (stockError) {
    throw new Error(`Variants saved, but the product stock total failed: ${serializeError(stockError)}`);
  }

  revalidateCurrentCmsSurfaces(
    context,
    { contentType: 'product', entityId: productId, slug: product['slug'], title: product['title'] },
    product['slug']
  );

  return {
    contentType: 'product',
    entityId: productId,
    mode: parsed.mode,
    mutationExecuted: true,
    skus: createdSkus,
    slug: product['slug'],
    success: true,
    totalStock,
    variantCount: createdSkus.length,
  };
}

// ---------------------------------------------------------------------------
// translate_content_bulk: one call per LOCALE instead of one call per page.
//
// translate_page handles a single item, so making a 20-page site bilingual meant 20
// round trips, each re-stating the target language. This loops the same executor and
// keeps going when one item fails, so a single bad string map does not abandon the
// other nineteen translations halfway through.
// ---------------------------------------------------------------------------

export const translateContentBulkInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        contentType: z.enum(['page', 'post']).default('page'),
        slug: z.string().trim().min(1).max(300).describe('Slug of the source page or post.'),
        title: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe('Translated title. Defaults to translating the source title.'),
        translations: z
          .record(z.string(), z.string())
          .describe('Source string -> translated string for every visible string in THIS item.'),
      })
    )
    .min(1)
    .max(25),
  targetLanguageCode: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe('Target language code or name, e.g. "fr". The language must already exist — create it with manage_language first.'),
});

export type TranslateContentBulkInput = z.infer<typeof translateContentBulkInputSchema>;

export async function executeTranslateContentBulk(
  input: TranslateContentBulkInput,
  context?: ToolExecutionContext
) {
  const parsed = translateContentBulkInputSchema.parse(input);

  const confirmation = getConfirmationPreview({
    action: 'TRANSLATE BULK',
    context,
    payload: { count: parsed.items.length, language: parsed.targetLanguageCode },
    preview: {
      contentType: 'page',
      summary: `Create ${parsed.targetLanguageCode} translations of ${pluralize(
        parsed.items.length,
        'item'
      )}: ${parsed.items.map((item) => item.slug).join(', ')}.`,
      title: `Bulk translate to ${parsed.targetLanguageCode}`,
    },
    subject: `bulk-translate-${parsed.targetLanguageCode}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const succeeded: Array<Record<string, unknown>> = [];
  const failed: Array<{ error: string; slug: string }> = [];

  for (const item of parsed.items) {
    try {
      const result = await executeTranslatePage(
        {
          cmsTarget: { contentType: item.contentType, slug: item.slug },
          targetLanguageCode: parsed.targetLanguageCode,
          ...(item.title ? { title: item.title } : {}),
          translations: item.translations,
        } as TranslatePageInput,
        context
      );

      succeeded.push({ slug: item.slug, ...(result as Record<string, unknown>) });
    } catch (error) {
      // Keep going: one unusable string map should not cost the whole batch.
      failed.push({ error: error instanceof Error ? error.message : String(error), slug: item.slug });
    }
  }

  return {
    failed,
    failedCount: failed.length,
    mutationExecuted: succeeded.length > 0,
    success: failed.length === 0,
    targetLanguageCode: parsed.targetLanguageCode,
    translated: succeeded,
    translatedCount: succeeded.length,
  };
}

// ---------------------------------------------------------------------------
// publish_content_draft: the other half of the Live Draft lifecycle.
//
// rewrite_page_draft/generate_jsonb_layout stage a draft and stop, because in the
// dashboard a human clicks Publish. An MCP client has no such button, so a page
// built over MCP used to be stranded in content_drafts with no tool able to release
// it — which makes "build me a site" impossible to finish in one pass. This applies
// the draft to the live tables with the same semantics as the editor's Publish.
// ---------------------------------------------------------------------------

export const publishContentDraftInputSchema = z.strictObject({
  action: z
    .enum(['publish', 'discard'])
    .default('publish')
    .describe('"publish" applies the draft to the live page/post; "discard" deletes it and leaves the live content untouched.'),
  contentType: z.enum(['page', 'post']).optional(),
  entityId: z.union([z.number().int().positive(), z.string().trim().min(1).max(120)]).optional(),
  slug: z.string().trim().min(1).max(300).optional(),
  title: z.string().trim().min(1).max(300).optional(),
});

export type PublishContentDraftInput = z.infer<typeof publishContentDraftInputSchema>;

/** Draft meta keys copied onto the live row, mirroring the editor's Publish exactly. */
const DRAFT_META_REQUIRED_STRING_KEYS = ['title', 'slug'] as const;
const DRAFT_META_NULLABLE_STRING_KEYS = [
  'custom_canonical',
  'feature_image_id',
  'meta_description',
  'meta_title',
] as const;

export async function executePublishContentDraft(
  input: PublishContentDraftInput,
  context?: ToolExecutionContext
) {
  const parsed = publishContentDraftInputSchema.parse(input);
  const supabase = getSupabase(context);
  const pageContext = await resolveEditingCmsContext(
    {
      ...(parsed.contentType ? { contentType: parsed.contentType } : {}),
      ...(parsed.entityId !== undefined ? { entityId: parsed.entityId } : {}),
      ...(parsed.slug ? { slug: parsed.slug } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
    },
    context
  );

  if (pageContext.contentType === 'product') {
    throw new Error(
      'publish_content_draft supports pages and posts. Product drafts live in product_drafts and are published from the product editor.'
    );
  }

  const parentType = pageContext.contentType;
  const parentId = getNumericEntityId(pageContext);
  const table = parentType === 'page' ? 'pages' : 'posts';

  const { data: draftRow, error: draftError } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('parent_type', parentType)
    .eq('parent_id', parentId)
    .maybeSingle();

  if (draftError) {
    throw new Error(`Failed to read the draft: ${serializeError(draftError)}`);
  }

  if (!draftRow) {
    return {
      contentType: parentType,
      entityId: parentId,
      message: `No Live Draft exists for ${parentType} "${pageContext.title || pageContext.slug}". Nothing to ${parsed.action}.`,
      mutationExecuted: false,
      success: false,
    };
  }

  const label = pageContext.title || pageContext.slug || `${parentType} ${parentId}`;
  const confirmation = getConfirmationPreview({
    action: parsed.action === 'publish' ? 'PUBLISH DRAFT' : 'DISCARD DRAFT',
    context,
    payload: { action: parsed.action, contentType: parentType, entityId: String(parentId) },
    preview: {
      contentType: parentType,
      slug: pageContext.slug,
      summary:
        parsed.action === 'publish'
          ? `Publish the Live Draft for ${parentType} "${label}", replacing its live blocks. A revision snapshot is saved first, so this is reversible from Revision History.`
          : `Discard the Live Draft for ${parentType} "${label}". The live content is left untouched.`,
      title: pageContext.title,
    },
    subject: `${parentType}-${parentId}-draft`,
  });

  if (confirmation) {
    return confirmation;
  }

  const draftMeta = (draftRow['meta'] ?? {}) as Record<string, unknown>;
  const draftBlocks = Array.isArray(draftRow['blocks']) ? (draftRow['blocks'] as any[]) : [];

  if (parsed.action === 'discard') {
    const { error: discardError } = await supabase
      .from('content_drafts')
      .delete()
      .eq('id', draftRow['id']);

    if (discardError) {
      throw new Error(`Failed to discard the draft: ${serializeError(discardError)}`);
    }

    revalidateCurrentCmsSurfaces(context, pageContext, pageContext.slug);

    return {
      action: 'discard',
      contentType: parentType,
      entityId: parentId,
      mutationExecuted: true,
      success: true,
    };
  }

  const baseline = await captureCmsRevision(context, parentType, parentId);

  const rowUpdate: Record<string, unknown> = {};

  for (const key of DRAFT_META_REQUIRED_STRING_KEYS) {
    const value = draftMeta[key];

    if (typeof value === 'string' && value.trim()) {
      rowUpdate[key] = value.trim();
    }
  }

  for (const key of DRAFT_META_NULLABLE_STRING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(draftMeta, key)) {
      const value = draftMeta[key];
      rowUpdate[key] = typeof value === 'string' && value.trim() ? value.trim() : null;
    }
  }

  // `status` and `published_at` are deliberately NOT copied. Visibility is owned by
  // the editor's own control and written straight to the row; a draft staged before
  // a visibility change still carries the old status, and copying it would silently
  // unpublish a live page (or publish a private one) behind the operator's back.

  if (Object.keys(rowUpdate).length > 0) {
    const { error: metaError } = await supabase.from(table).update(rowUpdate).eq('id', parentId);

    if (metaError) {
      throw new Error(`Failed to apply the draft metadata: ${serializeError(metaError)}`);
    }
  }

  const parentColumn = parentType === 'page' ? 'page_id' : 'post_id';
  const { error: clearError } = await supabase.from('blocks').delete().eq(parentColumn, parentId);

  if (clearError) {
    throw new Error(`Failed to clear the live blocks: ${serializeError(clearError)}`);
  }

  const languageId =
    Number(draftMeta['language_id']) ||
    Number(pageContext.languageId) ||
    Number(draftBlocks[0]?.language_id) ||
    0;

  if (draftBlocks.length > 0) {
    const blockRows = draftBlocks.map((block, index) => ({
      block_type: block?.block_type,
      content: block?.content ?? {},
      language_id: Number(block?.language_id) || languageId,
      order: Number.isFinite(block?.order) ? block.order : index,
      page_id: parentType === 'page' ? parentId : null,
      post_id: parentType === 'post' ? parentId : null,
      product_id: null,
    }));

    const { error: insertError } = await supabase.from('blocks').insert(blockRows);

    if (insertError) {
      throw new Error(`Failed to publish the draft blocks: ${serializeError(insertError)}`);
    }
  }

  // Past the point of no return: the live content has already been rewritten, so a
  // failure from here on is reported as a warning rather than thrown. Aborting would
  // leave the draft row in place and the public route stale — strictly worse.
  await commitCmsRevision(context, parentType, parentId, baseline);

  const { error: cleanupError } = await supabase
    .from('content_drafts')
    .delete()
    .eq('id', draftRow['id']);

  const publishedSlug =
    typeof rowUpdate['slug'] === 'string' ? (rowUpdate['slug'] as string) : pageContext.slug;

  revalidateCurrentCmsSurfaces(
    context,
    { ...pageContext, slug: publishedSlug },
    publishedSlug ?? undefined
  );

  return {
    action: 'publish',
    blockCount: draftBlocks.length,
    contentType: parentType,
    entityId: parentId,
    mutationExecuted: true,
    slug: publishedSlug,
    success: true,
    ...(cleanupError
      ? { warning: `Published, but the draft row was not removed: ${serializeError(cleanupError)}` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// translate_page: create a linked target-language copy of the current page/post.
// The tool copies the source structure + images verbatim and applies a compact
// source->target TEXT map the agent supplies, so translating is one small tool
// call (no rebuild, no photo search) and the new page is linked to the original.
// ---------------------------------------------------------------------------

// Content keys whose string values are visible copy that should be translated.
const TRANSLATABLE_STRING_FIELDS = new Set([
  'alt_text',
  'author_name',
  'author_title',
  'caption',
  'html_content',
  'label',
  'placeholder',
  'quote',
  'submit_button_text',
  'success_message',
  'text',
  'text_content',
  'title',
]);

function translateString(
  value: string,
  translations: Record<string, string>,
  sortedEntries: Array<[string, string]>
): string {
  if (!value) {
    return value;
  }

  // Exact match on the whole value (optionally trimmed) is the most reliable.
  if (Object.prototype.hasOwnProperty.call(translations, value)) {
    return translations[value];
  }

  const trimmed = value.trim();

  if (trimmed !== value && Object.prototype.hasOwnProperty.call(translations, trimmed)) {
    return value.replace(trimmed, translations[trimmed]);
  }

  // Otherwise replace known source phrases wherever they appear (e.g. inside
  // html_content). Longest-first so a short phrase never clobbers part of a longer one.
  let result = value;

  for (const [from, to] of sortedEntries) {
    if (from && result.includes(from)) {
      result = result.split(from).join(to);
    }
  }

  return result;
}

function translateBlockContent(
  content: unknown,
  translations: Record<string, string>,
  sortedEntries: Array<[string, string]>,
  extraTranslatableKeys?: ReadonlySet<string>
): unknown {
  if (Array.isArray(content)) {
    return content.map((item) => translateBlockContent(item, translations, sortedEntries, extraTranslatableKeys));
  }

  if (content && typeof content === 'object') {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
      if (typeof value === 'string' && (TRANSLATABLE_STRING_FIELDS.has(key) || extraTranslatableKeys?.has(key))) {
        out[key] = translateString(value, translations, sortedEntries);
      } else if (value && typeof value === 'object') {
        out[key] = translateBlockContent(value, translations, sortedEntries, extraTranslatableKeys);
      } else {
        out[key] = value;
      }
    }

    return out;
  }

  return content;
}

/** The text and rich-text field keys of a custom block, which carry visible copy. */
function getCustomBlockTranslatableKeys(blockType: unknown, context?: ToolExecutionContext) {
  if (typeof blockType !== 'string' || isValidBlockType(blockType)) {
    return undefined;
  }

  const definition = findCustomBlockDefinition(blockType, context);

  if (!definition) {
    return undefined;
  }

  return new Set(
    readCustomBlockFields(definition)
      .filter((field) => field.type === 'text' || field.type === 'rich-text')
      .map((field) => field.key)
  );
}

export const translatePageInputSchema = z.strictObject({
  cmsTarget: cmsTargetOverrideSchema,
  targetLanguageCode: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe('Target language code or name, e.g. "fr" or "French".'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe('Translated page title (defaults to translating the source title).'),
  translations: z
    .record(z.string(), z.string())
    .describe(
      'Map of every visible source string to its translation, e.g. { "Explore Our Products": "Explorez nos produits" }. Include headings, paragraph text, button labels, image alt text, captions, and form labels.'
    ),
});

export type TranslatePageInput = z.infer<typeof translatePageInputSchema>;

export async function executeTranslatePage(
  input: TranslatePageInput,
  context?: ToolExecutionContext
) {
  const parsed = translatePageInputSchema.parse(input);
  const pageContext = await resolveEditingCmsContext(parsed.cmsTarget, context);

  if (pageContext.contentType === 'product') {
    throw new Error('translate_page supports pages and posts only.');
  }

  const supabase = getSupabase(context);
  const entityId = getNumericEntityId(pageContext);
  const table = pageContext.contentType === 'page' ? 'pages' : 'posts';
  const parentColumn = pageContext.contentType === 'page' ? 'page_id' : 'post_id';

  const { data: source, error: sourceError } = await supabase
    .from(table)
    .select('*')
    .eq('id', entityId)
    .single();

  if (sourceError || !source) {
    throw new Error(
      `Could not read the source ${pageContext.contentType} to translate: ${serializeError(sourceError)}`
    );
  }

  const { data: blockRows, error: blocksError } = await supabase
    .from('blocks')
    .select('id, block_type, content, order')
    .eq(parentColumn, entityId);

  if (blocksError) {
    throw new Error(`Could not read the source blocks: ${serializeError(blocksError)}`);
  }

  const orderedBlocks = (Array.isArray(blockRows) ? blockRows : [])
    .slice()
    .sort((a: any, b: any) => Number(a.order) - Number(b.order));

  if (orderedBlocks.length === 0) {
    throw new Error(`The source ${pageContext.contentType} has no content blocks to translate.`);
  }

  // Custom block instances on the source page carry their copy in definition-named
  // fields; load the definitions so those fields are translated like built-in ones.
  context = await withCustomBlockDefinitions(context, orderedBlocks);

  const translations = parsed.translations || {};
  const sortedEntries = Object.entries(translations)
    .filter(([from]) => Boolean(from))
    .sort((a, b) => b[0].length - a[0].length);

  const translatedBlocks = orderedBlocks.map((block: any, index: number) => ({
    blockType: block.block_type,
    content: translateBlockContent(
      cloneJsonValue(block.content),
      translations,
      sortedEntries,
      getCustomBlockTranslatableKeys(block.block_type, context)
    ),
    order: index,
  }));

  const targetLanguage = await getDefaultLanguageRecord(supabase, parsed.targetLanguageCode);
  const sourceTitle = String(source.title || '');
  const translatedTitle =
    parsed.title || translateString(sourceTitle, translations, sortedEntries) || sourceTitle || 'Untitled';
  const translateOptional = (value: unknown) =>
    typeof value === 'string' && value.trim()
      ? translateString(value, translations, sortedEntries)
      : undefined;

  // Localize the slug from the translated title ("Home" -> "Accueil" ->
  // "accueil") instead of copying the source slug verbatim, so each language
  // gets its own clean URL. Fall back to the source slug (then a generic slug)
  // if the title yields nothing sluggable (e.g. a non-latin script).
  const translatedSlug = slugify(translatedTitle) || source.slug || 'translated-page';

  const commonInput = {
    blocks: translatedBlocks,
    feature_image_id: source.feature_image_id ?? undefined,
    languageCode: targetLanguage.code,
    meta_description: translateOptional(source.meta_description),
    meta_title: translateOptional(source.meta_title),
    slug: translatedSlug,
    // Publish the translation immediately so it goes live the moment the owner
    // confirms — the localized homepage/page is then reachable and the public
    // language switcher can find it (drafts are filtered out of public lookups).
    status: 'published' as const,
    title: translatedTitle,
    translationGroupId: source.translation_group_id || undefined,
  };
  const createInput =
    pageContext.contentType === 'post'
      ? {
          ...commonInput,
          excerpt: translateOptional(source.excerpt),
          label: translateOptional(source.label),
          // Inherit the source post's publish date (or "now" if it has none) so a
          // published translation sorts alongside its original in the article list
          // instead of jumping to the top with a null published_at.
          published_at: source.published_at ?? new Date().toISOString(),
          subtitle: translateOptional(source.subtitle),
        }
      : commonInput;

  const confirmation = getConfirmationPreview({
    action: 'TRANSLATE',
    context,
    payload: { createInput, sourceId: source.id, tool: 'translate_page' },
    preview: {
      blockCount: translatedBlocks.length,
      contentType: pageContext.contentType,
      languageCode: targetLanguage.code,
      slug: commonInput.slug,
      status: commonInput.status,
      summary: `Publish a ${targetLanguage.code.toUpperCase()} translation of "${sourceTitle}" — it goes live immediately, linked to the original ${pageContext.contentType}, at /${commonInput.slug} with ${pluralize(
        translatedBlocks.length,
        'translated block'
      )}.`,
      title: translatedTitle,
    },
    subject: `translate ${pageContext.contentType} ${source.id} to ${targetLanguage.code}`,
  });

  if (confirmation) {
    return confirmation;
  }

  const childContext = { ...context, skipConfirmation: true } as ToolExecutionContext;
  const created =
    pageContext.contentType === 'post'
      ? await executeCreateCmsPost(createInput as any, childContext)
      : await executeCreateCmsPage(createInput as any, childContext);

  return { ...(created as Record<string, unknown>), isTranslation: true, languageCode: targetLanguage.code };
}

/**
 * Set the feature image (pages/posts) or the ordered image gallery (products)
 * for a CMS item. Each entry may be an existing media library id or an
 * external image URL (imported automatically). The first entry is the feature /
 * main image. For pages/posts only the first entry is used (they have a single
 * feature image); for products every entry becomes a product_media row in order.
 *
 * The target is the current edit context by default, but an explicit
 * contentType + slug/entityId/title targets any item — so this works from the
 * dashboard with no page open (e.g. right after create_cms_product).
 */
export async function executeSetContentImages(
  input: SetContentImagesInput,
  context?: ToolExecutionContext
) {
  const parsed = setContentImagesInputSchema.parse(input);
  const hasExplicitTarget =
    parsed.entityId !== undefined || Boolean(parsed.slug) || Boolean(parsed.title);
  const supabase = getSupabase(context);
  let pageContext: CortexAiPageContext;
  let entityId: string | number;

  if (hasExplicitTarget) {
    const resolved = await resolveCmsTarget(
      {
        contentType: parsed.contentType,
        entityId: parsed.entityId,
        slug: parsed.slug,
        title: parsed.title,
      },
      context
    );
    const item = resolved.item as Record<string, unknown>;

    // Use the resolved row's id verbatim. Coercing it to a string would break
    // integer-keyed tables (pages/posts) while being a no-op for uuid products.
    entityId = item['id'] as string | number;
    pageContext = {
      contentType: resolved.contentType,
      entityId,
      slug: typeof item['slug'] === 'string' ? item['slug'] : '',
      title: typeof item['title'] === 'string' ? item['title'] : '',
    } as CortexAiPageContext;
  } else {
    pageContext = getCurrentCmsContext(context);
    entityId = getCmsEntityId(pageContext);
  }
  const label = pageContext.title || pageContext.slug || 'current item';
  const isProduct = pageContext.contentType === 'product';

  const confirmation = getConfirmationPreview({
    action: 'SET IMAGES',
    context,
    payload: {
      contentType: pageContext.contentType,
      entityId: String(entityId),
      images: parsed.images,
      tool: 'set_content_images',
    },
    preview: {
      contentType: pageContext.contentType,
      imageCount: parsed.images.length,
      slug: pageContext.slug,
      summary: isProduct
        ? `Set ${pluralize(
            parsed.images.length,
            'image'
          )} on product "${label}" (the first becomes the main product image, the rest the gallery).`
        : `Set the feature image on the ${pageContext.contentType} "${label}".`,
      title: pageContext.title,
    },
    subject: `set images on ${pageContext.contentType} ${String(entityId)}`,
  });

  if (confirmation) {
    return confirmation;
  }

  // Resolve every reference to a media id, importing external URLs as needed.
  const mediaIds = await resolveMediaReferences(parsed.images, context, label);

  if (mediaIds.length === 0) {
    throw new Error('None of the provided images could be resolved to a media item.');
  }

  if (isProduct) {
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, slug, language_id, title')
      .eq('id', entityId)
      .maybeSingle();

    if (productError || !product) {
      throw new Error(
        `Could not load the product to set images: ${serializeError(productError)}`
      );
    }

    const uniqueMediaIds = await replaceProductMediaRows({
      mediaIds,
      productId: entityId,
      supabase,
    });

    // An open draft carries its own product_media list, and publishing feeds it
    // straight back through updateProduct — which would restore the old gallery.
    await patchOpenProductDraft({
      patch: ({ meta }) =>
        Array.isArray(meta['product_media'])
          ? {
              meta: {
                ...meta,
                product_media: uniqueMediaIds.map((media_id, mediaIndex) => ({
                  media_id,
                  sort_order: mediaIndex,
                })),
              },
            }
          : {},
      productId: entityId,
      supabase,
    });

    revalidateCurrentCmsSurfaces(
      context,
      {
        contentType: 'product',
        entityId: String(entityId),
        languageId: product.language_id,
        slug: product.slug,
        title: product.title,
      },
      product.slug
    );
    context?.revalidatePath?.('/cms/products');

    return {
      contentType: 'product',
      entityId,
      imageCount: uniqueMediaIds.length,
      mutationExecuted: true,
      slug: product.slug,
      success: true,
    };
  }

  // Product images live in product_media, which is outside the revision snapshot
  // (content, not commerce state) — so only the page/post feature image is recorded.
  const revisionBaseline = await captureCmsRevision(context, pageContext.contentType, entityId);

  const table = pageContext.contentType === 'page' ? 'pages' : 'posts';
  const { data: item, error } = await supabase
    .from(table)
    .update({
      feature_image_id: mediaIds[0],
      updated_at: new Date().toISOString(),
    })
    .eq('id', entityId)
    .select('id, language_id, slug, status, title')
    .single();

  if (error || !item) {
    throw new Error(`Failed to set the feature image: ${serializeError(error)}`);
  }

  await commitCmsRevision(context, pageContext.contentType, entityId, revisionBaseline);

  revalidateCurrentCmsSurfaces(context, pageContext, item.slug);

  return {
    contentType: pageContext.contentType,
    entityId,
    extraImagesIgnored: mediaIds.length - 1,
    imageCount: 1,
    mutationExecuted: true,
    slug: item.slug,
    success: true,
  };
}

export function createCortexGlobalAgentTools(context?: ToolExecutionContext) {
  return {
    ...createCortexDatabaseAgentTools(context),
    ...createCortexCustomBlockTools(context),
    ...createCortexContentOpsTools(context),
    ...createCortexThemingTools(context),
    ...createCortexSiteTools(context),
    fetch_ecommerce_stats: tool({
      description:
        'Fetch quantitative ecommerce statistics and reports from the database. Use this to answer questions about revenue, order counts, order status counts such as pending or trial, and top-selling products over a time range. This tool is read-only and does not require confirmation.',
      execute: (input) => executeFetchEcommerceStats(input, context),
      inputSchema: fetchEcommerceStatsInputSchema,
      strict: true,
    }),
    read_current_cms_item: tool({
      description:
        'Read a CMS item: page/post/product metadata plus page/post block summaries or content. Defaults to the item currently open in the CMS editor; with no editor open (MCP clients) pass `cmsTarget` with contentType plus slug, entityId, or title. Read-only.',
      execute: (input) => executeReadCurrentCmsItem(input, context),
      inputSchema: readCurrentCmsItemInputSchema,
      strict: true,
    }),
    search_documentation: tool({
      description:
        'Search the NextBlock documentation database and return concise source snippets for factual CMS guidance.',
      execute: (input) => executeSearchDocumentationWithTimeout(input, context),
      inputSchema: searchDocumentationInputSchema,
      strict: true,
    }),
    fetch_url_content: tool({
      description:
        'Fetch an external web page and return its title, meta description, headings, body text, AND its images: `mainImage` (the page\'s subject image — schema.org Product image, else og:image, else the best in-body <img>) plus a ranked `images` list, all as absolute URLs. Read-only, no confirmation. Use this first whenever the user references an external URL to copy, adapt, clone, or draw inspiration from. To reuse the source page\'s image, pass `mainImage` straight into create_cms_product `images` or a page/post `feature_image_id` — it is imported into the media library automatically. Never invent an image URL: if `mainImage` is null, the page had none.',
      execute: (input) => executeFetchUrlContent(input),
      inputSchema: fetchUrlContentInputSchema,
      strict: true,
    }),
    search_stock_photos: tool({
      description:
        'Find relevant, free, high-quality stock photos (Unsplash/Pexels) for page imagery. Returns a list of photos each with a direct image `url`, `width`, `height`, `alt`, and `photographer`. Read-only, zero cost. Use the returned `url` directly as an image block\'s external_url (copy `width` and `height` into the same image content, so the page does not shift while the photo loads) or a section image background\'s image.external_url when building or revamping pages, so layouts show real photos instantly. Set orientation "landscape" for hero/section backgrounds.',
      execute: (input) => executeSearchStockPhotos(input, context),
      inputSchema: searchStockPhotosInputSchema,
      strict: true,
    }),
    manage_product_variants: tool({
      description:
        'Give a product sellable variations — size, flavour, colour, format — each with its own SKU, price, stock, and optional image. Define the option axes in `attributes` (name plus every term) and one entry in `variants` per purchasable combination, naming its term per attribute in `options`. Attributes and terms are global and reused across products, so an existing "Size" is matched rather than duplicated. Prices are in major units (25 = $25.00). The product\'s stock becomes the sum of its variants. Use mode "replace" to rebuild the variant set, "append" to add to it. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeManageProductVariants(input, context),
      inputSchema: manageProductVariantsInputSchema,
      strict: true,
    }),
    translate_content_bulk: tool({
      description:
        'Translate SEVERAL pages or posts into one language in a single call. Use this instead of repeating translate_page when making a site multilingual: pass the target language once and one entry per item, each with its own source-string -> translation map. Layout, blocks, and imagery are copied automatically and each copy is linked to its original as a translation. The language must exist first (manage_language). Items are processed independently, so one bad entry does not abandon the rest — check `failed` in the result. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeTranslateContentBulk(input, context),
      inputSchema: translateContentBulkInputSchema,
      strict: true,
    }),
    publish_content_draft: tool({
      description:
        'Publish (or discard) the Live Draft staged on a page or post by generate_jsonb_layout / rewrite_page_draft. Publishing applies the draft blocks and metadata to the live record and snapshots a revision first, so it is reversible from Revision History; visibility (status/published_at) is never changed. Use this to finish a build that staged a draft — without it the new layout stays invisible on the public site. Target the record with contentType plus slug, entityId, or title. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executePublishContentDraft(input, context),
      inputSchema: publishContentDraftInputSchema,
      strict: true,
    }),
    rewrite_page_draft: tool({
      description:
        'Replace ALL blocks of an existing page or post with a brand-new set of blocks, staged as a Live Draft (content_drafts) that the user previews before publishing. Use this for whole-page redesigns/rewrites such as "rewrite my home page with 5 sections". Provide the complete new list of top-level blocks in `blocks` (usually section blocks for a landing/home page, each with nested heading/text/button blocks). Nothing goes live until the user publishes the draft, and publishing auto-creates a revision snapshot so the change is reversible. Mutating: first returns a confirmation phrase; only stages the draft after the user replies with the exact phrase.',
      execute: (input) => executeRewritePageDraft(input, context),
      inputSchema: rewritePageDraftInputSchema,
      strict: true,
    }),
    translate_page: tool({
      description:
        'Translate the CURRENT page or post into another language. This copies the source page\'s entire structure, layout, and images automatically and links the new page to the original as a translation — you ONLY supply the text translations. Provide targetLanguageCode (e.g. "fr") and a `translations` map of every visible source string to its translation (headings, paragraph text, button labels, image alt text, captions, form labels). Do NOT rebuild the layout or call search_stock_photos for a translation. Targets the open page/post by default; with no editor open (MCP clients) pass `cmsTarget` with contentType plus slug, entityId, or title. Mutating: first returns a confirmation phrase; only creates the translation after exact confirmation.',
      execute: (input) => executeTranslatePage(input, context),
      inputSchema: translatePageInputSchema,
      strict: true,
    }),
    set_content_images: tool({
      description:
        "Set the feature image for a page or post, or the image gallery for a product. Pass `images`: a list of image URLs (e.g. `mainImage` from fetch_url_content or `url` values from search_stock_photos) and/or existing media library IDs. External URLs are imported into the media library automatically — NEVER put an image URL directly into feature_image_id. The FIRST image becomes the feature image (pages/posts) or the main product image (products); for a product the remaining images become its gallery in order (this REPLACES the product's current images). On a PAGE the feature image renders as a full-width title banner above the blocks, so never set one on the home page or on a page that opens with its own hero section — use update_site_identity `social_image` for that page's share preview instead; posts should always have one. Targets the currently open page/post/product by default; to target any other item (for example a product you just created from the dashboard) pass contentType plus slug, entityId, or title — no open editor needed. Mutating: first returns a confirmation phrase; only applies after exact confirmation.",
      execute: (input) => executeSetContentImages(input, context),
      inputSchema: setContentImagesInputSchema,
      strict: true,
    }),
    create_cms_page: tool({
      description:
        'Create a new CMS page with metadata and optional validated page blocks. Mutating: first returns a confirmation phrase; only executes after the user replies with the exact phrase. For translations, pass translationGroupId from the source page/post/product context so the new language is linked to the same backend translation group. For contact pages, provide a form block with fields; the destination address is configured once in CMS -> Messages and is never stored on the block.',
      execute: (input) => executeCreateCmsPage(input, context),
      inputSchema: createCmsPageInputSchema,
      strict: true,
    }),
    create_cms_post: tool({
      description:
        'Create a new CMS post with metadata and optional validated post blocks. Mutating: first returns a confirmation phrase; only executes after the user replies with the exact phrase. For translations, pass translationGroupId from the source post context so the new language is linked to the same backend translation group.',
      execute: (input) => executeCreateCmsPost(input, context),
      inputSchema: createCmsPostInputSchema,
      strict: true,
    }),
    create_cms_product: tool({
      description:
        'Create a new draft-capable product, complete with its images and its body copy in ONE call. Pass `images` to set the main product image and gallery (external https URLs are imported into the media library automatically — use `mainImage` from fetch_url_content to reuse a source page\'s photo). Pass `blocks` to build the product\'s "Product Description Blocks" — the SAME block vocabulary and section-based design rules as create_cms_page, rendered on the public product page. This is the richest product body and is what you should produce whenever the user asks to copy or write real product content. Also pass `short_description` for the one-line summary shown on product cards. `description_html` is a plain-HTML fallback body used only when no blocks are supplied. Defaults missing fields safely: physical Stripe product, generated SKU, price 0, stock 0, taxable, draft. `price` is in major units (25 = $25.00). For translations, pass translationGroupId from the source product context. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeCreateCmsProduct(input, context),
      inputSchema: createCmsProductInputSchema,
      strict: true,
    }),
    delete_cms_item: tool({
      description:
        'Delete a resolved page, post, or product after exact confirmation. Pages/posts delete all translations in the translation group and related navigation links. Mutating: refuses unless the latest user message includes the exact confirmation phrase.',
      execute: (input) => executeDeleteCmsItem(input, context),
      inputSchema: deleteCmsItemInputSchema,
      strict: true,
    }),
    prepare_delete_cms_item: tool({
      description:
        'Inspect the page, post, or product that would be deleted and return the exact confirmation phrase. This tool does not mutate data.',
      execute: (input) => executePrepareDeleteCmsItem(input, context),
      inputSchema: prepareDeleteCmsItemInputSchema,
      strict: true,
    }),
    update_footer: tool({
      description:
        'Replace the public footer links and/or footer copyright settings for a locale. Use links for footer navigation and copyright for locale text templates. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateFooter(input, context),
      inputSchema: updateFooterInputSchema,
      strict: true,
    }),
    update_content_block: tool({
      description:
        'Update the JSON content of an existing top-level page/post block. The block must belong to the item being edited — the open CMS editor, or the item named by `cmsTarget` (contentType plus slug, entityId, or title) when no editor is open, as with MCP clients. Content is merged with the existing block before validation. For section blocks, add nested blocks with content.append_block or content.append_blocks using objects like { block_type: "button", content: { text: "Contact Us", url: "/contact" } }; existing column_blocks and layout fields are preserved. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateContentBlock(input, context),
      inputSchema: updateContentBlockInputSchema,
      strict: true,
    }),
    insert_content_block: tool({
      description:
        'Insert a new validated top-level page/post block before or after an existing block, or at the start/end. Use this for visible content additions like adding a rich text title and paragraph above a form. For "above the form", use position "before" with anchorBlockType "form" and blockType "text" containing html_content. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeInsertContentBlock(input, context),
      inputSchema: insertContentBlockInputSchema,
      strict: true,
    }),
    update_current_cms_fields: tool({
      description:
        'Update validated metadata fields on the current page, post, or product. For products, description_json must be a valid NextBlock editor document JSON object. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateCurrentCmsFields(input, context),
      inputSchema: updateCurrentCmsFieldsInputSchema,
      strict: true,
    }),
    update_cms_item_field: tool({
      description:
        'Update one field on a page, post, or product, resolving by current edit context, id, slug, or exact title. Use this for requests like changing price, stock, title, slug, status, sale_price, or meta fields. Interpret public as published for pages/posts and active for products. Scheduled sale date ranges are not supported and will be refused without mutation. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateCmsItemField(input, context),
      inputSchema: updateCmsItemFieldInputSchema,
      strict: true,
    }),
    update_navigation_bar: tool({
      description:
        'Update the public header navigation bar for a locale. Use mode "append" when adding links while preserving existing navigation. Use mode "update" when renaming or changing an existing single link. Use mode "replace" only when the user asks to rebuild the complete header and you provide the full menu; destructive partial replacements are refused. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateNavigationBar(input, context),
      inputSchema: updateNavigationBarInputSchema,
      strict: true,
    }),
    update_section_column_block: tool({
      description:
        'Update the content of one existing nested block inside a section block. The parent section must belong to the item being edited — the open CMS editor, or the item named by `cmsTarget` (contentType plus slug, entityId, or title) when no editor is open, as with MCP clients. This tool must not change the nested block type. To add a new nested block, update the parent section with update_content_block and preserve existing column_blocks. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateSectionColumnBlock(input, context),
      inputSchema: updateSectionColumnBlockInputSchema,
      strict: true,
    }),
    execute_cms_action_plan: tool({
      description:
        'Execute multiple CMS mutations as one confirmed plan. Use this whenever the user asks for more than one change in the same prompt, such as creating a page and adding a navigation link. First returns one combined confirmation preview and Confirm button; after confirmation, runs each action in order and stops on the first failure.',
      execute: (input) => executeCmsActionPlan(input, context),
      inputSchema: executeCmsActionPlanInputSchema,
      strict: true,
    }),
  };
}
