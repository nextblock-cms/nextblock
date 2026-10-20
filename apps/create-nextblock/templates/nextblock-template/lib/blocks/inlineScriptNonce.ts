/**
 * Sanitize author-supplied block HTML before it is rendered via dangerouslySetInnerHTML.
 *
 * SECURITY (2026-10-19): the previous behaviour stamped the request's CSP nonce onto every inline
 * <script> in block HTML so authored scripts would run. Block HTML is written by any WRITER (a
 * lower-trust content role), and the rendered output appears on public pages AND inside the
 * authenticated /cms shell, so nonce-blessing authored <script> turned a WRITER text block into
 * stored XSS that executed for every visitor and every admin — defeating the whole point of the
 * site's nonce-based CSP. We no longer bless authored scripts: inline and remote <script> tags,
 * inline event-handler attributes, and `javascript:`/`data:text/html` URLs are stripped out. The
 * site's own operator scripts have a separate, ADMIN-only, server-nonced path (site_scripts).
 *
 * This is a conservative strip, not a general-purpose HTML sanitizer; a full allowlist sanitizer
 * (e.g. DOMPurify via jsdom) is the recommended follow-up for defence in depth against other
 * markup vectors. The production CSP (`script-src` nonce + `script-src-attr 'none'`) remains the
 * backstop for anything this misses.
 */
export function sanitizeAuthoredBlockHtml(html: string): string {
  if (!html) return '';
  return (
    html
      // whole <script>…</script> blocks (any attributes, any case, across newlines)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      // a dangling/self-closed <script …> with no close tag
      .replace(/<script\b[^>]*\/?>/gi, '')
      // inline event handlers: on<name>="…" | '…' | bare
      .replace(/\son[a-z]+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s">]+/gi, '')
      // javascript:/vbscript:/data:text/html URLs in href/src/xlink:href
      .replace(/((?:href|src|xlink:href)\s*=\s*)(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1$2#$2')
  );
}

/**
 * @deprecated Kept so existing call sites compile; the nonce argument is ignored. Use
 * {@link sanitizeAuthoredBlockHtml}. Authored block HTML is sanitized, never nonce-blessed.
 */
export function addNonceToInlineScripts(html: string, _nonce: string): string {
  return sanitizeAuthoredBlockHtml(html || '');
}
