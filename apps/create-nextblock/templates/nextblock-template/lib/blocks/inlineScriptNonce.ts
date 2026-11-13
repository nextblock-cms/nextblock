/**
 * Sanitize author-supplied block HTML before it is rendered via dangerouslySetInnerHTML or
 * html-react-parser.
 *
 * The sanitizer lives in `@nextblock-cms/utils` (`libs/utils/src/lib/authored-html.ts`, with its
 * history and its tests) so the libs render authored HTML through the same function: the
 * product short description and description renderers in `@nextblock-cms/ecommerce` rendered it
 * raw until 2026-11-03. This module keeps the app's import path and the deprecated nonce helper.
 */
import { sanitizeAuthoredBlockHtml } from '@nextblock-cms/utils';

export { sanitizeAuthoredBlockHtml };

/**
 * @deprecated Kept so existing call sites compile; the nonce argument is ignored. Use
 * {@link sanitizeAuthoredBlockHtml}. Authored block HTML is sanitized, never nonce-blessed.
 */
export function addNonceToInlineScripts(html: string, _nonce: string): string {
  return sanitizeAuthoredBlockHtml(html || '');
}
