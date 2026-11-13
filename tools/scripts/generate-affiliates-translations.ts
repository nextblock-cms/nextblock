/**
 * Generates migration 02031 (libs/db/src/supabase/migrations/02031_affiliates_ui_translations.sql):
 * the Affiliates package's UI copy in English and French. The rows come from AFFILIATES_COPY
 * (the merged package dictionaries, libs/affiliates/src/lib/i18n/copy/<area>.ts) and from the
 * site-wide keys the feature's app components added (AFFILIATE_GLOBAL_TRANSLATIONS,
 * apps/nextblock/lib/i18n/global-affiliate-keys.ts). Both modules are imported, never parsed.
 *
 *   npx tsx --tsconfig tsconfig.base.json tools/scripts/generate-affiliates-translations.ts --write
 *   npx tsx --tsconfig tsconfig.base.json tools/scripts/generate-affiliates-translations.ts --check
 *   npx tsx --tsconfig tsconfig.base.json tools/scripts/generate-affiliates-translations.ts
 *
 * --write (re)writes 02031 with LF endings; --check exits 1 when 02031 on disk differs from what
 * the dictionaries generate; no flag prints the SQL (prefer --write: PowerShell's `>` writes
 * UTF-16). Every string is checked first: trimmed and non-empty, no control or invisible
 * character, no backslash, each {placeholder} at most once and the same set in both languages.
 *
 * --write is for an UNAPPLIED 02031 only. Once the file has run against any shared database it is
 * append-only like every migration, so a later copy change ships in a NEW forward migration (the
 * header written below says how) and libs/affiliates/src/lib/i18n/translations-migration.test.ts
 * keeps the seeded copy and the dictionaries in step. After writing, regenerate the embedded
 * copies: npm run generate:migrations-bundle && npm run generate:sandbox.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A build-time generator in the workspace root, not a runtime project: it reads the package
// dictionaries and the app's key list as data (the lib's own entry would also load React).
// eslint-disable-next-line @nx/enforce-module-boundaries -- generator input, read as data
import { AFFILIATES_COPY, AFFILIATES_COPY_AREAS } from '../../libs/affiliates/src/lib/i18n/dictionary';
// eslint-disable-next-line @nx/enforce-module-boundaries -- generator input, read as data
import { AFFILIATE_GLOBAL_TRANSLATIONS } from '../../apps/nextblock/lib/i18n/global-affiliate-keys';

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(WORKSPACE_ROOT, 'libs', 'db', 'src', 'supabase', 'migrations');
const MIGRATION_VERSION = '02031';
const MIGRATION_FILE = `${MIGRATION_VERSION}_affiliates_ui_translations.sql`;
const AFFILIATES_PREFIX = 'affiliates.';

/** `affiliates.portal.nav_title`, `partner_portal`, `unauthorized.retailer_only`. */
const KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** Invisible code points a reviewer cannot see in SQL; refused rather than escaped. */
const INVISIBLE_CODE_POINTS = new Set([0x00a0, 0x00ad, 0x061c, 0x180e, 0x2007, 0x2028, 0x2029, 0x202f, 0xfeff]);

interface CopyEntry {
  readonly en: string;
  readonly fr: string;
}

type CopyRow = readonly [key: string, entry: CopyEntry];

interface SeedBatch {
  heading: string;
  rows: CopyRow[];
}

function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Why `text` cannot go into the migration as a plain SQL literal, or null when it can. */
function forbiddenCharacter(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `the control character ${codePointLabel(code)}`;
    if (code >= 0xd800 && code <= 0xdfff) return `a lone surrogate (${codePointLabel(code)})`;
    if (
      INVISIBLE_CODE_POINTS.has(code) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return `the invisible character ${codePointLabel(code)} (use a plain space)`;
    }
    // Standard strings keep a backslash literal, but only while standard_conforming_strings is
    // on; UI copy never needs one, so the generated SQL never depends on that setting.
    if (code === 0x5c) return 'a backslash';
  }
  return null;
}

/** A standard SQL string literal: the text between single quotes, each quote doubled. */
function sqlString(text: string): string {
  const problem = forbiddenCharacter(text);
  if (problem) throw new Error(`cannot write ${JSON.stringify(text)} as SQL: it contains ${problem}`);
  return `'${text.replace(/'/g, "''")}'`;
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/** Every problem with one row, so a run reports all of them at once. */
function entryProblems(key: string, entry: unknown): string[] {
  const problems: string[] = [];
  if (!KEY_PATTERN.test(key)) problems.push(`${key}: keys are lowercase snake_case segments joined by dots`);
  if (!entry || typeof entry !== 'object') return [...problems, `${key}: not an { en, fr } entry`];

  const texts = entry as Partial<Record<'en' | 'fr', unknown>>;
  const found: Partial<Record<'en' | 'fr', string[]>> = {};
  for (const language of ['en', 'fr'] as const) {
    const text = texts[language];
    if (typeof text !== 'string' || text.trim() === '') {
      problems.push(`${key}.${language}: missing or empty`);
      continue;
    }
    if (text !== text.trim()) problems.push(`${key}.${language}: leading or trailing whitespace`);
    const forbidden = forbiddenCharacter(text);
    if (forbidden) problems.push(`${key}.${language}: contains ${forbidden}`);
    const names = placeholdersOf(text);
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    if (repeated.length > 0) {
      problems.push(`${key}.${language}: {${repeated[0]}} appears more than once (t() replaces only the first occurrence)`);
    }
    found[language] = names;
  }
  if (found.en && found.fr && [...found.en].sort().join(',') !== [...found.fr].sort().join(',')) {
    problems.push(`${key}: the English and French placeholders differ`);
  }
  return problems;
}

const byKey = (a: CopyRow, b: CopyRow): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** One batch per dictionary area (AFFILIATES_COPY_AREAS order, empty areas skipped), then the site-wide keys. */
function buildBatches(problems: string[]): SeedBatch[] {
  const areaRows = new Map<string, CopyRow[]>(AFFILIATES_COPY_AREAS.map((area) => [area, []]));
  for (const [key, entry] of Object.entries(AFFILIATES_COPY)) {
    problems.push(...entryProblems(key, entry));
    const area = /^affiliates\.([a-z0-9_]+)\./.exec(key)?.[1];
    const rows = area === undefined ? undefined : areaRows.get(area);
    if (!rows) {
      problems.push(`${key}: not under affiliates.<area>. for an area of AFFILIATES_COPY_AREAS (${AFFILIATES_COPY_AREAS.join(', ')})`);
      continue;
    }
    rows.push([key, entry]);
  }

  const globalRows: CopyRow[] = [];
  for (const [key, entry] of Object.entries(AFFILIATE_GLOBAL_TRANSLATIONS)) {
    problems.push(...entryProblems(key, entry));
    if (key.startsWith(AFFILIATES_PREFIX)) {
      problems.push(`${key}: a site-wide key cannot use the ${AFFILIATES_PREFIX} prefix (that namespace is the package dictionaries')`);
    }
    globalRows.push([key, entry]);
  }

  const batches: SeedBatch[] = [];
  for (const [area, rows] of areaRows) {
    if (rows.length === 0) continue;
    batches.push({ heading: `${AFFILIATES_PREFIX}${area}.* (${rows.length} keys)`, rows: [...rows].sort(byKey) });
  }
  if (globalRows.length > 0) {
    batches.push({
      heading: `site-wide keys, AFFILIATE_GLOBAL_TRANSLATIONS (${globalRows.length} keys)`,
      rows: [...globalRows].sort(byKey),
    });
  }
  return batches;
}

function renderHeader(batches: SeedBatch[]): string {
  const affiliateBatches = batches.filter((batch) => batch.rows[0]?.[0].startsWith(AFFILIATES_PREFIX));
  const affiliateCount = affiliateBatches.reduce((sum, batch) => sum + batch.rows.length, 0);
  const globalCount = batches.reduce((sum, batch) => sum + batch.rows.length, 0) - affiliateCount;
  const perArea = affiliateBatches
    .map((batch) => `${batch.rows[0]?.[0].split('.')[1] ?? ''} ${batch.rows.length}`)
    .join(', ');

  return [
    '-- Affiliates & Creator Storefronts: the UI copy, in English and French.',
    '--',
    '-- GENERATED by tools/scripts/generate-affiliates-translations.ts; do not edit by hand.',
    '-- Sources, imported by the generator (never parsed):',
    '--   AFFILIATES_COPY, the package dictionaries (libs/affiliates/src/lib/i18n/copy/<area>.ts):',
    `--     ${affiliateCount} affiliates.* keys (${perArea})`,
    '--   AFFILIATE_GLOBAL_TRANSLATIONS (apps/nextblock/lib/i18n/global-affiliate-keys.ts):',
    `--     ${globalCount} site-wide keys the feature's app components use`,
    '-- One INSERT per area, in AFFILIATES_COPY_AREAS order (areas without keys skipped), keys sorted.',
    '--',
    '-- Data only, and safe to re-run: ON CONFLICT (key) DO NOTHING never overwrites a row that',
    '-- already exists, so a string an operator edited (CMS > Settings > Extra Translations) stays',
    "-- theirs. The package dictionaries and the components' inline fallbacks carry the same text, so",
    '-- an install that has not run this file yet renders that copy, never a raw key. The root layout',
    '-- leaves the affiliates.* rows out of its global payload (excludeAffiliateTranslationRows); the',
    '-- partner layouts read their areas back as overrides of the built-in dictionaries.',
    '--',
    '-- Changing this copy later: once applied, this file is append-only like every migration, so',
    '-- never regenerate it. Ship a NEW forward migration: new keys as INSERT ... ON CONFLICT (key)',
    '-- DO NOTHING; changed text with the 02015 pattern, guarded by the OLD seeded text so copy an',
    '-- operator edited stays theirs:',
    '--   UPDATE public.translations AS t',
    "--   SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)), updated_at = now()",
    "--   FROM (VALUES ('affiliates.<area>.<key>', '<old fr>', '<new fr>')) AS fix(key, old_fr, new_fr)",
    "--   WHERE t.key = fix.key AND t.translations->>'fr' = fix.old_fr;",
    '-- libs/affiliates/src/lib/i18n/translations-migration.test.ts replays this file and every later',
    '-- migration and fails until the seeded copy matches the dictionaries again.',
  ].join('\n');
}

function renderStatement(batch: SeedBatch): string {
  const rows = batch.rows.map(
    ([key, entry]) =>
      `  (${sqlString(key)}, jsonb_build_object('en', ${sqlString(entry.en)}, 'fr', ${sqlString(entry.fr)}), now(), now())`
  );
  return [
    `-- ${batch.heading}`,
    'INSERT INTO public.translations (key, translations, created_at, updated_at)',
    'VALUES',
    rows.join(',\n'),
    'ON CONFLICT (key) DO NOTHING;',
  ].join('\n');
}

function renderMigration(batches: SeedBatch[]): string {
  return `${[renderHeader(batches), ...batches.map(renderStatement)].join('\n\n')}\n`;
}

/** Refuse to write 02031 when another file holds that version or the folder has moved past it. */
function slotProblem(): string | null {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
  const sameVersion = files.filter((name) => name.startsWith(`${MIGRATION_VERSION}_`) && name !== MIGRATION_FILE);
  if (sameVersion.length > 0) return `${sameVersion.join(', ')} already uses version ${MIGRATION_VERSION}`;
  if (files.includes(MIGRATION_FILE)) return null;
  const previous = String(Number(MIGRATION_VERSION) - 1).padStart(MIGRATION_VERSION.length, '0');
  const highest = files
    .map((name) => /^(\d{5})_/.exec(name)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort()
    .pop();
  return highest === previous
    ? null
    : `${MIGRATION_VERSION} is not the next free version any more (highest on disk: ${highest ?? 'none'}); this script only writes ${MIGRATION_FILE}`;
}

function main(argv: readonly string[]): number {
  const unknown = argv.filter((arg) => arg !== '--write' && arg !== '--check');
  if (unknown.length > 0 || (argv.includes('--write') && argv.includes('--check'))) {
    console.error('usage: generate-affiliates-translations.ts [--write | --check]');
    return 2;
  }

  const problems: string[] = [];
  const batches = buildBatches(problems);
  if (problems.length > 0) {
    console.error(`[generate-affiliates-translations] ${problems.length} problem(s) in the copy dictionaries:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const sql = renderMigration(batches);
  const target = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
  const rowCount = batches.reduce((sum, batch) => sum + batch.rows.length, 0);

  if (argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === sql) {
      console.error(`[generate-affiliates-translations] ${MIGRATION_FILE} is up to date (${rowCount} rows).`);
      return 0;
    }
    console.error(
      `[generate-affiliates-translations] ${MIGRATION_FILE} ${current === null ? 'is missing' : 'differs from the dictionaries'}. ` +
        'Unapplied: rerun with --write. Applied: ship the change as a NEW migration (see its header).'
    );
    return 1;
  }

  if (argv.includes('--write')) {
    const problem = slotProblem();
    if (problem) {
      console.error(`[generate-affiliates-translations] refusing to write: ${problem}`);
      return 1;
    }
    writeFileSync(target, sql, 'utf8');
    console.error(`[generate-affiliates-translations] wrote ${path.relative(WORKSPACE_ROOT, target)} (${batches.length} statements, ${rowCount} rows).`);
    console.error('[generate-affiliates-translations] next: npm run generate:migrations-bundle && npm run generate:sandbox');
    return 0;
  }

  process.stdout.write(sql);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
