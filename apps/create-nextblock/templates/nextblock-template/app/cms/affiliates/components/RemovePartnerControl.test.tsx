// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Remove partner" on the review page: a destructive confirmation that needs the partner's handle
 * typed out (an `@`, surrounding spaces and capitals aside, as the server compares it). A removal
 * leaves the review page (it no longer exists); a partner kept paused because of their ledger gets
 * a warning and a refresh; any failure gets an error and a refresh, because the server may have
 * paused the partner before it failed. The server re-checks the handle either way.
 */

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../actions', () => ({ removeAffiliatePartnerAction: mocks.remove }));

import { RemovePartnerControl, type RemovePartnerControlProps } from './RemovePartnerControl';

const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const APPROVALS = '/cms/affiliates/approvals';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
});

async function renderControl(props: Partial<RemovePartnerControlProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <RemovePartnerControl
        affiliateId={AFFILIATE_ID}
        handle="jane"
        displayName="Jane Partner"
        blockedReason={null}
        afterRemoveHref={APPROVALS}
        {...props}
      />,
    );
  });
  return container;
}

function removeButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Remove partner @jane"]');
  if (!button) throw new Error('no Remove partner button');
  return button;
}

/** Open the dialog; return its handle field, its confirm button and its form. */
async function openDialog(container: HTMLElement) {
  await act(async () => {
    removeButton(container).click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const field = dialog?.querySelector('input');
  const confirm = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const form = dialog?.querySelector('form');
  if (!dialog || !field || !confirm || !form) throw new Error('dialog not open');
  return { dialog, field, confirm, form };
}

/** Set a controlled field's value the way typing does (React listens to `input`). */
async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('RemovePartnerControl: the typed handle', () => {
  it('keeps the confirm button disabled until the handle matches (an @, spaces and capitals aside)', async () => {
    const { field, confirm, form } = await openDialog(await renderControl());
    expect(confirm.disabled).toBe(true);

    for (const typed of ['jan', 'janet', 'jane-doe', 'j a n e', '@@jane', 'jane.']) {
      await type(field, typed);
      expect(confirm.disabled, typed).toBe(true);
    }
    // Enter in the field submits the form: nothing is sent while the handle does not match.
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.remove).not.toHaveBeenCalled();

    for (const typed of ['jane', ' @Jane ', 'JANE', '@jane']) {
      await type(field, typed);
      expect(confirm.disabled, typed).toBe(false);
    }
  });

  it('opens with an empty field every time', async () => {
    const container = await renderControl();
    const first = await openDialog(container);
    await type(first.field, 'jane');
    const cancel = [...first.dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel');
    await act(async () => {
      cancel?.click();
    });
    const again = await openDialog(container);
    expect(again.field.value).toBe('');
    expect(again.confirm.disabled).toBe(true);
  });
});

describe('RemovePartnerControl: the outcome', () => {
  async function confirmRemoval(typed = 'jane') {
    const { field, confirm } = await openDialog(await renderControl());
    await type(field, typed);
    await act(async () => {
      confirm.click();
    });
  }

  it('sends what was typed, then leaves the review page for Approvals once the partner is gone', async () => {
    mocks.remove.mockResolvedValueOnce({ ok: true, removed: true, message: 'Jane Partner was removed.' });

    await confirmRemoval(' @Jane ');

    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: ' @Jane ' });
    expect(mocks.toast.success).toHaveBeenCalledExactlyOnceWith('Jane Partner was removed.');
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(APPROVALS);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('warns and refreshes, staying on the page, when the partner was paused instead of removed', async () => {
    const message = 'Jane Partner has commission or payout history, so they were paused instead of removed.';
    mocks.remove.mockResolvedValueOnce({ ok: true, removed: false, message });

    await confirmRemoval();

    expect(mocks.toast.warning).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a refusal and refreshes (the server may have paused the partner first)', async () => {
    const error = 'The partner is paused, but their partner account could not be removed. Try again in a moment.';
    mocks.remove.mockResolvedValueOnce({ ok: false, error });

    await confirmRemoval();

    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('survives a request that never reached the server', async () => {
    mocks.remove.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await confirmRemoval();

    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(
      'The request did not reach the server. Check your connection and try again.',
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('RemovePartnerControl: when removal is not offered', () => {
  it('is disabled and described by the reason while the ledger is not empty', async () => {
    const reason = "Jane Partner has commission or payout history, so they can't be removed.";
    const container = await renderControl({ blockedReason: reason });
    const button = removeButton(container);
    expect(button.disabled).toBe(true);
    const describedBy = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(reason);
  });

  it('is disabled and described by the lock note on the sandbox', async () => {
    const container = await renderControl({ lockedNoteId: 'affiliate-partners-locked-note' });
    const button = removeButton(container);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('affiliate-partners-locked-note');
  });
});
