import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The payment mode an attributed order records comes from the Stripe secret key that creates the
 * checkout session: a test key's sales must only ever be paid out by test-mode transfers.
 */

const mocks = vi.hoisted(() => ({ key: null as string | null, fail: false }));

vi.mock('../payment-config', () => ({
  resolveStripeSecretKey: async () => {
    if (mocks.fail) throw new Error('site_settings unreachable');
    return mocks.key;
  },
}));

import { resolveStripeKeyLivemode, stripeSecretKeyLivemode } from './client';

beforeEach(() => {
  mocks.key = null;
  mocks.fail = false;
});

describe('stripeSecretKeyLivemode', () => {
  it('reads the mode from the documented key prefixes', () => {
    expect(stripeSecretKeyLivemode('sk_live_51abc')).toBe(true);
    expect(stripeSecretKeyLivemode('rk_live_51abc')).toBe(true);
    expect(stripeSecretKeyLivemode('sk_test_51abc')).toBe(false);
    expect(stripeSecretKeyLivemode('rk_test_51abc')).toBe(false);
    expect(stripeSecretKeyLivemode('  sk_test_51abc  ')).toBe(false);
  });

  it.each([null, undefined, '', 'pk_live_51abc', 'whsec_abc', 'sk_51abc', 'SK_LIVE_51abc'])('is null for %s', (key) => {
    expect(stripeSecretKeyLivemode(key)).toBeNull();
  });
});

describe('resolveStripeKeyLivemode', () => {
  it('reads the configured key', async () => {
    mocks.key = 'sk_live_51abc';
    await expect(resolveStripeKeyLivemode()).resolves.toBe(true);
    mocks.key = 'sk_test_51abc';
    await expect(resolveStripeKeyLivemode()).resolves.toBe(false);
  });

  it('is null when no key is configured or it cannot be read', async () => {
    await expect(resolveStripeKeyLivemode()).resolves.toBeNull();
    mocks.fail = true;
    await expect(resolveStripeKeyLivemode()).resolves.toBeNull();
  });
});
