import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  AFFILIATE_DEFAULT_COOKIE_DAYS,
  AFFILIATE_HANDLE_PATTERN,
  AFFILIATE_REF_COOKIE,
  RESERVED_AFFILIATE_HANDLES,
  normalizeAffiliateHandle,
} from '@nextblock-cms/affiliates';

import { CONSENT_COOKIE_NAME } from '../privacy/types';
import {
  AFFILIATE_REFERRAL_CACHE_CONTROL,
  AFFILIATE_REFERRAL_CONSENT_COOKIE,
  AFFILIATE_REFERRAL_COOKIE,
  AFFILIATE_REFERRAL_FALLBACK_DAYS,
  AFFILIATE_REFERRAL_HANDLE_PATTERN,
  AFFILIATE_REFERRAL_RESERVED_HANDLES,
  AFFILIATE_REFERRAL_WINDOW_CACHE_DEFAULTS,
  applyAffiliateReferralCookie,
  buildAffiliateReferralCookie,
  buildAffiliateVisitorHashInput,
  computeAffiliateVisitorHash,
  createAffiliateReferralWindowCache,
  decideAffiliateReferral,
  expireAffiliateReferralCookie,
  hasDeclinedAffiliateMarketingConsent,
  maskAffiliateVisitorIp,
  normalizeAffiliateReferralHandle,
  normalizeAffiliateReferralWindowDays,
  readAffiliateVisitorIp,
  shouldWithdrawAffiliateReferral,
  type AffiliateReferralRequest,
} from './referral-cookie';

const MODULE_PATH = fileURLToPath(new URL('./referral-cookie.ts', import.meta.url));

function headers(values: Record<string, string> = {}) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function cookies(values: Record<string, string> = {}) {
  return { get: (name: string) => (name in values ? { value: values[name] } : undefined) };
}

const DOCUMENT = { 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml' };

function request(overrides: Partial<Omit<AffiliateReferralRequest, 'headers' | 'cookies'>> & {
  url?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
} = {}): AffiliateReferralRequest {
  const url = new URL(overrides.url ?? '/partners/jane', 'https://shop.example');
  return {
    method: overrides.method ?? 'GET',
    pathname: overrides.pathname ?? url.pathname,
    searchParams: overrides.searchParams ?? url.searchParams,
    headers: headers(overrides.headers ?? DOCUMENT),
    cookies: cookies(overrides.cookies ?? {}),
    isBot: overrides.isBot ?? false,
  };
}

describe('referral-cookie.ts stays dependency-free', () => {
  it('imports nothing at all (the proxy loads it on every request)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    const file = ts.createSourceFile(MODULE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) imports.push(node.getText(file));
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) imports.push(node.getText(file));
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
          imports.push(node.getText(file));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(imports).toEqual([]);
  });
});

describe('parity with @nextblock-cms/affiliates and lib/privacy', () => {
  it('mirrors the cookie name, the fallback window and the consent cookie name', () => {
    expect(AFFILIATE_REFERRAL_COOKIE).toBe(AFFILIATE_REF_COOKIE);
    expect(AFFILIATE_REFERRAL_FALLBACK_DAYS).toBe(AFFILIATE_DEFAULT_COOKIE_DAYS);
    expect(AFFILIATE_REFERRAL_CONSENT_COOKIE).toBe(CONSENT_COOKIE_NAME);
  });

  it('mirrors the handle pattern and the reserved list exactly', () => {
    expect(AFFILIATE_REFERRAL_HANDLE_PATTERN.source).toBe(AFFILIATE_HANDLE_PATTERN.source);
    expect(AFFILIATE_REFERRAL_HANDLE_PATTERN.flags).toBe(AFFILIATE_HANDLE_PATTERN.flags);
    expect([...AFFILIATE_REFERRAL_RESERVED_HANDLES].sort()).toEqual([...RESERVED_AFFILIATE_HANDLES].sort());
  });

  it('normalizes handles exactly like normalizeAffiliateHandle', () => {
    const corpus: unknown[] = [
      'jane',
      'Jane',
      '  JANE-DOE  ',
      'ab',
      'abc',
      'a'.repeat(32),
      'a'.repeat(33),
      '-jane',
      'jane-',
      'ja--ne',
      'jane_doe',
      'jäne',
      'jane doe',
      'jane/doe',
      '',
      '   ',
      `${' '.repeat(200)}jane`,
      'x'.repeat(300),
      ...RESERVED_AFFILIATE_HANDLES,
      ...RESERVED_AFFILIATE_HANDLES.map((handle) => handle.toUpperCase()),
      null,
      undefined,
      42,
      { handle: 'jane' },
    ];
    for (const value of corpus) {
      expect(normalizeAffiliateReferralHandle(value), JSON.stringify(value)).toBe(normalizeAffiliateHandle(value));
    }
  });
});

describe('decideAffiliateReferral', () => {
  it('takes the handle of a storefront document navigation, as a new click', () => {
    expect(decideAffiliateReferral(request({ url: '/partners/jane' }))).toEqual({ handle: 'jane', isNewClick: true });
    expect(decideAffiliateReferral(request({ url: '/partners/jane/' }))).toEqual({ handle: 'jane', isNewClick: true });
  });

  it('takes ?ref=<handle> on any public page, normalized', () => {
    expect(decideAffiliateReferral(request({ url: '/?ref=jane' }))).toEqual({ handle: 'jane', isNewClick: true });
    expect(decideAffiliateReferral(request({ url: '/product/mug?ref=%20Jane-Doe%20' }))).toEqual({
      handle: 'jane-doe',
      isNewClick: true,
    });
    expect(decideAffiliateReferral(request({ url: '/partners?ref=jane' }))?.handle).toBe('jane');
  });

  it('prefers the storefront in the path over a ?ref on it', () => {
    expect(decideAffiliateReferral(request({ url: '/partners/jane?ref=bob' }))?.handle).toBe('jane');
    // A reserved segment is not a storefront, so its ?ref still counts.
    expect(decideAffiliateReferral(request({ url: '/partners/apply?ref=bob' }))?.handle).toBe('bob');
  });

  it('never reads the partner terms page as a storefront (the handles terms and conditions are reserved)', () => {
    expect(decideAffiliateReferral(request({ url: '/partners/terms' }))).toBeNull();
    expect(decideAffiliateReferral(request({ url: '/partenaires/conditions' }))).toBeNull();
    expect(decideAffiliateReferral(request({ url: '/partners/terms?ref=bob' }))?.handle).toBe('bob');
    expect(decideAffiliateReferral(request({ url: '/about?ref=conditions' }))).toBeNull();
  });

  it('never matches below a storefront (OG images, nested routes)', () => {
    for (const url of ['/partners/jane/opengraph-image', '/partners/jane/twitter-image', '/partners/jane/x', '/partners/Jane']) {
      expect(decideAffiliateReferral(request({ url })), url).toBeNull();
    }
  });

  it('ignores ?ref under /cms, /api, /portal and /_next (whole segments only)', () => {
    for (const url of ['/cms?ref=jane', '/cms/pages?ref=jane', '/api/checkout?ref=jane', '/portal/retailer?ref=jane', '/_next/data?ref=jane']) {
      expect(decideAffiliateReferral(request({ url })), url).toBeNull();
    }
    expect(decideAffiliateReferral(request({ url: '/cms-guide?ref=jane' }))?.handle).toBe('jane');
    expect(decideAffiliateReferral(request({ url: '/portals?ref=jane' }))?.handle).toBe('jane');
  });

  it('refuses invalid and reserved handles', () => {
    for (const url of ['/?ref=', '/?ref=a', '/?ref=admin', '/?ref=PARTNERS', '/?ref=-x-', `/?ref=${'a'.repeat(40)}`, '/partners/cms', '/partners/-bad']) {
      expect(decideAffiliateReferral(request({ url })), url).toBeNull();
    }
  });

  it('acts only on GET document navigations', () => {
    expect(decideAffiliateReferral(request({ method: 'POST' }))).toBeNull();
    expect(decideAffiliateReferral(request({ method: 'HEAD' }))).toBeNull();
    expect(decideAffiliateReferral(request({ method: 'get' }))?.handle).toBe('jane');
    // Fetches, images and iframes are not documents.
    for (const dest of ['empty', 'image', 'iframe', 'script']) {
      expect(decideAffiliateReferral(request({ headers: { 'sec-fetch-dest': dest, accept: 'text/html' } })), dest).toBeNull();
    }
    // Next client-side navigations and router prefetches are RSC fetches.
    expect(decideAffiliateReferral(request({ headers: { ...DOCUMENT, rsc: '1' } }))).toBeNull();
    expect(decideAffiliateReferral(request({ headers: { ...DOCUMENT, 'next-router-prefetch': '1' } }))).toBeNull();
    // An older browser without Sec-Fetch-Dest qualifies through Accept.
    expect(decideAffiliateReferral(request({ headers: { accept: 'text/html' } }))?.handle).toBe('jane');
    expect(decideAffiliateReferral(request({ headers: { accept: 'application/json' } }))).toBeNull();
    expect(decideAffiliateReferral(request({ headers: {} }))).toBeNull();
  });

  it('skips prefetches and prerenders', () => {
    for (const [name, value] of [
      ['sec-purpose', 'prefetch'],
      ['sec-purpose', 'prefetch;prerender'],
      ['purpose', 'prefetch'],
      ['Purpose', 'Prefetch'],
      ['x-purpose', 'preview'],
      ['x-moz', 'prefetch'],
    ]) {
      expect(decideAffiliateReferral(request({ headers: { ...DOCUMENT, [name]: value } })), `${name}: ${value}`).toBeNull();
    }
  });

  it('skips bots, and only asks the bot check once a handle was found', () => {
    expect(decideAffiliateReferral(request({ isBot: true }))).toBeNull();

    const isBot = vi.fn(() => false);
    expect(decideAffiliateReferral(request({ url: '/about', isBot }))).toBeNull();
    expect(isBot).not.toHaveBeenCalled();
    expect(decideAffiliateReferral(request({ url: '/about?ref=jane', isBot }))?.handle).toBe('jane');
    expect(isBot).toHaveBeenCalledTimes(1);
  });

  it('respects a declined marketing consent, in the encoded and the decoded spelling', () => {
    const declined = JSON.stringify({ necessary: true, analytics: true, marketing: false, token: 't', ts: 1 });
    const accepted = JSON.stringify({ necessary: true, analytics: false, marketing: true, token: 't', ts: 1 });
    expect(decideAffiliateReferral(request({ cookies: { nb_consent_preference: declined } }))).toBeNull();
    expect(decideAffiliateReferral(request({ cookies: { nb_consent_preference: encodeURIComponent(declined) } }))).toBeNull();
    expect(decideAffiliateReferral(request({ cookies: { nb_consent_preference: accepted } }))?.handle).toBe('jane');
    expect(decideAffiliateReferral(request({ cookies: { nb_consent_preference: 'not json' } }))?.handle).toBe('jane');
  });

  it('marks a repeat visit through the same partner as no new click, and a new partner as one', () => {
    expect(decideAffiliateReferral(request({ cookies: { nb_affiliate_ref: 'jane' } }))).toEqual({ handle: 'jane', isNewClick: false });
    expect(decideAffiliateReferral(request({ cookies: { nb_affiliate_ref: 'bob' } }))).toEqual({ handle: 'jane', isNewClick: true });
    expect(decideAffiliateReferral(request({ cookies: { nb_affiliate_ref: 'garbage value' } }))).toEqual({ handle: 'jane', isNewClick: true });
  });

  it('never throws, whatever the request object does', () => {
    const hostile = {
      ...request(),
      headers: { get: () => { throw new Error('boom'); } },
    } as AffiliateReferralRequest;
    expect(decideAffiliateReferral(hostile)).toBeNull();
    const throwingBot = request({ isBot: () => { throw new Error('ua parser'); } });
    expect(decideAffiliateReferral(throwingBot)).toBeNull();
    expect(decideAffiliateReferral({} as AffiliateReferralRequest)).toBeNull();
  });
});

describe('shouldWithdrawAffiliateReferral / expireAffiliateReferralCookie', () => {
  const declined = encodeURIComponent(JSON.stringify({ necessary: true, analytics: true, marketing: false }));

  it('withdraws a referral cookie once marketing consent is declined', () => {
    expect(shouldWithdrawAffiliateReferral(request({ url: '/about', cookies: { nb_affiliate_ref: 'jane', nb_consent_preference: declined } }))).toBe(true);
  });

  it('leaves everything else alone', () => {
    // No referral cookie to withdraw.
    expect(shouldWithdrawAffiliateReferral(request({ url: '/about', cookies: { nb_consent_preference: declined } }))).toBe(false);
    // Consent given or never answered.
    expect(shouldWithdrawAffiliateReferral(request({ url: '/about', cookies: { nb_affiliate_ref: 'jane' } }))).toBe(false);
    expect(
      shouldWithdrawAffiliateReferral(
        request({ url: '/about', cookies: { nb_affiliate_ref: 'jane', nb_consent_preference: '{"marketing":true}' } }),
      ),
    ).toBe(false);
    // Not a document navigation.
    expect(
      shouldWithdrawAffiliateReferral(
        request({ headers: { ...DOCUMENT, 'sec-purpose': 'prefetch' }, cookies: { nb_affiliate_ref: 'jane', nb_consent_preference: declined } }),
      ),
    ).toBe(false);
    expect(
      shouldWithdrawAffiliateReferral(request({ method: 'POST', cookies: { nb_affiliate_ref: 'jane', nb_consent_preference: declined } })),
    ).toBe(false);
  });

  it('expires the cookie with the same attributes on a private response', () => {
    const set = vi.fn();
    const headerSet = vi.fn();
    expireAffiliateReferralCookie({ cookies: { set }, headers: { set: headerSet } }, true);
    expect(set).toHaveBeenCalledWith('nb_affiliate_ref', '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
    expect(headerSet).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});

describe('hasDeclinedAffiliateMarketingConsent', () => {
  it('is true only for an explicit marketing: false', () => {
    expect(hasDeclinedAffiliateMarketingConsent('{"marketing":false}')).toBe(true);
    expect(hasDeclinedAffiliateMarketingConsent('{"marketing":true}')).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent('{"marketing":"false"}')).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent('{}')).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent('[false]')).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent('%7B%22marketing%22%3Afalse%7D')).toBe(true);
    expect(hasDeclinedAffiliateMarketingConsent('%E0%A4%A')).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent(`{"marketing":false,"pad":"${'x'.repeat(5000)}"}`)).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent(undefined)).toBe(false);
    expect(hasDeclinedAffiliateMarketingConsent('')).toBe(false);
  });
});

describe('normalizeAffiliateReferralWindowDays', () => {
  it('accepts whole days 1..365, maps NULL to null and anything else to undefined', () => {
    expect(normalizeAffiliateReferralWindowDays(30)).toBe(30);
    expect(normalizeAffiliateReferralWindowDays(1)).toBe(1);
    expect(normalizeAffiliateReferralWindowDays(365)).toBe(365);
    expect(normalizeAffiliateReferralWindowDays('45')).toBe(45);
    expect(normalizeAffiliateReferralWindowDays(null)).toBeNull();
    expect(normalizeAffiliateReferralWindowDays(undefined)).toBeNull();
    for (const value of [0, -1, 366, 1.5, Number.NaN, '30 days', {}, [30], true]) {
      expect(normalizeAffiliateReferralWindowDays(value), String(value)).toBeUndefined();
    }
  });
});

describe('createAffiliateReferralWindowCache', () => {
  function setup(load: (handle: string) => unknown, extra: Record<string, number> = {}) {
    let clock = 1_000_000;
    const loader = vi.fn(load);
    const cache = createAffiliateReferralWindowCache({ load: loader, now: () => clock, ...extra });
    return { cache, loader, advance: (ms: number) => { clock += ms; } };
  }

  it('uses the documented bounds', () => {
    expect(AFFILIATE_REFERRAL_WINDOW_CACHE_DEFAULTS).toEqual({
      maxEntries: 1000,
      maxInflight: 100,
      positiveTtlMs: 300_000,
      negativeTtlMs: 60_000,
      errorTtlMs: 15_000,
    });
  });

  it('caches a window for 5 minutes', async () => {
    const { cache, loader, advance } = setup(async () => 45);
    expect(await cache.get('jane')).toBe(45);
    advance(299_999);
    expect(await cache.get('jane')).toBe(45);
    expect(loader).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await cache.get('jane')).toBe(45);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('caches "no such partner" for 60 seconds', async () => {
    const { cache, loader, advance } = setup(async () => null);
    expect(await cache.get('ghost')).toBeNull();
    advance(59_999);
    expect(await cache.get('ghost')).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.get('ghost');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('falls back to 30 days when the lookup fails, and asks again soon', async () => {
    const { cache, loader, advance } = setup(async () => {
      throw new Error('connection reset');
    });
    expect(await cache.get('jane')).toBe(30);
    advance(14_999);
    expect(await cache.get('jane')).toBe(30);
    expect(loader).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.get('jane');
    expect(loader).toHaveBeenCalledTimes(2);

    const sync = setup(() => {
      throw new Error('sync throw');
    });
    expect(await sync.cache.get('jane')).toBe(30);
    const weird = setup(async () => 'thirty');
    expect(await weird.cache.get('jane')).toBe(30);
  });

  it('shares one in-flight lookup per handle', async () => {
    let release: (value: number) => void = () => undefined;
    const { cache, loader } = setup(() => new Promise<number>((resolve) => { release = resolve; }));
    const first = cache.get('jane');
    const second = cache.get('JANE');
    expect(loader).toHaveBeenCalledTimes(1);
    release(20);
    expect(await Promise.all([first, second])).toEqual([20, 20]);
  });

  it('never looks up an invalid or reserved handle', async () => {
    const { cache, loader } = setup(async () => 30);
    expect(await cache.get('admin')).toBeNull();
    expect(await cache.get('x')).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('keeps at most maxEntries handles, dropping the oldest', async () => {
    const { cache, loader } = setup(async () => 30, { maxEntries: 3 });
    for (const handle of ['aaa', 'bbb', 'ccc', 'ddd']) await cache.get(handle);
    expect(cache.size).toBe(3);
    await cache.get('bbb');
    expect(loader).toHaveBeenCalledTimes(4);
    await cache.get('aaa');
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it('answers "no cookie" instead of queueing past maxInflight', async () => {
    const { cache, loader } = setup(() => new Promise(() => undefined), { maxInflight: 2 });
    void cache.get('aaa');
    void cache.get('bbb');
    expect(await cache.get('ccc')).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('buildAffiliateReferralCookie / applyAffiliateReferralCookie', () => {
  it('builds an httpOnly, lax, site-wide cookie for the tier window', () => {
    expect(buildAffiliateReferralCookie({ handle: 'Jane', days: 30, secure: true })).toEqual({
      name: 'nb_affiliate_ref',
      value: 'jane',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 86_400 },
    });
    expect(buildAffiliateReferralCookie({ handle: 'jane', days: 7, secure: false })?.options).toMatchObject({
      secure: false,
      maxAge: 7 * 86_400,
    });
  });

  it('refuses an invalid handle or window', () => {
    expect(buildAffiliateReferralCookie({ handle: 'admin', days: 30, secure: true })).toBeNull();
    expect(buildAffiliateReferralCookie({ handle: 'jane', days: 0, secure: true })).toBeNull();
    expect(buildAffiliateReferralCookie({ handle: 'jane', days: 400, secure: true })).toBeNull();
  });

  it('sets the cookie and makes the response private', () => {
    const set = vi.fn();
    const headerSet = vi.fn();
    const cookie = buildAffiliateReferralCookie({ handle: 'jane', days: 30, secure: true });
    if (!cookie) throw new Error('expected a cookie');
    applyAffiliateReferralCookie({ cookies: { set }, headers: { set: headerSet } }, cookie);
    expect(set).toHaveBeenCalledWith('nb_affiliate_ref', 'jane', cookie.options);
    expect(headerSet).toHaveBeenCalledWith('Cache-Control', AFFILIATE_REFERRAL_CACHE_CONTROL);
    expect(AFFILIATE_REFERRAL_CACHE_CONTROL).toBe('private, no-store');
  });
});

describe('visitor hash', () => {
  it('reads the first forwarded hop, then X-Real-IP', () => {
    expect(readAffiliateVisitorIp(headers({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe('203.0.113.7');
    expect(readAffiliateVisitorIp(headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(readAffiliateVisitorIp(headers({}))).toBeNull();
  });

  it('keeps only the /24 or /48 of an address', () => {
    expect(maskAffiliateVisitorIp('203.0.113.7')).toBe('203.0.113.0/24');
    expect(maskAffiliateVisitorIp('203.0.113.7:51234')).toBe('203.0.113.0/24');
    expect(maskAffiliateVisitorIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::/48');
    expect(maskAffiliateVisitorIp('2001:0DB8:0000::1')).toBe('2001:db8:0::/48');
    expect(maskAffiliateVisitorIp('[2001:db8:85a3::1]:443')).toBe('2001:db8:85a3::/48');
    expect(maskAffiliateVisitorIp('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(maskAffiliateVisitorIp('::ffff:198.51.100.23')).toBe('198.51.100.0/24');
    expect(maskAffiliateVisitorIp('::1')).toBe('0:0:0::/48');
    for (const value of ['', 'unknown', '999.1.1.1', '1.2.3', '1::2::3', '2001:db8:::1', 'gggg::1', null, undefined]) {
      expect(maskAffiliateVisitorIp(value as string | null | undefined), String(value)).toBe('unknown');
    }
  });

  it('hashes <UTC day>|<masked ip>|<first 200 UA chars> and keeps 32 hex characters', async () => {
    const now = Date.parse('2026-10-27T23:59:59.000Z');
    const userAgent = `Mozilla/5.0 ${'x'.repeat(300)}`;
    const input = buildAffiliateVisitorHashInput({ now, ip: '203.0.113.7', userAgent });
    expect(input).toBe(`2026-10-27|203.0.113.0/24|${userAgent.slice(0, 200)}`);

    const hash = await computeAffiliateVisitorHash({ now, ip: '203.0.113.7', userAgent });
    expect(hash).toBe(createHash('sha256').update(input ?? '').digest('hex').slice(0, 32));
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it('gives the same visitor the same hash all day, and a new one the next day', async () => {
    const visitor = { ip: '203.0.113.7', userAgent: 'UA' };
    const morning = await computeAffiliateVisitorHash({ ...visitor, now: Date.parse('2026-10-27T00:00:01Z') });
    const evening = await computeAffiliateVisitorHash({ ...visitor, now: Date.parse('2026-10-27T23:00:00Z') });
    const neighbour = await computeAffiliateVisitorHash({ ...visitor, ip: '203.0.113.200', now: Date.parse('2026-10-27T23:00:00Z') });
    const tomorrow = await computeAffiliateVisitorHash({ ...visitor, now: Date.parse('2026-10-28T00:00:01Z') });
    expect(morning).toBe(evening);
    expect(neighbour).toBe(evening);
    expect(tomorrow).not.toBe(evening);
  });

  it('returns null instead of throwing', async () => {
    expect(await computeAffiliateVisitorHash({ now: Number.NaN, ip: null, userAgent: null })).toBeNull();
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      expect(await computeAffiliateVisitorHash({ now: Date.now(), ip: null, userAgent: null })).toBeNull();
    } finally {
      vi.stubGlobal('crypto', original);
      vi.unstubAllGlobals();
    }
  });
});
