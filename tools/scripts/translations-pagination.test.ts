import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PostgREST answers one request with at most `max_rows` rows (1000 in
 * libs/db/src/supabase/config.toml and on hosted Supabase) and drops the rest without an error.
 * Migration 02031 took the `translations` table past 1000 rows (about 1100 keys on a fresh
 * install), and the root layout's unpaginated `.order('key')` read lost the hundred keys that sort
 * last: every public page rendered raw keys such as `sign_in`, `sign_up` and `theme_switcher`, and
 * CMS → Extra translations could not show them.
 *
 * This guard finds every `.from('translations')` query chain in apps/nextblock and libs (tests
 * excluded) and fails on a read of many rows that does not page with `.range()` (see
 * apps/nextblock/lib/i18n/translation-pages.ts). Writes, single-row reads (`.single()`,
 * `.maybeSingle()`, `.eq('key', …)`), count-only reads and `.limit(n)` reads with n <= max_rows
 * pass. A query split across statements cannot be checked, so it fails too: build it in one chain.
 */

const ROOT = path.resolve(__dirname, '../..');
const PAGES_MODULE = 'apps/nextblock/lib/i18n/translation-pages.ts';
const SCAN_ROOTS = ['apps/nextblock', 'libs'];

/** PostgREST's row cap, which is also the paged reader's page size (read as text: no app import). */
const TRANSLATIONS_PAGE_SIZE = Number(
  /export const TRANSLATIONS_PAGE_SIZE = (\d+);/.exec(readFileSync(path.join(ROOT, PAGES_MODULE), 'utf8'))?.[1],
);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo', '.nx', 'out']);
const SKIP_PATHS = new Set(['apps/nextblock/public']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const FROM_TRANSLATIONS = /\.from\(\s*(['"`])translations\1\s*\)/g;

type ChainKind = 'write' | 'single-row' | 'count-only' | 'paginated' | 'bounded' | 'unpaginated' | 'split';

interface ChainFinding {
  file: string;
  line: number;
  kind: ChainKind;
  chain: string;
}

const OK_KINDS: ReadonlySet<ChainKind> = new Set(['write', 'single-row', 'count-only', 'paginated', 'bounded']);

/** Index just past the string literal (quote, double quote or template) that starts at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = skipBalanced(source, i + 1);
      continue;
    }
    i += 1;
  }
  return i;
}

/** Index just past the bracket group that opens at `start`, skipping strings and comments. */
function skipBalanced(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    const comment = skipComment(source, i);
    if (comment !== i) {
      i = comment;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Index just past a comment starting at `i`, or `i` when there is none. */
function skipComment(source: string, i: number): number {
  if (source[i] !== '/') return i;
  if (source[i + 1] === '/') {
    const end = source.indexOf('\n', i);
    return end < 0 ? source.length : end;
  }
  if (source[i + 1] === '*') {
    const end = source.indexOf('*/', i + 2);
    return end < 0 ? source.length : end + 2;
  }
  return i;
}

/**
 * The source with every comment blanked out (newlines kept, so offsets and line numbers hold):
 * a `.from('translations')` quoted in a comment is prose, not a query.
 */
function maskComments(source: string): string {
  let masked = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(source, i);
      masked += source.slice(i, end);
      i = end;
      continue;
    }
    const end = skipComment(source, i);
    if (end !== i) {
      masked += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    masked += ch;
    i += 1;
  }
  return masked;
}

/** The next index that is neither whitespace nor inside a comment. */
function nextSignificant(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (/\s/.test(source[i] as string)) {
      i += 1;
      continue;
    }
    const comment = skipComment(source, i);
    if (comment === i) return i;
    i = comment;
  }
  return i;
}

/**
 * The query chain that starts at `start` (the `.from(` of a match): every `.call(…)` that follows,
 * across lines and comments, up to the end of the expression (`;`, `,`, a closing bracket of the
 * enclosing call, or a line that does not continue the chain).
 */
export function chainAt(source: string, start: number): string {
  let i = start;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    const comment = skipComment(source, i);
    if (comment !== i) {
      i = comment;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      i = skipBalanced(source, i);
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}' || ch === ';' || ch === ',') break;
    if (ch === '\n') {
      const next = nextSignificant(source, i);
      const continues = source[next] === '.' || (source[next] === '?' && source[next + 1] === '.');
      if (!continues) break;
      i = next;
      continue;
    }
    i += 1;
  }
  return source.slice(start, i);
}

/** What a `.from('translations')` chain does, and so whether it can lose rows past `max_rows`. */
export function classifyTranslationsChain(chain: string, maxRows = TRANSLATIONS_PAGE_SIZE): ChainKind {
  const calls = new Set([...chain.matchAll(/\.\s*([A-Za-z]+)\s*\(/g)].map((match) => match[1]));
  if (['insert', 'update', 'upsert', 'delete'].some((call) => calls.has(call))) return 'write';
  if (!calls.has('select')) return 'split';
  if (/\bhead\s*:\s*true\b/.test(chain)) return 'count-only';
  if (calls.has('single') || calls.has('maybeSingle')) return 'single-row';
  if (/\.eq\(\s*(['"`])key\1\s*,/.test(chain)) return 'single-row';
  if (calls.has('range')) return 'paginated';
  const limit = /\.limit\(\s*(\d+)\s*[,)]/.exec(chain);
  if (limit && Number(limit[1]) <= maxRows) return 'bounded';
  return 'unpaginated';
}

function sourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  const absolute = path.join(ROOT, relativeDir);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(relative)) continue;
      files.push(...sourceFiles(relative));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

export function findTranslationsChains(file: string, source: string): ChainFinding[] {
  const findings: ChainFinding[] = [];
  const code = maskComments(source);
  for (const match of code.matchAll(FROM_TRANSLATIONS)) {
    const index = match.index ?? 0;
    const chain = chainAt(code, index);
    findings.push({
      file,
      line: code.slice(0, index).split('\n').length,
      kind: classifyTranslationsChain(chain),
      chain: chain.replace(/\s+/g, ' ').trim(),
    });
  }
  return findings;
}

function scanRepository(): ChainFinding[] {
  const findings: ChainFinding[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      if (!source.includes('translations')) continue;
      findings.push(...findTranslationsChains(file, source));
    }
  }
  return findings;
}

describe('the translations query classifier', () => {
  const kindOf = (source: string) => findTranslationsChains('fixture.ts', source).map((finding) => finding.kind);

  it('fails an unpaginated read of the whole table', () => {
    expect(kindOf("const { data } = await supabase.from('translations').select('key, translations').order('key');")).toEqual([
      'unpaginated',
    ]);
    expect(kindOf('await supabase.from("translations").select("*")')).toEqual(['unpaginated']);
    expect(kindOf("await supabase.from('translations').select('*').limit(5000);")).toEqual(['unpaginated']);
  });

  it('passes a paged read, across lines and comments, and inside a page callback', () => {
    expect(
      kindOf(`await supabase
        .from('translations')
        // site-wide keys only
        .select('key, translations')
        .not('key', 'like', 'affiliates.%')
        .order('key')
        .range(from, to);`),
    ).toEqual(['paginated']);
    expect(
      kindOf("const rows = await readAll((from, to) => supabase.from('translations').select('key').order('key').range(from, to));"),
    ).toEqual(['paginated']);
  });

  it('does not borrow a .range() from the next statement', () => {
    expect(kindOf("const a = supabase.from('translations').select('key')\nconst b = other.range(0, 9);")).toEqual(['unpaginated']);
    expect(kindOf("const a = supabase.from('translations').select('key'); other.range(0, 9);")).toEqual(['unpaginated']);
    expect(kindOf("call(supabase.from('translations').select('key'), other.range(0, 9));")).toEqual(['unpaginated']);
  });

  it('passes writes, single-row reads, count-only reads and small bounded reads', () => {
    expect(kindOf("await supabase.from('translations').insert({ key }).select('key, translations').single();")).toEqual(['write']);
    expect(kindOf("await supabase.from('translations').upsert(rows, { onConflict: 'key' });")).toEqual(['write']);
    expect(kindOf("await supabase.from('translations').update({ translations }).eq('key', key).select('key').single();")).toEqual([
      'write',
    ]);
    expect(kindOf("await supabase.from('translations').select('key').eq('key', key).maybeSingle();")).toEqual(['single-row']);
    expect(kindOf("await supabase.from('translations').select('key').eq('key', key);")).toEqual(['single-row']);
    expect(kindOf("await supabase.from('translations').select('*', { count: 'exact', head: true });")).toEqual(['count-only']);
    expect(kindOf("await supabase.from('translations').select('key').order('key').limit(50);")).toEqual(['bounded']);
  });

  it('fails a query built across statements, which it cannot check', () => {
    expect(kindOf("const query = supabase.from('translations');\nconst { data } = await query.select('*');")).toEqual(['split']);
  });

  it('ignores a query quoted in a comment', () => {
    expect(kindOf("// never: supabase.from('translations').select('*')\n/* nor .from('translations') */ const url = 'https://x';")).toEqual(
      [],
    );
  });
});

describe('reads of the translations table', () => {
  const findings = scanRepository();

  it('page every multi-row read with .range() (PostgREST returns at most max_rows rows)', () => {
    const offenders = findings
      .filter((finding) => !OK_KINDS.has(finding.kind))
      .map((finding) => `${finding.file}:${finding.line} (${finding.kind}) ${finding.chain}`);
    expect(offenders).toEqual([]);
  });

  it('finds the paged readers of the root layout and of CMS → Extra translations', () => {
    const paged = (file: string) => findings.some((finding) => finding.file === file && finding.kind === 'paginated');
    expect(paged('apps/nextblock/lib/i18n/cached-translations.ts')).toBe(true);
    expect(paged('apps/nextblock/app/cms/settings/extra-translations/actions.ts')).toBe(true);
  });

  it('pages no larger than the configured max_rows', () => {
    const config = readFileSync(path.join(ROOT, 'libs/db/src/supabase/config.toml'), 'utf8');
    const maxRows = /^\s*max_rows\s*=\s*(\d+)/m.exec(config);
    expect(maxRows, 'libs/db/src/supabase/config.toml sets max_rows').not.toBeNull();
    expect(TRANSLATIONS_PAGE_SIZE, `${PAGES_MODULE} exports TRANSLATIONS_PAGE_SIZE`).toBeGreaterThan(0);
    expect(TRANSLATIONS_PAGE_SIZE).toBeLessThanOrEqual(Number(maxRows?.[1]));
  });
});
