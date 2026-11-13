// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A partner's sign-in address on the /cms/affiliates screens. `loadAffiliatePartnerEmails` has
 * three outcomes, and so does this component: an address (a same-tab `mailto:` and Copy), `null`
 * (the account has no usable address) and `undefined` (the lookup failed: never shown as "no
 * address", since every partner signs up with one). Only the review page prints the address, so
 * elsewhere a failed copy cannot tell the admin to select the text.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({ toast }));
// The subject's site name comes from the cached site settings (not needed for the link builder).
vi.mock('../../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop' }) }));

import { PartnerEmailActions } from './PartnerEmailActions';

const SUBJECT = 'Your partner storefront on Maple Shop';

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
  vi.unstubAllGlobals();
});

async function render(email: string | null | undefined, showAddress = false): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<PartnerEmailActions email={email} subject={SUBJECT} handle="jane" showAddress={showAddress} />);
  });
  return container;
}

/** Make the clipboard refuse (an insecure origin, a denied permission, an unfocused page). */
function refuseClipboard(): void {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
}

async function clickCopy(container: HTMLElement): Promise<void> {
  const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy the email address of @jane"]');
  if (!copy) throw new Error('no Copy button');
  await act(async () => {
    copy.click();
  });
}

describe('PartnerEmailActions', () => {
  it('says the address is unavailable when the lookup failed, never that there is none', async () => {
    const container = await render(undefined);
    expect(container.textContent).toBe('Email unavailable right now');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('says there is no usable address for null, or for something that is not one address', async () => {
    for (const email of [null, '', 'not an address', 'a@b@c.example']) {
      const container = await render(email);
      expect(container.textContent, String(email)).toBe('No usable email');
      expect(container.querySelector('a'), String(email)).toBeNull();
    }
  });

  it('links a same-tab mailto with the subject, and copies the address', async () => {
    const container = await render('jane@partner.dev');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('mailto:jane@partner.dev?subject=Your%20partner%20storefront%20on%20Maple%20Shop');
    expect(link?.hasAttribute('target')).toBe(false);
    expect(link?.getAttribute('aria-label')).toBe('Email @jane');
    // Rows do not print the address; the review page does.
    expect(container.textContent).not.toContain('jane@partner.dev');

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await clickCopy(container);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('jane@partner.dev');
    expect(toast.success).toHaveBeenCalledWith('Copied to the clipboard.');
  });

  it('points at the review page when a copy fails where the address is not printed', async () => {
    refuseClipboard();
    const container = await render('jane@partner.dev');
    await clickCopy(container);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Copy failed. The review page shows the address.');
  });

  it('keeps "select the text" on the review page, which prints the address beside the button', async () => {
    refuseClipboard();
    const container = await render('jane@partner.dev', true);
    expect(container.textContent).toContain('jane@partner.dev');
    await clickCopy(container);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Copy failed. Select the text and copy it by hand.');
  });
});
