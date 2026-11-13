/**
 * True when a text block's `html_content` is a Tiptap JSON document rather than HTML: the
 * trimmed string starts with `{` or `[` and the whole string parses as JSON. The editor writes
 * HTML, but JSON reaches the column too (a product description copied into a text block, a
 * revision restore that writes its snapshot back verbatim, a CSV import, a PostgREST write).
 *
 * ClientTextBlockRenderer renders such a string through SimpleTiptapRenderer: React elements and
 * React-escaped text only (its fallback for a string that does not parse is sanitized HTML). So
 * its callers (BlockRenderer, TextBlockRenderer) hand JSON over without the HTML sanitizer, which
 * reads the `a<b` of a text node as a tag left open and escapes it to `a&lt;b` (React then shows
 * that literally). Everything else is HTML and is sanitized first.
 *
 * The callers and ClientTextBlockRenderer decide with this one predicate on the same string, so a
 * string they pass unsanitized always takes the JSON branch and never reaches html-react-parser.
 * The exemption belongs in the text-block renderers, never in sanitizeAuthoredBlockHtml: the
 * sanitizer also feeds raw sinks (ShortDescription), which inject a JSON-parseable string as HTML.
 */
export function isTiptapJsonString(value: string): boolean {
  const head = value.trimStart();
  if (!head.startsWith('{') && !head.startsWith('[')) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
