import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOrderAttributionColumns,
  insertPendingOrderWithAttribution,
  isMissingOrderAttributionColumnError,
  isOrderAttributionInsertError,
} from './customer';

/**
 * Attribution rides on the pending-order insert of both providers, so it must never cost a sale:
 * malformed values are dropped before the insert, and a database that lacks or refuses the
 * columns gets the order again without them.
 */

const AFFILIATE_ID = '11111111-1111-4111-8111-111111111111';
const ROW = { status: 'pending', total: 2500, currency: 'USD', provider: 'stripe' };

type InsertResult = { data: { id: string } | null; error: unknown };

function recorder(responses: InsertResult[]) {
  const rows: Array<Record<string, unknown>> = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    rows.push(row);
    return responses[Math.min(rows.length - 1, responses.length - 1)];
  });
  return { insert, rows };
}

const ok: InsertResult = { data: { id: 'order-1' }, error: null };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildOrderAttributionColumns', () => {
  it('maps an attribution onto the orders columns, normalizing case', () => {
    expect(
      buildOrderAttributionColumns({ affiliateId: AFFILIATE_ID.toUpperCase(), source: 'storefront', baseCurrency: 'cad' })
    ).toEqual({ affiliate_id: AFFILIATE_ID, affiliate_source: 'storefront', affiliate_base_currency: 'CAD', affiliate_livemode: null });
  });

  it('records the payment mode of the checkout: live, test, or unknown (null)', () => {
    const attribution = { affiliateId: AFFILIATE_ID, source: 'storefront' as const, baseCurrency: 'USD' };
    expect(buildOrderAttributionColumns(attribution, true)).toMatchObject({ affiliate_livemode: true });
    expect(buildOrderAttributionColumns(attribution, false)).toMatchObject({ affiliate_livemode: false });
    expect(buildOrderAttributionColumns(attribution, null)).toMatchObject({ affiliate_livemode: null });
    expect(buildOrderAttributionColumns(attribution, 'false' as never)).toMatchObject({ affiliate_livemode: null });
    // No attribution, no affiliate column at all (the mode alone is never written).
    expect(buildOrderAttributionColumns(null, false)).toBeNull();
  });

  it('keeps a null or malformed base currency as null (the CHECK would refuse it)', () => {
    expect(buildOrderAttributionColumns({ affiliateId: AFFILIATE_ID, source: 'referral_link', baseCurrency: null })).toEqual({
      affiliate_id: AFFILIATE_ID,
      affiliate_source: 'referral_link',
      affiliate_base_currency: null,
      affiliate_livemode: null,
    });
    expect(
      buildOrderAttributionColumns({ affiliateId: AFFILIATE_ID, source: 'referral_link', baseCurrency: 'dollars' })
    ).toMatchObject({ affiliate_base_currency: null });
  });

  it.each([
    ['no attribution', null],
    ['a malformed affiliate id', { affiliateId: 'jane-doe', source: 'storefront', baseCurrency: 'USD' }],
    ['an unknown source', { affiliateId: AFFILIATE_ID, source: 'coupon', baseCurrency: 'USD' }],
  ])('returns null for %s', (_label, attribution) => {
    expect(buildOrderAttributionColumns(attribution as never)).toBeNull();
  });
});

describe('attribution insert errors', () => {
  it('recognizes missing columns from PostgREST and Postgres', () => {
    expect(isMissingOrderAttributionColumnError({ code: 'PGRST204' })).toBe(true);
    expect(isMissingOrderAttributionColumnError({ code: '42703' })).toBe(true);
    expect(isMissingOrderAttributionColumnError({ code: '23505' })).toBe(false);
    expect(isMissingOrderAttributionColumnError(null)).toBe(false);
  });

  it('treats constraint violations as attribution errors only when they name an affiliate column', () => {
    expect(
      isOrderAttributionInsertError({
        code: '23503',
        message: 'insert or update on table "orders" violates foreign key constraint "orders_affiliate_id_fkey"',
      })
    ).toBe(true);
    expect(isOrderAttributionInsertError({ code: '23514', message: 'violates check constraint "orders_affiliate_source_check"' })).toBe(true);
    expect(isOrderAttributionInsertError({ code: '23503', message: 'violates foreign key constraint "orders_user_id_fkey"' })).toBe(false);
    expect(isOrderAttributionInsertError({ code: '23505', message: 'duplicate key value' })).toBe(false);
  });
});

describe('insertPendingOrderWithAttribution', () => {
  it('inserts once, without affiliate keys, when there is no attribution', async () => {
    const { insert, rows } = recorder([ok]);

    const outcome = await insertPendingOrderWithAttribution({ provider: 'Stripe', row: ROW, attribution: null, insert });

    expect(outcome).toEqual({ result: ok, attributed: null });
    expect(rows).toEqual([ROW]);
  });

  it('inserts the attribution columns with the row, the payment mode included', async () => {
    const { insert, rows } = recorder([ok]);

    const outcome = await insertPendingOrderWithAttribution({
      provider: 'Stripe',
      row: ROW,
      attribution: { affiliateId: AFFILIATE_ID, source: 'storefront', baseCurrency: 'USD' },
      livemode: false,
      insert,
    });

    const columns = { affiliate_id: AFFILIATE_ID, affiliate_source: 'storefront', affiliate_base_currency: 'USD', affiliate_livemode: false };
    expect(outcome.attributed).toEqual(columns);
    expect(rows).toEqual([{ ...ROW, ...columns }]);
  });

  it('writes no payment mode without an attribution', async () => {
    const { insert, rows } = recorder([ok]);

    await insertPendingOrderWithAttribution({ provider: 'Stripe', row: ROW, attribution: null, livemode: true, insert });

    expect(rows).toEqual([ROW]);
  });

  it('retries without the columns when the database lacks them, and logs that once per process', async () => {
    const missing = { data: null, error: { code: 'PGRST204', message: "Could not find the 'affiliate_id' column of 'orders' in the schema cache" } };
    const first = recorder([missing, ok]);
    const second = recorder([{ data: null, error: { code: '42703', message: 'column "affiliate_id" does not exist' } }, ok]);
    const attribution = { affiliateId: AFFILIATE_ID, source: 'referral_link' as const, baseCurrency: 'USD' };

    const one = await insertPendingOrderWithAttribution({ provider: 'Stripe', row: ROW, attribution, insert: first.insert });
    const two = await insertPendingOrderWithAttribution({ provider: 'Freemius', row: ROW, attribution, insert: second.insert });

    expect(one).toEqual({ result: ok, attributed: null });
    expect(two).toEqual({ result: ok, attributed: null });
    expect(first.rows[1]).toEqual(ROW);
    expect(second.rows[1]).toEqual(ROW);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('retries without the columns when the partner row vanished (foreign key)', async () => {
    const { insert, rows } = recorder([
      { data: null, error: { code: '23503', message: 'violates foreign key constraint "orders_affiliate_id_fkey"' } },
      ok,
    ]);

    const outcome = await insertPendingOrderWithAttribution({
      provider: 'Stripe',
      row: ROW,
      attribution: { affiliateId: AFFILIATE_ID, source: 'storefront', baseCurrency: null },
      insert,
    });

    expect(outcome).toEqual({ result: ok, attributed: null });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(ROW);
  });

  it('returns any other insert error as is, without a second attempt', async () => {
    const failure = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    const { insert, rows } = recorder([failure, ok]);

    const outcome = await insertPendingOrderWithAttribution({
      provider: 'Stripe',
      row: ROW,
      attribution: { affiliateId: AFFILIATE_ID, source: 'storefront', baseCurrency: 'USD' },
      insert,
    });

    expect(outcome).toEqual({ result: failure, attributed: null });
    expect(rows).toHaveLength(1);
  });

  it('drops a malformed attribution before the insert instead of risking a refused row', async () => {
    const { insert, rows } = recorder([ok]);

    await insertPendingOrderWithAttribution({
      provider: 'Stripe',
      row: ROW,
      attribution: { affiliateId: "x' OR 1=1", source: 'storefront', baseCurrency: 'USD' },
      insert,
    });

    expect(rows).toEqual([ROW]);
  });
});
