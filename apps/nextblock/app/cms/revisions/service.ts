// apps/nextblock/app/cms/revisions/service.ts
//
// Not a server action: callers pass the author id and, for bearer-authenticated routes, the
// client, so every export would let a POST choose both. Server actions (./actions.ts) and
// routes call it after their own auth check, with the author taken from that check.
import "server-only";

import { createClient } from "@nextblock-cms/db/server";
import type { Json } from "@nextblock-cms/db";
import { compare, applyPatch } from 'fast-json-patch';
import {
  PAGE_META_COLUMNS,
  POST_META_COLUMNS,
  PRODUCT_META_COLUMNS,
  buildRestoreMetaUpdate,
  getFullPageContent,
  getFullPostContent,
  getFullProductContent,
} from './utils';
import type {
  AnyFullContent,
  FullPageContent,
  FullPostContent,
  FullProductContent,
} from './utils';

/** A full snapshot is stored whenever this many versions have accumulated since the last one. */
const SNAPSHOT_INTERVAL = 20;

export type RevisionParentType = 'page' | 'post' | 'product';

export type RevisionResult =
  | { success: true; version: number; recorded: boolean }
  | { error: string };

export type RestoreResult =
  | { success: true; version: number }
  | { error: string };

export type ReconstructResult<T> =
  | { success: true; content: T }
  | { error: string };

/**
 * Everything that differs between pages, posts and products. Keeping one implementation
 * behind this table is deliberate: the previous copy-per-entity version had drifted so far
 * that the page and post restore paths no longer agreed on which columns they wrote.
 */
interface RevisionSpec {
  parentTable: 'pages' | 'posts' | 'products';
  revisionTable: 'page_revisions' | 'post_revisions' | 'product_revisions';
  parentColumn: 'page_id' | 'post_id' | 'product_id';
  metaColumns: readonly string[];
  label: string;
  draft: { table: 'content_drafts'; parentType: 'page' | 'post' } | { table: 'product_drafts' };
}

const PAGE_SPEC: RevisionSpec = {
  parentTable: 'pages',
  revisionTable: 'page_revisions',
  parentColumn: 'page_id',
  metaColumns: PAGE_META_COLUMNS,
  label: 'Page',
  draft: { table: 'content_drafts', parentType: 'page' },
};

const POST_SPEC: RevisionSpec = {
  parentTable: 'posts',
  revisionTable: 'post_revisions',
  parentColumn: 'post_id',
  metaColumns: POST_META_COLUMNS,
  label: 'Post',
  draft: { table: 'content_drafts', parentType: 'post' },
};

const PRODUCT_SPEC: RevisionSpec = {
  parentTable: 'products',
  revisionTable: 'product_revisions',
  parentColumn: 'product_id',
  metaColumns: PRODUCT_META_COLUMNS,
  label: 'Product',
  draft: { table: 'product_drafts' },
};

function specFor(parentType: RevisionParentType): RevisionSpec {
  if (parentType === 'page') return PAGE_SPEC;
  if (parentType === 'post') return POST_SPEC;
  return PRODUCT_SPEC;
}

/** Postgres unique-violation. Concurrent saves race for the same version number. */
const UNIQUE_VIOLATION = '23505';

type Db = any;

async function readParentVersion(
  supabase: Db,
  spec: RevisionSpec,
  parentId: number | string
): Promise<number | null> {
  const { data, error } = await supabase
    .from(spec.parentTable)
    .select('version')
    .eq('id', parentId)
    .single();
  if (error || !data) return null;
  return (data.version as number | null) ?? 1;
}

/** The newest stored snapshot at or below `maxVersion`, or null if the chain has no base. */
async function findBaseSnapshot(
  supabase: Db,
  spec: RevisionSpec,
  parentId: number | string,
  maxVersion: number
): Promise<{ version: number; content: unknown } | null> {
  const { data } = await supabase
    .from(spec.revisionTable)
    .select('version, content')
    .eq(spec.parentColumn, parentId)
    .lte('version', maxVersion)
    .eq('revision_type', 'snapshot')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { version: data.version as number, content: data.content } : null;
}

/**
 * Guarantee the diff chain has a snapshot to replay onto.
 *
 * A diff is only meaningful relative to a base. The old implementation wrote that base
 * exactly once — on the 1 -> 2 transition — and discarded the insert's error, so any page
 * that missed that single moment (RLS rejection, a version bumped by another code path,
 * content seeded straight into the table) accumulated diffs forever with nothing beneath
 * them. Checking the invariant on every write instead means such a chain repairs itself on
 * the next save.
 */
async function ensureBaseSnapshot(
  supabase: Db,
  spec: RevisionSpec,
  parentId: number | string,
  authorId: string | null,
  currentVersion: number,
  currentContent: AnyFullContent
): Promise<{ version: number } | { error: string }> {
  const existing = await findBaseSnapshot(supabase, spec, parentId, currentVersion);
  if (existing) return { version: existing.version };

  const { error } = await supabase.from(spec.revisionTable).insert({
    [spec.parentColumn]: parentId,
    author_id: authorId,
    version: currentVersion,
    revision_type: 'snapshot',
    content: currentContent as unknown as Json,
  });

  if (error) {
    // Another writer inserted this version first; theirs is just as valid a base.
    if (error.code === UNIQUE_VIOLATION) return { version: currentVersion };
    return { error: `Failed to record the baseline revision: ${error.message}` };
  }

  return { version: currentVersion };
}

async function lastSnapshotVersion(
  supabase: Db,
  spec: RevisionSpec,
  parentId: number | string
): Promise<number> {
  const { data } = await supabase
    .from(spec.revisionTable)
    .select('version')
    .eq(spec.parentColumn, parentId)
    .eq('revision_type', 'snapshot')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.version as number | undefined) ?? 0;
}

/**
 * Record the transition from `previousContent` to `newContent` as a new revision.
 *
 * Returns `recorded: false` when the two states are identical — that is a successful
 * no-op, not a failure, and it deliberately does not consume a version number.
 */
async function createRevisionInternal(
  spec: RevisionSpec,
  parentId: number | string,
  authorId: string | null,
  previousContent: AnyFullContent,
  newContent: AnyFullContent,
  client?: Db
): Promise<RevisionResult> {
  const supabase: Db = client ?? createClient();

  const currentVersion = await readParentVersion(supabase, spec, parentId);
  if (currentVersion === null) return { error: `${spec.label} not found` };

  // Nothing changed. Checked before the snapshot decision so a no-op publish can never
  // burn a version number or write a redundant full snapshot.
  const ops = compare(previousContent as object, newContent as object);
  if (ops.length === 0) {
    return { success: true, version: currentVersion, recorded: false };
  }

  const base = await ensureBaseSnapshot(
    supabase, spec, parentId, authorId, currentVersion, previousContent
  );
  if ('error' in base) return { error: base.error };

  const nextVersion = currentVersion + 1;
  const lastSnapshot = await lastSnapshotVersion(supabase, spec, parentId);

  // A diff is only meaningful if replaying the existing chain actually reproduces the
  // document this diff was computed against. Counting version numbers is not enough:
  // writes that bypass the revision engine (a live-mode import, a script) change content
  // without consuming a version, leaving a chain that looks contiguous but no longer
  // represents the live state. Replaying it here is the only honest check — and when it
  // disagrees, a full snapshot silently repairs the chain from this point on.
  let makeSnapshot = nextVersion - lastSnapshot >= SNAPSHOT_INTERVAL;
  if (!makeSnapshot) {
    const replay = await reconstructInternal(spec, parentId, currentVersion, supabase);
    makeSnapshot =
      'error' in replay ||
      compare(replay.content as object, previousContent as object).length > 0;
  }

  const insertAt = async (version: number, asSnapshot: boolean) =>
    supabase.from(spec.revisionTable).insert({
      [spec.parentColumn]: parentId,
      author_id: authorId,
      version,
      revision_type: asSnapshot ? 'snapshot' : 'diff',
      content: (asSnapshot ? (newContent as unknown as Json) : (ops as unknown as Json)),
    });

  let targetVersion = nextVersion;
  let { error: insertError } = await insertAt(targetVersion, makeSnapshot);

  // Whoever wins the UNIQUE(parent_id, version) insert owns that version number. If we
  // lost the race, re-read and take the next one — but store the full document rather
  // than the diff, because the winner has moved the chain past the base our ops assumed.
  if (insertError?.code === UNIQUE_VIOLATION) {
    const refreshed = await readParentVersion(supabase, spec, parentId);
    targetVersion = (refreshed ?? currentVersion) + 1;
    ({ error: insertError } = await insertAt(targetVersion, true));
  }

  if (insertError) {
    return { error: `Failed to insert ${spec.label.toLowerCase()} revision: ${insertError.message}` };
  }

  // The revision row is written before the version bump on purpose: a crash between the
  // two leaves a recoverable extra revision, whereas the old order left the parent
  // pointing at a version that had no history behind it.
  const { error: bumpError } = await supabase
    .from(spec.parentTable)
    .update({ version: targetVersion })
    .eq('id', parentId);
  if (bumpError) {
    return { error: `Failed to bump ${spec.label.toLowerCase()} version: ${bumpError.message}` };
  }

  return { success: true, version: targetVersion, recorded: true };
}

/**
 * Resolve the exact content stored at `targetVersion` by replaying diffs onto the nearest
 * snapshot at or below it.
 *
 * There is deliberately no fallback for a missing baseline. The previous implementation
 * fabricated version 1 as "current metadata plus zero blocks" whenever no snapshot existed,
 * which made Restore delete every block on the page and report success. An honest error is
 * the correct answer; migration 00000000000016 backfills a real baseline so the error is
 * also rare.
 */
async function reconstructInternal<T extends AnyFullContent>(
  spec: RevisionSpec,
  parentId: number | string,
  targetVersion: number,
  client?: Db
): Promise<ReconstructResult<T>> {
  const supabase: Db = client ?? createClient();

  const snapshot = await findBaseSnapshot(supabase, spec, parentId, targetVersion);
  if (!snapshot) {
    return {
      error: `No stored snapshot exists at or before version ${targetVersion}, so this version cannot be reconstructed.`,
    };
  }

  let content = snapshot.content as T;

  if (snapshot.version < targetVersion) {
    const { data: diffs, error: diffsError } = await supabase
      .from(spec.revisionTable)
      .select('version, content, revision_type')
      .eq(spec.parentColumn, parentId)
      .gt('version', snapshot.version)
      .lte('version', targetVersion)
      .order('version', { ascending: true });
    if (diffsError) return { error: `Failed to fetch diffs: ${diffsError.message}` };

    for (const r of diffs || []) {
      if (r.revision_type === 'diff') {
        const patchOps = r.content as unknown[];
        if (!Array.isArray(patchOps)) {
          return { error: `Revision history is corrupted at version ${r.version}.` };
        }
        try {
          const result = applyPatch(content as object, patchOps as any, /* validate */ false, /* mutateDocument */ true);
          content = result.newDocument as unknown as T;
        } catch (e) {
          return {
            error: `Revision history is corrupted at version ${r.version}: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      } else {
        content = r.content as T;
      }
    }
  }

  if (!content || typeof content !== 'object' || !(content as AnyFullContent).meta) {
    return { error: `Version ${targetVersion} is missing its content payload.` };
  }

  return { success: true, content };
}

async function deleteDraftFor(supabase: Db, spec: RevisionSpec, parentId: number | string) {
  // A surviving draft row would be overlaid on top of the restored content by the editor,
  // making the restore look like it silently failed — and the next Publish would replay the
  // stale draft straight back over it.
  if (spec.draft.table === 'content_drafts') {
    await supabase
      .from('content_drafts')
      .delete()
      .eq('parent_type', spec.draft.parentType)
      .eq('parent_id', parentId);
  } else {
    await supabase.from('product_drafts').delete().eq('product_id', parentId);
  }
}

async function restoreInternal(
  spec: RevisionSpec,
  parentId: number | string,
  targetVersion: number,
  authorId: string | null,
  client?: Db
): Promise<RestoreResult> {
  const supabase: Db = client ?? createClient();

  const reconstructed = await reconstructInternal(spec, parentId, targetVersion, supabase);
  if ('error' in reconstructed) return { error: reconstructed.error };
  const content = reconstructed.content;

  const blocks = Array.isArray(content.blocks) ? content.blocks : null;
  if (!blocks) {
    return { error: `Version ${targetVersion} has no block list and cannot be restored.` };
  }

  // Build and validate the whole block payload before touching anything, so a malformed
  // revision cannot leave the page emptied out between the delete and the insert.
  const blockPayload = blocks.map((b, index) => ({
    page_id: spec.parentColumn === 'page_id' ? parentId : null,
    post_id: spec.parentColumn === 'post_id' ? parentId : null,
    product_id: spec.parentColumn === 'product_id' ? parentId : null,
    language_id: b.language_id,
    block_type: b.block_type,
    content: b.content,
    order: Number.isFinite(b.order) ? b.order : index,
  }));

  if (blockPayload.some(b => typeof b.block_type !== 'string' || typeof b.language_id !== 'number')) {
    return { error: `Version ${targetVersion} contains malformed blocks and was not restored.` };
  }

  const metaUpdate = buildRestoreMetaUpdate(
    content.meta as unknown as Record<string, unknown>,
    spec.metaColumns
  );
  if (Object.keys(metaUpdate).length === 0) {
    return { error: `Version ${targetVersion} has no restorable metadata.` };
  }

  const { error: updateError } = await supabase
    .from(spec.parentTable)
    .update(metaUpdate)
    .eq('id', parentId);
  if (updateError) {
    return { error: `Failed to update ${spec.label.toLowerCase()}: ${updateError.message}` };
  }

  // Kept so the block swap can be rolled back if the reinsert fails.
  const { data: previousBlocks } = await supabase
    .from('blocks')
    .select('page_id, post_id, product_id, language_id, block_type, content, order')
    .eq(spec.parentColumn, parentId)
    .order('order', { ascending: true })
    .order('id', { ascending: true });

  // Carry contact-form routing across the restore.
  //
  // A snapshot taken before migration 27 stores `recipient_email` and no `form_key`.
  // Restoring it verbatim would strand the form: the renderer strips the legacy address
  // (so nothing leaks), but with no key the submission falls back to the site-wide
  // contact address, losing whatever per-form destination the owner had configured.
  // Reuse the key from the live block being replaced, matched positionally.
  const liveFormKeys = ((previousBlocks ?? []) as Array<{ block_type: string; content: unknown }>)
    .filter((block) => block.block_type === 'form')
    .map((block) => (block.content as Record<string, unknown> | null)?.['form_key'])
    .filter((key): key is string => typeof key === 'string' && key.length > 0);

  for (const block of blockPayload as Array<{ block_type?: string; content?: unknown }>) {
    if (block.block_type !== 'form') continue;
    const content = (block.content ?? {}) as Record<string, unknown>;
    if (typeof content['form_key'] === 'string' && content['form_key']) continue;
    const inherited = liveFormKeys.shift();
    if (inherited) block.content = { ...content, form_key: inherited };
  }

  const { error: deleteError } = await supabase
    .from('blocks')
    .delete()
    .eq(spec.parentColumn, parentId);
  if (deleteError) return { error: `Failed to clear blocks: ${deleteError.message}` };

  if (blockPayload.length > 0) {
    const { error: insertError } = await supabase.from('blocks').insert(blockPayload);
    if (insertError) {
      if (previousBlocks && previousBlocks.length > 0) {
        await supabase.from('blocks').insert(previousBlocks);
      }
      return { error: `Failed to insert blocks: ${insertError.message}` };
    }
  }

  await deleteDraftFor(supabase, spec, parentId);

  // Record the restored state as a new snapshot so history stays append-only: restoring is
  // itself an edit, and the version you restored from remains reachable.
  const currentVersion = (await readParentVersion(supabase, spec, parentId)) ?? 1;
  let newVersion = currentVersion + 1;

  const insertRestoreSnapshot = async (version: number) =>
    supabase.from(spec.revisionTable).insert({
      [spec.parentColumn]: parentId,
      author_id: authorId,
      version,
      revision_type: 'snapshot',
      content: content as unknown as Json,
    });

  let { error: revError } = await insertRestoreSnapshot(newVersion);

  // A revision can already occupy that number — a previous publish whose version bump
  // failed leaves exactly that shape. Take the next free one instead of swallowing the
  // collision, which would leave the parent pointing at somebody else's document.
  if (revError?.code === UNIQUE_VIOLATION) {
    const refreshed = await readParentVersion(supabase, spec, parentId);
    newVersion = Math.max(refreshed ?? newVersion, newVersion) + 1;
    ({ error: revError } = await insertRestoreSnapshot(newVersion));
  }

  if (revError) {
    return { error: `Restored, but failed to record the new revision: ${revError.message}` };
  }

  const { error: bumpError } = await supabase
    .from(spec.parentTable)
    .update({ version: newVersion })
    .eq('id', parentId);
  if (bumpError) {
    return { error: `Restored, but failed to bump the version: ${bumpError.message}` };
  }

  return { success: true, version: newVersion };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createPageRevision(
  pageId: number,
  authorId: string | null,
  previousContent: FullPageContent,
  newContent: FullPageContent,
  client?: unknown
): Promise<RevisionResult> {
  return createRevisionInternal(PAGE_SPEC, pageId, authorId, previousContent, newContent, client);
}

export async function createPostRevision(
  postId: number,
  authorId: string | null,
  previousContent: FullPostContent,
  newContent: FullPostContent,
  client?: unknown
): Promise<RevisionResult> {
  return createRevisionInternal(POST_SPEC, postId, authorId, previousContent, newContent, client);
}

export async function createProductRevision(
  productId: string,
  authorId: string | null,
  previousContent: FullProductContent,
  newContent: FullProductContent,
  client?: unknown
): Promise<RevisionResult> {
  return createRevisionInternal(PRODUCT_SPEC, productId, authorId, previousContent, newContent, client);
}

export async function restorePageToVersion(pageId: number, targetVersion: number, authorId: string | null) {
  return restoreInternal(PAGE_SPEC, pageId, targetVersion, authorId);
}

export async function restorePostToVersion(postId: number, targetVersion: number, authorId: string | null) {
  return restoreInternal(POST_SPEC, postId, targetVersion, authorId);
}

export async function restoreProductToVersion(productId: string, targetVersion: number, authorId: string | null) {
  return restoreInternal(PRODUCT_SPEC, productId, targetVersion, authorId);
}

export async function reconstructPageVersionContent(pageId: number, targetVersion: number) {
  return reconstructInternal<FullPageContent>(PAGE_SPEC, pageId, targetVersion);
}

export async function reconstructPostVersionContent(postId: number, targetVersion: number) {
  return reconstructInternal<FullPostContent>(POST_SPEC, postId, targetVersion);
}

export async function reconstructProductVersionContent(productId: string, targetVersion: number) {
  return reconstructInternal<FullProductContent>(PRODUCT_SPEC, productId, targetVersion);
}

/**
 * Record a revision for a live write made outside the draft pipeline — Cortex AI tools,
 * imports, scripted edits.
 *
 * Two-phase so callers never have to know the snapshot shape: capture before the write,
 * commit after it. The captured state is returned opaquely and handed straight back.
 */
export async function captureRevisionBaseline(
  parentType: RevisionParentType,
  parentId: number | string,
  client?: unknown
): Promise<AnyFullContent | null> {
  const supabase = (client ?? createClient()) as any;
  if (parentType === 'page') return getFullPageContent(Number(parentId), undefined, supabase);
  if (parentType === 'post') return getFullPostContent(Number(parentId), undefined, supabase);
  return getFullProductContent(String(parentId), undefined, supabase);
}

export async function commitRevisionFromBaseline(
  parentType: RevisionParentType,
  parentId: number | string,
  authorId: string | null,
  baseline: AnyFullContent | null,
  client?: unknown
): Promise<RevisionResult> {
  if (!baseline) return { error: 'No baseline was captured before the write.' };
  const supabase = (client ?? createClient()) as any;
  const next = await captureRevisionBaseline(parentType, parentId, supabase);
  if (!next) return { error: 'Failed to read the content back after the write.' };
  return createRevisionInternal(specFor(parentType), parentId, authorId, baseline, next, supabase);
}
