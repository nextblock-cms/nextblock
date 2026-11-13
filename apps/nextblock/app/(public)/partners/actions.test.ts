import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public `/partners` actions: zod-validate the form, hand the service only what the visitor
 * typed (never an id), answer `{ ok, … }` shapes with localized messages, echo the typed values
 * (never the password), and redirect only after a signup that has a session.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  check: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${path}` });
  }),
  locale: 'en',
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../lib/affiliates/signup', () => ({
  submitAffiliateSignup: mocks.submit,
  checkAffiliateHandleAvailability: mocks.check,
}));
type CopyDictionary = Record<string, { en: string; fr: string }>;
type CopyRuntime = {
  createAffiliatesCopy: (options: { locale: string; dictionary: CopyDictionary }) => (key: string) => string;
};

vi.mock('../../../lib/affiliates/server-copy', async () => {
  const { createAffiliatesCopy } = (await vi.importActual('../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as CopyRuntime;
  return {
    getServerAffiliatesCopy: async ({ dictionary }: { dictionary: CopyDictionary }) =>
      createAffiliatesCopy({ locale: mocks.locale, dictionary }),
  };
});

import { checkPartnerHandleAvailability, submitPartnerSignup, type PartnerSignupState } from './actions';

const INITIAL: PartnerSignupState = { ok: null, attempt: 0 };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = {
  handle: 'jane-picks',
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  password: 'correct horse battery',
  terms: 'on',
};

beforeEach(() => {
  mocks.submit.mockReset();
  mocks.check.mockReset();
  mocks.redirect.mockClear();
  mocks.locale = 'en';
});

describe('submitPartnerSignup', () => {
  it('hands the service only the typed fields and the form (no id, no role, no client)', async () => {
    mocks.submit.mockResolvedValue({ kind: 'confirm_email' });
    const data = form({ ...VALID, userId: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' });

    await expect(submitPartnerSignup(INITIAL, data)).resolves.toEqual({ ok: true, status: 'confirm_email', attempt: 1 });
    expect(mocks.submit).toHaveBeenCalledWith(
      { handle: 'jane-picks', displayName: 'Jane Doe', email: 'jane@example.com', password: 'correct horse battery' },
      data,
    );
  });

  it('redirects into the portal only after a signup that has a session', async () => {
    mocks.submit.mockResolvedValue({ kind: 'signed_in', account: { affiliateId: 'aff-1' } });
    await expect(submitPartnerSignup(INITIAL, form(VALID))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/portal/retailer?welcome=1');
  });

  it('reports "sign in" when the account exists but has no session yet', async () => {
    mocks.submit.mockResolvedValue({ kind: 'sign_in' });
    await expect(submitPartnerSignup({ ok: null, attempt: 4 }, form(VALID))).resolves.toEqual({ ok: true, status: 'sign_in', attempt: 5 });
  });

  it('answers the sandbox demo with a status and the handle, never a redirect (no account, no session)', async () => {
    mocks.submit.mockResolvedValue({ kind: 'sandbox_demo', handle: 'jane-picks' });
    const result = await submitPartnerSignup(INITIAL, form(VALID));
    expect(result).toEqual({ ok: true, status: 'sandbox_demo', handle: 'jane-picks', attempt: 1 });
    expect(JSON.stringify(result)).not.toContain('correct horse battery');

    // The upgrade form of a signed-in customer gets the same answer.
    await expect(
      submitPartnerSignup({ ok: null, attempt: 1 }, form({ handle: 'jane-picks', displayName: 'Jane', email: '', password: '', terms: 'on' })),
    ).resolves.toEqual({ ok: true, status: 'sandbox_demo', handle: 'jane-picks', attempt: 2 });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('refuses unchecked terms, echoing the typed values but never the password', async () => {
    const result = await submitPartnerSignup(INITIAL, form({ ...VALID, terms: '' }));
    expect(result).toEqual({
      ok: false,
      error: 'terms_required',
      message: 'Please accept the partner terms.',
      field: 'terms',
      values: { handle: 'jane-picks', displayName: 'Jane Doe', email: 'jane@example.com', terms: false },
      attempt: 1,
    });
    expect(JSON.stringify(result)).not.toContain('correct horse battery');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: 'not-an-email' }, 'email_invalid', 'email'],
    [{ password: 'short' }, 'password_invalid', 'password'],
    [{ displayName: 'x'.repeat(81) }, 'name_invalid', 'displayName'],
    [{ displayName: '   ' }, 'name_invalid', 'displayName'],
    [{ handle: '' }, 'handle_invalid', 'handle'],
    [{ handle: 'h'.repeat(65) }, 'handle_invalid', 'handle'],
  ])('validates %o before calling the service', async (override, error, field) => {
    const result = await submitPartnerSignup(INITIAL, form({ ...VALID, ...override }));
    expect(result).toMatchObject({ ok: false, error, field });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('accepts an empty email and password (the upgrade form of a signed-in customer)', async () => {
    mocks.submit.mockResolvedValue({ kind: 'confirm_email' });
    await submitPartnerSignup(INITIAL, form({ handle: 'jane-picks', displayName: 'Jane', email: '', password: '', terms: 'on' }));
    expect(mocks.submit).toHaveBeenCalledWith({ handle: 'jane-picks', displayName: 'Jane', email: null, password: null }, expect.any(FormData));
  });

  it('localizes service refusals and names the field', async () => {
    mocks.submit.mockResolvedValue({ kind: 'error', code: 'handle_taken' });
    await expect(submitPartnerSignup(INITIAL, form(VALID))).resolves.toMatchObject({
      ok: false,
      error: 'handle_taken',
      message: 'That handle is already taken. Try another one.',
      field: 'handle',
    });

    mocks.locale = 'fr';
    mocks.submit.mockResolvedValue({ kind: 'error', code: 'throttled' });
    await expect(submitPartnerSignup(INITIAL, form(VALID))).resolves.toMatchObject({
      ok: false,
      error: 'throttled',
      message: 'Trop de comptes partenaires ont été créés à partir de votre réseau. Veuillez réessayer dans une heure.',
      field: null,
    });
  });

  it('never echoes an unexpected error', async () => {
    mocks.submit.mockRejectedValue(new Error('relation "affiliate_profiles" does not exist'));
    const result = await submitPartnerSignup(INITIAL, form(VALID));
    expect(result).toMatchObject({ ok: false, error: 'unknown', message: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(result)).not.toContain('relation');
  });

  it('counts attempts from a sane previous state only', async () => {
    mocks.submit.mockResolvedValue({ kind: 'confirm_email' });
    await expect(submitPartnerSignup({ ok: null, attempt: 2 }, form(VALID))).resolves.toMatchObject({ attempt: 3 });
    await expect(submitPartnerSignup({ ok: null, attempt: -5 } as PartnerSignupState, form(VALID))).resolves.toMatchObject({ attempt: 1 });
    await expect(submitPartnerSignup('garbage' as unknown as PartnerSignupState, form(VALID))).resolves.toMatchObject({ attempt: 1 });
  });
});

describe('checkPartnerHandleAvailability', () => {
  it('validates the input shape before asking the service', async () => {
    await expect(checkPartnerHandleAvailability({ handle: 'x'.repeat(65) })).resolves.toEqual({ ok: false, error: 'invalid_input' });
    await expect(
      checkPartnerHandleAvailability({ handle: 'jane', userId: 'someone' } as unknown as { handle: string }),
    ).resolves.toEqual({ ok: false, error: 'invalid_input' });
    await expect(checkPartnerHandleAvailability(null as unknown as { handle: string })).resolves.toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('passes the service answer through and hides failures', async () => {
    mocks.check.mockResolvedValue({ ok: true, status: 'taken' });
    await expect(checkPartnerHandleAvailability({ handle: 'jane' })).resolves.toEqual({ ok: true, status: 'taken' });
    expect(mocks.check).toHaveBeenCalledWith('jane');

    mocks.check.mockRejectedValue(new Error('boom'));
    await expect(checkPartnerHandleAvailability({ handle: 'jane' })).resolves.toEqual({ ok: false, error: 'unavailable' });
  });
});
