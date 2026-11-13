/**
 * Sanitize author-supplied HTML before it is rendered: `dangerouslySetInnerHTML`, or
 * html-react-parser, which renders `<script>` / `<style>` text the same way and keeps every
 * other element it is given.
 *
 * Lives here (moved from `apps/nextblock/lib/blocks/inlineScriptNonce.ts` on 2026-11-03, which
 * still re-exports it) so the libs render authored HTML through the same function as the app:
 * the product short description and a string `description_json` (`@nextblock-cms/ecommerce`)
 * were rendered raw, and any ADMIN writes them (the CMS, Cortex tools, PostgREST). The production
 * CSP keeps host sources in `script-src` without `'strict-dynamic'`, so a parser-inserted
 * `<script src="https://www.googletagmanager.com/gtm.js?id=…">` ran for every later visitor,
 * and `<meta http-equiv="refresh">` redirects them whatever the CSP says.
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
 * SECURITY (2026-11-03): two more bypasses. A handler or `srcdoc` right after a quoted value
 * (`<iframe src="x"srcdoc="…">`: the HTML tokenizer, and html-react-parser's, starts a new
 * attribute there with no whitespace) survived in raw and parsed renders alike, text blocks
 * included; a srcdoc document is same-origin and inherits the CSP, so an entity-encoded
 * `<script src="https://www.googletagmanager.com/…">` inside it ran. And where the result is
 * injected raw into a server render, a tag that never closes (`<script src=…` or
 * `<meta http-equiv=refresh content=…` with no `>` after it) matched none of the strips, then ran
 * on into the page's own markup up to ITS next `>` and became an element. Handlers are now
 * caught after a quoted value too (their name neutralised, not deleted: the quote can just as
 * well end a value or sit in text), and a tag left open at the end is escaped. The URL rule
 * matched the literal word only, so `&#x6A;avascript:`, `java&#9;script:` and
 * `href="javascript:alert('x')"` (a quote of the other kind inside) kept their scheme; values are
 * now decoded and read the way the URL parser reads them (isScriptUrl).
 *
 * This is still a conservative strip, not an allowlist sanitizer. Replacing it with one
 * (DOMPurify / sanitize-html) is the open follow-up; the production CSP (`script-src` nonce +
 * `script-src-attr 'none'`) remains the backstop for script-based vectors this misses.
 *
 * No imports and no DOM: it runs in server components, client components and the published
 * lib alike.
 */

/** Elements that act without any script (navigation, base URL, plugins, nested documents). */
const DANGEROUS_PAIRED_ELEMENTS = ['script', 'object', 'applet', 'frameset', 'noembed', 'noframes'];
const DANGEROUS_VOID_ELEMENTS = ['meta', 'base', 'embed', 'frame', 'link'];

/** Attributes whose value the browser loads or navigates to as a URL. */
const URL_ATTRIBUTE = '(?:href|src|xlink:href|action|formaction|data|poster|background)';

/** The named references an obfuscated scheme uses (`java&Tab;script&colon;`), any case. */
const NAMED_REFERENCES: Record<string, string> = {
  tab: '\t',
  newline: '\n',
  colon: ':',
  sol: '/',
  lpar: '(',
  rpar: ')',
  period: '.',
  comma: ',',
  excl: '!',
  quot: '"',
  apos: "'",
  amp: '&',
  nbsp: '\u00a0',
};

/** The value without spaces, C0 control characters and DEL (char codes, so no control-character regex). */
function withoutSpacesAndControls(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 0x20 && code !== 0x7f) out += character;
  }
  return out;
}

function fromCodePoint(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
}

/**
 * True when an attribute value is a script URL as the browser reads it: character references
 * decoded (`&#x6A;avascript:`, `javascript&colon;`), then every space and control character
 * dropped, since the URL parser strips them around the scheme and removes tabs and newlines
 * inside it (`java&#9;script:`). Dropping more than the browser does only rewrites more.
 */
function isScriptUrl(value: string): boolean {
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_match, decimal: string) => fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);?/gi, (match, name: string) => NAMED_REFERENCES[name.toLowerCase()] ?? match);
  return /^(?:javascript|vbscript|data:text\/html)/.test(withoutSpacesAndControls(decoded).toLowerCase());
}

/**
 * `onerror` → `&#111;nerror`: the first letter of a handler or `srcdoc` name becomes its numeric
 * character reference. Neither the HTML tokenizer nor html-react-parser decodes a reference in an
 * attribute name, so the attribute stops being a handler (React drops the name as invalid); in an
 * attribute value or in text the reference decodes, so content that only looked like a name after
 * a quote still reads as authored.
 */
function neutraliseAttributeName(_match: string, before: string, name: string): string {
  return `${before}&#${name.charCodeAt(0)};${name.slice(1)}`;
}

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
      // ... and one whose quoted value never closes (`<iframe src=x srcdoc="…` to the end): the
      // rules above need the closing quote, and in a raw sink the value runs on into the page's
      // own markup. Whatever is left after them is neutralised (neutraliseAttributeName): in text
      // or a value the reference decodes back, so `turn online=yes` still reads as authored.
      .replace(/([\s/])(on[a-z]+|srcdoc)(?=\s*=)/gi, neutraliseAttributeName)
      // ... and right after a quoted value, where the tokenizer starts the next attribute with no
      // whitespace: <iframe src="x"srcdoc="…">. The quote may instead end a value that itself
      // ends in `=` (`href="/?ref=" title="online=yes"`), or sit in text, so the name is
      // neutralised rather than removed (neutraliseAttributeName); nothing after it is consumed.
      .replace(/(=\s*"[^"]*")(on[a-z]+|srcdoc)(?=\s*=)/gi, neutraliseAttributeName)
      .replace(/(=\s*'[^']*')(on[a-z]+|srcdoc)(?=\s*=)/gi, neutraliseAttributeName)
      // javascript:/vbscript:/data:text/html URLs in URL attributes (isScriptUrl), quoted or bare.
      // A quoted value is read up to its first quote of either kind, closed or not, so
      // `href="javascript:alert('x')"` and a value that never closes lose their scheme as well.
      .replace(new RegExp(`(${URL_ATTRIBUTE}\\s*=\\s*)(["'])([^"']*)`, 'gi'), (match, before: string, quote: string, value: string) =>
        isScriptUrl(value) ? `${before}${quote}#` : match
      )
      .replace(new RegExp(`(${URL_ATTRIBUTE}\\s*=\\s*)([^\\s"'>]+)`, 'gi'), (match, before: string, value: string) =>
        isScriptUrl(value) ? `${before}#` : match
      )
  );
}

/**
 * A `<` with no `>` after it opens a tag the authored string never closes. Injected raw into a
 * server render, that tag continues into the page's own markup up to the page's next `>`, so
 * `<script src=https://allowed.host/x.js?a=` became a script element. After the last `>`, every
 * `<` that would open a tag, comment or end tag (a letter, `!`, `/` or `?` follows it) is
 * escaped, so it shows as text instead; any other `<` is text to the tokenizer already
 * (`a < b`) and stays. Linear: no look-ahead past the next character.
 */
function escapeUnclosedTail(html: string): string {
  const tailStart = html.lastIndexOf('>') + 1;
  const tail = html.slice(tailStart);
  return tail.includes('<') ? html.slice(0, tailStart) + tail.replace(/<(?=[A-Za-z!/?])/g, '&lt;') : html;
}

export function sanitizeAuthoredBlockHtml(html: string): string {
  if (!html) return '';
  // Repeat until stable so removing one construct cannot assemble another (`<scr<script>ipt>`).
  let current = html;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = stripOnce(current);
    if (next === current) return escapeUnclosedTail(next);
    current = next;
  }
  // Still changing after 10 passes: adversarial input. Drop every tag rather than guess.
  return escapeUnclosedTail(current.replace(/<[^>]*>/g, ''));
}
