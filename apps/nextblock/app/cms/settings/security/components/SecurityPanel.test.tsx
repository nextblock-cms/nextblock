import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecurityPanelData } from '../actions';

/**
 * The sign-up policy card is read-only on the sandbox (updateAutoAcceptSignups refuses there). The
 * security page shows a notice instead of this panel on the sandbox today; the card stays honest
 * if it is ever rendered there.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../actions', () => ({
  disableMfa: vi.fn(),
  revokeTrustedDeviceAction: vi.fn(),
  sendEmailEnrollmentCode: vi.fn(),
  startTotpEnrollment: vi.fn(),
  updateAutoAcceptSignups: vi.fn(),
  updateGlobalSecuritySettings: vi.fn(),
  verifyEmailEnrollment: vi.fn(),
  verifyTotpEnrollment: vi.fn(),
}));

import SecurityPanel from './SecurityPanel';

const DATA: SecurityPanelData = {
  email: 'admin@example.com',
  mfaEnabled: false,
  mfaType: null,
  hasVerifiedTotp: false,
  isAdmin: true,
  globalSettings: { trusted_device_days: 30, enforce_staff_2fa: true },
  trustedDevices: [],
  autoAcceptSignups: true,
  emailConfigured: true,
};

const NOTE = 'Sign-up settings are disabled in the sandbox.';
/** `disabled=""`, not `data-disabled=""`. */
const DISABLED = /\sdisabled=""/;

/** The markup of the sign-up policy card, the panel's last card. */
function signupPolicyCard() {
  const html = renderToStaticMarkup(<SecurityPanel data={DATA} />);
  const start = html.indexOf('Sign-up Policy (Admin)');
  if (start < 0) throw new Error('the sign-up policy card did not render');
  return html.slice(start);
}

function tag(html: string, pattern: RegExp) {
  const found = html.match(pattern)?.[0];
  if (!found) throw new Error(`no element matches ${pattern}`);
  return found;
}

const CHECKBOX = /<button[^>]*id="auto_accept_signups"[^>]*>/;
const SUBMIT = /<button[^>]*type="submit"[^>]*>/;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SecurityPanel sign-up policy card', () => {
  it('renders the switch and its save button disabled on the sandbox, with a note', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const card = signupPolicyCard();

    const checkbox = tag(card, CHECKBOX);
    expect(checkbox).toMatch(DISABLED);
    expect(checkbox).toContain('aria-describedby="auto_accept_signups_sandbox_note"');
    expect(tag(card, SUBMIT)).toMatch(DISABLED);
    expect(card).toContain(`<p id="auto_accept_signups_sandbox_note" class="text-xs text-slate-500">${NOTE}</p>`);
  });

  it('keeps both enabled, with no note, everywhere else', () => {
    for (const value of ['', 'false']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const card = signupPolicyCard();

      expect(tag(card, CHECKBOX)).not.toMatch(/\sdisabled=|aria-describedby=/);
      expect(tag(card, SUBMIT)).not.toMatch(DISABLED);
      expect(card).not.toContain(NOTE);
    }
  });
});
