/**
 * Block-level diff between the published storefront and the submitted draft, for the admin review
 * screen: a longest common subsequence over top-level blocks compared as key-sorted JSON.
 */
import type { StorefrontBlockDiff, StorefrontBlockDiffStatus, StorefrontDoc } from './types';

type JsonRecord = Record<string, unknown>;

/** Above this many DP cells (unsanitized giants only) the middle is paired by position instead. */
const MAX_LCS_CELLS = 1_000_000;
const MAX_KEY_DEPTH = 32;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function topLevelBlocks(doc: unknown): readonly unknown[] {
  if (!isRecord(doc) || !Object.prototype.hasOwnProperty.call(doc, 'content')) return [];
  const content = doc['content'];
  return Array.isArray(content) ? content : [];
}

/** JSON with object keys sorted, so key order never makes two equal blocks differ. */
function stableKey(value: unknown, depth: number): string {
  if (depth > MAX_KEY_DEPTH) return '"…"';
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return '"?"';
    }
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => stableKey(item, depth + 1)).join(',')}]`;
  const record = value as JsonRecord;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(record[key], depth + 1)}`).join(',')}}`;
}

/** Index pairs [published, draft] of a longest common subsequence, ascending in both. */
function matchBlocks(published: readonly string[], draft: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < published.length && start < draft.length && published[start] === draft[start]) {
    pairs.push([start, start]);
    start += 1;
  }
  let publishedEnd = published.length;
  let draftEnd = draft.length;
  const suffix: Array<[number, number]> = [];
  while (publishedEnd > start && draftEnd > start && published[publishedEnd - 1] === draft[draftEnd - 1]) {
    publishedEnd -= 1;
    draftEnd -= 1;
    suffix.push([publishedEnd, draftEnd]);
  }
  const rows = publishedEnd - start;
  const columns = draftEnd - start;
  if (rows > 0 && columns > 0 && rows * columns <= MAX_LCS_CELLS) {
    const width = columns + 1;
    // table[i * width + j] = LCS length of published[start + i..] and draft[start + j..].
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          published[start + i] === draft[start + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (published[start + i] === draft[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  for (let index = suffix.length - 1; index >= 0; index -= 1) {
    const pair = suffix[index];
    if (pair) pairs.push(pair);
  }
  return pairs;
}

/**
 * One status per top-level DRAFT block: `unchanged` (in the common subsequence), `changed` (paired
 * with a different published block in the same gap between unchanged blocks) or `added`;
 * `removedCount` counts published blocks left without a draft counterpart. A missing or empty
 * published document makes every draft block `added`.
 */
export function diffStorefrontBlocks(published: StorefrontDoc | null, draft: StorefrontDoc): StorefrontBlockDiff {
  const draftKeys = topLevelBlocks(draft).map((block) => stableKey(block, 0));
  const publishedKeys = topLevelBlocks(published).map((block) => stableKey(block, 0));
  const statuses: StorefrontBlockDiffStatus[] = draftKeys.map(() => 'added');
  if (publishedKeys.length === 0) return { statuses, removedCount: 0 };
  let removedCount = 0;
  let previousPublished = -1;
  let previousDraft = -1;
  const settleGap = (nextPublished: number, nextDraft: number): void => {
    const publishedGap = nextPublished - previousPublished - 1;
    const draftGap = nextDraft - previousDraft - 1;
    const paired = Math.min(publishedGap, draftGap);
    for (let offset = 0; offset < draftGap; offset += 1) {
      statuses[previousDraft + 1 + offset] = offset < paired ? 'changed' : 'added';
    }
    removedCount += Math.max(0, publishedGap - draftGap);
  };
  for (const [publishedIndex, draftIndex] of matchBlocks(publishedKeys, draftKeys)) {
    settleGap(publishedIndex, draftIndex);
    statuses[draftIndex] = 'unchanged';
    previousPublished = publishedIndex;
    previousDraft = draftIndex;
  }
  settleGap(publishedKeys.length, draftKeys.length);
  return { statuses, removedCount };
}
