import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { threadReference } from './threads';
import { replyToThread, retryThreadDelivery } from '../../app/cms/messages/actions';

/**
 * The sandbox reply case at the bottom drives the real chain: replyToThread → sendThreadNotice →
 * sendEmail, over an in-memory message store. Only the edges are stubbed (the admin gate, the
 * SMTP config and transport, branding, the seller address); threadReference needs none of it.
 */
const sandboxMail = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  let nextId = 0;

  /** select / insert / update, filtered by one `.eq('id', …)`, as the message actions use them. */
  function serviceClient() {
    return {
      from(table: string) {
        const rows = table === 'message_threads' ? threads : messages;
        let op: 'select' | 'insert' | 'update' = 'select';
        let payload: Record<string, unknown> = {};
        let id: string | null = null;
        const run = () => {
          if (op === 'insert') {
            nextId += 1;
            const row = { id: `msg-${nextId}`, email_delivered: false, email_error: null, ...payload };
            rows.set(row.id, row);
            return { data: { id: row.id }, error: null };
          }
          if (op === 'update') {
            const row = id ? rows.get(id) : undefined;
            if (row && id) rows.set(id, { ...row, ...payload });
            return { data: null, error: null };
          }
          return { data: (id && rows.get(id)) || null, error: null };
        };
        const chain: Record<string, unknown> = {
          select: () => chain,
          insert: (values: Record<string, unknown>) => {
            op = 'insert';
            payload = values;
            return chain;
          },
          update: (values: Record<string, unknown>) => {
            op = 'update';
            payload = values;
            return chain;
          },
          eq: (_column: string, value: string) => {
            id = value;
            return chain;
          },
          maybeSingle: async () => run(),
          single: async () => run(),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(run()).then(resolve, reject),
        };
        return chain;
      },
    };
  }

  const sendMail = vi.fn();
  return {
    threads,
    messages,
    serviceClient,
    sendMail,
    // A working transport: without the sandbox guard the reply would really go out.
    createTransport: vi.fn(() => ({ sendMail, on: () => undefined, close: () => undefined })),
    reset() {
      threads.clear();
      messages.clear();
      nextId = 0;
    },
  };
});

vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<typeof import('../../../../libs/db/src/lib/config-resolve')>(
    '../../../../libs/db/src/lib/config-resolve'
  );
  return {
    isSandboxEnvironment,
    createClient: () => {
      throw new Error('the cookie client is not used on this path');
    },
    getServiceRoleSupabaseClient: () => sandboxMail.serviceClient(),
  };
});
vi.mock('../../app/cms/messages/require-admin', () => ({
  requireAdminSupabaseClient: async () => ({ supabase: {}, userId: 'admin-1', fullName: 'Demo Admin' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('nodemailer', () => ({ default: { createTransport: sandboxMail.createTransport } }));
vi.mock('../config/email-settings', () => ({
  // The deployment's own SMTP_* login, which is all the sandbox ever resolves.
  resolveEmailServerConfig: async () => ({
    host: 'smtp.deployment.example',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: 'deployment-user', pass: 'deployment-pass' },
    from: '"NextBlock Sandbox" <no-reply@sandbox.example>',
  }),
  invalidateEmailConfigCache: () => undefined,
}));
vi.mock('../email/branding', () => ({
  resolveEmailBranding: async () => ({ siteName: 'NextBlock Sandbox' }),
  applyEmailBranding: (html: string) => html,
}));
vi.mock('../commerce/seller-contact', () => ({
  resolveSellerContactEmail: async () => ({ email: 'store@sandbox.example' }),
}));

/**
 * A real install stopped receiving replies and nothing reported a fault: SMTP accepted
 * every message, Outlook accepted every message, and they went straight to Deleted Items.
 * The cause was the subject. Every conversation from one form produced a byte-identical
 * "Re: Contact form"; Exchange derives its ConversationTopic from the subject rather than
 * from References, so an Ignore Conversation applied once applied to every enquiry the
 * site would ever receive.
 *
 * A per-conversation reference is what stops one filtering decision swallowing the lot.
 */

const THREAD_A = 'f4c00aff-a458-40cb-8f6b-7ec66e98779c';
const THREAD_B = '34b62e11-8209-4beb-98e9-10b364bd2807';

describe('threadReference', () => {
  it('is stable for a given thread', () => {
    expect(threadReference(THREAD_A, 'New Roots Herbal')).toBe(
      threadReference(THREAD_A, 'New Roots Herbal')
    );
  });

  it('differs between threads, which is the entire point', () => {
    expect(threadReference(THREAD_A, 'New Roots Herbal')).not.toBe(
      threadReference(THREAD_B, 'New Roots Herbal')
    );
  });

  it('reads as a ticket number rather than a hex dump', () => {
    expect(threadReference(THREAD_A, 'New Roots Herbal')).toBe('NRH-VWQOLB');
    expect(threadReference(THREAD_A, 'New Roots Herbal')).toMatch(/^[A-Z]{2,4}-[0-9A-Z]{6}$/);
  });

  it('builds initials from a multi-word site name', () => {
    expect(threadReference(THREAD_A, 'New Roots Herbal')).toMatch(/^NRH-/);
    expect(threadReference(THREAD_A, 'The Corner  Shop')).toMatch(/^TCS-/);
  });

  it('falls back to the first three letters of a one-word name', () => {
    expect(threadReference(THREAD_A, 'NextBlock')).toMatch(/^NEX-/);
  });

  it('drops the prefix entirely when there is no usable site name', () => {
    expect(threadReference(THREAD_A, '')).toBe('VWQOLB');
    expect(threadReference(THREAD_A, '   ')).toBe('VWQOLB');
    expect(threadReference(THREAD_A)).toBe('VWQOLB');
  });

  it('ignores punctuation in the site name rather than emitting it', () => {
    expect(threadReference(THREAD_A, "Bob's Bikes & Co.")).toMatch(/^BBC-/);
  });

  it('survives a malformed id instead of throwing', () => {
    expect(threadReference('', 'New Roots Herbal')).toBe('NRH-000000');
    expect(threadReference('zzzzzzzz', 'New Roots Herbal')).toBe('NRH-000000');
  });

  it('keeps distinct conversations apart across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(threadReference(crypto.randomUUID(), 'New Roots Herbal'));
    }
    // 2.2 billion references; a handful of collisions in 2000 draws would signal a bug
    // in the fold, not birthday-paradox noise.
    expect(seen.size).toBe(2000);
  });
});

describe('a reply on the public sandbox (2026-11-03)', () => {
  // A visitor submitted the contact form with someone else's address as theirs; as the published
  // admin they then "reply" with text of their choosing. The sandbox mails only its operator.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    vi.stubEnv('SANDBOX_CONTACT_EMAIL', 'ops@sandbox.example');
    vi.stubEnv('NEXT_PUBLIC_URL', 'https://sandbox.nextblock.dev');
    sandboxMail.reset();
    sandboxMail.sendMail.mockReset().mockResolvedValue({ messageId: '<m-1@sandbox.example>' });
    sandboxMail.createTransport.mockClear();
    sandboxMail.threads.set(THREAD_A, {
      id: THREAD_A,
      source: 'contact_form',
      subject_label: 'Contact form',
      sender_name: 'Visitor',
      sender_email: 'victim@example.org',
      status: 'open',
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('records the reply as not delivered, and Retry delivery mails nobody either', async () => {
    await expect(replyToThread(THREAD_A, 'Your account is locked, sign in at https://phish.example')).resolves.toEqual({
      success: false,
      message: 'Reply saved, but it could not be delivered. Email is turned off in the sandbox.',
    });
    const [saved] = [...sandboxMail.messages.values()];
    expect(saved).toMatchObject({
      thread_id: THREAD_A,
      direction: 'outbound',
      email_delivered: false,
      email_error: 'Email is turned off in the sandbox.',
    });

    await expect(retryThreadDelivery(String(saved.id))).resolves.toEqual({
      success: false,
      message: 'Email is turned off in the sandbox.',
    });
    expect(sandboxMail.createTransport).not.toHaveBeenCalled();
    expect(sandboxMail.sendMail).not.toHaveBeenCalled();
  });
});
