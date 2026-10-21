/**
 * Sanitize author-supplied block HTML before it is rendered via dangerouslySetInnerHTML.
 *
 * SECURITY (2026-10-19): the previous behaviour stamped the request's CSP nonce onto every inline
 * <script> in block HTML so authored scripts would run. Block HTML is written by any WRITER (a
 * lower-trust content role), and the rendered output appears on public pages AND inside the
 * authenticated /cms shell, so nonce-blessing authored <script> turned a WRITER text block into
 * stored XSS that executed for every visitor and every admin — defeating the whole point of the
 * site's nonce-based CSP. We no longer bless authored scripts.
 *
 * SECURITY (2026-10-21): a review defeated the single-pass version. `<scr<script>ipt>` collapsed
 * into a live `<script>` once the inner tag was removed, `<img src=x/onerror=…>` (no whitespace
 * before the handler) survived, and `<meta http-equiv=refresh>` / `<base href>` were never
 * touched — and those two need no script at all, so the CSP cannot stop them: a WRITER text block
 * could send every visitor and every admin to another site. The strip now repeats until the
 * output stops changing, removes the elements that act without script, and catches handlers and
 * `srcdoc` wherever they sit in a tag.
 *
 * This is still a conservative strip, not an allowlist sanitizer. Replacing it with one
 * (DOMPurify / sanitize-html) is the open follow-up; the production CSP (`script-src` nonce +
 * `script-src-attr 'none'`) remains the backstop for script-based vectors this misses.
 */

/** Elements that act without any script (navigation, base URL, plugins, nested documents). */
const DANGEROUS_PAIRED_ELEMENTS = ['script', 'object', 'applet', 'frameset', 'noembed', 'noframes'];
const DANGEROUS_VOID_ELEMENTS = ['meta', 'base', 'embed', 'frame', 'link'];

function stripOnce(html: string): string {
  let out = html;
  for (const tag of DANGEROUS_PAIRED_ELEMENTS) {
    // whole <tag>…</tag> blocks (any attributes, any case, across newlines)
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
  }
  for (const tag of [...DANGEROUS_PAIRED_ELEMENTS, ...DANGEROUS_VOID_ELEMENTS]) {
    // the opening (or dangling / self-closed) tag on its own, and any stray closing tag
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  return (
    out
      // inline event handlers and srcdoc (an inline same-origin document), after whitespace OR a
      // slash, quoted or bare: <img src=x/onerror=…>
      .replace(/([\s/])(?:on[a-z]+|srcdoc)\s*=\s*"[^"]*"/gi, '$1')
      .replace(/([\s/])(?:on[a-z]+|srcdoc)\s*=\s*'[^']*'/gi, '$1')
      .replace(/([\s/])(?:on[a-z]+|srcdoc)\s*=\s*[^\s"'>]+/gi, '$1')
      // javascript:/vbscript:/data:text/html URLs in URL attributes, quoted or bare
      .replace(
        /((?:href|src|xlink:href|action|formaction|data|poster|background)\s*=\s*)(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi,
        '$1$2#$2'
      )
      .replace(
        /((?:href|src|xlink:href|action|formaction|data|poster|background)\s*=\s*)(?:javascript|vbscript|data:text\/html)[^\s>]*/gi,
        '$1#'
      )
  );
}

export function sanitizeAuthoredBlockHtml(html: string): string {
  if (!html) return '';
  // Repeat until stable so removing one construct cannot assemble another (`<scr<script>ipt>`).
  let current = html;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = stripOnce(current);
    if (next === current) return next;
    current = next;
  }
  // Still changing after 10 passes: adversarial input. Drop every tag rather than guess.
  return current.replace(/<[^>]*>/g, '');
}

/**
 * @deprecated Kept so existing call sites compile; the nonce argument is ignored. Use
 * {@link sanitizeAuthoredBlockHtml}. Authored block HTML is sanitized, never nonce-blessed.
 */
export function addNonceToInlineScripts(html: string, _nonce: string): string {
  return sanitizeAuthoredBlockHtml(html || '');
}
