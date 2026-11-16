// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { sanitizeAuthoredBlockHtml, sanitizeAuthoredSvgMarkup } from './authored-html';

/**
 * Server components and the published lib run the sanitizer where no DOM exists: no window, no
 * document, no DOMParser. authored-html.test.ts checks what a browser builds from the output; this
 * suite checks the sanitizer needs no DOM to produce it, and produces the same strings.
 */
describe('sanitizeAuthoredBlockHtml without a DOM', () => {
  it('runs where there is no window, document or DOMParser', () => {
    const scope = globalThis as Record<string, unknown>;
    expect([typeof scope['window'], typeof scope['document'], typeof scope['DOMParser']]).toEqual(['undefined', 'undefined', 'undefined']);
  });

  it('gives the same output as in the browser suite', () => {
    const benign = '<h2>Title</h2><p><strong>bold</strong> <a href="/about">about</a></p><img src="https://cdn.test/a.png" alt="a">';
    expect(sanitizeAuthoredBlockHtml(benign)).toBe(benign);
    const embed =
      '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
    expect(sanitizeAuthoredBlockHtml(embed)).toBe(embed);
    expect(sanitizeAuthoredBlockHtml('<p>hi</p><script>alert(1)</script><img src="x"onerror="alert(1)"><a href="java&Tab;script&colon;alert(1)">x</a>')).toBe(
      '<p>hi</p><img src="x"><a>x</a>',
    );
    expect(sanitizeAuthoredBlockHtml('<p>ok</p><meta http-equiv=refresh content=0;url=https://evil.example/?')).toBe(
      '<p>ok</p>&lt;meta http-equiv=refresh content=0;url=https://evil.example/?',
    );
    expect(sanitizeAuthoredSvgMarkup('<path d="M0 0"/><foreignObject><p>x</p></foreignObject>')).toBe('<path d="M0 0"></path>');
    expect(sanitizeAuthoredBlockHtml('<p data-x:y="1" data-testid="t" aria-x:y="1" aria-hidden="true" data-="1">x</p>')).toBe(
      '<p data-testid="t" aria-hidden="true">x</p>',
    );
    expect(sanitizeAuthoredSvgMarkup('<a data-x:xlink:href="javascript:alert(1)"><text>x</text></a>')).toBe('<a><text>x</text></a>');
  });
});
