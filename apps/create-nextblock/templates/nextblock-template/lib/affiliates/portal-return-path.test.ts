import { describe, expect, it } from 'vitest';
import { buildAffiliatePortalReturnPath } from './portal-return-path';

describe('buildAffiliatePortalReturnPath', () => {
  it('keeps a portal page and its query string', () => {
    expect(buildAffiliatePortalReturnPath('/portal/retailer')).toBe('/portal/retailer');
    expect(buildAffiliatePortalReturnPath('/portal/retailer/storefront', '')).toBe('/portal/retailer/storefront');
    expect(buildAffiliatePortalReturnPath('/portal/retailer/payouts', '?connect_error=1')).toBe('/portal/retailer/payouts?connect_error=1');
    expect(buildAffiliatePortalReturnPath('/portal/retailer/payouts', 'connected=1')).toBe('/portal/retailer/payouts?connected=1');
    expect(buildAffiliatePortalReturnPath('/portal/retailer', { welcome: '1', tag: ['a', 'b'], skip: undefined })).toBe(
      '/portal/retailer?welcome=1&tag=a&tag=b',
    );
    expect(buildAffiliatePortalReturnPath('/portal/retailer/payouts', new URLSearchParams('connected=1'))).toBe(
      '/portal/retailer/payouts?connected=1',
    );
  });

  it('falls back to the overview, without the query, for anything outside the portal', () => {
    for (const path of [
      null,
      undefined,
      '',
      '/cms/users',
      '/portal/retailerx',
      '/portal',
      '//evil.example/portal/retailer',
      'https://evil.example/portal/retailer',
      '/portal/retailer/../../cms',
      '/portal/retailer//evil.example',
      '/portal/retailer/%2F%2Fevil.example',
      '/portal/retailer\\evil',
      '/portal/retailer/x y',
    ]) {
      expect(buildAffiliatePortalReturnPath(path, '?connected=1')).toBe('/portal/retailer');
    }
  });

  it('drops framework parameters and an oversized query', () => {
    expect(buildAffiliatePortalReturnPath('/portal/retailer/payouts', '?_rsc=abc&connected=1')).toBe('/portal/retailer/payouts?connected=1');
    expect(buildAffiliatePortalReturnPath('/portal/retailer/payouts', `?q=${'x'.repeat(600)}`)).toBe('/portal/retailer/payouts');
  });

  it('re-encodes the query, so nothing in it can break out of the sign-in URL', () => {
    expect(buildAffiliatePortalReturnPath('/portal/retailer', '?next=%2F%2Fevil.example&a=b c')).toBe(
      '/portal/retailer?next=%2F%2Fevil.example&a=b+c',
    );
  });
});
