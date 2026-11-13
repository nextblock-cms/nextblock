/**
 * Text cleaning shared by the storefront sanitizer, the starter documents and the renderer.
 * Pure and deterministic; running a cleaner on its own output changes nothing.
 */

/** Characters removed outright (tab, CR, LF and the line separators are mapped instead). */
function isRemovedCode(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

/** Index of the first character `cleanStorefrontText()` would change, or -1. */
function firstUncleanIndex(value: string, singleLine: boolean): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code < 0x7f) continue;
    if (code === 0x0a) {
      if (singleLine) return index;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return index;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return index;
    if (code === 0x09 || code === 0x0d || code === 0x2028 || code === 0x2029 || isRemovedCode(code)) return index;
  }
  return -1;
}

export interface StorefrontCleanTextOptions {
  /** Map line breaks to spaces (alt texts, titles, names). Default: keep `\n`. */
  singleLine?: boolean;
}

export interface StorefrontCleanTextResult {
  text: string;
  /** True when a character was removed or replaced. */
  altered: boolean;
}

/**
 * Removes C0 and C1 control characters (keeps `\n` unless `singleLine`), DEL, bidi
 * embedding/override/isolate controls (U+202A–U+202E, U+2066–U+2069), BOM/ZWNBSP, the
 * interlinear annotation controls, the noncharacters U+FFFE/U+FFFF and lone surrogates.
 * CRLF and CR become `\n`, U+2028/U+2029 become `\n`, a tab becomes a space. Emoji, accents,
 * NBSP, ZWJ/ZWNJ and LRM/RLM are kept.
 */
export function cleanStorefrontText(
  value: string,
  options: StorefrontCleanTextOptions = {},
): StorefrontCleanTextResult {
  const singleLine = options.singleLine === true;
  const first = firstUncleanIndex(value, singleLine);
  if (first < 0) return { text: value, altered: false };
  const lineBreak = singleLine ? ' ' : '\n';
  const parts: string[] = [value.slice(0, first)];
  let altered = false;
  for (let index = first; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        parts.push(value.slice(index, index + 2));
        index += 1;
      } else {
        altered = true;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      altered = true;
      continue;
    }
    if (code === 0x0a) {
      parts.push(lineBreak);
      if (singleLine) altered = true;
      continue;
    }
    if (code === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
      parts.push(lineBreak);
      altered = true;
      continue;
    }
    if (code === 0x2028 || code === 0x2029) {
      parts.push(lineBreak);
      altered = true;
      continue;
    }
    if (code === 0x09) {
      parts.push(' ');
      altered = true;
      continue;
    }
    if (isRemovedCode(code)) {
      altered = true;
      continue;
    }
    parts.push(value.charAt(index));
  }
  return { text: parts.join(''), altered };
}

/** Cuts `value` to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function truncateStorefrontText(value: string, max: number): string {
  const limit = Math.max(0, Math.floor(max));
  if (value.length <= limit) return value;
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * Whitespace, control characters and the characters Unicode marks as default-ignorable (zero-width
 * spaces and joiners, soft hyphen, bidi and other format controls, variation selectors, fillers),
 * plus the blank braille pattern: a text made only of these shows nothing.
 */
const STOREFRONT_VISIBLE_CHARACTER = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}⠀]/u;

/**
 * True when some `text` node among `content` (a block's inline children) holds a visible
 * character. Hard breaks, whitespace and invisible format characters do not count, so a heading
 * or callout made only of them is blank. Reads own properties only; anything else is ignored.
 */
export function hasStorefrontVisibleText(content: readonly unknown[]): boolean {
  for (const node of content) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'type') || record['type'] !== 'text') continue;
    const text = Object.prototype.hasOwnProperty.call(record, 'text') ? record['text'] : undefined;
    if (typeof text === 'string' && STOREFRONT_VISIBLE_CHARACTER.test(text)) return true;
  }
  return false;
}

/**
 * UTF-8 byte length of `value` (lone surrogates count 3 bytes, as `TextEncoder` would encode
 * U+FFFD). Stops counting once the total exceeds `stopAfter` and returns that partial total.
 */
export function storefrontUtf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

/**
 * UTF-8 byte length of `value` as Postgres prints it as jsonb (`content::text`, the unit of the
 * `draft_content` / `published_content` CHECKs of migration 02030): compact JSON plus one space
 * after every `:` and `,` outside strings. Postgres escapes strings exactly as `JSON.stringify`
 * does, and a sanitized document holds only small integers, so for one this is
 * `octet_length(value::jsonb::text)` exactly. 0 for a value JSON cannot represent (`undefined`).
 */
export function storefrontJsonbTextByteLength(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  if (typeof json !== 'string') return 0;
  let separators = 0;
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index += 1; // a backslash escapes the next character
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x3a || code === 0x2c) {
      separators += 1;
    }
  }
  return storefrontUtf8ByteLength(json) + separators;
}
