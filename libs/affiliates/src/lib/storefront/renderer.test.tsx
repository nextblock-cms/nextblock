/* eslint-disable no-script-url -- javascript:/data: URLs are the XSS vectors this suite proves inert */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StorefrontRenderer } from './renderer';
import { sanitizeStorefrontDoc } from './sanitize';
import { buildStorefrontStarterDoc } from './starter';
import type { StorefrontDoc, StorefrontRendererProps } from './types';

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const TAB = ch(0x09);
const NUL = ch(0x00);
const BACKSLASH = ch(0x5c);

const ORIGINS = ['https://media.example-store.com', 'https://images.pexels.com', 'https://images.unsplash.com'];
const SITE = 'https://shop.example';
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const render = (doc: unknown, props: Partial<StorefrontRendererProps> = {}): string =>
  renderToStaticMarkup(<StorefrontRenderer doc={doc as StorefrontDoc} allowedImageOrigins={ORIGINS} siteOrigin={SITE} {...props} />);

const docOf = (...content: unknown[]): StorefrontDoc => ({ type: 'doc', content }) as unknown as StorefrontDoc;
const paragraph = (...content: unknown[]): unknown => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]): unknown => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const link = (href: string): unknown => ({ type: 'link', attrs: { href } });
const image = (src: string, extra: Record<string, unknown> = {}): unknown => ({
  type: 'image',
  attrs: { src, alt: 'Alt', title: null, width: null, height: null, credit: null, ...extra },
});

const UNSPLASH_CREDIT = {
  provider: 'unsplash',
  photographer: 'Sam Lee',
  photographerUrl: 'https://unsplash.com/@samlee',
  sourceUrl: 'https://unsplash.com/photos/abc123',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
  utmSource: 'nextblock store',
};

const PEXELS_CREDIT = {
  provider: 'pexels',
  photographer: 'Jane Doe',
  photographerUrl: 'https://www.pexels.com/@jane',
  sourceUrl: 'https://www.pexels.com/photo/mug-1/',
  downloadLocation: null,
  utmSource: null,
};

/** Elements the renderer may emit (plus `section`/`span` from the test grid callbacks). */
const ALLOWED_TAGS = new Set([
  'div', 'p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'figure', 'img', 'figcaption', 'aside', 'a',
  'strong', 'em', 'u', 's', 'br', 'section', 'span',
]);
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc', 'srcset', 'formaction', 'action', 'xlink:href', 'background', 'poster']);

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parses the real tags of server-rendered markup (React escapes `<`, `>` and quotes in text and
 * attribute values, so escaped text never forms a tag) and checks every element and attribute:
 * allowlisted elements only, no `on*` handler, no `style`, no `srcdoc`/`srcset`, and every
 * href/src a site path, http(s) or mailto URL.
 */
function expectInertMarkup(html: string): void {
  const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];
  for (const tag of tags) {
    const name = (/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1] ?? '').toLowerCase();
    // React 19 emits its own preload hint for a high-priority image (same validated src).
    const reactImagePreload = name === 'link' && /\srel="preload"/.test(tag) && /\sas="image"/.test(tag);
    expect(ALLOWED_TAGS.has(name) || reactImagePreload, tag).toBe(true);
    for (const match of tag.slice(name.length + 1).matchAll(/\s([^\s=/>]+)(?:="([^"]*)")?/g)) {
      const attribute = (match[1] ?? '').toLowerCase();
      const value = decodeAttribute(match[2] ?? '');
      expect(attribute.startsWith('on'), `${attribute} in ${tag}`).toBe(false);
      expect(FORBIDDEN_ATTRIBUTES.has(attribute), `${attribute} in ${tag}`).toBe(false);
      if (attribute === 'href' || attribute === 'src') {
        expect(/^(\/(?![/\\])|https?:\/\/|mailto:)/i.test(value), `${attribute}="${value}"`).toBe(true);
      }
    }
  }
}

describe('StorefrontRenderer: node types', () => {
  it('renders every allowlisted node with literal Tailwind classes', () => {
    const html = render(
      docOf(
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        { type: 'heading', attrs: { level: 3 }, content: [text('Sub')] },
        paragraph(text('b', [{ type: 'bold' }]), text('i', [{ type: 'italic' }]), text('u', [{ type: 'underline' }]), text('s', [{ type: 'strike' }])),
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('one')), { type: 'orderedList', attrs: { start: 4 }, content: [{ type: 'listItem', content: [paragraph(text('four'))] }] }] }] },
        { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [paragraph(text('first'))] }] },
        { type: 'blockquote', content: [paragraph(text('quote'))] },
        { type: 'horizontalRule' },
        { type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [text('tip')] },
        { type: 'storefrontCallout', attrs: { tone: 'highlight' }, content: [text('hi')] },
        { type: 'storefrontCallout', attrs: { tone: 'nope' }, content: [text('info')] },
      ),
    );
    expect(html).toContain('<h2 class="text-2xl md:text-3xl font-bold tracking-tight mt-10 mb-4">Title</h2>');
    expect(html).toContain('<h3 class="text-xl md:text-2xl font-semibold mt-8 mb-3">Sub</h3>');
    expect(html).toContain('<strong>b</strong><em>i</em><u>u</u><s>s</s>');
    expect(html).toContain('<ul class="my-4 list-disc pl-6 space-y-1"><li><p class="leading-relaxed">one</p><ol class="mt-1 list-decimal pl-6 space-y-1" start="4">');
    expect(html).toContain('<ol class="my-4 list-decimal pl-6 space-y-1"><li>');
    expect(html).toContain('<blockquote class="my-6 border-l-4 border-border pl-4 italic text-muted-foreground"><p class="my-2 leading-relaxed">quote</p></blockquote>');
    expect(html).toContain('<hr class="my-10 border-border"/>');
    expect(html).toContain('<aside role="note" class="my-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-foreground">');
    expect(html).toContain('border-amber-500/40 bg-amber-500/10');
    expect(html).toContain('<aside role="note" class="my-6 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-foreground"><p class="leading-relaxed">info</p></aside>');
    expectInertMarkup(html);
  });

  it('nests marks in a fixed order and renders line breaks', () => {
    const html = render(docOf(paragraph(text('both', [{ type: 'italic' }, { type: 'bold' }]), { type: 'hardBreak' }, text(`a${ch(0x0a)}b`))));
    expect(html).toContain('<strong><em>both</em></strong><br/>a<br/>b');
  });

  it('renders empty paragraphs as a blank line and skips empty headings and callouts', () => {
    const html = render(docOf({ type: 'paragraph' }, { type: 'heading', attrs: { level: 2 } }, { type: 'storefrontCallout', attrs: { tone: 'tip' } }));
    expect(html).toBe('<div class="break-words text-base leading-relaxed text-foreground"><p class="my-4 leading-relaxed"><br/></p></div>');
  });

  it('skips headings and callouts that show nothing (spaces, NBSP, zero-width characters, line breaks)', () => {
    // The sanitizer keeps these (it never trims text), but an empty heading is an accessibility
    // failure and a hole in the page outline.
    const hardBreak = { type: 'hardBreak' };
    const blanks: unknown[][] = [[text(' ')], [text(ch(0xa0, 0xa0))], [text(ch(0x200b))], [hardBreak], [text('  '), hardBreak, text(ch(0xfeff))]];
    for (const content of blanks) {
      for (const level of [2, 3]) {
        const html = render(docOf({ type: 'heading', attrs: { level }, content }, paragraph(text('Body'))));
        expect(html, JSON.stringify(content)).toBe(
          '<div class="break-words text-base leading-relaxed text-foreground"><p class="my-4 leading-relaxed">Body</p></div>',
        );
      }
      const callout = render(docOf({ type: 'storefrontCallout', attrs: { tone: 'info' }, content }));
      expect(callout, JSON.stringify(content)).not.toContain('<aside');
    }
    // Visible text keeps its spaces and line breaks.
    const kept = render(docOf({ type: 'heading', attrs: { level: 2 }, content: [text(' Real '), hardBreak, text('picks')] }));
    expect(kept).toContain('> Real <br/>picks</h2>');
    expect(render(docOf({ type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [text(' Tip ')] }))).toContain('<aside role="note"');
  });

  it('appends the caller class name', () => {
    expect(render(docOf(), { className: 'prose max-w-none' })).toBe('<div class="break-words text-base leading-relaxed text-foreground prose max-w-none"></div>');
  });

  it('renders the sanitized starter documents', () => {
    for (const locale of ['en', 'fr']) {
      const doc = sanitizeStorefrontDoc(buildStorefrontStarterDoc({ locale, displayName: 'Jane' }), { allowedImageOrigins: ORIGINS }).doc;
      const html = render(doc);
      expect(html).toContain('<h2');
      expect(html).toContain('Jane');
      expect(html).toContain('role="note"');
      expectInertMarkup(html);
    }
  });
});

describe('StorefrontRenderer: links', () => {
  it('opens only absolute links to another origin in a new tab, all with the partner rel', () => {
    const html = render(
      docOf(
        paragraph(text('external', [link('https://other.example/a')])),
        paragraph(text('same site', [link('https://shop.example/products/x')])),
        paragraph(text('relative', [link('/products/x')])),
        paragraph(text('mail', [link('mailto:hi@example.com')])),
      ),
    );
    expect(html).toContain('<a href="https://other.example/a" rel="nofollow ugc noopener noreferrer" target="_blank" class="font-medium text-primary underline underline-offset-4 hover:opacity-80">external</a>');
    expect(html).toContain('<a href="https://shop.example/products/x" rel="nofollow ugc noopener noreferrer" class=');
    expect(html).toContain('<a href="/products/x" rel="nofollow ugc noopener noreferrer" class=');
    expect(html).toContain('<a href="mailto:hi@example.com" rel="nofollow ugc noopener noreferrer" class=');
    expect(html.match(/target="_blank"/g)).toHaveLength(1);
  });

  // 2026-10-29 fix review: a product linked from the partner's own text carried no referral, so a
  // visitor who arrived by a client-side navigation (or blocks cookies) bought unattributed.
  it('adds ?ref=<handle> to site-internal links on the public storefront, and only there', () => {
    const doc = docOf(
      paragraph(text('product', [link('/product/chef-knife')])),
      paragraph(text('query', [link('/shop?sort=new#top')])),
      paragraph(text('same site', [link('https://shop.example/products/x')])),
      paragraph(text('own ref', [link('/products/y?ref=someone')])),
      paragraph(text('external', [link('https://other.example/a')])),
      paragraph(text('mail', [link('mailto:hi@example.com')])),
    );
    const html = render(doc, { referralHandle: 'jane-picks' });
    expect(html).toContain('href="/product/chef-knife?ref=jane-picks"');
    expect(html).toContain('href="/shop?sort=new&amp;ref=jane-picks#top"');
    expect(html).toContain('href="https://shop.example/products/x?ref=jane-picks"');
    expect(html).toContain('href="/products/y?ref=someone"');
    expect(html).toContain('href="https://other.example/a"');
    expect(html).toContain('href="mailto:hi@example.com"');

    // Previews and the review screen pass no handle; an invalid handle is ignored.
    for (const props of [{}, { referralHandle: 'Not A Handle' }]) {
      expect(render(doc, props)).toContain('href="/product/chef-knife"');
    }
  });

  it('treats every absolute link as external when the site origin is unknown', () => {
    const html = render(docOf(paragraph(text('x', [link('https://shop.example/a')]))), { siteOrigin: null });
    expect(html).toContain('target="_blank"');
  });

  it('uses a custom rel and still protects the opener on new-tab links', () => {
    const html = render(docOf(paragraph(text('in', [link('/a')]), text(' '), text('out', [link('https://other.example/')]))), { linkRel: 'sponsored' });
    expect(html).toContain('<a href="/a" rel="sponsored" class=');
    expect(html).toContain('<a href="https://other.example/" rel="sponsored noopener noreferrer" target="_blank"');
  });

  it('merges consecutive text runs that share a link into one anchor', () => {
    const html = render(docOf(paragraph(text('Shop ', [link('/shop')]), text('now', [link('/shop'), { type: 'bold' }]), text(' today'))));
    expect(html).toContain('<a href="/shop" rel="nofollow ugc noopener noreferrer" class="font-medium text-primary underline underline-offset-4 hover:opacity-80">Shop <strong>now</strong></a> today');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('re-validates hrefs: unsafe links in an unsanitized document render as plain text', () => {
    const unsafe = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      `java${TAB}script:alert(1)`,
      `java${NUL}script:alert(1)`,
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example',
      `/${BACKSLASH}evil.example`,
      'https://user:pw@evil.example/',
    ];
    const html = render(docOf(...unsafe.map((href) => paragraph(text('click me', [link(href)])))));
    expect(html).not.toContain('<a');
    expect(html.match(/click me/g)).toHaveLength(unsafe.length);
    expect(html).not.toContain('evil');
    expectInertMarkup(html);
  });
});

describe('StorefrontRenderer: images', () => {
  it('loads the first image eagerly at high priority and the rest lazily', () => {
    const html = render(
      docOf(
        image('https://evil.example/skip.png'),
        image('https://images.pexels.com/1.jpeg', { width: 800, height: 600 }),
        image('/images/2.webp'),
        image('https://media.example-store.com/images/3.png', { title: 'Three' }),
      ),
    );
    const tags = html.match(/<img [^>]*>/g) ?? [];
    expect(tags).toHaveLength(3);
    expect(tags[0]).toContain('src="https://images.pexels.com/1.jpeg"');
    expect(tags[0]).toContain('loading="eager"');
    // HTML attribute names are case-insensitive; React serializes the camelCase prop name.
    expect(tags[0]).toMatch(/\sfetchpriority="high"/i);
    expect(tags[0]).toContain('width="800"');
    expect(tags[0]).toContain('height="600"');
    expect(tags[0]).toContain('decoding="async"');
    for (const tag of tags.slice(1)) {
      expect(tag).toContain('loading="lazy"');
      expect(tag).not.toMatch(/fetchpriority/i);
      expect(tag).toContain('decoding="async"');
      expect(tag).not.toContain('width=');
    }
    expect(tags[2]).toContain('title="Three"');
    expect(html).not.toContain('evil');
    expect(html).toContain('<figure class="my-8">');
    // Only the first image gets React's preload hint.
    expect(html.match(/<link rel="preload" as="image" href="https:\/\/images\.pexels\.com\/1\.jpeg"/g)).toHaveLength(1);
    expect(html.match(/<link /g)).toHaveLength(1);
    expectInertMarkup(html);
  });

  it('re-validates srcs and dimensions in an unsanitized document', () => {
    const html = render(
      docOf(
        image('javascript:alert(1)'),
        image('data:image/svg+xml,<svg onload=alert(1)>'),
        image('//images.pexels.com/x.png'),
        image('/images/../cms/x.png'),
        image('http://images.pexels.com/x.png'),
        image('/images/ok.png', { width: 99999, height: '600', alt: `Alt${NUL}text` }),
      ),
    );
    const tags = html.match(/<img [^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('src="/images/ok.png"');
    expect(tags[0]).not.toContain('width=');
    expect(tags[0]).not.toContain('height=');
    // Attribute text is cleaned exactly like the sanitizer cleans it (control characters removed).
    expect(tags[0]).toContain('alt="Alttext"');
    expectInertMarkup(html);
  });

  it('credits Unsplash photos with linked names and utm parameters', () => {
    const html = render(docOf(image('https://images.unsplash.com/photo-1', { credit: UNSPLASH_CREDIT })));
    expect(html).toContain('<figcaption class="mt-2 text-center text-xs text-muted-foreground">Photo: <a href="https://unsplash.com/@samlee?utm_source=nextblock+store&amp;utm_medium=referral" rel="nofollow noopener noreferrer" target="_blank" class="underline underline-offset-2 hover:opacity-80">Sam Lee</a> / <a href="https://unsplash.com/photos/abc123?utm_source=nextblock+store&amp;utm_medium=referral" rel="nofollow noopener noreferrer" target="_blank" class="underline underline-offset-2 hover:opacity-80">Unsplash</a></figcaption>');
  });

  it('credits Pexels photos without utm parameters, through a localized label', () => {
    const photoCredit = vi.fn((photographer: string, provider: string) => `Photo de ${photographer} sur ${provider}`);
    const html = render(docOf(image('https://images.pexels.com/x.jpeg', { credit: PEXELS_CREDIT })), { labels: { photoCredit } });
    expect(html).toContain('Photo de <a href="https://www.pexels.com/@jane" rel="nofollow noopener noreferrer" target="_blank" class="underline underline-offset-2 hover:opacity-80">Jane Doe</a> sur <a href="https://www.pexels.com/photo/mug-1/"');
    expect(html).not.toContain('utm_');
  });

  it('falls back to a plain-text credit when the label does not place both names', () => {
    const constant = render(docOf(image('/images/x.png', { credit: PEXELS_CREDIT })), { labels: { photoCredit: () => 'Stock photo' } });
    expect(constant).toContain('<figcaption class="mt-2 text-center text-xs text-muted-foreground">Stock photo</figcaption>');
    const throwing = render(docOf(image('/images/x.png', { credit: PEXELS_CREDIT })), {
      labels: {
        photoCredit: () => {
          throw new Error('label failed');
        },
      },
    });
    // A throwing label falls back to the default template, names still linked.
    expect(throwing).toContain('>Photo: <a href="https://www.pexels.com/@jane"');
    expect(throwing).toContain('>Pexels</a></figcaption>');
  });

  it('drops forged credits', () => {
    const html = render(
      docOf(image('/images/x.png', { credit: { ...PEXELS_CREDIT, provider: 'evil' } }), image('/images/y.png', { credit: { ...UNSPLASH_CREDIT, photographerUrl: 'javascript:alert(1)' } })),
    );
    expect(html).not.toContain('javascript:');
    expect(html.match(/<figcaption/g)).toHaveLength(1);
    expect(html).toContain('href="https://unsplash.com/?utm_source=nextblock+store&amp;utm_medium=referral"');
  });
});

describe('StorefrontRenderer: product grids and review highlights', () => {
  it('renders grids through renderProductGrid with validated ids and a running index', () => {
    const renderProductGrid = vi.fn(({ productIds, index }: { productIds: string[]; index: number }) => (
      <section data-grid={index}>{productIds.join(',')}</section>
    ));
    const html = render(
      docOf(
        { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), 'bad', uuid(1), uuid(0xabc).toUpperCase()], title: 'Picks', columns: 4 } },
        paragraph(text('between')),
        { type: 'affiliateProductGrid', attrs: { productIds: [], title: null, columns: 9 } },
      ),
      { renderProductGrid },
    );
    expect(renderProductGrid).toHaveBeenCalledTimes(2);
    expect(renderProductGrid.mock.calls[0]?.[0]).toEqual({ productIds: [uuid(1), uuid(0xabc)], title: 'Picks', columns: 4, index: 0 });
    expect(renderProductGrid.mock.calls[1]?.[0]).toEqual({ productIds: [], title: null, columns: 3, index: 1 });
    expect(html).toContain(`<div class="my-8"><section data-grid="0">${uuid(1)},${uuid(0xabc)}</section></div>`);
  });

  it('renders nothing for grids without a renderProductGrid callback, or when it returns null', () => {
    const doc = docOf({ type: 'affiliateProductGrid', attrs: { productIds: [uuid(1)], title: null, columns: 3 } });
    expect(render(doc)).toBe('<div class="break-words text-base leading-relaxed text-foreground"></div>');
    expect(render(doc, { renderProductGrid: () => null })).toBe('<div class="break-words text-base leading-relaxed text-foreground"></div>');
  });

  it('wraps each top-level block in a data-diff box when highlighting', () => {
    const html = render(docOf(paragraph(text('a')), paragraph(text('b')), paragraph(text('c')), paragraph(text('d'))), {
      highlight: ['unchanged', 'added', 'changed'],
    });
    expect(html).toContain('<div data-diff="unchanged" class="border-l-4 border-transparent pl-4"><p class="my-4 leading-relaxed">a</p></div>');
    expect(html).toContain('<div data-diff="added" class="border-l-4 border-emerald-500 pl-4"><p class="my-4 leading-relaxed">b</p></div>');
    expect(html).toContain('<div data-diff="changed" class="border-l-4 border-amber-500 pl-4"><p class="my-4 leading-relaxed">c</p></div>');
    expect(html).toContain('<div data-diff="unchanged" class="border-l-4 border-transparent pl-4"><p class="my-4 leading-relaxed">d</p></div>');
  });
});

describe('StorefrontRenderer: hostile input (defense in depth)', () => {
  const XSS_DOC = docOf(
    { type: 'script', content: [text('alert(1)')] },
    { type: 'iframe', attrs: { src: 'javascript:alert(1)', srcdoc: '<script>alert(1)</script>' } },
    { type: 'svg', attrs: { onload: 'alert(1)' } },
    { type: 'paragraph', attrs: { onclick: 'alert(1)', style: 'color:red', class: 'x' }, content: [text('<script>alert(1)</script>'), text('<img src=x onerror=alert(1)>')] },
    { type: 'heading', attrs: { level: 2, onmouseover: 'alert(1)', style: 'x' }, content: [text('"><svg onload=alert(1)>')] },
    { type: 'image', attrs: { src: '/images/ok.png', alt: '" onerror="alert(1)', title: '"><script>alert(1)</script>', onerror: 'alert(1)', style: 'x', srcset: 'javascript:alert(1)' } },
    { type: 'storefrontCallout', attrs: { tone: 'tip" onclick="alert(1)', style: 'x' }, content: [text('x')] },
    { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://ok.example/', onclick: 'alert(1)', style: 'x', target: '_self' } }, { type: 'textStyle', attrs: { style: 'color:red' } }] }] },
    { type: 'paragraph', content: [{ type: 'html', html: '<script>alert(1)</script>' }, { type: 'text', text: 42 }, null, 'raw string'] },
    { type: 'affiliateProductGrid', attrs: { productIds: ['<script>'], title: '<b onmouseover=alert(1)>', columns: 3 } },
  );

  it('renders an XSS corpus without event handlers, styles, script URLs or active elements', () => {
    const html = render(XSS_DOC, { renderProductGrid: ({ title }) => <span>{title}</span> });
    expectInertMarkup(html);
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toMatch(/<(script|iframe|svg|img src=x)/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).toContain('<span>&lt;b onmouseover=alert(1)&gt;</span>');
  });

  it('renders the sanitized XSS corpus just as inertly', () => {
    const sanitized = sanitizeStorefrontDoc(XSS_DOC, { allowedImageOrigins: ORIGINS }).doc;
    expectInertMarkup(render(sanitized));
  });

  it('never throws on malformed documents', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      'doc',
      { type: 'doc' },
      { type: 'doc', content: null },
      { type: 'doc', content: [null, 1, 'x', [], { type: 1 }, { type: 'paragraph', content: 'x' }, { type: 'bulletList', content: [1, { type: 'listItem', content: 'x' }] }] },
      { type: 'doc', content: [{ type: 'image' }, { type: 'image', attrs: 'x' }, { type: 'affiliateProductGrid', attrs: null }, { type: 'orderedList', attrs: { start: 'x' }, content: [] }] },
    ];
    for (const doc of malformed) {
      expect(() => render(doc, { renderProductGrid: () => null })).not.toThrow();
    }
  });

  it('bounds deeply nested hostile lists', () => {
    let node: unknown = { type: 'paragraph', content: [text('leaf')] };
    for (let index = 0; index < 5000; index += 1) {
      node = { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text(`level ${index}`)), node] }] };
    }
    const html = render(docOf(node));
    expect((html.match(/<ul/g) ?? []).length).toBeLessThanOrEqual(4);
  });
});

describe('renderer source guard', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(here).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name));

  it('never uses raw HTML injection, inline styles, hooks or a client directive', () => {
    const directive = ['use', 'client'].join(' ');
    const rawHtmlProp = ['dangerously', 'Set', 'Inner', 'HTML'].join('');
    for (const name of sources) {
      const source = readFileSync(path.join(here, name), 'utf8');
      expect(source.includes(`'${directive}'`) || source.includes(`"${directive}"`), name).toBe(false);
      expect(source.includes(rawHtmlProp), name).toBe(false);
      expect(/\bstyle\s*=\s*\{/.test(source), name).toBe(false);
      expect(/\buse(State|Effect|LayoutEffect|Memo|Callback|Ref|Context|Reducer|Id|Transition|SyncExternalStore)\s*\(/.test(source), name).toBe(false);
    }
    expect(sources).toContain('renderer.tsx');
  });
});
