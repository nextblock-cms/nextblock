import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PayPal payouts screen's server actions (02037) are public POST endpoints. Each calls
 * `requireCmsAdmin()` first, refuses on the public sandbox right after (before it reads the input),
 * validates with strict zod (unknown keys refused), takes no actor or client, and answers with fixed
 * sentences: never PayPal's text, never a secret.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  sync: vi.fn(),
  cancel: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/core/money')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/repository/client')),
}));
vi.mock('../../../../lib/auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('../../../../lib/affiliates/paypal/admin', () => ({
  saveAffiliatePayPalCredentialsNow: mocks.save,
  testAffiliatePayPalConnectionNow: mocks.test,
  syncAffiliatePayPalPayoutsNow: mocks.sync,
  cancelAffiliatePayPalPayoutNow: mocks.cancel,
}));
vi.mock('../../../../lib/affiliates/paypal/credentials', () => ({ AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH: 256 }));

import {
  cancelAffiliatePayPalPayoutAction,
  saveAffiliatePayPalCredentialsAction,
  syncAffiliatePayPalPayoutsAction,
  testAffiliatePayPalConnectionAction,
} from './actions';

const PAYOUT_ID = '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111';
const SECRET = 'super-secret-paypal-value';

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gates', () => {
  it('refuses a caller who is not an ADMIN before reading the input', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    const forbidden = { ok: false, error: 'Only administrators can manage the affiliate program.' };
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: 'Abc', secret: SECRET })).toEqual(forbidden);
    expect(await testAffiliatePayPalConnectionAction()).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await syncAffiliatePayPalPayoutsAction()).toEqual(forbidden);
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toEqual(forbidden);
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Unauthorized'));
    expect(await syncAffiliatePayPalPayoutsAction()).toMatchObject({ ok: false, error: expect.stringContaining('session') });
    for (const mock of [mocks.save, mocks.test, mocks.sync, mocks.cancel]) expect(mock).not.toHaveBeenCalled();
  });

  it('refuses on the public sandbox right after the admin check, whatever the input', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const results = [
      await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: 'Abc', secret: SECRET, extra: 1 } as never),
      await syncAffiliatePayPalPayoutsAction(),
      await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: 'not-even-a-uuid' }),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, error: expect.stringContaining('sandbox') });
    expect(await testAffiliatePayPalConnectionAction()).toMatchObject({ ok: false, reason: 'sandbox' });
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(4);
    for (const mock of [mocks.save, mocks.test, mocks.sync, mocks.cancel]) expect(mock).not.toHaveBeenCalled();
  });
});

describe('saveAffiliatePayPalCredentialsAction', () => {
  it('refuses unknown keys and a client id of the wrong shape, without calling PayPal', async () => {
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: 'Abc', secret: 'x', userId: 'u1' } as never)).toMatchObject({
      ok: false,
    });
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: 'has spaces' })).toEqual({
      ok: false,
      error: 'A PayPal client ID holds only letters, digits, - and _.',
    });
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'production' as never })).toMatchObject({ ok: false });
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'live', secret: 'x'.repeat(257) })).toMatchObject({ ok: false });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('saves what PayPal accepted and says so, without echoing the secret', async () => {
    mocks.save.mockResolvedValue({ status: 'saved', environment: 'live', payoutsEnabled: true, clientIdLast4: '1234' });
    const result = await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: ' LiveClient1234 ', secret: ` ${SECRET} ` });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('saved') });
    expect(mocks.save).toHaveBeenCalledWith({ environment: 'live', clientId: 'LiveClient1234', secret: SECRET });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/affiliates/paypal');
  });

  it('explains a rejection and an unreachable PayPal: nothing was saved', async () => {
    mocks.save.mockResolvedValue({ status: 'rejected' });
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'live', clientId: 'Wrong1234', secret: 'nope' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('PayPal rejected these credentials, so nothing was saved'),
    });
    mocks.save.mockResolvedValue({ status: 'unavailable' });
    expect(await saveAffiliatePayPalCredentialsAction({ environment: 'sandbox' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not be reached'),
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('testAffiliatePayPalConnectionAction', () => {
  it('lists what PayPal answered and says that nothing was sent', async () => {
    mocks.test.mockResolvedValue({
      ok: true,
      environment: 'live',
      source: 'cms',
      clientIdLast4: '1234',
      appId: 'APP-123',
      payoutsEnabled: true,
      balances: [
        { currency: 'CAD', primary: true, availableCents: 12345 },
        { currency: 'USD', primary: false, availableCents: 500 },
      ],
      storeCurrency: 'CAD',
    });
    const result = await testAffiliatePayPalConnectionAction();
    expect(result).toMatchObject({ ok: true, note: 'Nothing was sent.' });
    if (!result.ok) throw new Error('expected ok');
    const facts = Object.fromEntries(result.facts.map((fact) => [fact.label, fact.value]));
    expect(facts['Environment']).toBe('Live');
    expect(facts['Credentials']).toBe('Saved in the CMS · client ID ending in 1234');
    expect(facts['PayPal app']).toBe('APP-123');
    expect(facts['Payouts']).toContain('Enabled');
    expect(facts['Balance (CAD)']).toContain('available');
    expect(facts['Other balances']).toBeTruthy();
  });

  it('words each refusal', async () => {
    mocks.test.mockResolvedValue({ ok: false, reason: 'not_configured' });
    expect(await testAffiliatePayPalConnectionAction()).toMatchObject({ ok: false, reason: 'not_configured', error: expect.stringContaining('No PayPal credentials') });
    mocks.test.mockResolvedValue({ ok: false, reason: 'credentials' });
    expect(await testAffiliatePayPalConnectionAction()).toMatchObject({ ok: false, error: expect.stringContaining('rejected') });
  });
});

describe('syncAffiliatePayPalPayoutsAction and cancelAffiliatePayPalPayoutAction', () => {
  it('summarizes the PayPal check in counts', async () => {
    mocks.sync.mockResolvedValue({
      status: 'synced',
      summary: { synced: 3, completed: 1, failed: 1, inFlight: 1, unclaimed: 1, pendingRetry: 0, errors: [] },
      autoPayoutsEnabled: true,
    });
    expect(await syncAffiliatePayPalPayoutsAction()).toEqual({ ok: true, message: 'PayPal checked: 1 paid, 1 failed, 1 still in flight, 1 unclaimed.' });
    mocks.sync.mockResolvedValue({
      status: 'synced',
      summary: { synced: 0, completed: 0, failed: 0, inFlight: 0, unclaimed: 0, pendingRetry: 0, errors: [] },
      autoPayoutsEnabled: true,
    });
    expect(await syncAffiliatePayPalPayoutsAction()).toEqual({ ok: true, message: 'No PayPal payout was waiting for PayPal.' });
  });

  it('promises a resend of the batches with no answer only while automatic payouts are on', async () => {
    const summary = { synced: 1, completed: 0, failed: 0, inFlight: 1, unclaimed: 0, pendingRetry: 2, errors: [] };
    mocks.sync.mockResolvedValue({ status: 'synced', summary, autoPayoutsEnabled: true });
    expect(await syncAffiliatePayPalPayoutsAction()).toMatchObject({
      ok: true,
      message: expect.stringContaining('2 sent with no answer yet will be sent again by the next payout run.'),
    });
    mocks.sync.mockResolvedValue({ status: 'synced', summary, autoPayoutsEnabled: false });
    const off = await syncAffiliatePayPalPayoutsAction();
    expect(off).toMatchObject({
      ok: true,
      message: expect.stringContaining('are sent again only when you press Run payouts now on the Payouts screen (automatic payouts are off).'),
    });
    expect(JSON.stringify(off)).not.toContain('by the next payout run');
  });

  it('checks the payout id strictly, then words the outcome', async () => {
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: 'nope' })).toMatchObject({ ok: false });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID, affiliateId: 'x' } as never)).toMatchObject({ ok: false });
    expect(mocks.cancel).not.toHaveBeenCalled();

    mocks.cancel.mockResolvedValue({ status: 'cancelled', result: 'returned', recorded: true });
    const stopped = await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID });
    expect(stopped).toMatchObject({ ok: true, message: expect.stringContaining('The payment was stopped at PayPal') });
    // the partner is not paid by PayPal at that address again until they save it: no "next payout run" promise
    expect(stopped).toMatchObject({ message: expect.stringContaining('pay them under Payouts → Pay manually meanwhile') });
    expect(mocks.cancel).toHaveBeenCalledWith({ payoutIdToCancel: PAYOUT_ID });
    mocks.cancel.mockResolvedValue({ status: 'cancelled', result: 'returned', recorded: false });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toMatchObject({
      ok: true,
      message: expect.stringContaining('with the next PayPal check'),
    });
    mocks.cancel.mockResolvedValue({ status: 'released' });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toMatchObject({
      ok: true,
      message: expect.stringContaining('(automatic payouts on, or Run payouts now) pays them again'),
    });
    mocks.cancel.mockResolvedValue({ status: 'paypal_error', code: 'INTERNAL_SERVICE_ERROR', debugId: 'f818051c24f41' });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toMatchObject({
      ok: false,
      error: expect.stringContaining('PayPal answered with an error (INTERNAL_SERVICE_ERROR), so the payment was not stopped and nothing changed'),
    });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toMatchObject({ error: expect.stringContaining('PayPal debug id: f818051c24f41.') });
    mocks.cancel.mockResolvedValue({ status: 'not_cancellable' });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toMatchObject({
      ok: false,
      error: expect.stringContaining('released an hour after its last send, and one PayPal accepted but never settled a week after it'),
    });
    mocks.cancel.mockResolvedValue({ status: 'still_in_flight', itemStatus: 'PENDING' });
    expect(await cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: PAYOUT_ID })).toEqual({
      ok: false,
      error: 'PayPal no longer lists this payout as unclaimed (PENDING), so it was not stopped.',
    });
  });
});
