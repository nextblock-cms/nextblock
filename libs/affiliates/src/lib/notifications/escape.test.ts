/* eslint-disable no-script-url -- javascript:/data: URLs are the vectors affiliateEmailHref must refuse */
import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH,
  affiliateEmailHref,
  cleanAffiliateEmailText,
  escapeAffiliateHtml,
  toAffiliateEmailSubject,
} from './escape';

describe('escapeAffiliateHtml', () => {
  it('escapes every character that can open a tag or leave an attribute', () => {
    expect(escapeAffiliateHtml(`<script>alert("x")</script> & 'y' \`z\``)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39; &#96;z&#96;'
    );
    expect(escapeAffiliateHtml('" onmouseover="alert(1)')).toBe('&quot; onmouseover=&quot;alert(1)');
    expect(escapeAffiliateHtml('&amp;')).toBe('&amp;amp;');
  });

  it('renders null and undefined as nothing and stringifies the rest', () => {
    expect(escapeAffiliateHtml(null)).toBe('');
    expect(escapeAffiliateHtml(undefined)).toBe('');
    expect(escapeAffiliateHtml(42)).toBe('42');
  });
});

describe('toAffiliateEmailSubject', () => {
  it('keeps a subject on one line (no header injection)', () => {
    const subject = toAffiliateEmailSubject('Hello\r\nBcc: victim@example.com\n\tX-Spam: yes');
    expect(subject).toBe('Hello Bcc: victim@example.com X-Spam: yes');
    expect(subject).not.toMatch(/[\r\n]/);
    const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x85)}c${String.fromCharCode(0)}d`;
    expect(toAffiliateEmailSubject(separators)).not.toMatch(/[\r\n]/);
  });

  it('cuts long subjects at 150 characters with an ellipsis', () => {
    const subject = toAffiliateEmailSubject('word '.repeat(80));
    expect(subject.length).toBeLessThanOrEqual(AFFILIATE_EMAIL_SUBJECT_MAX_LENGTH);
    expect(subject.endsWith('…')).toBe(true);
  });
});

describe('cleanAffiliateEmailText', () => {
  it('removes control and bidi override characters, keeping line breaks only when asked', () => {
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    expect(cleanAffiliateEmailText(`a${rlo}b${bell}c\nd`)).toBe('abc d');
    expect(cleanAffiliateEmailText('line 1\r\n\r\n\r\n  line 2  ', { multiline: true })).toBe('line 1\n\nline 2');
    expect(cleanAffiliateEmailText(undefined)).toBe('');
    expect(cleanAffiliateEmailText('x'.repeat(50), { max: 10 })).toBe(`${'x'.repeat(9)}…`);
  });

  it('keeps the no-break spaces of French amounts', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(cleanAffiliateEmailText(`25,00${nbsp}$`)).toBe(`25,00${nbsp}$`);
  });
});

describe('affiliateEmailHref', () => {
  it('accepts absolute http(s) URLs and normalizes them', () => {
    expect(affiliateEmailHref('https://Shop.Example/partners/jane')).toBe('https://shop.example/partners/jane');
    expect(affiliateEmailHref(' http://localhost:4200/portal/retailer ')).toBe('http://localhost:4200/portal/retailer');
  });

  it('refuses everything else', () => {
    for (const value of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:jane@example.com',
      '/portal/retailer',
      '//evil.example/x',
      'https://user:pass@evil.example/',
      'https://shop.example/a b',
      'https://shop.example/\\evil',
      'not a url',
      '',
      null,
      42,
    ]) {
      expect(affiliateEmailHref(value), String(value)).toBeNull();
    }
  });
});
