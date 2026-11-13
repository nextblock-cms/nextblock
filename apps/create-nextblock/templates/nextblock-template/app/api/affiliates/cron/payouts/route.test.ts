import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The payout cron route fails closed: 404 in the sandbox, 503 without a (long enough)
 * CRON_SECRET, 401 for a missing or wrong bearer (timing-safe), `{ skipped }` while the package
 * is inactive, the run summary otherwise, never cached and never a stack.
 */

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  verifyPackageOnline: vi.fn(),
}));

vi.mock('../../../../../lib/affiliates/payout-runner', () => ({ runAffiliatePayoutCycleNow: mocks.run }));
vi.mock('@nextblock-cms/db/server', () => ({ verifyPackageOnline: mocks.verifyPackageOnline }));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../../libs/affiliates/src/lib/core/constants')),
}));

import { GET, POST, dynamic, maxDuration, runtime } from './route';

const SECRET = 'cron-secret-0123456789abcdef';
const ROUTE_URL = 'https://shop.example.org/api/affiliates/cron/payouts';

function request(method: 'GET' | 'POST', authorization?: string) {
  return new Request(ROUTE_URL, { method, headers: authorization ? { authorization } : {} });
}

const SUMMARY = { trigger: 'cron', sent: 3, claimed: 3, remaining: 0, errors: [], skipped: null };

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.run.mockReset();
  mocks.verifyPackageOnline.mockReset();
  mocks.run.mockResolvedValue(SUMMARY);
  mocks.verifyPackageOnline.mockResolvedValue(true);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('CRON_SECRET', SECRET);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorLog.mockRestore();
});

describe('route config', () => {
  it('runs on Node, dynamically, for up to a minute', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
    expect(maxDuration).toBe(60);
  });
});

describe('authorization matrix', () => {
  it('404s in the sandbox, even with the right secret', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const response = await POST(request('POST', `Bearer ${SECRET}`));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('404s a GET in the sandbox too, even with the right secret', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const response = await GET(request('GET', `Bearer ${SECRET}`));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it('runs by GET or POST off the sandbox (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      expect((await GET(request('GET', `Bearer ${SECRET}`))).status, value).toBe(200);
      expect((await POST(request('POST', `Bearer ${SECRET}`))).status, value).toBe(200);
    }
    expect(mocks.run).toHaveBeenCalledTimes(8);
    expect(mocks.run).toHaveBeenCalledWith('cron');
  });

  it('503s while CRON_SECRET is unset or too short', async () => {
    vi.stubEnv('CRON_SECRET', '');
    let response = await POST(request('POST', 'Bearer undefined'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'not configured' });

    vi.stubEnv('CRON_SECRET', 'short-secret');
    response = await POST(request('POST', 'Bearer short-secret'));
    expect(response.status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer cron-secret-0123456789abcdeX'],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['the secret plus extra', `Bearer ${SECRET}x`],
    ['another scheme', `Basic ${SECRET}`],
    ['the secret without a scheme', SECRET],
    ['an empty bearer', 'Bearer '],
  ])('401s for %s', async (_label, authorization) => {
    const response = await POST(request('POST', authorization));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: false, error: 'Unauthorized' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it('runs the cron cycle for the right secret, by POST or GET', async () => {
    const post = await POST(request('POST', `Bearer ${SECRET}`));
    expect(post.status).toBe(200);
    expect(post.headers.get('cache-control')).toBe('no-store');
    expect(await post.json()).toEqual({
      ok: true,
      skipped: null,
      summary: { trigger: 'cron', sent: 3, claimed: 3, remaining: 0, errors: [] },
    });
    expect(mocks.run).toHaveBeenCalledWith('cron');

    const get = await GET(request('GET', `bearer ${SECRET}`));
    expect(get.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});

describe('outcomes', () => {
  it('skips while the Affiliates package is inactive (or its check fails)', async () => {
    mocks.verifyPackageOnline.mockResolvedValueOnce(false);
    let response = await POST(request('POST', `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: 'package_inactive' });

    mocks.verifyPackageOnline.mockRejectedValueOnce(new Error('db down'));
    response = await POST(request('POST', `Bearer ${SECRET}`));
    expect(await response.json()).toEqual({ ok: true, skipped: 'package_inactive' });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('reports a skipped run (automatic payouts off)', async () => {
    mocks.run.mockResolvedValueOnce({ ...SUMMARY, sent: 0, skipped: 'disabled' });
    const response = await POST(request('POST', `Bearer ${SECRET}`));
    expect(await response.json()).toMatchObject({ ok: true, skipped: 'disabled' });
  });

  it('answers a generic 500 without the error message or a stack', async () => {
    mocks.run.mockRejectedValueOnce(new Error('relation "secret_table" does not exist at /srv/app.js:1:1'));
    const response = await POST(request('POST', `Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'payout run failed' });
    expect(body).not.toContain('secret_table');
    expect(body).not.toContain('app.js');
  });
});
