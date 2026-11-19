import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A draft's stock quantity written as text is read by two readers that must agree on which text is a
 * number: the edit page's readDraftStockQuantity (DECIMAL_TEXT_PATTERN, apps/nextblock/app/cms/products/
 * productFormData.ts), which decides what the form shows and whether publish refuses the draft
 * (findUnreadableProductDraftValues), and publish_product_draft's helper (v_quantity_pattern, declared
 * by 02044 and again by each later migration that replaces the helper: 02047), which decides what is
 * written. Text one accepts and the other refuses is a stock the form
 * shows one way and the publish writes (or refuses) another. Neither constant is exported
 * (DECIMAL_TEXT_PATTERN is private to productFormData.ts, and v_quantity_pattern is SQL), so both are
 * read from their source text. The SQL pattern is written in the syntax both engines share (ASCII ranges
 * spelled out, no class escapes whose meaning depends on the engine or the locale), so a RegExp built
 * from it matches as PostgreSQL's ~ does.
 */

const ROOT = path.resolve(__dirname, '../..');
const FORM_DATA = 'apps/nextblock/app/cms/products/productFormData.ts';
const MIGRATIONS_DIR = 'libs/db/src/supabase/migrations';
/**
 * The last migration that declares v_quantity_pattern: the helper a database runs is the one the last
 * of them created (CREATE OR REPLACE), so a pattern changed there and not in the app, or the other way
 * round, must fail here (02044 declared it first; 02047 replaces the helper with its own copy).
 */
const MIGRATION = (() => {
  const files = readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((name) => /^\d{5}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const declaring = files.filter((name) =>
    /^\s*v_quantity_pattern constant text :=/m.test(readFileSync(path.join(ROOT, MIGRATIONS_DIR, name), 'utf8')),
  );
  if (declaring.length === 0) throw new Error(`no migration in ${MIGRATIONS_DIR} declares v_quantity_pattern`);
  return `${MIGRATIONS_DIR}/${declaring[declaring.length - 1]}`;
})();

/** DECIMAL_TEXT_PATTERN's source and flags, as productFormData.ts declares it (a regex literal on one line). */
function formPatternSource(): { source: string; flags: string } {
  const text = readFileSync(path.join(ROOT, FORM_DATA), 'utf8');
  const declarations = [...text.matchAll(/^const DECIMAL_TEXT_PATTERN = \/(.+)\/([a-z]*);\r?$/gm)];
  if (declarations.length !== 1) {
    throw new Error(`${FORM_DATA}: expected one "const DECIMAL_TEXT_PATTERN = /…/flags;" line, found ${declarations.length}`);
  }
  return { source: declarations[0][1], flags: declarations[0][2] };
}

/** v_quantity_pattern's text, as MIGRATION declares it (a standard SQL string: only '' is an escape). */
function functionPatternSource(): string {
  const sql = readFileSync(path.join(ROOT, MIGRATION), 'utf8');
  const declarations = [...sql.matchAll(/^\s*v_quantity_pattern constant text := '((?:[^']|'')*)';\r?$/gm)];
  if (declarations.length !== 1) {
    throw new Error(`${MIGRATION}: expected one "v_quantity_pattern constant text := '…';" line, found ${declarations.length}`);
  }
  return declarations[0][1].replace(/''/g, "'");
}

/** A RegExp that tests text the way the reader does (a global or sticky flag would make test() stateful). */
function build(source: string, flags = ''): RegExp {
  return new RegExp(source, flags.replace(/[gy]/g, ''));
}

const ASCII_SPACES = [' ', '\t', '\n', '\v', '\f', '\r'];
const OTHER_SPACES = ['\u0085', ' ', ' ', '᠎', ' ', ' ', ' ', '​', ' ', ' ', ' ', ' ', '　', '﻿'];
// Arabic-Indic, Extended Arabic-Indic, Devanagari and fullwidth 5, mathematical bold 5, super- and subscript 5, Roman five.
const OTHER_DIGITS = ['٥', '۵', '५', '５', '\u{1d7d3}', '⁵', '₅', 'Ⅴ'];

/**
 * The strings both readers are compared on: what product-draft-publish.db.test.ts reads and refuses,
 * round 2's probes, and the edges of each part of the pattern.
 */
const CORPUS: string[] = [
  // product-draft-publish.db.test.ts: read
  ' 7 ', '5.9', '-3', '1e3', '\t+.5e1\n', ' 12.9 ', '1e400',
  // product-draft-publish.db.test.ts: refused (as text; '1e200000' and '1e-20000' match and overflow numeric)
  'NaN', 'Infinity', 'inf', '-Infinity', '0x10', '1_000', '1e200000', '1e-20000', '', '   ', '5 5', '5e', 'five',
  // probes of round 2
  '5.e3', '+5.', '-.5e-3', '007e1', '1e0005', '-0', '-.5', '1e131071', '1e131072', '1e-16384', '4.99999999999999999', '\v5\f',
  // signs
  '+5', '-5', '+-5', '-+5', '--5', '++5', '+', '-', '+.', '-.', '+.5', '-.5', '5+', '5-', '+ 5', '- 5',
  // the point
  '.5', '5.', '.', '..5', '5..', '5.5.5', '.5.', '0.', '.0', '5 .5', '5. 5',
  // exponents
  '5e3', '5E3', '5e+3', '5e-3', '5E-3', '5E+3', 'e3', 'E3', 'e', '5e', '5E', '5e+', '5e-', '.e3', '5.e3', '.5e3', '5.5e3',
  '5e3.5', '5e3e3', '5ee3', '5e 3', '5 e3', '5e+-3', '5e3+', '5d3', '5f3',
  // other notations
  '0X10', '0b1', '0o7', '0x', '1,000', '1 000', "1'000", '-inf', '+inf', 'nan', 'NAN', 'infinity', '1/2', '5%', '$5', '5$', '#5', '5L', '5n',
  // escapes written out, letters
  't5', 'n5', 'v5', 'f5', 'r5', '\\5', '\\t5', '5\\n', 'x', 'five5', '5five',
  // each ASCII space around a digit, alone, and doubled
  ...ASCII_SPACES.flatMap((space) => [`${space}5`, `5${space}`, `${space}${space}5${space}${space}`, space, `5${space}5`]),
  // other spaces, which neither reads as one
  ...OTHER_SPACES.flatMap((space) => [`${space}5`, `5${space}`, space]),
  // digits that are not ASCII
  ...OTHER_DIGITS.flatMap((digit) => [digit, `1${digit}`, `${digit}.5`, `5e${digit}`]),
  // the anchors hold the whole text, not a line
  '5\n5', '\n\n5', 'x\n5', '5\nx', '5\n\nx',
  // long, exponents of more than 12 digits included (a pattern capping them refuses these)
  '9'.repeat(400), `0.${'9'.repeat(400)}`, `${'1'.repeat(200)}e${'1'.repeat(10)}`,
  `1e${'0'.repeat(20)}1`, `1e-${'0'.repeat(20)}1`, `5E+${'9'.repeat(13)}`,
];

describe("the stock quantity patterns of the edit page and of publish_product_draft (the last migration's v_quantity_pattern)", () => {
  it('reads the last migration that declares the pattern, the copy a database runs (02047 or later)', () => {
    expect(MIGRATION >= `${MIGRATIONS_DIR}/02047_`).toBe(true);
  });

  it('are read from their source text', () => {
    const form = formPatternSource();
    expect(form.source.length).toBeGreaterThan(0);
    expect(functionPatternSource().length).toBeGreaterThan(0);
  });

  it('accept and refuse the same strings', () => {
    const form = build(formPatternSource().source, formPatternSource().flags);
    const fn = build(functionPatternSource());
    const differing = CORPUS.filter((text) => form.test(text) !== fn.test(text)).map(
      (text) => `${JSON.stringify(text)}: the edit page ${form.test(text) ? 'reads' : 'refuses'} it, the function ${fn.test(text) ? 'reads' : 'refuses'} it`
    );
    expect(differing).toEqual([]);
  });

  it('read what the database tests read and refuse what they refuse (so both cannot drift the same way unseen)', () => {
    const fn = build(functionPatternSource());
    for (const text of [' 7 ', '5.9', '-3', '1e3', '\t+.5e1\n', ' 12.9 ', '1e400', '5.e3', '+5.', '.5', '5.', '-.5e-3', '\v5\f', '1e200000']) {
      expect(fn.test(text), JSON.stringify(text)).toBe(true);
    }
    for (const text of ['NaN', 'Infinity', 'inf', '-Infinity', '0x10', '1_000', '', '   ', '5 5', '5e', 'five', '.', ' 5', ' ', '٥', '５']) {
      expect(fn.test(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('the function matches it case-sensitively with ~, and writes it with no class escape or POSIX class (whose meaning depends on the engine or the locale)', () => {
    const sql = readFileSync(path.join(ROOT, MIGRATION), 'utf8');
    expect(sql).toMatch(/\(v_item\.quantity #>> '\{\}'\) ~ v_quantity_pattern\b/);
    expect(sql).not.toMatch(/~\*\s*v_quantity_pattern/);
    expect(functionPatternSource()).not.toMatch(/\\[dDsSwW]|\[\[:/);
  });

  /**
   * Drifted copies of each pattern, one edit each: every one must read or refuse some string of the
   * corpus differently, so the lockstep above fails when either pattern drifts that way.
   */
  const FORM_DRIFTS: Array<[string, (source: string, flags: string) => [string, string]]> = [
    ['vertical tab dropped from the spaces', (s, f) => [s.split('\\v').join(''), f]],
    ['form feed dropped from the spaces', (s, f) => [s.split('\\f').join(''), f]],
    ['carriage return dropped from the spaces', (s, f) => [s.split('\\r').join(''), f]],
    ['tab dropped from the spaces', (s, f) => [s.split('\\t').join(''), f]],
    ['spaces widened to \\s', (s, f) => [s.split('[ \\t\\n\\v\\f\\r]').join('\\s'), f]],
    ['sign dropped', (s, f) => [s.replace('[+-]?(?:', '(?:'), f]],
    ["'.5' refused", (s, f) => [s.replace('|\\.\\d+)', ')'), f]],
    ["'5.' refused", (s, f) => [s.replace('\\d+\\.?\\d*', '\\d+(?:\\.\\d+)?'), f]],
    ['exponent sign dropped', (s, f) => [s.replace('e[+-]?', 'e'), f]],
    ['exponent capped at 12 digits', (s, f) => [s.replace('e[+-]?\\d+', 'e[+-]?\\d{1,12}'), f]],
    ["upper-case 'E' refused", (s, f) => [s, f.replace('i', '')]],
    ['digits widened to \\w', (s, f) => [s.split('\\d').join('\\w'), f]],
    ['end anchor dropped', (s, f) => [s.replace(/\$$/, ''), f]],
    ['start anchor dropped', (s, f) => [s.replace(/^\^/, ''), f]],
  ];
  const FUNCTION_DRIFTS: Array<[string, (source: string) => string]> = [
    ['vertical tab dropped from the spaces', (s) => s.split('\\v').join('')],
    ['form feed dropped from the spaces', (s) => s.split('\\f').join('')],
    ['carriage return dropped from the spaces', (s) => s.split('\\r').join('')],
    ['newline dropped from the spaces', (s) => s.split('\\n').join('')],
    ['spaces widened to \\s', (s) => s.split('[ \\t\\n\\v\\f\\r]').join('\\s')],
    ['sign dropped', (s) => s.replace('[+-]?(?:', '(?:')],
    ["'.5' refused", (s) => s.replace('|\\.[0-9]+)', ')')],
    ["'5.' refused", (s) => s.replace('[0-9]+\\.?[0-9]*', '[0-9]+(?:\\.[0-9]+)?')],
    ['exponent sign dropped', (s) => s.replace('[eE][+-]?', '[eE]')],
    ['exponent capped at 12 digits', (s) => s.replace('[eE][+-]?[0-9]+', '[eE][+-]?[0-9]{1,12}')],
    ["upper-case 'E' refused", (s) => s.replace('[eE]', 'e')],
    ['underscore read as a digit', (s) => s.split('[0-9]').join('[0-9_]')],
    ['end anchor dropped', (s) => s.replace(/\$$/, '')],
    ['start anchor dropped', (s) => s.replace(/^\^/, '')],
  ];

  it.each(FORM_DRIFTS)("tells DECIMAL_TEXT_PATTERN from a copy with its %s", (_label, drift) => {
    const { source, flags } = formPatternSource();
    const [driftedSource, driftedFlags] = drift(source, flags);
    expect(`${driftedSource}/${driftedFlags}`, 'the drift changes the pattern').not.toBe(`${source}/${flags}`);
    const original = build(source, flags);
    const drifted = build(driftedSource, driftedFlags);
    expect(CORPUS.some((text) => original.test(text) !== drifted.test(text))).toBe(true);
  });

  it.each(FUNCTION_DRIFTS)('tells v_quantity_pattern from a copy with its %s', (_label, drift) => {
    const source = functionPatternSource();
    const driftedSource = drift(source);
    expect(driftedSource, 'the drift changes the pattern').not.toBe(source);
    const original = build(source);
    const drifted = build(driftedSource);
    expect(CORPUS.some((text) => original.test(text) !== drifted.test(text))).toBe(true);
  });
});
