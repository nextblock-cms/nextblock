import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PayPal payouts file route (02036) hands the CSV over as a private, uncached attachment, and
 * passes the admin check and every refusal of lib/affiliates/manual-payouts.ts through as a fixed
 * sentence with its status.
 */

const mocks = vi.hoisted(() => ({ build: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('../../../../../lib/affiliates/manual-payouts', () => ({ buildAffiliatePayPalPayoutsFileNow: mocks.build }));

import { GET, dynamic, runtime } from './route';

const URL_BASE = 'https://shop.example.org/cms/affiliates/payouts/paypal';

beforeEach(() => {
  mocks.build.mockReset();
});

describe('GET /cms/affiliates/payouts/paypal', () => {
  it('runs on Node, dynamically', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('answers the CSV as a private attachment named for the currency and the day', async () => {
    mocks.build.mockResolvedValueOnce({
      ok: true,
      csv: 'jane@paypal.example,30.00,CAD,jane,Maple Shop partner commissions (2 orders),PAYPAL\r\n',
      count: 1,
      truncated: false,
      filename: 'paypal-payouts-cad-2026-11-11.csv',
    });

    const response = await GET(new Request(`${URL_BASE}?currency=CAD`));

    expect(mocks.build).toHaveBeenCalledWith('CAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="paypal-payouts-cad-2026-11-11.csv"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('jane@paypal.example,30.00,CAD');
  });

  it('passes a refusal through as plain text with its status, and an absent currency as an empty one', async () => {
    mocks.build.mockResolvedValueOnce({ ok: false, status: 403, error: 'Only administrators can download the payouts file.' });
    const forbidden = await GET(new Request(URL_BASE));
    expect(mocks.build).toHaveBeenCalledWith('');
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(forbidden.headers.get('cache-control')).toBe('private, no-store');
    expect(await forbidden.text()).toBe('Only administrators can download the payouts file.');
  });
});
