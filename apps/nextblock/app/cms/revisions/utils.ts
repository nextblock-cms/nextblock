// apps/nextblock/app/cms/revisions/utils.ts
import { createClient } from "@nextblock-cms/db/server";
import type { Database, Json } from "@nextblock-cms/db";

type BlockRow = Database['public']['Tables']['blocks']['Row'];

/**
 * The columns a revision snapshot captures, in one place.
 *
 * These lists are the contract between four things that must agree exactly:
 *   - the SELECTs in this file (what a snapshot records; for products, the `meta` object of
 *     public.product_revision_content in migration 02043, which getFullProductContent reads),
 *   - the UPDATEs in service.ts (what a restore replays),
 *   - the jsonb_build_object() calls in migration 00000000000016 (the stored baseline),
 *   - RESTORE_EXCLUDED_META_COLUMNS below (what a restore must never replay).
 *
 * Anything editable that is missing here is silently un-restorable: a publish that only
 * changed that field produces an empty JSON Patch, which createPageRevision treats as
 * "nothing happened" and drops on the floor.
 */
export const PAGE_META_COLUMNS = [
  'title',
  'slug',
  'language_id',
  'status',
  'meta_title',
  'meta_description',
  'custom_canonical',
  'published_at',
  'feature_image_id',
] as const;

export const POST_META_COLUMNS = [
  ...PAGE_META_COLUMNS,
  'label',
  'excerpt',
  'subtitle',
] as const;

export const PRODUCT_META_COLUMNS = [
  'title',
  'slug',
  'language_id',
  'status',
  'meta_title',
  'meta_description',
  'custom_canonical',
  'published_at',
  'short_description',
  'description_json',
] as const;

/**
 * Visibility is owned by setContentVisibility (app/actions/visibilityActions.ts), which
 * deliberately bypasses the draft/revision pipeline. Both fields are still *captured* —
 * they are useful history — but replaying them on restore would let "restore the wording
 * from last Tuesday" silently unpublish a live page or resurrect a cancelled schedule.
 *
 * They are excluded from change detection for the same reason: a status flip made from
 * the top bar would otherwise be misattributed to whichever author saved next.
 */
export const RESTORE_EXCLUDED_META_COLUMNS = ['status', 'published_at'] as const;

export interface PageMetaContent {
  title: string;
  slug: string;
  language_id: number;
  status: Database['public']['Enums']['page_status'];
  meta_title: string | null;
  meta_description: string | null;
  custom_canonical: string | null;
  published_at: string | null;
  feature_image_id: string | null;
}

export interface PostMetaContent extends PageMetaContent {
  label: string | null;
  excerpt: string | null;
  subtitle: string | null;
}

export interface ProductMetaContent {
  title: string;
  slug: string;
  language_id: number;
  status: string;
  meta_title: string | null;
  meta_description: string | null;
  custom_canonical: string | null;
  published_at: string | null;
  short_description: string | null;
  description_json: Json | null;
}

export interface SimpleBlockContent {
  language_id: number;
  block_type: BlockRow['block_type'];
  content: Json;
  order: number;
}

export interface FullPageContent {
  meta: PageMetaContent;
  blocks: SimpleBlockContent[];
}

export interface FullPostContent {
  meta: PostMetaContent;
  blocks: SimpleBlockContent[];
}

/** A variant in a product's History content, by SKU and attribute terms (variant ids are left out). */
export interface ProductVariantCommerceContent {
  sku: string;
  upc: string | null;
  price: number;
  prices: Json;
  sale_price: number | null;
  sale_prices: Json | null;
  sale_start_at: string | null;
  sale_end_at: string | null;
  scheduled_price: number | null;
  scheduled_prices: Json | null;
  scheduled_price_at: string | null;
  stock_quantity: number;
  main_media_id: string | null;
  attribute_term_ids: string[];
}

/**
 * The commerce side of a product's History content: what a product-values publish can change beside
 * the meta columns and the blocks. Amounts are minor units, as stored. A restore never replays it
 * (RESTORE_EXCLUDED_META_COLUMNS covers visibility the same way): restoring the wording of a version
 * must not move prices, variants or stock behind a shopper's back.
 */
export interface ProductCommerceContent {
  sku: string;
  upc: string | null;
  product_type: string;
  payment_provider: string;
  price: number;
  prices: Json;
  sale_price: number | null;
  sale_prices: Json | null;
  sale_start_at: string | null;
  sale_end_at: string | null;
  scheduled_price: number | null;
  scheduled_prices: Json | null;
  scheduled_price_at: string | null;
  stock: number | null;
  is_taxable: boolean;
  freemius_product_id: string | null;
  freemius_plan_id: string | null;
  trial_period_days: number;
  trial_requires_payment_method: boolean;
  /** media ids in gallery order */
  gallery: string[];
  category_ids: string[];
  /** ordered by SKU */
  variants: ProductVariantCommerceContent[];
}

export interface FullProductContent {
  meta: ProductMetaContent;
  blocks: SimpleBlockContent[];
  /**
   * Absent from revisions recorded before migration 02043, which held the meta columns and the
   * blocks only, so a publish that changed prices, variants, stock, the sale window or the gallery
   * and nothing else recorded nothing.
   */
  commerce?: ProductCommerceContent;
}

export type AnyFullContent = FullPageContent | FullPostContent | FullProductContent;

/**
 * Any Supabase client shape. Callers pass the cookie-scoped client, the service-role client,
 * or nothing at all — the generics on those two differ enough that a union of them makes
 * `.from()` uncallable, so this stays deliberately loose.
 */
type AnySupabaseClient = any;

/**
 * Normalise a timestamp to the exact format JSON snapshots use everywhere else —
 * `Date#toISOString()`, millisecond precision, `Z` suffix. Postgres renders timestamptz
 * with microseconds and a `+00:00` offset, so without this a value that round-trips
 * through the database comes back textually different and shows up as a phantom diff.
 */
function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface BlockCaptureOptions {
  overrideBlockId?: number;
  overrideBlockContent?: unknown;
  excludeDeletedBlockId?: number;
}

/** Reduce raw block rows to the id-free shape stored in revisions. */
function toSimpleBlocks(
  blocks: Pick<BlockRow, 'id' | 'language_id' | 'block_type' | 'content' | 'order'>[] | null,
  opts?: BlockCaptureOptions
): SimpleBlockContent[] {
  return (blocks || [])
    .filter(b => (opts?.excludeDeletedBlockId ? b.id !== opts.excludeDeletedBlockId : true))
    .map(b => ({
      language_id: b.language_id,
      block_type: b.block_type,
      content: (opts?.overrideBlockId && b.id === opts.overrideBlockId)
        ? (opts.overrideBlockContent as Json)
        : (b.content as Json),
      order: b.order,
    } satisfies SimpleBlockContent));
}

/**
 * Blocks are ordered by `order` then `id`. Revision blocks carry no id, so their array
 * position *is* their identity — two blocks sharing an `order` value would otherwise swap
 * places between two reads and register as a content change that never happened.
 */
const BLOCK_SELECT = 'id, language_id, block_type, content, order';

export async function getFullPageContent(
  pageId: number,
  opts?: BlockCaptureOptions,
  client?: AnySupabaseClient
): Promise<FullPageContent | null> {
  const supabase = (client ?? createClient()) as AnySupabaseClient;
  const { data: page, error: pageError } = await supabase
    .from('pages')
    .select(`id, ${PAGE_META_COLUMNS.join(', ')}`)
    .eq('id', pageId)
    .single();
  if (pageError || !page) return null;

  const { data: blocks, error: blocksError } = await supabase
    .from('blocks')
    .select(BLOCK_SELECT)
    .eq('page_id', pageId)
    .order('order', { ascending: true })
    .order('id', { ascending: true });
  if (blocksError) return null;

  const row = page as Record<string, any>;

  return {
    meta: {
      title: row['title'],
      slug: row['slug'],
      language_id: row['language_id'],
      status: row['status'],
      meta_title: row['meta_title'] ?? null,
      meta_description: row['meta_description'] ?? null,
      custom_canonical: row['custom_canonical'] ?? null,
      published_at: normalizeTimestamp(row['published_at']),
      feature_image_id: row['feature_image_id'] ?? null,
    },
    blocks: toSimpleBlocks(blocks as any, opts),
  };
}

export async function getFullPostContent(
  postId: number,
  opts?: BlockCaptureOptions,
  client?: AnySupabaseClient
): Promise<FullPostContent | null> {
  const supabase = (client ?? createClient()) as AnySupabaseClient;
  const { data: post, error: postError } = await supabase
    .from('posts')
    .select(`id, ${POST_META_COLUMNS.join(', ')}`)
    .eq('id', postId)
    .single();
  if (postError || !post) return null;

  const { data: blocks, error: blocksError } = await supabase
    .from('blocks')
    .select(BLOCK_SELECT)
    .eq('post_id', postId)
    .order('order', { ascending: true })
    .order('id', { ascending: true });
  if (blocksError) return null;

  const row = post as Record<string, any>;

  return {
    meta: {
      title: row['title'],
      slug: row['slug'],
      language_id: row['language_id'],
      status: row['status'],
      meta_title: row['meta_title'] ?? null,
      meta_description: row['meta_description'] ?? null,
      custom_canonical: row['custom_canonical'] ?? null,
      published_at: normalizeTimestamp(row['published_at']),
      feature_image_id: row['feature_image_id'] ?? null,
      label: row['label'] ?? null,
      excerpt: row['excerpt'] ?? null,
      subtitle: row['subtitle'] ?? null,
    },
    blocks: toSimpleBlocks(blocks as any, opts),
  };
}

/**
 * A product's History content, read from `public.product_revision_content` (migration 02043): the
 * same function `publish_product_draft` records a publish's revision with, in the transaction that
 * publishes, so the content History compares and the content it stored can never be shaped
 * differently. `meta` holds PRODUCT_META_COLUMNS (timestamps as normalizeTimestamp writes them),
 * `blocks` the blocks ordered by `order` then id, and `commerce` the prices, variants, stock, sale
 * window, gallery and the rest (ProductCommerceContent). Runs with the caller's rights, as the table
 * reads it replaced did. Null when the product cannot be read, or when the database has not applied
 * 02043 yet (PostgREST then knows no such function). Products take no block overrides
 * (BlockCaptureOptions): nothing captures a product's blocks with one.
 */
export async function getFullProductContent(
  productId: string,
  opts?: undefined,
  client?: AnySupabaseClient
): Promise<FullProductContent | null> {
  void opts;
  const supabase = (client ?? createClient()) as AnySupabaseClient;
  let data: unknown;
  try {
    const answer = await supabase.rpc('product_revision_content', { p_product_id: productId });
    if (answer.error) return null;
    data = answer.data;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const content = data as Record<string, unknown>;
  if (!content['meta'] || typeof content['meta'] !== 'object' || !Array.isArray(content['blocks'])) return null;

  return content as unknown as FullProductContent;
}

/**
 * Build the meta payload a restore writes back, minus the fields a restore must never
 * replay (see RESTORE_EXCLUDED_META_COLUMNS).
 */
export function buildRestoreMetaUpdate(
  meta: Record<string, unknown>,
  columns: readonly string[]
): Record<string, unknown> {
  const excluded = new Set<string>(RESTORE_EXCLUDED_META_COLUMNS);
  const update: Record<string, unknown> = {};
  for (const column of columns) {
    if (excluded.has(column)) continue;
    if (!Object.prototype.hasOwnProperty.call(meta, column)) continue;
    update[column] = meta[column];
  }
  return update;
}
