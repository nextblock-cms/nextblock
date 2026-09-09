import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProductRow = {
  product_type: 'physical' | 'digital';
  status: 'active' | 'draft';
};

const mocks = vi.hoisted(() => ({
  getStoreReadiness: vi.fn(),
  verifyPackageOnline: vi.fn(),
  products: [] as ProductRow[],
}));

vi.mock('server-only', () => ({}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getStoreReadiness: mocks.getStoreReadiness,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: mocks.verifyPackageOnline,
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'admin-1' } } }),
    },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { role: 'ADMIN' } }),
            }),
          }),
        };
      }

      if (table === 'products') {
        return {
          select: () => {
            const filters: Array<(product: ProductRow) => boolean> = [];
            const query = {
              eq(column: keyof ProductRow, value: string) {
                filters.push((product) => product[column] === value);
                return query;
              },
              then(onFulfilled: (value: { count: number }) => unknown) {
                const count = mocks.products.filter((product) =>
                  filters.every((filter) => filter(product)),
                ).length;
                return Promise.resolve({ count }).then(onFulfilled);
              },
            };
            return query;
          },
        };
      }

      throw new Error(`Unexpected table in test: ${table}`);
    },
  }),
}));

import { getPaymentsReminder } from './payments-reminder';

function providerReadiness({
  stripeReady,
  freemiusReady,
}: {
  stripeReady: boolean;
  freemiusReady: boolean;
}) {
  return {
    stripe: {
      provider: 'stripe',
      label: 'Stripe',
      enabled: true,
      hasKeys: stripeReady,
      ready: stripeReady,
      missing: stripeReady ? [] : ['Secret key'],
    },
    freemius: {
      provider: 'freemius',
      label: 'Freemius',
      enabled: true,
      hasKeys: freemiusReady,
      ready: freemiusReady,
      missing: freemiusReady ? [] : ['Secret key'],
    },
  };
}

describe('CMS payments reminder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.products.length = 0;
    mocks.verifyPackageOnline.mockResolvedValue(true);
  });

  it('ignores an unconfigured Stripe toggle when the store has only digital products', async () => {
    mocks.products.push({ product_type: 'digital', status: 'active' });
    mocks.getStoreReadiness.mockResolvedValue(
      providerReadiness({ stripeReady: false, freemiusReady: true }),
    );

    await expect(getPaymentsReminder()).resolves.toBeNull();
  });

  it('warns about Stripe when any physical product needs it', async () => {
    mocks.products.push({ product_type: 'physical', status: 'draft' });
    mocks.getStoreReadiness.mockResolvedValue(
      providerReadiness({ stripeReady: false, freemiusReady: true }),
    );

    await expect(getPaymentsReminder()).resolves.toEqual({
      blocked: [
        { provider: 'stripe', label: 'Stripe', missing: ['Secret key'] },
      ],
      affectedProducts: 0,
    });
  });

  it('warns about Freemius when a digital product needs it', async () => {
    mocks.products.push({ product_type: 'digital', status: 'active' });
    mocks.getStoreReadiness.mockResolvedValue(
      providerReadiness({ stripeReady: true, freemiusReady: false }),
    );

    await expect(getPaymentsReminder()).resolves.toEqual({
      blocked: [
        { provider: 'freemius', label: 'Freemius', missing: ['Secret key'] },
      ],
      affectedProducts: 1,
    });
  });
});
