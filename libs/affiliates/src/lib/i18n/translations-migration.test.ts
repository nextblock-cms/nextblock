import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AFFILIATES_COPY, AFFILIATES_COPY_KEY_PREFIX } from './dictionary';
import type { AffiliatesCopyEntry } from './types';

/**
 * Parity between the Affiliates copy and the `translations` rows the migrations seed.
 *
 * Migration 02031 (written by tools/scripts/generate-affiliates-translations.ts) seeds every key
 * of AFFILIATES_COPY and of the app's AFFILIATE_GLOBAL_TRANSLATIONS, EN + FR, with
 * INSERT ... ON CONFLICT (key) DO NOTHING. This test replays 02031 and every later migration with
 * a small reader for the statements the repo writes translations with (INSERT ... VALUES, the
 * 02015 UPDATE ... FROM (VALUES (key, old, new)) jsonb_set correction, DELETE, TRUNCATE) and
 * requires the final seeded text to be exactly the dictionaries'. A copy change fails here until
 * a NEW migration seeds it (02031 is append-only once applied), and passes again once one does.
 *
 * Keys seeded before 02031 are collected too, inside the baseline's DO block and the catch-up's
 * EXECUTE bodies: ON CONFLICT DO NOTHING keeps an existing row, so a new key that collided with
 * one would keep the older text on every install.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'libs', 'db', 'src', 'supabase', 'migrations');
const SEED_FILE = '02031_affiliates_ui_translations.sql';
const GENERATOR = 'tools/scripts/generate-affiliates-translations.ts';
const THIS_TEST = 'libs/affiliates/src/lib/i18n/translations-migration.test.ts';
const GLOBAL_KEYS_MODULE = path.join(REPO_ROOT, 'apps', 'nextblock', 'lib', 'i18n', 'global-affiliate-keys.ts');

/**
 * AFFILIATE_GLOBAL_TRANSLATIONS lives in the app, whose components own those keys. A lib must
 * not import the app: a static import (or an import() of a literal path) gives the Nx graph an
 * affiliates -> nextblock edge, a cycle with the app's own dependency on this lib that
 * @nx/enforce-module-boundaries refuses. So the test loads the module from a computed path at
 * run time; the generator imports the same module statically.
 */
async function loadSiteWideCopy(): Promise<Readonly<Record<string, AffiliatesCopyEntry>>> {
  const moduleUrl = pathToFileURL(GLOBAL_KEYS_MODULE).href;
  const loaded = (await import(/* @vite-ignore */ moduleUrl)) as { AFFILIATE_GLOBAL_TRANSLATIONS?: unknown };
  const table = loaded.AFFILIATE_GLOBAL_TRANSLATIONS;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`${GLOBAL_KEYS_MODULE} must export AFFILIATE_GLOBAL_TRANSLATIONS ({ key: { en, fr } })`);
  }
  return table as Readonly<Record<string, AffiliatesCopyEntry>>;
}

const SITE_WIDE_COPY = await loadSiteWideCopy();
const DICTIONARY_ENTRIES = Object.entries(AFFILIATES_COPY);
const SITE_WIDE_ENTRIES = Object.entries(SITE_WIDE_COPY);
const TRACKED_KEYS: ReadonlySet<string> = new Set([...DICTIONARY_ENTRIES, ...SITE_WIDE_ENTRIES].map(([key]) => key));

/* ------------------------------------------------------------------ SQL reader --- */

type Token =
  | { kind: 'word'; text: string; upper: string; lower: string }
  | { kind: 'ident'; value: string }
  | { kind: 'literal'; value: string }
  | { kind: 'number' | 'op'; text: string };
type LiteralToken = Extract<Token, { kind: 'literal' }>;

/** A statement this reader cannot replay (the message says what to write instead). */
class SqlReadError extends Error {}

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const E_STRING_ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const isSpaceCode = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);
const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
const isIdentStartCode = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 128;
const isIdentPartCode = (code: number): boolean => isIdentStartCode(code) || isDigitCode(code) || code === 36;

/** Index just past the quote closing the run opened at `start`; a doubled quote is an escape. */
function quotedEnd(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (backslashEscapes && char === '\\') {
      i += 2;
      continue;
    }
    if (char === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  throw new SqlReadError(`unterminated ${quote === '"' ? 'quoted identifier' : 'string'} at offset ${start}`);
}

/** The value of an E'...' body: backslash escapes and doubled quotes resolved. */
function unescapeEString(body: string): string {
  return body.replace(
    /''|\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g,
    (_match: string, escape: string | undefined) => {
      if (escape === undefined) return "'";
      const head = escape.charAt(0);
      if (Object.prototype.hasOwnProperty.call(E_STRING_ESCAPES, head)) return E_STRING_ESCAPES[head] as string;
      if (head === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (head === 'u' || head === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16));
      if (head >= '0' && head <= '7') return String.fromCharCode(parseInt(escape, 8));
      return escape;
    }
  );
}

/** The `$tag$` (or `$$`) that opens a dollar quote at `index`, or null. */
function dollarTagAt(sql: string, index: number): string | null {
  DOLLAR_TAG.lastIndex = index;
  return DOLLAR_TAG.exec(sql)?.[0] ?? null;
}

/**
 * Tokens of a SQL (or plpgsql) source: comments dropped, '' / E'' / $tag$ literals and "quoted
 * identifiers" unquoted, so a quote, semicolon or keyword inside a literal is never code.
 */
function lexSql(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const code = sql.charCodeAt(i);
    const next = sql.charCodeAt(i + 1);
    const tag = code === 36 ? dollarTagAt(sql, i) : null;
    if (isSpaceCode(code)) {
      i += 1;
    } else if (code === 45 && next === 45) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (code === 47 && next === 42) {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      if (depth !== 0) throw new SqlReadError(`unterminated /* comment at offset ${i}`);
      i = j;
    } else if (code === 39) {
      const end = quotedEnd(sql, i, "'", false);
      tokens.push({ kind: 'literal', value: sql.slice(i + 1, end - 1).replace(/''/g, "'") });
      i = end;
    } else if ((code === 69 || code === 101) && next === 39) {
      const end = quotedEnd(sql, i + 1, "'", true);
      tokens.push({ kind: 'literal', value: unescapeEString(sql.slice(i + 2, end - 1)) });
      i = end;
    } else if (code === 34) {
      const end = quotedEnd(sql, i, '"', false);
      tokens.push({ kind: 'ident', value: sql.slice(i + 1, end - 1).replace(/""/g, '"') });
      i = end;
    } else if (tag !== null) {
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) throw new SqlReadError(`unterminated dollar quote ${tag} at offset ${i}`);
      tokens.push({ kind: 'literal', value: sql.slice(i + tag.length, close) });
      i = close + tag.length;
    } else if (isIdentStartCode(code)) {
      let j = i + 1;
      while (j < n && isIdentPartCode(sql.charCodeAt(j))) j += 1;
      const text = sql.slice(i, j);
      tokens.push({ kind: 'word', text, upper: text.toUpperCase(), lower: text.toLowerCase() });
      i = j;
    } else if (isDigitCode(code)) {
      let j = i + 1;
      while (j < n && (isDigitCode(sql.charCodeAt(j)) || sql[j] === '.')) j += 1;
      tokens.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: 'op', text: sql.charAt(i) });
      i += 1;
    }
  }
  return tokens;
}

/** Statements at the top level of a token list (literal bodies are single tokens). */
function splitStatements(tokens: readonly Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'op' && token.text === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

const isWord = (token: Token | undefined, upper: string): boolean => token?.kind === 'word' && token.upper === upper;
const isOp = (token: Token | undefined, text: string): boolean => token?.kind === 'op' && token.text === text;
const isLiteral = (token: Token | undefined): token is LiteralToken => token?.kind === 'literal';
const isOpen = (token: Token | undefined): boolean => isOp(token, '(') || isOp(token, '[');
const isClose = (token: Token | undefined): boolean => isOp(token, ')') || isOp(token, ']');

function nameOf(token: Token | undefined): string | null {
  if (token?.kind === 'word') return token.lower;
  if (token?.kind === 'ident') return token.value;
  return null;
}

/** Tokens back as SQL-ish text, for messages. */
function render(tokens: readonly Token[]): string {
  const text = tokens
    .map((token) => {
      switch (token.kind) {
        case 'word':
          return token.text;
        case 'ident':
          return `"${token.value}"`;
        case 'literal':
          return `'${token.value.replace(/'/g, "''")}'`;
        default:
          return token.text;
      }
    })
    .join(' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function closingBracket(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isOpen(tokens[i])) depth += 1;
    else if (isClose(tokens[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SqlReadError(`unbalanced brackets in ${render(tokens.slice(open))}`);
}

function splitTopLevel(tokens: readonly Token[], isSeparator: (token: Token, index: number) => boolean): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  tokens.forEach((token, index) => {
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    if (depth === 0 && isSeparator(token, index)) {
      parts.push(current);
      current = [];
    } else {
      current.push(token);
    }
  });
  parts.push(current);
  return parts;
}

function commaSeparated(tokens: readonly Token[]): Token[][] {
  return tokens.length === 0 ? [] : splitTopLevel(tokens, (token) => isOp(token, ','));
}

/** Operands of `a || b || c` at the top level. */
function splitConcat(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    if (depth === 0 && isOp(token, '|') && isOp(tokens[i + 1], '|')) {
      parts.push(current);
      current = [];
      i += 1;
    } else {
      current.push(token);
    }
  }
  parts.push(current);
  return parts;
}

function indexOfTopLevelWord(tokens: readonly Token[], from: number, words: readonly string[]): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    else if (depth === 0 && token?.kind === 'word' && words.includes(token.upper)) return i;
  }
  return tokens.length;
}

function stripParens(tokens: readonly Token[]): readonly Token[] {
  let expr = tokens;
  while (expr.length >= 2 && isOp(expr[0], '(') && closingBracket(expr, 0) === expr.length - 1) expr = expr.slice(1, -1);
  return expr;
}

/** `expr::type` or `expr::type[]` → the expression and the lower-case type. */
function withoutCast(tokens: readonly Token[]): { expr: readonly Token[]; cast: string | null } {
  const n = tokens.length;
  const typeAt = (index: number): string | null => {
    const token = tokens[index];
    return token?.kind === 'word' ? token.lower : null;
  };
  if (n >= 5 && isOp(tokens[n - 1], ']') && isOp(tokens[n - 2], '[') && typeAt(n - 3) && isOp(tokens[n - 4], ':') && isOp(tokens[n - 5], ':')) {
    return { expr: tokens.slice(0, n - 5), cast: `${typeAt(n - 3)}[]` };
  }
  if (n >= 3 && typeAt(n - 1) && isOp(tokens[n - 2], ':') && isOp(tokens[n - 3], ':')) {
    return { expr: tokens.slice(0, n - 3), cast: typeAt(n - 1) };
  }
  return { expr: tokens, cast: null };
}

function readCall(tokens: readonly Token[]): { name: string; args: Token[][] } | null {
  const head = tokens[0];
  if (head?.kind !== 'word' || !isOp(tokens[1], '(') || closingBracket(tokens, 1) !== tokens.length - 1) return null;
  return { name: head.lower, args: commaSeparated(tokens.slice(2, -1)) };
}

const TEXT_TYPES = new Set(['text', 'varchar']);

/** A string literal, optionally cast to text: its value; null for NULL; undefined otherwise. */
function readTextLiteral(tokens: readonly Token[]): string | null | undefined {
  const { expr, cast } = withoutCast(stripParens(tokens));
  if (cast !== null && !TEXT_TYPES.has(cast)) return undefined;
  const inner = stripParens(expr);
  if (inner.length !== 1) return undefined;
  const only = inner[0];
  if (isLiteral(only)) return only.value;
  if (isWord(only, 'NULL')) return null;
  return undefined;
}

type Translations = Record<string, string>;

function parseTranslationsJson(text: string): Translations {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SqlReadError(`invalid JSON ${JSON.stringify(text.slice(0, 80))}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SqlReadError('a translations value must be a JSON object');
  const out: Translations = {};
  for (const [language, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new SqlReadError(`the "${language}" translation is not a string`);
    out[language] = value;
  }
  return out;
}

/** An INSERT row's translations: '{"en": ...}'[::jsonb] or jsonb_build_object('en', '...', ...). */
function readTranslationsValue(tokens: readonly Token[]): Translations {
  const { expr, cast } = withoutCast(stripParens(tokens));
  const inner = stripParens(expr);
  const only = inner.length === 1 ? inner[0] : undefined;
  if (isLiteral(only) && (cast === null || cast === 'jsonb' || cast === 'json')) return parseTranslationsJson(only.value);
  const call = cast === null ? readCall(inner) : null;
  if (call && (call.name === 'jsonb_build_object' || call.name === 'json_build_object') && call.args.length % 2 === 0) {
    const out: Translations = {};
    for (let k = 0; k < call.args.length; k += 2) {
      const language = readTextLiteral(call.args[k] ?? []);
      const text = readTextLiteral(call.args[k + 1] ?? []);
      if (typeof language !== 'string' || typeof text !== 'string') {
        throw new SqlReadError(`${call.name}() arguments must be string literals in ${render(tokens)}`);
      }
      out[language] = text;
    }
    return out;
  }
  throw new SqlReadError(`cannot read the translations value ${render(tokens)}`);
}

interface QualifiedName {
  schema: string | null;
  name: string;
  next: number;
}

function readQualifiedName(tokens: readonly Token[], start: number): QualifiedName | null {
  const first = nameOf(tokens[start]);
  if (first === null) return null;
  if (!isOp(tokens[start + 1], '.')) return { schema: null, name: first, next: start + 1 };
  const second = nameOf(tokens[start + 2]);
  return second === null ? null : { schema: first, name: second, next: start + 3 };
}

const isTranslationsTable = (name: QualifiedName | null): boolean =>
  Boolean(name && name.name === 'translations' && (name.schema === null || name.schema === 'public'));

type WriteVerb = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'MERGE' | 'COPY';

/** Every place a statement writes public.translations (GRANT, policy and trigger syntax never match). */
function findTranslationsWrites(tokens: readonly Token[]): Array<{ verb: WriteVerb; at: number }> {
  const writes: Array<{ verb: WriteVerb; at: number }> = [];
  tokens.forEach((token, i) => {
    if (token.kind !== 'word') return;
    let target: QualifiedName | null = null;
    switch (token.upper) {
      case 'INSERT':
      case 'MERGE':
        if (isWord(tokens[i + 1], 'INTO')) target = readQualifiedName(tokens, i + 2);
        break;
      case 'UPDATE':
        target = readQualifiedName(tokens, isWord(tokens[i + 1], 'ONLY') ? i + 2 : i + 1);
        break;
      case 'DELETE':
        if (isWord(tokens[i + 1], 'FROM')) target = readQualifiedName(tokens, isWord(tokens[i + 2], 'ONLY') ? i + 3 : i + 2);
        break;
      case 'COPY':
        target = readQualifiedName(tokens, i + 1);
        break;
      case 'TRUNCATE': {
        let j = i + 1;
        if (isWord(tokens[j], 'TABLE')) j += 1;
        if (isWord(tokens[j], 'ONLY')) j += 1;
        for (let name = readQualifiedName(tokens, j); name; name = isOp(tokens[name.next], ',') ? readQualifiedName(tokens, name.next + 1) : null) {
          if (isTranslationsTable(name)) {
            target = name;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
    if (isTranslationsTable(target)) writes.push({ verb: token.upper as WriteVerb, at: i });
  });
  return writes;
}

/**
 * Code a statement carries as a literal: a DO body, a function body (`AS $$ ... $$`, runs only
 * when called) or an EXECUTE of one whole literal (a concatenated EXECUTE is never read).
 */
function codeBodies(tokens: readonly Token[]): Array<{ kind: 'do' | 'function' | 'execute'; sql: string }> {
  const bodies: Array<{ kind: 'do' | 'function' | 'execute'; sql: string }> = [];
  tokens.forEach((token, i) => {
    if (!isLiteral(token)) return;
    const previous = tokens[i - 1];
    const following = tokens[i + 1];
    if (isWord(previous, 'DO') || (isWord(tokens[i - 3], 'DO') && isWord(tokens[i - 2], 'LANGUAGE'))) {
      bodies.push({ kind: 'do', sql: token.value });
    } else if (isWord(previous, 'AS')) {
      bodies.push({ kind: 'function', sql: token.value });
    } else if (isWord(previous, 'EXECUTE') && (following === undefined || isWord(following, 'INTO') || isWord(following, 'USING'))) {
      bodies.push({ kind: 'execute', sql: token.value });
    }
  });
  return bodies;
}

/** Whether code that runs while the migration applies (top level, DO, EXECUTE) writes translations. */
function writesTranslations(sql: string): boolean {
  return splitStatements(lexSql(sql)).some(
    (statement) =>
      findTranslationsWrites(statement).length > 0 ||
      codeBodies(statement).some((body) => body.kind !== 'function' && writesTranslations(body.sql))
  );
}

/* ---------------------------------------------------------------- INSERT --- */

type ConflictAction =
  | { type: 'error' }
  | { type: 'nothing'; target: 'key' | null }
  | { type: 'update'; merge: 'replace' | 'incoming-wins' | 'existing-wins' };

interface ParsedInsert {
  schema: string | null;
  columns: string[];
  rows: Token[][][];
  conflict: ConflictAction;
}

function readConflictMerge(tokens: readonly Token[], refs: ReadonlySet<string>): 'replace' | 'incoming-wins' | 'existing-wins' {
  const isExcluded = (part: readonly Token[]): boolean => {
    const expr = stripParens(part);
    return expr.length === 3 && isWord(expr[0], 'EXCLUDED') && isOp(expr[1], '.') && nameOf(expr[2]) === 'translations';
  };
  const isExisting = (part: readonly Token[]): boolean => {
    const expr = stripParens(part);
    if (expr.length === 1) return nameOf(expr[0]) === 'translations';
    if (expr.length === 3) return refs.has(nameOf(expr[0]) ?? '') && isOp(expr[1], '.') && nameOf(expr[2]) === 'translations';
    return (
      expr.length === 5 &&
      nameOf(expr[0]) === 'public' &&
      isOp(expr[1], '.') &&
      nameOf(expr[2]) === 'translations' &&
      isOp(expr[3], '.') &&
      nameOf(expr[4]) === 'translations'
    );
  };
  const parts = splitConcat(stripParens(tokens));
  const [first = [], second = []] = parts;
  if (parts.length === 1 && isExcluded(first)) return 'replace';
  if (parts.length === 2 && isExisting(first) && isExcluded(second)) return 'incoming-wins';
  if (parts.length === 2 && isExcluded(first) && isExisting(second)) return 'existing-wins';
  throw new SqlReadError(`cannot read ON CONFLICT DO UPDATE SET translations = ${render(tokens)}`);
}

function parseConflict(tokens: readonly Token[], start: number, refs: ReadonlySet<string>): { action: ConflictAction; next: number } {
  let i = start;
  let target: 'key' | null = null;
  if (isOp(tokens[i], '(')) {
    const end = closingBracket(tokens, i);
    const inner = tokens.slice(i + 1, end);
    if (inner.length !== 1 || nameOf(inner[0]) !== 'key') throw new SqlReadError('ON CONFLICT must target (key), the primary key');
    target = 'key';
    i = end + 1;
  } else if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'CONSTRAINT')) {
    if (nameOf(tokens[i + 2]) !== 'translations_pkey') throw new SqlReadError('ON CONFLICT ON CONSTRAINT must name translations_pkey');
    target = 'key';
    i += 3;
  }
  if (!isWord(tokens[i], 'DO')) throw new SqlReadError('expected ON CONFLICT ... DO NOTHING or DO UPDATE');
  if (isWord(tokens[i + 1], 'NOTHING')) return { action: { type: 'nothing', target }, next: i + 2 };
  if (!isWord(tokens[i + 1], 'UPDATE') || !isWord(tokens[i + 2], 'SET') || target === null) {
    throw new SqlReadError('expected ON CONFLICT (key) DO UPDATE SET ...');
  }
  const end = indexOfTopLevelWord(tokens, i + 3, ['WHERE', 'RETURNING']);
  if (isWord(tokens[end], 'WHERE')) throw new SqlReadError('ON CONFLICT DO UPDATE ... WHERE is not understood');
  let merge: 'replace' | 'incoming-wins' | 'existing-wins' | null = null;
  for (const assignment of commaSeparated(tokens.slice(i + 3, end))) {
    const column = nameOf(assignment[0]);
    if (column === null || !isOp(assignment[1], '=')) throw new SqlReadError(`cannot read the assignment ${render(assignment)}`);
    if (column === 'updated_at' || column === 'created_at') continue;
    if (column !== 'translations') throw new SqlReadError(`ON CONFLICT DO UPDATE sets ${column}; only translations is understood`);
    merge = readConflictMerge(assignment.slice(2), refs);
  }
  if (merge === null) throw new SqlReadError('ON CONFLICT DO UPDATE does not set translations');
  return { action: { type: 'update', merge }, next: end };
}

/** `INSERT INTO <table> [AS alias] (columns) VALUES (...), ... [ON CONFLICT ...] [RETURNING ...]`. */
function parseInsert(tokens: readonly Token[]): ParsedInsert {
  const target = readQualifiedName(tokens, 2);
  if (!isWord(tokens[0], 'INSERT') || !isWord(tokens[1], 'INTO') || !target) throw new SqlReadError('expected INSERT INTO <table>');
  let i = target.next;
  const refs = new Set(['translations']);
  if (isWord(tokens[i], 'AS')) {
    const alias = nameOf(tokens[i + 1]);
    if (alias === null) throw new SqlReadError('INSERT INTO ... AS without an alias');
    refs.add(alias);
    i += 2;
  }
  if (!isOp(tokens[i], '(')) throw new SqlReadError('list the columns: INSERT INTO public.translations (key, translations, created_at, updated_at)');
  const columnsEnd = closingBracket(tokens, i);
  const columns = commaSeparated(tokens.slice(i + 1, columnsEnd)).map((part) => {
    const name = part.length === 1 ? nameOf(part[0]) : null;
    if (name === null) throw new SqlReadError(`cannot read the column list ${render(tokens.slice(i, columnsEnd + 1))}`);
    return name;
  });
  i = columnsEnd + 1;
  if (!isWord(tokens[i], 'VALUES')) throw new SqlReadError('only INSERT ... VALUES (...) is understood, not INSERT ... SELECT');
  i += 1;
  const rows: Token[][][] = [];
  while (isOp(tokens[i], '(')) {
    const end = closingBracket(tokens, i);
    rows.push(commaSeparated(tokens.slice(i + 1, end)));
    i = end + 1;
    if (!isOp(tokens[i], ',')) break;
    i += 1;
  }
  if (rows.length === 0) throw new SqlReadError('INSERT ... VALUES without rows');
  let conflict: ConflictAction = { type: 'error' };
  if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'CONFLICT')) {
    const parsed = parseConflict(tokens, i + 2, refs);
    conflict = parsed.action;
    i = parsed.next;
  }
  if (isWord(tokens[i], 'RETURNING')) i = tokens.length;
  if (i < tokens.length) throw new SqlReadError(`unexpected ${render(tokens.slice(i, i + 4))} after the VALUES rows`);
  return { schema: target.schema, columns, rows, conflict };
}

/* ------------------------------------------------------- UPDATE and DELETE --- */

interface ValuesTable {
  alias: string;
  columns: string[];
  rows: Array<Record<string, string | null>>;
}

/** How a WHERE or SET may name things: the target row (`refs`) and the FROM (VALUES ...) table. */
interface RowScope {
  refs: ReadonlySet<string>;
  values: ValuesTable | null;
}

type Operand =
  | { kind: 'key' }
  | { kind: 'text'; language: string }
  | { kind: 'column'; column: string }
  | { kind: 'literal'; value: string | null };

type Condition =
  | { kind: 'keys'; keys: ReadonlySet<string> }
  | { kind: 'join'; column: string }
  | { kind: 'compare'; language: string; op: 'eq' | 'ne' | 'distinct' | 'same'; value: Operand }
  | { kind: 'null'; language: string; negated: boolean }
  | { kind: 'unknown'; text: string };

interface JsonbEdit {
  language: string;
  value: Operand;
}

/** `key`, `t.key` or `public.translations.key`: a column of the row being updated or deleted. */
function isRowColumn(tokens: readonly Token[], scope: RowScope, column: string): boolean {
  const expr = stripParens(tokens);
  if (expr.length === 1) return nameOf(expr[0]) === column && !(scope.values?.columns.includes(column) ?? false);
  if (expr.length === 3) return scope.refs.has(nameOf(expr[0]) ?? '') && isOp(expr[1], '.') && nameOf(expr[2]) === column;
  return (
    expr.length === 5 &&
    nameOf(expr[0]) === 'public' &&
    isOp(expr[1], '.') &&
    nameOf(expr[2]) === 'translations' &&
    isOp(expr[3], '.') &&
    nameOf(expr[4]) === column
  );
}

function readOperand(tokens: readonly Token[], scope: RowScope): Operand | null {
  const expr = stripParens(tokens);
  const n = expr.length;
  if (isRowColumn(expr, scope, 'key')) return { kind: 'key' };
  const language = expr[n - 1];
  if (n >= 5 && isOp(expr[n - 4], '-') && isOp(expr[n - 3], '>') && isOp(expr[n - 2], '>') && isLiteral(language)) {
    if (isRowColumn(expr.slice(0, n - 4), scope, 'translations')) return { kind: 'text', language: language.value };
  }
  const values = scope.values;
  if (values && n === 3 && nameOf(expr[0]) === values.alias && isOp(expr[1], '.')) {
    const column = nameOf(expr[2]);
    if (column !== null && values.columns.includes(column)) return { kind: 'column', column };
  }
  const literal = readTextLiteral(expr);
  return literal === undefined ? null : { kind: 'literal', value: literal };
}

/** A text value: a FROM (VALUES ...) column or a string literal, optionally cast to text. */
function readTextOperand(tokens: readonly Token[], scope: RowScope): Operand | null {
  const { expr, cast } = withoutCast(stripParens(tokens));
  if (cast !== null && !TEXT_TYPES.has(cast)) return null;
  const operand = readOperand(expr, scope);
  return operand && (operand.kind === 'column' || operand.kind === 'literal') ? operand : null;
}

function parseCondition(tokens: readonly Token[], scope: RowScope): Condition {
  const unknown: Condition = { kind: 'unknown', text: render(tokens) };
  const expr = stripParens(tokens);

  const inAt = indexOfTopLevelWord(expr, 0, ['IN']);
  if (inAt < expr.length) {
    const list = expr.slice(inAt + 1);
    if (isWord(expr[inAt - 1], 'NOT') || !isRowColumn(expr.slice(0, inAt), scope, 'key')) return unknown;
    if (!isOp(list[0], '(') || closingBracket(list, 0) !== list.length - 1) return unknown;
    const keys = commaSeparated(list.slice(1, -1)).map((part) => readTextLiteral(part));
    return keys.every((key): key is string => typeof key === 'string') ? { kind: 'keys', keys: new Set(keys) } : unknown;
  }

  const isAt = indexOfTopLevelWord(expr, 0, ['IS']);
  if (isAt < expr.length) {
    const left = readOperand(expr.slice(0, isAt), scope);
    if (left?.kind !== 'text') return unknown;
    let j = isAt + 1;
    const negated = isWord(expr[j], 'NOT');
    if (negated) j += 1;
    if (isWord(expr[j], 'NULL') && j === expr.length - 1) return { kind: 'null', language: left.language, negated };
    if (isWord(expr[j], 'DISTINCT') && isWord(expr[j + 1], 'FROM')) {
      const right = readTextOperand(expr.slice(j + 2), scope);
      return right ? { kind: 'compare', language: left.language, op: negated ? 'same' : 'distinct', value: right } : unknown;
    }
    return unknown;
  }

  let opAt = -1;
  let width = 1;
  let op: 'eq' | 'ne' | null = null;
  let depth = 0;
  for (let k = 0; k < expr.length && op === null; k += 1) {
    const token = expr[k];
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    else if (depth === 0 && isOp(token, '=')) {
      if (isOp(expr[k - 1], '<') || isOp(expr[k - 1], '>')) return unknown;
      const negated = isOp(expr[k - 1], '!');
      opAt = negated ? k - 1 : k;
      width = negated ? 2 : 1;
      op = negated ? 'ne' : 'eq';
    } else if (depth === 0 && isOp(token, '<') && isOp(expr[k + 1], '>')) {
      opAt = k;
      width = 2;
      op = 'ne';
    }
  }
  if (op === null || opAt <= 0) return unknown;
  const left = readOperand(expr.slice(0, opAt), scope);
  const right = readOperand(expr.slice(opAt + width), scope);
  if (!left || !right) return unknown;
  const [subject, other] = left.kind === 'key' || left.kind === 'text' ? [left, right] : [right, left];
  if (subject.kind === 'key' && op === 'eq') {
    if (other.kind === 'literal' && other.value !== null) return { kind: 'keys', keys: new Set([other.value]) };
    if (other.kind === 'column') return { kind: 'join', column: other.column };
    return unknown;
  }
  if (subject.kind === 'text' && (other.kind === 'literal' || other.kind === 'column')) {
    return { kind: 'compare', language: subject.language, op, value: other };
  }
  return unknown;
}

/** The WHERE as a conjunction; a top-level OR, CASE or BETWEEN makes the whole clause unknown. */
function parseWhere(tokens: readonly Token[] | null, scope: RowScope): Condition[] {
  if (tokens === null) return [];
  if (indexOfTopLevelWord(tokens, 0, ['OR', 'CASE', 'BETWEEN']) < tokens.length) return [{ kind: 'unknown', text: render(tokens) }];
  return splitTopLevel(tokens, (token) => isWord(token, 'AND')).map((part) => parseCondition(part, scope));
}

/** `FROM (VALUES (...), ...) [AS] alias(columns)`, every value a string literal or NULL. */
function parseValuesTable(tokens: readonly Token[]): ValuesTable {
  const refuse = (): SqlReadError =>
    new SqlReadError(`only FROM (VALUES (...), ...) AS alias(columns) is understood, not FROM ${render(tokens)}`);
  if (!isOp(tokens[0], '(')) throw refuse();
  const close = closingBracket(tokens, 0);
  const inner = tokens.slice(1, close);
  if (!isWord(inner[0], 'VALUES')) throw refuse();
  const rowTokens: Token[][][] = [];
  let i = 1;
  while (isOp(inner[i], '(')) {
    const end = closingBracket(inner, i);
    rowTokens.push(commaSeparated(inner.slice(i + 1, end)));
    i = end + 1;
    if (!isOp(inner[i], ',')) break;
    i += 1;
  }
  if (i !== inner.length || rowTokens.length === 0) throw refuse();
  let j = close + 1;
  if (isWord(tokens[j], 'AS')) j += 1;
  const alias = nameOf(tokens[j]);
  if (alias === null || !isOp(tokens[j + 1], '(') || closingBracket(tokens, j + 1) !== tokens.length - 1) throw refuse();
  const columns = commaSeparated(tokens.slice(j + 2, -1)).map((part) => {
    const name = part.length === 1 ? nameOf(part[0]) : null;
    if (name === null) throw refuse();
    return name;
  });
  const rows = rowTokens.map((values) => {
    if (values.length !== columns.length) throw new SqlReadError(`a VALUES row has ${values.length} values for ${columns.length} columns`);
    const row: Record<string, string | null> = {};
    values.forEach((value, index) => {
      const text = readTextLiteral(value);
      if (text === undefined) throw new SqlReadError(`VALUES rows must hold string literals, not ${render(value)}`);
      row[columns[index] as string] = text;
    });
    return row;
  });
  return { alias, columns, rows };
}

function readPathLanguage(tokens: readonly Token[]): string {
  const { expr, cast } = withoutCast(stripParens(tokens));
  const inner = stripParens(expr);
  const only = inner.length === 1 ? inner[0] : undefined;
  if (isLiteral(only) && (cast === null || cast === 'text[]')) {
    const match = /^\{\s*"?([A-Za-z][A-Za-z0-9_-]*)"?\s*\}$/.exec(only.value);
    if (match?.[1]) return match[1];
  }
  const element = inner[2];
  if (cast === null && inner.length === 4 && isWord(inner[0], 'ARRAY') && isOp(inner[1], '[') && isLiteral(element) && isOp(inner[3], ']')) {
    return element.value;
  }
  throw new SqlReadError(`the jsonb_set path ${render(tokens)} is not one language like '{fr}'`);
}

/** jsonb_set's new value: to_jsonb(<text>) or a JSON string literal cast to jsonb. */
function readJsonbText(tokens: readonly Token[], scope: RowScope): Operand {
  const { expr, cast } = withoutCast(stripParens(tokens));
  const inner = stripParens(expr);
  const call = cast === null ? readCall(inner) : null;
  if (call?.name === 'to_jsonb' && call.args.length === 1) {
    const operand = readTextOperand(call.args[0] ?? [], scope);
    if (operand) return operand;
  }
  const only = inner.length === 1 ? inner[0] : undefined;
  if (isLiteral(only) && cast === 'jsonb') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(only.value);
    } catch {
      parsed = null;
    }
    if (typeof parsed === 'string') return { kind: 'literal', value: parsed };
  }
  throw new SqlReadError(`cannot read the jsonb_set value ${render(tokens)} (write to_jsonb(<text>))`);
}

/** The right operand of `translations || ...`: jsonb_build_object(...) or a jsonb literal. */
function readObjectEdits(tokens: readonly Token[], scope: RowScope): JsonbEdit[] {
  const { expr, cast } = withoutCast(stripParens(tokens));
  const inner = stripParens(expr);
  const only = inner.length === 1 ? inner[0] : undefined;
  if (isLiteral(only) && (cast === 'jsonb' || cast === 'json')) {
    return Object.entries(parseTranslationsJson(only.value)).map(([language, value]) => ({
      language,
      value: { kind: 'literal', value },
    }));
  }
  const call = cast === null ? readCall(inner) : null;
  if (call?.name === 'jsonb_build_object' && call.args.length % 2 === 0) {
    const edits: JsonbEdit[] = [];
    for (let k = 0; k < call.args.length; k += 2) {
      const language = readTextLiteral(call.args[k] ?? []);
      const value = readTextOperand(call.args[k + 1] ?? [], scope);
      if (typeof language !== 'string' || !value) throw new SqlReadError(`cannot read ${render(tokens)}`);
      edits.push({ language, value });
    }
    return edits;
  }
  throw new SqlReadError(`cannot read ${render(tokens)} as a translations object`);
}

/** SET translations = jsonb_set(...) | <row>.translations || jsonb_build_object(...), nested freely. */
function readJsonbEdits(tokens: readonly Token[], scope: RowScope): JsonbEdit[] {
  const expr = stripParens(tokens);
  const parts = splitConcat(expr);
  if (parts.length > 1) {
    const edits = readJsonbEdits(parts[0] ?? [], scope);
    for (const part of parts.slice(1)) edits.push(...readObjectEdits(part, scope));
    return edits;
  }
  if (isRowColumn(expr, scope, 'translations')) return [];
  const call = readCall(expr);
  if (call?.name === 'jsonb_set' && (call.args.length === 3 || call.args.length === 4)) {
    if (call.args.length === 4 && !isWord(stripParens(call.args[3] ?? [])[0], 'TRUE')) {
      throw new SqlReadError('jsonb_set(..., false) is not understood');
    }
    const edits = readJsonbEdits(call.args[0] ?? [], scope);
    edits.push({ language: readPathLanguage(call.args[1] ?? []), value: readJsonbText(call.args[2] ?? [], scope) });
    return edits;
  }
  throw new SqlReadError(`cannot read the new translations value ${render(tokens)}`);
}

function readUpdateEdits(set: readonly Token[], scope: RowScope): JsonbEdit[] {
  let edits: JsonbEdit[] | null = null;
  for (const assignment of commaSeparated(set)) {
    const column = nameOf(assignment[0]);
    if (column === null || !isOp(assignment[1], '=')) throw new SqlReadError(`cannot read the assignment ${render(assignment)}`);
    if (column === 'updated_at' || column === 'created_at') continue;
    if (column !== 'translations') throw new SqlReadError(`this UPDATE sets ${column}; only translations (and updated_at) are understood`);
    edits = readJsonbEdits(assignment.slice(2), scope);
  }
  if (edits === null) throw new SqlReadError('this UPDATE does not set translations');
  return edits;
}

interface WriteParts {
  refs: Set<string>;
  set: Token[];
  from: Token[] | null;
  where: Token[] | null;
}

/** `UPDATE [ONLY] t [[AS] a] SET ... [FROM ...] [WHERE ...]` and `DELETE FROM [ONLY] t [[AS] a] [WHERE ...]`. */
function splitWrite(tokens: readonly Token[], verb: 'UPDATE' | 'DELETE'): WriteParts {
  let i = verb === 'UPDATE' ? 1 : 2;
  if (isWord(tokens[i], 'ONLY')) i += 1;
  const target = readQualifiedName(tokens, i);
  if (!target) throw new SqlReadError(`${verb} without a table`);
  i = target.next;
  const refs = new Set<string>();
  const clause = verb === 'UPDATE' ? ['SET'] : ['WHERE', 'USING', 'RETURNING'];
  const afterTable = tokens[i];
  if (isWord(afterTable, 'AS')) {
    refs.add(nameOf(tokens[i + 1]) ?? '');
    i += 2;
  } else if (afterTable?.kind === 'word' && !clause.includes(afterTable.upper)) {
    refs.add(afterTable.lower);
    i += 1;
  } else {
    refs.add('translations');
  }
  let set: Token[] = [];
  if (verb === 'UPDATE') {
    if (!isWord(tokens[i], 'SET')) throw new SqlReadError('expected UPDATE ... SET');
    const end = indexOfTopLevelWord(tokens, i + 1, ['FROM', 'WHERE', 'RETURNING']);
    set = tokens.slice(i + 1, end);
    i = end;
  }
  let from: Token[] | null = null;
  if (isWord(tokens[i], 'FROM') || isWord(tokens[i], 'USING')) {
    if (verb === 'DELETE') throw new SqlReadError('DELETE ... USING is not understood');
    const end = indexOfTopLevelWord(tokens, i + 1, ['WHERE', 'RETURNING']);
    from = tokens.slice(i + 1, end);
    i = end;
  }
  let where: Token[] | null = null;
  if (isWord(tokens[i], 'WHERE')) {
    const end = indexOfTopLevelWord(tokens, i + 1, ['RETURNING']);
    where = tokens.slice(i + 1, end);
    i = end;
  }
  if (i < tokens.length && !isWord(tokens[i], 'RETURNING')) throw new SqlReadError(`unexpected ${render(tokens.slice(i, i + 4))}`);
  return { refs, set, from, where };
}

function textOf(row: Translations, language: string): string | null {
  return Object.prototype.hasOwnProperty.call(row, language) ? (row[language] as string) : null;
}

function resolveOperand(operand: Operand, valuesRow: Record<string, string | null> | null): string | null {
  if (operand.kind === 'literal') return operand.value;
  if (operand.kind === 'column' && valuesRow) return valuesRow[operand.column] ?? null;
  throw new SqlReadError('a VALUES column is used without a VALUES row');
}

function conditionHolds(condition: Condition, key: string, row: Translations, valuesRow: Record<string, string | null> | null): boolean {
  switch (condition.kind) {
    case 'keys':
      return condition.keys.has(key);
    case 'join':
      return valuesRow !== null && valuesRow[condition.column] === key;
    case 'null':
      return (textOf(row, condition.language) === null) !== condition.negated;
    case 'compare': {
      const actual = textOf(row, condition.language);
      const expected = resolveOperand(condition.value, valuesRow);
      if (condition.op === 'distinct') return actual !== expected;
      if (condition.op === 'same') return actual === expected;
      if (actual === null || expected === null) return false;
      return condition.op === 'eq' ? actual === expected : actual !== expected;
    }
    default:
      throw new SqlReadError(`cannot read the condition ${condition.text}`);
  }
}

/** The keys a WHERE (and its VALUES join) can reach, or null when nothing restricts them. */
function reachableKeys(conditions: readonly Condition[], values: ValuesTable | null): Set<string> | null {
  const restrictions: Array<ReadonlySet<string>> = [];
  for (const condition of conditions) {
    if (condition.kind === 'keys') restrictions.push(condition.keys);
    else if (condition.kind === 'join' && values) {
      restrictions.push(new Set(values.rows.map((row) => row[condition.column]).filter((key): key is string => typeof key === 'string')));
    }
  }
  const [first, ...rest] = restrictions;
  if (!first) return null;
  return new Set([...first].filter((key) => rest.every((keys) => keys.has(key))));
}

/* ------------------------------------------------------------------ replay --- */

interface SeedState {
  rows: Map<string, Translations>;
  /** The migration whose INSERT created the row. */
  createdBy: Map<string, string>;
}

function applyInsert(insert: ParsedInsert, state: SeedState, file: string): void {
  const keyAt = insert.columns.indexOf('key');
  const valueAt = insert.columns.indexOf('translations');
  if (keyAt === -1 || valueAt === -1) throw new SqlReadError('an INSERT into public.translations must set key and translations');
  const inThisStatement = new Set<string>();
  for (const row of insert.rows) {
    if (row.length !== insert.columns.length) throw new SqlReadError(`a row has ${row.length} values for ${insert.columns.length} columns`);
    const key = readTextLiteral(row[keyAt] ?? []);
    if (typeof key !== 'string') throw new SqlReadError(`every key must be a string literal, not ${render(row[keyAt] ?? [])}`);
    const value = readTranslationsValue(row[valueAt] ?? []);
    const existing = state.rows.get(key);
    const repeated = inThisStatement.has(key);
    inThisStatement.add(key);
    if (!existing) {
      state.rows.set(key, { ...value });
      state.createdBy.set(key, file);
    } else if (insert.conflict.type === 'error') {
      throw new SqlReadError(`${key} already exists and this INSERT has no ON CONFLICT: it fails with a unique violation`);
    } else if (insert.conflict.type === 'update') {
      if (repeated) throw new SqlReadError(`${key} appears twice in one INSERT ... ON CONFLICT DO UPDATE, which Postgres refuses`);
      const { merge } = insert.conflict;
      state.rows.set(key, merge === 'replace' ? { ...value } : merge === 'incoming-wins' ? { ...existing, ...value } : { ...value, ...existing });
    }
  }
}

function applyUpdate(tokens: readonly Token[], state: SeedState): void {
  const parts = splitWrite(tokens, 'UPDATE');
  const values = parts.from ? parseValuesTable(parts.from) : null;
  const scope: RowScope = { refs: parts.refs, values };
  const edits = readUpdateEdits(parts.set, scope);
  const conditions = parseWhere(parts.where, scope);
  const unknown = conditions.find((condition) => condition.kind === 'unknown');
  if (unknown) throw new SqlReadError(`cannot read the condition ${render(parts.where ?? [])}`);
  const join = conditions.find((condition): condition is Extract<Condition, { kind: 'join' }> => condition.kind === 'join');
  if (values && !join) throw new SqlReadError('UPDATE ... FROM (VALUES ...) must join on t.key = <values alias>.<column>');

  for (const [key, row] of [...state.rows]) {
    let valuesRow: Record<string, string | null> | null = null;
    if (values && join) {
      const matches = values.rows.filter((candidate) => candidate[join.column] === key);
      if (matches.length > 1) throw new SqlReadError(`${key} appears in more than one VALUES row`);
      valuesRow = matches[0] ?? null;
      if (!valuesRow) continue;
    }
    if (!conditions.every((condition) => conditionHolds(condition, key, row, valuesRow))) continue;
    const next = { ...row };
    for (const edit of edits) {
      const text = resolveOperand(edit.value, valuesRow);
      if (text === null) throw new SqlReadError(`${key}: this UPDATE would set translations to NULL`);
      next[edit.language] = text;
    }
    state.rows.set(key, next);
  }
}

function applyDelete(tokens: readonly Token[], state: SeedState): void {
  const parts = splitWrite(tokens, 'DELETE');
  const conditions = parseWhere(parts.where, { refs: parts.refs, values: null });
  if (conditions.some((condition) => condition.kind === 'unknown')) throw new SqlReadError(`cannot read the condition ${render(parts.where ?? [])}`);
  for (const [key, row] of [...state.rows]) {
    if (conditions.every((condition) => conditionHolds(condition, key, row, null))) {
      state.rows.delete(key);
      state.createdBy.delete(key);
    }
  }
}

/** The keys a statement can touch, read leniently (null: unknown, could be any). */
function statementReach(tokens: readonly Token[], verb: WriteVerb): Set<string> | null {
  try {
    if (verb === 'INSERT') {
      const insert = parseInsert(tokens);
      const keyAt = insert.columns.indexOf('key');
      const keys = insert.rows.map((row) => readTextLiteral(row[keyAt] ?? []));
      return keyAt !== -1 && keys.every((key): key is string => typeof key === 'string') ? new Set(keys) : null;
    }
    if (verb === 'UPDATE' || verb === 'DELETE') {
      const parts = splitWrite(tokens, verb);
      let values: ValuesTable | null = null;
      try {
        values = parts.from ? parseValuesTable(parts.from) : null;
      } catch {
        values = null;
      }
      return reachableKeys(parseWhere(parts.where, { refs: parts.refs, values }), values);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * One statement of a migration that runs at or after 02031. A write this reader cannot replay
 * fails, unless its WHERE / VALUES keys show it cannot touch a key the test checks.
 */
function applyStatement(tokens: readonly Token[], state: SeedState, file: string, tracked: ReadonlySet<string>): void {
  for (const body of codeBodies(tokens)) {
    if (body.kind !== 'function' && writesTranslations(body.sql)) {
      throw new SqlReadError(
        `a ${body.kind === 'do' ? 'DO block' : 'dynamic EXECUTE'} writes public.translations; seed rows with top-level INSERT, UPDATE or DELETE statements`
      );
    }
  }
  const writes = findTranslationsWrites(tokens);
  const write = writes[0];
  if (!write) return;
  if (writes.length > 1 || write.at !== 0) {
    throw new SqlReadError('write public.translations with one plain INSERT, UPDATE, DELETE or TRUNCATE per statement (no WITH, no second write)');
  }
  try {
    switch (write.verb) {
      case 'INSERT':
        applyInsert(parseInsert(tokens), state, file);
        return;
      case 'UPDATE':
        applyUpdate(tokens, state);
        return;
      case 'DELETE':
        applyDelete(tokens, state);
        return;
      case 'TRUNCATE':
        state.rows.clear();
        state.createdBy.clear();
        return;
      default:
        throw new SqlReadError(`${write.verb} on public.translations is not understood`);
    }
  } catch (error) {
    const reach = error instanceof SqlReadError ? statementReach(tokens, write.verb) : null;
    if (reach && [...reach].every((key) => !tracked.has(key))) return;
    throw error;
  }
}

interface MigrationSource {
  file: string;
  sql: string;
}

function replayMigrations(sources: readonly MigrationSource[], tracked: ReadonlySet<string>): SeedState {
  const state: SeedState = { rows: new Map(), createdBy: new Map() };
  for (const { file, sql } of sources) {
    let statements: Token[][];
    try {
      statements = splitStatements(lexSql(sql));
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const statement of statements) {
      try {
        applyStatement(statement, state, file, tracked);
      } catch (error) {
        if (!(error instanceof SqlReadError)) throw error;
        throw new Error(
          `${file}: ${error.message}\n  in: ${render(statement)}\n` +
            `  ${THIS_TEST} replays INSERT ... VALUES [ON CONFLICT (key) DO NOTHING | DO UPDATE], the 02015 ` +
            'UPDATE ... FROM (VALUES ...) jsonb_set pattern, DELETE ... WHERE key IN (...) and TRUNCATE. ' +
            'Write the change in one of those forms, or teach the test the new one.'
        );
      }
    }
  }
  return state;
}

/** Every key an INSERT INTO public.translations creates, at any depth (DO, function, EXECUTE bodies). */
function collectSeededKeys(sql: string, file: string, into: Map<string, string>): void {
  for (const statement of splitStatements(lexSql(sql))) {
    statement.forEach((token, i) => {
      if (!isWord(token, 'INSERT') || !isWord(statement[i + 1], 'INTO') || !isTranslationsTable(readQualifiedName(statement, i + 2))) return;
      for (const key of insertedKeys(statement.slice(i))) if (!into.has(key)) into.set(key, file);
    });
    for (const body of codeBodies(statement)) collectSeededKeys(body.sql, file, into);
  }
}

function insertedKeys(tokens: readonly Token[]): string[] {
  try {
    const insert = parseInsert(tokens);
    const keyAt = insert.columns.indexOf('key');
    const keys = insert.rows.map((row) => readTextLiteral(row[keyAt] ?? []));
    if (keyAt !== -1 && keys.every((key): key is string => typeof key === 'string')) return keys;
  } catch (error) {
    if (!(error instanceof SqlReadError)) throw error;
  }
  // Unreadable: every literal of the statement counts as a key, so a collision is never missed.
  return tokens.filter(isLiteral).map((token) => token.value);
}

/* --------------------------------------------------------------- copy rules --- */

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const SITE_WIDE_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;
const INVISIBLE_CODE_POINTS = new Set([0x00a0, 0x00ad, 0x061c, 0x180e, 0x2007, 0x2028, 0x2029, 0x202f, 0xfeff]);

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/** A control or invisible character in `text` (U+XXXX), or null. Newlines count when `allowNewlines` is false. */
function forbiddenCharacter(text: string, allowNewlines = false): string | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (allowNewlines && code === 10) continue;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      INVISIBLE_CODE_POINTS.has(code) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

/** At most `limit` problems, then a count, so a broken migration does not print 600 lines. */
function firstProblems(problems: readonly string[], limit = 25): string[] {
  return problems.length <= limit ? [...problems] : [...problems.slice(0, limit), `… and ${problems.length - limit} more`];
}

/* -------------------------------------------------------------- migrations --- */

const MIGRATION_FILE = /^\d{5}_[a-z0-9_]+\.sql$/;
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();
const SEED_INDEX = MIGRATION_FILES.indexOf(SEED_FILE);

function readMigration(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

let replayed: SeedState | null = null;
/** 02031 and every later migration, replayed in order. */
function seededState(): SeedState {
  if (SEED_INDEX === -1) throw new Error(`${SEED_FILE} is missing: run ${GENERATOR} --write`);
  replayed ??= replayMigrations(
    MIGRATION_FILES.slice(SEED_INDEX).map((file) => ({ file, sql: readMigration(file) })),
    TRACKED_KEYS
  );
  return replayed;
}

let earlier: Map<string, string> | null = null;
/** key → the first migration before 02031 that seeds it. */
function seededBefore02031(): Map<string, string> {
  if (earlier === null) {
    const found = new Map<string, string>();
    for (const file of MIGRATION_FILES.slice(0, Math.max(SEED_INDEX, 0))) collectSeededKeys(readMigration(file), file, found);
    earlier = found;
  }
  return earlier;
}

let mentioned: Map<string, string> | null = null;
/**
 * key-shaped literal → the first migration before 02031 whose raw text quotes it. A second net
 * under the parsed collector: it also sees a rename (`SET key = '...'`), a format() template and
 * the doubled quotes of an EXECUTE string.
 */
function literalsBefore02031(): Map<string, string> {
  if (mentioned === null) {
    const found = new Map<string, string>();
    for (const file of MIGRATION_FILES.slice(0, Math.max(SEED_INDEX, 0))) {
      for (const match of readMigration(file).matchAll(/'([a-z0-9_]+(?:\.[a-z0-9_]+)*)'/g)) {
        const literal = match[1] ?? '';
        if (!found.has(literal)) found.set(literal, file);
      }
    }
    mentioned = found;
  }
  return mentioned;
}

function seedStatements(): Token[][] {
  return splitStatements(lexSql(readMigration(SEED_FILE)));
}

/* ------------------------------------------------------------------- tests --- */

describe(`${SEED_FILE}`, () => {
  it('exists in the migrations folder', () => {
    expect(MIGRATION_FILES).toContain(SEED_FILE);
  });

  it('is plain text with a header naming its generator, and no control or invisible character', () => {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, SEED_FILE), 'utf8');
    const sql = raw.replace(/\r\n/g, '\n');
    expect(raw.charCodeAt(0), 'no byte-order mark').not.toBe(0xfeff);
    expect(sql.startsWith('-- '), 'starts with a comment header').toBe(true);
    expect(sql).toContain(GENERATOR);
    expect(forbiddenCharacter(sql, true)).toBeNull();
  });

  it('holds only INSERT INTO public.translations ... ON CONFLICT (key) DO NOTHING statements', () => {
    const problems: string[] = [];
    const statements = seedStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const writes = findTranslationsWrites(statement);
      if (writes.length !== 1 || writes[0]?.verb !== 'INSERT' || writes[0].at !== 0) {
        problems.push(`not a plain INSERT into public.translations: ${render(statement)}`);
        continue;
      }
      const insert = parseInsert(statement);
      if (insert.schema !== 'public') problems.push(`name the schema: INSERT INTO public.translations (${render(statement.slice(0, 6))})`);
      if (insert.columns.join(',') !== 'key,translations,created_at,updated_at') problems.push(`columns ${insert.columns.join(', ')}`);
      if (insert.conflict.type !== 'nothing' || insert.conflict.target !== 'key') problems.push('every statement ends ON CONFLICT (key) DO NOTHING');
    }
    expect(problems).toEqual([]);
  });

  it("writes each key once, sorted within its statement, as (key, jsonb_build_object('en', ..., 'fr', ...), now(), now())", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    // Statements of another shape are reported by the test above.
    for (const statement of seedStatements().filter((tokens) => findTranslationsWrites(tokens)[0]?.at === 0 && isWord(tokens[0], 'INSERT'))) {
      const keys: string[] = [];
      for (const [keyTokens = [], valueTokens = [], created = [], updated = []] of parseInsert(statement).rows) {
        const key = readTextLiteral(keyTokens);
        if (typeof key !== 'string') {
          problems.push(`a key that is not a string literal: ${render(keyTokens)}`);
          continue;
        }
        keys.push(key);
        if (seen.has(key)) problems.push(`${key}: seeded twice`);
        seen.add(key);
        const call = readCall(stripParens(valueTokens));
        const languages = call?.args.filter((_arg, index) => index % 2 === 0).map((arg) => readTextLiteral(arg));
        if (call?.name !== 'jsonb_build_object' || languages?.join(',') !== 'en,fr') {
          problems.push(`${key}: write jsonb_build_object('en', '...', 'fr', '...'), not ${render(valueTokens)}`);
        }
        for (const stamp of [created, updated]) {
          const now = readCall(stripParens(stamp));
          if (now?.name !== 'now' || now.args.length !== 0) problems.push(`${key}: created_at and updated_at are now()`);
        }
      }
      const sorted = [...keys].sort();
      if (keys.join('\n') !== sorted.join('\n')) problems.push(`keys out of order in the statement that starts with ${keys[0] ?? '?'}`);
    }
    expect(firstProblems(problems)).toEqual([]);
  });
});

describe('seeded copy parity (02031 and every later migration, replayed)', () => {
  function mismatches(entries: ReadonlyArray<readonly [string, AffiliatesCopyEntry]>): string[] {
    const { rows } = seededState();
    const problems: string[] = [];
    for (const [key, entry] of entries) {
      const seeded = rows.get(key);
      if (!seeded) {
        problems.push(`${key}: not seeded by ${SEED_FILE} or a later migration`);
        continue;
      }
      for (const language of ['en', 'fr'] as const) {
        const actual = textOf(seeded, language);
        if (actual !== entry[language]) {
          problems.push(`${key}.${language}: seeded ${JSON.stringify(actual)}, dictionary ${JSON.stringify(entry[language])}`);
        }
      }
    }
    return problems;
  }

  it('seeds every AFFILIATES_COPY key with exactly the dictionary English and French', () => {
    expect(DICTIONARY_ENTRIES.length).toBeGreaterThan(0);
    expect(firstProblems(mismatches(DICTIONARY_ENTRIES))).toEqual([]);
  });

  it('seeds every site-wide key of AFFILIATE_GLOBAL_TRANSLATIONS with exactly its English and French', () => {
    expect(SITE_WIDE_ENTRIES.length).toBeGreaterThan(0);
    expect(firstProblems(mismatches(SITE_WIDE_ENTRIES))).toEqual([]);
  });

  it('leaves no affiliates.* row the dictionaries lost, and no unlisted site-wide row from 02031', () => {
    const { rows, createdBy } = seededState();
    const problems: string[] = [];
    for (const key of rows.keys()) {
      const listed = key.startsWith(AFFILIATES_COPY_KEY_PREFIX)
        ? Object.prototype.hasOwnProperty.call(AFFILIATES_COPY, key)
        : createdBy.get(key) !== SEED_FILE || Object.prototype.hasOwnProperty.call(SITE_WIDE_COPY, key);
      if (!listed) problems.push(`${key}: seeded by ${createdBy.get(key) ?? '?'} but no longer listed; delete the row in a new migration (DELETE FROM public.translations WHERE key IN (...))`);
    }
    expect(firstProblems(problems)).toEqual([]);
  });

  it('uses each {placeholder} at most once per value, the same set in English and French, and no invisible character', () => {
    const { rows } = seededState();
    const problems: string[] = [];
    for (const key of TRACKED_KEYS) {
      const seeded = rows.get(key);
      if (!seeded) continue;
      for (const [language, text] of Object.entries(seeded)) {
        const names = placeholdersOf(text);
        const repeated = names.filter((name, index) => names.indexOf(name) !== index);
        if (repeated.length > 0) problems.push(`${key}.${language}: {${repeated[0]}} appears more than once (t() replaces only the first)`);
        const invisible = forbiddenCharacter(text);
        if (invisible) problems.push(`${key}.${language}: contains ${invisible}`);
      }
      const en = placeholdersOf(textOf(seeded, 'en') ?? '').sort().join(',');
      const fr = placeholdersOf(textOf(seeded, 'fr') ?? '').sort().join(',');
      if (en !== fr) problems.push(`${key}: English uses {${en}}, French {${fr}}`);
    }
    expect(firstProblems(problems)).toEqual([]);
  });
});

describe('keys seeded before 02031', () => {
  it('are read from every earlier migration, inside the baseline DO block and the catch-up EXECUTE bodies too', () => {
    const found = seededBefore02031();
    expect(found.size).toBeGreaterThan(400);
    expect(found.get('or_continue_with')).toBe('02004_baseline_seed.sql');
    expect(found.get('ecommerce.contact_seller')).toBe('02000_catchup_gen1.sql');
    expect(found.get('two_factor.title')).toBe('02015_public_copy_typography_and_a11y_keys.sql');
    expect(found.get('ecommerce.coupon_invalid')).toBe('02022_security_hardening_writer_boundary_and_aal.sql');
  }, 30_000);

  it('never include an affiliates.* or site-wide key of this feature (ON CONFLICT DO NOTHING would keep the older text)', () => {
    const found = seededBefore02031();
    const collisions = [...TRACKED_KEYS]
      .filter((key) => found.has(key))
      .map((key) => `${key}: already seeded by ${found.get(key)}; pick a new key`);
    expect(collisions).toEqual([]);
    expect([...found.keys()].filter((key) => key.startsWith(AFFILIATES_COPY_KEY_PREFIX))).toEqual([]);

    const quoted = literalsBefore02031();
    expect(quoted.get('or_continue_with'), 'the literal scan reads the baseline seed').toBe('02004_baseline_seed.sql');
    const literalCollisions = [...TRACKED_KEYS]
      .filter((key) => quoted.has(key))
      .map((key) => `${key}: quoted in ${quoted.get(key)} (a rename or template there would make it an existing row)`);
    expect(literalCollisions).toEqual([]);
  }, 30_000);
});

describe('AFFILIATE_GLOBAL_TRANSLATIONS (apps/nextblock/lib/i18n/global-affiliate-keys.ts)', () => {
  it('lists site-wide keys only, each with trimmed English and Québec French copy', () => {
    const problems: string[] = [];
    for (const [key, entry] of SITE_WIDE_ENTRIES) {
      if (key.startsWith(AFFILIATES_COPY_KEY_PREFIX)) problems.push(`${key}: affiliates.* keys belong in the package dictionaries`);
      if (!SITE_WIDE_KEY.test(key)) problems.push(`${key}: lowercase snake_case segments joined by dots`);
      for (const language of ['en', 'fr'] as const) {
        const text: unknown = entry?.[language];
        if (typeof text !== 'string' || text.trim() === '' || text !== text.trim()) {
          problems.push(`${key}.${language}: missing, empty or untrimmed`);
          continue;
        }
        if (text.includes('...')) problems.push(`${key}.${language}: use … not ...`);
        if (/<\/?[a-z]/i.test(text)) problems.push(`${key}.${language}: copy is plain text`);
      }
      const fr = typeof entry?.fr === 'string' ? entry.fr : '';
      if (/[^\s]:(?=\s|$)/.test(fr) || /[^\s]%/.test(fr)) problems.push(`${key}.fr: Québec French puts a space before ':' and '%'`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the migration replay', () => {
  const TRACKED = new Set(['k', 'other']);
  const replay = (...sources: string[]): SeedState =>
    replayMigrations(sources.map((sql, index) => ({ file: `test_${index}.sql`, sql })), TRACKED);
  const insert = (rows: string, tail = 'ON CONFLICT (key) DO NOTHING'): string =>
    `INSERT INTO public.translations (key, translations, created_at, updated_at) VALUES ${rows} ${tail};`;

  it('keeps the first INSERT ... ON CONFLICT DO NOTHING, as Postgres does', () => {
    const state = replay(
      insert(`('k', jsonb_build_object('en', 'First', 'fr', 'Premier'), now(), now())`),
      insert(`('k', '{"en": "Second", "fr": "Deuxième"}'::jsonb, now(), now()), ('k', '{"en": "Third"}', now(), now())`)
    );
    expect(state.rows.get('k')).toEqual({ en: 'First', fr: 'Premier' });
    expect(state.createdBy.get('k')).toBe('test_0.sql');
  });

  it('applies a 02015-style correction only where the old seeded text is still there', () => {
    const state = replay(
      insert(`('k', jsonb_build_object('en', 'Old', 'fr', 'Ancien'), now(), now()), ('other', jsonb_build_object('en', 'Edited', 'fr', 'Modifié'), now(), now())`),
      `UPDATE public.translations AS t
       SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)),
           updated_at = now()
       FROM (
         VALUES
           ('k', 'Ancien', 'Nouveau'),
           ('other', 'Pas le texte actuel', 'Ignoré')
       ) AS fix(key, old_fr, new_fr)
       WHERE t.key = fix.key
         AND t.translations->>'fr' = fix.old_fr;`,
      `UPDATE public.translations AS t
       SET translations = jsonb_set(jsonb_set(t.translations, '{en}', to_jsonb(fix.new_en)), '{fr}', to_jsonb(fix.new_fr::text))
       FROM (VALUES ('k', 'Old', 'New', 'Nouveau 2')) AS fix(key, old_en, new_en, new_fr)
       WHERE t.key = fix.key AND (t.translations->>'en') = fix.old_en;`
    );
    expect(state.rows.get('k')).toEqual({ en: 'New', fr: 'Nouveau 2' });
    expect(state.rows.get('other')).toEqual({ en: 'Edited', fr: 'Modifié' });
  });

  it('reads ON CONFLICT DO UPDATE, || jsonb_build_object, guards, DELETE and TRUNCATE', () => {
    const merged = replay(
      insert(`('k', '{"en": "A", "fr": "B"}'::jsonb, now(), now())`),
      insert(
        `('k', jsonb_build_object('en', 'A2'), now(), now())`,
        'ON CONFLICT (key) DO UPDATE SET translations = public.translations.translations || EXCLUDED.translations, updated_at = now()'
      ),
      `UPDATE public.translations SET translations = translations || jsonb_build_object('es', 'C') WHERE key = 'k' AND translations->>'es' IS NULL;`,
      `UPDATE public.translations SET translations = translations || jsonb_build_object('es', 'Never') WHERE key IN ('k') AND translations->>'fr' IS DISTINCT FROM 'B';`
    );
    expect(merged.rows.get('k')).toEqual({ en: 'A2', fr: 'B', es: 'C' });

    const replaced = replay(
      insert(`('k', '{"en": "A", "fr": "B"}', now(), now()), ('other', '{"en": "O"}', now(), now())`),
      insert(`('k', jsonb_build_object('en', 'Z', 'fr', 'Y'), now(), now())`, 'ON CONFLICT ON CONSTRAINT translations_pkey DO UPDATE SET translations = EXCLUDED.translations'),
      `DELETE FROM public.translations WHERE key IN ('other');`
    );
    expect([...replaced.rows]).toEqual([['k', { en: 'Z', fr: 'Y' }]]);

    expect(replay(insert(`('k', '{"en": "A"}', now(), now())`), 'TRUNCATE TABLE public.translations;').rows.size).toBe(0);
  });

  it('keeps quotes, semicolons, comments, dollar quotes and E strings inside literals', () => {
    const state = replay(
      `-- a comment with a quote ' and a semicolon ;
       /* a block comment ' /* nested */ still a comment */
       INSERT INTO public.translations (key, translations, created_at, updated_at)
       VALUES ('k', jsonb_build_object('en', 'It''s done; really', 'fr', $fr$C'est fait ; vraiment$fr$), now(), now())
       ON CONFLICT (key) DO NOTHING;
       INSERT INTO public.translations (key, translations) VALUES ('other', jsonb_build_object('en', E'Tab\\there, it\\'s', 'fr', 'x'));`
    );
    expect(state.rows.get('k')).toEqual({ en: "It's done; really", fr: "C'est fait ; vraiment" });
    expect(state.rows.get('other')).toEqual({ en: "Tab\there, it's", fr: 'x' });
  });

  it('refuses a write it cannot replay when it may touch a checked key, and skips one that cannot', () => {
    const seed = insert(`('k', '{"en": "A", "fr": "B"}', now(), now())`);
    expect(() => replay(seed, `UPDATE public.translations SET translations = '{}'::jsonb WHERE key LIKE 'k%';`)).toThrow(
      /test_1\.sql: cannot read the new translations value/
    );
    expect(() => replay(seed, `DO $$ BEGIN INSERT INTO public.translations (key, translations) VALUES ('k', '{}'); END $$;`)).toThrow(
      /DO block writes public\.translations/
    );
    expect(() => replay(seed, insert(`('k', '{"en": "Again"}', now(), now())`, ''))).toThrow(/unique violation/);
    expect(() =>
      replay(seed, `WITH moved AS (DELETE FROM public.translations WHERE key = 'k' RETURNING key) SELECT count(*) FROM moved;`)
    ).toThrow(/one plain INSERT, UPDATE, DELETE or TRUNCATE/);

    // 02015's ellipsis pass: unreadable, but its key list cannot reach a checked key.
    const ellipsis = (keys: string) => `UPDATE public.translations AS t
      SET translations = (
            SELECT jsonb_object_agg(entry.key, to_jsonb(regexp_replace(entry.value, '[.]{3}$', '…')))
            FROM jsonb_each_text(t.translations) AS entry(key, value)
          ),
          updated_at = now()
      WHERE t.key IN (${keys})
        AND EXISTS (SELECT 1 FROM jsonb_each_text(t.translations) AS entry(key, value) WHERE entry.value ~ '[.]{3}$');`;
    expect(replay(seed, ellipsis(`'saving', 'retry'`)).rows.get('k')).toEqual({ en: 'A', fr: 'B' });
    expect(() => replay(seed, ellipsis(`'saving', 'k'`))).toThrow(/cannot read the new translations value/);
  });

  it('collects seeded keys from DO bodies and whole-literal EXECUTE bodies', () => {
    const found = new Map<string, string>();
    collectSeededKeys(
      `DO $outer$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM public.languages) THEN
           INSERT INTO public.translations (key, translations, created_at, updated_at) VALUES ('in_do', '{"en": "x"}', now(), now()) ON CONFLICT DO NOTHING;
         END IF;
         EXECUTE $inner$INSERT INTO public.translations (key, translations) VALUES ('in_execute', '{"en": "y"}')$inner$;
       END
       $outer$;
       GRANT INSERT, UPDATE ON public.translations TO authenticated;`,
      'test.sql',
      found
    );
    expect([...found.keys()].sort()).toEqual(['in_do', 'in_execute']);
  });
});
