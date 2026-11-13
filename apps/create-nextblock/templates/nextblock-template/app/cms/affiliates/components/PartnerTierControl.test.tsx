// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Change tier" (the Overview rows and the review page's Partner card). Active tiers are offered,
 * inactive ones are listed disabled with the reason, and a full capped tier stays selectable behind
 * an "Assign over the cap" box (the cap only limits public sign-ups and the spots-left count). The
 * partner is emailed only when "Email the partner" is ticked, and the confirmation says what the
 * move changes: orders paid from now on earn the new rate; recorded commissions keep theirs (in a
 * live region that also describes "Move partner"). The server action re-checks everything
 * (lib/affiliates/review.ts and the 02035 RPC), and re-renders the page when its tiers were stale.
 */

const mocks = vi.hoisted(() => ({
  changeTier: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../actions', () => ({ changeAffiliatePartnerTierAction: mocks.changeTier }));

import { PartnerTierControl, type PartnerTierControlProps } from './PartnerTierControl';
import type { PartnerTierOption } from './tier-options';

const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const STARTER = '11111111-1111-4111-8111-111111111111';
const ELITE = '22222222-2222-4222-8222-222222222222';
const FOUNDING = '33333333-3333-4333-8333-333333333333';
const RETIRED = '44444444-4444-4444-8444-444444444444';

const TIERS: PartnerTierOption[] = [
  { id: STARTER, name: 'Starter Partner', rateLabel: '10%', isActive: true, isFull: false },
  { id: ELITE, name: 'Elite Partner', rateLabel: '35%', isActive: true, isFull: false },
  { id: FOUNDING, name: 'Founding Ambassador', rateLabel: '50%', isActive: true, isFull: true },
  { id: RETIRED, name: 'Retired', rateLabel: '5%', isActive: false, isFull: false },
];

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix's checkbox measures its hidden form input; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.changeTier.mockResolvedValue({ ok: true, message: 'Jane Partner moved to Elite Partner. Orders paid from now on earn 35%.' });
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
});

function controlElement(props: Partial<PartnerTierControlProps> = {}) {
  return <PartnerTierControl affiliateId={AFFILIATE_ID} handle="jane" displayName="Jane Partner" tierId={STARTER} tiers={TIERS} {...props} />;
}

async function renderControl(props: Partial<PartnerTierControlProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(controlElement(props));
  });
  return container;
}

/** New props for the control rendered last, as a server re-render (router refresh) delivers them. */
async function rerenderControl(props: Partial<PartnerTierControlProps>): Promise<void> {
  const last = mounted[mounted.length - 1];
  if (!last) throw new Error('nothing rendered');
  await act(async () => {
    last.root.render(controlElement(props));
  });
}

function tierButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Change tier of @jane"]');
  if (!button) throw new Error('no tier button');
  return button;
}

async function openDialog(container: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    tierButton(container).click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('dialog not open');
  return dialog;
}

function select(dialog: HTMLElement): HTMLSelectElement {
  const element = dialog.querySelector('select');
  if (!element) throw new Error('no tier select');
  return element;
}

/** Pick an option the way a user does (React listens to `change`). */
async function choose(dialog: HTMLElement, tierId: string): Promise<void> {
  const element = select(dialog);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, tierId);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The checkbox labelled `label` (a Radix checkbox: a button with role="checkbox"). */
function checkbox(dialog: HTMLElement, label: string): HTMLButtonElement | null {
  const labelElement = [...dialog.querySelectorAll('label')].find((element) => element.textContent?.trim() === label);
  const id = labelElement?.getAttribute('for');
  const control = id ? document.getElementById(id) : null;
  return control instanceof HTMLButtonElement && control.getAttribute('role') === 'checkbox' && dialog.contains(control) ? control : null;
}

async function tick(box: HTMLButtonElement | null): Promise<void> {
  if (!box) throw new Error('no checkbox');
  await act(async () => {
    box.click();
  });
}

function submitButton(dialog: HTMLElement): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error('no submit button');
  return button;
}

async function submit(dialog: HTMLElement): Promise<void> {
  await act(async () => {
    submitButton(dialog).click();
  });
}

const CONFIRM_ELITE = 'From now on, orders paid earn 35%. Commissions already recorded keep their rate.';

describe('PartnerTierControl: the tiers it offers', () => {
  it('lists every tier: the current one marked, a full one selectable, an inactive one disabled with the reason', async () => {
    const dialog = await openDialog(await renderControl());
    const options = [...select(dialog).options].map((option) => ({ label: option.textContent, disabled: option.disabled }));
    expect(options).toEqual([
      { label: 'Starter Partner (10%) – current', disabled: false },
      { label: 'Elite Partner (35%)', disabled: false },
      { label: 'Founding Ambassador (50%) – full', disabled: false },
      { label: 'Retired (5%) – inactive', disabled: true },
    ]);
    const describedBy = select(dialog).getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Inactive tiers can’t take partners: activate one on the Tiers screen first.',
    );
  });

  it('names the current tier and says a paused partner can be moved', async () => {
    const dialog = await openDialog(await renderControl());
    expect(dialog.textContent).toContain(
      'Jane Partner is in Starter Partner (10%). Move them to another tier at any time, even while they are paused.',
    );
  });

  it('keeps a partner’s inactive current tier selectable (it is where they are) and drops the reason when no other tier is inactive', async () => {
    const tiers = TIERS.map((tier) => (tier.id === STARTER ? { ...tier, isActive: false } : tier)).filter((tier) => tier.id !== RETIRED);
    const dialog = await openDialog(await renderControl({ tiers }));
    expect(select(dialog).options[0]?.disabled).toBe(false);
    expect(select(dialog).getAttribute('aria-describedby')).toBeNull();
  });
});

describe('PartnerTierControl: the move', () => {
  it('confirms what changes, then sends the two ids only', async () => {
    const dialog = await openDialog(await renderControl());
    // Nothing to move yet: no confirmation, Move disabled.
    expect(dialog.textContent).not.toContain('From now on');
    expect(submitButton(dialog).disabled).toBe(true);

    await choose(dialog, ELITE);
    expect(dialog.textContent).toContain(CONFIRM_ELITE);
    expect(checkbox(dialog, 'Assign over the cap')).toBeNull();
    expect(submitButton(dialog).disabled).toBe(false);

    await submit(dialog);
    expect(mocks.changeTier).toHaveBeenCalledExactlyOnceWith({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: ELITE });
    expect(mocks.toast.success).toHaveBeenCalledWith('Jane Partner moved to Elite Partner. Orders paid from now on earn 35%.');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('offers "Assign over the cap" for a full tier and waits for it before moving', async () => {
    const dialog = await openDialog(await renderControl());
    await choose(dialog, FOUNDING);

    const overCap = checkbox(dialog, 'Assign over the cap');
    expect(overCap).not.toBeNull();
    // The help says why "Move partner" waits: the box has to be ticked.
    const help = document.getElementById(overCap?.getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toBe(
      'Founding Ambassador is full. The cap only limits public sign-ups and the spots-left count on the partners page. Tick it to move them anyway.',
    );
    expect(overCap?.getAttribute('aria-checked')).toBe('false');
    expect(dialog.textContent).toContain('From now on, orders paid earn 50%. Commissions already recorded keep their rate.');
    expect(submitButton(dialog).disabled).toBe(true);

    await tick(overCap);
    expect(submitButton(dialog).disabled).toBe(false);
    await submit(dialog);
    expect(mocks.changeTier).toHaveBeenCalledExactlyOnceWith({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: FOUNDING, allowOverCap: true });
  });

  it('forgets the over-cap tick when another tier is picked, and never sends it for a tier with room', async () => {
    const dialog = await openDialog(await renderControl());
    await choose(dialog, FOUNDING);
    await tick(checkbox(dialog, 'Assign over the cap'));
    await choose(dialog, ELITE);
    expect(checkbox(dialog, 'Assign over the cap')).toBeNull();
    await choose(dialog, FOUNDING);
    expect(checkbox(dialog, 'Assign over the cap')?.getAttribute('aria-checked')).toBe('false');

    await choose(dialog, ELITE);
    await submit(dialog);
    expect(mocks.changeTier.mock.calls[0]?.[0]).not.toHaveProperty('allowOverCap');
  });

  it('emails the partner only when "Email the partner" is ticked', async () => {
    const dialog = await openDialog(await renderControl());
    const email = checkbox(dialog, 'Email the partner');
    expect(email?.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(email?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'They get the new tier and its rate by email, in their language, once the move is saved.',
    );

    await choose(dialog, ELITE);
    await tick(email);
    await submit(dialog);
    expect(mocks.changeTier).toHaveBeenCalledExactlyOnceWith({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: ELITE, notifyPartner: true });
  });

  it('starts every opening fresh: the current tier, no over-cap tick, no email', async () => {
    const container = await renderControl();
    let dialog = await openDialog(container);
    await choose(dialog, FOUNDING);
    await tick(checkbox(dialog, 'Assign over the cap'));
    await tick(checkbox(dialog, 'Email the partner'));
    const cancel = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel');
    await act(async () => {
      cancel?.click();
    });

    dialog = await openDialog(container);
    expect(select(dialog).value).toBe(STARTER);
    expect(checkbox(dialog, 'Assign over the cap')).toBeNull();
    expect(checkbox(dialog, 'Email the partner')?.getAttribute('aria-checked')).toBe('false');
    expect(mocks.changeTier).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the refusal when the server says no', async () => {
    mocks.changeTier.mockResolvedValueOnce({ ok: false, error: 'That tier is inactive.' });
    const dialog = await openDialog(await renderControl());
    await choose(dialog, ELITE);
    await submit(dialog);
    expect(mocks.toast.error).toHaveBeenCalledWith('That tier is inactive.');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  // The page loaded with a spot left in Founding Ambassador; a sign-up took it before the admin
  // pressed Move. The server refuses (tier_full) and re-renders the page in its response
  // (changeAffiliatePartnerTierAction revalidates on a stale refusal): the open dialog then gets the
  // tier marked full, keeps the selection, and shows the box the refusal points at.
  it('shows "Assign over the cap" in the open dialog once the refreshed tiers mark the chosen tier full', async () => {
    const withRoom = TIERS.map((tier) => (tier.id === FOUNDING ? { ...tier, isFull: false } : tier));
    const refusal = 'That tier filled up in the meantime. Tick "Assign over the cap" to move this partner anyway, or raise the tier\'s partner cap on the Tiers screen.';
    mocks.changeTier.mockResolvedValueOnce({ ok: false, error: refusal });
    const dialog = await openDialog(await renderControl({ tiers: withRoom }));
    await choose(dialog, FOUNDING);
    expect(checkbox(dialog, 'Assign over the cap')).toBeNull();
    await submit(dialog);
    expect(mocks.changeTier).toHaveBeenLastCalledWith({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: FOUNDING });
    expect(mocks.toast.error).toHaveBeenCalledWith(refusal);

    await rerenderControl({ tiers: TIERS });
    const open = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!open) throw new Error('the dialog closed');
    expect(select(open).value).toBe(FOUNDING);
    const overCap = checkbox(open, 'Assign over the cap');
    expect(overCap?.getAttribute('aria-checked')).toBe('false');
    expect(submitButton(open).disabled).toBe(true);

    await tick(overCap);
    await submit(open);
    expect(mocks.changeTier).toHaveBeenLastCalledWith({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: FOUNDING, allowOverCap: true });
  });
});

describe('PartnerTierControl: accessibility', () => {
  it('names the trigger "Change tier", the start of its accessible name', async () => {
    const button = tierButton(await renderControl());
    expect(button.textContent?.trim()).toBe('Change tier');
    expect(button.getAttribute('aria-label')).toBe('Change tier of @jane');
  });

  it('announces the confirmation in a polite, atomic live region and describes "Move partner" with it', async () => {
    const dialog = await openDialog(await renderControl());
    const region = dialog.querySelector<HTMLElement>('[role="status"]');
    if (!region) throw new Error('no live region');
    // Present (empty) before any choice, so the sentence is announced when it appears.
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toBe('');
    expect(submitButton(dialog).getAttribute('aria-describedby')).toBeNull();

    await choose(dialog, ELITE);
    expect(region.textContent).toBe(CONFIRM_ELITE);
    expect(submitButton(dialog).getAttribute('aria-describedby')).toBe(region.id);

    await choose(dialog, STARTER);
    expect(region.textContent).toBe('');
    expect(submitButton(dialog).getAttribute('aria-describedby')).toBeNull();
  });
});

describe('PartnerTierControl: locked on the public sandbox', () => {
  it('renders the button disabled and described by the lock note', async () => {
    const container = await renderControl({ lockedNoteId: 'affiliate-partners-locked-note' });
    const button = tierButton(container);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('affiliate-partners-locked-note');
  });
});
