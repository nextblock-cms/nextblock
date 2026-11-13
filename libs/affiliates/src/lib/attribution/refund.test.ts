import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AffiliateRepositoryClient } from '../repository/client';
import { AffiliateRefundError, applyAffiliateRefund } from './refund';
import type { AffiliateRefundInput } from './types';

/**
 * applyAffiliateRefund is the only path from a refund webhook to the commission ledger. It must
 * hand the RPC the CUMULATIVE amounts unchanged (the SQL is monotonic), never turn a malformed
 * partial refund into a void, and fail the way the caller asked: quietly for best-effort
 * callers, loudly for webhooks that want the provider to redeliver.
 */

const ORDER_ID = '33333333-3333-4333-8333-333333333333';

function fakeRpc(answer: { data?: unknown; error?: unknown } | (() => never)) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    if (typeof answer === 'function') return answer();
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  return { supabase: { rpc } as unknown as AffiliateRepositoryClient, rpc };
}

function input(supabase: AffiliateRepositoryClient, overrides: Partial<AffiliateRefundInput> = {}): AffiliateRefundInput {
  return {
    supabase,
    gateway: 'STRIPE',
    orderId: ORDER_ID,
    refundedMinor: 2500,
    orderTotalMinor: 10000,
    full: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyAffiliateRefund', () => {
  it('voids on a full refund', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'voided' });

    await expect(applyAffiliateRefund(input(supabase, { full: true, refundedMinor: 10000 }))).resolves.toBe('voided');
    expect(rpc).toHaveBeenCalledWith('apply_affiliate_refund', {
      p_gateway: 'STRIPE',
      p_order_id: ORDER_ID,
      p_refunded_minor: 10000,
      p_order_total_minor: 10000,
      p_full: true,
    });
  });

  it('passes the cumulative amounts of a partial refund through unchanged', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'adjusted' });

    await expect(applyAffiliateRefund(input(supabase))).resolves.toBe('adjusted');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_refunded_minor: 2500, p_order_total_minor: 10000, p_full: false });
  });

  it('hands an out-of-order (lower) cumulative amount to the RPC as is: the SQL never lowers a refund', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'none' });

    await applyAffiliateRefund(input(supabase, { refundedMinor: 4000 }));
    await applyAffiliateRefund(input(supabase, { refundedMinor: 2500 }));

    expect(rpc.mock.calls.map((call) => call[1]['p_refunded_minor'])).toEqual([4000, 2500]);
  });

  it('accepts a full refund without amounts', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'voided' });

    await expect(
      applyAffiliateRefund(input(supabase, { gateway: 'freemius' as never, full: true, refundedMinor: Number.NaN, orderTotalMinor: -1 }))
    ).resolves.toBe('voided');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_gateway: 'FREEMIUS', p_refunded_minor: 0, p_order_total_minor: 0, p_full: true });
  });

  it.each([
    ['an unknown gateway', { gateway: 'PAYPAL' as never }],
    ['a malformed order id', { orderId: "1' OR 1=1" }],
    ['a partial refund without a total', { orderTotalMinor: 0 }],
    ['a partial refund with a fractional amount', { refundedMinor: 12.5 }],
    ['a partial refund of nothing', { refundedMinor: 0 }],
    ['a partial refund with a negative amount', { refundedMinor: -100 }],
  ])('answers none without calling the RPC for %s', async (_label, overrides) => {
    const { supabase, rpc } = fakeRpc({ data: 'voided' });

    await expect(applyAffiliateRefund(input(supabase, overrides))).resolves.toBe('none');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads an unexpected RPC answer as none', async () => {
    const { supabase } = fakeRpc({ data: { status: 'voided' } });

    await expect(applyAffiliateRefund(input(supabase))).resolves.toBe('none');
  });

  it('logs and answers none on an RPC error by default', async () => {
    const { supabase } = fakeRpc({ error: { code: '40P01', message: 'deadlock detected' } });

    await expect(applyAffiliateRefund(input(supabase))).resolves.toBe('none');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('throws an AffiliateRefundError carrying the code when the webhook asks for it', async () => {
    const { supabase } = fakeRpc({ error: { code: '40P01', message: 'deadlock detected' } });

    const failure = applyAffiliateRefund(input(supabase, { throwOnError: true }));

    await expect(failure).rejects.toBeInstanceOf(AffiliateRefundError);
    await expect(failure).rejects.toMatchObject({ code: '40P01', message: 'Affiliates: apply_affiliate_refund failed' });
  });

  it('throws on a rejected call too, when asked', async () => {
    const { supabase } = fakeRpc(() => {
      throw new TypeError('fetch failed');
    });

    await expect(applyAffiliateRefund(input(supabase, { throwOnError: true }))).rejects.toBeInstanceOf(AffiliateRefundError);
  });

  it('answers none (never throws) when the database has no such RPC, logging it once', async () => {
    const { supabase } = fakeRpc({ error: { code: 'PGRST202', message: 'Could not find the function public.apply_affiliate_refund' } });

    await expect(applyAffiliateRefund(input(supabase, { throwOnError: true }))).resolves.toBe('none');
    await expect(applyAffiliateRefund(input(supabase, { throwOnError: true }))).resolves.toBe('none');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});
