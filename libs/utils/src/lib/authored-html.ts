/**
 * Sanitize author-supplied HTML before it is rendered: `dangerouslySetInnerHTML`, or
 * html-react-parser, which renders `<script>` / `<style>` text the same way and keeps every
 * other element it is given.
 *
 * Lives here (moved from `apps/nextblock/lib/blocks/inlineScriptNonce.ts` on 2026-11-03, which
 * still re-exports it) so the libs render authored HTML through the same function as the app:
 * the product short description and a string `description_json` (`@nextblock-cms/ecommerce`)
 * were rendered raw, and any ADMIN writes them (the CMS, Cortex tools, PostgREST). Text blocks are
 * written by any WRITER and render on public pages AND inside the authenticated /cms shell, so
 * whatever survives here runs for every visitor and every admin. The production CSP keeps host
 * sources in `script-src`, so a parser-inserted `<script src="https://www.googletagmanager.com/…">`
 * ran for every later visitor, and `<meta http-equiv="refresh">` redirects them whatever the CSP
 * says. Authored scripts are never nonce-blessed (that was stored XSS until 2026-10-19).
 *
 * SECURITY (2026-11-04): an allowlist, not a strip. The regex strip this replaces was defeated in
 * every review (2026-10-21: `<scr<script>ipt>`, `src=x/onerror=`, meta refresh and base; 2026-11-03:
 * a handler right after a quoted value, a tag left open to run on into the page markup,
 * entity-encoded and tab-split script URLs), each time by markup the browser read differently from
 * the regexes. sanitize-html reads the input with htmlparser2 the way the browser does (raw-text
 * elements, SVG context and its tag-name casing, character references in values), keeps only the
 * elements and attributes listed below, and writes the result out itself: every text and attribute
 * value escaped, every element it opened closed. Whatever the input, the output holds only the
 * listed elements and attributes, and the browser reads it as written. The tests keep every bypass
 * above as a regression case.
 *
 * Kept: rich text as the editor writes it (its widget `data-*` attributes, inline `style`, `class`,
 * `id`), links (http, https, mailto, tel, sms, ftp, relative), images (`data:` too), tables, lists,
 * code, audio and video, inline SVG, the editor's `<style>` blocks, task-list checkboxes, and
 * YouTube / Vimeo players over https (the hosts the production CSP's `frame-src` allows) with their
 * attributes. Dropped: scripts, handlers, `srcdoc`, meta / base / link, plugins, forms and every
 * control but the checkbox, every other iframe, `name`, `form` and `for`, a `data-` / `aria-` name
 * the HTML spec forbids (`data-x:xlink:href`, a bare `data-`), SVG `foreignObject` / `use` /
 * animation, MathML, and anything else not listed. Elements nested more than 100 deep are
 * dropped too (their text stays): html-react-parser and React's server render recurse once per
 * level, so a WRITER could otherwise overflow the stack of every render of the page.
 *
 * `<style>` stays because the editor has a node for it (StyleTagNode), but one whose text holds a
 * `<` that could open a tag (`<img`, `</`, `<!`) is dropped whole: inside `<svg>` the browser parses
 * style text as markup, and through 2.18.1 the library wrote style text through unescaped, so
 * `<svg><style>&lt;img src=x onerror=…&gt;` came back as a live element. Since 2.18.2 it writes a
 * `<` in svg or math style text as the CSS escape `\3c ` (GHSA-6wrv-5cp6-h3c5). The rule stays as
 * defense in depth: the output never depends on that escape, or on where the library thinks an
 * `<svg>` is open, and the tests pin its exact output. Any other `<` stays (`@media (width < 600px)`;
 * inside svg or math the library writes it as `\3c `). CSS is authored content
 * (`style-src 'unsafe-inline'`): it restyles the page, it never runs script. `<style>`, `<title>`
 * and `<iframe>` keep text only (an element inside one is dropped): inside `<svg>` they hold markup
 * until a tag like `<p>` switches the browser back to HTML, where they hold raw text, so markup kept
 * in one would mutate on the browser's own serialize-and-parse round trip (TEXT_ONLY_ELEMENTS).
 *
 * Kept from the strip: a tag the input leaves open at its end is escaped first (escapeUnclosedTail),
 * so `if a<b` stays readable text instead of vanishing. The production CSP (`script-src` nonce,
 * `script-src-attr 'none'`) stays the backstop.
 *
 * No DOM and no eval (the production CSP forbids it): sanitize-html and its dependencies are plain
 * JavaScript, so server components, client components (no hydration drift) and the published lib
 * get the same output from the same code. Its cost is client bundle size where a client component
 * imports this (docs/04 → "Authored HTML renders through sanitizeAuthoredBlockHtml").
 */
import sanitizeHtml from 'sanitize-html';

/** Schemes a link, image or media URL may use. Relative URLs and `#fragments` carry no scheme and pass. */
const URL_SCHEMES = ['http', 'https', 'mailto', 'tel', 'sms', 'ftp'];

/**
 * Iframe hosts: the YouTube and Vimeo players, the embeds the production CSP's `frame-src` allows
 * (the YouTube rewrites to the no-cookie host run after this, so the plain hosts must pass).
 */
const IFRAME_HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.vimeo.com'];

const HTML_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'data', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'picture',
  'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
  'audio', 'video', 'track',
  // Checked again in exclusiveFilter: an iframe off the player hosts loses its src and goes, an
  // input is a checkbox (Tiptap task lists) or goes, a style holding `<` goes.
  'iframe', 'input', 'style',
];

/**
 * Inline SVG. htmlparser2 restores SVG casing inside `<svg>` (`linearGradient`), so these are the
 * names as it reports them. Not here: `foreignObject` (an HTML island: meta refresh, forms),
 * `use` (pulls in other documents), and the animation elements (they can rewrite `href`).
 */
const SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'desc', 'title', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text',
  'tspan', 'textPath', 'image', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'filter',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
  'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge',
  'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
];

/** On every element. `name`, `form` and `for` are absent on purpose: they reach outside the block (clobbering, form association). */
const GLOBAL_ATTRIBUTES = ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'align', 'hidden', 'aria-*', 'data-*'];

/**
 * The `aria-*` and `data-*` globs match any name with the prefix: `data-x:xlink:href`, `aria-x"y`,
 * a bare `data-`. The HTML spec allows a custom data attribute only as an XML-compatible name with
 * no `:` (and no uppercase, which the parser lowercases anyway), and every ARIA attribute is `aria-`
 * and lowercase letters. A name with either prefix that is not one of these is dropped before the
 * allowlist reads it (dropInvalidDataAriaNames). The globs cannot say this: the library escapes
 * everything in them but `*`.
 */
const DATA_ARIA_PREFIX = /^(?:data|aria)-/;
const VALID_DATA_ARIA_NAME = /^(?:data-[a-z0-9._-]+|aria-[a-z]+)$/;

/** Lowercase: htmlparser2 lowercases attribute names, and the browser restores SVG casing (`viewBox`) on parse. */
const SVG_ATTRIBUTES = [
  'xmlns', 'xmlns:xlink', 'version', 'viewbox', 'preserveaspectratio', 'focusable', 'x', 'y', 'width', 'height', 'href', 'xlink:href',
  'd', 'pathlength', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'fr', 'dx', 'dy', 'rotate', 'textlength',
  'lengthadjust', 'startoffset', 'method', 'spacing', 'side', 'offset', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'patternunits', 'patterncontentunits', 'patterntransform', 'maskunits', 'maskcontentunits', 'clippathunits', 'markerwidth',
  'markerheight', 'markerunits', 'refx', 'refy', 'orient', 'filterunits', 'primitiveunits', 'in', 'in2', 'result', 'stddeviation',
  'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'radius', 'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'scale',
  'xchannelselector', 'ychannelselector', 'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent', 'edgemode', 'kernelmatrix',
  'order', 'divisor', 'bias', 'targetx', 'targety', 'preservealpha', 'surfacescale', 'diffuseconstant', 'specularconstant',
  'specularexponent', 'azimuth', 'elevation', 'z', 'pointsatx', 'pointsaty', 'pointsatz', 'limitingconeangle',
  // presentation attributes
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'transform', 'transform-origin', 'clip-path', 'clip-rule',
  'mask', 'filter', 'color', 'display', 'visibility', 'overflow', 'vector-effect', 'shape-rendering', 'paint-order', 'stop-color',
  'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color', 'color-interpolation', 'color-interpolation-filters',
  'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'letter-spacing', 'word-spacing', 'text-anchor',
  'text-decoration', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'marker-start', 'marker-mid', 'marker-end',
];

const TABLE_CELL_ATTRIBUTES = ['colspan', 'rowspan', 'colwidth', 'headers', 'scope', 'abbr', 'valign', 'width', 'height'];

const ATTRIBUTES_BY_TAG: Record<string, sanitizeHtml.AllowedAttribute[]> = {
  a: ['href', 'xlink:href', 'target', 'rel', 'hreflang', 'referrerpolicy'],
  img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority', 'referrerpolicy'],
  iframe: [
    'src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'webkitallowfullscreen', 'mozallowfullscreen', 'frameborder',
    'referrerpolicy', 'loading', 'scrolling', 'sandbox',
  ],
  input: [{ name: 'type', multiple: false, values: ['checkbox'] }, 'checked', 'disabled'],
  video: ['src', 'poster', 'width', 'height', 'controls', 'autoplay', 'muted', 'loop', 'playsinline', 'preload'],
  audio: ['src', 'controls', 'autoplay', 'muted', 'loop', 'preload'],
  source: ['src', 'srcset', 'sizes', 'type', 'media', 'width', 'height'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  style: ['media', 'type'],
  table: ['width', 'border', 'cellpadding', 'cellspacing'],
  td: TABLE_CELL_ATTRIBUTES,
  th: TABLE_CELL_ATTRIBUTES,
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  ol: ['start', 'reversed', 'type'],
  ul: ['type'],
  li: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  time: ['datetime'],
  data: ['value'],
  details: ['open'],
  font: ['color', 'face', 'size'],
  ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, SVG_ATTRIBUTES])),
  '*': GLOBAL_ATTRIBUTES,
};

/**
 * A `<` that opens a tag, comment or end tag once the tokenizer reads markup: a letter, `!`, `/` or
 * `?` follows it. Any other `<` is text (`@media (width < 600px)`, `a < b`).
 */
const TAG_OPENER = /<[A-Za-z!/?]/;

/**
 * The listed elements HTML reads as raw text or RCDATA. They keep text only: an element inside one
 * is dropped whole. Inside `<svg>` they read as markup, until a tag such as `<p>` puts the browser
 * back in HTML, so one element can be markup to one parse and text to the next. A browser that
 * serializes `<svg><p></p><style><a id="</style><img src=x onerror=…>">` (attribute values keep
 * their `<`) and parses it again builds a live `<img>`.
 */
const TEXT_ONLY_ELEMENTS = new Set(['style', 'title', 'iframe']);

/**
 * The elements open around the one being closed, while one sanitize call runs: the library reports
 * every open and close tag, and calls onCloseTag before exclusiveFilter. Synchronous, so a single
 * module-level stack is safe; sanitize() saves and restores it.
 */
let openElements: string[] = [];

/** Void elements: written without the library's ` />`, the way the browser and the editor write them. */
const VOID_ELEMENTS = ['area', 'br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr'];

/**
 * The `'*'` transform: the library runs it on every element, after the element's own transform and
 * before the allowlist reads the attributes. It drops a `data-` / `aria-` attribute whose lowercased
 * name is not VALID_DATA_ARIA_NAME, and copies the attributes only when one goes.
 */
function dropInvalidDataAriaNames(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  let kept: sanitizeHtml.Attributes | undefined;
  for (const name of Object.keys(attribs)) {
    const lowered = name.toLowerCase();
    if (DATA_ARIA_PREFIX.test(lowered) && !VALID_DATA_ARIA_NAME.test(lowered)) {
      kept ??= { ...attribs };
      delete kept[name];
    }
  }
  return { tagName, attribs: kept ?? attribs };
}

/** `allowedEmptyAttributes` is a sanitize-html 2.18 option that @types/sanitize-html 2.16 does not declare yet. */
type Options = sanitizeHtml.IOptions & { allowedEmptyAttributes?: string[] };

const OPTIONS: Options = {
  allowedTags: [...HTML_TAGS, ...SVG_TAGS],
  allowedAttributes: ATTRIBUTES_BY_TAG,
  // Empty `hidden` still hides; empty `alt` marks a decorative image. Other known non-boolean
  // attributes with no value are dropped, boolean ones (allowfullscreen, checked) stay bare.
  allowedEmptyAttributes: ['alt', 'hidden'],
  allowedSchemes: URL_SCHEMES,
  allowedSchemesByTag: { img: [...URL_SCHEMES, 'data'], image: [...URL_SCHEMES, 'data'], iframe: ['https'] },
  allowProtocolRelative: true,
  allowedIframeHostnames: IFRAME_HOSTS,
  allowIframeRelativeUrls: false,
  selfClosing: [...VOID_ELEMENTS, 'base', 'basefont', 'link', 'meta'],
  // Dropped with everything inside them, not just unwrapped: content the browser never shows
  // (noscript with scripting on, template, noembed, noframes), MathML, and SVG's HTML island.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'noscript', 'noembed', 'noframes', 'template', 'math', 'foreignObject', 'foreignobject'],
  disallowedTagsMode: 'discard',
  nestingLimit: 100,
  // Style attribute values pass through as authored (escaped like any value). Parsing them needs
  // postcss at runtime and buys nothing without a CSS allowlist.
  parseStyleAttributes: false,
  // `style` is allowed on purpose; exclusiveFilter keeps a style element only while its text holds
  // no TAG_OPENER.
  allowVulnerableTags: true,
  transformTags: {
    // An iframe's content is fallback the browser never shows (raw text to both parsers): written empty.
    iframe: (tagName, attribs) => ({ tagName, attribs, text: '' }),
    // Every element, iframes too (their text stays empty): junk `data-` / `aria-` names go first.
    '*': dropInvalidDataAriaNames,
  },
  onOpenTag: (name) => {
    openElements.push(name);
  },
  onCloseTag: () => {
    openElements.pop();
  },
  exclusiveFilter: (frame) => {
    if (openElements.some((name) => TEXT_ONLY_ELEMENTS.has(name))) return true;
    if (frame.tag === 'iframe') return !frame.attribs['src'];
    if (frame.tag === 'input') return frame.attribs['type'] !== 'checkbox';
    if (frame.tag === 'style') return TAG_OPENER.test(frame.text);
    return false;
  },
};

/**
 * A `<` with no `>` after it opens a tag the authored string never closes. The parser would drop
 * that tag, and with it the author's text (`if a<b`), so after the last `>` every `<` that would
 * open a tag, comment or end tag (a letter, `!`, `/` or `?` follows it) is escaped first and shows
 * as text; any other `<` is text to the tokenizer already (`a < b`). Linear: no look-ahead past the
 * next character.
 */
function escapeUnclosedTail(html: string): string {
  const tailStart = html.lastIndexOf('>') + 1;
  const tail = html.slice(tailStart);
  return tail.includes('<') ? html.slice(0, tailStart) + tail.replace(/<(?=[A-Za-z!/?])/g, '&lt;') : html;
}

/**
 * `<img src="…" />` → `<img src="…">`. The library ends the void elements it writes with ` />`;
 * attribute values are escaped and text holding `<` never reaches the output unescaped, so this
 * pattern only ever meets those tag ends.
 */
const VOID_TAG_END = new RegExp(`<(${VOID_ELEMENTS.join('|')})((?:\\s[^<>]*?)?) />`, 'g');

function sanitize(html: string): string {
  const outer = openElements;
  openElements = [];
  try {
    return sanitizeHtml(html, OPTIONS).replace(VOID_TAG_END, '<$1$2>');
  } finally {
    openElements = outer;
  }
}

export function sanitizeAuthoredBlockHtml(html: string): string {
  if (!html) return '';
  return sanitize(escapeUnclosedTail(String(html)));
}

/**
 * The inner markup of an authored `<svg>` (the editor's SvgNode keeps it as a string and assigns
 * it with `innerHTML` to an `<svg>` element), sanitized as SVG content: inside a `<svg>` wrapper,
 * so `<path/>` closes and SVG casing holds, as it does where the markup lands. The output is the
 * wrapper's content. The sanitizer escapes every `<` it does not write as a tag, so the only
 * `<svg` / `</svg>` left are elements; the wrapper ends at the `</svg>` that brings the depth back
 * to zero, and anything the input placed after an early `</svg>` is dropped.
 */
export function sanitizeAuthoredSvgMarkup(markup: string): string {
  if (!markup) return '';
  const wrapped = sanitize(`<svg>${String(markup)}</svg>`);
  if (!wrapped.startsWith('<svg>')) return '';
  let depth = 0;
  for (const tag of wrapped.matchAll(/<(\/?)svg[\s>]/g)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return wrapped.slice('<svg>'.length, tag.index);
  }
  return '';
}
