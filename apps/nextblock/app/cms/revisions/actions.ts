// apps/nextblock/app/cms/revisions/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@nextblock-cms/db/server";
import { revalidatePublicContent } from "../../../lib/public-content-cache";
import {
  restorePageToVersion,
  restorePostToVersion,
  restoreProductToVersion,
  reconstructPageVersionContent,
  reconstructPostVersionContent,
  reconstructProductVersionContent,
} from './service';
import {
  getFullPageContent,
  getFullPostContent,
  getFullProductContent,
  RESTORE_EXCLUDED_META_COLUMNS,
} from './utils';
import type { FullPageContent, FullPostContent, FullProductContent } from './utils';
import { compare } from 'fast-json-patch';

type RevisionListItem = {
  id: number;
  version: number;
  revision_type: 'snapshot' | 'diff';
  created_at: string;
  author_id: string | null;
  author?: { full_name?: string | null } | null;
};

const REVISIONS_PER_PAGE = 10;

/**
 * Paths whose ops never represent an editorial change.
 *
 * These are anchored to the exact meta path rather than matched with `endsWith`, because a
 * suffix match at any depth also swallows real content — a block whose payload happens to
 * carry an `id` or a `published_at` field would have its edits filtered out and the row
 * would render as "no changes".
 *
 * `status`/`published_at` are here because visibility is owned by the top bar and never
 * replayed on restore (see RESTORE_EXCLUDED_META_COLUMNS); attributing a publish toggle to
 * whoever saved next would be wrong.
 */
const IGNORED_DIFF_PATHS = new Set<string>([
  '/meta/updated_at',
  '/meta/created_at',
  '/meta/version',
  '/meta/id',
  '/meta/author_id',
  ...RESTORE_EXCLUDED_META_COLUMNS.map(column => `/meta/${column}`),
]);

function hasMeaningfulOps(ops: unknown): boolean {
  if (!Array.isArray(ops) || ops.length === 0) return false;
  return ops.some((op: any) => !op?.path || !IGNORED_DIFF_PATHS.has(op.path));
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Decide whether a stored revision differs from the live content in a way worth showing.
 * Unknown/unparseable payloads default to "yes" — hiding a row the user might need is worse
 * than showing one that turns out to be identical.
 */
function computeHasChanges(
  revision: { revision_type: string; content: unknown; version: number },
  currentContent: unknown,
  currentVersion: number | null
): boolean {
  if (revision.revision_type === 'diff') {
    return hasMeaningfulOps(parseMaybeJson(revision.content));
  }

  if (!currentContent || revision.version === currentVersion) return true;

  const snapshotContent = parseMaybeJson(revision.content);
  if (!snapshotContent || typeof snapshotContent !== 'object') return true;

  return hasMeaningfulOps(compare(currentContent as object, snapshotContent as object));
}

function paginate(
  revisions: (RevisionListItem & { has_changes: boolean; content?: unknown })[],
  page: number
) {
  revisions.sort((a, b) => b.version - a.version);
  const count = revisions.length;
  const totalPages = Math.ceil(count / REVISIONS_PER_PAGE);
  const fromIndex = (page - 1) * REVISIONS_PER_PAGE;
  const slice = revisions
    .slice(fromIndex, fromIndex + REVISIONS_PER_PAGE)
    .map(({ content, ...rest }) => rest);

  return {
    success: true as const,
    revisions: slice,
    count,
    totalPages,
    hasMore: page * REVISIONS_PER_PAGE < count,
  };
}

function applyDateFilters(query: any, startDate?: string, endDate?: string) {
  if (startDate) query = query.gte('created_at', `${startDate}T00:00:00.000Z`);
  if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);
  return query;
}

export async function listPageRevisions(pageId: number, page = 1, startDate?: string, endDate?: string) {
  const supabase = createClient();

  const query = applyDateFilters(
    supabase
      .from('page_revisions')
      .select('id, page_id, author_id, version, revision_type, created_at, content, author:profiles(full_name)')
      .eq('page_id', pageId)
      .order('version', { ascending: false })
      .limit(1000),
    startDate,
    endDate
  );

  const { data, error } = await query;
  if (error) return { error: error.message } as const;

  const { data: pageRow } = await supabase.from('pages').select('version').eq('id', pageId).single();
  const currentVersion = pageRow?.version ?? null;
  const currentContent = await getFullPageContent(pageId);

  const revisions = (data || []).map((r: any) => ({
    ...r,
    has_changes: computeHasChanges(r, currentContent, currentVersion),
  }));

  return { ...paginate(revisions, page), currentVersion };
}

export async function listPostRevisions(postId: number, page = 1, startDate?: string, endDate?: string) {
  const supabase = createClient();

  const query = applyDateFilters(
    supabase
      .from('post_revisions')
      .select('id, post_id, author_id, version, revision_type, created_at, content, author:profiles(full_name)')
      .eq('post_id', postId)
      .order('version', { ascending: false })
      .limit(1000),
    startDate,
    endDate
  );

  const { data, error } = await query;
  if (error) return { error: error.message } as const;

  const { data: postRow } = await supabase.from('posts').select('version').eq('id', postId).single();
  const currentVersion = postRow?.version ?? null;
  const currentContent = await getFullPostContent(postId);

  const revisions = (data || []).map((r: any) => ({
    ...r,
    has_changes: computeHasChanges(r, currentContent, currentVersion),
  }));

  return { ...paginate(revisions, page), currentVersion };
}

export async function listProductRevisions(productId: string, page = 1, startDate?: string, endDate?: string) {
  const supabase = createClient();

  const query = applyDateFilters(
    (supabase as any)
      .from('product_revisions')
      .select('id, product_id, author_id, version, revision_type, created_at, content, author:profiles(full_name)')
      .eq('product_id', productId)
      .order('version', { ascending: false })
      .limit(1000),
    startDate,
    endDate
  );

  const { data, error } = await query;
  if (error) return { error: error.message } as const;

  const { data: productRow } = await (supabase as any)
    .from('products')
    .select('version')
    .eq('id', productId)
    .single();
  const currentVersion = productRow?.version ?? null;
  const currentContent = await getFullProductContent(productId);

  const revisions = (data || []).map((r: any) => ({
    ...r,
    has_changes: computeHasChanges(r, currentContent, currentVersion),
  }));

  return { ...paginate(revisions, page), currentVersion };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function requireUserId() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function restorePageVersion(pageId: number, targetVersion: number) {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  const supabase = createClient();
  const { data: before } = await supabase.from('pages').select('slug').eq('id', pageId).single();

  const result = await restorePageToVersion(pageId, targetVersion, userId);
  if ('error' in result) return result;

  const { data: after } = await supabase.from('pages').select('slug').eq('id', pageId).single();

  revalidatePath('/cms/pages');
  revalidatePath(`/cms/pages/${pageId}/edit`);
  revalidatePath('/', 'layout');
  if (before?.slug) revalidatePath(`/${before.slug}`);
  if (after?.slug && after.slug !== before?.slug) revalidatePath(`/${after.slug}`);
  revalidatePublicContent('pages');

  return result;
}

export async function restorePostVersion(postId: number, targetVersion: number) {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  const supabase = createClient();
  const { data: before } = await supabase.from('posts').select('slug').eq('id', postId).single();

  const result = await restorePostToVersion(postId, targetVersion, userId);
  if ('error' in result) return result;

  const { data: after } = await supabase.from('posts').select('slug').eq('id', postId).single();

  revalidatePath('/cms/posts');
  revalidatePath(`/cms/posts/${postId}/edit`);
  // Public post routes are /article/<slug> (singular) — see getPublicPath in
  // lib/visual-editing/draft-content.ts. The listing lives at the seeded /articles page.
  revalidatePath('/articles');
  if (before?.slug) revalidatePath(`/article/${before.slug}`);
  if (after?.slug && after.slug !== before?.slug) revalidatePath(`/article/${after.slug}`);
  revalidatePublicContent('posts');

  return result;
}

export async function restoreProductVersion(productId: string, targetVersion: number) {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  // products_update_policy is is_admin()-only. Without this check a WRITER would get an
  // UPDATE matching zero rows, which PostgREST reports as success — a restore that
  // silently did nothing.
  const supabase = createClient();
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', userId).single();
  if (profile?.role !== 'ADMIN') {
    return { error: 'Only an administrator can restore a product version.' } as const;
  }

  const { data: before } = await (supabase as any)
    .from('products').select('slug').eq('id', productId).single();

  const result = await restoreProductToVersion(productId, targetVersion, userId);
  if ('error' in result) return result;

  const { data: after } = await (supabase as any)
    .from('products').select('slug').eq('id', productId).single();

  revalidatePath('/cms/products');
  revalidatePath(`/cms/products/${productId}/edit`);
  // Public product routes are /product/<slug> (singular) — see getProductPublicPath in
  // lib/visual-editing/product-drafts.ts.
  if (before?.slug) revalidatePath(`/product/${before.slug}`);
  if (after?.slug && after.slug !== before?.slug) revalidatePath(`/product/${after.slug}`);

  return result;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

type CompareResponse<T> = { success: true; current: T; target: T } | { error: string };

export async function comparePageVersion(pageId: number, targetVersion: number): Promise<CompareResponse<FullPageContent>> {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  const current = await getFullPageContent(pageId);
  if (!current) return { error: 'Failed to fetch current content.' } as const;
  const reconstructed = await reconstructPageVersionContent(pageId, targetVersion);
  if ('error' in reconstructed) return { error: reconstructed.error } as const;
  return { success: true as const, current, target: reconstructed.content };
}

export async function comparePostVersion(postId: number, targetVersion: number): Promise<CompareResponse<FullPostContent>> {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  const current = await getFullPostContent(postId);
  if (!current) return { error: 'Failed to fetch current content.' } as const;
  const reconstructed = await reconstructPostVersionContent(postId, targetVersion);
  if ('error' in reconstructed) return { error: reconstructed.error } as const;
  return { success: true as const, current, target: reconstructed.content };
}

export async function compareProductVersion(productId: string, targetVersion: number): Promise<CompareResponse<FullProductContent>> {
  const userId = await requireUserId();
  if (!userId) return { error: 'User not authenticated.' } as const;

  const current = await getFullProductContent(productId);
  if (!current) return { error: 'Failed to fetch current content.' } as const;
  const reconstructed = await reconstructProductVersionContent(productId, targetVersion);
  if ('error' in reconstructed) return { error: reconstructed.error } as const;
  return { success: true as const, current, target: reconstructed.content };
}
