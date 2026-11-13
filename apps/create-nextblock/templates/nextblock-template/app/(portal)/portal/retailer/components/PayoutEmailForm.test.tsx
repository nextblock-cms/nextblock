// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_COMMON_COPY, AFFILIATES_PORTAL_COPY, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

/**
 * The partner's payout email form (manual payouts 02036, PayPal or Interac e-Transfer 02037): the
 * choice of PayPal or Interac e-Transfer first, the PayPal warning and a confirmation for a PayPal
 * email PayPal has not been given yet, the Interac help, Save and Remove through
 * `saveRetailerPayoutEmail` (with what the address is for), the portal's own messages, and a
 * read-only form on the public sandbox and for a suspended partner.
 */

const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));

vi.mock('../actions', () => ({ saveRetailerPayoutEmail: mocks.save }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn(), push: vi.fn() }) }));

import { PayoutEmailForm, type PayoutEmailFormProps } from './PayoutEmailForm';

const PORTAL = AFFILIATES_PORTAL_COPY;
const LEGEND = 'How do you want to receive your payouts?';
const PAYPAL_LABEL = 'Email of your PayPal account';
const CONFIRM_LABEL = 'Confirm your PayPal email';
const INTERAC_LABEL = 'Email for Interac e-Transfers';
const PAYPAL_WARNING =
  'Use the email of your PayPal account. A payout to an address without a confirmed PayPal account waits 30 days to be claimed, then returns.';
const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.save.mockReset();
  mocks.refresh.mockReset();
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
});

async function renderForm(props: Partial<PayoutEmailFormProps> = {}, locale: 'en' | 'fr' = 'en') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <AffiliatesCopyProvider locale={locale}>
        <PayoutEmailForm
          initialEmail={null}
          initialKind="paypal"
          sandbox={false}
          suspended={false}
          siteName="Maple Shop"
          paypalPayouts
          {...props}
        />
      </AffiliatesCopyProvider>,
    );
  });
  /** The input a label names (by its text), or null. */
  const field = (labelText: string): HTMLInputElement | null => {
    const label = [...container.querySelectorAll('label')].find((element) => element.textContent === labelText);
    const id = label?.getAttribute('for');
    return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  };
  const radio = (labelText: string): HTMLInputElement | null =>
    [...container.querySelectorAll('label')]
      .find((element) => element.textContent === labelText)
      ?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null;
  const button = (name: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === name) ?? null;
  const status = () => container.querySelector('[role="status"]')?.textContent ?? '';
  const describedBy = (input: HTMLInputElement | null) =>
    (input?.getAttribute('aria-describedby')?.split(' ') ?? []).map((id) => document.getElementById(id)?.textContent ?? '');
  return { container, field, radio, button, status, describedBy };
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no input to type in');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(input: HTMLInputElement | null) {
  if (!input) throw new Error('no radio to choose');
  await act(async () => {
    input.click();
  });
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('PayoutEmailForm', () => {
  it('asks PayPal or Interac e-Transfer first, labels the PayPal email and warns about unclaimed payouts', async () => {
    const form = await renderForm();
    const legend = form.container.querySelector('legend');
    expect(legend?.textContent).toBe(LEGEND);
    expect(form.container.querySelector('fieldset')?.getAttribute('aria-labelledby')).toBe(legend?.id);
    const radios = form.container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect([...radios].map((input) => input.value)).toEqual(['paypal', 'interac']);
    expect(form.radio('PayPal')?.checked).toBe(true);
    expect(form.radio('Interac e-Transfer')?.checked).toBe(false);
    // One group: the two radios share their name.
    expect(new Set([...radios].map((input) => input.name)).size).toBe(1);

    const email = form.field(PAYPAL_LABEL);
    expect(email).not.toBeNull();
    expect(email?.type).toBe('email');
    expect(email?.autocomplete).toBe('email');
    expect(email?.maxLength).toBe(127);
    expect(form.describedBy(email)).toContain(PAYPAL_WARNING);
    // Nothing typed yet: no confirmation field, nothing to save or remove.
    expect(form.field(CONFIRM_LABEL)).toBeNull();
    expect(form.button('Save')?.hasAttribute('disabled')).toBe(true);
    expect(form.button('Remove')).toBeNull();
  });

  it('asks to confirm a new PayPal email and refuses a mismatch before calling the server, then saves it as PayPal', async () => {
    mocks.save.mockResolvedValue({ ok: true, payoutEmail: 'jane.doe@paypal.example', payoutEmailKind: 'paypal' });
    const form = await renderForm();
    await type(form.field(PAYPAL_LABEL), '  Jane.Doe@PayPal.example ');
    const confirmation = form.field(CONFIRM_LABEL);
    expect(confirmation).not.toBeNull();
    expect(confirmation?.autocomplete).toBe('off');

    // The email says a confirmation follows while the field is shown.
    expect(form.describedBy(form.field(PAYPAL_LABEL))).toContain(PORTAL['affiliates.portal.payout_email_paypal_confirm_hint'].en);

    await type(confirmation, 'jane.doe@paypa1.example');
    await submit(form.container);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(form.status()).toBe(PORTAL['affiliates.portal.error_payout_email_mismatch'].en);
    expect(form.field(CONFIRM_LABEL)?.getAttribute('aria-invalid')).toBe('true');
    expect(form.field(PAYPAL_LABEL)?.hasAttribute('aria-invalid')).toBe(false);
    // The focus moves to the field to fix.
    expect(document.activeElement).toBe(form.field(CONFIRM_LABEL));

    // Case and surrounding spaces do not count, as on the server.
    await type(form.field(CONFIRM_LABEL), 'JANE.DOE@paypal.example');
    await submit(form.container);
    // An email input strips surrounding whitespace itself (HTML value sanitization); the action
    // trims and lowercases again on the server.
    expect(mocks.save).toHaveBeenCalledWith({ payoutEmail: 'Jane.Doe@PayPal.example', payoutEmailKind: 'paypal' });
    expect(form.field(PAYPAL_LABEL)?.value).toBe('jane.doe@paypal.example');
    expect(form.status()).toBe(PORTAL['affiliates.portal.payout_email_saved'].en);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(form.button('Remove')).not.toBeNull();
    // Saved for PayPal now: nothing left to confirm.
    expect(form.field(CONFIRM_LABEL)).toBeNull();
  });

  it('saves an Interac e-Transfer address without a confirmation, and says the store sends it by hand, usually less often', async () => {
    mocks.save.mockResolvedValue({ ok: true, payoutEmail: 'jane@bank.example', payoutEmailKind: 'interac' });
    const form = await renderForm();
    await choose(form.radio('Interac e-Transfer'));
    expect(form.radio('Interac e-Transfer')?.checked).toBe(true);
    const email = form.field(INTERAC_LABEL);
    expect(email).not.toBeNull();
    expect(email?.maxLength).toBe(254);
    expect(form.describedBy(email)).toContain('Interac e-Transfers are sent by Maple Shop by hand, usually less often.');
    expect(form.container.textContent).not.toContain(PAYPAL_WARNING);

    await type(email, 'Jane@Bank.example');
    expect(form.field(CONFIRM_LABEL)).toBeNull();
    await submit(form.container);
    expect(mocks.save).toHaveBeenCalledWith({ payoutEmail: 'Jane@Bank.example', payoutEmailKind: 'interac' });
    expect(form.radio('Interac e-Transfer')?.checked).toBe(true);
    expect(form.status()).toBe(PORTAL['affiliates.portal.payout_email_saved'].en);
  });

  it('says the store sends Interac e-Transfers by hand, without "less often", when no kind of order is paid with PayPal', async () => {
    const form = await renderForm({ paypalPayouts: false, initialKind: 'interac', initialEmail: 'jane@bank.example' });
    expect(form.describedBy(form.field(INTERAC_LABEL))).toContain('Maple Shop sends Interac e-Transfers by hand.');
    expect(form.container.textContent).not.toContain('less often');
  });

  it('needs no confirmation for the PayPal email already saved, and asks for one when an Interac address becomes a PayPal one', async () => {
    const paypal = await renderForm({ initialEmail: 'jane@paypal.example', initialKind: 'paypal' });
    expect(paypal.field(PAYPAL_LABEL)?.value).toBe('jane@paypal.example');
    expect(paypal.field(CONFIRM_LABEL)).toBeNull();
    expect(paypal.button('Save')?.hasAttribute('disabled')).toBe(true);
    // Choosing Interac e-Transfer for the same address is a change worth saving, with no confirmation.
    await choose(paypal.radio('Interac e-Transfer'));
    expect(paypal.button('Save')?.hasAttribute('disabled')).toBe(false);
    expect(paypal.field(CONFIRM_LABEL)).toBeNull();
    await choose(paypal.radio('PayPal'));
    expect(paypal.button('Save')?.hasAttribute('disabled')).toBe(true);
    expect(paypal.field(CONFIRM_LABEL)).toBeNull();

    mocks.save.mockResolvedValue({ ok: true, payoutEmail: 'jane@example.com', payoutEmailKind: 'paypal' });
    const interac = await renderForm({ initialEmail: 'jane@example.com', initialKind: 'interac' });
    expect(interac.radio('Interac e-Transfer')?.checked).toBe(true);
    await choose(interac.radio('PayPal'));
    expect(interac.field(CONFIRM_LABEL)).not.toBeNull();
    await submit(interac.container);
    expect(mocks.save).not.toHaveBeenCalled();
    // An empty confirmation has its own message, and the focus goes to it.
    expect(interac.status()).toBe(PORTAL['affiliates.portal.error_payout_email_confirm_empty'].en);
    expect(document.activeElement).toBe(interac.field(CONFIRM_LABEL));
    await type(interac.field(CONFIRM_LABEL), 'jane@example.com');
    await submit(interac.container);
    expect(mocks.save).toHaveBeenCalledWith({ payoutEmail: 'jane@example.com', payoutEmailKind: 'paypal' });
  });

  it('says what is wrong with a refused address, marks the field and refreshes nothing', async () => {
    mocks.save.mockResolvedValue({ ok: false, error: 'invalid_payout_email' });
    const form = await renderForm({ initialKind: 'interac' });
    await type(form.field(INTERAC_LABEL), 'jane@localhost');
    await submit(form.container);

    expect(form.status()).toBe(PORTAL['affiliates.portal.error_payout_email'].en);
    expect(form.field(INTERAC_LABEL)?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(form.field(INTERAC_LABEL));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('after PayPal returned a payout from the saved email, saves the same address again to try PayPal there again', async () => {
    const retry = 'I checked it: try PayPal again';
    // Nothing returned: no such button.
    const plain = await renderForm({ initialEmail: 'jane@paypal.example', initialKind: 'paypal' });
    expect(plain.button(retry)).toBeNull();

    mocks.save.mockResolvedValue({ ok: true, payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' });
    const form = await renderForm({ initialEmail: 'jane@paypal.example', initialKind: 'paypal', paypalReturned: true });
    expect(form.button(retry)?.hasAttribute('disabled')).toBe(false);
    // The address is unchanged: Save stays off and no confirmation is asked.
    expect(form.button('Save')?.hasAttribute('disabled')).toBe(true);
    expect(form.field(CONFIRM_LABEL)).toBeNull();
    await act(async () => {
      form.button(retry)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.save).toHaveBeenCalledWith({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' });
    expect(form.status()).toBe(PORTAL['affiliates.portal.payout_email_retry_saved'].en);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(form.button(retry)).toBeNull();

    // Changed to Interac e-Transfer meanwhile: the button is not offered for an address being changed.
    const changing = await renderForm({ initialEmail: 'jane@paypal.example', initialKind: 'paypal', paypalReturned: true });
    await choose(changing.radio('Interac e-Transfer'));
    expect(changing.button(retry)).toBeNull();
  });

  it('removes the saved address, keeping what it was for', async () => {
    mocks.save.mockResolvedValue({ ok: true, payoutEmail: null, payoutEmailKind: 'paypal' });
    const form = await renderForm({ initialEmail: 'jane@paypal.example' });
    await act(async () => {
      form.button('Remove')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.save).toHaveBeenCalledWith({ payoutEmail: '', payoutEmailKind: 'paypal' });
    expect(form.field(PAYPAL_LABEL)?.value).toBe('');
    expect(form.status()).toBe(PORTAL['affiliates.portal.payout_email_removed'].en);
    expect(form.button('Remove')).toBeNull();
  });

  it('reports a network failure without pretending it saved', async () => {
    mocks.save.mockRejectedValue(new Error('offline'));
    const form = await renderForm({ initialKind: 'interac' });
    await type(form.field(INTERAC_LABEL), 'jane@bank.example');
    await submit(form.container);
    expect(form.status()).toBe(AFFILIATES_COMMON_COPY['affiliates.common.error_network'].en);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('is read-only on the public sandbox and for a suspended partner', async () => {
    const sandbox = await renderForm({ sandbox: true, initialEmail: 'demo@paypal.example' });
    expect(sandbox.field(PAYPAL_LABEL)?.disabled).toBe(true);
    expect(sandbox.container.querySelector('fieldset')?.disabled).toBe(true);
    expect(sandbox.button('Remove')?.hasAttribute('disabled')).toBe(true);
    expect(sandbox.container.textContent).toContain(PORTAL['affiliates.portal.error_sandbox'].en);
    await submit(sandbox.container);
    expect(mocks.save).not.toHaveBeenCalled();

    const suspended = await renderForm({ suspended: true });
    expect(suspended.field(PAYPAL_LABEL)?.disabled).toBe(true);
    expect(suspended.container.querySelector('fieldset')?.disabled).toBe(true);
    await submit(suspended.container);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reads in Québec French', async () => {
    const form = await renderForm({}, 'fr');
    expect(form.container.querySelector('legend')?.textContent).toBe(PORTAL['affiliates.portal.payout_email_label'].fr);
    expect(form.radio('Virement Interac')).not.toBeNull();
    const email = form.field(PORTAL['affiliates.portal.payout_email_paypal_label'].fr);
    expect(email).not.toBeNull();
    expect(form.describedBy(email)).toContain(PORTAL['affiliates.portal.payout_email_help'].fr);
    await type(email, 'jane@paypal.example');
    expect(form.field(PORTAL['affiliates.portal.payout_email_paypal_confirm_label'].fr)).not.toBeNull();
    await choose(form.radio('Virement Interac'));
    expect(form.describedBy(form.field(PORTAL['affiliates.portal.payout_email_interac_label'].fr))).toContain(
      'Les virements Interac sont envoyés manuellement par Maple Shop, habituellement moins souvent.',
    );
    expect(form.button('Enregistrer')).not.toBeNull();
  });
});
