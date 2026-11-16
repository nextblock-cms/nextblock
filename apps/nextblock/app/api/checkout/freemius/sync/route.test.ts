import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/checkout/freemius/sync is public: it needs only the order's access token, and every
 * sync asks Freemius about the license with the store's credentials (on nextblock.dev, the
 * developer key pair every Freemius flow shares). Review 2026-11-13: a token holder could loop it
 * with arbitrary license ids, one signed Freemius request each, until Freemius throttled the key
 * and checkout, webhooks, claims and trials failed with it. One order got 5 syncs a minute, but a
 * token is no scarce thing: POST /api/checkout mints one per checkout for anyone, and it never
 * expires, so N scripted checkouts still gave 5N lookups a minute. Syncs are now also limited per
 * client network (20 every 10 minutes) and per instance (60 a minute, all callers together). The
 * overlay sends one sync per checkout, so a buyer never meets a limit.
 */

const mocks = vi.hoisted(() => ({
  syncFreemiusCheckoutOrder: vi.fn(async (input: { orderId: string }) => ({ success: true, orderId: input.orderId, status: 'paid' })),
  verifyOrderAccessToken: vi.fn((orderId: string, token: string | null) => token === `token-for-${orderId}`),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  syncFreemiusCheckoutOrder: mocks.syncFreemiusCheckoutOrder,
  verifyOrderAccessToken: mocks.verifyOrderAccessToken,
}));

/** The limiters live in the route module, so each test imports a fresh copy. */
let POST: (typeof import('./route'))['POST'];

const START = new Date('2026-11-13T12:00:00Z').getTime();

function at(offsetMs: number) {
  vi.setSystemTime(new Date(START + offsetMs));
}

function sync(orderId: string, options: { token?: string; headers?: Record<string, string> } = {}) {
  return POST(
    new Request('http://localhost/api/checkout/freemius/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify({ orderId, token: options.token ?? `token-for-${orderId}`, checkoutResponse: { license_id: 9001 } }),
    })
  );
}

/** A request from `ip` as the platform's proxy reports it. */
function from(ip: string, options: { token?: string } = {}) {
  return { ...options, headers: { 'x-real-ip': ip } };
}

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import('./route'));
  vi.useFakeTimers({ now: START, toFake: ['Date'] });
  vi.stubEnv('VERCEL', '');
  mocks.syncFreemiusCheckoutOrder.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/checkout/freemius/sync: per order', () => {
  it('lets one order sync 5 times a minute, then answers 429 without asking Freemius', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await sync('order-limit')).status).toBe(200);
    }

    const refused = await sync('order-limit');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
    await expect(refused.json()).resolves.toMatchObject({ success: false });
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(5);
  });

  it('keeps each order apart, and lets an order sync again after a minute', async () => {
    for (let i = 0; i < 5; i += 1) await sync('order-a');
    at(20_000);
    const refused = await sync('order-a');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('40');
    expect((await sync('order-b')).status).toBe(200);

    at(61_000);
    expect((await sync('order-a')).status).toBe(200);
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(7);
  });

  it('still refuses a request without the order id or the token before counting anything', async () => {
    const missing = await POST(
      new Request('http://localhost/api/checkout/freemius/sync', { method: 'POST', body: JSON.stringify({ token: 'x' }) })
    );

    expect(missing.status).toBe(400);
    expect((await sync('order-none', { token: '' })).status).toBe(404);
    expect(mocks.syncFreemiusCheckoutOrder).not.toHaveBeenCalled();
  });
});

describe('POST /api/checkout/freemius/sync: only token holders count', () => {
  it('counts nothing for a forged token: no buyer, network or instance loses a sync to it', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await sync('order-token', from('203.0.113.7', { token: 'forged-token' }))).status).toBe(404);
    }
    // Forged tokens from 200 networks, past every limit.
    for (let i = 0; i < 200; i += 1) {
      expect((await sync(`order-forged-${i}`, from(`198.51.${i}.1`, { token: 'forged-token' }))).status).toBe(404);
    }

    // The order, its network and the instance still have their whole budget.
    for (let i = 0; i < 5; i += 1) expect((await sync('order-token', from('203.0.113.7'))).status).toBe(200);
    for (let i = 0; i < 15; i += 1) expect((await sync(`order-net-${i}`, from('203.0.113.7'))).status).toBe(200);
    for (let i = 0; i < 40; i += 1) expect((await sync(`order-buyer-${i}`, from(`192.0.${i}.1`))).status).toBe(200);
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(60);
  });
});

describe('POST /api/checkout/freemius/sync: per client network', () => {
  it('lets one network sync 20 times in 10 minutes whatever the orders, then answers 429, while other networks still sync', async () => {
    // Scripted checkouts give a fresh order and token each time; the addresses share one /24.
    for (let i = 0; i < 20; i += 1) {
      expect((await sync(`order-net-${i}`, from(`203.0.113.${i + 1}`))).status).toBe(200);
    }

    // Past the order and instance windows: only the network's 10 minutes are still running.
    at(2 * 60_000);
    const refused = await sync('order-net-20', from('203.0.113.200'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('480');
    await expect(refused.json()).resolves.toMatchObject({ success: false });
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(20);
    expect((await sync('order-other-network', from('198.51.100.7'))).status).toBe(200);

    at(10 * 60_000);
    expect((await sync('order-net-21', from('203.0.113.9'))).status).toBe(200);
  });

  it('counts an IPv6 network as one, and an IPv4-mapped address as its IPv4 network', async () => {
    // A host rotating through its block (here the /48's subnets and hosts) gains no bucket.
    for (let i = 0; i < 20; i += 1) {
      expect((await sync(`order-v6-${i}`, from(`2001:db8:85a3:${(i + 1).toString(16)}::${i + 1}`))).status).toBe(200);
    }
    expect((await sync('order-v6-20', from('[2001:db8:85a3:ffff::1]:443'))).status).toBe(429);

    for (let i = 0; i < 20; i += 1) {
      expect((await sync(`order-v4-${i}`, from(i % 2 ? `::ffff:192.0.2.${i}` : `192.0.2.${i}`))).status).toBe(200);
    }
    expect((await sync('order-v4-20', from('192.0.2.250'))).status).toBe(429);
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(40);
  });

  it('trusts x-vercel-forwarded-for only on Vercel, where the platform sets it', async () => {
    // Anywhere else a client sends it: a new value per request must not mint a new bucket.
    for (let i = 0; i < 20; i += 1) {
      const spoofed = { headers: { 'x-real-ip': '203.0.113.7', 'x-vercel-forwarded-for': `198.51.${i}.1` } };
      expect((await sync(`order-spoof-${i}`, spoofed)).status).toBe(200);
    }
    const onVercelHeaders = { headers: { 'x-real-ip': '203.0.113.7', 'x-vercel-forwarded-for': '192.0.2.1' } };
    expect((await sync('order-spoof-20', onVercelHeaders)).status).toBe(429);

    // On Vercel the platform writes it, so it names the caller's own network.
    vi.stubEnv('VERCEL', '1');
    expect((await sync('order-spoof-20', onVercelHeaders)).status).toBe(200);
  });

  it('puts callers with no readable address in one shared bucket: more room, never a free pass', async () => {
    // Spread over three minutes so the instance limit never decides.
    for (let minute = 0; minute < 3; minute += 1) {
      at(minute * 60_000);
      for (let i = 0; i < 20; i += 1) {
        expect((await sync(`order-unknown-${minute}-${i}`)).status).toBe(200);
      }
    }

    // An unreadable address joins the same bucket rather than escaping it.
    const refused = await sync('order-unknown-60', from('not-an-address'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('480');
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(60);
  });
});

describe('POST /api/checkout/freemius/sync: per instance', () => {
  it('runs at most 60 syncs a minute, all callers together, then answers 429 until the minute is over', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 60; i += 1) {
      expect((await sync(`order-busy-${i}`, from(`198.51.${i}.10`))).status).toBe(200);
    }

    at(15_000);
    const refused = await sync('order-busy-60', from('192.0.2.10'));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('45');
    await expect(refused.json()).resolves.toMatchObject({ success: false });
    expect((await sync('order-busy-61', from('192.0.2.11'))).status).toBe(429);
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(60);
    // One line a minute however many are refused, naming no address and no order.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/192\.0\.2|198\.51|order-busy/);

    at(60_000);
    // The refused order and network spent nothing while they waited.
    expect((await sync('order-busy-60', from('192.0.2.10'))).status).toBe(200);
  });

  it('spends none of its budget on requests another limit refuses', async () => {
    // One caller loops one order: 5 syncs run, 95 are refused.
    for (let i = 0; i < 100; i += 1) await sync('order-loop', from('203.0.113.7'));
    // Another loops fresh orders from one network: 20 run, 20 are refused.
    for (let i = 0; i < 40; i += 1) await sync(`order-network-loop-${i}`, from('198.51.100.7'));
    expect(mocks.syncFreemiusCheckoutOrder).toHaveBeenCalledTimes(25);

    // The other 35 of the minute's 60 are still there for buyers.
    for (let i = 0; i < 35; i += 1) {
      expect((await sync(`order-buyer-${i}`, from(`192.0.${i}.1`))).status).toBe(200);
    }
    expect((await sync('order-buyer-35', from('192.0.200.1'))).status).toBe(429);
  });
});
