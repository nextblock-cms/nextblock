import { describe, expect, it, vi } from 'vitest';

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({}),
}));
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number) => String(amount),
  getCurrencyMinorUnitFactor: () => 100,
}));
vi.mock('server-only', () => ({}));

import { evaluateFreemiusCheckoutLicense, syncFreemiusCheckoutOrder } from './freemius-order-sync';

// 2026-10-21: the public checkout-sync route stored whatever license id the browser sent, and
// the success page then showed that license's key, so any guest could harvest other customers'
// keys by id. A license is now linked only after Freemius confirms it is this order's own.

const NOW = new Date('2026-10-21T15:00:00Z');
const order = {
  created_at: '2026-10-21T14:55:00Z',
  freemius_license_id: null,
  freemius_product_id: '111',
};
const freshLicense = {
  activated: 0,
  created: '2026-10-21 14:57:00',
  id: 5001,
  is_cancelled: false,
  plan_id: 9,
  plugin_id: 111,
  secret_key: 'sk_buyer',
  user_id: 77,
};
const buyer = { email: 'Buyer@Example.com', id: 77 };
const base = {
  callbackEmail: 'buyer@example.com',
  callbackUserId: '77',
  license: freshLicense,
  licenseId: '5001',
  linkedToOtherOrder: false,
  now: NOW,
  order,
  user: buyer,
};

describe('evaluateFreemiusCheckoutLicense', () => {
  it('accepts the buyer own fresh license for this order product', () => {
    expect(evaluateFreemiusCheckoutLicense(base)).toEqual({ ok: true });
  });

  it('refuses another customer older license (the key-harvesting attack)', () => {
    const victim = { ...freshLicense, created: '2026-09-01 10:00:00', id: 4000, user_id: 12 };
    expect(evaluateFreemiusCheckoutLicense({ ...base, license: victim, licenseId: '4000' })).toMatchObject({ ok: false });
    // even with the victim user id and email guessed, a license older than the order is refused
    expect(
      evaluateFreemiusCheckoutLicense({
        ...base,
        callbackUserId: '12',
        license: { ...victim, created: '2026-10-21 14:40:00' },
        licenseId: '4000',
        user: { email: 'buyer@example.com', id: 12 },
      }),
    ).toEqual({ ok: false, reason: 'license_predates_order' });
  });

  it('refuses another product, user or email, an activated license, or one linked elsewhere', () => {
    expect(evaluateFreemiusCheckoutLicense({ ...base, license: { ...freshLicense, plugin_id: 222 } })).toEqual({ ok: false, reason: 'product_mismatch' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, callbackUserId: '78' })).toEqual({ ok: false, reason: 'user_mismatch' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, callbackEmail: 'other@example.com' })).toEqual({ ok: false, reason: 'email_mismatch' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, license: { ...freshLicense, activated: 1 } })).toEqual({ ok: false, reason: 'already_activated' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, linkedToOtherOrder: true })).toEqual({ ok: false, reason: 'license_linked_to_other_order' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, order: { ...order, freemius_license_id: '4999' } })).toEqual({ ok: false, reason: 'order_has_other_license' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, licenseId: null })).toEqual({ ok: false, reason: 'no_license_in_callback' });
    expect(evaluateFreemiusCheckoutLicense({ ...base, order: { ...order, freemius_product_id: null } })).toEqual({ ok: false, reason: 'missing_order_product' });
  });
});

/** Just enough of the Supabase query builder for the sync's three queries. */
function fakeOrdersClient(row: Record<string, unknown>, otherOrdersWithLicense: string[] = []) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from: () => {
      const chain: Record<string, any> = { license: null, pendingUpdate: null };
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'freemius_license_id') chain.license = value;
          if (chain.pendingUpdate) {
            updates.push(chain.pendingUpdate);
            return Promise.resolve({ error: null });
          }
          return chain;
        },
        neq: () => chain,
        limit: () =>
          Promise.resolve({
            data: chain.license && otherOrdersWithLicense.includes(chain.license) ? [{ id: 'other' }] : [],
            error: null,
          }),
        single: () => Promise.resolve({ data: row, error: null }),
        update: (values: Record<string, unknown>) => {
          chain.pendingUpdate = values;
          return chain;
        },
      });
      return chain;
    },
  };
  return { client: client as any, updates };
}

const pendingOrder = { id: 'o1', status: 'pending', provider: 'freemius', ...order };

describe('syncFreemiusCheckoutOrder', () => {
  it('refuses a forged callback naming another customer license, writing nothing', async () => {
    const { client, updates } = fakeOrdersClient(pendingOrder);
    const retrieveLicense = vi.fn(async () => ({
      ok: true as const,
      license: { ...freshLicense, created: '2026-09-01 10:00:00', id: 4000, user_id: 12 },
      user: { email: 'victim@example.com', id: 12 },
    }));
    const result = await syncFreemiusCheckoutOrder({
      orderId: 'o1',
      checkoutResponse: { trial: { license_id: '4000', plugin_id: '999' } },
      client,
      retrieveLicense,
      now: NOW,
    });
    expect(result.success).toBe(false);
    // looked up under the ORDER product, never the callback plugin_id
    expect(retrieveLicense).toHaveBeenCalledWith('111', '4000');
    expect(updates).toEqual([]);
  });

  it('links a verified license and keeps the order product id, never the callback one', async () => {
    const { client, updates } = fakeOrdersClient(pendingOrder);
    const result = await syncFreemiusCheckoutOrder({
      orderId: 'o1',
      checkoutResponse: {
        trial: { license_id: '5001', plugin_id: '999' },
        user: { id: 77, email: 'buyer@example.com' },
      },
      client,
      retrieveLicense: async () => ({ ok: true as const, license: freshLicense, user: buyer }),
      now: NOW,
    });
    expect(result.success).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ freemius_license_id: '5001', freemius_product_id: '111', status: 'trial' });
  });

  it('refuses when Freemius cannot be reached or the license is already on another order', async () => {
    const callback = { trial: { license_id: '5001' }, user: { id: 77, email: 'buyer@example.com' } };
    const down = fakeOrdersClient(pendingOrder);
    const downResult = await syncFreemiusCheckoutOrder({
      orderId: 'o1',
      checkoutResponse: callback,
      client: down.client,
      retrieveLicense: async () => ({ ok: false as const, reason: 'upstream_error' as const }),
      now: NOW,
    });
    const taken = fakeOrdersClient(pendingOrder, ['5001']);
    const takenResult = await syncFreemiusCheckoutOrder({
      orderId: 'o1',
      checkoutResponse: callback,
      client: taken.client,
      retrieveLicense: async () => ({ ok: true as const, license: freshLicense, user: buyer }),
      now: NOW,
    });
    expect(downResult.success).toBe(false);
    expect(takenResult.success).toBe(false);
    expect(down.updates).toEqual([]);
    expect(taken.updates).toEqual([]);
  });

  it('refuses a callback with no license at all instead of trusting its trial flag', async () => {
    const { client, updates } = fakeOrdersClient(pendingOrder);
    const result = await syncFreemiusCheckoutOrder({
      orderId: 'o1',
      checkoutResponse: { trial: { id: 1 } },
      client,
      retrieveLicense: async () => {
        throw new Error('must not be called');
      },
      now: NOW,
    });
    expect(result.success).toBe(false);
    expect(updates).toEqual([]);
  });
});
