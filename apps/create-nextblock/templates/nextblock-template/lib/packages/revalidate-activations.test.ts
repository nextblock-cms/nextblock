import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily license re-validation re-issues Freemius `licenses/activate.json` (a POST) for every
 * active activation. The public sandbox seeds placeholder activations and every visitor is its
 * admin, so it never asks Freemius anything there: the refusal comes before the activations are
 * even read. Off the sandbox a due row is re-validated as before.
 */

const mocks = vi.hoisted(() => ({
  getServiceRoleSupabaseClient: vi.fn(),
  revalidateTag: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  PACKAGE_ACTIVATION_CACHE_TAG: 'package-activations',
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }));

import { maybeRevalidatePackageActivations } from './revalidate-activations';

const DUE_ROW = {
  id: 'activation-1',
  package_id: 'cortex-ai',
  license_key: 'sk_live_license',
  status: 'active',
  meta: { fm_uid: 'uid-1', fm_product_id: '28609' },
  last_validated_at: null,
};

/** A service-role client whose activations table holds one row that is due. */
function fakeClient() {
  const query = {
    select: () => query,
    eq: () => query,
    in: async () => ({ error: null }),
    update: () => query,
    maybeSingle: async () => ({ data: { status: 'active' }, error: null }),
    then: (resolve: (value: unknown) => void) => resolve({ data: [DUE_ROW], error: null }),
  };
  return { from: vi.fn(() => query) };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => fakeClient());
  mocks.revalidateTag.mockReset();
  mocks.fetch.mockReset().mockResolvedValue(Response.json({ expiration: null }));
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('maybeRevalidatePackageActivations', () => {
  it('asks Freemius nothing on the sandbox and reads no activation', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await maybeRevalidatePackageActivations();

    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])('re-validates a due activation off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    await maybeRevalidatePackageActivations();

    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(String(url)).toContain('https://api.freemius.com/v1/products/28609/licenses/activate.json?uid=uid-1');
    expect(init).toMatchObject({ method: 'POST' });
  });
});
