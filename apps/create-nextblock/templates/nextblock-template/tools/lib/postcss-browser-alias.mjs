// Adds the postcss browser alias to the next.config.js of a project scaffolded before 0.23.4.
//
// 0.23.4 put sanitize-html (the authored-HTML allowlist in @nextblock-cms/utils) into client
// bundles. It requires postcss as it loads but never calls it with style parsing off, so the
// app's next.config.js resolves `postcss` to the empty lib/browser-stubs/postcss.cjs for the
// `browser` condition (turbopack.resolveAlias): about 18 KB gzipped off every client chunk that
// imports the sanitizer. A new scaffold inherits that entry (create-nextblock derives its
// next.config.js from the app's file). An existing project does not: next.config.js is the
// project's own file, outside the update's framework paths, so the update copies the stub in
// while the old config keeps bundling all of postcss, and nothing fails to say so.
//
// The patch is textual and anchored, like the CLI's own next.config.js patches. The entry goes
// into the file's only `turbopack: { … resolveAlias: { … } }` object (scaffolds from 0.19 to
// 0.23.3), or a `resolveAlias` holding it goes into its only `turbopack: { … }` object (earlier
// scaffolds). Anything else, or anything ambiguous, is left alone and the update prints the entry
// to add by hand. A file that already mentions browser-stubs/postcss is never touched.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** The stub the alias points at, relative to the project root. lib/ is framework-owned, so the update copies it. */
export const POSTCSS_STUB_PATH = 'lib/browser-stubs/postcss.cjs';

/** The entry the app's next.config.js carries under turbopack.resolveAlias. */
export const POSTCSS_ALIAS_ENTRY = "postcss: { browser: './lib/browser-stubs/postcss.cjs' },";

/** A config that mentions this has the alias, or its owner chose otherwise: it is never touched. */
const ALIAS_MARKER = 'browser-stubs/postcss';

/** The comment above the entry in the app's next.config.js, so a patched config reads like a new scaffold's. */
const ALIAS_COMMENT = [
  '// Browser bundles only: sanitize-html requires postcss but never calls it with style',
  '// parsing off, so the client gets an empty module instead of ~18 KB gzipped of postcss.',
  '// lib/browser-stubs/postcss.test.ts proves the sanitizer still works against the stub.',
];

/** The file create-nextblock writes, and the only one this patches. Next reads it first. */
const CONFIG_FILE = 'next.config.js';
/** The other names Next 16 reads (CONFIG_FILES in next/dist/shared/lib/constants): reported, never patched. */
const OTHER_CONFIG_FILES = ['next.config.mjs', 'next.config.ts'];

/* ----------------------------------------------------------------- lexing --- */

const IDENT = /[\w$]/;
// A `/` after one of these starts a regular expression; after anything else it divides.
const REGEX_AFTER_PUNCTUATOR = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * A copy of `source` with every comment, and the body of every string, template literal and
 * regular expression, blanked to spaces (line breaks kept), so a search or a brace count over it
 * sees only code while every offset still points at the same character of `source`. Quotes and
 * regex slashes stay; a template's `${` and its closing `}` are blanked, and the code inside stays.
 * Returns null when the text does not lex cleanly (an unterminated comment, string, template or
 * regex), so the caller refuses to patch rather than guess.
 */
export function maskNonCode(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const n = source.length;
  const exprDepths = []; // one per open `${`: how many `{` are open inside it
  let inTemplate = false;
  let prev = ''; // the last code character that is not whitespace ('' at the start)
  let prevAt = -1;
  let word = ''; // the identifier ending at prevAt, if one does
  const sawValue = (at) => {
    prev = ')';
    prevAt = at;
    word = '';
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    if (inTemplate) {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (c === '`') {
        inTemplate = false;
        sawValue(i);
        i += 1;
      } else if (c === '$' && source[i + 1] === '{') {
        blank(i, i + 2);
        exprDepths.push(0);
        inTemplate = false;
        prev = '(';
        prevAt = i + 1;
        word = '';
        i += 2;
      } else {
        blank(i, i + 1);
        i += 1;
      }
      continue;
    }

    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < n && source[j] !== c; j++) {
        if (source[j] === '\\') j++;
        else if (source[j] === '\n') return null;
      }
      if (j >= n) return null;
      blank(i + 1, j);
      sawValue(j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_AFTER_PUNCTUATOR.has(prev) || (IDENT.test(prev) && REGEX_AFTER_KEYWORD.has(word)))) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const r = source[j];
        if (r === '\\') {
          j++;
          continue;
        }
        if (r === '\n') return null;
        if (inClass) {
          if (r === ']') inClass = false;
        } else if (r === '[') inClass = true;
        else if (r === '/') break;
      }
      if (j >= n) return null;
      blank(i + 1, j);
      j += 1;
      while (j < n && IDENT.test(source[j])) j++; // flags
      sawValue(j - 1);
      i = j;
      continue;
    }
    if (exprDepths.length > 0 && (c === '{' || c === '}')) {
      const top = exprDepths.length - 1;
      if (c === '{') {
        exprDepths[top] += 1;
      } else if (exprDepths[top] > 0) {
        exprDepths[top] -= 1;
      } else {
        // The `}` that closes a template's `${`: back into the template text.
        exprDepths.pop();
        blank(i, i + 1);
        inTemplate = true;
        i += 1;
        continue;
      }
    }
    if (!/\s/.test(c)) {
      word = IDENT.test(c) ? (prevAt === i - 1 && IDENT.test(prev) ? word + c : c) : '';
      prev = c;
      prevAt = i;
    }
    i += 1;
  }
  if (inTemplate || exprDepths.length > 0) return null;
  return out.join('');
}

/** Offsets of `word` as an identifier in the masked code: keys, references and member names alike. */
function wordsNamed(masked, word) {
  return [...masked.matchAll(new RegExp(`(?<![\\w$])${word}(?![\\w$])`, 'g'))].map((m) => m.index);
}

/**
 * The offset of the `{` when the identifier at `at` is an object key (after `{` or `,`) whose
 * value is an inline object, as in `turbopack: {`; -1 for anything else.
 */
function inlineObjectKeyAt(masked, at, word) {
  let before = at - 1;
  while (before >= 0 && /\s/.test(masked[before])) before--;
  if (before < 0 || (masked[before] !== '{' && masked[before] !== ',')) return -1;
  const value = /^\s*:\s*\{/.exec(masked.slice(at + word.length));
  return value ? at + word.length + value[0].length - 1 : -1;
}

/** The offset of the `}` that closes the `{` at `open`, or -1. */
function closingBrace(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '{') depth++;
    else if (masked[k] === '}' && --depth === 0) return k;
  }
  return -1;
}

/** True when `at` sits directly inside the object that opens at `open`, not in something nested in it. */
function isDirectChild(masked, open, at) {
  let depth = 0;
  for (let k = open + 1; k < at; k++) {
    const ch = masked[k];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if ((ch === '}' || ch === ']' || ch === ')') && --depth < 0) return false;
  }
  return depth === 0;
}

function compiles(text) {
  try {
    new vm.Script(text, { filename: CONFIG_FILE });
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert `buildLines(unit)` as whole lines just above the `}` at `close`, indented like the
 * object's last line, with a comma after its last entry when it has none. Returns null when the
 * object is written on one line (the `}` shares its line with anything), which is left alone.
 */
function insertAboveClosingBrace(source, masked, open, close, buildLines) {
  const closingLineStart = source.lastIndexOf('\n', close - 1) + 1;
  const closingIndent = source.slice(closingLineStart, close);
  if (closingLineStart <= open || !/^[ \t]*$/.test(closingIndent)) return null;

  let last = close - 1;
  while (last > open && /\s/.test(masked[last])) last--;
  const needsComma = last > open && masked[last] !== ',';

  // The lines strictly between the opening and the closing line (closingLineStart > open, so
  // the opening line ends before the closing one starts).
  const bodyLines = source
    .slice(source.indexOf('\n', open) + 1, closingLineStart)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const indent =
    bodyLines.length > 0
      ? bodyLines[bodyLines.length - 1].match(/^[ \t]*/)[0]
      : closingIndent + (closingIndent.includes('\t') ? '\t' : '  ');
  const unit = indent.includes('\t') ? '\t' : '  ';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const block = buildLines(unit)
    .map((line) => `${indent}${line}${eol}`)
    .join('');

  const withBlock = source.slice(0, closingLineStart) + block + source.slice(closingLineStart);
  return needsComma ? `${withBlock.slice(0, last + 1)},${withBlock.slice(last + 1)}` : withBlock;
}

/* ------------------------------------------------------------- the patch --- */

/**
 * Add the alias to next.config.js source text. Pure: no file access.
 *
 * @param {string} source
 * @returns {{ status: 'present' } | { status: 'patched', text: string, how: 'entry' | 'resolveAlias' } | { status: 'no-anchor', reason: string }}
 */
export function addPostcssBrowserAlias(source) {
  if (source.includes(ALIAS_MARKER)) return { status: 'present' };
  const refuse = (reason) => ({ status: 'no-anchor', reason });

  if (!compiles(source)) return refuse('it does not parse as a CommonJS script');
  const masked = maskNonCode(source);
  if (masked === null) return refuse('it could not be read safely');
  // `masked` blanks quoted keys, and a second `turbopack` or `resolveAlias` key would make the
  // object keep only one of the two.
  if (/['"`](?:turbopack|resolveAlias)['"`]\s*:/.test(source)) {
    return refuse('it names `turbopack` or `resolveAlias` in quotes');
  }

  // Exactly one `turbopack` in the code, and it is the `turbopack: { … }` key: no second key,
  // no `nextConfig.turbopack = …` that could replace the object later.
  const turbopack = wordsNamed(masked, 'turbopack');
  if (turbopack.length === 0) return refuse('it has no `turbopack: { … }` object');
  if (turbopack.length > 1) return refuse('it refers to `turbopack` more than once');
  const turbopackOpen = inlineObjectKeyAt(masked, turbopack[0], 'turbopack');
  if (turbopackOpen === -1) return refuse('its `turbopack` is not a `turbopack: { … }` object');
  const turbopackClose = closingBrace(masked, turbopackOpen);
  if (turbopackClose === -1) return refuse('its `turbopack` object does not close');

  const resolveAlias = wordsNamed(masked, 'resolveAlias');
  let open;
  let close;
  let lines;
  let how;
  if (resolveAlias.length === 0) {
    // Scaffolds before 0.19 carry `turbopack: { // comment }`: give it a resolveAlias holding the entry.
    open = turbopackOpen;
    close = turbopackClose;
    how = 'resolveAlias';
    lines = (unit) => ['resolveAlias: {', ...ALIAS_COMMENT.map((line) => `${unit}${line}`), `${unit}${POSTCSS_ALIAS_ENTRY}`, '},'];
  } else if (resolveAlias.length === 1) {
    const [at] = resolveAlias;
    open = inlineObjectKeyAt(masked, at, 'resolveAlias');
    if (open === -1 || at < turbopackOpen || at > turbopackClose || !isDirectChild(masked, turbopackOpen, at)) {
      return refuse('its `resolveAlias` is not a `resolveAlias: { … }` object directly inside `turbopack`');
    }
    close = closingBrace(masked, open);
    if (close === -1 || close > turbopackClose) return refuse('its `turbopack.resolveAlias` object does not close');
    if (source.slice(open, close).includes('postcss')) {
      return refuse('its `turbopack.resolveAlias` already says something about postcss');
    }
    how = 'entry';
    lines = () => [...ALIAS_COMMENT, POSTCSS_ALIAS_ENTRY];
  } else {
    return refuse('it refers to `resolveAlias` more than once');
  }
  // A spread may already carry the key being added, which the new one would silently override.
  if (masked.slice(open + 1, close).includes('...')) return refuse('the object to extend spreads another object into it');

  const patched = insertAboveClosingBrace(source, masked, open, close, lines);
  if (patched === null) return refuse('the object to extend is written on one line');
  if (!compiles(patched)) return refuse('the patched file would not parse');
  return { status: 'patched', text: patched, how };
}

/**
 * Add the alias to `<projectRoot>/next.config.js` when it lacks it and the stub it points at is
 * there (or arrives with the update: `incomingDir`, the staged template, for a dry run). A patched
 * file's old copy goes to .nextblock-backup/<timestamp>/next.config.js, the way the file-replace
 * fallback in update.mjs keeps what it overwrites.
 *
 * @param {string} projectRoot
 * @param {{ dryRun?: boolean, incomingDir?: string | null, now?: Date }} [options]
 * @returns {{ status: 'present' | 'patched' | 'would-patch' | 'no-anchor' | 'failed' | 'no-stub' | 'no-config', file: string, reason?: string, how?: string, backup?: string }}
 */
export function applyPostcssBrowserAlias(projectRoot, { dryRun = false, incomingDir = null, now = new Date() } = {}) {
  const stubAvailable =
    existsSync(path.join(projectRoot, POSTCSS_STUB_PATH)) ||
    (incomingDir != null && existsSync(path.join(incomingDir, POSTCSS_STUB_PATH)));

  const configPath = path.join(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) {
    const other = OTHER_CONFIG_FILES.find((name) => existsSync(path.join(projectRoot, name)));
    if (!other) return { status: 'no-config', file: CONFIG_FILE };
    let text = '';
    try {
      text = readFileSync(path.join(projectRoot, other), 'utf8');
    } catch {
      /* reported as missing below */
    }
    if (text.includes(ALIAS_MARKER)) return { status: 'present', file: other };
    if (!stubAvailable) return { status: 'no-stub', file: other };
    return { status: 'no-anchor', file: other, reason: `the update only edits ${CONFIG_FILE}` };
  }

  let source;
  try {
    source = readFileSync(configPath, 'utf8');
  } catch (err) {
    return { status: 'failed', file: CONFIG_FILE, reason: `it could not be read (${err?.code ?? err?.message ?? err})` };
  }
  if (source.includes(ALIAS_MARKER)) return { status: 'present', file: CONFIG_FILE };
  // Without the stub the alias would point at nothing and break the build: never add one alone.
  if (!stubAvailable) return { status: 'no-stub', file: CONFIG_FILE };

  let result;
  try {
    result = addPostcssBrowserAlias(source);
  } catch (err) {
    // A bug here must never stop an update: report it like any file the patch cannot handle.
    return { status: 'failed', file: CONFIG_FILE, reason: `the patch failed (${err?.message ?? err})` };
  }
  if (result.status !== 'patched') return { ...result, file: CONFIG_FILE };
  if (dryRun) return { status: 'would-patch', file: CONFIG_FILE, how: result.how };

  const backupRoot = path.join(projectRoot, '.nextblock-backup');
  const backupPath = path.join(backupRoot, now.toISOString().replace(/[:.]/g, '-'), CONFIG_FILE);
  try {
    mkdirSync(path.dirname(backupPath), { recursive: true });
    copyFileSync(configPath, backupPath);
  } catch (err) {
    return { status: 'failed', file: CONFIG_FILE, reason: `its backup could not be written (${err?.code ?? err?.message ?? err})` };
  }
  try {
    // Self-ignoring, like the backups update.mjs writes when it replaces framework files.
    writeFileSync(path.join(backupRoot, '.gitignore'), '# NextBlock update backups — local safety copies, never committed.\n*\n', 'utf8');
  } catch {
    /* non-fatal */
  }
  try {
    writeFileSync(configPath, result.text, 'utf8');
  } catch (err) {
    return { status: 'failed', file: CONFIG_FILE, reason: `it could not be written (${err?.code ?? err?.message ?? err})` };
  }
  return { status: 'patched', file: CONFIG_FILE, how: result.how, backup: path.relative(projectRoot, backupPath) };
}

/**
 * The update log lines for a result of applyPostcssBrowserAlias(): what it changed, what a
 * `--check` run would change, or the entry to add by hand. Nothing for a file that has the
 * alias, or a project without the stub.
 *
 * @param {ReturnType<typeof applyPostcssBrowserAlias> | null | undefined} result
 * @returns {{ level: 'good' | 'warn' | 'info' | 'code' | 'dim', text: string }[]}
 */
export function describePostcssBrowserAlias(result) {
  const file = result?.file ?? CONFIG_FILE;
  switch (result?.status) {
    case 'patched':
      return [
        {
          level: 'good',
          text: `${file}: added the postcss browser alias to turbopack.resolveAlias (backup: ${result.backup})`,
        },
      ];
    case 'would-patch':
      return [{ level: 'dim', text: `would add the postcss browser alias to ${file} (turbopack.resolveAlias)` }];
    case 'no-anchor':
    case 'failed':
      return [
        {
          level: 'warn',
          text:
            result.status === 'failed'
              ? `${file}: this update could not add the postcss browser alias: ${result.reason}.`
              : `${file} has no postcss browser alias, and this update cannot add one safely: ${result.reason}.`,
        },
        { level: 'info', text: `Add this entry to turbopack.resolveAlias in ${file} (create either object if it is missing):` },
        { level: 'code', text: POSTCSS_ALIAS_ENTRY },
        { level: 'dim', text: 'Without it, client bundles that use the HTML sanitizer ship all of postcss (about 18 KB gzipped).' },
      ];
    default:
      return [];
  }
}
