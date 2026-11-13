// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimpleTiptapRenderer } from './SimpleTiptapRenderer';

/**
 * A string `description_json` (and a text block whose HTML merely starts with `{` or `[`) is
 * rendered as HTML: on /product/<slug> for every visitor, and in the CMS block previews. Any
 * ADMIN writes it (the CMS, the Cortex tools, PostgREST; every visitor on the public sandbox), so
 * it goes through the text-block sanitizer. The sanitizer does not read the sandbox flag.
 */

const ATTACKS: Array<[label: string, html: string]> = [
  ['a remote script on an allowed host', '<p>Intro</p><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER"></script>'],
  ['a meta refresh', '<p>Intro</p><meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['a base element', '<p>Intro</p><base href="https://evil.example/">'],
  ['an iframe with srcdoc', '<p>Intro</p><iframe srcdoc="<p>inner</p>"></iframe>'],
  ['an onerror handler', '<p>Intro</p><img src="/x.png" onerror="alert(1)">'],
  ['a javascript: link', '<p>Intro <a href="javascript:alert(1)">more</a></p>'],
  // Starts like JSON, fails to parse, falls through to the HTML path (EditableBlock sends these).
  ['HTML behind a leading brace', '{<p>Intro</p><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER"></script>'],
  ['HTML behind a leading bracket', '[<p>Intro</p><meta http-equiv="refresh" content="0;url=https://evil.example/">'],
];

const FORBIDDEN = ['<script', 'http-equiv', '<base', 'srcdoc', 'onerror', 'javascript:'];

const BENIGN = '<h2>Details</h2><p><strong>Bold</strong> and <em>italic</em> with a <a href="/shop">link</a>.</p>';
const LEGACY_YOUTUBE =
  '<p>Watch:</p><iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Demo" allowfullscreen></iframe>';

const render = (content: unknown) => renderToStaticMarkup(<SimpleTiptapRenderer content={content} className="prose" />);

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

describe.each(['true', '', 'false', 'TRUE', '1'])('SimpleTiptapRenderer with NEXT_PUBLIC_IS_SANDBOX=%j', (flag) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(ATTACKS)('drops %s from an HTML string', (_label, html) => {
    const markup = render(html);
    for (const needle of FORBIDDEN) expect(markup.toLowerCase()).not.toContain(needle);
    expect(markup).toContain('Intro');
    expect(activeElements(parseInPage(markup))).toEqual([]);
  });

  it('drops a tag left open to run on into the page markup', () => {
    const markup = render('<p>Intro</p><meta http-equiv=refresh content=0;url=https://evil.example/?');
    const doc = parseInPage(markup);
    expect(activeElements(doc)).toEqual([]);
    expect(doc.querySelector('p.after')?.textContent).toBe('after');
  });

  it('keeps ordinary formatting exactly as authored', () => {
    expect(render(BENIGN)).toBe(`<div class="prose">${BENIGN}</div>`);
  });

  it('keeps a legacy YouTube embed, on the no-cookie host', () => {
    const markup = render(LEGACY_YOUTUBE);
    expect(markup).toContain('<iframe');
    expect(markup).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(markup).not.toContain('www.youtube.com/embed');
  });

  it('still renders Tiptap JSON (object or string) through React, which escapes text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script> Hello' }] }],
    };
    for (const content of [doc, JSON.stringify(doc)]) {
      const markup = render(content);
      expect(markup).toBe('<div class="prose"><p class="mb-4">&lt;script&gt;alert(1)&lt;/script&gt; Hello</p></div>');
    }
  });
});
