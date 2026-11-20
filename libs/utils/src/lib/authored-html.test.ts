// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import sanitizeHtml from 'sanitize-html';
import { describe, expect, it } from 'vitest';

import * as utilsBarrel from '../index';
import { sanitizeAuthoredBlockHtml, sanitizeAuthoredSvgMarkup } from './authored-html';

/**
 * What a browser builds when the sanitized string is injected raw into a server render
 * (`dangerouslySetInnerHTML`): the authored markup sits between the page's own tags, so a tag it
 * leaves open runs on into them. The page markup after it is what the tokenizer continues into.
 */
function parseInPage(sanitized: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body><div class="authored">${sanitized}</div><p class="after">after</p></body></html>`,
    'text/html',
  );
}

/** Elements and attributes that act without a click: scripts, redirects, base URLs, nested documents, handlers. */
function activeConstructs(doc: Document): string[] {
  const found: string[] = [];
  doc.querySelectorAll('script, meta, base, object, embed, link, frame, frameset').forEach((element) => {
    found.push(`<${element.tagName.toLowerCase()}>`);
  });
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') found.push(`${element.tagName.toLowerCase()}[${name}]`);
      // As the URL parser reads the value: tabs and newlines removed, leading spaces and controls stripped.
      const unbroken = attribute.value.replace(/[\t\n\r]/g, '');
      let start = 0;
      while (start < unbroken.length && unbroken.charCodeAt(start) <= 0x20) start += 1;
      const url = unbroken.slice(start);
      if (/^(?:javascript|vbscript|data:text\/html)/i.test(url) && /href|src|action|data|poster|background/.test(name)) {
        found.push(`${element.tagName.toLowerCase()}[${name}=${attribute.value}]`);
      }
    }
  });
  return found;
}

describe('sanitizeAuthoredBlockHtml', () => {
  it('strips inline <script> blocks', () => {
    const out = sanitizeAuthoredBlockHtml('<p>hi</p><script>alert(1)</script><p>bye</p>');
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('<p>bye</p>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips remote and attribute-laden scripts, and dangling script tags', () => {
    expect(sanitizeAuthoredBlockHtml('<script src="https://evil.test/x.js"></script>').toLowerCase()).not.toContain('<script');
    expect(sanitizeAuthoredBlockHtml('<script type="module" async>fetch("/x")</script>').toLowerCase()).not.toContain('<script');
    expect(sanitizeAuthoredBlockHtml('<script>').toLowerCase()).not.toContain('<script');
  });

  it('strips inline event handlers', () => {
    const out = sanitizeAuthoredBlockHtml('<img src="/a.png" onerror="steal()"><div onclick=\'x()\'>z</div>');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('src="/a.png"');
  });

  it('neutralises javascript: and data:text/html URLs in href/src', () => {
    const out = sanitizeAuthoredBlockHtml('<a href="javascript:alert(1)">x</a><iframe src="data:text/html,<script>1</script>"></iframe>');
    expect(out).not.toMatch(/href\s*=\s*["']javascript:/i);
    expect(out).not.toMatch(/src\s*=\s*["']data:text\/html/i);
  });

  it('leaves benign rich-text markup intact', () => {
    const html = '<h2>Title</h2><p><strong>bold</strong> <a href="/about">about</a></p><img src="https://cdn.test/a.png" alt="a">';
    expect(sanitizeAuthoredBlockHtml(html)).toBe(html);
  });

  it('keeps iframes and their src, so YouTube embeds still play', () => {
    const embed =
      '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
    expect(sanitizeAuthoredBlockHtml(embed)).toBe(embed);
  });

  it('empty input yields empty string', () => {
    expect(sanitizeAuthoredBlockHtml('')).toBe('');
  });

  describe('bypasses found in the 2026-10-21 review', () => {
    it('does not reassemble a script from a nested tag', () => {
      const out = sanitizeAuthoredBlockHtml('<scr<script>ipt src="https://www.google.com/x.js"></scr<script>ipt>');
      expect(out.toLowerCase()).not.toContain('<script');
    });

    it('strips handlers that follow a slash instead of whitespace', () => {
      const out = sanitizeAuthoredBlockHtml('<img src="x"/onerror=alert(1)>');
      expect(out).not.toMatch(/onerror/i);
    });

    it('neutralises unquoted javascript: URLs', () => {
      const out = sanitizeAuthoredBlockHtml('<a href=javascript:alert(1)>x</a>');
      expect(out).not.toMatch(/javascript:/i);
    });

    it('removes elements that act without script (meta refresh, base, plugins)', () => {
      const out = sanitizeAuthoredBlockHtml(
        '<meta http-equiv=refresh content="0;url=https://evil.test"><base href="https://evil.test/"><object data="x.swf"></object><embed src="x.swf"><p>ok</p>',
      );
      expect(out).not.toMatch(/<meta|<base|<object|<embed/i);
      expect(out).toContain('<p>ok</p>');
    });

    it('strips srcdoc, which renders an inline same-origin document', () => {
      const out = sanitizeAuthoredBlockHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>');
      expect(out).not.toMatch(/srcdoc/i);
    });
  });

  describe('bypasses found in the 2026-11-03 review', () => {
    it('strips a handler or srcdoc right after a quoted value, where the tokenizer starts a new attribute', () => {
      const payloads = [
        '<img src="x"onerror="alert(1)">',
        "<img src='x'onerror='alert(1)'>",
        '<img src="x"onerror=alert(1)>',
        // A srcdoc document is same-origin and inherits the CSP, whose script-src keeps host
        // sources: the entity-encoded script below would load an attacker's GTM container.
        '<iframe src="https://www.youtube-nocookie.com/embed/abc"srcdoc="&lt;script src=https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER&gt;&lt;/script&gt;"></iframe>',
      ];
      for (const payload of payloads) {
        // Unsanitized, the browser really gives the element the attribute.
        expect(activeConstructs(parseInPage(payload)), payload).not.toEqual([]);

        const out = sanitizeAuthoredBlockHtml(payload);
        expect(out, payload).not.toMatch(/onerror|srcdoc/i);
        expect(activeConstructs(parseInPage(out)), payload).toEqual([]);
      }
    });

    it('escapes a tag that never closes, which would otherwise run on into the page markup', () => {
      const payloads = [
        '<p>ok</p><script src=https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER&a=',
        '<p>ok</p><meta http-equiv=refresh content=0;url=https://evil.example/?',
        '<p>ok</p><base href=https://evil.example/',
        '<p>ok</p><iframe src=https://www.youtube-nocookie.com/embed/abc srcdoc=x',
      ];
      for (const payload of payloads) {
        // Unsanitized, the browser really builds the element out of the page's own markup.
        expect(activeConstructs(parseInPage(payload)), payload).not.toEqual([]);

        const out = sanitizeAuthoredBlockHtml(payload);
        const doc = parseInPage(out);
        expect(activeConstructs(doc), payload).toEqual([]);
        expect(doc.querySelector('.authored p')?.textContent).toBe('ok');
        expect(doc.querySelector('p.after')?.textContent).toBe('after');
      }
    });

    it('escapes only a < after the last > that would open a tag, comment or end tag', () => {
      expect(sanitizeAuthoredBlockHtml('if a<b')).toBe('if a&lt;b');
      expect(sanitizeAuthoredBlockHtml('<p>x</p><!-- never closed')).toBe('<p>x</p>&lt;!-- never closed');
      expect(sanitizeAuthoredBlockHtml('<p>x</p></div')).toBe('<p>x</p>&lt;/div');
      // Text to the tokenizer already, before or after the last >: the browser reads it as
      // authored. (The sanitizer writes every `<` in text as `&lt;`, so compare what it builds.)
      expect(sanitizeAuthoredBlockHtml('<p>1 &lt; 2</p>')).toBe('<p>1 &lt; 2</p>');
      const text = '<p>a</p> b < c, 1<2 <';
      expect(parseInPage(sanitizeAuthoredBlockHtml(text)).body.innerHTML).toBe(parseInPage(text).body.innerHTML);
    });

    it('neutralises a handler name after a quote rather than deleting it, so look-alikes read as authored', () => {
      // The quote can end a value that itself ends in `=`, or sit in text. Deleting from the name
      // on emptied data-query / title and ate text up to the next `>`; a character reference in
      // a value or in text decodes back to the authored letter.
      const lookAlikes = [
        '<a href="https://example.com/?ref=" data-query="onsale=1">x</a>',
        '<img src="data:image/png;base64,iVBORw0KGgo=" title="online=yes">',
        '<a href="/?q=">a</a><span title="onion=3">b</span>',
        '<p>a="</p><p title="online=yes">c</p>',
        '<p>a="b"onion=c and x=\'y\'onboarding=true</p>',
      ];
      for (const html of lookAlikes) {
        expect(parseInPage(sanitizeAuthoredBlockHtml(html)).body.innerHTML, html).toBe(parseInPage(html).body.innerHTML);
      }
    });

    it('leaves no handler or srcdoc right after a quote, however the quote got there', () => {
      const payloads = [
        '<img src="a"x="b"onerror=alert(1)>',
        '<img/src="x"onerror=alert(1)>',
        '<p>a="</p><img src="x"onerror=alert(1)>',
        '<img src="x="onerror=alert(1)>',
        '<IMG SRC="x"ONERROR=alert(1)>',
        '<iframe src="https://example.com/embed"SrcDoc="&lt;script src=https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER&gt;&lt;/script&gt;"></iframe>',
        '<img src="x"onerror =alert(1)>',
        '<img src="x"onload="a"onerror="b">',
        // A value that never closes runs on into the page markup: nothing after the name must match.
        '<img src="x"onerror="alert(1)//>',
        // The first match ends inside alt's value, past alt's own `=`; the next pass finds onerror.
        '<p>a="</p><img alt="onx=1"onerror=alert(1)>',
      ];
      for (const payload of payloads) {
        // Unsanitized, the browser really gives the element the attribute.
        expect(activeConstructs(parseInPage(payload)), payload).not.toEqual([]);
        expect(activeConstructs(parseInPage(sanitizeAuthoredBlockHtml(payload))), payload).toEqual([]);
      }
    });

    it('escapes a tag left open in a JSON-parseable string too, because raw sinks inject it as HTML', () => {
      // ShortDescription renders this as HTML (it contains a tag). The text-block renderers keep
      // Tiptap JSON away from the sanitizer themselves; an exemption in here would hand every raw
      // sink a live script.
      const payload = '{"a":"<b>x</b><script src=https://www.googletagmanager.com/gtm.js?id=GTM-X&c="}';
      expect(() => JSON.parse(payload)).not.toThrow();
      expect(activeConstructs(parseInPage(payload))).not.toEqual([]);
      expect(activeConstructs(parseInPage(sanitizeAuthoredBlockHtml(payload)))).toEqual([]);
    });

    it('leaves values that merely start with on…= alone, in attributes and in Tiptap JSON', () => {
      // The sanitizer writes every value in double quotes and `<` in text as `&lt;`: the browser
      // builds the same element and reads the same text.
      const attribute = '<img alt="one=two" title=\'online=yes\' src="/a.png">';
      expect(parseInPage(sanitizeAuthoredBlockHtml(attribute)).body.innerHTML).toBe(parseInPage(attribute).body.innerHTML);
      const tiptapJson = JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'onion=3 and a < b' }] }],
      });
      expect(parseInPage(sanitizeAuthoredBlockHtml(tiptapJson)).querySelector('.authored')?.textContent).toBe(tiptapJson);
    });

    it('neutralises a script URL hidden behind character references, tabs or a quote in its value', () => {
      const payloads = [
        '<a href="&#x6A;avascript:alert(1)">x</a>',
        '<a href="&#106avascript:alert(1)">x</a>',
        '<a href="java&#9;script:alert(1)">x</a>',
        '<a href="java&Tab;script&colon;alert(1)">x</a>',
        '<a href=javascript&colon;alert(1)>x</a>',
        '<a href="&#x20;&#x0A;javascript:alert(1)">x</a>',
        "<a href=\"javascript:alert('x')\">x</a>",
        '<form><button formaction="JaVaScRiPt:alert(1)">x</button></form>',
        '<iframe src="data&colon;text/html,&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
      ];
      for (const payload of payloads) {
        // Unsanitized, the browser really reads the value as a script URL.
        expect(activeConstructs(parseInPage(payload)), payload).not.toEqual([]);
        expect(activeConstructs(parseInPage(sanitizeAuthoredBlockHtml(payload))), payload).toEqual([]);
      }
      // A URL that only mentions a scheme further on is left as authored.
      const benign = '<a href="https://example.com/?q=javascript:1&amp;r=2">x</a>';
      expect(sanitizeAuthoredBlockHtml(benign)).toBe(benign);
    });

    it('neutralises a handler or srcdoc whose quoted value never closes', () => {
      // Raw-injected, the open value runs on into the page markup: a live srcdoc document (same
      // origin, the CSP's script-src allows Google Tag Manager) or a handler.
      for (const payload of [
        '<p>ok</p><iframe src=x srcdoc="&lt;script src=https://www.googletagmanager.com/gtm.js?id=GTM-X&gt;&lt;/script&gt;>',
        '<p>ok</p><img src=x onerror="alert(1)//>',
      ]) {
        expect(activeConstructs(parseInPage(payload)), payload).not.toEqual([]);
        expect(activeConstructs(parseInPage(sanitizeAuthoredBlockHtml(payload))), payload).toEqual([]);
      }
      // Text that only looks like an unclosed handler still reads as authored.
      const text = '<p>He typed onclick="hi</p>';
      expect(parseInPage(sanitizeAuthoredBlockHtml(text)).querySelector('.authored')?.textContent).toBe('He typed onclick="hi');
    });

    it('stays linear on a long run of unclosed tags', () => {
      // A per-`<` look-ahead to the end of the input (`/<(?=[^>]*$)/g`) takes seconds here; the
      // tail escape a few milliseconds. Every page render runs this on every text block.
      const input = '<a'.repeat(100_000);
      const started = performance.now();
      expect(sanitizeAuthoredBlockHtml(input)).toBe('&lt;a'.repeat(100_000));
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it('stays linear on a long run of handlers right after quoted values', () => {
      const input = '<img src="x"onerror=1>'.repeat(20_000);
      const started = performance.now();
      expect(sanitizeAuthoredBlockHtml(input)).toBe('<img src="x">'.repeat(20_000));
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });
});

/** The browser builds the same DOM from the sanitized string as from the authored one. */
function expectSameDom(html: string): void {
  expect(parseInPage(sanitizeAuthoredBlockHtml(html)).body.innerHTML, html).toBe(parseInPage(html).body.innerHTML);
}

/**
 * `innerHTML` as browsers serialized it before the 2025 HTML change that escapes `<` and `>` in
 * attribute values (Chrome 138; parse5 8.1, so jsdom 31's own serializer does it too). Browsers
 * from before it are still in use and keep them raw, which is what lets markup change namespace
 * across a round trip, so the round trips below serialize this way: the sanitizer has to hold on
 * the weakest serializer, not on the test DOM's. Attribute values carry `<` and `>` as private-use
 * stand-ins through the real serializer, which writes them as they are, and get them back after.
 */
function legacyInnerHtml(root: Element): string {
  const LT = '';
  const GT = '';
  const mark = (node: Element | DocumentFragment): void => {
    for (const element of Array.from(node.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        if (/[<>]/.test(attribute.value)) attribute.value = attribute.value.replace(/</g, LT).replace(/>/g, GT);
      }
      if (element instanceof HTMLTemplateElement) mark(element.content);
    }
  };
  mark(root);
  return root.innerHTML.replace(//g, '<').replace(//g, '>');
}

/**
 * The browser's own round trip on sanitized block HTML: parse it into the page, serialize the
 * authored subtree, parse that again (the editor's getHTML, a preview). Serializing keeps `<` in
 * attribute values (`legacyInnerHtml`), so markup that changes namespace between the two parses
 * shows up here.
 */
function roundTrip(sanitized: string): Document {
  const authored = parseInPage(sanitized).querySelector('.authored');
  return parseInPage(authored ? legacyInnerHtml(authored) : '');
}

/** SvgNode's round trip: the markup assigned into an <svg>, serialized with its host, parsed again. */
function svgRoundTrip(markup: string): Document {
  const host = document.createElement('div');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = markup;
  host.appendChild(svg);
  return parseInPage(legacyInnerHtml(host));
}

describe('the allowlist (2026-11-04)', () => {
  it('keeps what the editor writes: widgets, styles, marks, code, tables and task lists', () => {
    expectSameDom(
      '<style type="text/css">.promo{color:#0a7}</style>' +
        '<div data-alert-widget="" data-type="info" data-title="Heads up" data-message="Read me" class="my-4"></div>' +
        '<div data-cta-widget="" data-text="Buy" data-url="/shop" data-style="primary" data-size="lg"></div>' +
        '<h2 id="intro" style="text-align: center !important">Intro</h2>' +
        '<p><span style="color: #ff0000; font-size: 18px; font-family: Georgia">Red</span> <mark data-color="#fde68a" style="background-color: #fde68a; color: inherit" class="rounded-sm px-1 py-0.5">hi</mark> <code>x</code>, H<sub>2</sub>O, E=mc<sup>2</sup>, <s>old</s> <u>under</u><br>next</p>' +
        '<pre><code class="language-ts"><span class="hljs-keyword">const</span> a = 1;</code></pre><blockquote><p>Q</p></blockquote><hr>' +
        '<ul class="list-disc pl-4"><li><p>One</p><ol class="list-decimal pl-4" start="3"><li><p>Three</p></li></ol></li></ul>' +
        '<ul data-type="taskList" class="list-none pl-0 space-y-1"><li data-type="taskItem" data-checked="true" class="flex items-start gap-2 my-1"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li></ul>',
    );
    const table =
      '<table style="min-width: 200px" class="w-full border-collapse"><colgroup><col style="min-width: 100px"><col style="min-width: 100px"></colgroup>' +
      '<tbody><tr><th colspan="1" rowspan="1" colwidth="150"><p>Head</p></th><th colspan="1" rowspan="1"><p>Two</p></th></tr>' +
      '<tr><td colspan="2" rowspan="1" class="p-3"><p>Cell</p></td></tr></tbody></table>';
    expect(sanitizeAuthoredBlockHtml(table)).toBe(table);
  });

  it('keeps links on web, mail and phone URLs and relative ones, and drops every other scheme', () => {
    for (const href of ['https://example.com/a?b=1#c', 'http://example.com', 'mailto:hi@example.com', 'tel:+15145550100', 'sms:+15145550100', '/about', '#top', '?page=2', '../up']) {
      const html = `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-primary underline">x</a>`;
      expect(sanitizeAuthoredBlockHtml(html), href).toBe(html);
    }
    // Protocol handlers launch other software (ms-msdt: was Follina); data:, file: and blob: are not links.
    for (const href of ['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'intent://scan/#Intent;scheme=zxing;end', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)', 'blob:https://example.com/0f6c']) {
      expect(sanitizeAuthoredBlockHtml(`<a href="${href}">x</a>`), href).toBe('<a>x</a>');
    }
  });

  it('keeps images, data: ones included, with the editor attributes on them', () => {
    const image =
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="" class="max-w-full h-auto rounded-md" data-align="center" data-caption="A cat" width="320" height="200" loading="lazy" srcset="/a-1x.png 1x, /a-2x.png 2x">';
    expect(sanitizeAuthoredBlockHtml(image)).toBe(image);
    expect(sanitizeAuthoredBlockHtml('<img src="javascript:alert(1)" alt="x">')).toBe('<img alt="x">');
    expect(sanitizeAuthoredBlockHtml('<img src="/a.png" srcset="javascript:alert(1) 1x, /a-2x.png 2x">')).toBe('<img src="/a.png" srcset="/a-2x.png 2x">');
  });

  it('keeps YouTube and Vimeo players over https, and drops every other iframe whole', () => {
    expectSameDom(
      '<iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe>',
    );
    expectSameDom('<div data-youtube-video=""><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=30" loading="lazy" allowfullscreen></iframe></div>');
    // Protocol-relative: https on the https page it renders in.
    expectSameDom('<iframe src="//www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>');
    const dropped = [
      '<iframe src="https://evil.example/embed"></iframe>',
      '<iframe src="http://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
      // Same origin: the CMS framed under a block (frame-ancestors 'self' allows it).
      '<iframe src="/cms/users"></iframe>',
      '<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>',
      '<iframe src="https://evil.example\\@www.youtube.com/embed/x"></iframe>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<iframe></iframe>',
    ];
    for (const html of dropped) {
      expect(sanitizeAuthoredBlockHtml(`<p>a</p>${html}<p>b</p>`), html).toBe('<p>a</p><p>b</p>');
    }
    // Fallback content inside a kept iframe is never shown: it is not written.
    expect(sanitizeAuthoredBlockHtml('<iframe src="https://player.vimeo.com/video/1"><p>fallback</p></iframe>')).toBe(
      '<iframe src="https://player.vimeo.com/video/1"></iframe>',
    );
  });

  it('drops forms and every control but the task-list checkbox, and the attributes that reach outside the block', () => {
    const out = sanitizeAuthoredBlockHtml(
      // A WRITER's form that posts with the cookies of the admin who clicks it.
      '<form action="/api/cms/users" method="post"><input type="hidden" name="role" value="ADMIN"><button formaction="/api/x">Save</button></form>' +
        // Joins a CMS form elsewhere on the page, toggles a CMS control, clobbers document.cookie.
        '<input form="settings" name="role" value="ADMIN"><label for="confirm-delete">Click</label><img src="/a.png" name="cookie">' +
        '<select name="s"><option>opt</option></select><textarea name="t">area</textarea><input type="checkbox" form="settings" name="c" checked>',
    );
    const doc = parseInPage(out);
    expect(doc.querySelectorAll('form, button, select, option, textarea').length).toBe(0);
    expect(doc.querySelectorAll('[name], [form], [for], [formaction], [action]').length).toBe(0);
    expect(Array.from(doc.querySelectorAll('input'), (input) => input.outerHTML)).toEqual(['<input type="checkbox" checked="">']);
    expect(doc.querySelector('label')?.textContent).toBe('Click');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('/a.png');
    expect(out).not.toMatch(/opt|area/);
  });

  it('keeps inline SVG with its gradients and clip paths, and drops foreignObject, use and animation', () => {
    const icon =
      '<p>Icon <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" class="inline-block align-middle">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#f00"></stop><stop offset="1" stop-color="#00f"></stop></linearGradient>' +
      '<clipPath id="c"><rect width="24" height="24" rx="4"></rect></clipPath></defs><g clip-path="url(#c)"><path d="M0 0h24v24H0z" fill="url(#g)"></path><circle cx="12" cy="12" r="4"/></g>' +
      '<title>Logo</title><text x="2" y="20" font-size="6">Hi</text></svg> end</p>';
    expectSameDom(icon);
    const doc = parseInPage(sanitizeAuthoredBlockHtml(icon));
    expect(doc.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(doc.querySelector('linearGradient')?.getAttribute('gradientUnits')).toBe('objectBoundingBox');

    const hostile =
      '<svg><foreignObject><p>island</p><meta http-equiv="refresh" content="0;url=https://evil.example/"></foreignObject>' +
      '<use href="https://evil.example/sprite.svg#a"></use><animate attributeName="href" to="javascript:alert(1)"></animate><set attributeName="href" to="javascript:alert(1)"></set>' +
      '<a href="javascript:alert(1)"><text>x</text></a><a xlink:href="javascript:alert(1)"><text>y</text></a><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"></image></svg>';
    const out = sanitizeAuthoredBlockHtml(hostile);
    expect(activeConstructs(parseInPage(out))).toEqual([]);
    expect(out).not.toMatch(/foreignobject|<use|<animate|<set|island|javascript:/i);
    expect(parseInPage(out).querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('keeps a <style> block, and drops one whose text could open a tag, which the browser reads as markup inside <svg>', () => {
    expect(sanitizeAuthoredBlockHtml('<style media="(min-width: 640px)">.lead > p{color:red}</style><p class="lead">x</p>')).toBe(
      '<style media="(min-width: 640px)">.lead > p{color:red}</style><p class="lead">x</p>',
    );
    // Media queries level 4 ranges: a `<` no tag can start with.
    expect(sanitizeAuthoredBlockHtml('<style>@media (400px <= width < 600px){.a{color:red}}</style>')).toBe(
      '<style>@media (400px <= width < 600px){.a{color:red}}</style>',
    );
    expectSameDom('<svg viewBox="0 0 10 10"><style>.a{fill:red}</style><rect class="a" width="10" height="10"></rect></svg>');

    const payload = '<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>';
    // Through 2.18.1 the library wrote allowed style text through decoded and unescaped. This is
    // what it returned for the payload, and inside <svg> the browser reads that text as a live element:
    const writtenThrough2181 = '<svg><style><img src=x onerror=alert(1)></style></svg>';
    expect(activeConstructs(parseInPage(writtenThrough2181))).not.toEqual([]);
    // 2.18.2 writes that `<` as the CSS escape `\3c ` (GHSA-6wrv-5cp6-h3c5), so the inertness checks
    // below now pass without the `<` rule too. The rule is defense in depth since then: these exact
    // outputs fail without it (the library alone writes `<svg><style>\3c img …></style></svg>`).
    expect(sanitizeAuthoredBlockHtml(payload)).toBe('<svg></svg>');
    expect(sanitizeAuthoredSvgMarkup('<style>&lt;img src=x onerror=alert(1)&gt;</style><path d="M0 0"/>')).toBe('<path d="M0 0"></path>');
    for (const html of [
      payload,
      // The old library's own output, fed back in.
      writtenThrough2181,
      '<style>a{}</style><svg><style><b>&lt;img src=x onerror=alert(1)&gt;</b></style></svg>',
      '<style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style>',
      // The `<` and the tag name come from different nodes: style text, then a dropped element's text.
      '<svg><style>&lt;<x-a>img src=x onerror=alert(1) </x-a></style></svg>',
      '<svg><p><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></p></svg>',
    ]) {
      const out = sanitizeAuthoredBlockHtml(html);
      expect(activeConstructs(parseInPage(out)), html).toEqual([]);
      expect(out, html).not.toMatch(/<img/i);
    }
  });

  it('drops MathML whole, the namespace of the classic mutation bypasses', () => {
    for (const html of [
      '<p>Area <math><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></math></p>',
      '<p>Area <math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math></p>',
      '<p>Area <math><mtext><style><img src=x onerror=alert(1)></style></mtext></math></p>',
    ]) {
      expect(sanitizeAuthoredBlockHtml(html), html).toBe('<p>Area </p>');
    }
  });

  it('drops elements nested more than 100 deep and keeps their text, so a render cannot run out of stack', () => {
    const input = '<div>'.repeat(5_000) + 'deep' + '</div>'.repeat(5_000);
    const started = performance.now();
    expect(sanitizeAuthoredBlockHtml(input)).toBe('<div>'.repeat(100) + 'deep' + '</div>'.repeat(100));
    expect(performance.now() - started).toBeLessThan(2_000);
    // Real content is nowhere near: a list 30 levels deep inside a table keeps every level.
    const nested = `<table><tbody><tr><td>${'<ul><li>'.repeat(30)}x${'</li></ul>'.repeat(30)}</td></tr></tbody></table>`;
    expect(sanitizeAuthoredBlockHtml(nested)).toBe(nested);
  });

  it('leaves nothing active from the mutation payloads published against other sanitizers', () => {
    // DOMPurify and sanitize-html advisories and the classic parser-differential families:
    // namespace confusion (svg / math / integration points), raw-text and RCDATA elements,
    // comments and CDATA, entity-encoded and control-character schemes. A random-soup fuzz of the
    // same fragments (40,000 samples through parse5, both functions, a second pass included) found
    // nothing active when the allowlist landed on 2026-11-04.
    const payloads = [
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>">',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
      '<svg><p><style><img src=x onerror=alert(1)></style></p></svg>',
      '<svg><title><style><img src=x onerror=alert(1)></style></title></svg>',
      '<svg><style><!--</style><img src=x onerror=alert(1)>--></style></svg>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<noscript><style></noscript><img src=x onerror=alert(1)>',
      '<textarea></textarea/><img src=x onerror=alert(1)>',
      '<xmp><img src=x onerror=alert(1)></xmp>',
      '<iframe><img src=x onerror=alert(1)></iframe>',
      '<iframe src="https://www.youtube.com/embed/x"><img src=x onerror=alert(1)></iframe><img src=x onerror=alert(1)>',
      '<noembed><img src=x onerror=alert(1)></noembed>',
      '<template><img src=x onerror=alert(1)></template>',
      '<title><img src=x onerror=alert(1)></title>',
      '<style><style/><img src=x onerror=alert(1)>',
      '<svg><a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>',
      '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
      '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
      '<svg><image href="javascript:alert(1)"/></svg>',
      '<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
      '<svg><script href="data:,alert(1)"/></svg>',
      '<a href="j&#x0D;avascript:alert(1)">x</a>',
      '<a href="\u0001javascript:alert(1)">x</a>',
      '<a href="javascript&#58alert(1)">x</a>',
      '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
      '<img/src/onerror=alert(1)>',
      '<img """><script>alert(1)</script>">',
      '<details open ontoggle=alert(1)>',
      '<video poster="javascript:alert(1)"><source onerror=alert(1)></video>',
      '<html><head><meta http-equiv="refresh" content="0;url=javascript:alert(1)"></head></html>',
      '<base href="javascript:/a/-alert(1)///////"><a href=../lol/safari.html>test</a>',
      '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
      '<input onfocus=alert(1) autofocus><input type="image" src=x onerror=alert(1)>',
      '<<script>script>alert(1)<</script>/script>',
      '<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>',
      '<!--><img src=x onerror=alert(1)>-->',
      '<!--<img src="--><img src=x onerror=alert(1)//">',
      '<![CDATA[<img src=x onerror=alert(1)>]]>',
      '<svg><![CDATA[><img src=x onerror=alert(1)>]]></svg>',
      '<plaintext><img src=x onerror=alert(1)>',
      '<table><td><style><img src=x onerror=alert(1)></style></td></table>',
    ];
    for (const payload of payloads) {
      const out = sanitizeAuthoredBlockHtml(payload);
      expect(activeConstructs(parseInPage(out)), payload).toEqual([]);
      expect(activeConstructs(roundTrip(out)), `[round trip] ${payload}`).toEqual([]);
      expect(activeConstructs(svgRoundTrip(sanitizeAuthoredSvgMarkup(payload))), `[svg] ${payload}`).toEqual([]);
    }
  });

  it('keeps <style>, <title> and <iframe> to text, so no markup in them survives the browser round trip', () => {
    // Inside <svg> these hold markup, until a tag like <p> puts the browser back in HTML, where
    // they hold raw text; serializing keeps the `<` in attribute values.
    const payloads = [
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<svg><p></p><title><a id="</title><img src=1 onerror=alert(1)>"></a></title></svg>',
      '<svg><p></p><iframe src="https://www.youtube.com/embed/x"><a id="</iframe><img src=1 onerror=alert(1)>"></a></iframe></svg>',
    ];
    // The mutation is real: kept as markup, the attribute becomes a live element on the round trip.
    const unguarded = sanitizeHtml(payloads[0], { allowedTags: ['svg', 'p', 'style', 'a'], allowedAttributes: { a: ['id'] }, allowVulnerableTags: true });
    expect(activeConstructs(svgRoundTrip(unguarded))).not.toEqual([]);
    for (const payload of payloads) {
      const out = sanitizeAuthoredBlockHtml(payload);
      expect(out, payload).not.toMatch(/<a\b/);
      expect(activeConstructs(roundTrip(out)), payload).toEqual([]);
      const svgOut = sanitizeAuthoredSvgMarkup(payload);
      expect(svgOut, payload).not.toMatch(/<a\b/);
      expect(activeConstructs(svgRoundTrip(svgOut)), `[svg] ${payload}`).toEqual([]);
    }
    // Their text stays.
    expect(sanitizeAuthoredSvgMarkup('<title>Logo <b>mark</b></title><desc>An icon</desc>')).toBe('<title>Logo </title><desc>An icon</desc>');
  });

  it('drops unknown elements but keeps their text, and drops comments', () => {
    expect(sanitizeAuthoredBlockHtml('<p>a<o:p>b</o:p><x-widget data-id="1">c</x-widget><!-- note --><blink>d</blink></p>')).toBe('<p>abcd</p>');
  });

  it('leaves its own output unchanged, for editor markup and the bypass cases above', () => {
    // Not a law for every input: around a dropped element, text it decoded inside <svg><style>
    // or an implied end tag can come out differently on a second pass, and stays inert.
    const corpus = [
      '<p>hi</p><script>alert(1)</script><p>bye</p>',
      '<scr<script>ipt src="https://www.google.com/x.js"></scr<script>ipt>',
      '<img src="x"onerror="alert(1)">',
      '<p>ok</p><script src=https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER&a=',
      '<p>a</p> b < c, 1<2 <',
      '<a href="java&Tab;script&colon;alert(1)">x</a>',
      '<iframe src="https://www.youtube.com/embed/x"><b>fallback</b></iframe>',
      '<svg viewBox="0 0 1 1"><style>.a{}</style><path d="M0 0"/></svg>',
      '<p>&nbsp;&amp;&lt;&gt;&quot;é</p><img alt="" src="/a.png">',
    ];
    for (const html of corpus) {
      const once = sanitizeAuthoredBlockHtml(html);
      expect(sanitizeAuthoredBlockHtml(once), html).toBe(once);
    }
  });
});

describe('data-* and aria-* attribute names (2026-11-13)', () => {
  // The `data-*` / `aria-*` globs matched any name with the prefix. These are names the parser
  // builds (only whitespace, `/`, `=` and `>` end one; the parser lowercases it) that the HTML spec
  // forbids: a `:` or a bare prefix, and after `data-` anything but lowercase letters, digits, `.`,
  // `_` and `-`, after `aria-` anything but lowercase letters.
  const junkNames = [
    'data-x:xlink:href',
    'data-x:y',
    'aria-x:y',
    'data-',
    'aria-',
    'DATA-X:Y',
    'data-:',
    ...Array.from('!"#$%&\'()*+,:;<?@[\\]^`{|}~\u00a0é', (character) => `data-x${character}y`),
    ...Array.from('!"#$%&\'()*+,.:;<?@[\\]^_`{|}~\u00a0é0-', (character) => `aria-x${character}y`),
  ];
  const validNames = 'data-testid="t" data-v-1a2b3c="v" data-foo.bar="b" data-x_y="c" aria-labelledby="l" aria-hidden="true"';

  it('drops a data- or aria- name the HTML spec forbids, in HTML and inside <svg>', () => {
    for (const name of junkNames) {
      const attribute = `${name}="javascript:alert(1)"`;
      expect(sanitizeAuthoredBlockHtml(`<p ${attribute} data-keep="k">x</p>`), name).toBe('<p data-keep="k">x</p>');
      const inSvg = sanitizeAuthoredBlockHtml(`<svg><a ${attribute} data-keep="k"><text>x</text></a></svg>`);
      expect(inSvg, name).toBe('<svg><a data-keep="k"><text>x</text></a></svg>');
      expect(activeConstructs(parseInPage(inSvg)), name).toEqual([]);
      expect(sanitizeAuthoredSvgMarkup(`<a ${attribute} data-keep="k"><text>x</text></a>`), name).toBe('<a data-keep="k"><text>x</text></a>');
    }
    // The case from the review, whole: nothing with the prefix and a `:` reaches the page.
    const out = sanitizeAuthoredBlockHtml('<svg><a data-x:xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
    expect(out).toBe('<svg><a><text>x</text></a></svg>');
    expect(Array.from(parseInPage(out).querySelectorAll('.authored *'), (element) => element.getAttributeNames()).flat()).toEqual([]);
  });

  it('keeps the data- and aria- names the spec allows, on HTML and SVG elements', () => {
    expect(sanitizeAuthoredBlockHtml(`<p ${validNames}>x</p>`)).toBe(`<p ${validNames}>x</p>`);
    expect(sanitizeAuthoredBlockHtml(`<svg><rect ${validNames} width="1" height="1"></rect></svg>`)).toBe(
      `<svg><rect ${validNames} width="1" height="1"></rect></svg>`,
    );
    expect(sanitizeAuthoredSvgMarkup(`<rect ${validNames} width="1" height="1"/>`)).toBe(`<rect ${validNames} width="1" height="1"></rect>`);
    // A scoped-style marker carries no value; the parser lowercases names, and the rule reads them so.
    expect(sanitizeAuthoredBlockHtml('<p data-v-1a2b3c>x</p>')).toBe('<p data-v-1a2b3c>x</p>');
    expect(sanitizeAuthoredBlockHtml('<p DATA-TestId="t" ARIA-Hidden="true">x</p>')).toBe('<p data-testid="t" aria-hidden="true">x</p>');
  });
});

describe('sanitizeAuthoredSvgMarkup', () => {
  /** What SvgNode builds: the sanitized markup assigned to an <svg> element in the page. */
  function intoSvg(markup: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = markup;
    return svg;
  }

  it('keeps self-closed shapes, SVG casing and nested <svg> where the markup lands', () => {
    const markup = '<path d="M0 0h24v24H0z" fill="currentColor"/><linearGradient id="g"><stop offset="0"/></linearGradient><svg x="2"><circle r="1"/></svg><rect width="1" height="1"/>';
    const svg = intoSvg(sanitizeAuthoredSvgMarkup(markup));
    expect(Array.from(svg.children, (child) => child.tagName)).toEqual(['path', 'linearGradient', 'svg', 'rect']);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M0 0h24v24H0z');
    expect(svg.querySelector('svg circle')?.getAttribute('r')).toBe('1');
    expect(sanitizeAuthoredSvgMarkup('<path d="M0 0h24v24H0z" fill="currentColor"></path>')).toBe('<path d="M0 0h24v24H0z" fill="currentColor"></path>');
  });

  it('drops scripts, handlers, the HTML island and anything after an early </svg>', () => {
    const out = sanitizeAuthoredSvgMarkup(
      '<path d="M0 0"/><foreignObject><meta http-equiv="refresh" content="0;url=https://evil.example/"><img src=x onerror=alert(1)></foreignObject>' +
        '<script>alert(1)</script><circle r="1" onload="alert(1)"/></svg><img src=x onerror=alert(1)><p>outside</p>',
    );
    expect(out).toBe('<path d="M0 0"></path><circle r="1"></circle>');
    expect(sanitizeAuthoredSvgMarkup('')).toBe('');
  });
});

describe('@nextblock-cms/utils main barrel', () => {
  it('exports sanitizeAuthoredBlockHtml, so the libs and the app share one sanitizer', () => {
    expect(utilsBarrel.sanitizeAuthoredBlockHtml).toBe(sanitizeAuthoredBlockHtml);
    expect(utilsBarrel.sanitizeAuthoredSvgMarkup).toBe(sanitizeAuthoredSvgMarkup);
  });

  it('imports only sanitize-html and touches no DOM global, so it stays client-safe and runs in any runtime', () => {
    // authored-html.node.test.ts runs it where no DOM exists at all.
    const source = readFileSync(resolve(__dirname, 'authored-html.ts'), 'utf8');
    const imported = Array.from(source.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm), (match) => match[1]);
    expect(imported).toEqual(['sanitize-html']);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    expect(source).not.toMatch(/\bdocument\.|\bwindow\.|\bglobalThis\./);
  });
});
