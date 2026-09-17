import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The enquiry action is the only unauthenticated, mail-sending endpoint the storefront
 * exposes, so the tests here are about its guarantees rather than its happy path:
 *
 *  - the lead is persisted even when SMTP is dead (that is the entire reason the table
 *    exists — a store with no payment keys usually has no mail server either);
 *  - the recipient is never taken from the request;
 *  - a tripped honeypot looks exactly like a success to the caller.
 */

const mocks = vi.hoisted(() => ({
  verifyBotProtection: vi.fn(),
  sendEmail: vi.fn(),
  resolveSellerContactEmail: vi.fn(),
  insert: vi.fn(),
  productLookup: vi.fn(),
  throttleCount: vi.fn(),
  throttleKey: vi.fn(),
  update: vi.fn(),
  afterPromises: [] as Promise<unknown>[],
  requestHeaders: {} as Record<string, string>,
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => mocks.requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

// `after` defers work until past the response, so the notification genuinely has not
// run when the action returns. Capture each deferred promise so a test can await it
// instead of racing it.
vi.mock('next/server', () => ({
  after: (callback: () => unknown) => {
    const promise = Promise.resolve().then(callback);
    mocks.afterPromises.push(promise);
    return promise;
  },
}));

/** Wait for everything `after()` deferred, mirroring what the platform does post-response. */
async function flushAfter(): Promise<void> {
  await Promise.all(mocks.afterPromises);
}

vi.mock('../../lib/botProtection/verify', () => ({
  verifyBotProtection: mocks.verifyBotProtection,
}));

// Partial mock: the real describeSmtpError is what turns a transport failure into text
// an admin can act on, so exercise it rather than stubbing it out. resolveFromDomain is
// stubbed because it reaches for the live SMTP config, which this suite does not model.
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  sendEmail: mocks.sendEmail,
  resolveFromDomain: async () => 'example.com',
}));

vi.mock('../../lib/commerce/seller-contact', () => ({
  resolveSellerContactEmail: mocks.resolveSellerContactEmail,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'products') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.productLookup }) }),
        };
      }
      return {
        select: () => ({
          eq: (_column: string, value: string) => {
            mocks.throttleKey(value);
            return { gte: mocks.throttleCount };
          },
        }),
        insert: () => ({ select: () => ({ single: mocks.insert }) }),
        update: (values: unknown) => {
          mocks.update(values);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  }),
}));

import { submitProductInquiry } from './contactSellerActions';

function buildFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set('product_id', 'prod-1');
  formData.set('name', 'Ada Lovelace');
  formData.set('email', 'ada@example.com');
  formData.set('message', 'Can I buy ten of these?');
  for (const [key, value] of Object.entries(overrides)) formData.set(key, value);
  return formData;
}

describe('submitProductInquiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.afterPromises.length = 0;
    mocks.requestHeaders = { 'x-forwarded-for': '203.0.113.7' };
    mocks.verifyBotProtection.mockResolvedValue({ ok: true });
    mocks.throttleCount.mockResolvedValue({ count: 0 });
    mocks.productLookup.mockResolvedValue({
      data: { id: 'prod-1', title: 'Brass Kettle', slug: 'brass-kettle' },
    });
    mocks.insert.mockResolvedValue({ data: { id: 'inq-1' }, error: null });
    mocks.resolveSellerContactEmail.mockResolvedValue({
      email: 'owner@example.com',
      source: 'store_contact',
    });
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it('stores the enquiry and notifies the resolved seller address', async () => {
    const result = await submitProductInquiry(null, buildFormData());
    await flushAfter();

    expect(result).toEqual({ success: true, messageKey: 'ecommerce.contact_seller_sent' });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.to).toBe('owner@example.com');
    // The visitor's address goes in Reply-To so the owner can just hit reply.
    expect(email.replyTo).toBe('ada@example.com');
    expect(mocks.update).toHaveBeenCalledWith({ email_delivered: true, email_error: null });
  });

  it('still reports success when the mail server is unconfigured', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('Email server is not configured.'));

    const result = await submitProductInquiry(null, buildFormData());
    await flushAfter();

    // The row is the deliverable; the visitor's message really did get through.
    expect(result.success).toBe(true);
    expect(mocks.insert).toHaveBeenCalled();
    // The failure is recorded on the message rather than lost, so the CMS can show
    // "not emailed" instead of implying the owner was told.
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ email_delivered: false })
    );
    // And it is recorded as guidance, not as the raw transport text.
    const recorded = mocks.update.mock.calls.at(-1)?.[0]?.email_error ?? '';
    expect(recorded).toMatch(/CMS Settings/i);
  });

  it('ignores any recipient supplied by the client', async () => {
    await submitProductInquiry(null, buildFormData({ recipient: 'attacker@evil.test' }));
    await flushAfter();

    expect(mocks.sendEmail.mock.calls[0][0].to).toBe('owner@example.com');
  });

  it('fakes a success when the honeypot is tripped, writing nothing', async () => {
    mocks.verifyBotProtection.mockResolvedValue({ ok: false, reason: 'honeypot' });

    const result = await submitProductInquiry(null, buildFormData());
    await flushAfter();

    expect(result).toEqual({ success: true, messageKey: 'ecommerce.contact_seller_sent' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a malformed email address before touching the database', async () => {
    const result = await submitProductInquiry(null, buildFormData({ email: 'not-an-email' }));

    expect(result).toMatchObject({ success: false, messageKey: 'ecommerce.contact_seller_invalid' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('refuses a product id that does not exist', async () => {
    mocks.productLookup.mockResolvedValue({ data: null });

    const result = await submitProductInquiry(null, buildFormData());

    expect(result).toMatchObject({ success: false, messageKey: 'ecommerce.contact_seller_invalid' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('throttles a flood from one masked IP', async () => {
    mocks.throttleCount.mockResolvedValue({ count: 5 });

    const result = await submitProductInquiry(null, buildFormData());

    expect(result).toMatchObject({ success: false, messageKey: 'ecommerce.contact_seller_throttled' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('uses the stored product title rather than anything the client sent', async () => {
    await submitProductInquiry(null, buildFormData({ product_title: 'FREE MONEY CLICK HERE' }));
    await flushAfter();

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.subject).toContain('Brass Kettle');
    expect(email.subject).not.toContain('FREE MONEY');
  });

  it('escapes visitor text landing in the HTML body', async () => {
    await submitProductInquiry(
      null,
      buildFormData({ name: '<script>alert(1)</script>', message: 'a < b & c' })
    );
    await flushAfter();

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('a &lt; b &amp; c');
  });

  it('still throttles when no address header is present at all', async () => {
    // Regression: the throttle used to sit inside `if (ipMasked)`, so a request with no
    // usable address skipped the check entirely — a fail-open an attacker could trigger
    // just by sending an unparseable header.
    mocks.requestHeaders = {};
    mocks.throttleCount.mockResolvedValue({ count: 5 });

    const result = await submitProductInquiry(null, buildFormData());

    expect(result).toMatchObject({ success: false, messageKey: 'ecommerce.contact_seller_throttled' });
    expect(mocks.throttleKey).toHaveBeenCalledWith('unknown');
  });

  it('buckets an unparseable forwarded-for under the shared unknown key', async () => {
    mocks.requestHeaders = { 'x-forwarded-for': 'nothanks' };
    mocks.throttleCount.mockResolvedValue({ count: 0 });

    await submitProductInquiry(null, buildFormData());

    expect(mocks.throttleKey).toHaveBeenCalledWith('unknown');
  });

  it('prefers the platform header over the client-writable forwarded-for', async () => {
    // x-forwarded-for is client-prependable on an appending proxy, so rotating it must
    // not mint a fresh throttle bucket when a trusted header is available.
    mocks.requestHeaders = {
      'x-forwarded-for': '9.9.9.9',
      'x-real-ip': '198.51.100.4',
    };
    mocks.throttleCount.mockResolvedValue({ count: 0 });

    await submitProductInquiry(null, buildFormData());

    expect(mocks.throttleKey).toHaveBeenCalledWith('198.51.100.x');
  });

  it('masks the stored address rather than keeping the full IP', async () => {
    mocks.throttleCount.mockResolvedValue({ count: 0 });

    await submitProductInquiry(null, buildFormData());

    expect(mocks.throttleKey).toHaveBeenCalledWith('203.0.113.x');
  });

  it('translates a TLS/port mismatch into something the admin can act on', async () => {
    // The verbatim OpenSSL error a real install hit: SMTP2GO on port 2525 with implicit
    // TLS left switched on. It names neither TLS mode nor port, so it is stored as
    // guidance instead.
    mocks.sendEmail.mockRejectedValue(
      new Error(
        'B4730000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:ssl3_record.c:355:'
      )
    );

    await submitProductInquiry(null, buildFormData());
    await flushAfter();

    const recorded = mocks.update.mock.calls.at(-1)?.[0]?.email_error ?? '';
    expect(recorded).toContain('2525');
    expect(recorded).toContain('465');
    expect(recorded).not.toContain('ssl3_get_record');
  });
});
