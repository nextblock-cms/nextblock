// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared Pause / Resume controls (the Overview table, the approvals Storefronts list and the
 * review page). What a pause does depends on whether the partner was ever approved
 * (`first_published_at`): an approved partner's storefront goes offline and their referral links
 * stop earning; before a first approval nothing of theirs is public and nothing earns, so the
 * dialogs promise no storefront, earnings or credits. The crediting sentence says what
 * `reconcile_affiliate_commissions` really does: orders placed before the pause and paid during
 * it, at most 120 days old, at the next payout run.
 */

const mocks = vi.hoisted(() => ({
  suspend: vi.fn(),
  reactivate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../actions', () => ({
  suspendAffiliatePartnerAction: mocks.suspend,
  reactivateAffiliatePartnerAction: mocks.reactivate,
}));

import { PartnerStatusControls, type PartnerStatusControlsProps } from './PartnerStatusControls';

const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.suspend.mockResolvedValue({ ok: true, message: '@jane is paused.' });
  mocks.reactivate.mockResolvedValue({ ok: true, message: '@jane is active again.' });
});

async function unmountAll(): Promise<void> {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
}

afterEach(unmountAll);

async function renderControls(props: Partial<PartnerStatusControlsProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <PartnerStatusControls affiliateId={AFFILIATE_ID} handle="jane" displayName="Jane Partner" status="ACTIVE" isApproved {...props} />,
    );
  });
  return container;
}

/** Click the button with this accessible name, then return the open dialog. */
async function openDialog(container: HTMLElement, label: string): Promise<HTMLElement> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => {
    button.click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('dialog not open');
  return dialog;
}

function descriptionOf(dialog: HTMLElement): string {
  const id = dialog.getAttribute('aria-describedby');
  if (!id) throw new Error('dialog has no description');
  return document.getElementById(id)?.textContent ?? '';
}

/** Set a controlled field's value the way typing does (React listens to `input`). */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PartnerStatusControls: an approved partner', () => {
  it('pausing takes the storefront offline, and credits only what reconcile records', async () => {
    const dialog = await openDialog(await renderControls(), 'Pause partner @jane');
    expect(descriptionOf(dialog)).toBe(
      "Jane Partner's storefront goes offline and their referral links stop earning until you resume. Earned balances are kept and payouts wait. Orders placed before the pause and paid during it are credited at the first payout run after you resume (orders up to 120 days old).",
    );
  });

  it('resuming puts the last approved storefront back online', async () => {
    const dialog = await openDialog(await renderControls({ status: 'SUSPENDED' }), 'Resume partner @jane');
    expect(descriptionOf(dialog)).toBe(
      "Jane Partner's last approved storefront goes back online and their referral links earn again. Payouts resume, and orders placed before the pause and paid during it (up to 120 days old) are credited at the next payout run.",
    );
  });
});

describe('PartnerStatusControls: a partner never approved', () => {
  it('pausing only locks the portal: no storefront, earnings or credits are promised', async () => {
    const dialog = await openDialog(await renderControls({ isApproved: false }), 'Pause partner @jane');
    const text = descriptionOf(dialog);
    expect(text).toBe(
      "Jane Partner can't edit or submit their storefront until you resume. Nothing of theirs is public yet, and they earn nothing before a first approval.",
    );
    expect(text).not.toMatch(/offline|balances|credited|payout/);
  });

  it('resuming lets them edit and submit again, and puts nothing online', async () => {
    const dialog = await openDialog(await renderControls({ isApproved: false, status: 'SUSPENDED' }), 'Resume partner @jane');
    const text = descriptionOf(dialog);
    expect(text).toBe('Jane Partner can edit their storefront again and submit it for review.');
    expect(text).not.toMatch(/online|earn|payout/);
  });

  it('names the handle when the display name is blank', async () => {
    const dialog = await openDialog(await renderControls({ isApproved: false, displayName: '  ' }), 'Pause partner @jane');
    expect(descriptionOf(dialog)).toMatch(/^@jane can't edit/);
  });
});

describe('PartnerStatusControls: what the pause sends', () => {
  it('sends the trimmed reason, or null for a blank one', async () => {
    for (const [typed, reason] of [
      ['  Chargebacks on 3 orders  ', 'Chargebacks on 3 orders'],
      ['   ', null],
    ] as const) {
      const container = await renderControls();
      const dialog = await openDialog(container, 'Pause partner @jane');
      const field = dialog.querySelector('textarea');
      if (!field) throw new Error('no reason field');
      await act(async () => typeInto(field, typed));
      const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (!submit) throw new Error('no submit button');
      await act(async () => {
        submit.click();
      });

      expect(mocks.suspend, JSON.stringify(typed)).toHaveBeenLastCalledWith({ affiliateIdToUpdate: AFFILIATE_ID, reason });
      await unmountAll();
    }
    expect(mocks.suspend).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('resumes with the partner id only', async () => {
    const dialog = await openDialog(await renderControls({ status: 'SUSPENDED' }), 'Resume partner @jane');
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Resume partner');
    if (!confirm) throw new Error('no confirm button');
    await act(async () => {
      confirm.click();
    });
    expect(mocks.reactivate).toHaveBeenCalledExactlyOnceWith({ affiliateIdToUpdate: AFFILIATE_ID });
  });
});
