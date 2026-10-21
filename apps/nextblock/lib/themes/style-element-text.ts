/**
 * Make author CSS safe to place inside a `<style>` element.
 *
 * A `<style>` element is raw text to the HTML parser: the only thing that ends it is
 * `</style` (any letter case) followed by whitespace, `/` or `>`. `site_settings.global_css`
 * is rendered with `dangerouslySetInnerHTML` on every page, /cms included, so a stylesheet
 * containing `</style><script>…` would close the element and inject markup. Rewriting the
 * sequence as `<\/style` keeps the CSS meaning (`\/` is an escaped `/` inside a CSS string
 * or comment, the only places the sequence can legitimately appear) while the parser no
 * longer sees an end tag. Unlike `sanitizeExtraCss` it keeps every other `<`, because media
 * queries level 4 range syntax (`@media (width < 600px)`) is valid site-wide CSS.
 */
export function escapeStyleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}
