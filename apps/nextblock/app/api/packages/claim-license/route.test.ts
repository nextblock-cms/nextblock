import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/packages/claim-license, the vendor's license claim (nextblock.dev only).
 *
 * Review 2026-11-13:
 * - L1: the public sandbox answers 404 before anything else, even with the vendor flag copied into
 *   its env (it used to check the flag alone, and would then have handed out license keys read with
 *   the operator's keys).
 * - L5: the flag, the package allowlist, validation, the uniform refusal and the not_configured /
 *   upstream mappings.
 * - L7: lookups spend the Freemius developer key pair every flow of the store shares, so they are
 *   limited per client network (an IPv4 /24, an IPv6 /48, read with x-vercel-forwarded-for only on
 *   Vercel), per license and per instance, counted only when every limit admits them, and a license
 *   Freemius just answered "no such license" for is refused from memory for a minute.
 */

const REFUSED = 'This license cannot be claimed automatically. Use the key from your purchase email.';

const mocks = vi.hoisted(() => ({
  claimFreemiusLicenseKey: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE: 'This license cannot be claimed automatically. Use the key from your purchase email.',
  claimFreemiusLicenseKey: mocks.claimFreemiusLicenseKey,
}));

type Post = (request: Request) => Promise<Response>;

/** A fresh route module per test: its limiters and its miss memory are module state. */
async function loadRoute(): Promise<Post> {
  vi.resetModules();
  return (await import('./route')).POST;
}

let licenseCounter = 7000;

/** A claim body; every call gets a new license id unless one is given. */
function claimBody(overrides: Record<string, unknown> = {}) {
  licenseCounter += 1;
  return { email: 'buyer@example.com', kind: 'purchase', licenseId: String(licenseCounter), productId: '28609', userId: '77', ...overrides };
}

function claimRequest(body: unknown, headers: Record<string, string> = { 'x-real-ip': '192.0.2.10' }) {
  return new Request('https://nextblock.dev/api/packages/claim-license', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const GRANTED = { ok: true, licenseKey: 'sk_claimed_key', planId: '47122', expiration: null };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXTBLOCK_LICENSE_CLAIM_ENABLED', 'true');
  vi.stubEnv('VERCEL', '');
  mocks.claimFreemiusLicenseKey.mockReset().mockResolvedValue(GRANTED);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/packages/claim-license: where it runs', () => {
  it('answers 404 on the sandbox, even with the vendor flag set, before reading or counting anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const POST = await loadRoute();
    const request = claimRequest(claimBody());

    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.', ok: false });
    expect(request.bodyUsed).toBe(false);
    expect(mocks.claimFreemiusLicenseKey).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])('answers 404 wherever the vendor flag is not exactly true (%j)', async (value) => {
    vi.stubEnv('NEXTBLOCK_LICENSE_CLAIM_ENABLED', value);
    const POST = await loadRoute();

    expect((await POST(claimRequest(claimBody()))).status).toBe(404);
    expect(mocks.claimFreemiusLicenseKey).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])('claims on the vendor deployment (NEXT_PUBLIC_IS_SANDBOX=%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const POST = await loadRoute();
    const body = claimBody({ email: 'Buyer@Example.com', kind: 'trial' });

    const response = await POST(claimRequest(body));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ expiration: null, licenseKey: 'sk_claimed_key', ok: true, planId: '47122' });
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledWith({
      email: 'Buyer@Example.com',
      kind: 'trial',
      licenseId: body.licenseId,
      productId: '28609',
      userId: '77',
    });
  });
});

describe('POST /api/packages/claim-license: input', () => {
  it.each<[string, string | unknown]>([
    ['a body that is not JSON', '{not json'],
    ['an array', [claimBody()]],
    ['a JSON string', '"claim"'],
  ])('refuses %s (400) without a lookup', async (_label, body) => {
    const POST = await loadRoute();
    const response = await POST(claimRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request body.', ok: false });
    expect(mocks.claimFreemiusLicenseKey).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['no product id', { productId: undefined }],
    ['no license id', { licenseId: '' }],
    ['no user id (the second factor of the claim)', { userId: undefined }],
    ['no email', { email: '   ' }],
    ['an unknown kind', { kind: 'gift' }],
    ['a license id with a path in it', { licenseId: '6001/../../users/1' }],
    ['a product id that is not digits', { productId: '28609.json' }],
    ['a user id that is not digits', { userId: '77 OR 1=1' }],
    ['a license id over 32 characters', { licenseId: '1'.repeat(33) }],
    ['an email over 320 characters', { email: `${'a'.repeat(310)}@example.com` }],
    ['a number instead of a string', { licenseId: 6001 }],
  ])('refuses %s (400) without a lookup', async (_label, overrides) => {
    const POST = await loadRoute();
    const response = await POST(claimRequest(claimBody(overrides)));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'productId, licenseId, userId, email, and kind are required.', ok: false });
    expect(mocks.claimFreemiusLicenseKey).not.toHaveBeenCalled();
  });

  it('looks up only the NextBlock packages sold here', async () => {
    const POST = await loadRoute();

    for (const productId of ['12345', '1', '00028609']) {
      const response = await POST(claimRequest(claimBody({ productId })));
      expect(response.status, productId).toBe(400);
      expect(await response.json()).toEqual({ error: 'Unknown NextBlock package.', ok: false });
    }
    expect(mocks.claimFreemiusLicenseKey).not.toHaveBeenCalled();

    for (const productId of ['24851', '28609', '43273']) {
      expect((await POST(claimRequest(claimBody({ productId })))).status, productId).toBe(200);
    }
    expect(mocks.claimFreemiusLicenseKey.mock.calls.map(([request]) => request.productId)).toEqual(['24851', '28609', '43273']);
  });
});

describe('POST /api/packages/claim-license: answers', () => {
  it.each<[string, number, string]>([
    ['not_configured', 503, 'The license service is not configured for this product.'],
    ['upstream_error', 502, 'Freemius could not be reached to verify the license.'],
  ])('passes %s through as %i with its message, logged once', async (reason, status, error) => {
    mocks.claimFreemiusLicenseKey.mockResolvedValue({ error, ok: false, reason, status });
    const POST = await loadRoute();

    const response = await POST(claimRequest(claimBody()));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error, ok: false });
    expect(console.error).toHaveBeenCalledWith('[License claim] unavailable:', reason);
  });

  it.each(['license_not_found', 'too_old', 'product_mismatch', 'user_mismatch', 'email_mismatch', 'already_activated', 'cancelled', 'no_key', 'credentials_refused'])(
    'answers %s with the uniform 403, the reason never leaving the server',
    async (reason) => {
      mocks.claimFreemiusLicenseKey.mockResolvedValue({ error: REFUSED, ok: false, reason, status: 403 });
      const POST = await loadRoute();

      const response = await POST(claimRequest(claimBody()));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({ error: REFUSED, ok: false });
      expect(JSON.stringify(body)).not.toContain(reason);
      if (reason === 'credentials_refused') {
        // The claim module logs the configuration error itself, throttled: no line per claim here.
        expect(console.warn).not.toHaveBeenCalled();
      } else {
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`: ${reason}`));
      }
    }
  );
});

describe('POST /api/packages/claim-license: limits', () => {
  it('buckets by IPv4 /24: rotating the last octet buys nothing, another network still claims', async () => {
    const POST = await loadRoute();
    const statuses: number[] = [];

    // 20 now and 10 a minute later: the instance cap (30 a minute) never decides here.
    for (let octet = 1; octet <= 20; octet += 1) {
      statuses.push((await POST(claimRequest(claimBody(), { 'x-real-ip': `203.0.113.${octet}` }))).status);
    }
    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    for (let octet = 21; octet <= 30; octet += 1) {
      statuses.push((await POST(claimRequest(claimBody(), { 'x-real-ip': `203.0.113.${octet}` }))).status);
    }
    expect(statuses).toEqual(new Array(30).fill(200));

    const limited = await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.113.250' }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many claims from your network. Try again later.', ok: false });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // IPv4-mapped IPv6 is the same /24.
    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '::ffff:203.0.113.77' }))).status).toBe(429);
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(30);

    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.114.1' }))).status).toBe(200);
  });

  it('buckets by IPv6 /48: addresses anywhere in the block, however written, share one bucket', async () => {
    const POST = await loadRoute();
    const addresses = (index: number) =>
      [`2001:db8:abcd:${index.toString(16)}::1`, `2001:0db8:abcd:${index.toString(16)}:ffff:1:2:3`, `[2001:db8:abcd:ff${index}::9]:443`][index % 3];

    for (let index = 0; index < 20; index += 1) {
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': addresses(index) }))).status).toBe(200);
    }
    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    for (let index = 20; index < 30; index += 1) {
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': addresses(index) }))).status).toBe(200);
    }

    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '2001:db8:abcd:9999:8888:7777:6666:5555' }))).status).toBe(429);
    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '2001:db8:abce::1' }))).status).toBe(200);
  });

  it('holds the instance cap across networks: the 31st lookup a minute is refused whoever sends it, logged once', async () => {
    const POST = await loadRoute();

    for (let index = 0; index < 15; index += 1) {
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': `198.51.${index}.1` }))).status).toBe(200);
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': `2001:db8:${index.toString(16)}::1` }))).status).toBe(200);
    }

    const busy = await POST(claimRequest(claimBody(), { 'x-real-ip': '192.0.2.200' }));
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'License claims are busy. Try again in a minute.', ok: false });
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '2001:db8:fff0::1' }))).status).toBe(429);
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(30);
    expect(vi.mocked(console.warn).mock.calls.filter(([line]) => String(line).includes('Freemius lookups ran on this instance'))).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '192.0.2.200' }))).status).toBe(200);
  });

  it('counts a request only when every limit admits it: a network over its limit spends none of the instance budget', async () => {
    const POST = await loadRoute();

    for (let index = 0; index < 20; index += 1) {
      await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.113.5' }));
    }
    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    for (let index = 0; index < 10; index += 1) {
      await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.113.5' }));
    }
    // 200 more from the exhausted network: all refused, none counted.
    for (let index = 0; index < 200; index += 1) {
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.113.6' }))).status).toBe(429);
    }

    // This minute's instance budget still holds 20 lookups for everyone else (one per network here).
    for (let index = 0; index < 20; index += 1) {
      expect((await POST(claimRequest(claimBody(), { 'x-real-ip': `198.51.${index}.1` }))).status).toBe(200);
    }
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(50);
  });

  it('limits one license to 10 lookups per window from any number of networks, with the uniform refusal', async () => {
    const POST = await loadRoute();
    const body = claimBody({ licenseId: '9000001' });

    for (let index = 0; index < 10; index += 1) {
      expect((await POST(claimRequest(body, { 'x-real-ip': `198.51.${index}.9` }))).status).toBe(200);
    }

    const refused = await POST(claimRequest(body, { 'x-real-ip': '192.0.2.99' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: REFUSED, ok: false });
    expect(refused.headers.get('retry-after')).toBeNull();
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(10);
  });

  it('remembers a license Freemius answered "no such license" for about a minute, per product', async () => {
    mocks.claimFreemiusLicenseKey.mockResolvedValue({ error: REFUSED, ok: false, reason: 'license_not_found', status: 403 });
    const POST = await loadRoute();
    const body = claimBody({ licenseId: '31337' });

    for (let index = 0; index < 5; index += 1) {
      const response = await POST(claimRequest(body, { 'x-real-ip': `198.51.${index}.1` }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: REFUSED, ok: false });
    }
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(1);

    // The same license id of another product is another lookup.
    await POST(claimRequest({ ...body, productId: '24851' }));
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    await POST(claimRequest(body));
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(3);
  });

  it.each(['upstream_error', 'not_configured', 'credentials_refused', 'too_old'])('never remembers %s as a miss', async (reason) => {
    mocks.claimFreemiusLicenseKey.mockResolvedValue({ error: 'x', ok: false, reason, status: reason === 'upstream_error' ? 502 : 403 });
    const POST = await loadRoute();
    const body = claimBody({ licenseId: '424242' });

    await POST(claimRequest(body));
    await POST(claimRequest(body));
    expect(mocks.claimFreemiusLicenseKey).toHaveBeenCalledTimes(2);
  });

  /** 30 claims (20, then 10 a minute later so the instance cap never decides), each with `headers(index)`. */
  async function fillNetwork(POST: Post, headers: (index: number) => Record<string, string>) {
    const statuses: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      if (index === 20) vi.setSystemTime(new Date(Date.now() + 61_000));
      statuses.push((await POST(claimRequest(claimBody(), headers(index)))).status);
    }
    return statuses;
  }

  it('off Vercel ignores x-vercel-forwarded-for and cf-connecting-ip, which any client can send', async () => {
    const POST = await loadRoute();

    expect(
      await fillNetwork(POST, (index) => ({
        'x-real-ip': '203.0.113.9',
        'x-vercel-forwarded-for': `198.51.${index}.1`,
        'cf-connecting-ip': `192.0.${index}.1`,
      }))
    ).toEqual(new Array(30).fill(200));
    expect(
      (await POST(claimRequest(claimBody(), { 'x-real-ip': '203.0.113.9', 'x-vercel-forwarded-for': '198.51.250.1', 'cf-connecting-ip': '192.0.250.1' }))).status
    ).toBe(429);
    // Without x-real-ip, the first x-forwarded-for hop decides.
    expect((await POST(claimRequest(claimBody(), { 'x-forwarded-for': '203.0.113.44, 10.0.0.1' }))).status).toBe(429);
    expect((await POST(claimRequest(claimBody(), { 'x-forwarded-for': '10.0.0.1, 203.0.113.44' }))).status).toBe(200);
  });

  it('on Vercel, where the platform sets it, reads the first x-vercel-forwarded-for hop', async () => {
    vi.stubEnv('VERCEL', '1');
    const POST = await loadRoute();

    expect(
      await fillNetwork(POST, (index) => ({ 'x-vercel-forwarded-for': `203.0.113.${index}, 10.0.0.1`, 'x-real-ip': `198.51.${index}.1` }))
    ).toEqual(new Array(30).fill(200));
    expect((await POST(claimRequest(claimBody(), { 'x-vercel-forwarded-for': '203.0.113.200', 'x-real-ip': '192.0.2.1' }))).status).toBe(429);
    expect((await POST(claimRequest(claimBody(), { 'x-vercel-forwarded-for': '192.0.2.1', 'x-real-ip': '203.0.113.200' }))).status).toBe(200);
  });

  it('gives callers whose address cannot be read one shared bucket, with more room, never a free pass', async () => {
    const POST = await loadRoute();
    let admitted = 0;

    for (let minute = 0; minute < 3; minute += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 12, minute, 1)));
      for (let index = 0; index < 25; index += 1) {
        const headers: Record<string, string> = index % 2 ? { 'x-real-ip': 'not-an-address' } : {};
        if ((await POST(claimRequest(claimBody(), headers))).status === 200) admitted += 1;
      }
    }

    expect(admitted).toBe(60);
  });
});
