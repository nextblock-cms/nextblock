// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortDescription } from './ShortDescription';

/**
 * `products.short_description` is written by any ADMIN (the CMS, the Cortex tools, PostgREST;
 * every visitor on the public sandbox) and server-rendered on /product/<slug> and in
 * featured_product blocks for every later visitor. Its HTML goes through the text-block
 * sanitizer. The sanitizer does not read the sandbox flag: the same markup renders on and off it.
 */

const ATTACKS: Array<[label: string, html: string]> = [
  ['a remote script on an allowed host', '<p>Intro</p><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER"></script>'],
  ['a meta refresh', '<p>Intro</p><meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['a base element', '<p>Intro</p><base href="https://evil.example/">'],
  ['an iframe with srcdoc', '<p>Intro</p><iframe srcdoc="<p>inner</p>"></iframe>'],
  ['an onerror handler', '<p>Intro</p><img src="/x.png" onerror="alert(1)">'],
  ['a javascript: link', '<p>Intro <a href="javascript:alert(1)">more</a></p>'],
];

const FORBIDDEN = ['<script', 'http-equiv', '<base', 'srcdoc', 'onerror', 'javascript:'];

const BENIGN = '<p><strong>Bold</strong> and <em>italic</em> with a <a href="/shop">link</a>.</p><ul><li>One</li></ul>';
const LEGACY_YOUTUBE =
  '<p>Watch:</p><iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Demo" allowfullscreen></iframe>';

const render = (value: string) => renderToStaticMarkup(<ShortDescription value={value} className="lead" />);

/** What a browser builds from the server render, with page markup after it to run on into. */
function parseInPage(markup: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${markup}<p class="after">after</p></body></html>`,
    'text/html',
  );
}

function activeElements(doc: Document): string[] {
  const found = Array.from(doc.querySelectorAll('script, meta, base, iframe[srcdoc], [onerror]')).map((element) =>
    element.tagName.toLowerCase(),
  );
  doc.querySelectorAll('a[href]').forEach((anchor) => {
    if (/^\s*javascript:/i.test(anchor.getAttribute('href') ?? '')) found.push('a[href=javascript:]');
  });
  return found;
}

describe.each(['true', '', 'false', 'TRUE', '1'])('ShortDescription with NEXT_PUBLIC_IS_SANDBOX=%j', (flag) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(ATTACKS)('drops %s', (_label, html) => {
    const markup = render(html);
    for (const needle of FORBIDDEN) expect(markup.toLowerCase()).not.toContain(needle);
    expect(markup).toContain('Intro');
    expect(activeElements(parseInPage(markup))).toEqual([]);
  });

  it('drops a tag left open to run on into the page markup', () => {
    const markup = render('<p>Intro</p><script src=https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER&a=');
    const doc = parseInPage(markup);
    expect(activeElements(doc)).toEqual([]);
    expect(doc.querySelector('p.after')?.textContent).toBe('after');
  });

  it('keeps ordinary formatting exactly as authored', () => {
    expect(render(BENIGN)).toBe(`<div class="lead">${BENIGN}</div>`);
  });

  it('keeps a legacy YouTube embed, on the no-cookie host', () => {
    const markup = render(LEGACY_YOUTUBE);
    expect(markup).toContain('<iframe');
    expect(markup).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(markup).toContain('allowfullscreen');
    expect(markup).not.toContain('www.youtube.com/embed');
  });

  it('still renders plain text as escaped text with its line breaks', () => {
    expect(render('Line one\nLine two & more')).toBe(
      '<p class="whitespace-pre-line lead">Line one\nLine two &amp; more</p>',
    );
  });
});
