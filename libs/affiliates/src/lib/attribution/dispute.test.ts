import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AffiliateRepositoryClient } from '../repository/client';
import { AffiliateCommissionDisputeError, setAffiliateCommissionDispute } from './dispute';
import type { AffiliateCommissionDisputeInput } from './types';

/**
 * setAffiliateCommissionDispute is the path from a chargeback webhook to the commission ledger:
 * an open dispute holds the commission so it is never paid out while the dispute is pending, a
 * dispute closed without loss releases it. Every answer is a success; a failure is quiet for
 * best-effort callers and loud for webhooks that want the provider to redeliver.
 */

const ORDER_ID = '44444444-4444-4444-8444-444444444444';

type RpcCall = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

function fakeRpc(answer: { data?: unknown; error?: unknown } | (() => never)) {
  const rpc = vi.fn<RpcCall>(async () => {
    if (typeof answer === 'function') return answer();
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  return { supabase: { rpc } as unknown as AffiliateRepositoryClient, rpc };
}

function input(
  supabase: AffiliateRepositoryClient,
  overrides: Partial<AffiliateCommissionDisputeInput> = {}
): AffiliateCommissionDisputeInput {
  return { supabase, gateway: 'STRIPE', orderId: ORDER_ID, open: true, ...overrides };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setAffiliateCommissionDispute', () => {
  it('holds the commission of an order whose payment is disputed', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'held' });

    await expect(setAffiliateCommissionDispute(input(supabase))).resolves.toBe('held');
    expect(rpc).toHaveBeenCalledWith('set_affiliate_commission_dispute', {
      p_gateway: 'STRIPE',
      p_order_id: ORDER_ID,
      p_open: true,
    });
  });

  it('releases it when the dispute closes without loss', async () => {
    const { supabase, rpc } = fakeRpc({ data: 'released' });

    await expect(
      setAffiliateCommissionDispute(input(supabase, { gateway: 'freemius' as never, orderId: ORDER_ID.toUpperCase(), open: false }))
    ).resolves.toBe('released');
    expect(rpc.mock.calls[0][1]).toEqual({ p_gateway: 'FREEMIUS', p_order_id: ORDER_ID, p_open: false });
  });

  it.each(['held', 'released', 'none'])('passes %s through', async (answer) => {
    const { supabase } = fakeRpc({ data: answer });

    await expect(setAffiliateCommissionDispute(input(supabase))).resolves.toBe(answer);
  });

  it('reads an unexpected answer as none', async () => {
    const { supabase } = fakeRpc({ data: 'voided' });

    await expect(setAffiliateCommissionDispute(input(supabase))).resolves.toBe('none');
  });

  it.each([
    ['an unknown gateway', { gateway: 'PAYPAL' as never }],
    ['a malformed order id', { orderId: "1' OR 1=1" }],
    ['a missing direction', { open: 'yes' as never }],
  ])('answers none without calling the RPC for %s', async (_label, overrides) => {
    const { supabase, rpc } = fakeRpc({ data: 'held' });

    await expect(setAffiliateCommissionDispute(input(supabase, overrides))).resolves.toBe('none');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('logs and answers none on an RPC error by default', async () => {
    const { supabase } = fakeRpc({ error: { code: '40P01', message: 'deadlock detected' } });

    await expect(setAffiliateCommissionDispute(input(supabase))).resolves.toBe('none');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('throws an AffiliateCommissionDisputeError carrying the code when the webhook asks for it', async () => {
    const { supabase } = fakeRpc({ error: { code: '40P01', message: 'deadlock detected' } });

    const failure = setAffiliateCommissionDispute(input(supabase, { throwOnError: true }));

    await expect(failure).rejects.toBeInstanceOf(AffiliateCommissionDisputeError);
    await expect(failure).rejects.toMatchObject({ code: '40P01', message: 'Affiliates: set_affiliate_commission_dispute failed' });
  });

  it('throws on a rejected call too, when asked', async () => {
    const { supabase } = fakeRpc(() => {
      throw new TypeError('fetch failed');
    });

    await expect(setAffiliateCommissionDispute(input(supabase, { throwOnError: true }))).rejects.toBeInstanceOf(
      AffiliateCommissionDisputeError
    );
  });

  it('answers none (never throws) when the database has no such RPC, logging it once', async () => {
    const { supabase } = fakeRpc({
      error: { code: 'PGRST202', message: 'Could not find the function public.set_affiliate_commission_dispute' },
    });

    await expect(setAffiliateCommissionDispute(input(supabase, { throwOnError: true }))).resolves.toBe('none');
    await expect(setAffiliateCommissionDispute(input(supabase, { throwOnError: true }))).resolves.toBe('none');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});
