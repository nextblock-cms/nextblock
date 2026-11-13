import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sendEmail on the public sandbox (2026-11-03). Its admin login is published, so a visitor chose
 * both the recipient and the text of mail sent on the deployment's SMTP account: a contact form or
 * product enquiry with any sender address, answered (and "Retry delivery"-ed) from /cms/messages; a
 * saved comment notification list; a per-form recipient while SANDBOX_CONTACT_EMAIL is unset. The
 * choke point now mails only the operator's inbox (SANDBOX_CONTACT_EMAIL) and the product feedback
 * inbox there, and refuses everything else before the SMTP config is even read. Off the sandbox ('', 'false', 'TRUE', '1')
 * any address sends exactly as before.
 */

const OPERATOR = 'ops@sandbox.example';
const CONFIG = {
  host: 'smtp.deployment.example',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: { user: 'deployment-user', pass: 'deployment-pass' },
  from: '"NextBlock Sandbox" <no-reply@sandbox.example>',
};

const mocks = vi.hoisted(() => ({
  resolveEmailServerConfig: vi.fn(),
  resolveEmailBranding: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransport },
}));
vi.mock('../../lib/config/email-settings', () => ({
  resolveEmailServerConfig: mocks.resolveEmailServerConfig,
}));
vi.mock('../../lib/email/branding', () => ({
  resolveEmailBranding: mocks.resolveEmailBranding,
  applyEmailBranding: (html: string) => html,
}));
// The real sandbox predicate (exactly 'true'), without the rest of the server barrel.
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<typeof import('../../../../libs/db/src/lib/config-resolve')>(
    '../../../../libs/db/src/lib/config-resolve'
  );
  return { isSandboxEnvironment };
});

import { PRODUCT_FEEDBACK_INBOX, describeSmtpError, sendEmail } from './email';

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
const REFUSAL = 'Email is turned off in the sandbox.';

function message(to: string) {
  return { to, subject: 'Re: your enquiry', text: 'Hello', html: '<p>Hello</p>' };
}

/** No config read, no branding read, no transport, no send. */
function expectNoSmtpWork() {
  expect(mocks.resolveEmailServerConfig).not.toHaveBeenCalled();
  expect(mocks.resolveEmailBranding).not.toHaveBeenCalled();
  expect(mocks.createTransport).not.toHaveBeenCalled();
  expect(mocks.sendMail).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('SANDBOX_CONTACT_EMAIL', OPERATOR);
  mocks.resolveEmailServerConfig.mockReset().mockResolvedValue(CONFIG);
  mocks.resolveEmailBranding.mockReset().mockResolvedValue({ siteName: 'NextBlock Sandbox' });
  mocks.sendMail.mockReset().mockResolvedValue({ messageId: '<m-1@sandbox.example>' });
  // The module keeps one pooled transport per config; delegating keeps every test's sendMail live.
  mocks.createTransport.mockReset().mockImplementation(() => ({
    sendMail: (options: unknown) => mocks.sendMail(options),
    on: () => undefined,
    close: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendEmail on the sandbox (NEXT_PUBLIC_IS_SANDBOX=true)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('refuses a visitor-chosen recipient before reading the SMTP config', async () => {
    await expect(sendEmail(message('victim@example.org'))).rejects.toThrow(REFUSAL);
    expectNoSmtpWork();
  });

  it.each([
    ['the operator plus a visitor address', `${OPERATOR}, victim@example.org`],
    ['a visitor address plus the operator', `victim@example.org,${OPERATOR}`],
    ['the operator joined by a semicolon (nodemailer splits on it)', `${OPERATOR};victim@example.org`],
    ['the operator behind a display name', `Operator <${OPERATOR}>`],
    ['a group that names the operator', `team: ${OPERATOR}, victim@example.org;`],
    ['an empty list', ' , '],
    ['nothing', ''],
  ])('refuses %s', async (_label, to) => {
    await expect(sendEmail(message(to))).rejects.toThrow(REFUSAL);
    expectNoSmtpWork();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('refuses every visitor-chosen recipient while SANDBOX_CONTACT_EMAIL is %s', async (_label, operator) => {
    if (operator === undefined) {
      vi.stubEnv('SANDBOX_CONTACT_EMAIL', undefined);
      expect(process.env['SANDBOX_CONTACT_EMAIL']).toBeUndefined();
    } else {
      vi.stubEnv('SANDBOX_CONTACT_EMAIL', operator);
    }

    for (const to of [OPERATOR, 'victim@example.org', operator ?? '', 'undefined']) {
      await expect(sendEmail(message(to))).rejects.toThrow(REFUSAL);
    }
    expectNoSmtpWork();
  });

  it.each([
    ['exactly', OPERATOR],
    ['in another case, with whitespace', '  Ops@Sandbox.EXAMPLE '],
    ['listed twice', `${OPERATOR}, OPS@sandbox.example`],
  ])('sends to the operator inbox alone (%s)', async (_label, to) => {
    vi.stubEnv('SANDBOX_CONTACT_EMAIL', ' OPS@Sandbox.Example ');

    await expect(sendEmail(message(to))).resolves.toEqual({ messageId: '<m-1@sandbox.example>' });
    expect(mocks.resolveEmailServerConfig).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({ to, from: CONFIG.from, subject: 'Re: your enquiry' });
  });

  it('delivers the product feedback inbox, fixed in code, even without SANDBOX_CONTACT_EMAIL', async () => {
    vi.stubEnv('SANDBOX_CONTACT_EMAIL', undefined);

    await expect(sendEmail(message(' Feedback@NextBlock.dev '))).resolves.toEqual({ messageId: '<m-1@sandbox.example>' });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['plus a visitor address', `${PRODUCT_FEEDBACK_INBOX}, victim@example.org`],
    ['joined to a visitor address by a semicolon', `${PRODUCT_FEEDBACK_INBOX};victim@example.org`],
  ])('refuses the feedback inbox %s', async (_label, to) => {
    await expect(sendEmail(message(to))).rejects.toThrow(REFUSAL);
    expectNoSmtpWork();
  });

  it('is the inbox submitFeedback sends to', () => {
    expect(PRODUCT_FEEDBACK_INBOX).toBe('feedback@nextblock.dev');
    const feedback = readFileSync(join(__dirname, 'feedback.ts'), 'utf8');
    expect(feedback).toMatch(/to: PRODUCT_FEEDBACK_INBOX,/);
    expect(feedback).not.toMatch(/to: ["']/);
  });

  it('fails with a reason the callers can store and show as is', () => {
    // threads record describeSmtpError(error) on the message; nothing rewrites this one.
    expect(describeSmtpError(new Error(REFUSAL))).toBe(REFUSAL);
  });
});

describe.each(OFF_SANDBOX)('sendEmail off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j): unchanged', (value) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
  });

  it.each([
    'victim@example.org',
    `${OPERATOR}, customer@example.org`,
    'Store Owner <owner@shop.example>',
  ])('sends to %j through the resolved SMTP config', async (to) => {
    await expect(sendEmail(message(to))).resolves.toEqual({ messageId: '<m-1@sandbox.example>' });
    expect(mocks.resolveEmailServerConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEmailBranding).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail.mock.calls[0][0]).toEqual({
      from: CONFIG.from,
      to,
      subject: 'Re: your enquiry',
      text: 'Hello',
      html: '<p>Hello</p>',
    });
  });

  it('sends whatever SANDBOX_CONTACT_EMAIL says, or without it', async () => {
    vi.stubEnv('SANDBOX_CONTACT_EMAIL', undefined);
    await expect(sendEmail(message('customer@example.org'))).resolves.toBeDefined();
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it('still reports an unconfigured server', async () => {
    mocks.resolveEmailServerConfig.mockResolvedValue(null);
    await expect(sendEmail(message('customer@example.org'))).rejects.toThrow(/not configured/);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});
