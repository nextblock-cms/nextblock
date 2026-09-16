import { tool } from 'ai';
import { parseSiteSocialImageSetting, SITE_SOCIAL_IMAGE_SETTING_KEY } from '@nextblock-cms/utils/seo';
import { findOriginalUploadVariant, pickOriginalUploadObjectKey } from '@nextblock-cms/utils/media-variants';

import { requireActorRole } from './ai-global-agent-theming-tools';
import {
  CORTEX_AI_BUILD_SESSION_SETTING_KEY,
  CORTEX_AI_SITE_BRIEF_SETTING_KEY,
  cortexBuildSessionSchema,
  cortexSiteBriefInputSchema,
  cortexSiteBriefSchema,
  isCortexBuildSessionUsable,
  safeParseCortexSiteBrief,
  type CortexBuildSession,
  type CortexSiteBrief,
} from './site-brief';
import { z } from './zod-config';

/**
 * Site-level tools: the ones a "build me a website" request needs and no
 * page-level tool provides.
 *
 *   get_site_overview     one read that grounds a whole-site plan
 *   update_site_identity  title / description / keywords / copyright / logo pin
 *   save_site_brief       persist what the client wants, for this and later chats
 *   reset_site_content    remove the seeded NextBlock demo content (or everything)
 *   start_site_build      ONE confirmation that approves a plan and opens a time-boxed
 *                         build session in which the remaining steps run unattended
 *   finish_site_build     close the session and mark the brief built
 *
 * Every executor runs with the service-role client, so role checks happen here
 * (`requireActorRole`), never in RLS.
 */

type SiteToolContext = {
  actorFromOrphanedToken?: boolean;
  actorUserId?: string | null;
  latestUserMessage?: string | null;
  revalidatePath?: (path: string, type?: 'layout' | 'page') => void;
  skipConfirmation?: boolean;
  supabase?: { from: (table: string) => any };
};

type SupabaseLike = { from: (table: string) => any };

/* -------------------------------------------------------------------------- */
/* Seed signatures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a fresh install ships (libs/db/src/supabase/migrations/02004_baseline_seed.sql
 * plus the FR posts in 02009). Seeded rows carry no marker column, but their
 * translation groups are fixed UUIDs — the same handles the data-fix migrations
 * key on — so they are the most reliable way to tell "NextBlock demo content"
 * from something the operator wrote.
 */
export const NEXTBLOCK_SEED_TRANSLATION_GROUP_IDS: ReadonlySet<string> = new Set([
  // pages: home, articles, contact, privacy policy, terms of service
  '0098e4f0-e5f3-4e28-acfc-bb9fdb3a4a6b',
  '50adeea5-5040-4ae7-bacd-992647920982',
  'e3b28669-7e38-47bd-9189-7db2353b52dc',
  '8cd91839-518d-4b57-87db-441e59a71a95',
  'b5eb82c7-95d6-4308-82d8-3ac2816f5d46',
  // posts: architecture, setup, commerce, cortex guide, updating, MCP guide (+ FR)
  'de8b8593-1ef6-4e66-8d1f-8b3e7ffb811d',
  '461cde55-74cb-4112-8c3d-a25882eeedce',
  '23773a34-e54b-40c6-89b5-b09ead17ae60',
  '669489e7-5900-496e-8b73-2aba7514a71b',
  'c0d3f1a2-8b47-4e19-9a52-7f6b1d4e8c30',
  'a7c4e2d1-3b58-4f96-9e0a-6d2c8b1f5a73',
  'dbe2a06f-1a9d-48ba-bc35-0f6ef4869156',
]);

/** Bundled demo images (served from /public, no storage object behind them). */
export const NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'images/NBcover.webp',
  'images/commerce-plan.webp',
  'images/commerce-wide.webp',
  'images/cortex-ai.webp',
  'images/cortex_post.webp',
  'images/extensibility.webp',
  'images/included.webp',
  'images/nextblock-logo-button-tiny.png',
  'images/nextblock-logo-small.webp',
  'images/programmer-upscaled.webp',
  'images/update_nextblock.webp',
]);

const NEXTBLOCK_SEED_SITE_TITLE = 'NextBlock™ CMS';
const NEXTBLOCK_SEED_COPYRIGHT_MARKER = 'nextblock cms';
const HOME_SLUG = 'home';

const IDENTITY_SETTING_KEYS = [
  'active_logo_id',
  'footer_copyright',
  'footer_show_attribution',
  'site_description',
  'site_keywords',
  'site_title',
  SITE_SOCIAL_IMAGE_SETTING_KEY,
] as const;

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function requireSupabase(context?: SiteToolContext): SupabaseLike {
  if (!context?.supabase) {
    throw new Error('No database connection is available for this tool.');
  }

  return context.supabase;
}

function serializeError(error: unknown): string {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    return String((error as Record<string, unknown>)['message']);
  }
  return String(error);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashPayload(value: unknown) {
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

/** Same two-step protocol as every other mutating Cortex tool. */
function getConfirmationPreview(params: {
  action: string;
  context?: SiteToolContext;
  payload: unknown;
  preview: Record<string, unknown>;
  subject: string;
}) {
  if (params.context?.skipConfirmation) {
    return null;
  }

  const confirmationPhrase = `${normalizeConfirmationToken(
    `CONFIRM ${params.action} ${params.subject}`
  )} #${hashPayload(params.payload)}`;
  const latestUserMessage = normalizeConfirmationToken(params.context?.latestUserMessage || '');

  if (latestUserMessage.includes(normalizeConfirmationToken(confirmationPhrase))) {
    return null;
  }

  return {
    confirmationPhrase,
    mutationExecuted: false,
    preview: params.preview,
    requiresConfirmation: true,
    success: true,
  };
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function chunk<T>(items: T[], size = 200): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function revalidateSite(context: SiteToolContext | undefined, paths: string[] = []) {
  let revalidate = context?.revalidatePath;

  if (!revalidate) {
    try {
      // Lazily required so the module stays import-safe outside a request scope.
      revalidate = (require('next/cache') as typeof import('next/cache')).revalidatePath;
    } catch {
      return;
    }
  }

  try {
    revalidate('/', 'layout');
    for (const path of paths) {
      revalidate(path);
    }
  } catch {
    // Revalidation is best-effort; the rows are already written.
  }
}

async function readSettings(supabase: SupabaseLike, keys: readonly string[]) {
  const { data, error } = await supabase.from('site_settings').select('key, value').in('key', [...keys]);

  if (error) {
    throw new Error(`Could not read the site settings: ${serializeError(error)}`);
  }

  return new Map<string, unknown>((Array.isArray(data) ? data : []).map((row: any) => [row.key, row.value]));
}

async function upsertSetting(supabase: SupabaseLike, key: string, value: unknown) {
  const { error } = await supabase.from('site_settings').upsert({ key, value });

  if (error) {
    throw new Error(`Could not save the "${key}" setting: ${serializeError(error)}`);
  }
}

async function deleteByIds(supabase: SupabaseLike, table: string, column: string, ids: Array<string | number>) {
  let deleted = 0;

  for (const batch of chunk(ids)) {
    const { error } = await supabase.from(table).delete().in(column, batch);

    if (error) {
      throw new Error(`Could not delete from ${table}: ${serializeError(error)}`);
    }

    deleted += batch.length;
  }

  return deleted;
}

function isSeededCopyright(value: unknown) {
  if (!value || typeof value !== 'object') return false;

  return Object.values(value as Record<string, unknown>).some(
    (entry) => typeof entry === 'string' && entry.toLowerCase().includes(NEXTBLOCK_SEED_COPYRIGHT_MARKER)
  );
}

/* -------------------------------------------------------------------------- */
/* Site brief                                                                  */
/* -------------------------------------------------------------------------- */

export async function readCortexSiteBrief(supabase: SupabaseLike): Promise<CortexSiteBrief | null> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', CORTEX_AI_SITE_BRIEF_SETTING_KEY)
    .maybeSingle();

  if (error) {
    return null;
  }

  return safeParseCortexSiteBrief(data?.value);
}

export const saveSiteBriefInputSchema = z.strictObject({
  brief: cortexSiteBriefInputSchema.describe(
    'The fields you learned. With mode "merge" (default) they are layered over the saved brief, so you can save after every answer.'
  ),
  mode: z.enum(['merge', 'replace']).default('merge'),
});

export type SaveSiteBriefInput = z.input<typeof saveSiteBriefInputSchema>;

export async function executeSaveSiteBrief(input: SaveSiteBriefInput, context?: SiteToolContext) {
  const parsed = saveSiteBriefInputSchema.parse(input);
  const supabase = requireSupabase(context);
  const existing = parsed.mode === 'merge' ? await readCortexSiteBrief(supabase) : null;
  // Only the keys the caller actually sent take part in the merge: the partial
  // input schema still fills defaults (languages, site_type, ...) for omitted keys,
  // and those defaults must not overwrite what an earlier answer recorded.
  const providedKeys = new Set(Object.keys((input as { brief?: Record<string, unknown> }).brief ?? {}));
  const patch = Object.fromEntries(
    Object.entries(parsed.brief).filter(([key]) => providedKeys.has(key))
  );
  const merged = cortexSiteBriefSchema.parse({
    ...(existing ?? {}),
    ...patch,
    updated_at: new Date().toISOString(),
  });

  await upsertSetting(supabase, CORTEX_AI_SITE_BRIEF_SETTING_KEY, merged);

  return {
    brief: merged,
    created: !existing,
    mutationExecuted: true,
    success: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Build session                                                               */
/* -------------------------------------------------------------------------- */

export async function readCortexBuildSession(supabase: SupabaseLike): Promise<CortexBuildSession | null> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', CORTEX_AI_BUILD_SESSION_SETTING_KEY)
    .maybeSingle();

  if (error) {
    return null;
  }

  const parsed = cortexBuildSessionSchema.safeParse(data?.value);
  return parsed.success ? parsed.data : null;
}

/** The session the chat route may honour for this actor right now, or null. */
export async function resolveCortexBuildSession(
  supabase: SupabaseLike,
  actorUserId: string | null | undefined
): Promise<CortexBuildSession | null> {
  const session = await readCortexBuildSession(supabase);

  return isCortexBuildSessionUsable(session, { actorUserId }) ? session : null;
}

async function clearCortexBuildSession(supabase: SupabaseLike) {
  const { error } = await supabase
    .from('site_settings')
    .delete()
    .eq('key', CORTEX_AI_BUILD_SESSION_SETTING_KEY);

  if (error) {
    throw new Error(`Could not close the build session: ${serializeError(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* get_site_overview                                                           */
/* -------------------------------------------------------------------------- */

export const getSiteOverviewInputSchema = z.strictObject({
  includeMedia: z
    .boolean()
    .default(false)
    .describe('Also list the most recent media library entries (id, file name, alt text).'),
  includeNavigation: z.boolean().default(true),
  limit: z
    .number()
    .int()
    .min(10)
    .max(300)
    .default(120)
    .describe('Maximum pages, posts, and products to list.'),
});

export type GetSiteOverviewInput = z.input<typeof getSiteOverviewInputSchema>;

type NavigationNode = {
  children: NavigationNode[];
  id: number;
  label: string;
  url: string;
};

function buildNavigationTrees(rows: any[], languagesById: Map<number, string>) {
  const result: Record<'footer' | 'header', Record<string, NavigationNode[]>> = { footer: {}, header: {} };
  const nodesById = new Map<number, NavigationNode & { languageCode: string; menu: 'footer' | 'header'; parentId: number | null; order: number }>();

  for (const row of rows) {
    const menu = String(row.menu_key).toUpperCase() === 'FOOTER' ? 'footer' : 'header';
    nodesById.set(Number(row.id), {
      children: [],
      id: Number(row.id),
      label: String(row.label ?? ''),
      languageCode: languagesById.get(Number(row.language_id)) ?? String(row.language_id),
      menu,
      order: Number(row.order ?? 0),
      parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
      url: String(row.url ?? ''),
    });
  }

  const sorted = [...nodesById.values()].sort((a, b) => a.order - b.order);

  for (const node of sorted) {
    const parent = node.parentId === null ? null : nodesById.get(node.parentId);

    if (parent) {
      parent.children.push({ children: node.children, id: node.id, label: node.label, url: node.url });
      continue;
    }

    const bucket = (result[node.menu][node.languageCode] ??= []);
    bucket.push({ children: node.children, id: node.id, label: node.label, url: node.url });
  }

  return result;
}

export async function executeGetSiteOverview(input: GetSiteOverviewInput, context?: SiteToolContext) {
  const parsed = getSiteOverviewInputSchema.parse(input);
  const supabase = requireSupabase(context);

  const [languagesResult, settings, pagesResult, postsResult, themesResult, customBlocksResult, draftsResult] =
    await Promise.all([
      supabase.from('languages').select('id, code, name, is_default, is_active').order('id'),
      readSettings(supabase, [...IDENTITY_SETTING_KEYS, CORTEX_AI_SITE_BRIEF_SETTING_KEY, CORTEX_AI_BUILD_SESSION_SETTING_KEY]),
      // `count: 'exact'` so the totals are the site's, not the capped list's.
      supabase
        .from('pages')
        .select('id, slug, title, status, language_id, translation_group_id, author_id, updated_at', { count: 'exact' })
        .order('id')
        .limit(parsed.limit),
      supabase
        .from('posts')
        .select('id, slug, title, status, language_id, translation_group_id, author_id, published_at', { count: 'exact' })
        .order('id')
        .limit(parsed.limit),
      supabase.from('site_themes').select('slug, name, is_default, is_active, color_scheme').order('sort_order'),
      supabase.from('custom_block_definitions').select('slug, name, fields').order('name'),
      supabase.from('content_drafts').select('parent_type, parent_id, updated_at'),
    ]);

  for (const [label, result] of [
    ['languages', languagesResult],
    ['pages', pagesResult],
    ['posts', postsResult],
    ['themes', themesResult],
    ['custom blocks', customBlocksResult],
    ['drafts', draftsResult],
  ] as const) {
    if (result?.error) {
      throw new Error(`Could not read the ${label}: ${serializeError(result.error)}`);
    }
  }

  const languages = (languagesResult.data ?? []) as any[];
  const languagesById = new Map<number, string>(languages.map((row) => [Number(row.id), String(row.code)]));
  const defaultLanguage = languages.find((row) => row.is_default) ?? languages[0] ?? null;

  // Products only exist with the ecommerce package; a missing table is not an error here.
  let products: any[] = [];
  try {
    const { data } = await supabase
      .from('products')
      .select('id, slug, title, status, language_id')
      .order('created_at', { ascending: false })
      .limit(parsed.limit);
    products = Array.isArray(data) ? data : [];
  } catch {
    products = [];
  }

  // Block counts per parent: cheap columns only, capped so a very large site cannot
  // turn an overview into a full table scan.
  const blockCounts = new Map<string, number>();
  {
    const { data } = await supabase.from('blocks').select('page_id, post_id').limit(5000);
    for (const row of (Array.isArray(data) ? data : []) as any[]) {
      const key = row.page_id ? `page:${row.page_id}` : row.post_id ? `post:${row.post_id}` : null;
      if (key) blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1);
    }
  }

  let navigation: ReturnType<typeof buildNavigationTrees> | null = null;
  if (parsed.includeNavigation) {
    const { data, error } = await supabase
      .from('navigation_items')
      .select('id, label, url, menu_key, language_id, parent_id, order, page_id')
      .order('order');
    if (error) {
      throw new Error(`Could not read the navigation: ${serializeError(error)}`);
    }
    navigation = buildNavigationTrees(Array.isArray(data) ? data : [], languagesById);
  }

  // Media: count + which of it is the bundled demo imagery.
  const { data: mediaRows } = await supabase
    .from('media')
    .select('id, object_key, file_name, description, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  const media = (Array.isArray(mediaRows) ? mediaRows : []) as any[];
  const seededMediaCount = media.filter((row) => NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS.has(String(row.object_key))).length;

  // Active logo (pinned id, else newest).
  const { data: logoRows } = await supabase.from('logos').select('id, name, media_id, created_at').order('created_at', { ascending: false });
  const logos = (Array.isArray(logoRows) ? logoRows : []) as any[];
  const pinnedLogoId = typeof settings.get('active_logo_id') === 'string' ? (settings.get('active_logo_id') as string) : null;
  const activeLogo = (pinnedLogoId ? logos.find((row) => row.id === pinnedLogoId) : null) ?? logos[0] ?? null;
  const activeLogoMedia = activeLogo ? media.find((row) => row.id === activeLogo.media_id) ?? null : null;
  const activeLogoObjectKey = activeLogoMedia ? String(activeLogoMedia.object_key) : null;

  // The site-wide share preview (Branding screen, or update_site_identity social_image).
  const storedSocialImage = parseSiteSocialImageSetting(settings.get(SITE_SOCIAL_IMAGE_SETTING_KEY));
  const socialImage = storedSocialImage
    ? { mediaId: storedSocialImage.media_id, objectKey: storedSocialImage.object_key, url: storedSocialImage.url }
    : null;

  const pages = ((pagesResult.data ?? []) as any[]).map((row) => ({
    blockCount: blockCounts.get(`page:${row.id}`) ?? 0,
    id: Number(row.id),
    isHome: row.slug === HOME_SLUG && (!defaultLanguage || Number(row.language_id) === Number(defaultLanguage.id)),
    isSeeded: NEXTBLOCK_SEED_TRANSLATION_GROUP_IDS.has(String(row.translation_group_id)),
    languageCode: languagesById.get(Number(row.language_id)) ?? String(row.language_id),
    slug: String(row.slug),
    status: String(row.status),
    title: String(row.title ?? ''),
    translationGroupId: row.translation_group_id ? String(row.translation_group_id) : null,
  }));
  const posts = ((postsResult.data ?? []) as any[]).map((row) => ({
    blockCount: blockCounts.get(`post:${row.id}`) ?? 0,
    id: Number(row.id),
    isSeeded: NEXTBLOCK_SEED_TRANSLATION_GROUP_IDS.has(String(row.translation_group_id)),
    languageCode: languagesById.get(Number(row.language_id)) ?? String(row.language_id),
    publishedAt: row.published_at ?? null,
    slug: String(row.slug),
    status: String(row.status),
    title: String(row.title ?? ''),
    translationGroupId: row.translation_group_id ? String(row.translation_group_id) : null,
  }));

  const siteTitle = typeof settings.get('site_title') === 'string' ? (settings.get('site_title') as string) : '';
  const footerCopyright = settings.get('footer_copyright');
  const seeded = {
    copyright: isSeededCopyright(footerCopyright),
    logo: Boolean(activeLogoObjectKey && NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS.has(activeLogoObjectKey)),
    media: seededMediaCount,
    pages: pages.filter((page) => page.isSeeded).length,
    posts: posts.filter((post) => post.isSeeded).length,
    siteTitle: siteTitle.trim() === NEXTBLOCK_SEED_SITE_TITLE,
  };
  const seededAnyPresent =
    seeded.copyright || seeded.logo || seeded.media > 0 || seeded.pages > 0 || seeded.posts > 0 || seeded.siteTitle;

  const brief = safeParseCortexSiteBrief(settings.get(CORTEX_AI_SITE_BRIEF_SETTING_KEY));
  const buildSessionParsed = cortexBuildSessionSchema.safeParse(settings.get(CORTEX_AI_BUILD_SESSION_SETTING_KEY));
  const buildSession = buildSessionParsed.success ? buildSessionParsed.data : null;
  const homePage = pages.find((page) => page.isHome) ?? null;

  const nextSteps: string[] = [];
  if (!homePage) {
    nextSteps.push(
      `There is no "${HOME_SLUG}" page in the default language, so "/" returns 404. Create one with create_cms_page (slug "${HOME_SLUG}", status "published").`
    );
  } else if (homePage.blockCount === 0) {
    nextSteps.push(`The home page exists but has no blocks. Fill it with rewrite_page_draft then publish_content_draft.`);
  }
  if (seededAnyPresent) {
    nextSteps.push(
      `NextBlock demo content is still present (${seeded.pages} seeded pages, ${seeded.posts} seeded posts, ${seeded.media} bundled images${
        seeded.logo ? ', the NextBlock logo' : ''
      }${seeded.siteTitle ? ', the default site title' : ''}${seeded.copyright ? ', the default copyright' : ''}). Remove it with reset_site_content, or pass reset to start_site_build.`
    );
  }
  if (!brief) {
    nextSteps.push('No site brief is saved yet. Interview the client and record the answers with save_site_brief.');
  }

  return {
    brief,
    buildSession: buildSession ? { expiresAt: buildSession.expiresAt, id: buildSession.id, summary: buildSession.summary } : null,
    counts: {
      customBlocks: ((customBlocksResult.data ?? []) as any[]).length,
      drafts: ((draftsResult.data ?? []) as any[]).length,
      media: media.length,
      pages: typeof pagesResult.count === 'number' ? pagesResult.count : pages.length,
      posts: typeof postsResult.count === 'number' ? postsResult.count : posts.length,
      products: products.length,
    },
    customBlocks: ((customBlocksResult.data ?? []) as any[]).map((row) => ({
      fieldCount: Array.isArray(row.fields) ? row.fields.length : 0,
      fields: Array.isArray(row.fields)
        ? row.fields.map((field: any) => ({ key: field?.key, required: field?.required === true, type: field?.type }))
        : [],
      name: String(row.name ?? ''),
      slug: String(row.slug),
    })),
    drafts: ((draftsResult.data ?? []) as any[]).map((row) => ({
      parentId: Number(row.parent_id),
      parentType: String(row.parent_type),
    })),
    homePage,
    identity: {
      activeLogo: activeLogo
        ? {
            id: String(activeLogo.id),
            isSeeded: seeded.logo,
            name: String(activeLogo.name ?? ''),
            objectKey: activeLogoObjectKey,
          }
        : null,
      footerCopyright: footerCopyright ?? null,
      footerShowAttribution: settings.get('footer_show_attribution') !== false,
      siteDescription: typeof settings.get('site_description') === 'string' ? settings.get('site_description') : '',
      siteKeywords: typeof settings.get('site_keywords') === 'string' ? settings.get('site_keywords') : '',
      siteTitle,
      socialImage,
    },
    languages: languages.map((row) => ({
      code: String(row.code),
      id: Number(row.id),
      isActive: row.is_active !== false,
      isDefault: row.is_default === true,
      name: String(row.name ?? ''),
    })),
    media: {
      count: media.length,
      sample: parsed.includeMedia
        ? media.slice(0, 40).map((row) => ({
            altText: row.description ?? null,
            fileName: row.file_name ?? null,
            id: String(row.id),
            isSeeded: NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS.has(String(row.object_key)),
          }))
        : undefined,
      seededCount: seededMediaCount,
    },
    navigation,
    nextSteps,
    pages,
    posts,
    products: products.map((row) => ({
      id: String(row.id),
      languageCode: languagesById.get(Number(row.language_id)) ?? String(row.language_id),
      slug: String(row.slug),
      status: String(row.status),
      title: String(row.title ?? ''),
    })),
    seeded: { ...seeded, anyPresent: seededAnyPresent },
    success: true,
    themes: ((themesResult.data ?? []) as any[]).map((row) => ({
      colorScheme: String(row.color_scheme ?? 'light'),
      isActive: row.is_active !== false,
      isDefault: row.is_default === true,
      name: String(row.name ?? ''),
      slug: String(row.slug),
    })),
  };
}

export type CortexSiteOverview = Awaited<ReturnType<typeof executeGetSiteOverview>>;

const OVERVIEW_PROMPT_PAGE_LIMIT = 30;

/**
 * Compact, prompt-ready rendering of a site overview (≈ 1200 characters at most on a
 * typical install). The chat route fetches the overview itself when the site
 * builder opens, so the model's first turn can be the plan instead of a tool call
 * followed by a questionnaire. Facts only, no JSON.
 */
export function formatCortexSiteOverviewForPrompt(overview: CortexSiteOverview): string {
  const { counts, seeded } = overview;
  const lines: string[] = [];

  lines.push(
    `Counts: ${counts.pages} pages, ${counts.posts} posts, ${counts.products} products, ${counts.media} media, ${counts.customBlocks} custom blocks, ${counts.drafts} drafts.`
  );

  const activeLanguages = overview.languages.filter((language) => language.isActive);
  const languageList = (activeLanguages.length > 0 ? activeLanguages : overview.languages)
    .map((language) => `${language.code}${language.isDefault ? ' (default)' : ''}`)
    .join(', ');
  lines.push(`Languages: ${languageList || 'none'}.`);

  if (seeded.anyPresent) {
    const parts = [
      seeded.pages > 0 ? `${seeded.pages} demo pages` : null,
      seeded.posts > 0 ? `${seeded.posts} demo posts` : null,
      seeded.media > 0 ? `${seeded.media} bundled images` : null,
      seeded.logo ? 'the NextBlock logo' : null,
      seeded.siteTitle ? 'the default site title' : null,
      seeded.copyright ? 'the default copyright' : null,
    ].filter((part): part is string => Boolean(part));
    lines.push(`NextBlock demo content: present (${parts.join(', ')}).`);
  } else {
    lines.push('NextBlock demo content: none detected.');
  }

  const home = overview.homePage;
  lines.push(
    home
      ? `Home page: "${home.title}" (/${home.slug}) ${home.status}, ${home.blockCount} blocks${home.isSeeded ? ', seeded demo content' : ''}.`
      : 'Home page: missing in the default language ("/" returns 404).'
  );

  const identity = overview.identity;
  const logo = identity.activeLogo
    ? `logo "${identity.activeLogo.name || identity.activeLogo.id}"${identity.activeLogo.isSeeded ? ' (NextBlock demo logo)' : ''}`
    : 'no logo';
  lines.push(`Site title: ${identity.siteTitle ? `"${identity.siteTitle}"` : 'not set'}; ${logo}.`);
  lines.push(
    identity.socialImage
      ? 'Social preview image: set.'
      : 'Social preview image: not set (link previews show the NextBlock banner; set one with update_site_identity social_image).'
  );

  if (overview.themes.length > 0) {
    lines.push(
      `Themes: ${overview.themes
        .map(
          (theme) =>
            `${theme.name || theme.slug} (${theme.colorScheme}${theme.isDefault ? ', default' : ''}${
              theme.isActive ? '' : ', inactive'
            })`
        )
        .join('; ')}.`
    );
  }

  lines.push(overview.brief ? `Site brief: saved (status ${overview.brief.status}).` : 'Site brief: none saved.');
  lines.push(
    overview.buildSession
      ? `Build session: active until ${overview.buildSession.expiresAt}.`
      : 'Build session: none.'
  );

  if (overview.pages.length > 0) {
    const shown = overview.pages.slice(0, OVERVIEW_PROMPT_PAGE_LIMIT);
    // Against the site total, not the capped list, so "+N more" is honest past the limit.
    const rest = Math.max(counts.pages, overview.pages.length) - shown.length;
    lines.push(
      `Pages: ${shown.map((page) => `${page.title || page.slug} (/${page.slug}) [${page.languageCode}]`).join(', ')}${
        rest > 0 ? `, +${rest} more` : ''
      }.`
    );
  } else {
    lines.push('Pages: none.');
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* update_site_identity                                                        */
/* -------------------------------------------------------------------------- */

export const updateSiteIdentityInputSchema = z
  .strictObject({
    active_logo_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe('Pin a logos.id as the active logo, or null to fall back to the newest logo.'),
    footer_copyright: z
      .record(z.string().trim().min(2).max(12), z.string().trim().min(1).max(500))
      .optional()
      .describe('Copyright line per locale code; "{year}" is replaced with the current year. Example: { "en": "© {year} Acme Bakery", "fr": "© {year} Boulangerie Acme" }.'),
    footer_show_attribution: z
      .boolean()
      .optional()
      .describe('Whether the "Published with NextBlock" credit shows in the footer. Set false when the client wants no NextBlock mention.'),
    site_description: z.string().trim().max(500).optional().describe('Default meta description and header tagline.'),
    site_keywords: z.string().trim().max(500).optional().describe('Comma-separated SEO keywords.'),
    site_title: z.string().trim().min(1).max(160).optional().describe('The brand name shown in the header and <title>.'),
    social_image: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .nullable()
      .optional()
      .describe(
        'The site-wide social preview image (Open Graph / Twitter card) for every page, post or product without a feature image of its own — the home page above all, which must NOT get a feature image (on a page that renders a full-width title banner above the hero). A media library id (from list_media or upload_media) or an https image URL, hotlinked as-is (a search_stock_photos `url` works). Use a wide landscape image, ideally 1200×630. Null clears it and the NextBlock banner is used.'
      ),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Provide at least one identity field to update.',
  });

export type UpdateSiteIdentityInput = z.input<typeof updateSiteIdentityInputSchema>;

export async function executeUpdateSiteIdentity(input: UpdateSiteIdentityInput, context?: SiteToolContext) {
  const parsed = updateSiteIdentityInputSchema.parse(input);
  await requireActorRole(context, ['ADMIN', 'WRITER'], 'Updating the site identity');
  const supabase = requireSupabase(context);
  const updates = Object.entries(parsed).filter(([, value]) => value !== undefined) as Array<[string, unknown]>;

  const confirmation = getConfirmationPreview({
    action: 'UPDATE SITE IDENTITY',
    context,
    payload: { input: parsed, tool: 'update_site_identity' },
    preview: {
      changes: Object.fromEntries(updates),
      summary: `Update ${updates.map(([key]) => key).join(', ')} for the whole site.`,
    },
    subject: updates.map(([key]) => key).join(' '),
  });

  if (confirmation) {
    return confirmation;
  }

  // Resolve every value BEFORE the first write. `social_image` is the only argument
  // that can still be rejected at execution time (an id no media row has), and the
  // writes below are separate upserts with no transaction around them — resolving
  // inside the loop would leave the earlier settings committed when it throws.
  const resolved: Array<[string, unknown]> = [];
  for (const [key, value] of updates) {
    resolved.push(
      key === 'social_image'
        ? [SITE_SOCIAL_IMAGE_SETTING_KEY, await resolveSocialImageSetting(supabase, value as string | null)]
        : [key, value]
    );
  }

  for (const [key, value] of resolved) {
    await upsertSetting(supabase, key, value);
  }

  revalidateSite(context, ['/cms/settings/logos', '/cms/settings/copyright']);

  return {
    mutationExecuted: true,
    success: true,
    updatedKeys: resolved.map(([key]) => key),
  };
}

const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn the `social_image` argument into the stored `site_social_image` value (the
 * shape `parseSiteSocialImageSetting` reads): a media library row, whose object key
 * and size are copied so the public site never joins `media` for metadata, or a
 * hotlinked https URL. Nothing is imported — stock photos stay hotlinked here exactly
 * as they do in image blocks.
 */
async function resolveSocialImageSetting(supabase: SupabaseLike, value: string | null) {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return { alt: null, height: null, media_id: null, object_key: null, url: trimmed, width: null };
  }

  if (!MEDIA_ID_RE.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a usable social image — provide an https:// image URL or a media library id.`);
  }

  const { data, error } = await supabase
    .from('media')
    .select('id, object_key, file_path, width, height, description, variants')
    .eq('id', trimmed)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not read media ${trimmed}: ${serializeError(error)}`);
  }

  if (!data) {
    throw new Error(`No media library item has the id ${trimmed}. Call list_media to find one, or upload_media to import an image first.`);
  }

  // The UNTOUCHED upload, not the row's AVIF derivative: this value is only ever
  // fetched by social crawlers, which do not decode AVIF. Same choice the Branding
  // screen makes, so both writers store the same shape.
  const original = findOriginalUploadVariant(data);
  const objectKey = pickOriginalUploadObjectKey(data);

  if (!objectKey) {
    throw new Error(`Media ${trimmed} has no usable file to serve as the social image.`);
  }

  return {
    alt: typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null,
    height: original?.height ?? (typeof data.height === 'number' ? data.height : null),
    media_id: String(data.id),
    object_key: objectKey,
    url: null,
    width: original?.width ?? (typeof data.width === 'number' ? data.width : null),
  };
}

/* -------------------------------------------------------------------------- */
/* reset_site_content                                                          */
/* -------------------------------------------------------------------------- */

const resetScopeSchema = z
  .strictObject({
    customBlocks: z.boolean().default(false).describe('Delete every custom block definition.'),
    identity: z
      .boolean()
      .default(true)
      .describe('Clear the NextBlock site title, description, keywords, copyright line, social preview image, and the seeded logo.'),
    navigation: z.boolean().default(true).describe('Delete every header and footer navigation item.'),
    pages: z.boolean().default(true).describe('Delete pages (all languages) except keepPageSlugs.'),
    posts: z.boolean().default(true).describe('Delete every blog post.'),
    products: z.boolean().default(false).describe('Delete every product, with its variants, images, and drafts.'),
    seededMedia: z.boolean().default(true).describe('Delete the bundled NextBlock demo images from the media library.'),
  })
  .partial();

export const resetSiteContentInputSchema = z.strictObject({
  clearKeptPageBlocks: z
    .boolean()
    .default(true)
    .describe('Empty the blocks of the kept pages (usually "home") so they can be rebuilt. Set false to leave their content untouched.'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Report what would be removed without changing anything. No confirmation needed.'),
  keepLanguages: z
    .array(z.string().trim().min(2).max(10))
    .max(10)
    .optional()
    .describe('Locale codes the site should keep. Other languages are deactivated (never deleted) and their pages and posts removed. Omit to keep every language as it is.'),
  keepPageSlugs: z
    .array(z.string().trim().min(1).max(300))
    .max(50)
    .default([HOME_SLUG])
    .describe('Pages to keep, by slug in any language; every translation of a kept page is kept. Defaults to ["home"] because "/" must always resolve.'),
  onlySeeded: z
    .boolean()
    .default(false)
    .describe('Remove only rows that match the NextBlock demo seed (fixed translation groups, bundled images). Use when the site already has real content next to the demo content.'),
  scope: resetScopeSchema.default({}),
});

export type ResetSiteContentInput = z.input<typeof resetSiteContentInputSchema>;

type ResetPlan = {
  blocksToClearPageIds: number[];
  customBlockSlugs: string[];
  draftsToDelete: Array<{ parentId: number; parentType: string }>;
  identityKeys: string[];
  languagesToDeactivate: Array<{ code: string; id: number }>;
  logosToDelete: string[];
  mediaToDelete: string[];
  navigationToDelete: number[];
  newDefaultLanguage: { code: string; id: number } | null;
  pagesToDelete: Array<{ id: number; slug: string; languageCode: string }>;
  pagesToKeep: Array<{ id: number; slug: string; languageCode: string }>;
  postsToDelete: Array<{ id: number; slug: string; languageCode: string }>;
  productsToDelete: string[];
};

async function planSiteReset(
  parsed: z.infer<typeof resetSiteContentInputSchema>,
  supabase: SupabaseLike
): Promise<ResetPlan> {
  const scope = {
    customBlocks: parsed.scope.customBlocks ?? false,
    identity: parsed.scope.identity ?? true,
    navigation: parsed.scope.navigation ?? true,
    pages: parsed.scope.pages ?? true,
    posts: parsed.scope.posts ?? true,
    products: parsed.scope.products ?? false,
    seededMedia: parsed.scope.seededMedia ?? true,
  };

  const { data: languageRows, error: languageError } = await supabase
    .from('languages')
    .select('id, code, name, is_default, is_active');
  if (languageError) {
    throw new Error(`Could not read the languages: ${serializeError(languageError)}`);
  }
  const languages = (Array.isArray(languageRows) ? languageRows : []) as any[];
  const languagesById = new Map<number, string>(languages.map((row) => [Number(row.id), String(row.code).toLowerCase()]));

  const keepCodes = parsed.keepLanguages
    ? new Set(parsed.keepLanguages.map((code) => code.toLowerCase()))
    : null;
  if (keepCodes) {
    const known = new Set(languagesById.values());
    const unknown = [...keepCodes].filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new Error(`Unknown language code(s) in keepLanguages: ${unknown.join(', ')}. Existing: ${[...known].join(', ')}.`);
    }
  }
  const keptLanguageIds = new Set(
    languages
      .filter((row) => !keepCodes || keepCodes.has(String(row.code).toLowerCase()))
      .map((row) => Number(row.id))
  );
  const languagesToDeactivate = languages
    .filter((row) => keepCodes && !keepCodes.has(String(row.code).toLowerCase()) && row.is_active !== false)
    .map((row) => ({ code: String(row.code), id: Number(row.id) }));
  const currentDefault = languages.find((row) => row.is_default === true);
  const newDefaultLanguage =
    keepCodes && currentDefault && !keepCodes.has(String(currentDefault.code).toLowerCase())
      ? (() => {
          const candidate = languages.find((row) => keepCodes.has(String(row.code).toLowerCase()));
          return candidate ? { code: String(candidate.code), id: Number(candidate.id) } : null;
        })()
      : null;

  const isSeededRow = (row: any) => NEXTBLOCK_SEED_TRANSLATION_GROUP_IDS.has(String(row.translation_group_id));

  const { data: pageRows, error: pageError } = await supabase
    .from('pages')
    .select('id, slug, language_id, translation_group_id, author_id');
  if (pageError) {
    throw new Error(`Could not read the pages: ${serializeError(pageError)}`);
  }
  const pages = (Array.isArray(pageRows) ? pageRows : []) as any[];
  const keepSlugs = new Set(parsed.keepPageSlugs.map((slug) => slug.toLowerCase()));
  const keptGroups = new Set(
    pages
      .filter((row) => keepSlugs.has(String(row.slug).toLowerCase()))
      .map((row) => String(row.translation_group_id))
  );
  const describePage = (row: any) => ({
    id: Number(row.id),
    languageCode: languagesById.get(Number(row.language_id)) ?? String(row.language_id),
    slug: String(row.slug),
  });
  const pagesToDelete: ResetPlan['pagesToDelete'] = [];
  const pagesToKeep: ResetPlan['pagesToKeep'] = [];
  for (const row of pages) {
    const inKeptGroup = keptGroups.has(String(row.translation_group_id));
    const inKeptLanguage = keptLanguageIds.has(Number(row.language_id));
    const eligible = !parsed.onlySeeded || isSeededRow(row);

    if (inKeptGroup && inKeptLanguage) {
      pagesToKeep.push(describePage(row));
    } else if ((scope.pages && eligible) || !inKeptLanguage) {
      pagesToDelete.push(describePage(row));
    } else {
      pagesToKeep.push(describePage(row));
    }
  }

  const { data: postRows, error: postError } = await supabase
    .from('posts')
    .select('id, slug, language_id, translation_group_id, author_id');
  if (postError) {
    throw new Error(`Could not read the posts: ${serializeError(postError)}`);
  }
  const postsToDelete = ((Array.isArray(postRows) ? postRows : []) as any[])
    .filter((row) => {
      const inKeptLanguage = keptLanguageIds.has(Number(row.language_id));
      const eligible = !parsed.onlySeeded || isSeededRow(row);
      return (scope.posts && eligible) || !inKeptLanguage;
    })
    .map(describePage);

  let productsToDelete: string[] = [];
  if (scope.products) {
    try {
      const { data } = await supabase.from('products').select('id');
      productsToDelete = ((Array.isArray(data) ? data : []) as any[]).map((row) => String(row.id));
    } catch {
      productsToDelete = [];
    }
  }

  const deletedPageIds = new Set(pagesToDelete.map((page) => page.id));
  const deletedPagePaths = new Set(pagesToDelete.map((page) => `/${page.slug}`));
  const { data: navRows, error: navError } = await supabase.from('navigation_items').select('id, url, page_id');
  if (navError) {
    throw new Error(`Could not read the navigation: ${serializeError(navError)}`);
  }
  const navigationToDelete = ((Array.isArray(navRows) ? navRows : []) as any[])
    .filter(
      (row) =>
        scope.navigation ||
        (row.page_id !== null && row.page_id !== undefined && deletedPageIds.has(Number(row.page_id))) ||
        deletedPagePaths.has(String(row.url))
    )
    .map((row) => Number(row.id));

  const keptPageIds = pagesToKeep.map((page) => page.id);
  const deletedPostIds = new Set(postsToDelete.map((post) => post.id));
  const { data: draftRows } = await supabase.from('content_drafts').select('id, parent_type, parent_id');
  const draftsToDelete = ((Array.isArray(draftRows) ? draftRows : []) as any[])
    .filter((row) => {
      const parentId = Number(row.parent_id);
      if (row.parent_type === 'page') {
        return deletedPageIds.has(parentId) || (parsed.clearKeptPageBlocks && keptPageIds.includes(parentId));
      }
      return row.parent_type === 'post' && deletedPostIds.has(parentId);
    })
    .map((row) => ({ parentId: Number(row.parent_id), parentType: String(row.parent_type) }));

  let customBlockSlugs: string[] = [];
  if (scope.customBlocks) {
    const { data } = await supabase.from('custom_block_definitions').select('slug');
    customBlockSlugs = ((Array.isArray(data) ? data : []) as any[]).map((row) => String(row.slug));
  }

  let mediaToDelete: string[] = [];
  let logosToDelete: string[] = [];
  if (scope.seededMedia || scope.identity) {
    const { data: mediaRows } = await supabase.from('media').select('id, object_key');
    const seededMedia = ((Array.isArray(mediaRows) ? mediaRows : []) as any[]).filter((row) =>
      NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS.has(String(row.object_key))
    );
    const seededMediaIds = new Set(seededMedia.map((row) => String(row.id)));
    const { data: logoRows } = await supabase.from('logos').select('id, media_id');
    logosToDelete = ((Array.isArray(logoRows) ? logoRows : []) as any[])
      .filter((row) => seededMediaIds.has(String(row.media_id)))
      .map((row) => String(row.id));
    mediaToDelete = scope.seededMedia ? [...seededMediaIds] : [];
    if (!scope.identity) {
      logosToDelete = [];
    }
  }

  return {
    blocksToClearPageIds: parsed.clearKeptPageBlocks ? keptPageIds : [],
    customBlockSlugs,
    draftsToDelete,
    identityKeys: scope.identity
      ? ['site_title', 'site_description', 'site_keywords', 'footer_copyright', SITE_SOCIAL_IMAGE_SETTING_KEY]
      : [],
    languagesToDeactivate,
    logosToDelete,
    mediaToDelete,
    navigationToDelete,
    newDefaultLanguage,
    pagesToDelete,
    pagesToKeep,
    postsToDelete,
    productsToDelete,
  };
}

function summarizeResetPlan(plan: ResetPlan) {
  return {
    blocksClearedOnPages: plan.blocksToClearPageIds.length,
    customBlocks: plan.customBlockSlugs.length,
    drafts: plan.draftsToDelete.length,
    identityCleared: plan.identityKeys.length > 0,
    languagesDeactivated: plan.languagesToDeactivate.map((language) => language.code),
    logos: plan.logosToDelete.length,
    media: plan.mediaToDelete.length,
    navigationItems: plan.navigationToDelete.length,
    pages: plan.pagesToDelete.length,
    pagesKept: plan.pagesToKeep.map((page) => `${page.slug} (${page.languageCode})`),
    posts: plan.postsToDelete.length,
    products: plan.productsToDelete.length,
  };
}

async function applySiteReset(plan: ResetPlan, supabase: SupabaseLike, keptLanguageCodes: string[]) {
  // Order matters: drafts and navigation have no cascading FK to pages, so they go
  // first; pages/posts/products cascade their own blocks, revisions, and media joins.
  for (const draft of plan.draftsToDelete) {
    const { error } = await supabase
      .from('content_drafts')
      .delete()
      .eq('parent_type', draft.parentType)
      .eq('parent_id', draft.parentId);
    if (error) {
      throw new Error(`Could not delete a draft: ${serializeError(error)}`);
    }
  }

  await deleteByIds(supabase, 'navigation_items', 'id', plan.navigationToDelete);

  if (plan.blocksToClearPageIds.length > 0) {
    for (const batch of chunk(plan.blocksToClearPageIds)) {
      const { error } = await supabase.from('blocks').delete().in('page_id', batch);
      if (error) {
        throw new Error(`Could not clear the kept pages: ${serializeError(error)}`);
      }
    }
  }

  await deleteByIds(supabase, 'pages', 'id', plan.pagesToDelete.map((page) => page.id));
  await deleteByIds(supabase, 'posts', 'id', plan.postsToDelete.map((post) => post.id));
  await deleteByIds(supabase, 'products', 'id', plan.productsToDelete);
  await deleteByIds(supabase, 'custom_block_definitions', 'slug', plan.customBlockSlugs);
  await deleteByIds(supabase, 'logos', 'id', plan.logosToDelete);
  await deleteByIds(supabase, 'media', 'id', plan.mediaToDelete);

  if (plan.identityKeys.length > 0) {
    await upsertSetting(supabase, 'site_title', '');
    await upsertSetting(supabase, 'site_description', '');
    await upsertSetting(supabase, 'site_keywords', '');
    await upsertSetting(supabase, SITE_SOCIAL_IMAGE_SETTING_KEY, null);
    await upsertSetting(
      supabase,
      'footer_copyright',
      Object.fromEntries(keptLanguageCodes.map((code) => [code, '© {year}']))
    );
  }

  if (plan.logosToDelete.length > 0) {
    const { data } = await supabase.from('site_settings').select('value').eq('key', 'active_logo_id').maybeSingle();
    if (typeof data?.value === 'string' && plan.logosToDelete.includes(data.value)) {
      await upsertSetting(supabase, 'active_logo_id', null);
    }
  }

  for (const language of plan.languagesToDeactivate) {
    const { error } = await supabase.from('languages').update({ is_active: false, is_default: false }).eq('id', language.id);
    if (error) {
      throw new Error(`Could not deactivate the "${language.code}" language: ${serializeError(error)}`);
    }
  }

  if (plan.newDefaultLanguage) {
    const { error: demoteError } = await supabase.from('languages').update({ is_default: false }).neq('id', plan.newDefaultLanguage.id);
    if (demoteError) {
      throw new Error(`Could not change the default language: ${serializeError(demoteError)}`);
    }
    const { error: promoteError } = await supabase
      .from('languages')
      .update({ is_active: true, is_default: true })
      .eq('id', plan.newDefaultLanguage.id);
    if (promoteError) {
      throw new Error(`Could not change the default language: ${serializeError(promoteError)}`);
    }
  }
}

function buildResetNextSteps(plan: ResetPlan) {
  const steps: string[] = [];
  const keptHome = plan.pagesToKeep.some((page) => page.slug === HOME_SLUG);

  if (keptHome && plan.blocksToClearPageIds.length > 0) {
    steps.push('The home page was kept but is now empty: rebuild it with rewrite_page_draft (contentType "page", slug "home") and then publish_content_draft.');
  } else if (!keptHome) {
    steps.push(`No "${HOME_SLUG}" page remains, so "/" is a 404 until you create_cms_page with slug "${HOME_SLUG}" and status "published".`);
  }
  if (plan.navigationToDelete.length > 0) {
    steps.push('The header and footer menus are empty: rebuild them with update_navigation_bar (mode "replace") and update_footer for every active language.');
  }
  if (plan.identityKeys.length > 0) {
    steps.push('Site title, description, keywords, and copyright are blank: set them with update_site_identity.');
  }
  steps.push('The "Published with NextBlock" footer credit is unchanged; set footer_show_attribution to false with update_site_identity if the client wants no NextBlock mention.');

  return steps;
}

export async function executeResetSiteContent(input: ResetSiteContentInput, context?: SiteToolContext) {
  const parsed = resetSiteContentInputSchema.parse(input);
  await requireActorRole(context, ['ADMIN'], 'Resetting the site content');
  const supabase = requireSupabase(context);
  const plan = await planSiteReset(parsed, supabase);
  const summary = summarizeResetPlan(plan);
  const totalItems =
    summary.pages + summary.posts + summary.products + summary.navigationItems + summary.customBlocks + summary.media + summary.logos;

  if (parsed.dryRun) {
    return {
      dryRun: true,
      mutationExecuted: false,
      nextSteps: buildResetNextSteps(plan),
      success: true,
      summary,
      wouldDelete: {
        pages: plan.pagesToDelete,
        posts: plan.postsToDelete,
      },
    };
  }

  const confirmation = getConfirmationPreview({
    action: 'RESET SITE CONTENT',
    context,
    payload: { input: parsed, summary, tool: 'reset_site_content' },
    preview: {
      irreversible: true,
      summary: `Permanently delete ${summary.pages} page(s), ${summary.posts} post(s), ${summary.products} product(s), ${summary.navigationItems} navigation item(s), ${summary.customBlocks} custom block definition(s), ${summary.media} demo image(s) and ${summary.logos} logo(s)${
        summary.identityCleared ? ', clear the site identity' : ''
      }${summary.languagesDeactivated.length ? `, deactivate ${summary.languagesDeactivated.join(', ')}` : ''}. Kept: ${
        summary.pagesKept.join(', ') || 'nothing'
      }. This cannot be undone — take a backup first at /cms/settings/backup-restore if the content matters.`,
      ...summary,
    },
    subject: `${totalItems} items`,
  });

  if (confirmation) {
    return confirmation;
  }

  const keptLanguageCodes = parsed.keepLanguages?.map((code) => code.toLowerCase()) ?? [];
  const fallbackCodes = keptLanguageCodes.length > 0 ? keptLanguageCodes : await (async () => {
    const { data } = await supabase.from('languages').select('code, is_active');
    return ((Array.isArray(data) ? data : []) as any[])
      .filter((row) => row.is_active !== false)
      .map((row) => String(row.code).toLowerCase());
  })();

  await applySiteReset(plan, supabase, fallbackCodes);

  revalidateSite(context, ['/cms/pages', '/cms/posts', '/cms/navigation', '/cms/media', '/cms/custom-blocks', '/cms/products']);

  return {
    deleted: summary,
    mutationExecuted: true,
    nextSteps: buildResetNextSteps(plan),
    success: true,
  };
}

/* -------------------------------------------------------------------------- */
/* start_site_build / finish_site_build                                        */
/* -------------------------------------------------------------------------- */

const BUILD_SESSION_DEFAULT_MINUTES = 60;

export const startSiteBuildInputSchema = z.strictObject({
  brief: cortexSiteBriefInputSchema
    .optional()
    .describe('The brief as agreed with the client. Merged over the saved brief and marked confirmed.'),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(180)
    .default(BUILD_SESSION_DEFAULT_MINUTES)
    .describe('How long the unattended build session stays open.'),
  reset: resetSiteContentInputSchema
    .optional()
    .describe('Remove the seeded NextBlock demo content as the first step of the build. Omit when the client keeps existing content.'),
  summary: z
    .string()
    .trim()
    .min(20)
    .max(4000)
    .describe('The plan the operator is approving, in plain language: what is removed, every page and its sections, navigation, footer, theme, languages.'),
});

export type StartSiteBuildInput = z.input<typeof startSiteBuildInputSchema>;

export async function executeStartSiteBuild(input: StartSiteBuildInput, context?: SiteToolContext) {
  const parsed = startSiteBuildInputSchema.parse(input);
  await requireActorRole(context, ['ADMIN'], 'Starting a site build');
  const supabase = requireSupabase(context);
  const actorUserId = context?.actorUserId as string;

  let resetPlanSummary: ReturnType<typeof summarizeResetPlan> | null = null;
  let resetParsed: z.infer<typeof resetSiteContentInputSchema> | null = null;
  if (parsed.reset) {
    resetParsed = resetSiteContentInputSchema.parse({ ...parsed.reset, dryRun: false });
    resetPlanSummary = summarizeResetPlan(await planSiteReset(resetParsed, supabase));
  }

  const confirmation = getConfirmationPreview({
    action: 'START SITE BUILD',
    context,
    payload: { brief: parsed.brief ?? null, durationMinutes: parsed.durationMinutes, reset: resetParsed, summary: parsed.summary, tool: 'start_site_build' },
    preview: {
      durationMinutes: parsed.durationMinutes,
      plan: parsed.summary,
      reset: resetPlanSummary,
      summary: `${parsed.summary}${
        resetPlanSummary
          ? ` First, permanently delete ${resetPlanSummary.pages} page(s), ${resetPlanSummary.posts} post(s), ${resetPlanSummary.navigationItems} navigation item(s), ${resetPlanSummary.media} demo image(s)${
              resetPlanSummary.identityCleared ? ' and the NextBlock site identity' : ''
            } (kept: ${resetPlanSummary.pagesKept.join(', ') || 'nothing'}).`
          : ''
      } After you confirm, Cortex applies every step of this plan without asking again, for up to ${parsed.durationMinutes} minutes. You can stop it at any time.`,
    },
    subject: 'plan',
  });

  if (confirmation) {
    return confirmation;
  }

  let brief: CortexSiteBrief | null = null;
  if (parsed.brief) {
    const saved = await executeSaveSiteBrief(
      { brief: { ...parsed.brief, status: 'confirmed' }, mode: 'merge' },
      { ...context, skipConfirmation: true }
    );
    brief = saved.brief;
  } else {
    const existing = await readCortexSiteBrief(supabase);
    if (existing) {
      brief = (await executeSaveSiteBrief({ brief: { status: 'confirmed' }, mode: 'merge' }, { ...context, skipConfirmation: true })).brief;
    }
  }

  let resetResult: Record<string, unknown> | null = null;
  if (resetParsed) {
    resetResult = (await executeResetSiteContent(resetParsed, { ...context, skipConfirmation: true })) as Record<string, unknown>;
  }

  const now = new Date();
  const session: CortexBuildSession = {
    actorUserId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + parsed.durationMinutes * 60_000).toISOString(),
    id: createId(),
    summary: parsed.summary,
  };
  await upsertSetting(supabase, CORTEX_AI_BUILD_SESSION_SETTING_KEY, session);

  return {
    brief,
    buildSession: { expiresAt: session.expiresAt, id: session.id },
    continuePrompt:
      'The build session is active and the plan is approved. Continue the site build now, step by step, without asking for confirmation: identity, languages, theme, pages (rewrite home, create the others), publish every draft, navigation, footer, translations, then call finish_site_build and summarize what was built with links.',
    mutationExecuted: true,
    resetResult,
    success: true,
  };
}

export const finishSiteBuildInputSchema = z.strictObject({
  outcome: z
    .enum(['built', 'stopped'])
    .default('built')
    .describe('"built" when the plan was completed; "stopped" when the operator interrupted it.'),
  summary: z.string().trim().max(4000).optional().describe('What was built, for the record.'),
});

export type FinishSiteBuildInput = z.input<typeof finishSiteBuildInputSchema>;

export async function executeFinishSiteBuild(input: FinishSiteBuildInput, context?: SiteToolContext) {
  const parsed = finishSiteBuildInputSchema.parse(input);
  const supabase = requireSupabase(context);
  const session = await readCortexBuildSession(supabase);

  await clearCortexBuildSession(supabase);

  let brief: CortexSiteBrief | null = null;
  if (parsed.outcome === 'built') {
    const existing = await readCortexSiteBrief(supabase);
    if (existing) {
      brief = (
        await executeSaveSiteBrief(
          { brief: { status: 'built', ...(parsed.summary ? { notes: `${existing.notes ? `${existing.notes}\n` : ''}Built: ${parsed.summary}` } : {}) }, mode: 'merge' },
          { ...context, skipConfirmation: true }
        )
      ).brief;
    }
  }

  revalidateSite(context, ['/cms/dashboard']);

  return {
    brief,
    buildSessionEnded: true,
    hadSession: Boolean(session),
    mutationExecuted: true,
    outcome: parsed.outcome,
    success: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export function createCortexSiteTools(context?: SiteToolContext) {
  return {
    get_site_overview: tool({
      description:
        'Read the WHOLE site in one call: languages, site identity (title, description, copyright, active logo), every page, post, and product with status and language, the header and footer menus per language, themes, custom block definitions, media counts, pending Live Drafts, the saved site brief, and whether NextBlock demo content is still present. Read-only. Call this FIRST for any request about the site as a whole ("build my site", "update the whole website", "what do I have?") instead of several narrower reads.',
      execute: (input) => executeGetSiteOverview(input, context),
      inputSchema: getSiteOverviewInputSchema,
      strict: true,
    }),
    update_site_identity: tool({
      description:
        'Set the site-wide identity: site_title (brand name in the header and <title>), site_description, site_keywords, footer_copyright per locale ("{year}" is substituted), footer_show_attribution (the "Published with NextBlock" credit), the pinned active_logo_id, and social_image — the site-wide Open Graph / share preview image (a media id or an https URL) used by every page without a feature image, the home page above all, which must never get a feature image of its own. Use it right after a reset and whenever the client renames or re-describes their business. Mutating: first returns a confirmation phrase; only executes after exact confirmation.',
      execute: (input) => executeUpdateSiteIdentity(input, context),
      inputSchema: updateSiteIdentityInputSchema,
      strict: true,
    }),
    save_site_brief: tool({
      description:
        'Record what the client wants their website to be — business, audience, goals, site type (a one-page landing site is fine), pages and their sections, languages, brand colours and tone, contact details, whether existing content is kept. Saved site-wide and shown to you at the start of every later conversation, so save it as soon as you learn something (mode "merge" adds to what is saved). Runs immediately, no confirmation.',
      execute: (input) => executeSaveSiteBrief(input, context),
      inputSchema: saveSiteBriefInputSchema,
      strict: true,
    }),
    reset_site_content: tool({
      description:
        'Remove the NextBlock demo content that ships with a fresh install — or, by scope, everything: pages (all languages, except keepPageSlugs, default ["home"] which is kept but emptied), posts, navigation, the bundled demo images and logo, the default site title and copyright; optionally products and custom block definitions. keepLanguages deactivates every other language and removes its content, so a client who only wants English gets an English-only site. Pass dryRun true to see the counts first. ADMIN only, irreversible; take a backup at /cms/settings/backup-restore if in doubt. Mutating: first returns a confirmation phrase; only executes after exact confirmation. Prefer start_site_build with `reset` when you are about to rebuild the site, so one confirmation covers both.',
      execute: (input) => executeResetSiteContent(input, context),
      inputSchema: resetSiteContentInputSchema,
      strict: true,
    }),
    start_site_build: tool({
      description:
        'Approve a whole-site plan with ONE confirmation. Pass the plain-language plan in `summary`, the agreed `brief`, and (usually) `reset` so the demo content is removed first. On confirmation it saves the brief, runs the reset, and opens a time-boxed build session: until it expires, every later tool call in this chat executes without asking for confirmation, so you can create pages, publish drafts, set navigation, footer, theme, and translations in one unattended run. Call it only after the client has seen the plan and agreed. After it succeeds, keep working through the plan immediately and finish with finish_site_build. ADMIN only.',
      execute: (input) => executeStartSiteBuild(input, context),
      inputSchema: startSiteBuildInputSchema,
      strict: true,
    }),
    finish_site_build: tool({
      description:
        'Close the current build session (opened by start_site_build) and mark the brief as built. Call it as the LAST step of a site build, or with outcome "stopped" if the operator interrupted. Runs immediately, no confirmation.',
      execute: (input) => executeFinishSiteBuild(input, context),
      inputSchema: finishSiteBuildInputSchema,
      strict: true,
    }),
  };
}
