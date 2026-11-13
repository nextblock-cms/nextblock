import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Email" link of the /cms/affiliates screens: a `mailto:` with a fixed subject. A partner
 * picks their own sign-in address, and HTML's address grammar lets its local part hold `?`, `&`,
 * `#`, `%` and `=`: written raw into a `mailto:`, `a?cc=x%40evil.example@shop.test` would add a
 * recipient in the admin's mail client. The local part is percent-encoded instead (RFC 6068).
 */

const settings = vi.hoisted(() => ({ siteTitle: 'Maple Shop' as string | null, fail: false }));

vi.mock('server-only', () => ({}));
vi.mock('../../app/lib/site-settings', () => ({
  getSiteSettings: async () => {
    if (settings.fail) throw new Error('settings unavailable');
    return { siteTitle: settings.siteTitle };
  },
}));

import { buildAffiliatePartnerMailtoHref, getAffiliatePartnerEmailSubject } from './partner-contact';

describe('getAffiliatePartnerEmailSubject', () => {
  beforeEach(() => {
    settings.siteTitle = 'Maple Shop';
    settings.fail = false;
  });

  it('names the site, or falls back to the default title', async () => {
    expect(await getAffiliatePartnerEmailSubject()).toBe('Your partner storefront on Maple Shop');
    settings.siteTitle = '   ';
    expect(await getAffiliatePartnerEmailSubject()).toBe('Your partner storefront on NextBlock™ CMS');
    settings.fail = true;
    expect(await getAffiliatePartnerEmailSubject()).toBe('Your partner storefront on NextBlock™ CMS');
  });
});

describe('buildAffiliatePartnerMailtoHref', () => {
  const subject = 'Your partner storefront on Maple & Co';

  it('builds a mailto with an encoded subject', () => {
    expect(buildAffiliatePartnerMailtoHref('jane@partner.dev', subject)).toBe(
      'mailto:jane@partner.dev?subject=Your%20partner%20storefront%20on%20Maple%20%26%20Co'
    );
    expect(buildAffiliatePartnerMailtoHref('jane.doe+shop@partner.dev', 'x')).toBe('mailto:jane.doe%2Bshop@partner.dev?subject=x');
  });

  it('never lets the address add a recipient, a header or a fragment', () => {
    const href = buildAffiliatePartnerMailtoHref('a?cc=x%40evil.example&bcc=y#z@shop.test', subject) ?? '';
    expect(href.startsWith('mailto:a%3Fcc%3Dx%2540evil.example%26bcc%3Dy%23z@shop.test?subject=')).toBe(true);
    // Exactly one query, the subject.
    expect(href.split('?')).toHaveLength(2);
    expect(href).not.toMatch(/[&?](cc|bcc|body)=/i);
  });

  it('refuses anything that is not one plain address', () => {
    for (const value of ['', 'jane', 'jane@', '@partner.dev', 'a b@partner.dev', 'jane@partner.dev\r\nBcc: x@y.z', 'jane@part ner.dev', '"q"@x.io', 'a@b@c.io', '<a@b.io>']) {
      expect(buildAffiliatePartnerMailtoHref(value, subject), JSON.stringify(value)).toBeNull();
    }
  });
});
