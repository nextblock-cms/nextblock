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
