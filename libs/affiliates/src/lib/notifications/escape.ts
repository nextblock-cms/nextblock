/**
 * Output hygiene for the affiliate emails and alerts: HTML escaping for element and attribute
 * contexts, one-line subjects (a subject is a mail header, so CR/LF would inject headers), plain
 * body text without control characters, and the only URLs that may become links.
 */
import { cleanStorefrontText, truncateStorefrontText } from '../storefront/text';

/** Longest subject `buildAffiliateEmail()` returns (the notifier clips at 200 as a last resort). */
export const AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH = 150;

/**
 * Escapes `&`, `<`, `>`, `"`, `'` and `` ` `` so a value is inert inside element content and inside
 * a double- or single-quoted attribute. `null` / `undefined` become ''.
 */
export function escapeAffiliateHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return '&#96;';
    }
  });
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${truncateStorefrontText(value, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface AffiliateEmailTextOptions {
  /** Keep line breaks (notes). Default: one line. */
  multiline?: boolean;
  /** Longest result; longer text is cut and ends with `…`. */
  max?: number;
}

/**
 * Plain text for an email or alert: control, bidi-override and invisible formatting characters
 * removed, line breaks kept only when `multiline` (at most one blank line in a row), runs of
 * spaces collapsed, trimmed. '' for a non-string.
 */
export function cleanAffiliateEmailText(value: unknown, options: AffiliateEmailTextOptions = {}): string {
  if (typeof value !== 'string' || value === '') return '';
  const max = options.max ?? 2000;
  const source = value.length > max * 2 + 16 ? value.slice(0, max * 2 + 16) : value;
  const cleaned = cleanStorefrontText(source, { singleLine: options.multiline !== true }).text;
  const text = options.multiline
    ? cleaned
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : // Regular whitespace only: the no-break spaces of French amounts ("25,00 $") stay put.
      cleaned.replace(/[ \t\n\r\f\v]+/g, ' ').trim();
  return clip(text, max);
}

/** A subject line: one line, whitespace collapsed, at most 150 characters (`…` when cut). */
export function toAffiliateEmailSubject(value: unknown, max: number = AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH): string {
  return cleanAffiliateEmailText(value, { max });
}

/** Controls, spaces, DEL, C1 controls and backslashes never appear in a URL an email links to. */
function hasUnsafeUrlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) return true;
  }
  return false;
}

/**
 * The normalized form of an absolute `https:` / `http:` URL without credentials, or null. Only
 * such URLs become `href`s in an email; anything else (relative paths, `javascript:`, `data:`,
 * `mailto:`, malformed input) is never linked.
 */
export function affiliateEmailHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 2000 || hasUnsafeUrlCharacter(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return url.href;
}
