import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The vendor's trial endpoint mints a real license on the operator's Freemius product. Only the
 * deployment that sells the packages enables it (NEXTBLOCK_LICENSE_CLAIM_ENABLED=true), and the
 * public sandbox answers 404 even when that flag was copied into its env: nothing is read and no
 * license is provisioned.
 */

const mocks = vi.hoisted(() => ({
  provisionFreemiusTrialLicense: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  provisionFreemiusTrialLicense: mocks.provisionFreemiusTrialLicense,
}));

import { POST } from './route';

function trialRequest(email: string): Request {
  return new Request('https://nextblock.dev/api/packages/provision-trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${email.length}` },
    body: JSON.stringify({ email, name: 'Agent', packageId: 'cortex-ai' }),
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXTBLOCK_LICENSE_CLAIM_ENABLED', 'true');
  mocks.provisionFreemiusTrialLicense.mockReset().mockResolvedValue({ ok: true, licenseKey: 'sk_trial', expiresAt: null });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/packages/provision-trial', () => {
  it('answers 404 on the sandbox, even with the vendor flag set, without provisioning', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    const response = await POST(trialRequest('visitor@example.com'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.', ok: false });
    expect(mocks.provisionFreemiusTrialLicense).not.toHaveBeenCalled();
  });

  it('answers 404 wherever the vendor flag is off', async () => {
    vi.stubEnv('NEXTBLOCK_LICENSE_CLAIM_ENABLED', '');

    expect((await POST(trialRequest('owner@example.com'))).status).toBe(404);
    expect(mocks.provisionFreemiusTrialLicense).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])('provisions on the vendor deployment (NEXT_PUBLIC_IS_SANDBOX=%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    const response = await POST(trialRequest(`agent-${value || 'blank'}@example.com`));

    expect(response.status).not.toBe(404);
    expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review 2026-11-13:
 * - L2: the route mints Cortex AI trials only. The CLI never asks for another package, and turning
 *   the vendor flag on for claims used to open trial minting for every package in the registry.
 * - L7: each provision spends the Freemius developer key pair every flow of the store shares, so
 *   provisions are limited per client network (an IPv4 /24, an IPv6 /48; x-vercel-forwarded-for
 *   only on Vercel), per email and per instance, counted only when every limit admits them.
 */
type Post = (request: Request) => Promise<Response>;

/** A fresh route module: its limiters are module state. */
async function loadRoute(): Promise<Post> {
  vi.resetModules();
  return (await import('./route')).POST;
}

let emailCounter = 0;

function nextEmail(label = 'agent') {
  emailCounter += 1;
  return `${label}-${emailCounter}@example.com`;
}

function provisionRequest(body: unknown, headers: Record<string, string> = { 'x-real-ip': '192.0.2.10' }) {
  return new Request('https://nextblock.dev/api/packages/provision-trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const trialBody = (overrides: Record<string, unknown> = {}) => ({ email: nextEmail(), name: 'Agent', packageId: 'cortex-ai', ...overrides });

describe('POST /api/packages/provision-trial: Cortex AI trials only', () => {
  beforeEach(() => {
    mocks.provisionFreemiusTrialLicense.mockResolvedValue({
      ok: true,
      assigned: true,
      expiresAt: '2026-12-13 12:00:00',
      licenseId: '999',
      licenseKey: 'sk_trial',
      planId: '47122',
      pricingId: '110047',
    });
  });

  it.each(['ecommerce', 'affiliates', 'no-such-package', '__proto__', 'constructor', 'CORTEX-AI'])(
    'answers %s like an unknown package, minting nothing',
    async (packageId) => {
      const POST = await loadRoute();
      const response = await POST(provisionRequest(trialBody({ packageId })));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'UNKNOWN_PACKAGE', error: 'Unknown NextBlock package.', ok: false });
      expect(mocks.provisionFreemiusTrialLicense).not.toHaveBeenCalled();
    }
  );

  it.each([{ packageId: 'cortex-ai' }, { packageId: undefined }, { packageId: ' cortex-ai ' }])(
    'mints a Cortex AI trial for %j',
    async (overrides) => {
      const POST = await loadRoute();
      const response = await POST(provisionRequest(trialBody(overrides)));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, kind: 'trial', packageId: 'cortex-ai', licenseKey: 'sk_trial', trialDays: 30 });
      expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledWith(
        expect.objectContaining({ productId: '28609', planId: '47122', trialDays: 30, name: 'Agent' })
      );
    }
  );

  it.each<[string, unknown]>([
    ['a body that is not JSON', '{nope'],
    ['an array', [trialBody()]],
  ])('refuses %s (400) without provisioning', async (_label, body) => {
    const POST = await loadRoute();
    const response = await POST(provisionRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST', error: 'Invalid request body.', ok: false });
    expect(mocks.provisionFreemiusTrialLicense).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an invalid email', { email: 'not-an-email' }],
    ['no name', { name: '' }],
    ['a name over 120 characters', { name: 'n'.repeat(121) }],
  ])('refuses %s (400) without provisioning', async (_label, overrides) => {
    const POST = await loadRoute();
    const response = await POST(provisionRequest(trialBody(overrides)));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST', ok: false });
    expect(mocks.provisionFreemiusTrialLicense).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    ['already_licensed', { error: 'A NextBlock license or trial already exists for this email.', status: 409 }, 409, 'TRIAL_ALREADY_USED'],
    ['not_configured', { error: 'The license service is not configured for this product.', status: 503 }, 503, 'NOT_CONFIGURED'],
    ['upstream_error', { error: 'Freemius could not be reached to verify eligibility.', status: 502 }, 502, 'UPSTREAM_ERROR'],
  ])('maps %s to %i %s', async (reason, result, status, code) => {
    mocks.provisionFreemiusTrialLicense.mockResolvedValue({ ok: false, reason, ...result });
    const POST = await loadRoute();
    const response = await POST(provisionRequest(trialBody()));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, error: result['error'], ok: false });
  });
});

describe('POST /api/packages/provision-trial: limits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    vi.stubEnv('VERCEL', '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function statusOf(POST: Post, headers: Record<string, string>, body = trialBody()) {
    return (await POST(provisionRequest(body, headers))).status;
  }

  it('buckets by IPv4 /24: rotating the last octet buys nothing, another network still provisions', async () => {
    const POST = await loadRoute();
    const statuses: number[] = [];

    for (let octet = 1; octet <= 5; octet += 1) {
      statuses.push(await statusOf(POST, { 'x-real-ip': `203.0.113.${octet}` }));
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200]);

    const limited = await POST(provisionRequest(trialBody(), { 'x-real-ip': '203.0.113.200' }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 'RATE_LIMITED', error: 'Too many trial requests from your network. Try again later.', ok: false });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3000);
    expect(await statusOf(POST, { 'x-real-ip': '::ffff:203.0.113.9' })).toBe(429);
    expect(await statusOf(POST, { 'x-real-ip': '203.0.112.1' })).toBe(200);
    expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledTimes(6);

    vi.setSystemTime(new Date('2026-11-13T13:00:01Z'));
    expect(await statusOf(POST, { 'x-real-ip': '203.0.113.200' })).toBe(200);
  });

  it('buckets by IPv6 /48: addresses anywhere in the block, however written, share one bucket', async () => {
    const POST = await loadRoute();

    for (const address of ['2001:db8:beef::1', '2001:db8:beef:1::1', '2001:0DB8:BEEF:ffff:1:2:3:4', '[2001:db8:beef:42::7]:51234', '2001:db8:beef:9::1%eth0']) {
      expect(await statusOf(POST, { 'x-real-ip': address }), address).toBe(200);
    }

    expect(await statusOf(POST, { 'x-real-ip': '2001:db8:beef:dead:beef:dead:beef:1' })).toBe(429);
    expect(await statusOf(POST, { 'x-real-ip': '2001:db8:bee0::1' })).toBe(200);
  });

  it('limits one email to 3 provisions a day from any number of networks, whatever its case', async () => {
    const POST = await loadRoute();
    const email = nextEmail('repeat');

    for (const [index, spelling] of [email, email.toUpperCase(), ` ${email} `].entries()) {
      expect(await statusOf(POST, { 'x-real-ip': `198.51.${index}.1` }, trialBody({ email: spelling }))).toBe(200);
    }

    const limited = await POST(provisionRequest(trialBody({ email }), { 'x-real-ip': '192.0.2.77' }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 'RATE_LIMITED', error: 'Too many trial requests for this email. Try again tomorrow.', ok: false });
    expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledTimes(3);
  });

  it('holds the instance cap across networks and emails: the 11th provision a minute is refused, logged once', async () => {
    const POST = await loadRoute();

    for (let index = 0; index < 5; index += 1) {
      expect(await statusOf(POST, { 'x-real-ip': `198.51.${index}.1` })).toBe(200);
      expect(await statusOf(POST, { 'x-real-ip': `2001:db8:${(index + 1).toString(16)}::1` })).toBe(200);
    }

    const busy = await POST(provisionRequest(trialBody(), { 'x-real-ip': '192.0.2.50' }));
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ code: 'RATE_LIMITED', error: 'The trial service is busy. Try again in a minute.', ok: false });
    expect(Number(busy.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(await statusOf(POST, { 'x-real-ip': '2001:db8:ffff::1' })).toBe(429);
    expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledTimes(10);
    expect(vi.mocked(console.warn).mock.calls.filter(([line]) => String(line).includes('trial provisions ran on this instance'))).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    expect(await statusOf(POST, { 'x-real-ip': '192.0.2.50' })).toBe(200);
  });

  it('counts a request only when every limit admits it: a refused email spends none of its network', async () => {
    const POST = await loadRoute();
    const email = nextEmail('spent');
    const network = { 'x-real-ip': '203.0.113.20' };

    for (let index = 0; index < 3; index += 1) {
      expect(await statusOf(POST, network, trialBody({ email }))).toBe(200);
    }
    for (let index = 0; index < 20; index += 1) {
      expect(await statusOf(POST, network, trialBody({ email }))).toBe(429);
    }

    // The network still has its last 2 provisions this hour.
    expect(await statusOf(POST, network)).toBe(200);
    expect(await statusOf(POST, network)).toBe(200);
    expect(await statusOf(POST, network)).toBe(429);
    expect(mocks.provisionFreemiusTrialLicense).toHaveBeenCalledTimes(5);
  });

  it('reads x-vercel-forwarded-for only on Vercel, and never cf-connecting-ip', async () => {
    let POST = await loadRoute();

    for (let index = 0; index < 5; index += 1) {
      expect(
        await statusOf(POST, { 'x-real-ip': '203.0.113.30', 'x-vercel-forwarded-for': `198.51.${index}.1`, 'cf-connecting-ip': `192.0.${index}.1` })
      ).toBe(200);
    }
    expect(await statusOf(POST, { 'x-real-ip': '203.0.113.30', 'x-vercel-forwarded-for': '198.51.99.1' })).toBe(429);

    vi.stubEnv('VERCEL', '1');
    POST = await loadRoute();
    for (let index = 0; index < 5; index += 1) {
      expect(await statusOf(POST, { 'x-vercel-forwarded-for': `203.0.113.${index}, 10.0.0.1`, 'x-real-ip': `198.51.${index}.1` })).toBe(200);
    }
    expect(await statusOf(POST, { 'x-vercel-forwarded-for': '203.0.113.99', 'x-real-ip': '192.0.2.1' })).toBe(429);
    expect(await statusOf(POST, { 'x-vercel-forwarded-for': '192.0.2.1', 'x-real-ip': '203.0.113.99' })).toBe(200);
  });
});
