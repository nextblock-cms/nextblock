/**
 * Where a media item is used, as public.media_usage (migration 02045) answers it, and how the media
 * library describes it. Import-free and client-safe: the server reads the answer
 * (lib/media/media-usage.ts), the library's dialogs and pages render it.
 *
 * The lookup finds the media id or a storage key the row owns in every content table: a lookup, not a
 * proof. A reference outside the database (another site, a sent email, a cached social preview) is
 * invisible to it, so the library says "nothing here uses it", never "unused anywhere". A row whose
 * keys were not searched reads "could not be fully checked" and counts as used.
 */

/** A kind of use, as the database function names it, plus the one findMediaUsage adds (MEDIA_USAGE_UNCHECKED_KIND). */
export type MediaUsageKind =
  | 'product_gallery'
  | 'product_variant'
  | 'page_feature_image'
  | 'post_feature_image'
  | 'logo'
  | 'block'
  | 'product'
  | 'site_setting'
  | 'custom_block'
  | 'navigation_item'
  | 'redirect'
  | 'category'
  | 'site_theme'
  | 'profile'
  | 'partner_page'
  | 'content_draft'
  | 'product_draft'
  | 'page_revision'
  | 'post_revision'
  | 'product_revision'
  | typeof MEDIA_USAGE_UNCHECKED_KIND;

/**
 * The kind findMediaUsage adds, never the database, for a row whose storage keys it did not search:
 * a key holding a character the upload routes never mint, two spellings of one key, or more keys than
 * one upload makes. It counts as a use, so such a row is never "unused" and "Delete unused" never
 * deletes it: what was not searched could be what a page shows.
 */
export const MEDIA_USAGE_UNCHECKED_KIND = 'unchecked_key';

/** One place that names the media item. */
export interface MediaUsageSite {
  kind: string;
  /** The record's id; empty when withheld from a caller who cannot read the record (withoutAdminOnlyLabels). */
  recordId: string;
  parentType: 'page' | 'post' | 'product' | null;
  parentId: string | null;
  /** The parent's title, or the logo, theme, block definition, link or setting name; null when unknown or withheld. */
  label: string | null;
  /** The parent's language code. */
  language: string | null;
}

/** Where one media item is used: every place counted, the first 50 listed (live uses first). */
export interface MediaUsage {
  total: number;
  byKind: Record<string, number>;
  sites: MediaUsageSite[];
}

/** Revisions: listed as history, never counted as a use (restoring one would show a missing image). */
export const MEDIA_USAGE_HISTORY_KINDS: ReadonlySet<string> = new Set(['page_revision', 'post_revision', 'product_revision']);

/** How many places use the item now, drafts included, revisions not. */
export function countMediaUses(usage: MediaUsage): number {
  return Object.entries(usage.byKind).reduce(
    (sum, [kind, count]) => (MEDIA_USAGE_HISTORY_KINDS.has(kind) ? sum : sum + count),
    0
  );
}

/** How many revisions name the item. */
export function countMediaHistoryUses(usage: MediaUsage): number {
  return Object.entries(usage.byKind).reduce(
    (sum, [kind, count]) => (MEDIA_USAGE_HISTORY_KINDS.has(kind) ? sum + count : sum),
    0
  );
}

/** Whether nothing the lookup reads uses the item (revisions aside). */
export function isMediaUnused(usage: MediaUsage): boolean {
  return countMediaUses(usage) === 0;
}

/**
 * The site_settings keys a WRITER reads: the two branches of site_settings_read_policy (02038) that
 * are not the ADMIN tier. Every other key is an ADMIN-tier row (payment_public, store_contact,
 * forms_contact, the cortex_ai_* settings, ...). media-usage-format.test.ts holds this list to the
 * latest migration that creates that policy.
 */
export const WRITER_READABLE_SITE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'site_title',
  'site_description',
  'site_keywords',
  'site_social_image',
  'footer_copyright',
  'footer_show_attribution',
  'global_css',
  'language_detection_settings',
  'seo_robots_settings',
  'bot_protection_public',
  'active_logo_id',
  'is_admin_created',
  'privacy_settings',
  'enabled_payment_providers',
  'ecommerce_inventory_settings',
  'migration_baseline_generation',
  'invoice_settings',
  'security_settings',
  'onboarding_state',
  'email_public',
  'cortex_ai_site_brief',
]);

/**
 * Whether RLS stops a WRITER from reading the record a place names. public.media_usage answers with
 * the service role, so without this a WRITER's lookup would name records their own session cannot
 * read. The other kinds' tables let staff read every row (blocks, drafts, revisions, products,
 * pages, posts, profiles, logos, categories, themes, navigation, custom blocks).
 *  - partner_page: affiliate_pages and affiliate_profiles answer the partner or an ADMIN only.
 *  - redirect: an inactive redirect is ADMIN-only ("Authenticated read redirects"), and the answer
 *    does not say whether it is active.
 *  - site_setting: a key outside WRITER_READABLE_SITE_SETTING_KEYS is an ADMIN-tier row.
 */
function isAdminOnlySite(site: MediaUsageSite): boolean {
  switch (site.kind) {
    case 'partner_page':
    case 'redirect':
      return true;
    case 'site_setting':
      // A site_setting's record id is its key.
      return !WRITER_READABLE_SITE_SETTING_KEYS.has(site.recordId);
    default:
      return false;
  }
}

/**
 * The usage as a caller other than an ADMIN may see it: the places whose record RLS hides from a
 * WRITER keep their kind (and the counts stay whole), but lose their label, record id and parent.
 */
export function withoutAdminOnlyLabels(usage: MediaUsage): MediaUsage {
  return {
    ...usage,
    sites: usage.sites.map((site) =>
      isAdminOnlySite(site) ? { ...site, recordId: '', parentType: null, parentId: null, label: null, language: null } : site
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readSite(value: unknown): MediaUsageSite {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.record_id !== 'string') {
    throw new Error('the lookup answered a place in another shape');
  }
  const parentType = value.parent_type;
  return {
    kind: value.kind,
    recordId: value.record_id,
    parentType: parentType === 'page' || parentType === 'post' || parentType === 'product' ? parentType : null,
    parentId: nullableText(value.parent_id),
    label: nullableText(value.label),
    language: nullableText(value.language),
  };
}

function readUsage(value: unknown): MediaUsage {
  if (!isRecord(value) || typeof value.total !== 'number' || !isRecord(value.by_kind) || !Array.isArray(value.sites)) {
    throw new Error('the lookup answered in another shape');
  }
  const byKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value.by_kind)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      throw new Error('the lookup answered a count in another shape');
    }
    byKind[kind] = count;
  }
  return { total: value.total, byKind, sites: value.sites.map(readSite) };
}

/**
 * The lookup's answer for `mediaIds`, by lowercased id. Throws when the answer is not the function's
 * shape or leaves one of the ids out: a caller never reads a failed or partial lookup as "unused".
 */
export function parseMediaUsageAnswer(answer: unknown, mediaIds: readonly string[]): Map<string, MediaUsage> {
  if (!isRecord(answer)) {
    throw new Error('the lookup answered in another shape');
  }
  const usage = new Map<string, MediaUsage>();
  for (const rawId of mediaIds) {
    const id = rawId.toLowerCase();
    if (!(id in answer)) {
      throw new Error('the lookup left a media item out');
    }
    usage.set(id, readUsage(answer[id]));
  }
  return usage;
}

const PARENT_NOUNS = { page: 'Page', post: 'Post', product: 'Product' } as const;

/** `Page "Home" (FR)`, or `a page` when the title is unknown. */
function describeParent(site: MediaUsageSite): string {
  const noun = site.parentType ? PARENT_NOUNS[site.parentType] : 'Item';
  if (!site.label) {
    return `${noun} #${site.parentId ?? site.recordId}`;
  }
  return `${noun} "${site.label}"${site.language ? ` (${site.language.toUpperCase()})` : ''}`;
}

function parentEditHref(site: MediaUsageSite): string | null {
  if (!site.parentId || !site.parentType) {
    return null;
  }
  return `/cms/${site.parentType}s/${encodeURIComponent(site.parentId)}/edit`;
}

/** Settings screens for the site_settings rows that hold images. */
const SITE_SETTING_SCREENS: Record<string, { name: string; href: string }> = {
  site_social_image: { name: 'Social preview image (Branding)', href: '/cms/settings/logos' },
  global_css: { name: 'Global CSS', href: '/cms/settings/global-css' },
};

/** What a place is and where it is edited (null when no screen edits it). */
export function describeMediaUsageSite(site: MediaUsageSite): { text: string; href: string | null } {
  switch (site.kind) {
    case 'block':
      return { text: `${describeParent(site)}: content block`, href: parentEditHref(site) };
    case 'product':
      return { text: `${describeParent(site)}: description`, href: parentEditHref(site) };
    case 'product_gallery':
      return { text: `${describeParent(site)}: gallery`, href: parentEditHref(site) };
    case 'product_variant':
      return { text: `${describeParent(site)}: variant image`, href: parentEditHref(site) };
    case 'page_feature_image':
    case 'post_feature_image':
      return { text: `${describeParent(site)}: feature image`, href: parentEditHref(site) };
    case 'content_draft':
    case 'product_draft':
      return { text: `${describeParent(site)}: unpublished draft`, href: parentEditHref(site) };
    case 'page_revision':
    case 'post_revision':
    case 'product_revision':
      return { text: `${describeParent(site)}: revision history`, href: parentEditHref(site) };
    case 'logo':
      return { text: `Logo${site.label ? ` "${site.label}"` : ''}`, href: '/cms/settings/logos' };
    case 'site_setting': {
      const screen = site.label ? SITE_SETTING_SCREENS[site.label] : undefined;
      return screen
        ? { text: screen.name, href: screen.href }
        : { text: `Site setting${site.label ? ` "${site.label}"` : ''}`, href: null };
    }
    case 'custom_block':
      return {
        text: `Custom block${site.label ? ` "${site.label}"` : ''}: definition`,
        href: `/cms/custom-blocks/${encodeURIComponent(site.recordId)}`,
      };
    case 'navigation_item':
      return { text: `Navigation link${site.label ? ` "${site.label}"` : ''}`, href: '/cms/navigation' };
    case 'redirect':
      // Without its source path the place was withheld (the redirect screens are ADMIN-only): no link.
      return site.label
        ? { text: `Redirect from "${site.label}"`, href: '/cms/settings/seo' }
        : { text: 'A redirect', href: null };
    case 'category':
      return { text: `Product category${site.label ? ` "${site.label}"` : ''}`, href: '/cms/products/categories' };
    case 'site_theme':
      return { text: `Theme${site.label ? ` "${site.label}"` : ''}`, href: '/cms/settings/global-css' };
    case 'profile':
      return { text: "A user's profile picture", href: null };
    case 'partner_page':
      return site.label
        ? { text: `Partner storefront "${site.label}"`, href: `/cms/affiliates/approvals/${encodeURIComponent(site.recordId)}` }
        : { text: 'A partner storefront', href: null };
    case MEDIA_USAGE_UNCHECKED_KIND:
      return { text: 'Its storage key could not be searched; check where it is used before deleting', href: null };
    default:
      return { text: site.label ? `${site.kind}: ${site.label}` : site.kind, href: null };
  }
}

/**
 * One line for a usage: "Used in 3 places", "Only in revision history (2)", "Nothing here uses it", or
 * "Could not be fully checked" when its storage keys were not searched (the places found are then a
 * floor, never the whole answer).
 */
export function summarizeMediaUsage(usage: MediaUsage): string {
  const unchecked = usage.byKind[MEDIA_USAGE_UNCHECKED_KIND] ?? 0;
  const uses = countMediaUses(usage) - unchecked;
  const history = countMediaHistoryUses(usage);
  const inRevisions = history > 0 ? `, and in ${history} ${history === 1 ? 'revision' : 'revisions'}` : '';
  if (unchecked > 0) {
    return `Could not be fully checked${uses > 0 ? `; used in at least ${uses} ${uses === 1 ? 'place' : 'places'}` : ''}${inRevisions}`;
  }
  if (uses > 0) {
    return `Used in ${uses} ${uses === 1 ? 'place' : 'places'}${inRevisions}`;
  }
  if (history > 0) {
    return `Only in revision history (${history} ${history === 1 ? 'revision' : 'revisions'})`;
  }
  return 'Nothing in this site uses it';
}
