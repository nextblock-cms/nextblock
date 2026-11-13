/**
 * "Markdown-lite" for copilot-generated copy (SPEC §8): `**bold**`, `*italic*` and
 * `[label](https://…)` become storefront marks; everything else stays literal text. A tiny
 * hand-written scanner (no backtracking regular expressions over the copy, bounded input, nesting
 * capped by the mark flags), so model output can never produce raw HTML, an unknown mark or an
 * unsafe link: every href goes through `sanitizeStorefrontHref`, and a link it refuses keeps its
 * label as plain text. Marks come out in the sanitizer's canonical order (link, bold, italic), so
 * the nodes pass `sanitizeStorefrontDoc()` unchanged.
 */
import { cleanStorefrontText, truncateStorefrontText } from '../storefront/text';
import { sanitizeStorefrontHref } from '../storefront/urls';
import type { StorefrontInlineNode, StorefrontMark, StorefrontTextNode } from '../storefront/types';

export interface RetailerCopilotInlineOptions {
  /** How a line break inside the text renders: a hard break (paragraphs, callouts; default) or a space. */
  lineBreaks?: 'hardBreak' | 'space';
}

/** Characters of model text the parser reads; the rest is cut (the schemas allow at most 4000). */
const MAX_SOURCE_LENGTH = 5000;
/** Bold, italic and link can each open once per nesting path, so three levels is the real maximum. */
const MAX_NESTING = 4;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};
const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const COMMENT_PATTERN = /<!--[\s\S]{0,2000}?-->/g;
/** A tag needs a name right after `<` or `</`, so prose such as `a < b > c` is left alone. */
const TAG_PATTERN = /<(\/?)([A-Za-z][A-Za-z0-9-]{0,30})(?:\s[^<>]{0,500})?\/?>/g;
const LINE_TAGS: ReadonlySet<string> = new Set(['br', 'li', 'tr', 'dt', 'dd']);
const PARAGRAPH_TAGS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'section',
  'article',
  'blockquote',
  'ul',
  'ol',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  href: string | null;
}

interface ParseState {
  bold: boolean;
  italic: boolean;
  href: string | null;
  inLink: boolean;
}

interface LinkMatch {
  labelStart: number;
  labelEnd: number;
  url: string;
  end: number;
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** CommonMark backslash escapes: any ASCII punctuation character. */
function isEscapable(char: string | undefined): boolean {
  if (char === undefined || char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function decodeEntity(match: string, decimal?: string, hex?: string, name?: string): string {
  if (name) return NAMED_ENTITIES[name] ?? match;
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
  return String.fromCodePoint(code);
}

/**
 * Turns HTML a model slipped into its copy into plain text: the common entities are decoded
 * once, `<br>` and list or table rows become line breaks, block elements become paragraph breaks,
 * every other tag and comment is removed. The result is text, never markup (it is rendered
 * escaped); this only keeps stray tags from showing up literally on a storefront.
 */
export function stripRetailerCopilotHtml(value: string): string {
  if (!value.includes('<') && !value.includes('&')) return value;
  return value
    .replace(ENTITY_PATTERN, decodeEntity)
    .replace(COMMENT_PATTERN, '')
    .replace(TAG_PATTERN, (_match, closing: string, name: string) => {
      const tag = name.toLowerCase();
      if (PARAGRAPH_TAGS.has(tag)) return '\n\n';
      if (LINE_TAGS.has(tag)) return closing === '/' && tag !== 'br' ? '' : '\n';
      return '';
    });
}

/**
 * Cleans model text for the parser: stray HTML removed (`stripRetailerCopilotHtml`), control and
 * invisible formatting characters removed (the storefront text rules), CR/LF unified, runs of
 * spaces collapsed, every line trimmed, at most one blank line in a row, no blank lines at the
 * edges, at most 5000 characters.
 */
export function normalizeRetailerCopilotText(source: unknown): string {
  if (typeof source !== 'string' || source.length === 0) return '';
  const bounded = source.length > MAX_SOURCE_LENGTH * 2 ? source.slice(0, MAX_SOURCE_LENGTH * 2) : source;
  const lines = cleanStorefrontText(stripRetailerCopilotHtml(bounded))
    .text.split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return truncateStorefrontText(kept.join('\n'), MAX_SOURCE_LENGTH).trimEnd();
}

/** Splits model text into paragraphs at blank lines (each paragraph normalized, none empty). */
export function splitRetailerCopilotParagraphs(source: unknown): string[] {
  const normalized = normalizeRetailerCopilotText(source);
  if (normalized === '') return [];
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

/** Index of the `**` that closes a bold run whose content starts at `from`, or -1. */
function findBoldCloser(src: string, from: number, end: number): number {
  if (from >= end || isSpace(src[from])) return -1;
  let index = from;
  while (index < end - 1) {
    const char = src[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '*' && src[index + 1] === '*') {
      // The closer is the last two stars of a run, so `***both***` closes bold after its italic.
      let runEnd = index;
      while (runEnd < end && src[runEnd] === '*') runEnd += 1;
      const closer = runEnd - 2;
      if (closer > from && !isSpace(src[closer - 1])) return closer;
      index = runEnd;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** Index of the `*` that closes an italic run whose content starts at `from`, or -1. */
function findItalicCloser(src: string, from: number, end: number): number {
  if (from >= end || isSpace(src[from])) return -1;
  let index = from;
  while (index < end) {
    const char = src[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '*') {
      let runEnd = index;
      while (runEnd < end && src[runEnd] === '*') runEnd += 1;
      // A pair is a bold run inside the italic; an odd run ends with the italic closer.
      if ((runEnd - index) % 2 === 1) {
        const closer = runEnd - 1;
        if (closer > from && !isSpace(src[closer - 1])) return closer;
      }
      index = runEnd;
      continue;
    }
    index += 1;
  }
  return -1;
}

function unescapeDestination(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && isEscapable(value[index + 1])) {
      out += value[index + 1];
      index += 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** `[label](destination)` or `[label](destination "title")` starting at `start`, or null. */
function matchLink(src: string, start: number, end: number): LinkMatch | null {
  let index = start + 1;
  while (index < end) {
    const char = src[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[' || char === '\n') return null;
    if (char === ']') break;
    index += 1;
  }
  if (index >= end || src[index] !== ']' || index === start + 1 || src[index + 1] !== '(') return null;
  const labelEnd = index;

  let cursor = labelEnd + 2;
  let depth = 0;
  while (cursor < end) {
    const char = src[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '\n') return null;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    cursor += 1;
  }
  if (cursor >= end || src[cursor] !== ')') return null;

  const inner = src.slice(labelEnd + 2, cursor).trim();
  const space = inner.search(/\s/);
  let destination = space < 0 ? inner : inner.slice(0, space);
  const rest = space < 0 ? '' : inner.slice(space).trim();
  // Anything after the destination must be a quoted title: `(https://a.com/x y)` is not a link.
  if (rest !== '' && !/^(?:"[^"]*"|'[^']*')$/.test(rest)) return null;
  if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
  return { labelStart: start + 1, labelEnd, url: unescapeDestination(destination), end: cursor + 1 };
}

function sameMarks(run: Run, other: Pick<Run, 'bold' | 'italic' | 'href'>): boolean {
  return run.bold === other.bold && run.italic === other.italic && run.href === other.href;
}

function pushRun(out: Run[], text: string, state: ParseState): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && sameMarks(last, state)) {
    last.text += text;
    return;
  }
  out.push({ text, bold: state.bold, italic: state.italic, href: state.href });
}

function parseRange(src: string, start: number, end: number, state: ParseState, out: Run[], depth: number): void {
  let buffer = '';
  const flush = (): void => {
    pushRun(out, buffer, state);
    buffer = '';
  };

  let index = start;
  while (index < end) {
    const char = src[index] as string;

    if (char === '\\' && index + 1 < end && isEscapable(src[index + 1])) {
      buffer += src[index + 1];
      index += 2;
      continue;
    }

    if (char === '*' && depth < MAX_NESTING) {
      if (src[index + 1] === '*') {
        if (!state.bold) {
          const closer = findBoldCloser(src, index + 2, end);
          if (closer > 0) {
            flush();
            parseRange(src, index + 2, closer, { ...state, bold: true }, out, depth + 1);
            index = closer + 2;
            continue;
          }
        }
        buffer += '**';
        index += 2;
        continue;
      }
      if (!state.italic) {
        const closer = findItalicCloser(src, index + 1, end);
        if (closer > 0) {
          flush();
          parseRange(src, index + 1, closer, { ...state, italic: true }, out, depth + 1);
          index = closer + 1;
          continue;
        }
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === '!' && src[index + 1] === '[' && !state.inLink) {
      // A markdown image inside prose: dropped (images are their own blocks).
      const image = matchLink(src, index + 1, end);
      if (image) {
        index = image.end;
        continue;
      }
    }

    if (char === '[' && !state.inLink && depth < MAX_NESTING) {
      const link = matchLink(src, index, end);
      if (link) {
        flush();
        // An unsafe or invalid destination drops the link and keeps its label as text.
        const href = sanitizeStorefrontHref(link.url);
        parseRange(src, link.labelStart, link.labelEnd, { ...state, href, inLink: true }, out, depth + 1);
        index = link.end;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }
  flush();
}

function parseRuns(normalized: string): Run[] {
  const runs: Run[] = [];
  parseRange(normalized, 0, normalized.length, { bold: false, italic: false, href: null, inLink: false }, runs, 0);
  return runs;
}

function marksOf(run: Run): StorefrontMark[] {
  // The sanitizer's canonical order (the editor schema's mark rank).
  const marks: StorefrontMark[] = [];
  if (run.href !== null) marks.push({ type: 'link', attrs: { href: run.href } });
  if (run.bold) marks.push({ type: 'bold' });
  if (run.italic) marks.push({ type: 'italic' });
  return marks;
}

function textNode(text: string, run: Run): StorefrontTextNode {
  const marks = marksOf(run);
  return marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
}

/** Drops hard breaks and whitespace at both ends (a text node emptied by trimming is dropped too). */
function trimEdges(nodes: StorefrontInlineNode[]): StorefrontInlineNode[] {
  const out = [...nodes];
  let first = 0;
  let last = out.length - 1;
  while (first <= last) {
    const node = out[first] as StorefrontInlineNode;
    if (node.type === 'text') {
      const text = node.text.replace(/^\s+/, '');
      if (text !== '') {
        out[first] = { ...node, text };
        break;
      }
    }
    first += 1;
  }
  while (last >= first) {
    const node = out[last] as StorefrontInlineNode;
    if (node.type === 'text') {
      const text = node.text.replace(/\s+$/, '');
      if (text !== '') {
        out[last] = { ...node, text };
        break;
      }
    }
    last -= 1;
  }
  return out.slice(first, last + 1);
}

function runsToInline(runs: readonly Run[], lineBreaks: 'hardBreak' | 'space'): StorefrontInlineNode[] {
  const nodes: StorefrontInlineNode[] = [];
  let previousRun: Run | null = null;

  const pushText = (text: string, run: Run): void => {
    const last = nodes[nodes.length - 1];
    // A dropped markdown image or a line break turned into a space can leave two spaces behind.
    let value = text.replace(/ {2,}/g, ' ');
    if (last && last.type === 'text' && last.text.endsWith(' ')) value = value.replace(/^ +/, '');
    if (value === '') return;
    if (last && last.type === 'text' && previousRun !== null && sameMarks(previousRun, run)) {
      nodes[nodes.length - 1] = { ...last, text: last.text + value };
    } else {
      nodes.push(textNode(value, run));
    }
    previousRun = run;
  };

  const pushBreak = (): void => {
    const last = nodes[nodes.length - 1];
    if (!last || last.type === 'hardBreak') return;
    nodes.push({ type: 'hardBreak' });
    previousRun = null;
  };

  for (const run of runs) {
    // A blank line inside inline content is one break (paragraphs are split before parsing).
    const parts = run.text.split(/\n+/);
    parts.forEach((part, index) => {
      if (index > 0) {
        if (lineBreaks === 'hardBreak') pushBreak();
        else pushText(' ', run);
      }
      pushText(part, run);
    });
  }

  return trimEdges(nodes);
}

/**
 * Parses markdown-lite into storefront inline nodes: text with `link` / `bold` / `italic` marks
 * and, unless `lineBreaks: 'space'`, hard breaks for line breaks. Unmatched markers and any other
 * markdown stay literal text, markdown images are dropped. Never throws.
 */
export function parseRetailerCopilotMarkdownLite(
  source: unknown,
  options: RetailerCopilotInlineOptions = {}
): StorefrontInlineNode[] {
  const normalized = normalizeRetailerCopilotText(source);
  if (normalized === '') return [];
  return runsToInline(parseRuns(normalized), options.lineBreaks === 'space' ? 'space' : 'hardBreak');
}

/**
 * The visible text of markdown-lite on one line: markers removed, link labels kept (their URLs
 * dropped), stray HTML removed, line breaks and runs of whitespace turned into single spaces. For
 * headings, titles and the plain-text tool outputs.
 */
export function retailerCopilotMarkdownToPlainText(source: unknown): string {
  const nodes = parseRetailerCopilotMarkdownLite(source, { lineBreaks: 'space' });
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text') text += node.text;
  }
  // Regular whitespace only: a French no-break space before ":" or "%" stays where it is.
  return text.replace(/[\t\n\r ]+/g, ' ').trim();
}
