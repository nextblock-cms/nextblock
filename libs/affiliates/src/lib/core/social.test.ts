/* eslint-disable no-script-url -- the hostile URLs are the test fixtures */
import { describe, expect, it } from 'vitest';

import { AFFILIATE_SOCIAL_LINK_MAX_LENGTH, sanitizeAffiliateSocialLinks, sanitizeAffiliateSocialUrl } from './social';

describe('sanitizeAffiliateSocialLinks', () => {
  it('keeps https links on each network host, with or without www.', () => {
    expect(
      sanitizeAffiliateSocialLinks({
        website: 'https://janes-kitchen.example.com/about',
        instagram: 'https://www.instagram.com/janeskitchen',
        tiktok: 'https://tiktok.com/@janeskitchen',
        youtube: 'https://youtu.be/dQw4w9WgXcQ',
        x: 'https://twitter.com/janeskitchen',
        facebook: 'https://facebook.com/janeskitchen',
        pinterest: 'https://www.pinterest.com/janeskitchen/',
        linkedin: 'https://www.linkedin.com/in/jane',
      })
    ).toEqual({
      website: 'https://janes-kitchen.example.com/about',
      instagram: 'https://www.instagram.com/janeskitchen',
      tiktok: 'https://tiktok.com/@janeskitchen',
      youtube: 'https://youtu.be/dQw4w9WgXcQ',
      x: 'https://twitter.com/janeskitchen',
      facebook: 'https://facebook.com/janeskitchen',
      pinterest: 'https://www.pinterest.com/janeskitchen/',
      linkedin: 'https://www.linkedin.com/in/jane',
    });
  });

  it('normalizes case and accepts a pasted link without a scheme as https', () => {
    expect(sanitizeAffiliateSocialUrl('youtube', 'HTTPS://WWW.YouTube.com/@Jane')).toBe('https://www.youtube.com/@Jane');
    expect(sanitizeAffiliateSocialUrl('instagram', 'instagram.com/jane')).toBe('https://instagram.com/jane');
    expect(sanitizeAffiliateSocialUrl('website', 'janes-kitchen.example')).toBe('https://janes-kitchen.example/');
    expect(sanitizeAffiliateSocialUrl('x', '  https://x.com/jane  ')).toBe('https://x.com/jane');
  });

  it('drops every non-https scheme', () => {
    for (const value of [
      'http://instagram.com/jane',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://instagram.com/jane',
      'mailto:jane@example.com',
    ]) {
      expect(sanitizeAffiliateSocialUrl('instagram', value), value).toBeNull();
      expect(sanitizeAffiliateSocialUrl('website', value), value).toBeNull();
    }
  });

  it('drops hosts that only look like the network', () => {
    for (const value of [
      'https://instagram.com.evil.example/jane',
      'https://evilinstagram.com/jane',
      'https://m.instagram.com.attacker.io/jane',
      'https://xn--nstagram-yzc.com/jane',
      'https://іnstagram.com/jane',
      'https://tiktok.com/@jane',
    ]) {
      expect(sanitizeAffiliateSocialUrl('instagram', value), value).toBeNull();
    }
    expect(sanitizeAffiliateSocialUrl('youtube', 'https://youtube.co/jane')).toBeNull();
    expect(sanitizeAffiliateSocialUrl('x', 'https://x.co/jane')).toBeNull();
  });

  it('drops credentials, ports, whitespace, backslashes and control characters', () => {
    for (const value of [
      'https://user:pass@instagram.com/jane',
      'https://jane@instagram.com/jane',
      'https://instagram.com:8443/jane',
      'https://instagram.com/ja ne',
      'https:\\\\instagram.com\\jane',
      'https://instagram.com/jane\u0000',
      'https://instagram.com/\njane',
      '//instagram.com/jane',
      '/jane',
    ]) {
      expect(sanitizeAffiliateSocialUrl('instagram', value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops websites on IP literals, single-label hosts and over-long links', () => {
    expect(sanitizeAffiliateSocialUrl('website', 'https://127.0.0.1/')).toBeNull();
    expect(sanitizeAffiliateSocialUrl('website', 'https://0x7f.1/')).toBeNull();
    expect(sanitizeAffiliateSocialUrl('website', 'https://[::1]/')).toBeNull();
    expect(sanitizeAffiliateSocialUrl('website', 'https://localhost/')).toBeNull();
    expect(
      sanitizeAffiliateSocialUrl('website', `https://example.com/${'a'.repeat(AFFILIATE_SOCIAL_LINK_MAX_LENGTH)}`)
    ).toBeNull();
  });

  it('ignores unknown keys, non-string values and non-object input', () => {
    expect(sanitizeAffiliateSocialLinks({ myspace: 'https://myspace.com/jane', instagram: 42, website: null })).toEqual({});
    expect(sanitizeAffiliateSocialLinks(null)).toEqual({});
    expect(sanitizeAffiliateSocialLinks('https://instagram.com/jane')).toEqual({});
    expect(sanitizeAffiliateSocialLinks(['https://instagram.com/jane'])).toEqual({});
  });

  it('cannot be used for prototype pollution', () => {
    const links = sanitizeAffiliateSocialLinks(JSON.parse('{"__proto__": {"website": "https://evil.example"}, "constructor": "x"}'));
    expect(links).toEqual({});
    expect(Object.getPrototypeOf(links)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['website']).toBeUndefined();
  });
});
