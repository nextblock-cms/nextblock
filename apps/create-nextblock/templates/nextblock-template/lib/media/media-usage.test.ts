import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * findMediaUsage asks public.media_usage (02045) with the service role for each row's id and the
 * keys its delete would remove (ownedMediaStorageKeys), and throws rather than answer a failed or
 * partial lookup: its callers decide "unused" from it.
 *
 * Any staff member can write a media row's keys (a WRITER inserts their own row over PostgREST), so
 * they are search strings chosen by the row's author. Only keys the upload routes could mint are sent,
 * no two spellings of one key and at most 17 a row; a row breaking a rule is asked about by id alone
 * and answered as not checked, so it is never "unused" (2026-11-18 review: such keys took the
 * function's substring search, a probe of documents the author cannot read, and one row listing
 * thousands of spellings made every lookup that included it time out).
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({ rpc: mocks.rpc }),
}));

import { MAX_OBJECT_KEY_LENGTH } from '../storage/upload-policy';
import { MAX_SEARCHED_KEYS_PER_MEDIA_ROW, MEDIA_USAGE_BATCH_SIZE, findMediaUsage } from './media-usage';
import { isMediaUnused, summarizeMediaUsage, type MediaUsage } from './media-usage-format';

const A = 'a1111111-1111-4111-8111-11111111111a';
const B = 'b2222222-2222-4222-8222-22222222222b';
const C = 'c3333333-3333-4333-8333-33333333333c';
const D = 'd4444444-4444-4444-8444-44444444444d';
const E = 'e5555555-5555-4555-8555-55555555555e';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../libs/db/src/supabase/migrations');
const GENERATED_TYPES_FILE = path.resolve(__dirname, '../../../../libs/db/src/lib/supabase/types.ts');

/** Every case spelling of a word ('ab' → ab, aB, Ab, AB). */
function spellings(word: string): string[] {
  let out = [''];
  for (const ch of word) {
    out = out.flatMap((prefix) =>
      ch.toLowerCase() === ch.toUpperCase() ? [prefix + ch] : [prefix + ch.toLowerCase(), prefix + ch.toUpperCase()]
    );
  }
  return out;
}

/** The rpc answers total 0 for every id it is asked about, unless `answers` names it. */
function answerEveryId(answers: Record<string, unknown> = {}) {
  mocks.rpc.mockImplementation(async (_fn: string, args: { p_media: Record<string, string[]> }) => ({
    data: Object.fromEntries(
      Object.keys(args.p_media).map((id) => [id, answers[id] ?? { total: 0, by_kind: {}, sites: [] }])
    ),
    error: null,
  }));
}

/** The keys findMediaUsage sent for one id. */
function sentKeys(id: string): string[] {
  return (mocks.rpc.mock.calls[0][1] as { p_media: Record<string, string[]> }).p_media[id];
}

/** One id's usage, which findMediaUsage must have answered. */
function entry(usage: Map<string, MediaUsage>, id: string): MediaUsage {
  const found = usage.get(id);
  if (!found) throw new Error(`no usage for ${id}`);
  return found;
}

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe('findMediaUsage', () => {
  it("asks once, with each row's lowercased id and owned keys (a decoy's foreign variant is not its own, a partner upload owns nothing)", async () => {
    mocks.rpc.mockResolvedValue({
      data: { [A]: { total: 0, by_kind: {}, sites: [] }, [B]: { total: 0, by_kind: {}, sites: [] } },
      error: null,
    });

    const usage = await findMediaUsage([
      { id: A.toUpperCase(), object_key: 'uploads/a.webp', variants: [{ objectKey: 'uploads/a_large.avif' }, { objectKey: 'uploads/victim_small.avif' }] },
      { id: B, object_key: 'affiliates/avatars/0f8a1c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b/me.jpg', variants: null },
      { id: 'not-a-uuid', object_key: 'uploads/x.webp' },
    ]);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('media_usage', {
      p_media: { [A]: ['uploads/a.webp', 'uploads/a_large.avif'], [B]: [] },
    });
    expect([...usage.keys()]).toEqual([A, B]);
    // Owning nothing is not "not checked": its delete removes no object.
    expect(isMediaUnused(entry(usage, B))).toBe(true);
  });

  it('asks nothing for no rows', async () => {
    await expect(findMediaUsage([])).resolves.toEqual(new Map());
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it(`asks about a library past 1000 files in batches of ${MEDIA_USAGE_BATCH_SIZE}, and answers for every file`, async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 1200 }, (_, n) => ({ id: uuid(n), object_key: `uploads/${n}.webp` }));
    answerEveryId({ [uuid(1199)]: { total: 1, by_kind: { block: 1 }, sites: [] } });

    const usage = await findMediaUsage(rows);

    const batches = mocks.rpc.mock.calls.map((call) => Object.keys((call[1] as { p_media: Record<string, string[]> }).p_media));
    expect(batches.map((ids) => ids.length)).toEqual([500, 500, 200]);
    expect(batches.flat()).toEqual(rows.map((row) => row.id));
    expect(usage.size).toBe(1200);
    expect(isMediaUnused(entry(usage, uuid(0)))).toBe(true);
    expect(isMediaUnused(entry(usage, uuid(1199)))).toBe(false);
  });

  it('throws when any batch fails, so a later batch never reads as unused', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 600 }, (_, n) => ({ id: uuid(n), object_key: `uploads/${n}.webp` }));
    answerEveryId();
    mocks.rpc.mockImplementationOnce(async (_fn: string, args: { p_media: Record<string, string[]> }) => ({
      data: Object.fromEntries(Object.keys(args.p_media).map((id) => [id, { total: 0, by_kind: {}, sites: [] }])),
      error: null,
    }));
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }));

    await expect(findMediaUsage(rows)).rejects.toThrow('could not be checked: canceling statement due to statement timeout');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('throws when the lookup fails, answers another shape, or leaves a row out', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'canceling statement due to statement timeout' } });
    await expect(findMediaUsage([{ id: A, object_key: 'uploads/a.webp' }])).rejects.toThrow(
      'Where this media is used could not be checked: canceling statement due to statement timeout'
    );

    mocks.rpc.mockResolvedValueOnce({ data: [{ id: A }], error: null });
    await expect(findMediaUsage([{ id: A, object_key: 'uploads/a.webp' }])).rejects.toThrow(/could not be checked: the lookup answered/);

    mocks.rpc.mockResolvedValueOnce({ data: { [B]: { total: 0, by_kind: {}, sites: [] } }, error: null });
    await expect(findMediaUsage([{ id: A, object_key: 'uploads/a.webp' }])).rejects.toThrow(/left a media item out/);
  });

  it.each<readonly [string, string, unknown]>([
    ['quotes, a colon and spaces', 'x/"contactEmail": "owner@shop.md', null],
    ['a space', 'uploads/a b.png', [{ objectKey: 'uploads/a b_large.avif' }]],
    ['markup', 'q/<script>.svg', null],
    ['a percent escape', 'uploads/a%20b.png', null],
  ])('sends no key of a row whose key holds %s: it is asked about by id alone and answered as used', async (_label, objectKey, variants) => {
    answerEveryId();

    const usage = await findMediaUsage([
      { id: A, object_key: 'uploads/a.webp', variants: [{ objectKey: 'uploads/a_large.avif' }] },
      { id: B, object_key: objectKey, variants },
    ]);

    expect(sentKeys(B)).toEqual([]);
    expect(sentKeys(A)).toEqual(['uploads/a.webp', 'uploads/a_large.avif']);
    expect(usage.get(B)).toEqual({
      total: 1,
      byKind: { unchecked_key: 1 },
      sites: [{ kind: 'unchecked_key', recordId: B, parentType: null, parentId: null, label: null, language: null }],
    });
    expect(isMediaUnused(entry(usage, B))).toBe(false);
    expect(summarizeMediaUsage(entry(usage, B))).toBe('Could not be fully checked');
    // The rest of the batch keeps its own answer.
    expect(usage.get(A)).toEqual({ total: 0, byKind: {}, sites: [] });
  });

  it('keeps what the id search found for a row whose keys were not searched, and names the gap first', async () => {
    const gallery = { kind: 'product_gallery', record_id: 'p-1', parent_type: 'product', parent_id: 'p-1', label: 'Pro', language: 'en' };
    answerEveryId({ [B]: { total: 1, by_kind: { product_gallery: 1 }, sites: [gallery] } });

    const usage = await findMediaUsage([{ id: B, object_key: 'uploads/a b.png' }]);

    expect(usage.get(B)).toEqual({
      total: 2,
      byKind: { product_gallery: 1, unchecked_key: 1 },
      sites: [
        { kind: 'unchecked_key', recordId: B, parentType: null, parentId: null, label: null, language: null },
        { kind: 'product_gallery', recordId: 'p-1', parentType: 'product', parentId: 'p-1', label: 'Pro', language: 'en' },
      ],
    });
    expect(summarizeMediaUsage(entry(usage, B))).toBe('Could not be fully checked; used in at least 1 place');
  });

  it('sends no key of a row listing every case spelling of its keys (thousands of search strings), and answers the rest of the batch', async () => {
    const stem = 'x/a b';
    const amplified = [
      ...spellings('markdown').map((ext) => ({ objectKey: `${stem}.${ext}` })),
      ...spellings('thumbnail').flatMap((label) => spellings('avif').map((ext) => ({ objectKey: `${stem}_${label}.${ext}` }))),
    ];
    // The same spellings on a stem the routes could mint: no character to refuse, only the count.
    const mintedStem = 'uploads/c';
    const mintedAmplified = spellings('markdown').map((ext) => ({ objectKey: `${mintedStem}.${ext}` }));
    expect(amplified.length).toBeGreaterThan(8000);
    answerEveryId();

    const usage = await findMediaUsage([
      { id: A, object_key: 'uploads/a.webp', variants: [{ objectKey: 'uploads/a_large.avif' }] },
      { id: B, object_key: `${stem}.png`, variants: amplified },
      { id: C, object_key: `${mintedStem}.png`, variants: mintedAmplified },
    ]);

    expect(sentKeys(B)).toEqual([]);
    expect(sentKeys(C)).toEqual([]);
    expect(isMediaUnused(entry(usage, B))).toBe(false);
    expect(isMediaUnused(entry(usage, C))).toBe(false);
    expect(usage.get(A)).toEqual({ total: 0, byKind: {}, sites: [] });
  });

  it('sends no key of a row holding two spellings of one key: searching one would search less than its delete removes', async () => {
    answerEveryId();

    const usage = await findMediaUsage([
      { id: D, object_key: 'uploads/d.webp', variants: [{ objectKey: 'uploads/d_large.avif' }, { objectKey: 'uploads/d.WEBP' }] },
    ]);

    expect(sentKeys(D)).toEqual([]);
    expect(usage.get(D)?.byKind).toEqual({ unchecked_key: 1 });
  });

  it(`sends a real upload's keys and up to ${MAX_SEARCHED_KEYS_PER_MEDIA_ROW} a row, and none past that`, async () => {
    const labels = ['xlarge', 'large', 'medium', 'small', 'thumbnail', 'original', 'original_uploaded'];
    const variantsOf = (stem: string, count: number) =>
      labels
        .flatMap((label) => ['avif', 'webp', 'png'].map((ext) => `${stem}_${label}.${ext}`))
        .slice(0, count)
        .map((objectKey) => ({ objectKey }));
    const upload = [
      { objectKey: 'uploads/photo_20261118.png' },
      ...['xlarge', 'large', 'medium', 'small', 'thumbnail', 'original'].map((label) => ({ objectKey: `uploads/photo_20261118_${label}.avif` })),
    ];
    answerEveryId();

    const usage = await findMediaUsage([
      { id: A, object_key: 'uploads/photo_20261118.png', variants: upload },
      { id: D, object_key: 'uploads/d.png', variants: variantsOf('uploads/d', MAX_SEARCHED_KEYS_PER_MEDIA_ROW - 1) },
      { id: E, object_key: 'uploads/e.png', variants: variantsOf('uploads/e', MAX_SEARCHED_KEYS_PER_MEDIA_ROW) },
    ]);

    expect(sentKeys(A)).toHaveLength(7);
    expect(sentKeys(D)).toHaveLength(MAX_SEARCHED_KEYS_PER_MEDIA_ROW);
    expect(sentKeys(E)).toEqual([]);
    expect(usage.get(D)).toEqual({ total: 0, byKind: {}, sites: [] });
    expect(usage.get(E)?.byKind).toEqual({ unchecked_key: 1 });
  });

  it('reports a row as not checked when any copy of it in the batch could not be searched', async () => {
    answerEveryId();

    const usage = await findMediaUsage([
      { id: B, object_key: 'uploads/a b.png' },
      { id: B.toUpperCase(), object_key: 'uploads/b.png' },
    ]);

    expect(sentKeys(B)).toEqual([]);
    expect(usage.get(B)?.byKind).toEqual({ unchecked_key: 1 });
  });
});

describe('public.media_usage (02045) and the rules it keeps in step', () => {
  /** The last migration (by name) whose SQL matches `marker`, and that SQL. */
  function lastMigrationWith(marker: RegExp): { name: string; sql: string } {
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names.reverse()) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      if (marker.test(sql)) return { name, sql };
    }
    throw new Error(`no migration matches ${marker}`);
  }

  /** The named secret keys and the suffix pattern a statement excludes (`<column> <> ALL (ARRAY[...])`, `<column> !~* '...'`). */
  function secretRule(statement: string, column: string) {
    const named = new RegExp(`${column.replace('.', '\\.')}\\s*<>\\s*ALL\\s*\\(\\s*ARRAY\\[([^\\]]*)\\]`).exec(statement);
    const pattern = new RegExp(`${column.replace('.', '\\.')}\\s*!~\\*\\s*'([^']*)'`).exec(statement);
    return {
      named: named ? [...named[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort() : null,
      pattern: pattern ? pattern[1] : null,
    };
  }

  it("skips exactly the rows the latest site_settings_read_policy keeps for the service role (02038's rule)", () => {
    const policy = lastMigrationWith(/CREATE POLICY site_settings_read_policy/);
    const policyStatement = policy.sql.slice(policy.sql.indexOf('CREATE POLICY site_settings_read_policy'));
    const lookup = lastMigrationWith(/CREATE OR REPLACE FUNCTION public\.media_usage\(/);
    const lookupStatement = lookup.sql.slice(lookup.sql.indexOf('CREATE OR REPLACE FUNCTION public.media_usage('));

    const policyRule = secretRule(policyStatement.slice(0, policyStatement.indexOf(';')), 'key');
    const lookupRule = secretRule(lookupStatement, 's.key');

    expect(policyRule.named).toContain('cortex_ai_mcp_settings');
    expect(policyRule.pattern).toContain('_token');
    expect(lookupRule).toEqual(policyRule);
  });

  // The function builds no key token longer than the longest key it was sent, which bounds what one
  // run of a document costs (2026-11-18: building every suffix of a 40 KB run of slashes took tens of
  // seconds per lookup, 36 to 85 s on local replays, far past the Data API's 8 s statement timeout).
  // It ignores a key longer than MAX_OBJECT_KEY_LENGTH, so the app must never send one: a key it sent
  // and the function ignored would be answered "unused".
  it('ignores exactly the keys longer than MAX_OBJECT_KEY_LENGTH, and the app never sends one', async () => {
    const lookup = lastMigrationWith(/CREATE OR REPLACE FUNCTION public\.media_usage\(/);
    const lookupStatement = lookup.sql.slice(lookup.sql.indexOf('CREATE OR REPLACE FUNCTION public.media_usage('));
    const cap = /AND length\(k\.value #>> '\{\}'\) <= (\d+)/.exec(lookupStatement);
    expect(cap?.[1], `the longest key ${lookup.name} searches`).toBe(String(MAX_OBJECT_KEY_LENGTH));

    answerEveryId();
    const atCap = `uploads/${'a'.repeat(MAX_OBJECT_KEY_LENGTH - 'uploads/'.length - '.png'.length)}.png`;
    const overCap = `uploads/a${atCap.slice('uploads/'.length)}`;
    const longVariant = atCap.replace(/\.png$/, '_large.avif');
    await findMediaUsage([
      { id: A, object_key: atCap, variants: [{ objectKey: longVariant }] },
      { id: B, object_key: overCap },
    ]);

    expect(atCap).toHaveLength(MAX_OBJECT_KEY_LENGTH);
    expect(overCap).toHaveLength(MAX_OBJECT_KEY_LENGTH + 1);
    expect(longVariant.length).toBeGreaterThan(MAX_OBJECT_KEY_LENGTH);
    // A longer key is not the row's own (ownedMediaStorageKeys), so its delete removes no such object.
    expect(sentKeys(A)).toEqual([atCap]);
    expect(sentKeys(B)).toEqual([]);
  });

  /** The latest migration that defines media_usage, and its CREATE FUNCTION statement onward. */
  function latestLookup() {
    const lookup = lastMigrationWith(/CREATE OR REPLACE FUNCTION public\.media_usage\(/);
    return { lookup, lookupStatement: lookup.sql.slice(lookup.sql.indexOf('CREATE OR REPLACE FUNCTION public.media_usage(')) };
  }

  /**
   * The key branch of the latest media_usage, replayed in JS: the plain replace() that reads an escaped
   * slash as a slash (when the migration has one), then the escape pass, the '%2F' replaces and the run
   * pattern, each taken from the migration's own SQL. JS split/join replaces every occurrence left to
   * right, as replace() does.
   */
  function keyPass() {
    const { lookup, lookupStatement } = latestLookup();
    const keyBranch =
      /regexp_matches\(\s*replace\(replace\(regexp_replace\((?:replace\(d\.body, '([^']+)', '\/'\)|d\.body), '([^']+)', ' ', 'g'\), '%2F', '\/'\), '%2f', '\/'\),\s*'([^']+)', 'g'\)/.exec(
        lookupStatement
      );
    expect(keyBranch, `${lookup.name}: the escape pass before the key tokens`).not.toBeNull();
    const [, slashPattern, escapePattern, runPattern] = keyBranch as RegExpExecArray;

    /** One JSON text's key tokens: every suffix after a '/' of each run (the length bounds aside). */
    const keyTokens = (json: string) => {
      const text = (slashPattern === undefined ? json : json.split(slashPattern).join('/'))
        .replace(new RegExp(escapePattern, 'g'), ' ')
        .replace(/%2F/g, '/')
        .replace(/%2f/g, '/');
      const tokens = new Set<string>();
      for (const [found] of text.matchAll(new RegExp(runPattern, 'g'))) {
        const parts = found.replace(/[._/-]+$/, '').split('/');
        parts.forEach((_, n) => tokens.add(parts.slice(n).join('/')));
      }
      return tokens;
    };
    return { lookup, lookupStatement, slashPattern, keyTokens };
  }

  /** The comma-separated items of a SELECT list; commas inside parentheses or quotes stay. */
  function selectItems(list: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let quoted = false;
    let current = '';
    for (const ch of list) {
      if (ch === "'") quoted = !quoted;
      else if (!quoted && ch === '(') depth++;
      else if (!quoted && ch === ')') depth--;
      if (ch === ',' && depth === 0 && !quoted) {
        items.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    items.push(current.trim());
    return items;
  }

  // The function reads every document as JSON text: a jsonb column's ::text, and a plain text column
  // through to_json. There a control character is an escape (a newline is a backslash and an n), and
  // until 2026-11-18 its letter glued to a key on the next line: that key was never found, so its file
  // was listed as unused and "Delete unused" deleted it. The key tokens now turn each escape whose
  // letter is a key character, and each escaped backslash, into a separator before cutting runs. This
  // replays the migration's own patterns on JSON.stringify, which escapes the way jsonb::text does
  // (b, f, n, r and t escapes, a u escape for the other control characters, an escaped quote and
  // backslash, never an escaped slash); posture section 45 checks the same on a database.
  it('cuts key tokens from JSON text with its escapes as separators, and reads plain text columns through to_json', () => {
    const { lookupStatement, keyTokens } = keyPass();
    const backslash = String.fromCharCode(92);
    for (const code of [10, 13, 9, 8, 12, 1, 31]) {
      const label = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
      const json = JSON.stringify({ html_content: `Gallery:${String.fromCharCode(code)}uploads/a.webp` });
      expect(json, `${label} is an escape in JSON text`).toContain(backslash);
      expect(keyTokens(json), `a key right after ${label}`).toContain('uploads/a.webp');
    }
    // An escaped backslash is one character: the letter after it stays with the key.
    expect(keyTokens(JSON.stringify(`C:${backslash}nb/a.png`))).toContain('nb/a.png');
    expect(keyTokens(JSON.stringify(`C:${backslash}\nuploads/b.webp`))).toContain('uploads/b.webp');
    expect(keyTokens(JSON.stringify(`x${backslash}${backslash}nuploads/c.webp`))).not.toContain('uploads/c.webp');
    expect(keyTokens(JSON.stringify('x"uploads/d.webp'))).toContain('uploads/d.webp');

    // A plain text column goes through to_json, so a backslash in it is escaped like one in a jsonb value.
    const docs = lookupStatement.slice(lookupStatement.indexOf('docs AS ('), lookupStatement.indexOf('tokens AS ('));
    for (const column of ['p.short_description', 'n.url', 'r.destination_path', 'c.description', 't.extra_css', 'pr.avatar_url']) {
      expect(docs, `${column} through to_json`).toContain(`to_json(${column})::text`);
      const elsewhere = docs.split(`to_json(${column})::text`).join('').split(`WHERE ${column} IS NOT NULL`).join('');
      expect(new RegExp(`\\b${column.replace('.', '\\.')}\\b`).test(elsewhere), `${column} read raw`).toBe(false);
    }
  });

  // JSON pasted into a text field may escape every slash (JSON-LD as PHP's json_encode writes it), and
  // until 2026-11-18 the escaped backslash before each slash cut the run there: the key was never
  // found, so "Delete unused" deleted its file. A stored backslash and slash are two backslashes and a
  // slash in the JSON text, and one plain replace() before the escape pass reads those three
  // characters as a slash. Pairing holds because JSON text never writes a backslash and a slash: the
  // run before a slash is always even, and the replace takes its last pair. Posture section 45 checks
  // the same on a database.
  it('reads an escaped slash as a slash, and every other backslash before it as a separator', () => {
    const { lookup, slashPattern, keyTokens } = keyPass();
    const backslash = String.fromCharCode(92);
    /** n stored backslashes, then a slash. */
    const slashAfter = (n: number) => `${backslash.repeat(n)}/`;

    const jsonLd = `<script type="application/ld+json">{"contentUrl":"https:${slashAfter(1)}${slashAfter(1)}cdn.example.com${slashAfter(1)}uploads${slashAfter(1)}a.png"}</script>`;
    expect(keyTokens(JSON.stringify({ html_content: jsonLd })), 'a key in JSON-LD with escaped slashes').toContain('uploads/a.png');
    // A plain text column reads the same through to_json, which escapes a backslash as JSON.stringify does.
    const redirect = `https://cdn.example.com${slashAfter(1)}media${slashAfter(1)}uploads${slashAfter(1)}a.png`;
    expect(keyTokens(JSON.stringify(redirect)), 'a key in a redirect target with escaped slashes').toContain('uploads/a.png');

    for (const n of [1, 2, 3]) {
      // Two backslashes for each stored one: the run before the slash is always even.
      expect(JSON.stringify(`uploads${slashAfter(n)}b.png`)).toContain(`uploads${backslash.repeat(2 * n)}/b.png`);
      expect(keyTokens(JSON.stringify(`x${slashAfter(n)}uploads/b.png`)), `a key after ${n} backslashes and a slash`).toContain('uploads/b.png');
    }
    // Only the stored backslash right before the slash goes with it; any before that still separates.
    expect(keyTokens(JSON.stringify(`uploads${slashAfter(1)}c.png`))).toContain('uploads/c.png');
    expect(keyTokens(JSON.stringify(`uploads${slashAfter(2)}c.png`))).not.toContain('uploads/c.png');
    expect(keyTokens(JSON.stringify(`uploads${slashAfter(3)}c.png`))).not.toContain('uploads/c.png');
    expect(keyTokens(JSON.stringify(`uploads/d.png${slashAfter(2)}next`))).toContain('uploads/d.png');
    expect(keyTokens(JSON.stringify(`uploads/d.png${slashAfter(3)}next`))).toContain('uploads/d.png');

    // Text with escaped slashes names a key exactly where the same text without those backslashes does.
    // That is not only more matches: a key directly followed by an escaped slash and more key
    // characters is part of a longer run, as uploads/e.png/next is.
    expect(keyTokens(JSON.stringify(`uploads/e.png${slashAfter(1)}next`))).not.toContain('uploads/e.png');
    expect(keyTokens(JSON.stringify('uploads/e.png/next'))).not.toContain('uploads/e.png');
    for (const text of [
      '<img src="https://cdn.example.com/storage/v1/object/public/media/uploads/f.png">',
      'Gallery:\nuploads/f_large.avif and uploads/f.png/next, uploads/f_medium.avif.',
      '<img src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fuploads%2Ff_small.avif&w=640">',
      `C:${backslash}nb/f.png "uploads/f_thumbnail.avif"`,
    ]) {
      const escaped = text.split('/').join(slashAfter(1));
      expect([...keyTokens(JSON.stringify(escaped))].sort(), escaped).toEqual([...keyTokens(JSON.stringify(text))].sort());
    }
    expect(slashPattern, `${lookup.name}: a stored backslash and slash, as JSON text writes them`).toBe(`${backslash}${backslash}/`);
  });

  // Every document is read as JSON text, so a backslash in it always starts an escape: a jsonb column
  // through ::text, and any other column through to_json(...)::text (a plain text column read raw would
  // let the escape pass eat the letter after a literal backslash, and lose the key that starts there).
  // Each docs branch's body may read a column only in one of those two shapes, qualified by the branch's
  // alias, inside nothing but `concat_ws(' ', …)` (and the first branch's `AS body`): an unqualified or
  // quoted column, or any other expression, fails, in a branch joined by UNION ALL or by UNION, in any
  // case, and there must be one branch for each FROM public.<table>, so a branch the split missed fails
  // too. A column read through ::text must be one of the jsonb columns listed here, and the list must
  // name exactly the jsonb columns the bodies read. The generated types back the list: Json for each of
  // them, string for each column read through to_json (a column a pending migration adds is checked once
  // db:types has run).
  it('reads every column of the docs CTE as JSON text: a listed jsonb column through ::text, any other through to_json', () => {
    const JSONB_DOC_COLUMNS = [
      'affiliate_pages.draft_content',
      'affiliate_pages.published_content',
      'affiliate_pages.published_profile',
      'blocks.content',
      'categories.description_translations',
      'content_drafts.blocks',
      'content_drafts.meta',
      'custom_block_definitions.fields',
      'custom_block_definitions.layout_schema',
      'page_revisions.content',
      'post_revisions.content',
      'product_drafts.blocks',
      'product_drafts.meta',
      'product_revisions.content',
      'products.description_json',
      'products.metadata',
      'site_settings.value',
      'site_themes.tokens',
    ];
    const { lookup, lookupStatement } = latestLookup();
    const docs = lookupStatement
      .slice(lookupStatement.indexOf('docs AS ('), lookupStatement.indexOf('tokens AS ('))
      .replace(/--[^\n]*/g, '');
    const jsonbReads = new Set<string>();
    const plainReads = new Set<string>();
    const branches = docs.split(/\bUNION(?:\s+ALL)?\b/i);
    expect(branches.length, `${lookup.name}: the docs branches`).toBeGreaterThan(10);
    expect(branches.length, `${lookup.name}: one docs branch for each FROM public.<table>`).toBe(
      (docs.match(/\bFROM\s+public\./gi) ?? []).length,
    );
    for (const branch of branches) {
      const from = /\bFROM public\.(\w+) (\w+)\b/.exec(branch);
      expect(from, `${lookup.name}: a docs branch without FROM public.<table> <alias>`).not.toBeNull();
      const [, table, alias] = from as RegExpExecArray;
      const items = selectItems(branch.slice(branch.indexOf('SELECT') + 'SELECT'.length, (from as RegExpExecArray).index));
      expect(items, `${table}: kind, record_id, parent_type, parent_id, body`).toHaveLength(5);
      const rest = items[4]
        .replace(new RegExp(`\\bto_json\\(${alias}\\.(\\w+)\\)::text`, 'g'), (_match, column: string) => {
          plainReads.add(`${table}.${column}`);
          return '';
        })
        .replace(new RegExp(`\\b${alias}\\.(\\w+)::text`, 'g'), (_match, column: string) => {
          jsonbReads.add(`${table}.${column}`);
          return '';
        });
      // What is left may only be the concat_ws(' ', …) around those reads and the first branch's alias.
      const scaffolding = rest
        .replace(/\bAS\s+body\s*$/, '')
        .replace(/\bconcat_ws\(\s*' '/g, '')
        .replace(/[\s,()]/g, '');
      expect(scaffolding, `${table}: a body column read some other way (${items[4]})`).toBe('');
    }
    for (const column of plainReads) expect(JSONB_DOC_COLUMNS.includes(column), `${column}: jsonb through to_json`).toBe(false);
    expect([...jsonbReads].sort(), 'the columns read through ::text').toEqual(JSONB_DOC_COLUMNS);
    expect(plainReads.size, 'the columns read through to_json').toBe(6);

    const types = readFileSync(GENERATED_TYPES_FILE, 'utf8').replace(/\r\n/g, '\n');
    /** A column's type in the generated Row type of its table, or null when the types do not list it. */
    const rowType = (qualified: string) => {
      const [table, column] = qualified.split('.');
      const start = types.indexOf(`\n      ${table}: {\n        Row: {\n`);
      if (start < 0) return null;
      const row = types.slice(start, types.indexOf('\n        }', start + 1));
      return new RegExp(`\\n\\s+${column}: ([^\\n]+)`).exec(row)?.[1] ?? null;
    };
    expect(rowType('blocks.content'), 'the generated types are read').toBe('Json | null');
    for (const column of jsonbReads) {
      const type = rowType(column);
      if (type !== null) expect(type, `${column} in the generated types`).toMatch(/^Json\b/);
    }
    for (const column of plainReads) {
      const type = rowType(column);
      if (type !== null) expect(type, `${column} in the generated types`).toMatch(/^string\b/);
    }
  });
});
