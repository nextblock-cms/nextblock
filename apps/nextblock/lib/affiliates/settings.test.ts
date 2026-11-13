import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stored: null as unknown,
  readError: null as { message: string } | null,
  upsertError: null as { message: string } | null,
  upsert: vi.fn(),
  requireCmsAdmin: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  selectedKeys: [] as unknown[],
  /** Every `unstable_cache(fn, keyParts, options)` call (a pass-through here). */
  cacheCalls: [] as Array<{ keyParts: unknown; options: unknown }>,
}));

// The constants contract and the payout-method rules, via vi.importActual (an import() would mark the
// lib lazy-loaded for Nx).
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/payout-methods')),
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: unknown, options: unknown) => {
    mocks.cacheCalls.push({ keyParts, options });
    return fn;
  },
}));

function client() {
  return {
    from: (table: string) => {
      expect(table).toBe('site_settings');
      return {
        select: () => ({
          eq: (_column: string, key: unknown) => {
            mocks.selectedKeys.push(key);
            return {
              maybeSingle: async () => ({
                data: mocks.readError ? null : mocks.stored === null ? null : { value: mocks.stored },
                error: mocks.readError,
              }),
            };
          },
        }),
        upsert: async (row: unknown) => {
          mocks.upsert(row);
          return { error: mocks.upsertError };
        },
      };
    },
  };
}

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

vi.mock('../auth/cms-actor', () => ({
  requireCmsAdmin: mocks.requireCmsAdmin,
}));

import {
  AFFILIATES_SETTINGS_LIMITS,
  defaultAffiliatesSettings,
  getAffiliatesSettings,
  getPublicAffiliatesProgramSettings,
  isAffiliateTermsUrlBuiltIn,
  normalizeAffiliateNotificationEmail,
  normalizeAffiliateTermsUrl,
  normalizeAffiliatesSettings,
  parseAffiliateTermsUrl,
  readAffiliatesSettingsStrict,
  saveAffiliatesSettings,
  toAffiliatesPublicProgramSettings,
} from './settings';

/** What every normalized settings object carries for the terms overrides when none is stored. */
const NO_TERMS = { termsUrlEn: '', termsUrlFr: '' };

/** What every normalized settings object carries for the payout methods when none is stored (02036). */
const STRIPE_PAYOUTS = { payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Not the sandbox unless a case says so, whatever the shell running the tests exports.
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.stored = null;
  mocks.readError = null;
  mocks.upsertError = null;
  mocks.selectedKeys = [];
  mocks.getServiceRoleSupabaseClient.mockImplementation(client);
  mocks.requireCmsAdmin.mockImplementation(async () => ({ supabase: client(), userId: 'admin-1' }));
});

describe('normalizeAffiliatesSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const value of [null, undefined, 'x', 42, [], true]) {
      expect(normalizeAffiliatesSettings(value)).toEqual({
        notificationEmails: [],
        minPayoutCents: 100,
        autoPayoutsEnabled: true,
        termsUrlEn: '',
        termsUrlFr: '',
        ...STRIPE_PAYOUTS,
      });
    }
  });

  it('reads each gateway payout method as stripe_connect unless it is exactly manual (02036) or paypal (02037)', () => {
    expect(normalizeAffiliatesSettings({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } }).payoutMethods).toEqual({
      stripeSales: 'stripe_connect',
      freemiusSales: 'manual',
    });
    expect(normalizeAffiliatesSettings({ payoutMethods: { stripeSales: 'paypal', freemiusSales: 'paypal' } }).payoutMethods).toEqual({
      stripeSales: 'paypal',
      freemiusSales: 'paypal',
    });
    for (const payoutMethods of [undefined, null, 'manual', [], { stripeSales: 'PayPal', freemiusSales: 'Manual' }]) {
      expect(normalizeAffiliatesSettings({ payoutMethods }).payoutMethods, JSON.stringify(payoutMethods)).toEqual(STRIPE_PAYOUTS.payoutMethods);
    }
    // a fresh object every time
    expect(defaultAffiliatesSettings().payoutMethods).not.toBe(defaultAffiliatesSettings().payoutMethods);
  });

  it('keeps at most 10 valid, de-duplicated, lowercased addresses', () => {
    const emails = Array.from({ length: 14 }, (_, i) => ` Admin${i}@Shop.example.org `);
    const result = normalizeAffiliatesSettings({
      notificationEmails: ['ops@shop.dev', 'OPS@shop.dev', 'not-an-email', 42, ...emails],
    });
    expect(result.notificationEmails).toHaveLength(AFFILIATES_SETTINGS_LIMITS.maxNotificationEmails);
    expect(result.notificationEmails[0]).toBe('ops@shop.dev');
    expect(result.notificationEmails[1]).toBe('admin0@shop.example.org');
    expect(new Set(result.notificationEmails).size).toBe(result.notificationEmails.length);
  });

  it('accepts a comma or newline separated string from a textarea', () => {
    expect(
      normalizeAffiliatesSettings({ notificationEmails: 'a@shop.dev, b@shop.dev\nc@shop.dev;;' }).notificationEmails,
    ).toEqual(['a@shop.dev', 'b@shop.dev', 'c@shop.dev']);
  });

  it('refuses addresses that could inject a header or a second recipient', () => {
    for (const hostile of [
      'a@shop.dev\r\nBcc: victim@shop.dev',
      'a@shop.dev, b@shop.dev',
      '"Ops" <ops@shop.dev>',
      'ops@shop',
      '@shop.dev',
      `${'a'.repeat(250)}@shop.dev`,
    ]) {
      expect(normalizeAffiliateNotificationEmail(hostile)).toBeNull();
    }
    expect(normalizeAffiliateNotificationEmail('  Ops+Partners@Shop.Dev ')).toBe('ops+partners@shop.dev');
  });

  it('clamps the minimum payout to 50..1,000,000 minor units and rounds it', () => {
    expect(normalizeAffiliatesSettings({ minPayoutCents: 1 }).minPayoutCents).toBe(50);
    expect(normalizeAffiliatesSettings({ minPayoutCents: 5_000_000 }).minPayoutCents).toBe(1_000_000);
    expect(normalizeAffiliatesSettings({ minPayoutCents: 2500.6 }).minPayoutCents).toBe(2501);
    expect(normalizeAffiliatesSettings({ minPayoutCents: '750' }).minPayoutCents).toBe(750);
    expect(normalizeAffiliatesSettings({ minPayoutCents: 'lots' }).minPayoutCents).toBe(100);
    expect(normalizeAffiliatesSettings({ minPayoutCents: Number.NaN }).minPayoutCents).toBe(100);
    expect(normalizeAffiliatesSettings({ minPayoutCents: '' }).minPayoutCents).toBe(100);
  });

  it('reads the auto-payout switch strictly, defaulting to on', () => {
    expect(normalizeAffiliatesSettings({ autoPayoutsEnabled: false }).autoPayoutsEnabled).toBe(false);
    expect(normalizeAffiliatesSettings({ autoPayoutsEnabled: 'off' }).autoPayoutsEnabled).toBe(false);
    expect(normalizeAffiliatesSettings({ autoPayoutsEnabled: 'true' }).autoPayoutsEnabled).toBe(true);
    expect(normalizeAffiliatesSettings({ autoPayoutsEnabled: 'maybe' }).autoPayoutsEnabled).toBe(true);
    expect(normalizeAffiliatesSettings({}).autoPayoutsEnabled).toBe(true);
  });

  it('drops unknown keys', () => {
    expect(Object.keys(normalizeAffiliatesSettings({ extra: 1, notificationEmails: [] })).sort()).toEqual([
      'autoPayoutsEnabled',
      'minPayoutCents',
      'notificationEmails',
      'payoutMethods',
      'termsUrlEn',
      'termsUrlFr',
    ]);
  });

  it('hands out fresh default objects', () => {
    const first = defaultAffiliatesSettings();
    first.notificationEmails.push('x@shop.dev');
    expect(defaultAffiliatesSettings().notificationEmails).toEqual([]);
  });
});

describe('getAffiliatesSettings', () => {
  it('reads the affiliates_settings row with the service role and normalizes it', async () => {
    mocks.stored = { notificationEmails: ['Ops@Shop.dev'], minPayoutCents: 10, autoPayoutsEnabled: false };
    await expect(getAffiliatesSettings()).resolves.toEqual({
      notificationEmails: ['ops@shop.dev'],
      minPayoutCents: 50,
      autoPayoutsEnabled: false,
      ...NO_TERMS, ...STRIPE_PAYOUTS,
    });
    expect(mocks.selectedKeys).toEqual(['affiliates_settings']);
  });

  it('falls back to the defaults when the row is missing, unreadable or the client throws', async () => {
    await expect(getAffiliatesSettings()).resolves.toEqual(defaultAffiliatesSettings());

    mocks.readError = { message: 'permission denied' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(getAffiliatesSettings()).resolves.toEqual(defaultAffiliatesSettings());

    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
    await expect(getAffiliatesSettings()).resolves.toEqual(defaultAffiliatesSettings());
    warn.mockRestore();
  });
});

describe('readAffiliatesSettingsStrict (the payout runner)', () => {
  it('reads the stored row and normalizes it', async () => {
    mocks.stored = { notificationEmails: [], minPayoutCents: 5000, autoPayoutsEnabled: false };
    await expect(readAffiliatesSettingsStrict()).resolves.toEqual({
      notificationEmails: [],
      minPayoutCents: 5000,
      autoPayoutsEnabled: false,
      ...NO_TERMS, ...STRIPE_PAYOUTS,
    });
    expect(mocks.selectedKeys).toEqual(['affiliates_settings']);
  });

  it('uses the defaults only when no settings were ever saved', async () => {
    await expect(readAffiliatesSettingsStrict()).resolves.toEqual(defaultAffiliatesSettings());
  });

  it('refuses to guess (null) on a read error, a throwing client or a stored value that is not an object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mocks.readError = { message: 'fetch failed' };
    await expect(readAffiliatesSettingsStrict()).resolves.toBeNull();

    mocks.readError = null;
    for (const value of ['x', 42, ['a'], true]) {
      mocks.stored = value;
      await expect(readAffiliatesSettingsStrict()).resolves.toBeNull();
    }

    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
    await expect(readAffiliatesSettingsStrict()).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('saveAffiliatesSettings', () => {
  it('verifies the ADMIN before touching the row', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    await expect(saveAffiliatesSettings({ minPayoutCents: 500 })).rejects.toThrow('Forbidden');
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('merges a partial update over the stored row, normalizes and returns it', async () => {
    mocks.stored = { notificationEmails: ['ops@shop.dev'], minPayoutCents: 2000, autoPayoutsEnabled: true };

    await expect(saveAffiliatesSettings({ autoPayoutsEnabled: false, minPayoutCents: undefined })).resolves.toEqual({
      notificationEmails: ['ops@shop.dev'],
      minPayoutCents: 2000,
      autoPayoutsEnabled: false,
      ...NO_TERMS, ...STRIPE_PAYOUTS,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      key: 'affiliates_settings',
      value: { notificationEmails: ['ops@shop.dev'], minPayoutCents: 2000, autoPayoutsEnabled: false, ...NO_TERMS, ...STRIPE_PAYOUTS },
    });
  });

  it('never stores an out-of-range or malformed value', async () => {
    await saveAffiliatesSettings({
      notificationEmails: ['bad', 'Good@Shop.dev'],
      minPayoutCents: -5,
    } as never);
    expect(mocks.upsert).toHaveBeenCalledWith({
      key: 'affiliates_settings',
      value: { notificationEmails: ['good@shop.dev'], minPayoutCents: 50, autoPayoutsEnabled: true, ...NO_TERMS, ...STRIPE_PAYOUTS },
    });
  });

  it('stores the terms pages it is given and keeps the stored ones when they are omitted', async () => {
    mocks.stored = { notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true, termsUrlEn: '/legal/partners', termsUrlFr: '' };
    await saveAffiliatesSettings({ termsUrlFr: 'https://legal.example.com/fr' });
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      key: 'affiliates_settings',
      value: {
        notificationEmails: [],
        minPayoutCents: 500,
        autoPayoutsEnabled: true,
        termsUrlEn: '/legal/partners',
        termsUrlFr: 'https://legal.example.com/fr',
        ...STRIPE_PAYOUTS,
      },
    });
  });

  it('stores the payout methods it is given and keeps the stored ones when they are omitted (02036)', async () => {
    mocks.stored = { notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true };
    await saveAffiliatesSettings({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } });
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      key: 'affiliates_settings',
      value: expect.objectContaining({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } }),
    });

    mocks.stored = { notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } };
    await saveAffiliatesSettings({ minPayoutCents: 700 });
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      key: 'affiliates_settings',
      value: expect.objectContaining({ minPayoutCents: 700, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } }),
    });
  });

  it('stores no terms page on the public sandbox, whatever it is given', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.stored = { notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true, termsUrlEn: 'https://evil.example' };
    await saveAffiliatesSettings({ termsUrlEn: 'https://evil.example/terms', termsUrlFr: '/x' });
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      key: 'affiliates_settings',
      value: { notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true, ...NO_TERMS, ...STRIPE_PAYOUTS },
    });
  });

  it('throws a generic error when the write fails', async () => {
    mocks.upsertError = { message: 'new row violates row-level security policy' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(saveAffiliatesSettings({ minPayoutCents: 500 })).rejects.toThrow('Failed to save affiliate settings.');
    error.mockRestore();
  });
});

describe('partner terms overrides (termsUrlEn / termsUrlFr)', () => {
  it('accepts empty, a site path with one leading slash, or an https URL, trimmed', () => {
    expect(parseAffiliateTermsUrl('')).toBe('');
    expect(parseAffiliateTermsUrl('   ')).toBe('');
    expect(parseAffiliateTermsUrl(undefined)).toBe('');
    expect(parseAffiliateTermsUrl(null)).toBe('');
    expect(parseAffiliateTermsUrl(' /legal/partner-terms ')).toBe('/legal/partner-terms');
    expect(parseAffiliateTermsUrl('/legal/terms?lang=fr#payouts')).toBe('/legal/terms?lang=fr#payouts');
    expect(parseAffiliateTermsUrl('https://legal.example.com/partners')).toBe('https://legal.example.com/partners');
    expect(parseAffiliateTermsUrl(`/${'a'.repeat(AFFILIATES_SETTINGS_LIMITS.maxTermsUrlLength - 1)}`)).toHaveLength(2048);
  });

  it('stores the canonical form a browser requests: percent-encoded ASCII, fit for a Location header', () => {
    // A pasted typographic apostrophe or accent would otherwise reach redirect() raw: Node refuses a
    // header character above U+00FF (every request a 500) and sends Latin-1 as raw bytes.
    expect(parseAffiliateTermsUrl('/conditions’partenaires')).toBe('/conditions%E2%80%99partenaires');
    expect(parseAffiliateTermsUrl('/café?x=é#é')).toBe('/caf%C3%A9?x=%C3%A9#%C3%A9');
    expect(parseAffiliateTermsUrl('/caf%C3%A9')).toBe('/caf%C3%A9');
    // https: lowercase scheme and host, punycode, default port dropped, dot segments resolved.
    expect(parseAffiliateTermsUrl('HTTPS://Legal.Example.com')).toBe('https://legal.example.com/');
    expect(parseAffiliateTermsUrl('https://Légal.example.com/conditions’')).toBe('https://xn--lgal-bpa.example.com/conditions%E2%80%99');
    expect(parseAffiliateTermsUrl('https://legal.example.com:443/a/../terms')).toBe('https://legal.example.com/terms');
    // Too long once encoded.
    expect(parseAffiliateTermsUrl(`/${'é'.repeat(400)}`)).toBeNull();

    // A stored value parses to itself, so every read normalizes it to the same string.
    for (const value of ['/legal/partner-terms', '/legal/terms?lang=fr#payouts', '/conditions’partenaires', 'HTTPS://Légal.Example.com:443/x?y=é']) {
      const stored = parseAffiliateTermsUrl(value);
      expect(stored, value).not.toBeNull();
      expect(parseAffiliateTermsUrl(stored), value).toBe(stored);
      expect(stored, value).toMatch(/^[\x21-\x7e]+$/);
    }
  });

  it('refuses everything else: other schemes, protocol-relative and backslash paths, whitespace, control characters, credentials, length', () => {
    for (const value of [
      'http://legal.example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'mailto:legal@example.com',
      '//evil.example/terms',
      '/\\evil.example',
      '\\\\evil.example',
      'legal/terms',
      'legal.example.com/terms',
      '/legal terms',
      '/legal\tterms',
      '/legal\u0000terms',
      '/legal\u0085terms',
      'https://user:secret@legal.example.com',
      'https://legal.example.com@evil.example',
      'https:///nohost',
      'https:/evil.example',
      `/${'a'.repeat(AFFILIATES_SETTINGS_LIMITS.maxTermsUrlLength)}`,
      42,
      ['/legal'],
      { url: '/legal' },
    ]) {
      expect(parseAffiliateTermsUrl(value), String(value)).toBeNull();
    }
  });

  it('refuses a site path a server or browser would rewrite into another address: empty, . or .. segments, encoded slashes', () => {
    for (const value of [
      // Each of these reaches /partners/terms (a redirect loop) or another page than the one typed.
      '/partners//terms',
      '/legal//partner-terms',
      '/legal/terms//',
      '/partners/./terms',
      '/partners/terms/.',
      '/partenaires/../partners/terms',
      '/legal/..',
      '/legal/%2e/terms',
      '/legal/%2E%2e/terms',
      '/legal/.%2e/terms',
      '/legal%2fterms',
      '/legal%5Cterms',
      '/%2f/evil.example',
    ]) {
      expect(parseAffiliateTermsUrl(value), value).toBeNull();
    }
    // Dots inside a segment are ordinary characters.
    expect(parseAffiliateTermsUrl('/legal/partner-terms.html')).toBe('/legal/partner-terms.html');
    expect(parseAffiliateTermsUrl('/legal/.well-known/terms')).toBe('/legal/.well-known/terms');
    expect(parseAffiliateTermsUrl('/legal/terms/')).toBe('/legal/terms/');
  });

  it("reads an https URL on the site's own host that names the built-in terms as the built-in terms (save, route and sitemap agree)", () => {
    vi.stubEnv('NEXT_PUBLIC_URL', 'https://shop.example.com');
    for (const own of [
      'https://shop.example.com/partners/terms',
      'https://www.shop.example.com/partenaires/conditions',
      'https://shop.example.com/partners//terms',
      'https://SHOP.example.com/partners/%74erms?x=1',
    ]) {
      expect(isAffiliateTermsUrlBuiltIn(parseAffiliateTermsUrl(own) as string), own).toBe(true);
      expect(normalizeAffiliateTermsUrl(own), own).toBe('');
    }
    // Another site's page at the same path is a real page of its own.
    expect(normalizeAffiliateTermsUrl('https://other.example.org/partners/terms')).toBe('https://other.example.org/partners/terms');
    expect(normalizeAffiliateTermsUrl('https://shop.example.com/legal/partner-terms')).toBe('https://shop.example.com/legal/partner-terms');
    expect(isAffiliateTermsUrlBuiltIn('')).toBe(false);
  });

  it('reads a refused value, or a built-in terms address, as the built-in terms', () => {
    expect(normalizeAffiliateTermsUrl('javascript:alert(1)')).toBe('');
    expect(normalizeAffiliateTermsUrl('//evil.example')).toBe('');
    for (const builtIn of [
      '/partners/terms',
      '/partners/terms/',
      '/partenaires/conditions',
      '/Partenaires/Conditions?x=1',
      // Stored before the segment rule (or written another way): still never a redirect target.
      '/partners//terms',
      '/partners/./terms',
      '/partenaires/../partners/terms',
      '/partners/terms/.',
      '/partners/%74erms',
    ]) {
      expect(normalizeAffiliateTermsUrl(builtIn), builtIn).toBe('');
    }
    expect(normalizeAffiliateTermsUrl('/partners/terms-and-more')).toBe('/partners/terms-and-more');
    // A raw value stored before the canonical form reads as its encoded form (no 500 on the redirect).
    expect(normalizeAffiliateTermsUrl('/conditions’partenaires')).toBe('/conditions%E2%80%99partenaires');
    expect(
      normalizeAffiliatesSettings({ termsUrlEn: ' /legal/partners ', termsUrlFr: 'https://legal.example.com/fr', extra: 'x' }),
    ).toMatchObject({ termsUrlEn: '/legal/partners', termsUrlFr: 'https://legal.example.com/fr' });
    expect(normalizeAffiliatesSettings({ termsUrlEn: 'http://legal.example.com', termsUrlFr: 7 })).toMatchObject(NO_TERMS);
  });

  it('drops every override on the public sandbox, on every read (only the exact value "true" is the sandbox)', async () => {
    const stored = { notificationEmails: ['ops@shop.dev'], minPayoutCents: 500, autoPayoutsEnabled: true, termsUrlEn: '/legal/partners', termsUrlFr: 'https://legal.example.com/fr' };

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(normalizeAffiliateTermsUrl('/legal/partners')).toBe('');
    expect(normalizeAffiliatesSettings(stored)).toMatchObject(NO_TERMS);
    mocks.stored = stored;
    await expect(readAffiliatesSettingsStrict()).resolves.toMatchObject(NO_TERMS);
    await expect(getAffiliatesSettings()).resolves.toMatchObject(NO_TERMS);
    await expect(getPublicAffiliatesProgramSettings()).resolves.toEqual({ minPayoutCents: 500, autoPayoutsEnabled: true, ...NO_TERMS, ...STRIPE_PAYOUTS });

    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      expect(normalizeAffiliatesSettings(stored), value).toMatchObject({
        termsUrlEn: '/legal/partners',
        termsUrlFr: 'https://legal.example.com/fr',
      });
    }
  });
});

describe('getPublicAffiliatesProgramSettings (the public partner pages)', () => {
  it('projects the row: the terms pages, the minimum, the payout switch and methods, never the notification addresses', async () => {
    mocks.stored = {
      notificationEmails: ['ops@shop.dev', 'finance@shop.dev'],
      minPayoutCents: 2500,
      autoPayoutsEnabled: false,
      termsUrlEn: '/legal/partners',
      termsUrlFr: '',
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    };
    const settings = await getPublicAffiliatesProgramSettings();
    expect(settings).toEqual({
      termsUrlEn: '/legal/partners',
      termsUrlFr: '',
      minPayoutCents: 2500,
      autoPayoutsEnabled: false,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    expect(JSON.stringify(settings)).not.toContain('shop.dev');
    expect(mocks.selectedKeys).toEqual(['affiliates_settings']);
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalled();
  });

  it('is one cross-request cached read, tagged for eviction', async () => {
    mocks.stored = null;
    await getPublicAffiliatesProgramSettings();
    await getPublicAffiliatesProgramSettings();
    // Built once, on first use.
    expect(mocks.cacheCalls.length).toBeLessThanOrEqual(1);
    const [call] = mocks.cacheCalls;
    if (call) {
      expect(call.keyParts).toEqual(['affiliates-public-program-settings']);
      expect(call.options).toEqual({ revalidate: 300, tags: ['public-affiliate-program-settings'] });
    }
  });

  it('answers the defaults when no row was ever saved, and null when the settings cannot be read', async () => {
    await expect(getPublicAffiliatesProgramSettings()).resolves.toEqual(toAffiliatesPublicProgramSettings(defaultAffiliatesSettings()));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.readError = { message: 'permission denied' };
    await expect(getPublicAffiliatesProgramSettings()).resolves.toBeNull();

    mocks.readError = null;
    mocks.stored = 'not an object';
    await expect(getPublicAffiliatesProgramSettings()).resolves.toBeNull();

    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
    await expect(getPublicAffiliatesProgramSettings()).resolves.toBeNull();
    warn.mockRestore();
  });
});
