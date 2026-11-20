import 'server-only';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { ownedMediaStorageKeys } from '../storage/media-object-keys';
import { isAcceptableClientObjectKey } from '../storage/upload-policy';
import { MEDIA_USAGE_UNCHECKED_KIND, parseMediaUsageAnswer, type MediaUsage } from './media-usage-format';

/** A media row as the lookup reads it. */
export interface MediaUsageSubject {
  id: string;
  object_key?: unknown;
  variants?: unknown;
}

const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The most storage keys the lookup searches for one row: its object_key and 16 variants. A real upload
 * owns 6 to 8 (the original, five sizes and an AVIF copy of the original).
 */
export const MAX_SEARCHED_KEYS_PER_MEDIA_ROW = 17;

/**
 * Media rows asked about per call of public.media_usage. The library's "Unused files" view asks about
 * every file it lists, and it lists past PostgREST's 1000 rows since it pages its read: batches keep
 * each call one statement of bounded size (a library of 3000 files makes six calls).
 */
export const MEDIA_USAGE_BATCH_SIZE = 500;

/**
 * The keys to search for a row: every key its delete would remove (ownedMediaStorageKeys), or null when
 * the lookup cannot search them all. Anyone with staff access can write a row's object_key and variants
 * (RLS lets a WRITER insert their own row over PostgREST, and nothing checks the keys there), so they are
 * search strings chosen by the row's author, sent with the service role:
 *  - only keys the upload routes could mint (isAcceptableClientObjectKey: [A-Za-z0-9._/-] and a media
 *    extension). public.media_usage matches those as whole tokens, so a key with any other character
 *    could only be found by a substring search of every document, a probe of documents the author
 *    cannot read and a full scan per key; the function no longer runs one;
 *  - no two spellings of one key (equal ignoring case): the extension and variant label are read in any
 *    case, so one row could list thousands of spellings, and searching one spelling of a pair would
 *    search less than the delete removes;
 *  - at most MAX_SEARCHED_KEYS_PER_MEDIA_ROW keys.
 * A row that breaks any rule is still asked about by id, and findMediaUsage reports it as not checked.
 */
function searchableStorageKeys(row: MediaUsageSubject): string[] | null {
  const keys = ownedMediaStorageKeys(row);
  if (keys.length > MAX_SEARCHED_KEYS_PER_MEDIA_ROW) {
    return null;
  }
  const spellings = new Set<string>();
  for (const key of keys) {
    const folded = key.toLowerCase();
    if (!isAcceptableClientObjectKey(key, { requireAllowedExtension: true }) || spellings.has(folded)) {
      return null;
    }
    spellings.add(folded);
  }
  return keys;
}

/** The usage of a row whose keys were not searched: counted as a use, and named first in the list. */
function withUncheckedStorageKeys(usage: MediaUsage, mediaId: string): MediaUsage {
  return {
    total: usage.total + 1,
    byKind: { ...usage.byKind, [MEDIA_USAGE_UNCHECKED_KIND]: 1 },
    sites: [
      { kind: MEDIA_USAGE_UNCHECKED_KIND, recordId: mediaId, parentType: null, parentId: null, label: null, language: null },
      ...usage.sites,
    ],
  };
}

/**
 * Where each media row is used: public.media_usage (migration 02045), asked for every row's id and
 * the storage keys a delete would remove (ownedMediaStorageKeys: the row's object_key and the
 * variants of the same upload), keyed by lowercased id.
 *
 * Read with the service role, which bypasses RLS: the function reads every content table (drafts,
 * revisions, partner pages, site settings), and an answer limited to what RLS lets the caller see
 * would call a used image unused. So the caller's own check IS the authorization: call this only
 * after getCmsActor() has found staff past their second factor (the media actions and pages do), and
 * show a caller other than an ADMIN the answer through withoutAdminOnlyLabels.
 *
 * A row whose keys cannot all be searched (searchableStorageKeys) is asked about by id alone and
 * answered with one more use, MEDIA_USAGE_UNCHECKED_KIND: it is never "unused", and the rest of the
 * batch is answered as usual.
 *
 * Throws when the lookup cannot run or answers in another shape (parseMediaUsageAnswer): a caller
 * never reads a failed lookup as "unused". A lookup, not a proof: a reference outside the database
 * (another site, a sent email, a cached social preview) is invisible to it.
 */
export async function findMediaUsage(rows: readonly MediaUsageSubject[]): Promise<Map<string, MediaUsage>> {
  const input: Record<string, string[]> = {};
  const unchecked = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === 'string' && MEDIA_ID_PATTERN.test(row.id)) {
      const id = row.id.toLowerCase();
      const keys = searchableStorageKeys(row);
      if (keys === null) {
        unchecked.add(id);
      }
      input[id] = unchecked.has(id) ? [] : (keys ?? []);
    }
  }

  const ids = Object.keys(input);
  if (ids.length === 0) {
    return new Map();
  }

  // The function arrives with migration 02045; cast past the generated types until `npm run
  // db:types` is regenerated against a database that has it.
  const service = getServiceRoleSupabaseClient() as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  // All or nothing: any batch that fails throws, so no caller reads part of the answer as the whole.
  const usage = new Map<string, MediaUsage>();
  for (let start = 0; start < ids.length; start += MEDIA_USAGE_BATCH_SIZE) {
    const batchIds = ids.slice(start, start + MEDIA_USAGE_BATCH_SIZE);
    const batch: Record<string, string[]> = {};
    for (const id of batchIds) batch[id] = input[id] ?? [];
    const { data, error } = await service.rpc('media_usage', { p_media: batch });
    if (error) {
      throw new Error(`Where this media is used could not be checked: ${error.message}`);
    }

    try {
      for (const [id, entry] of parseMediaUsageAnswer(data, batchIds)) usage.set(id, entry);
    } catch (parseError) {
      const reason = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(`Where this media is used could not be checked: ${reason}.`);
    }
  }

  for (const id of unchecked) {
    const entry = usage.get(id);
    if (entry) {
      usage.set(id, withUncheckedStorageKeys(entry, id));
    }
  }
  return usage;
}
