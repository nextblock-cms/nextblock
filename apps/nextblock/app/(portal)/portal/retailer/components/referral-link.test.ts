import { describe, expect, it } from 'vitest';

import { buildPortalReferralLink } from './referral-link';

const SITE = 'https://shop.test';

function build(input: string, handle = 'jane-picks') {
  return buildPortalReferralLink({ input, siteOrigin: SITE, handle });
}

describe('buildPortalReferralLink', () => {
  it('links the home page when the field is empty', () => {
    expect(build('')).toEqual({ ok: true, url: 'https://shop.test/?ref=jane-picks' });
  });

  it('adds ref to a site path and keeps its query and fragment', () => {
    expect(build('/product/tee')).toEqual({ ok: true, url: 'https://shop.test/product/tee?ref=jane-picks' });
    expect(build('/product/tee?color=red#size')).toEqual({
      ok: true,
      url: 'https://shop.test/product/tee?color=red&ref=jane-picks#size',
    });
  });

  it('replaces a ref that is already there (one ref, the partner’s own)', () => {
    const result = build('/product/tee?ref=someone-else&ref=other');
    expect(result).toEqual({ ok: true, url: 'https://shop.test/product/tee?ref=jane-picks' });
  });

  it('accepts a full URL of this site, with or without the scheme, and keeps the site scheme', () => {
    expect(build('https://shop.test/article/guide')).toEqual({ ok: true, url: 'https://shop.test/article/guide?ref=jane-picks' });
    expect(build('shop.test/article/guide')).toEqual({ ok: true, url: 'https://shop.test/article/guide?ref=jane-picks' });
    expect(build('http://shop.test/article/guide')).toEqual({ ok: true, url: 'https://shop.test/article/guide?ref=jane-picks' });
  });

  it('refuses other sites, including look-alike hosts', () => {
    expect(build('https://evil.test/product/tee')).toEqual({ ok: false, error: 'other_site' });
    expect(build('https://shop.test.evil.test/')).toEqual({ ok: false, error: 'other_site' });
    expect(build('https://evil.test@shop.test/')).toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses scheme-relative, backslash, encoded-slash and script inputs', () => {
    for (const input of ['//evil.test/x', '/\\evil.test', '/%2F%2Fevil.test', '/%5Cevil.test', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(build(input).ok, input).toBe(false);
    }
    expect(build('/product/a b')).toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses the paths the referral proxy ignores (/cms, /api, /portal, /_next)', () => {
    for (const input of ['/cms', '/cms/pages', '/api/x', '/portal/retailer', '/_next/static/x', '/CMS/dashboard']) {
      expect(build(input), input).toEqual({ ok: false, error: 'excluded_path' });
    }
    // A public page that merely starts with the same letters is fine.
    expect(build('/cms-tips').ok).toBe(true);
  });

  it('refuses an invalid handle or site origin, and over-long input', () => {
    expect(buildPortalReferralLink({ input: '/x', siteOrigin: SITE, handle: 'Not A Handle' })).toEqual({ ok: false, error: 'invalid' });
    expect(buildPortalReferralLink({ input: '/x', siteOrigin: 'not a url', handle: 'jane' })).toEqual({ ok: false, error: 'invalid' });
    expect(build(`/${'a'.repeat(2100)}`)).toEqual({ ok: false, error: 'invalid' });
  });
});
