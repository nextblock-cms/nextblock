import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public partner readers: anon client only, cached per handle under the storefront tag, never
 * a cached error, never a malformed handle sent to the database, and the approved snapshot
 * normalized (a key that is not a server-built avatar key, a link that is not https on the right
 * host, an id that is not a uuid — all dropped).
 */

const AFFILIATE_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Result = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  cacheEntries: [] as Array<{ keyParts: unknown; options: { revalidate?: number; tags?: string[] } | undefined }>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Result | (() => Result)>,
  tableResults: {} as Record<string, Result>,
  tableFilters: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: unknown, options?: { revalidate?: number; tags?: string[] }) => {
    mocks.cacheEntries.push({ keyParts, options });
    return fn;
  },
}));

function tableBuilder(table: string) {
  const record = { table, calls: [] as Array<[string, unknown[]]> };
  mocks.tableFilters.push(record);
  const result = () => mocks.tableResults[table] ?? { data: null, error: { message: `no fixture for ${table}` } };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'in', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      record.calls.push([method, args]);
      return builder;
    };
  }
  builder['maybeSingle'] = async () => result();
  builder['then'] = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return builder;
}

vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      mocks.rpcCalls.push({ fn, args });
      const fixture = mocks.rpcResults[fn];
      if (!fixture) return { data: null, error: { message: `no fixture for ${fn}` } };
      return typeof fixture === 'function' ? fixture() : fixture;
    },
    from: (table: string) => tableBuilder(table),
  }),
}));

vi.mock('@nextblock-cms/affiliates/server', () => vi.importActual('../../../../libs/affiliates/src/lib/repository'));
vi.mock('../../app/lib/site-settings', () => ({ SITE_SETTINGS_CACHE_TAG: 'public-site-settings' }));

import {
  AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS,
  getAffiliateStoreBaseCurrency,
  getPartnersBotProtectionPublic,
  getPublicAffiliateTiers,
  getPublishedAffiliateStorefront,
  listPublishedAffiliateStorefronts,
  normalizeAffiliateAvatarObjectKey,
  normalizeAffiliatePublicStorefront,
} from './storefront-data';

const STOREFRONT_ROW = {
  affiliate_id: AFFILIATE_ID,
  handle: 'jane-picks',
  tier_name: 'Founding Ambassador',
  tier_name_translations: { fr: 'Ambassadeur fondateur', es: '' },
  tier_badge_color: 'amber',
  tier_is_limited_time_promo: true,
  published_profile: {
    display_name: '  Jane Doe  ',
    bio: 'I review kitchen tools.',
    avatar_object_key: 'affiliates/avatars/jane.png',
    social_links: { instagram: 'https://www.instagram.com/jane', website: 'javascript:alert(1)', myspace: 'https://myspace.com/x' },
  },
  published_title: "Jane's picks",
  published_meta_description: 'Kitchen tools I use every day.',
  published_content: { type: 'doc', content: [{ type: 'paragraph' }] },
  published_featured_product_ids: [PRODUCT_A, 'not-a-uuid', PRODUCT_A.toUpperCase(), PRODUCT_B],
  published_at: '2026-10-20T10:00:00.000Z',
  updated_at: '2026-10-21T10:00:00.000Z',
};

beforeEach(() => {
  mocks.rpcCalls = [];
  mocks.rpcResults = {};
  mocks.tableResults = {};
  mocks.tableFilters = [];
});

describe('cache wiring', () => {
  it('caches every public read for five minutes, the storefront reads under the storefront tag', () => {
    const byKey = new Map(mocks.cacheEntries.map((entry) => [JSON.stringify(entry.keyParts), entry.options]));
    expect(AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS).toBe(300);
    expect(byKey.get('["affiliates-public-storefront"]')).toEqual({ revalidate: 300, tags: ['public-affiliate-storefronts'] });
    expect(byKey.get('["affiliates-public-storefront-list"]')).toEqual({ revalidate: 300, tags: ['public-affiliate-storefronts'] });
    expect(byKey.get('["affiliates-public-tiers"]')).toEqual({ revalidate: 300, tags: ['public-affiliate-tiers'] });
    expect(byKey.get('["affiliates-public-bot-protection"]')).toEqual({ revalidate: 300, tags: ['public-site-settings'] });
  });
});

describe('getPublishedAffiliateStorefront', () => {
  it('never sends a malformed or reserved handle to the database', async () => {
    await expect(getPublishedAffiliateStorefront('a')).resolves.toBeNull();
    await expect(getPublishedAffiliateStorefront('partners')).resolves.toBeNull();
    await expect(getPublishedAffiliateStorefront('x'.repeat(300))).resolves.toBeNull();
    expect(mocks.rpcCalls).toEqual([]);
  });

  it('reads the approved snapshot through the anon RPC with the canonical handle', async () => {
    mocks.rpcResults['get_affiliate_storefront'] = { data: [STOREFRONT_ROW], error: null };
    const storefront = await getPublishedAffiliateStorefront('  Jane-Picks ');

    expect(mocks.rpcCalls).toEqual([{ fn: 'get_affiliate_storefront', args: { p_handle: 'jane-picks' } }]);
    expect(storefront).toEqual({
      affiliateId: AFFILIATE_ID,
      handle: 'jane-picks',
      tier: {
        name: 'Founding Ambassador',
        nameTranslations: { fr: 'Ambassadeur fondateur' },
        badgeColor: 'amber',
        isLimitedTimePromo: true,
      },
      profile: {
        display_name: 'Jane Doe',
        bio: 'I review kitchen tools.',
        avatar_object_key: 'affiliates/avatars/jane.png',
        social_links: { instagram: 'https://www.instagram.com/jane' },
      },
      title: "Jane's picks",
      metaDescription: 'Kitchen tools I use every day.',
      content: STOREFRONT_ROW.published_content,
      featuredProductIds: [PRODUCT_A, PRODUCT_B],
      publishedAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
    });
  });

  it('answers null when nothing is published and throws a generic error on a database failure', async () => {
    mocks.rpcResults['get_affiliate_storefront'] = { data: [], error: null };
    await expect(getPublishedAffiliateStorefront('jane-picks')).resolves.toBeNull();

    mocks.rpcResults['get_affiliate_storefront'] = { data: null, error: { message: 'permission denied for table affiliate_pages' } };
    await expect(getPublishedAffiliateStorefront('jane-picks')).rejects.toThrow('AffiliateStorefrontReadFailed');
  });
});

describe('normalizeAffiliatePublicStorefront', () => {
  it('drops rows without an id or a valid handle, and unknown badge colours fall back', () => {
    expect(normalizeAffiliatePublicStorefront(null)).toBeNull();
    expect(normalizeAffiliatePublicStorefront({ ...STOREFRONT_ROW, affiliate_id: 7 })).toBeNull();
    expect(normalizeAffiliatePublicStorefront({ ...STOREFRONT_ROW, handle: 'Not Valid!' })).toBeNull();
    expect(normalizeAffiliatePublicStorefront({ ...STOREFRONT_ROW, tier_badge_color: 'url(javascript:x)' })?.tier.badgeColor).toBe('violet');
  });

  it('falls back to the handle when the snapshot has no display name', () => {
    expect(normalizeAffiliatePublicStorefront({ ...STOREFRONT_ROW, published_profile: null })?.profile).toEqual({
      display_name: 'jane-picks',
      bio: null,
      avatar_object_key: null,
      social_links: {},
    });
  });

  it("keeps the snapshot's language only when it is en or fr", () => {
    const withLocale = (locale: unknown) =>
      normalizeAffiliatePublicStorefront({ ...STOREFRONT_ROW, published_profile: { display_name: 'Jane', locale } })?.profile;
    expect(withLocale('fr')?.locale).toBe('fr');
    expect(withLocale('en')?.locale).toBe('en');
    for (const locale of ['de', 'FR', '', 7, null, undefined, { fr: true }]) {
      expect(withLocale(locale)).not.toHaveProperty('locale');
    }
  });
});

describe('normalizeAffiliateAvatarObjectKey', () => {
  it('keeps server-built keys only', () => {
    expect(normalizeAffiliateAvatarObjectKey('affiliates/avatars/a1.webp')).toBe('affiliates/avatars/a1.webp');
    expect(normalizeAffiliateAvatarObjectKey('images/NBcover.webp')).toBe('images/NBcover.webp');
    for (const value of [
      'https://evil.example/a.png',
      '//evil.example/a.png',
      'affiliates/avatars/../../secrets.png',
      'affiliates/avatars//a.png',
      'other/a.png',
      `affiliates/avatars/${'a'.repeat(600)}.png`,
      42,
      null,
    ]) {
      expect(normalizeAffiliateAvatarObjectKey(value), String(value)).toBeNull();
    }
  });
});

describe('listPublishedAffiliateStorefronts', () => {
  it('asks for at most 5000 rows and keeps valid, distinct handles', async () => {
    mocks.rpcResults['list_affiliate_storefronts'] = {
      data: [
        { handle: 'jane-picks', published_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-21T10:00:00.000Z' },
        { handle: 'jane-picks', published_at: null, updated_at: null },
        { handle: 'Bad Handle', published_at: null, updated_at: null },
        { handle: 'max-gear', published_at: null, updated_at: 'not a date' },
      ],
      error: null,
    };

    await expect(listPublishedAffiliateStorefronts()).resolves.toEqual([
      { handle: 'jane-picks', publishedAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' },
      { handle: 'max-gear', publishedAt: null, updatedAt: null },
    ]);
    expect(mocks.rpcCalls).toEqual([{ fn: 'list_affiliate_storefronts', args: { p_limit: 5000 } }]);
  });

  it('throws on a database failure (the sitemap omits the section)', async () => {
    mocks.rpcResults['list_affiliate_storefronts'] = { data: null, error: { message: 'boom' } };
    await expect(listPublishedAffiliateStorefronts()).rejects.toThrow('AffiliateStorefrontListReadFailed');
  });
});

describe('getPublicAffiliateTiers', () => {
  it('reads active tiers in order through the anon client', async () => {
    mocks.tableResults['affiliate_tiers'] = {
      data: [
        { id: 't1', name: 'Starter Partner', slug: 'starter-partner', commission_percentage: '10.00', sort_order: 1, is_active: true },
        { id: 't9', name: 'Hidden', slug: 'hidden', commission_percentage: '90.00', sort_order: 9, is_active: false },
      ],
      error: null,
    };

    const tiers = await getPublicAffiliateTiers();
    expect(tiers.map((tier) => [tier.id, tier.commission_percentage])).toEqual([['t1', 10]]);
    const query = mocks.tableFilters.find((entry) => entry.table === 'affiliate_tiers');
    expect(query?.calls).toContainEqual(['eq', ['is_active', true]]);
    expect(query?.calls).toContainEqual(['order', ['sort_order', { ascending: true }]]);
  });

  it('never throws: an unreadable table means no tiers', async () => {
    mocks.tableResults['affiliate_tiers'] = { data: null, error: { message: 'relation does not exist' } };
    await expect(getPublicAffiliateTiers()).resolves.toEqual([]);
  });
});

describe('getAffiliateStoreBaseCurrency', () => {
  it('reads the default active currency and falls back to USD', async () => {
    mocks.tableResults['currencies'] = { data: { code: 'cad' }, error: null };
    await expect(getAffiliateStoreBaseCurrency()).resolves.toBe('CAD');

    mocks.tableResults['currencies'] = { data: { code: 'dollars' }, error: null };
    await expect(getAffiliateStoreBaseCurrency()).resolves.toBe('USD');

    mocks.tableResults['currencies'] = { data: null, error: { message: 'boom' } };
    await expect(getAffiliateStoreBaseCurrency()).resolves.toBe('USD');
  });
});

describe('getPartnersBotProtectionPublic', () => {
  it('reads only the public provider and site key', async () => {
    mocks.tableResults['site_settings'] = { data: { value: { provider: 'turnstile', siteKey: ' 0x4AAA ', secretKey: 'never' } }, error: null };
    await expect(getPartnersBotProtectionPublic()).resolves.toEqual({ provider: 'turnstile', siteKey: '0x4AAA' });

    mocks.tableResults['site_settings'] = { data: { value: { provider: 'hcaptcha' } }, error: null };
    await expect(getPartnersBotProtectionPublic()).resolves.toEqual({ provider: 'none', siteKey: '' });

    mocks.tableResults['site_settings'] = { data: null, error: { message: 'boom' } };
    await expect(getPartnersBotProtectionPublic()).resolves.toEqual({ provider: 'none', siteKey: '' });
  });
});
