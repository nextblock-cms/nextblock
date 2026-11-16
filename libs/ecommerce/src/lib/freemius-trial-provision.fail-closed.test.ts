import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 2026-11-13 (vendor license routes, L3): the one-trial-per-email rule fails closed.
 *
 * - The eligibility lookup refuses with 502 whenever Freemius does not answer it conclusively: a
 *   non-2xx, a network error, or a 2xx that is not the list it asked for. "This email holds no
 *   license" is never read from a failed lookup. Before, the bearer path asked through
 *   `@freemius/sdk`'s `retrieveByEmail` / `retrieveLicenses`, which return null and [] for ANY failure,
 *   and the developer path read a 2xx without a list as an empty one: either way a trial was minted.
 * - A license minted whose assignment failed belongs to no Freemius user, so the email's lookup
 *   cannot show it: the same email could mint again on every request. The instance now refuses it
 *   while that license stands at Freemius.
 */

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}), isSandboxEnvironment };
});
vi.mock('./payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.candidates,
}));

import { forgetFreemiusDeveloperCaches } from './freemius-developer-api';
import { provisionFreemiusTrialLicense } from './freemius-trial-provision';

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_trial_provision', secretKey: 'sk_dev_trial_provision', source: 'env' };
/** The bearer path's keys (FREEMIUS_CHECKOUT_PRODUCTS_JSON); the SDK wants a 32+ character secret. */
const BEARER = { publicKey: 'pk_cortex_bearer', secretKey: 'sk_cortex_bearer_secret_key_0123456789', apiKey: 'fs_bearer_api_token' };
const NOW = new Date('2026-11-13T12:00:00Z');

type Call = { method: string; host: string; path: string; query: URLSearchParams };
type Answer = { status: number; body?: unknown } | 'network-error';

let emailCounter = 0;

/** A fresh email per trial, so the instance's memory of one test never decides another. */
function trialFor(label: string) {
  emailCounter += 1;
  return { email: `${label}-${emailCounter}@example.com`, name: 'Agent Smith', planId: '47122', productId: '28609', trialDays: 30 };
}

/**
 * api.freemius.com (developer scope, paths relative to the developer) and fast-api.freemius.com (the
 * SDK's bearer client, paths without /v1). The developer account lists product 28609; every other
 * request answers `answer`, else a 404.
 */
function stubFreemius(answer: (call: Call) => Answer | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const developerPrefix = `/v1/developers/${DEV}`;
    const call: Call = {
      method: (request ? request.method : init.method) ?? 'GET',
      host: url.host,
      path: url.pathname.startsWith(developerPrefix) ? url.pathname.slice(developerPrefix.length) : url.pathname.replace(/^\/v1/, ''),
      query: url.searchParams,
    };
    calls.push(call);

    const custom = answer(call);

    if (custom === 'network-error') {
      throw new TypeError('fetch failed');
    }

    const result =
      custom ??
      (call.host === 'api.freemius.com' && call.path === '/plugins.json'
        ? { status: 200, body: { plugins: [{ id: 28609 }] } }
        : { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } });

    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** A whole trial at developer scope: no user yet, a single-site pricing, a minted license 999, then `overrides`. */
function developerTrial(overrides: (call: Call) => Answer | undefined = () => undefined) {
  return stubFreemius((call) => {
    const custom = overrides(call);
    if (custom) return custom;
    if (call.path === '/plugins/28609/users.json') return { status: 200, body: { users: [] } };
    if (call.path === '/plugins/28609/plans/47122/pricing.json') return { status: 200, body: { pricing: [{ id: 110047, licenses: 1 }] } };
    if (call.method === 'POST') return { status: 201, body: { id: 999, secret_key: 'sk_trial_license_999' } };
    if (call.method === 'PUT') return { status: 200, body: {} };
    return undefined;
  });
}

/** The same trial with the product's bearer token (no developer pair). */
function bearerTrial(overrides: (call: Call) => Answer | undefined = () => undefined) {
  return stubFreemius((call) => {
    const custom = overrides(call);
    if (custom) return custom;
    if (call.host !== 'fast-api.freemius.com') return undefined;
    if (call.path === '/products/28609/users.json') return { status: 200, body: { users: [] } };
    if (call.path === '/products/28609/plans/47122/pricing.json') return { status: 200, body: { pricing: [{ id: 110047, licenses: 1 }] } };
    if (call.method === 'POST') return { status: 201, body: { license: { id: 999, secret_key: 'sk_trial_license_999' } } };
    if (call.method === 'PUT') return { status: 200, body: {} };
    return undefined;
  });
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_API_KEY', 'FREEMIUS_PRODUCT_ID']) {
    vi.stubEnv(name, '');
  }
  forgetFreemiusDeveloperCaches();
  mocks.candidates.mockReset().mockImplementation(async () => [PAIR]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the eligibility lookup at developer scope fails closed', () => {
  it.each<[string, (call: Call) => Answer | undefined]>([
    ['a 500 on the user lookup', (call) => (call.path === '/plugins/28609/users.json' ? { status: 500, body: {} } : undefined)],
    ['a 429 on the user lookup', (call) => (call.path === '/plugins/28609/users.json' ? { status: 429, body: {} } : undefined)],
    ['a network error on the user lookup', (call) => (call.path === '/plugins/28609/users.json' ? 'network-error' : undefined)],
    ['a 2xx without a user list', (call) => (call.path === '/plugins/28609/users.json' ? { status: 200, body: {} } : undefined)],
    ['a 2xx whose users is not a list', (call) => (call.path === '/plugins/28609/users.json' ? { status: 200, body: { users: { id: 5 } } } : undefined)],
    ['an empty 2xx', (call) => (call.path === '/plugins/28609/users.json' ? { status: 200 } : undefined)],
    ['a listed user without an id', (call) => (call.path === '/plugins/28609/users.json' ? { status: 200, body: { users: [{ email: 'x' }] } } : undefined)],
    [
      'a listed user with another email',
      (call) => (call.path === '/plugins/28609/users.json' ? { status: 200, body: { users: [{ id: 501, email: 'someone@else.com' }] } } : undefined),
    ],
    [
      'a 2xx without a license list for an existing user',
      (call) =>
        call.path === '/plugins/28609/users.json'
          ? { status: 200, body: { users: [{ id: 501 }] } }
          : call.path === '/plugins/28609/users/501/licenses.json'
            ? { status: 200, body: { licenses: null } }
            : undefined,
    ],
    [
      'a 500 on the license lookup',
      (call) =>
        call.path === '/plugins/28609/users.json'
          ? { status: 200, body: { users: [{ id: 501 }] } }
          : call.path === '/plugins/28609/users/501/licenses.json'
            ? { status: 500, body: {} }
            : undefined,
    ],
  ])('%s: 502, nothing minted', async (_label, failure) => {
    const { calls } = developerTrial(failure);

    await expect(provisionFreemiusTrialLicense(trialFor('developer-lookup'), { now: NOW })).resolves.toEqual({
      error: 'Freemius could not be reached to verify eligibility.',
      ok: false,
      reason: 'upstream_error',
      status: 502,
    });
    expect(writes(calls)).toEqual([]);
  });

  it('still mints for an email Freemius answers has no user, and refuses one that holds a license', async () => {
    const { calls } = developerTrial();

    await expect(provisionFreemiusTrialLicense(trialFor('developer-new'), { now: NOW })).resolves.toMatchObject({
      ok: true,
      assigned: true,
      licenseKey: 'sk_trial_license_999',
    });
    expect(writes(calls).map((call) => call.method)).toEqual(['POST', 'PUT']);

    const owned = developerTrial((call) =>
      call.path === '/plugins/28609/users.json'
        ? { status: 200, body: { users: [{ id: 501, email: 'ignored-case@example.com' }] } }
        : call.path === '/plugins/28609/users/501/licenses.json'
          ? { status: 200, body: { licenses: [{ id: 1, plugin_id: 28609 }] } }
          : undefined
    );

    await expect(
      provisionFreemiusTrialLicense({ ...trialFor('unused'), email: 'Ignored-Case@Example.com' }, { now: NOW })
    ).resolves.toMatchObject({ ok: false, reason: 'already_licensed', status: 409 });
    expect(writes(owned.calls)).toEqual([]);
  });
});

describe('the eligibility lookup with the product bearer fails closed', () => {
  beforeEach(() => {
    mocks.candidates.mockImplementation(async () => []);
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': BEARER }));
  });

  it.each<[string, (call: Call) => Answer | undefined, Record<string, unknown>]>([
    [
      'a 500 on the user lookup',
      (call) => (call.path === '/products/28609/users.json' ? { status: 500, body: {} } : undefined),
      { reason: 'upstream_error', status: 502 },
    ],
    [
      'a 429 on the user lookup',
      (call) => (call.path === '/products/28609/users.json' ? { status: 429, body: {} } : undefined),
      { reason: 'upstream_error', status: 502 },
    ],
    [
      'a network error on the user lookup',
      (call) => (call.path === '/products/28609/users.json' ? 'network-error' : undefined),
      { reason: 'upstream_error', status: 502 },
    ],
    [
      'a 2xx without a user list',
      (call) => (call.path === '/products/28609/users.json' ? { status: 200, body: { users: 'none' } } : undefined),
      { reason: 'upstream_error', status: 502 },
    ],
    [
      'a 2xx without a license list for an existing user',
      (call) =>
        call.path === '/products/28609/users.json'
          ? { status: 200, body: { users: [{ id: 501 }] } }
          : call.path === '/products/28609/users/501/licenses.json'
            ? { status: 200, body: {} }
            : undefined,
      { reason: 'upstream_error', status: 502 },
    ],
    [
      'a 401 on the user lookup (a wrong bearer token)',
      (call) => (call.path === '/products/28609/users.json' ? { status: 401, body: {} } : undefined),
      { reason: 'not_configured', status: 503 },
    ],
  ])('%s: refused, nothing minted', async (_label, failure, expected) => {
    const { calls } = bearerTrial(failure);

    await expect(provisionFreemiusTrialLicense(trialFor('bearer-lookup'), { now: NOW })).resolves.toMatchObject({ ok: false, ...expected });
    expect(writes(calls)).toEqual([]);
    expect(calls.every((call) => call.host === 'fast-api.freemius.com')).toBe(true);
  });

  it('still mints for an email Freemius answers has no user, with the bearer token', async () => {
    const { calls } = bearerTrial();

    await expect(provisionFreemiusTrialLicense(trialFor('bearer-new'), { now: NOW })).resolves.toMatchObject({
      ok: true,
      assigned: true,
      licenseKey: 'sk_trial_license_999',
    });
    expect(writes(calls).map((call) => call.method)).toEqual(['POST', 'PUT']);
    expect(calls.find((call) => call.path === '/products/28609/users.json')?.query.get('email')).toMatch(/^bearer-new-\d+@example\.com$/);
  });
});

describe('a minted license whose assignment failed', () => {
  it('refuses the same email while that license stands, then lets it start over once Freemius drops it', async () => {
    const trial = trialFor('unassigned');
    let licenseState: Answer = { status: 200, body: { id: 999, plugin_id: 28609, is_cancelled: false } };
    const { calls } = developerTrial((call) => {
      if (call.method === 'PUT') return { status: 500, body: {} };
      if (call.path === '/plugins/28609/licenses/999.json') return licenseState;
      return undefined;
    });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: false, licenseKey: 'sk_trial_license_999' });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(1);

    // The email's own lookup still finds no user (the assignment never created one): refused anyway.
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toEqual({
      error: expect.stringContaining('already exists for this email'),
      ok: false,
      reason: 'already_licensed',
      status: 409,
    });
    await expect(provisionFreemiusTrialLicense({ ...trial, email: trial.email.toUpperCase() }, { now: NOW })).resolves.toMatchObject({
      reason: 'already_licensed',
    });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(1);

    // While Freemius cannot say whether the license stands: 502, nothing minted.
    licenseState = { status: 503, body: {} };
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ reason: 'upstream_error', status: 502 });
    licenseState = { status: 200 };
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ reason: 'upstream_error', status: 502 });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(1);

    // The operator cancelled it at Freemius: the email may mint again (once more here, as the
    // assignment still fails), and the new license (live) is refused in turn.
    licenseState = { status: 200, body: { id: 999, plugin_id: 28609, is_cancelled: true } };
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: false });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(2);
    licenseState = { status: 200, body: { id: 999, plugin_id: 28609, is_cancelled: false } };
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ reason: 'already_licensed' });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(2);

    // Deleted (404): the same.
    licenseState = { status: 404, body: { error: { code: 'license_not_found' } } };
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: false });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(3);
  });

  it('refuses the same email with the bearer path too, and never remembers an assigned trial', async () => {
    mocks.candidates.mockImplementation(async () => []);
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': BEARER }));
    const trial = trialFor('bearer-unassigned');
    let assignStatus = 500;
    const { calls } = bearerTrial((call) => {
      if (call.method === 'PUT') return { status: assignStatus, body: {} };
      if (call.path === '/products/28609/licenses/999.json') return { status: 200, body: { id: 999, plugin_id: 28609, is_cancelled: false } };
      return undefined;
    });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: false });
    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'already_licensed', status: 409 });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(1);

    expect(calls.filter((call) => call.path === '/products/28609/licenses/999.json')).toHaveLength(1);

    // Another email whose assignment works is not remembered: Freemius' own lookup decides its next
    // request (this stub keeps answering "no user", so it mints again).
    assignStatus = 200;
    const other = trialFor('bearer-assigned');
    await expect(provisionFreemiusTrialLicense(other, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: true });
    await expect(provisionFreemiusTrialLicense(other, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: true });
    expect(writes(calls).filter((call) => call.method === 'POST')).toHaveLength(3);
    expect(calls.filter((call) => call.path === '/products/28609/licenses/999.json')).toHaveLength(1);
  });
});
