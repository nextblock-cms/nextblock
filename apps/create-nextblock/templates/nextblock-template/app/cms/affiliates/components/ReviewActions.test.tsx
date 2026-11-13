// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The review screen's "Request changes" dialog tells the admin how the partner gets the note: by
 * email and in their portal, except on the public sandbox, which sends no email
 * (lib/affiliates/notify.ts mails nobody there).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Only the dialog is opened here: no decision is sent.
vi.mock('../actions', () => ({
  approveAffiliateStorefrontAction: vi.fn(),
  requestAffiliateStorefrontChangesAction: vi.fn(),
}));

import { ReviewActions } from './ReviewActions';

const BY_EMAIL = 'The partner gets this note by email and in their portal. Whatever is live now stays live.';
const PORTAL_ONLY = 'The partner sees this note in their portal (the sandbox sends no email). Whatever is live now stays live.';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

/** Render the review actions, open "Request changes" and return the dialog's accessible description. */
async function requestChangesDescription(): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <ReviewActions
        pageId="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
        handle="studio-nova"
        draftVersion={3}
        profileFingerprint={'ab'.repeat(32)}
        canReview
        approveBlockedReason={null}
        isFirstPublication={false}
      />,
    );
  });

  const open = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Request changes');
  if (!open) throw new Error('no Request changes button');
  await act(async () => {
    open.click();
  });

  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('dialog not open');
  const descriptionId = dialog.getAttribute('aria-describedby');
  if (!descriptionId) throw new Error('dialog has no description');
  return document.getElementById(descriptionId)?.textContent ?? '';
}

describe('ReviewActions: the Request changes dialog', () => {
  it.each(['', 'false'])('says the note goes out by email and to the portal (NEXT_PUBLIC_IS_SANDBOX=%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    expect(await requestChangesDescription()).toBe(BY_EMAIL);
  });

  it('says the sandbox sends no email: the note only reaches the portal', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await requestChangesDescription()).toBe(PORTAL_ONLY);
  });
});
