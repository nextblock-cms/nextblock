import { describe, expect, it } from 'vitest';
import { sanitizeAuthoredBlockHtml, addNonceToInlineScripts } from './inlineScriptNonce';

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

  it('empty input yields empty string', () => {
    expect(sanitizeAuthoredBlockHtml('')).toBe('');
  });

  it('deprecated addNonceToInlineScripts now sanitizes and ignores the nonce', () => {
    const out = addNonceToInlineScripts('<script>alert(1)</script><p>ok</p>', 'any-nonce');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('any-nonce');
    expect(out).toContain('<p>ok</p>');
  });
});
