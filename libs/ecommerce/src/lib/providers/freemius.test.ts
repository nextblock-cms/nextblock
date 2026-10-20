import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mocks.from }),
}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
}));
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) =>
    `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));
vi.mock('server-only', () => ({}));

import type { CartItem } from '../types';
import { FreemiusProvider } from './freemius';

const PRODUCT_D = 'b3367bed-2d2e-459f-856c-9c5568fd8266';

function digitalLine(quantity: unknown): CartItem {
  return {
    id: PRODUCT_D,
    product_id: PRODUCT_D,
    title: 'Cortex AI - Pro',
    slug: 'cortex-ai-pro',
    sku: 'FM-28609-47122',
    price: 25000,
    language_id: 1,
    translation_group_id: 'g1',
    product_type: 'digital',
    provider: 'freemius',
    quantity,
  } as CartItem;
}

describe('FreemiusProvider.createCheckoutSession quantities', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    mocks.from.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['a negative quantity', -1],
    ['a zero quantity', 0],
    ['a fractional quantity', 0.5],
    ['an absurd quantity', 1_000_000],
  ])('rejects %s before touching the database', async (_label, quantity) => {
    const result = await new FreemiusProvider().createCheckoutSession({
      items: [digitalLine(quantity)],
      billingAddress: { recipient_name: 'Guest', country_code: 'CA' },
    });

    expect(result).toEqual({
      url: null,
      error: 'Your checkout items could not be processed.',
      errorKey: 'ecommerce.checkout_invalid_items',
      errorStatus: 400,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
