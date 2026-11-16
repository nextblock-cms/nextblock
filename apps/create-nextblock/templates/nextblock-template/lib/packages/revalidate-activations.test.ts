import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily recheck is the only thing that carries a cancellation, an expiry or a renewal
 * at Freemius to the buyer's `package_activations` row. It must ask Freemius' validation
 * endpoint for the install's license (re-activating answers `license_activated` and says
 * nothing), record a verdict only when Freemius gives one, and otherwise leave the row alone.
 *
 * The public sandbox seeds placeholder activations and every visitor is its admin, so the
 * recheck never asks Freemius anything there: the refusal comes before the activations are
 * even read. Off the sandbox a due row is re-validated as usual.
 */

type Row = {
  id: string;
  last_validated_at: string | null;
  license_key: string;
  meta: Record<string, any> | null;
  package_id: string;
  status: string;
};

const mocks = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    updates: [] as Array<{ ids: string[]; values: Record<string, any> }>,
  };

  const apply = (values: Record<string, any>, ids: string[]) => {
    state.updates.push({ ids, values });

    for (const row of state.rows) {
      if (ids.includes(row.id)) Object.assign(row, values);
    }

    return { error: null };
  };

  const client = {
    from: () => ({
      select: () => ({
        in: async (column: keyof Row, values: string[]) => ({
          data: state.rows.filter((row) => values.includes(String(row[column]))).map((row) => structuredClone(row)),
          error: null,
        }),
      }),
      update: (values: Record<string, any>) => ({
        eq: async (_column: string, id: string) => apply(values, [id]),
        in: async (_column: string, ids: string[]) => apply(values, ids),
      }),
    }),
  };

  return { client, fetch: vi.fn(), getServiceRoleSupabaseClient: vi.fn(() => client), revalidateTag: vi.fn(), state };
});

vi.mock('server-only', () => ({}));

vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: mocks.revalidateTag,
}));

vi.mock('@nextblock-cms/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/db/server')>()),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

import {
  PACKAGE_ACTIVATION_CACHE_TAG,
  PACKAGE_RENEWAL_GRACE_MS,
  isPackageActivationRowValid,
} from '@nextblock-cms/db/server';
import { FREEMIUS_CREDENTIAL_FIELDS } from './freemius-license';
import { maybeRevalidatePackageActivations, resetPackageRevalidationThrottleForTests } from './revalidate-activations';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const STAMP = new Date(NOW).toISOString();
// Freemius keys carry URL-significant characters, so the query must be encoded.
const LICENSE_KEY = 'sk_7Ab+9Cd%2F;eF&x=y';
const UID = 'f'.repeat(32);

function activation(overrides: Partial<Row> = {}, nextblock: Record<string, unknown> = {}): Row {
  return {
    id: 'activation-1',
    last_validated_at: new Date(NOW - 2 * DAY).toISOString(),
    license_key: LICENSE_KEY,
    meta: {
      fm_install_id: '4815162342',
      fm_product_id: '28609',
      fm_uid: UID,
      install_id: '4815162342',
      nextblock: { activated_at: '2026-09-01T10:00:00.000Z', expiration: '2026-11-15 10:00:00', source: 'manual', ...nextblock },
    },
    package_id: 'cortex-ai',
    status: 'active',
    ...overrides,
  };
}

/** The License object `GET .../installs/{install_id}/license.json` returns. */
function license(overrides: Record<string, unknown> = {}) {
  return {
    activated: 1,
    expiration: '2027-11-15 10:00:00',
    id: '1977',
    is_block_features: true,
    is_cancelled: false,
    plan_id: '47122',
    plugin_id: '28609',
    secret_key: LICENSE_KEY,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status });
}

function freemiusError(status: number, code: string, message = '') {
  return jsonResponse(status, { error: { code, http: status, message, type: '' }, path: '', request: [] });
}

const stored = () => mocks.state.rows[0];

describe('maybeRevalidatePackageActivations', () => {
  beforeEach(() => {
    // Only Date is faked; AbortSignal.timeout keeps real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    vi.stubGlobal('fetch', mocks.fetch);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.fetch.mockReset();
    mocks.getServiceRoleSupabaseClient.mockClear();
    mocks.revalidateTag.mockReset();
    mocks.state.rows = [activation()];
    mocks.state.updates = [];
    resetPackageRevalidationThrottleForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('asks Freemius for the license active on the stored install instead of re-activating it', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license()));

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const requested = new URL(url);
    expect(`${requested.origin}${requested.pathname}`).toBe(
      'https://api.freemius.com/v1/products/28609/installs/4815162342/license.json'
    );
    expect(requested.searchParams.get('uid')).toBe(UID);
    expect(requested.searchParams.get('license_key')).toBe(LICENSE_KEY);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('keeps a valid license active and refreshes its expiration', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2027-11-15 10:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    expect(stored().last_validated_at).toBe(STAMP);
    expect(stored().meta?.nextblock).toEqual({
      activated_at: '2026-09-01T10:00:00.000Z',
      expiration: '2027-11-15 10:00:00',
      source: 'manual',
    });
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
    // The stored expiry moved, so the cached package checks are purged.
    expect(mocks.revalidateTag).toHaveBeenCalledWith(PACKAGE_ACTIVATION_CACHE_TAG, 'max');
  });

  it('marks a cancelled license expired', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ is_cancelled: true })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock).toMatchObject({ invalidated_at: STAMP, invalidation_reason: 'license_cancelled' });
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(false);
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(1);
  });

  it('marks a license past its renewal grace expired', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2026-10-01 00:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock).toMatchObject({
      expiration: '2026-10-01 00:00:00',
      invalidated_at: STAMP,
      invalidation_reason: 'license_expired',
    });
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(1);
  });

  it('keeps a paid license active while its renewal is pending', async () => {
    // Freemius shows a license as expired until the renewal lands, and retries a failed card.
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2026-10-25 00:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    expect(stored().meta?.nextblock?.expiration).toBe('2026-10-25 00:00:00');
    expect(stored().meta?.nextblock).not.toHaveProperty('invalidated_at');
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
  });

  it('ends a trial on its date, with no renewal grace', async () => {
    mocks.state.rows = [
      activation({}, { expiration: null, is_trial: true, source: 'checkout', trial_ends_at: '2026-10-28 10:00:00' }),
    ];
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2026-10-28 10:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock).toMatchObject({ invalidation_reason: 'license_expired', is_trial: true });
  });

  it('keeps a lapsed license working when its plan keeps features after expiry', async () => {
    mocks.state.rows = [activation({ status: 'expired' }, { expiration: '2026-10-01 00:00:00' })];
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, license({ expiration: '2026-10-01 00:00:00', is_block_features: false }))
    );

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    // No date ends this activation, so none is left for the local expiry check to enforce.
    expect(stored().meta?.nextblock?.expiration).toBeNull();
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
  });

  it('still ends a cancelled license when its plan keeps features after expiry', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ is_block_features: false, is_cancelled: true })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock?.invalidation_reason).toBe('license_cancelled');
  });

  it('still ends a trial when its plan keeps features after expiry', async () => {
    mocks.state.rows = [
      activation({}, { expiration: null, is_trial: true, source: 'checkout', trial_ends_at: '2026-10-28 10:00:00' }),
    ];
    mocks.fetch.mockResolvedValue(
      jsonResponse(200, license({ expiration: '2026-10-28 10:00:00', is_block_features: false }))
    );

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(false);
  });

  it.each([
    ['a verdict', () => Promise.resolve(jsonResponse(200, license()))],
    ['no verdict', () => Promise.reject(new TypeError('fetch failed'))],
  ])('removes the Freemius credentials older activations stored, on %s', async (_label, answer) => {
    const credentials = Object.fromEntries(FREEMIUS_CREDENTIAL_FIELDS.map((field) => [field, `${field}-value`]));
    const row = activation();
    mocks.state.rows = [{ ...row, meta: { ...row.meta, ...credentials } }];
    mocks.fetch.mockImplementation(answer);

    await maybeRevalidatePackageActivations();

    expect(JSON.stringify(mocks.state.rows)).not.toContain('-value');
    expect(stored().meta).toMatchObject({ fm_install_id: '4815162342', fm_uid: UID });
  });

  it('marks the row expired when Freemius reports the license or install gone', async () => {
    mocks.fetch.mockResolvedValue(freemiusError(404, 'not_found', 'The requested resource was not found.'));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock).toMatchObject({ invalidation_reason: 'not_found' });
  });

  it.each([
    [
      'an already-activated error',
      () => Promise.resolve(freemiusError(400, 'license_activated', 'License is already activated on the given install.')),
    ],
    ['a 5xx', () => Promise.resolve(freemiusError(503, 'service_unavailable', 'Down for maintenance.'))],
    ['a rate limit', () => Promise.resolve(freemiusError(429, 'rate_limit_exceeded'))],
    [
      "nginx's bare 403 page",
      () => Promise.resolve(new Response('<html><h1>403 Forbidden</h1></html>', { headers: { 'Content-Type': 'text/html' }, status: 403 })),
    ],
    ['a 200 that is not a license', () => Promise.resolve(jsonResponse(200, { api: 'pong' }))],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('leaves the row untouched on %s', async (_label, answer) => {
    const before = structuredClone(stored());
    mocks.fetch.mockImplementation(answer);

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Only the up-front stamp is written, so the row is asked again the next day.
    expect(mocks.state.updates).toEqual([{ ids: [before.id], values: { last_validated_at: STAMP } }]);
    expect(stored()).toEqual({ ...before, last_validated_at: STAMP });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it('skips rows without a usable Freemius install id', async () => {
    mocks.state.rows = [
      // Sandbox-seeded: no Freemius handle at all.
      { ...activation(), id: 'sandbox', meta: {} },
      activation({ id: 'no-install', meta: { fm_product_id: '28609', fm_uid: UID, nextblock: { source: 'manual' } } }),
      // Ids go into the URL path, so anything but digits is refused.
      activation({ id: 'path', meta: { ...activation().meta, fm_install_id: '1/../../../users/1' } }),
    ];

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.state.updates).toEqual([]);
  });

  it('flips an expired row back to active when the same key was renewed', async () => {
    mocks.state.rows = [
      activation({
        meta: {
          ...activation().meta,
          // A Freemius date an older activation spread into meta; it must not outvote the renewal.
          expiration: '2026-10-15 10:00:00',
          nextblock: {
            expiration: '2026-10-15 10:00:00',
            invalidated_at: '2026-10-16T09:00:00.000Z',
            invalidation_reason: 'license_expired',
            source: 'manual',
          },
        },
        status: 'expired',
      }),
    ];
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2027-10-15 10:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    expect(stored().meta?.expiration).toBe('2027-10-15 10:00:00');
    expect(stored().meta?.nextblock).toEqual({ expiration: '2027-10-15 10:00:00', source: 'manual' });
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(1);
  });

  it('keeps the original invalidation date while a license stays expired', async () => {
    mocks.state.rows = [
      activation(
        { status: 'expired' },
        {
          expiration: '2026-10-15 10:00:00',
          invalidated_at: '2026-10-16T09:00:00.000Z',
          invalidation_reason: 'license_expired',
        }
      ),
    ];
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2026-10-15 10:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('expired');
    expect(stored().meta?.nextblock).toMatchObject({ invalidated_at: '2026-10-16T09:00:00.000Z' });
  });

  it('drops the trial marker once the license runs past the trial', async () => {
    mocks.state.rows = [
      activation({}, { expiration: null, is_trial: true, source: 'checkout', trial_ends_at: '2026-10-28 10:00:00' }),
    ];
    // Left alone, the recorded trial end would lock the package although the buyer paid.
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(false);
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2027-10-28 10:00:00' })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    expect(stored().meta?.nextblock).toMatchObject({
      expiration: '2027-10-28 10:00:00',
      is_trial: false,
      source: 'checkout',
      trial_ends_at: null,
    });
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
  });

  it('keeps the trial marker while the license still ends with the trial', async () => {
    mocks.state.rows = [
      activation({}, { expiration: null, is_trial: true, source: 'checkout', trial_ends_at: '2026-11-12 10:00:00' }),
    ];
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: '2026-11-12 10:00:05' })));

    await maybeRevalidatePackageActivations();

    expect(stored().meta?.nextblock).toMatchObject({
      expiration: '2026-11-12 10:00:05',
      is_trial: true,
      trial_ends_at: '2026-11-12 10:00:00',
    });
  });

  it('treats a null expiration as a lifetime license', async () => {
    mocks.state.rows = [activation({}, { expiration: '2026-10-28 10:00:00' })];
    mocks.fetch.mockResolvedValue(jsonResponse(200, license({ expiration: null })));

    await maybeRevalidatePackageActivations();

    expect(stored().status).toBe('active');
    expect(stored().meta?.nextblock?.expiration).toBeNull();
    expect(isPackageActivationRowValid(stored(), NOW)).toBe(true);
  });

  it('asks once a day, and again the moment a row stops counting', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, license()));
    mocks.state.rows = [activation({ last_validated_at: new Date(NOW - HOUR).toISOString() })];

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.state.updates).toEqual([]);

    // The renewal grace ran out half an hour ago, after the last check.
    resetPackageRevalidationThrottleForTests();
    mocks.state.rows = [
      activation(
        { last_validated_at: new Date(NOW - HOUR).toISOString() },
        { expiration: new Date(NOW - PACKAGE_RENEWAL_GRACE_MS - HOUR / 2).toISOString() }
      ),
    ];

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(stored().status).toBe('active');
  });

  it('reads the table once per interval, however many requests ask', async () => {
    mocks.fetch.mockImplementation(async () => jsonResponse(200, license()));

    await maybeRevalidatePackageActivations();

    mocks.state.rows = [activation({ id: 'activation-2' })];

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 11 * 60_000);

    await maybeRevalidatePackageActivations();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('asks Freemius nothing on the sandbox and reads no activation', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await maybeRevalidatePackageActivations();

    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.state.updates).toEqual([]);
  });

  it.each(['', 'false', 'TRUE', '1'])(
    're-validates a due activation off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j)',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.fetch.mockResolvedValue(jsonResponse(200, license()));

      await maybeRevalidatePackageActivations();

      expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('https://api.freemius.com/v1/products/28609/installs/4815162342/license.json?');
      expect(init).toMatchObject({ method: 'GET' });
    }
  );
});
