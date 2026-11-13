// @vitest-environment jsdom
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// BlockRenderer's other block paths read Supabase, the request headers and the Next cache; only
// its text path is under test, so those modules are stubbed. TextBlockRenderer needs none of them.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ unstable_cache: () => async () => undefined }));
vi.mock('@nextblock-cms/db/server', () => ({ getSsgSupabaseClient: vi.fn() }));
vi.mock('../../../app/lib/site-settings', () => ({ SITE_SETTINGS_CACHE_TAG: 'public-site-settings' }));
vi.mock('../../../lib/public-content-cache', () => ({ PUBLIC_CONTENT_REVALIDATE_SECONDS: 300 }));
vi.mock('../../../lib/custom-block-definitions', () => ({ getCachedCustomBlockDefinitionBySlug: vi.fn(async () => null) }));
vi.mock('../../../lib/languages/cached-language-code', () => ({ getCachedLanguageCode: vi.fn(async () => 'en') }));
vi.mock('../../../lib/resolve-block-relations', () => ({ resolveBlockRelations: vi.fn() }));
vi.mock('../../renderers/CachedDynamicLayoutEngine', () => ({ CachedDynamicLayoutEngine: () => null }));
vi.mock('./SectionBlockRenderer', () => ({ default: () => null }));
vi.mock('../../../lib/privacy/contact-emails', () => ({
  substitutePrivacyMergeTags: async (html: string) => html.split('{{privacy_email}}').join('privacy@example.com'),
}));

import { ShortDescription } from '@nextblock-cms/ecommerce/components/ShortDescription';

import BlockRenderer from '../../BlockRenderer';
import ClientTextBlockRenderer from './ClientTextBlockRenderer';
import TextBlockRenderer from './TextBlockRenderer';
import { isTiptapJsonString } from './tiptap-json-string';

/**
 * A text block's html_content is HTML (sanitized by both callers of ClientTextBlockRenderer) or a
 * Tiptap JSON string (gen-1 description copies, revision restores, CSV imports, PostgREST), which
 * ClientTextBlockRenderer renders through React. The callers hand JSON over unsanitized: the
 * sanitizer escaped the `a<b` of a text node to `a&lt;b`, which React then showed literally.
 */

type Render = (html: string) => Promise<string>;

/** A top-level text block: BlockRenderer's own text path. */
const viaBlockRenderer: Render = async (html) => {
  const blocks = [
    { id: 1, block_type: 'text', content: { html_content: html }, order: 0, language_id: 1 },
  ] as unknown as ComponentProps<typeof BlockRenderer>['blocks'];
  const element = await BlockRenderer({ blocks, languageId: 1 });
  return renderToStaticMarkup(element as ReactElement);
};

/** A text block inside a section column: TextBlockRenderer. */
const viaTextBlockRenderer: Render = async (html) => {
  const render = TextBlockRenderer as unknown as (props: unknown) => Promise<ReactElement>;
  return renderToStaticMarkup(await render({ content: { html_content: html }, languageId: 1 }));
};

const CALLERS: Array<[name: string, render: Render]> = [
  ['BlockRenderer', viaBlockRenderer],
  ['TextBlockRenderer', viaTextBlockRenderer],
];

/** What a browser builds from the server render, with page markup after it to run on into. */
function parseInPage(markup: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body><main>${markup}</main><p class="after">after</p></body></html>`,
    'text/html',
  );
}

/** Elements and attributes that act without a click. */
function activeConstructs(doc: Document): string[] {
  const found: string[] = [];
  doc.querySelectorAll('script, meta, base, object, embed, link, frame, frameset').forEach((element) => {
    // React's own preload for the first image of an above-the-fold block.
    if (element.matches('link[rel="preload"][as="image"]')) return;
    found.push(`<${element.tagName.toLowerCase()}>`);
  });
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') found.push(`${element.tagName.toLowerCase()}[${name}]`);
      if (/^\s*(?:javascript|vbscript|data:text\/html)/i.test(attribute.value) && /href|src|action|data|poster|background/.test(name)) {
        found.push(`${element.tagName.toLowerCase()}[${name}=${attribute.value}]`);
      }
    }
  });
  return found;
}

const tiptapDoc = (...paragraphs: string[]) =>
  JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'When i<n' }] },
      ...paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    ],
  });

const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER';
const NBSP = String.fromCharCode(0xa0);
const BOM = String.fromCharCode(0xfeff);

const HTML_ATTACKS: Array<[label: string, html: string]> = [
  ['a remote script on an allowed host', `<p>Intro</p><script src="${GTM}"></script>`],
  ['srcdoc right after a quoted value', `<p>Intro</p><iframe src="https://example.com/embed"srcdoc="&lt;script src=${GTM}&gt;&lt;/script&gt;"></iframe>`],
  ['an onerror handler right after a quoted value', '<p>Intro</p><img src="/x.png"onerror="alert(1)">'],
  ['a meta refresh', '<p>Intro</p><meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['a tag left open', `<p>Intro</p><script src=${GTM}&a=`],
  // Starts like JSON but does not parse as JSON: HTML, so sanitized.
  ['HTML behind a leading brace', `{<p>Intro</p><script src="${GTM}"></script>`],
  ['HTML after a JSON value', `{"type":"doc"}<p>Intro</p><script src="${GTM}"></script>`],
  ['HTML behind a non-breaking space and a brace', `${NBSP}{"a":1}<p>Intro</p><script src="${GTM}"></script>`],
];

const MARKUP_AS_TEXT = `<script src="${GTM}"></script><img src=x onerror=alert(1)>`;

/** Valid JSON, handed to ClientTextBlockRenderer unsanitized: it must render none of it as HTML. */
const JSON_CARRYING_HTML: string[] = [
  JSON.stringify([`<script src="${GTM}"></script>`]),
  JSON.stringify({ html: `<iframe srcdoc="&lt;script src=${GTM}&gt;&lt;/script&gt;"></iframe>` }),
  `\n\t ${JSON.stringify(['<meta http-equiv="refresh" content="0;url=https://evil.example/">'])}\r\n`,
  tiptapDoc(MARKUP_AS_TEXT),
];

describe.each(CALLERS)('text block html_content through %s and ClientTextBlockRenderer', (_name, render) => {
  it('renders Tiptap JSON text exactly as authored, a<b, i<n and </div included', async () => {
    const markup = await render(tiptapDoc('If a<b, i<n and </div', 'Plain'));
    const doc = parseInPage(markup);

    expect(doc.querySelector('main h2')?.textContent).toBe('When i<n');
    expect(Array.from(doc.querySelectorAll('main p'), (p) => p.textContent)).toEqual(['If a<b, i<n and </div', 'Plain']);
    expect(markup).not.toContain('&amp;lt;');
    expect(doc.querySelector('p.after')?.textContent).toBe('after');
  });

  it('substitutes merge tags in Tiptap JSON and still renders it as JSON', async () => {
    const doc = parseInPage(await render(tiptapDoc('Write to {{privacy_email}} if a<b')));
    expect(doc.querySelector('main p')?.textContent).toBe('Write to privacy@example.com if a<b');
  });

  it.each(HTML_ATTACKS)('still sanitizes HTML: %s', async (_label, html) => {
    const doc = parseInPage(await render(html));
    expect(activeConstructs(doc)).toEqual([]);
    expect(doc.querySelector('main')?.textContent).toContain('Intro');
    expect(doc.querySelector('p.after')?.textContent).toBe('after');
  });

  it('renders JSON that carries HTML as text or not at all, never as markup', async () => {
    for (const json of JSON_CARRYING_HTML) {
      expect(isTiptapJsonString(json), json).toBe(true);
      expect(activeConstructs(parseInPage(await render(json))), json).toEqual([]);
    }
    const doc = parseInPage(await render(tiptapDoc(MARKUP_AS_TEXT)));
    expect(doc.querySelector('main p')?.textContent).toBe(MARKUP_AS_TEXT);
  });

  it('keeps values and text that only look like a handler after a quote as authored', async () => {
    const doc = parseInPage(
      await render(
        '<p><a href="https://example.com/?ref=" data-query="onsale=1">x</a></p>' +
          '<p><img src="data:image/png;base64,iVBORw0KGgo=" title="online=yes"></p>' +
          '<p class="text">a="b"onion=c</p>',
      ),
    );
    expect(doc.querySelector('main a')?.getAttribute('data-query')).toBe('onsale=1');
    expect(doc.querySelector('main a')?.getAttribute('href')).toBe('https://example.com/?ref=');
    expect(doc.querySelector('main img')?.getAttribute('title')).toBe('online=yes');
    expect(doc.querySelector('main p.text')?.textContent).toBe('a="b"onion=c');
  });
});

describe('ClientTextBlockRenderer', () => {
  const renderDirect = (html: string) =>
    renderToStaticMarkup(<ClientTextBlockRenderer content={{ html_content: html }} languageId={1} />);

  it('takes its JSON branch for every string its callers pass unsanitized', () => {
    // BlockRenderer and TextBlockRenderer skip the sanitizer exactly when isTiptapJsonString says
    // JSON; if this component decided differently, that string would reach html-react-parser raw.
    for (const json of JSON_CARRYING_HTML) {
      expect(activeConstructs(parseInPage(renderDirect(json))), json).toEqual([]);
    }
  });

  it('parses anything else as HTML', () => {
    const doc = parseInPage(renderDirect('<p class="lead">Hello <strong>world</strong></p>'));
    expect(doc.querySelector('main p.lead strong')?.textContent).toBe('world');
  });
});

describe('isTiptapJsonString', () => {
  it('accepts a string that starts with { or [ and parses as JSON', () => {
    for (const value of [tiptapDoc('x'), '[]', '{}', ' \n\t{"type":"doc"}\r\n', '["<p>x</p>"]']) {
      expect(isTiptapJsonString(value), value).toBe(true);
    }
  });

  it('rejects HTML, other JSON values and JSON with anything around it', () => {
    for (const value of ['', '<p>{x}</p>', '{<p>x</p>', '{"a":1}<p>x</p>', '[1,2', '"text"', '42', 'null', `${NBSP}{"a":1}`, `${BOM}[1]`]) {
      expect(isTiptapJsonString(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('the JSON exemption stays out of sanitizeAuthoredBlockHtml', () => {
  it('ShortDescription, a raw sink, still escapes a JSON-parseable string that leaves a tag open', () => {
    // Valid JSON, so the text-block callers would render it through React; ShortDescription
    // injects it as HTML (it contains a tag), so the sanitizer must escape the open <script.
    const payload = '{"a":"<b>x</b><script src=https://www.googletagmanager.com/gtm.js?id=GTM-X&c="}';
    expect(isTiptapJsonString(payload)).toBe(true);

    const doc = parseInPage(renderToStaticMarkup(<ShortDescription value={payload} />));
    expect(activeConstructs(doc)).toEqual([]);
    expect(doc.querySelector('main b')?.textContent).toBe('x');
    expect(doc.querySelector('p.after')?.textContent).toBe('after');
  });
});
