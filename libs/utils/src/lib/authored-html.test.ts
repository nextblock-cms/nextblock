// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as utilsBarrel from '../index';
import { sanitizeAuthoredBlockHtml } from './authored-html';

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
      // Text to the tokenizer already, before or after the last >: left as authored.
      expect(sanitizeAuthoredBlockHtml('<p>1 &lt; 2</p>')).toBe('<p>1 &lt; 2</p>');
      expect(sanitizeAuthoredBlockHtml('<p>a</p> b < c, 1<2 <')).toBe('<p>a</p> b < c, 1<2 <');
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
      const attribute = '<img alt="one=two" title=\'online=yes\' src="/a.png">';
      expect(sanitizeAuthoredBlockHtml(attribute)).toBe(attribute);
      const tiptapJson = JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'onion=3 and a < b' }] }],
      });
      expect(sanitizeAuthoredBlockHtml(tiptapJson)).toBe(tiptapJson);
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
      expect(sanitizeAuthoredBlockHtml(input)).toBe('<img src="x"&#111;nerror=1>'.repeat(20_000));
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });
});

describe('@nextblock-cms/utils main barrel', () => {
  it('exports sanitizeAuthoredBlockHtml, so the libs and the app share one sanitizer', () => {
    expect(utilsBarrel.sanitizeAuthoredBlockHtml).toBe(sanitizeAuthoredBlockHtml);
  });

  it('keeps the module import-free, so it stays client-safe and runs in any runtime', () => {
    const source = readFileSync(resolve(__dirname, 'authored-html.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bdocument\.|\bwindow\./);
  });
});
