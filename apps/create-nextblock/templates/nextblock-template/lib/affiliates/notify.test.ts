import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lifecycle notifier runs after the response of approvals, webhooks and payout runs, so its
 * guarantees are what matter: it never throws (SMTP down, templates broken, database gone), the
 * alert is recorded even when no mail can go out, duplicate events do not stack alerts or mails,
 * and recipients come from the server (settings, store contact ladder, the partner's own auth
 * address), never from the caller. The public sandbox (NEXT_PUBLIC_IS_SANDBOX === 'true') mails
 * nobody at all: every address it knows is one a visitor typed.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  db: null as any,
  clientThrows: false,
  sendEmail: vi.fn(),
  isEmailConfigured: vi.fn(),
  resolveSellerContactEmail: vi.fn(),
  buildAffiliateEmail: vi.fn(),
  buildAffiliateSystemAlert: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
  afterThrows: false,
}));

// The constants contract and the real money formatter only (the rest of the lib is still being
// written). vi.importActual, not import(): Nx would otherwise treat the lib as lazy-loaded.
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/money')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/payout-methods')),
}));

vi.mock('@nextblock-cms/affiliates/server', () => ({
  buildAffiliateEmail: mocks.buildAffiliateEmail,
  buildAffiliateSystemAlert: mocks.buildAffiliateSystemAlert,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => {
    if (mocks.clientThrows) throw new Error('Missing Supabase Service Role environment variables');
    return mocks.db;
  },
}));

vi.mock('next/server', () => ({
  after: (callback: () => unknown) => {
    if (mocks.afterThrows) throw new Error('`after` was called outside a request scope.');
    mocks.afterCallbacks.push(callback);
  },
}));

vi.mock('../../app/actions/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('../../app/lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop' }) }));
vi.mock('../commerce/seller-contact', () => ({ resolveSellerContactEmail: mocks.resolveSellerContactEmail }));
vi.mock('../config/email-settings', () => ({ isEmailConfigured: mocks.isEmailConfigured }));
// settings.ts imports the CMS actor for its save path; the notifier only reads.
vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: vi.fn() }));

import { formatAffiliateMoney } from '@nextblock-cms/affiliates';
import {
  notifyAffiliateLifecycle,
  scheduleAffiliateLifecycleNotification,
  scheduleAffiliateNotification,
  sweepAffiliateCommissionNotifications,
  sweepAffiliateRefundAlertEmails,
} from './notify';

/* ------------------------------------------------------------ fake database --- */

function readPath(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) {
    const value = row[json[1]]?.[json[2]];
    return value == null ? null : String(value);
  }
  return row[column];
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(row: Row) => boolean> = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private max: number | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => readPath(row, column) === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(readPath(row, column)));
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (readPath(row, column) ?? null) === value);
    return this;
  }
  gte(column: string, value: string) {
    this.filters.push((row) => String(readPath(row, column) ?? '') >= value);
    return this;
  }
  order() {
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  insert(row: Row) {
    this.mode = 'insert';
    this.payload = row;
    return this;
  }
  update(values: Row) {
    this.mode = 'update';
    this.payload = values;
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
    if (this.mode === 'insert') {
      if (this.db.failInsert) return { data: null, error: { message: 'insert failed' } };
      const inserted = { id: `alert-${++this.db.sequence}`, is_resolved: false, ...this.payload };
      rows.push(inserted);
      this.db.inserts.push(inserted);
      return { data: [inserted], error: null };
    }
    if (this.table === 'system_alerts' && this.mode === 'select' && this.db.failAlertLookup) {
      return { data: null, error: { message: 'lookup failed' } };
    }
    const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.mode === 'update') {
      for (const row of matched) Object.assign(row, this.payload);
      this.db.updates.push({ table: this.table, values: this.payload, count: matched.length });
      // PostgREST returns the updated rows when `.select()` follows; callers that ignore it still can.
      return { data: matched.map((row) => ({ ...row })), error: null };
    }
    return { data: this.max === null ? matched : matched.slice(0, this.max), error: null };
  }

  async maybeSingle() {
    const { data, error } = this.run();
    return { data: Array.isArray(data) ? data[0] ?? null : data, error };
  }
  async single() {
    return this.maybeSingle();
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  inserts: Row[] = [];
  updates: Array<{ table: string; values: unknown; count: number }> = [];
  sequence = 0;
  failInsert = false;
  failAlertLookup = false;
  users: Record<string, string | null> = {};
  claimRows: Row[] = [];
  claimError: { message: string } | null = null;
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  from(table: string) {
    return new FakeQuery(this, table);
  }
  async rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args });
    if (this.claimError) return { data: null, error: this.claimError };
    return { data: this.claimRows, error: null };
  }
  auth = {
    admin: {
      getUserById: async (id: string) => ({
        data: { user: id in this.users ? { id, email: this.users[id] } : null },
        error: id in this.users ? null : { message: 'User not found' },
      }),
    },
  };
}

/* ---------------------------------------------------------------- fixtures --- */

const PROFILE = {
  id: 'aff-1',
  user_id: 'user-1',
  handle: 'jane-doe',
  display_name: 'Jane Doe',
  preferred_locale: 'fr',
  status: 'ACTIVE',
};

const PROFILE_EN = {
  id: 'aff-2',
  user_id: 'user-2',
  handle: 'sam-smith',
  display_name: 'Sam Smith',
  preferred_locale: 'en',
  status: 'ACTIVE',
};

function seed(db: FakeDb) {
  db.tables['affiliate_profiles'] = [{ ...PROFILE }, { ...PROFILE_EN }];
  db.tables['affiliate_pages'] = [{ id: 'page-1', affiliate_id: 'aff-1' }];
  db.tables['site_settings'] = [
    { key: 'affiliates_settings', value: { notificationEmails: ['ops@maple.shop', 'owner@maple.shop'] } },
  ];
  db.tables['system_alerts'] = [];
  db.users = { 'user-1': 'Jane@Partner.dev', 'user-2': 'sam@partner.dev' };
}

function alerts(db: FakeDb, type?: string) {
  return (db.tables['system_alerts'] ?? []).filter((row) => !type || row.alert_type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db = new FakeDb();
  seed(mocks.db);
  mocks.clientThrows = false;
  mocks.afterCallbacks = [];
  mocks.afterThrows = false;
  mocks.isEmailConfigured.mockResolvedValue(true);
  mocks.sendEmail.mockResolvedValue({ messageId: 'm-1' });
  mocks.resolveSellerContactEmail.mockResolvedValue({ email: 'store@maple.shop', source: 'store_contact' });
  mocks.buildAffiliateEmail.mockImplementation((event: string) => ({
    subject: `Subject for ${event}`,
    text: `Text for ${event}`,
    html: `{{brand_header}}<p>${event}</p>`,
  }));
  mocks.buildAffiliateSystemAlert.mockImplementation((event: string) => ({
    alert_type: 'ignored-by-the-notifier',
    title: `Title ${event}`,
    message: `Message ${event}`,
    metadata: { action_url: '/cms/affiliates/approvals', action_label: 'Review' },
  }));
  vi.stubEnv('NEXT_PUBLIC_URL', 'https://maple.shop');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------- tests --- */

describe('notifyAffiliateLifecycle: never throws', () => {
  it('resolves when the service-role client cannot be built', async () => {
    mocks.clientThrows = true;
    await expect(notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1' })).resolves.toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  // 2026-11-03: the sandbox's admin login is public, so its notification addresses are whatever
  // a visitor typed; every submit or review round would otherwise mail all of them.
  it('records the alert but mails nobody on the sandbox, even with SMTP configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(
      notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1', tierName: 'Founding Ambassador', spotsRemaining: 41 }),
    ).resolves.toBeUndefined();
    expect(alerts(mocks.db, 'affiliate_signed_up')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('records the alert but sends nothing when SMTP is not configured', async () => {
    mocks.isEmailConfigured.mockResolvedValue(false);
    await expect(
      notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1', tierName: 'Founding Ambassador', spotsRemaining: 41 }),
    ).resolves.toBeUndefined();
    expect(alerts(mocks.db, 'affiliate_signed_up')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('resolves when every send fails, and leaves the alert unmarked so a retry can mail', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(notifyAffiliateLifecycle('PROFILE_COMPLETED', { affiliateId: 'aff-1' })).resolves.toBeUndefined();
    const [alert] = alerts(mocks.db, 'affiliate_profile_completed');
    expect(alert).toBeDefined();
    expect(alert.metadata.emailed_at).toBeUndefined();
  });

  it('falls back to built-in alert copy when the templates throw', async () => {
    mocks.buildAffiliateSystemAlert.mockImplementation(() => {
      throw new Error('template bug');
    });
    mocks.buildAffiliateEmail.mockImplementation(() => {
      throw new Error('template bug');
    });
    await expect(notifyAffiliateLifecycle('PAYOUT_CONFIGURED', { affiliateId: 'aff-1' })).resolves.toBeUndefined();
    const [alert] = alerts(mocks.db, 'affiliate_payout_configured');
    expect(alert.title).toBe('Partner payouts connected');
    expect(alert.metadata).toMatchObject({ action_url: '/cms/affiliates', action_label: 'View partners', affiliate_id: 'aff-1' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('resolves when the alert insert fails and still emails the admins', async () => {
    mocks.db.failInsert = true;
    await expect(notifyAffiliateLifecycle('PAGE_SUBMITTED', { affiliateId: 'aff-1' })).resolves.toBeUndefined();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown events and payloads without an affiliate id', async () => {
    await notifyAffiliateLifecycle('SOMETHING_ELSE' as never, { affiliateId: 'aff-1' });
    await notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: '' });
    await notifyAffiliateLifecycle('SIGNED_UP', null as never);
    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('admin events', () => {
  it('inserts the alert with server-side ids and mails each admin recipient separately, in English', async () => {
    await notifyAffiliateLifecycle('SIGNED_UP', {
      affiliateId: 'aff-1',
      tierName: 'Founding Ambassador',
      spotsRemaining: 41,
    });

    const [alert] = alerts(mocks.db, 'affiliate_signed_up');
    expect(alert).toMatchObject({
      alert_type: 'affiliate_signed_up',
      title: 'Title SIGNED_UP',
      message: 'Message SIGNED_UP',
    });
    expect(alert.metadata).toMatchObject({ affiliate_id: 'aff-1', action_label: 'Review' });

    const [, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(data).toMatchObject({
      locale: 'en',
      siteName: 'Maple Shop',
      siteUrl: 'https://maple.shop',
      recipientName: null,
      handle: 'jane-doe',
      displayName: 'Jane Doe',
      storefrontUrl: 'https://maple.shop/partners/jane-doe',
      cmsUrl: 'https://maple.shop/cms/affiliates',
      tierName: 'Founding Ambassador',
      spotsRemaining: 41,
    });

    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['ops@maple.shop', 'owner@maple.shop']);
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      subject: 'Subject for SIGNED_UP',
      html: '{{brand_header}}<p>SIGNED_UP</p>',
    });
    // Mailed once: a repeat of the same one-time step neither stacks an alert nor re-mails.
    expect(alert.metadata.emailed_at).toEqual(expect.any(String));
    await notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1' });
    expect(alerts(mocks.db, 'affiliate_signed_up')).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('falls back to the store contact address, skipping placeholder addresses', async () => {
    mocks.db.tables['site_settings'] = [];
    await notifyAffiliateLifecycle('PROFILE_COMPLETED', { affiliateId: 'aff-1' });
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['store@maple.shop']);

    mocks.sendEmail.mockClear();
    mocks.resolveSellerContactEmail.mockResolvedValue({ email: 'contact@example.com', source: 'privacy' });
    await notifyAffiliateLifecycle('PAYOUT_CONFIGURED', { affiliateId: 'aff-1' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('dedupes PAYOUT_FAILED by payout id', async () => {
    const payout = { payoutId: 'payout-1', amountCents: 12_500, currency: 'USD', reason: 'balance_insufficient' };
    await notifyAffiliateLifecycle('PAYOUT_FAILED', { affiliateId: 'aff-1', payout });
    await notifyAffiliateLifecycle('PAYOUT_FAILED', { affiliateId: 'aff-1', payout });

    const failed = alerts(mocks.db, 'affiliate_payout_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].metadata).toMatchObject({ payout_id: 'payout-1', reason: 'balance_insufficient' });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2); // two admins, once

    const [, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(data).toMatchObject({
      amountLabel: formatAffiliateMoney(12_500, 'USD', 'en'),
      reason: 'balance_insufficient',
      cmsUrl: 'https://maple.shop/cms/affiliates/payouts',
    });

    await notifyAffiliateLifecycle('PAYOUT_FAILED', { affiliateId: 'aff-1', payout: { ...payout, payoutId: 'payout-2' } });
    expect(alerts(mocks.db, 'affiliate_payout_failed')).toHaveLength(2);
  });

  it('retries the email (not the alert) for a payout whose first notice failed to send', async () => {
    const payout = { payoutId: 'payout-9', amountCents: 500, currency: 'USD' };
    mocks.sendEmail.mockRejectedValue(new Error('ECONNREFUSED'));
    await notifyAffiliateLifecycle('PAYOUT_FAILED', { affiliateId: 'aff-1', payout });

    mocks.sendEmail.mockReset();
    mocks.sendEmail.mockResolvedValue({});
    await notifyAffiliateLifecycle('PAYOUT_FAILED', { affiliateId: 'aff-1', payout });

    expect(alerts(mocks.db, 'affiliate_payout_failed')).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(alerts(mocks.db, 'affiliate_payout_failed')[0].metadata.emailed_at).toEqual(expect.any(String));
  });

  it('only mails for a refund-after-payout alert the database already raised', async () => {
    mocks.db.tables['system_alerts'].push({
      id: 'sql-alert',
      alert_type: 'affiliate_refund_after_payout',
      is_resolved: false,
      metadata: { commission_id: 'c-1', order_id: 'o-1', action_url: '/cms/affiliates/payouts', action_label: 'Review payouts' },
    });

    await notifyAffiliateLifecycle('REFUND_AFTER_PAYOUT', {
      affiliateId: 'aff-1',
      orderId: 'o-1',
      commission: { commissionId: 'c-1', amountCents: 900, currency: 'CAD', ratePercent: 50, clearsAt: '2026-11-20T00:00:00Z' },
    });

    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(alerts(mocks.db, 'affiliate_refund_after_payout')[0].metadata).toMatchObject({
      commission_id: 'c-1',
      emailed_at: expect.any(String),
    });

    // A webhook redelivery afterwards is a no-op.
    await notifyAffiliateLifecycle('REFUND_AFTER_PAYOUT', { affiliateId: 'aff-1', orderId: 'o-1' });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('resolves the page’s older submission alerts before inserting the new one', async () => {
    mocks.db.tables['system_alerts'].push(
      { id: 'old-1', alert_type: 'affiliate_page_submitted', is_resolved: false, metadata: { page_id: 'page-1' } },
      { id: 'other', alert_type: 'affiliate_page_submitted', is_resolved: false, metadata: { page_id: 'page-2' } },
    );

    await notifyAffiliateLifecycle('PAGE_SUBMITTED', { affiliateId: 'aff-1' });

    const byId = Object.fromEntries(alerts(mocks.db).map((row) => [row.id, row]));
    expect(byId['old-1'].is_resolved).toBe(true);
    expect(byId['old-1'].resolved_at).toEqual(expect.any(String));
    expect(byId['other'].is_resolved).toBe(false);
    const fresh = alerts(mocks.db, 'affiliate_page_submitted').filter((row) => !row.is_resolved && row.id !== 'other');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].metadata).toMatchObject({ page_id: 'page-1', affiliate_id: 'aff-1', action_url: '/cms/affiliates/approvals' });

    const [, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(data.cmsUrl).toBe('https://maple.shop/cms/affiliates/approvals');
  });

  it('never lets a template point the alert link outside the affiliates CMS', async () => {
    for (const actionUrl of ['https://evil.example/phish', '//evil.example', '/cms/users', '/cms/affiliates\\..\\x']) {
      mocks.buildAffiliateSystemAlert.mockReturnValueOnce({
        alert_type: 'affiliate_page_submitted',
        title: 't',
        message: 'm',
        metadata: { action_url: actionUrl, action_label: 'Go' },
      });
      await notifyAffiliateLifecycle('PAGE_SUBMITTED', { affiliateId: 'aff-1', pageId: 'page-1' });
    }
    for (const alert of alerts(mocks.db, 'affiliate_page_submitted')) {
      expect(alert.metadata.action_url).toBe('/cms/affiliates/approvals');
    }
  });

  it('strips CR/LF from the subject whatever the template produced', async () => {
    mocks.buildAffiliateEmail.mockReturnValue({ subject: 'Hello\r\nBcc: victim@evil.example', text: 't', html: 'h' });
    await notifyAffiliateLifecycle('PROFILE_COMPLETED', { affiliateId: 'aff-1' });
    for (const [params] of mocks.sendEmail.mock.calls) {
      expect(params.subject).not.toMatch(/[\r\n]/);
    }
  });

  it('records alerts but mails nobody when the site address is the unconfigured default', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
    vi.stubEnv('NODE_ENV', 'production');

    await notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1' });
    expect(alerts(mocks.db, 'affiliate_signed_up')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('allows localhost links in development', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
    vi.stubEnv('NODE_ENV', 'development');

    await notifyAffiliateLifecycle('SIGNED_UP', { affiliateId: 'aff-1' });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe('partner events', () => {
  it('mails the partner’s own auth address in their language, with no alert', async () => {
    await notifyAffiliateLifecycle('PAGE_PUBLISHED', { affiliateId: 'aff-1', pageId: 'page-1' });

    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe('jane@partner.dev');

    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(event).toBe('PAGE_PUBLISHED');
    expect(data).toMatchObject({
      locale: 'fr',
      recipientName: 'Jane Doe',
      storefrontUrl: 'https://maple.shop/partners/jane-doe',
      portalUrl: 'https://maple.shop/portal/retailer',
    });
  });

  it('formats commission money and dates per the partner locale', async () => {
    // The clearance date is shown only while it is ahead: pin "now" before it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    try {
      await notifyAffiliateLifecycle('COMMISSION_EARNED', {
        affiliateId: 'aff-2',
        commission: { commissionId: 'c-7', amountCents: 4200, currency: 'usd', ratePercent: 50, clearsAt: '2026-11-26T15:00:00Z' },
      });
    } finally {
      vi.useRealTimers();
    }
    const [, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(data).toMatchObject({
      locale: 'en',
      amountLabel: formatAffiliateMoney(4200, 'USD', 'en'),
      ratePercent: 50,
      clearsAtLabel: 'November 26, 2026',
      portalUrl: 'https://maple.shop/portal/retailer/payouts',
    });
  });

  // The hold counts from the payment (02035): a commission reconcile records after a long pause can
  // arrive with clears_at already behind it (it clears at the next promote). "It clears on" a date
  // that is gone would be wrong, so the email gets no date and says only what was earned.
  it('gives a commission email no clearance date once that date has passed', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await notifyAffiliateLifecycle('COMMISSION_EARNED', {
      affiliateId: 'aff-2',
      commission: { commissionId: 'c-8', amountCents: 4200, currency: 'USD', ratePercent: 50, clearsAt: past },
    });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ ratePercent: 50, clearsAtLabel: null });
  });

  it('carries the feedback note for a change request and deep-links the studio', async () => {
    await notifyAffiliateLifecycle('CHANGES_REQUESTED', { affiliateId: 'aff-1', feedbackNote: '  Add a disclosure.  ' });
    const [, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(data.feedbackNote).toBe('Add a disclosure.');
    expect(data.portalUrl).toBe('https://maple.shop/portal/retailer/storefront');
  });

  it('carries the pause reason and whether the storefront was live to a suspension notice', async () => {
    await notifyAffiliateLifecycle('PARTNER_SUSPENDED', {
      affiliateId: 'aff-1',
      suspendedReason: '  Chargebacks on 3 orders.\nCall us.  ',
      storefrontLive: true,
    });

    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['jane@partner.dev']);
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(event).toBe('PARTNER_SUSPENDED');
    expect(data).toMatchObject({
      locale: 'fr',
      recipientName: 'Jane Doe',
      reason: 'Chargebacks on 3 orders.\nCall us.',
      storefrontLive: true,
      portalUrl: 'https://maple.shop/portal/retailer',
    });
  });

  it('sends a reactivation notice without a reason, and never reads one from a payout', async () => {
    await notifyAffiliateLifecycle('PARTNER_REACTIVATED', { affiliateId: 'aff-2', storefrontLive: false });
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(event).toBe('PARTNER_REACTIVATED');
    expect(data).toMatchObject({ locale: 'en', reason: null, storefrontLive: false });
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['sam@partner.dev']);

    mocks.buildAffiliateEmail.mockClear();
    await notifyAffiliateLifecycle('PARTNER_SUSPENDED', {
      affiliateId: 'aff-2',
      payout: { payoutId: 'p-1', amountCents: 1, currency: 'USD', reason: 'balance_insufficient' },
    });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ reason: null, storefrontLive: null });
  });

  it('mails a tier change to the partner with the new tier and its rate, and no alert', async () => {
    await notifyAffiliateLifecycle('TIER_CHANGED', { affiliateId: 'aff-1', tierName: '  Partenaire Élite  ', tierRatePercent: 35 });

    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['jane@partner.dev']);
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(event).toBe('TIER_CHANGED');
    expect(data).toMatchObject({
      locale: 'fr',
      recipientName: 'Jane Doe',
      tierName: 'Partenaire Élite',
      ratePercent: 35,
      portalUrl: 'https://maple.shop/portal/retailer',
    });

    // A missing rate stays missing (never 0 %), and only TIER_CHANGED reads tierRatePercent.
    mocks.buildAffiliateEmail.mockClear();
    await notifyAffiliateLifecycle('TIER_CHANGED', { affiliateId: 'aff-2', tierName: 'Elite Partner', tierRatePercent: null });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ locale: 'en', tierName: 'Elite Partner', ratePercent: null });
    mocks.buildAffiliateEmail.mockClear();
    await notifyAffiliateLifecycle('PAGE_PUBLISHED', { affiliateId: 'aff-2', tierRatePercent: 35 });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ ratePercent: null });
  });

  it('hands a manual payout to the template with its channel, reference and note, and no transfer (02036)', async () => {
    await notifyAffiliateLifecycle('PAYOUT_SENT', {
      affiliateId: 'aff-2',
      payout: {
        payoutId: 'p-9',
        amountCents: 12_000,
        currency: 'USD',
        method: 'manual',
        channel: 'interac',
        reference: ' CA1x2y3z ',
        note: 'Thanks for October!',
      },
    });
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0] ?? [];
    expect(event).toBe('PAYOUT_SENT');
    expect(data).toMatchObject({
      locale: 'en',
      amountLabel: formatAffiliateMoney(12_000, 'USD', 'en'),
      payoutMethod: 'manual',
      payoutChannel: 'interac',
      payoutReference: 'CA1x2y3z',
      payoutNote: 'Thanks for October!',
      transferId: null,
    });
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['sam@partner.dev']);

    // A Stripe payout carries none of it.
    mocks.buildAffiliateEmail.mockClear();
    await notifyAffiliateLifecycle('PAYOUT_SENT', {
      affiliateId: 'aff-2',
      payout: { payoutId: 'p-1', amountCents: 100, currency: 'USD', transferId: 'tr_1', channel: 'paypal', reference: 'x' },
    });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({
      payoutMethod: null,
      payoutChannel: null,
      payoutReference: null,
      payoutNote: null,
      transferId: 'tr_1',
    });
  });

  it('hands a PayPal payout (02037) to the template as one PayPal paid, with the transaction id as the reference', async () => {
    await notifyAffiliateLifecycle('PAYOUT_SENT', {
      affiliateId: 'aff-2',
      payout: { payoutId: 'p-7', amountCents: 5000, currency: 'USD', transferId: '5TY12345AB678901C', method: 'paypal' },
    });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({
      payoutMethod: 'paypal',
      payoutChannel: null,
      payoutReference: '5TY12345AB678901C',
      payoutNote: null,
      payoutPrepared: null,
      portalUrl: 'https://maple.shop/portal/retailer/payouts',
    });

    // A commission the program pays with PayPal is worded without Stripe too.
    mocks.buildAffiliateEmail.mockClear();
    await notifyAffiliateLifecycle('COMMISSION_EARNED', {
      affiliateId: 'aff-2',
      commission: { commissionId: 'c-1', amountCents: 900, currency: 'USD', ratePercent: 10, clearsAt: '', payoutMethod: 'paypal' },
    });
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ payoutMethod: 'manual' });
  });

  it('mails the partner a PayPal payout waiting to be claimed (02037), naming the address PayPal emailed, in their language', async () => {
    await notifyAffiliateLifecycle('PAYPAL_UNCLAIMED', {
      affiliateId: 'aff-1',
      payout: { payoutId: 'p-8', amountCents: 4500, currency: 'USD', method: 'paypal', receiver: ' jane@paypal.example ' },
    });
    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['jane@partner.dev']);
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0] ?? [];
    expect(event).toBe('PAYPAL_UNCLAIMED');
    expect(data).toMatchObject({
      locale: 'fr',
      recipientName: 'Jane Doe',
      amountLabel: formatAffiliateMoney(4500, 'USD', 'fr'),
      payoutEmail: 'jane@paypal.example',
      portalUrl: 'https://maple.shop/portal/retailer/payouts',
    });
  });

  it('mails the partner a PayPal payout PayPal would not pay (02037) with the run’s reason code, which the template words', async () => {
    await notifyAffiliateLifecycle('PAYPAL_PAYOUT_FAILED', {
      affiliateId: 'aff-2',
      payout: { payoutId: 'p-9', amountCents: 4500, currency: 'USD', method: 'paypal', reason: 'paypal_failed:receiver_unregistered' },
    });
    // A partner event: no admin alert, no admin recipient.
    expect(mocks.db.inserts).toHaveLength(0);
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(['sam@partner.dev']);
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0] ?? [];
    expect(event).toBe('PAYPAL_PAYOUT_FAILED');
    expect(data).toMatchObject({
      locale: 'en',
      amountLabel: formatAffiliateMoney(4500, 'USD', 'en'),
      reason: 'paypal_failed:receiver_unregistered',
      payoutEmail: null,
      portalUrl: 'https://maple.shop/portal/retailer/payouts',
    });
  });

  it('skips a partner without a deliverable address', async () => {
    mocks.db.users['user-1'] = 'demo@example.com';
    await notifyAffiliateLifecycle('PAYOUT_SENT', {
      affiliateId: 'aff-1',
      payout: { payoutId: 'p-1', amountCents: 100, currency: 'USD', transferId: 'tr_1' },
    });
    delete mocks.db.users['user-2'];
    await notifyAffiliateLifecycle('PAYOUT_SENT', { affiliateId: 'aff-2' });
    await notifyAffiliateLifecycle('PAYOUT_SENT', { affiliateId: 'unknown-affiliate' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  // 2026-11-03: the sandbox's partner login is public and anyone can sign a partner up there, so a
  // partner's auth address is one a visitor chose. Not only the admin events: no partner event mails.
  const PARTNER_EVENTS: Array<
    [Parameters<typeof notifyAffiliateLifecycle>[0], Parameters<typeof notifyAffiliateLifecycle>[1], string]
  > = [
    ['PAGE_PUBLISHED', { affiliateId: 'aff-1', pageId: 'page-1' }, 'jane@partner.dev'],
    ['CHANGES_REQUESTED', { affiliateId: 'aff-1', feedbackNote: 'Add a disclosure.' }, 'jane@partner.dev'],
    [
      'COMMISSION_EARNED',
      {
        affiliateId: 'aff-2',
        commission: { commissionId: 'c-7', amountCents: 4200, currency: 'USD', ratePercent: 50, clearsAt: '2026-11-26T15:00:00Z' },
      },
      'sam@partner.dev',
    ],
    ['PAYOUT_SENT', { affiliateId: 'aff-1', payout: { payoutId: 'p-1', amountCents: 100, currency: 'USD', transferId: 'tr_1' } }, 'jane@partner.dev'],
    ['PARTNER_SUSPENDED', { affiliateId: 'aff-1', suspendedReason: 'Chargebacks', storefrontLive: true }, 'jane@partner.dev'],
    ['PARTNER_REACTIVATED', { affiliateId: 'aff-2', storefrontLive: true }, 'sam@partner.dev'],
    ['TIER_CHANGED', { affiliateId: 'aff-1', tierName: 'Elite Partner', tierRatePercent: 35 }, 'jane@partner.dev'],
    // 02037: the PayPal notices are partner events too.
    [
      'PAYPAL_UNCLAIMED',
      { affiliateId: 'aff-2', payout: { payoutId: 'p-2', amountCents: 4500, currency: 'USD', method: 'paypal', receiver: 'sam@paypal.example' } },
      'sam@partner.dev',
    ],
    [
      'PAYPAL_PAYOUT_FAILED',
      { affiliateId: 'aff-1', payout: { payoutId: 'p-3', amountCents: 4500, currency: 'USD', method: 'paypal', reason: 'paypal_returned' } },
      'jane@partner.dev',
    ],
  ];

  it.each(PARTNER_EVENTS)('%s mails nobody on the sandbox, even with SMTP configured', async (event, payload) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(notifyAffiliateLifecycle(event, payload)).resolves.toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.buildAffiliateEmail).not.toHaveBeenCalled();
    expect(mocks.db.inserts).toHaveLength(0);
  });

  it.each(PARTNER_EVENTS)(
    '%s still mails the partner off the sandbox (only the exact value "true" is the sandbox)',
    async (event, payload, to) => {
      for (const value of ['', 'false', 'TRUE', '1']) {
        vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
        mocks.sendEmail.mockClear();
        await notifyAffiliateLifecycle(event, payload);
        expect(mocks.sendEmail.mock.calls.map(([params]) => params.to), value).toEqual([to]);
      }
    },
  );
});

describe('sweepAffiliateCommissionNotifications', () => {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const commission = (overrides: Row) => ({
    id: 'c-x',
    affiliate_id: 'aff-1',
    status: 'PENDING_CLEARANCE',
    commission_amount_cents: 1000,
    refunded_amount_cents: 0,
    currency: 'USD',
    commission_rate_snapshot: 50,
    clears_at: iso(30 * 86_400_000),
    created_at: iso(-60_000),
    ...overrides,
  });

  it('claims through the RPC and mails one grouped notice per partner', async () => {
    mocks.db.claimRows = [
      commission({ id: 'c-1', commission_amount_cents: 1000, clears_at: iso(29 * 86_400_000) }),
      commission({ id: 'c-2', commission_amount_cents: 2500, refunded_amount_cents: 500 }),
      commission({ id: 'c-3', affiliate_id: 'aff-2', commission_amount_cents: 700 }),
      commission({ id: 'c-4', commission_amount_cents: 0 }), // tombstone
      commission({ id: 'c-5', created_at: iso(-30 * 86_400_000) }), // stale backlog
      commission({ id: 'c-6', status: 'VOIDED_REFUND' }),
    ];

    await expect(sweepAffiliateCommissionNotifications(25)).resolves.toBe(6);
    expect(mocks.db.rpcCalls).toEqual([{ fn: 'claim_affiliate_commission_notifications', args: { p_limit: 25 } }]);
    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to).sort()).toEqual(['jane@partner.dev', 'sam@partner.dev']);

    const janeData = mocks.buildAffiliateEmail.mock.calls.find(([, data]) => data.handle === 'jane-doe')?.[1];
    expect(janeData).toMatchObject({
      locale: 'fr',
      amountLabel: formatAffiliateMoney(3000, 'USD', 'fr'),
      ratePercent: 50,
    });
  });

  it('dates a grouped notice by its earliest clearance still ahead, and gives none when every one has passed', async () => {
    const day = 86_400_000;
    const longDate = (iso: string, locale: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
    mocks.db.claimRows = [
      // Jane: a late commission (recorded now, cleared 10 days ago) beside one still clearing
      commission({ id: 'c-1', clears_at: iso(-10 * day) }),
      commission({ id: 'c-2', clears_at: iso(25 * day) }),
      commission({ id: 'c-7', clears_at: iso(28 * day) }),
      // Sam: only a late one
      commission({ id: 'c-3', affiliate_id: 'aff-2', clears_at: iso(-2 * day) }),
    ];

    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(4);

    const byHandle = (handle: string) => mocks.buildAffiliateEmail.mock.calls.find(([, data]) => data.handle === handle)?.[1];
    expect(byHandle('jane-doe')).toMatchObject({ locale: 'fr', clearsAtLabel: longDate(iso(25 * day), 'fr-CA') });
    expect(byHandle('sam-smith')).toMatchObject({ locale: 'en', clearsAtLabel: null });
  });

  it('tells the partner a commission is paid by hand when its gateway is routed to manual payouts (02036)', async () => {
    mocks.db.tables['site_settings'] = [
      {
        key: 'affiliates_settings',
        value: { notificationEmails: [], payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } },
      },
    ];
    mocks.db.claimRows = [
      commission({ id: 'c-1', gateway: 'STRIPE', commission_amount_cents: 1000 }),
      commission({ id: 'c-2', gateway: 'FREEMIUS', commission_amount_cents: 2500 }),
    ];

    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(2);

    // One notice per payout method: the Freemius commission is explained as paid by hand.
    const notices = mocks.buildAffiliateEmail.mock.calls.map(([, data]) => [data.amountLabel, data.payoutMethod]);
    expect(notices).toEqual(
      expect.arrayContaining([
        [formatAffiliateMoney(1000, 'USD', 'fr'), null],
        [formatAffiliateMoney(2500, 'USD', 'fr'), 'manual'],
      ])
    );
    expect(notices).toHaveLength(2);
  });

  it('clamps the claim size and never throws', async () => {
    await expect(sweepAffiliateCommissionNotifications(10_000)).resolves.toBe(0);
    await expect(sweepAffiliateCommissionNotifications(0)).resolves.toBe(0);
    expect(mocks.db.rpcCalls.map((call: { args: { p_limit: number } }) => call.args.p_limit)).toEqual([200, 1]);

    mocks.db.claimError = { message: 'function does not exist' };
    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(0);

    mocks.clientThrows = true;
    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(0);
  });

  it('still claims (drains) when no mail can go out', async () => {
    mocks.isEmailConfigured.mockResolvedValue(false);
    mocks.db.claimRows = [commission({ id: 'c-1' })];
    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  // 2026-11-03: the sandbox's partner logins are public. The sweep still claims (drains), as it does
  // without SMTP (a backlog is not news, and the reset rebuilds the ledger), but mails no partner.
  it('still claims (drains) but mails nobody on the sandbox, even with SMTP configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.db.claimRows = [commission({ id: 'c-1' }), commission({ id: 'c-3', affiliate_id: 'aff-2' })];

    await expect(sweepAffiliateCommissionNotifications()).resolves.toBe(2);

    expect(mocks.db.rpcCalls).toEqual([{ fn: 'claim_affiliate_commission_notifications', args: { p_limit: 50 } }]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.buildAffiliateEmail).not.toHaveBeenCalled();
  });

  it('mails the partners off the sandbox (only the exact value "true" is the sandbox)', async () => {
    mocks.db.claimRows = [commission({ id: 'c-1' }), commission({ id: 'c-3', affiliate_id: 'aff-2' })];
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.sendEmail.mockClear();

      await expect(sweepAffiliateCommissionNotifications(), value).resolves.toBe(2);

      expect(mocks.sendEmail.mock.calls.map(([params]) => params.to).sort(), value).toEqual(['jane@partner.dev', 'sam@partner.dev']);
    }
  });
});

describe('sweepAffiliateRefundAlertEmails', () => {
  // The database raises these alerts itself (02030) on paths that never call the notifier (the
  // webhooks, the CMS order status actions, an order delete). Before 2026-10-27 nothing mailed them.
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const refundAlert = (overrides: Row = {}, metadata: Row = {}) => ({
    id: 'alert-r1',
    alert_type: 'affiliate_refund_after_payout',
    is_resolved: false,
    created_at: iso(-60_000),
    title: 'Refund after an affiliate payout',
    message: 'Order ord-1 was refunded after its commission was paid or queued.',
    ...overrides,
    metadata: {
      commission_id: 'com-1',
      affiliate_id: 'aff-2',
      order_id: 'ord-1',
      payout_id: 'pay-1',
      reason: 'refunded',
      action_url: '/cms/affiliates/payouts',
      action_label: 'Review payouts',
      ...metadata,
    },
  });

  beforeEach(() => {
    mocks.db.tables['affiliate_commissions'] = [
      { id: 'com-1', commission_amount_cents: 2500, currency: 'USD', commission_rate_snapshot: 35, clears_at: iso(-86_400_000) },
    ];
    mocks.db.tables['affiliate_payouts'] = [{ id: 'pay-1', amount_cents: 9000, currency: 'USD', stripe_transfer_id: 'tr_123' }];
  });

  it('mails each unresolved refund alert once, with its order, amount and transfer, and stamps it', async () => {
    mocks.db.tables['system_alerts'] = [refundAlert()];

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(1);

    expect(mocks.sendEmail.mock.calls.map(([params]) => params.to).sort()).toEqual(['ops@maple.shop', 'owner@maple.shop']);
    const [event, data] = mocks.buildAffiliateEmail.mock.calls[0];
    expect(event).toBe('REFUND_AFTER_PAYOUT');
    expect(data).toMatchObject({
      locale: 'en',
      orderId: 'ord-1',
      handle: 'sam-smith',
      amountLabel: formatAffiliateMoney(2500, 'USD', 'en'),
      transferId: 'tr_123',
    });
    const [alert] = alerts(mocks.db, 'affiliate_refund_after_payout');
    expect(typeof alert.metadata.emailed_at).toBe('string');
    expect(alert.metadata).toMatchObject({ commission_id: 'com-1', action_url: '/cms/affiliates/payouts' });

    // A second sweep (the next webhook, the payout cron) finds nothing left to mail.
    mocks.sendEmail.mockClear();
    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('tells the template when the refunded commission was paid by a payout recorded by hand (02036)', async () => {
    mocks.db.tables['affiliate_payouts'] = [{ id: 'pay-1', amount_cents: 9000, currency: 'USD', stripe_transfer_id: null, method: 'manual' }];
    mocks.db.tables['system_alerts'] = [refundAlert({}, { payout_method: 'manual' })];

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(1);

    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ payoutMethod: 'manual', transferId: null, payoutPrepared: null });
  });

  it('tells the template when the refunded commission sits in a PayPal payout, still in flight or paid (02037)', async () => {
    mocks.db.tables['affiliate_payouts'] = [
      { id: 'pay-1', amount_cents: 9000, currency: 'USD', stripe_transfer_id: null, method: 'paypal', status: 'PROCESSING' },
    ];
    mocks.db.tables['system_alerts'] = [refundAlert({}, { payout_method: 'paypal', payout_status: 'PROCESSING' })];
    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(1);
    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ payoutMethod: 'paypal', payoutPrepared: true });
  });

  it('says the manual payout was only prepared when the database saw it PROCESSING, whatever it became since (02036)', async () => {
    // Recorded since the alert: the alert's own status decides the advice it mailed for.
    mocks.db.tables['affiliate_payouts'] = [
      { id: 'pay-1', amount_cents: 9000, currency: 'USD', stripe_transfer_id: null, method: 'manual', status: 'COMPLETED' },
    ];
    mocks.db.tables['system_alerts'] = [refundAlert({}, { payout_method: 'manual', payout_status: 'PROCESSING' })];

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(1);

    expect(mocks.buildAffiliateEmail.mock.calls[0]?.[1]).toMatchObject({ payoutMethod: 'manual', payoutPrepared: true });
  });

  it('leaves resolved, mailed, stale, other and freshly claimed alerts alone, and retries a lapsed claim', async () => {
    mocks.db.tables['system_alerts'] = [
      refundAlert({ id: 'resolved', is_resolved: true }),
      refundAlert({ id: 'mailed' }, { emailed_at: iso(-3_600_000) }),
      refundAlert({ id: 'stale', created_at: iso(-15 * 86_400_000) }),
      refundAlert({ id: 'other-type', alert_type: 'affiliate_payout_failed' }),
      refundAlert({ id: 'claimed' }, { email_claimed_at: iso(-60_000) }),
      refundAlert({ id: 'no-affiliate' }, { affiliate_id: null }),
      refundAlert({ id: 'lapsed' }, { email_claimed_at: iso(-30 * 60_000) }),
    ];

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(1);

    const stamped = alerts(mocks.db).filter((row) => row.metadata.emailed_at && row.id !== 'mailed');
    expect(stamped.map((row) => row.id)).toEqual(['lapsed']);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2); // one alert, two recipients
  });

  it('keeps the alert unmailed when every send fails, so a later sweep retries once the claim lapses', async () => {
    mocks.db.tables['system_alerts'] = [refundAlert()];
    mocks.sendEmail.mockRejectedValue(new Error('SMTP down'));

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);

    const [alert] = alerts(mocks.db, 'affiliate_refund_after_payout');
    expect(alert.metadata.emailed_at).toBeUndefined();
    expect(typeof alert.metadata.email_claimed_at).toBe('string');
  });

  it('claims and sends nothing without SMTP, and never throws', async () => {
    mocks.db.tables['system_alerts'] = [refundAlert()];
    mocks.isEmailConfigured.mockResolvedValue(false);
    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);
    expect(alerts(mocks.db)[0].metadata.email_claimed_at).toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    mocks.isEmailConfigured.mockResolvedValue(true);
    mocks.db.failAlertLookup = true;
    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);

    mocks.clientThrows = true;
    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);
  });

  // 2026-11-03: the sandbox's admin login is public, so its notification addresses are whatever a
  // visitor typed. The sweep stops before its claim, as it does without SMTP: the alert stays
  // unclaimed and unmailed (the CMS banner still shows it).
  it('claims, stamps and mails nothing on the sandbox, even with SMTP configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.db.tables['system_alerts'] = [refundAlert()];

    await expect(sweepAffiliateRefundAlertEmails()).resolves.toBe(0);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.buildAffiliateEmail).not.toHaveBeenCalled();
    expect(mocks.db.updates).toEqual([]);
    const [alert] = alerts(mocks.db, 'affiliate_refund_after_payout');
    expect(alert.metadata.email_claimed_at).toBeUndefined();
    expect(alert.metadata.emailed_at).toBeUndefined();
  });

  it('mails off the sandbox (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.db.tables['system_alerts'] = [refundAlert()];
      mocks.sendEmail.mockClear();

      await expect(sweepAffiliateRefundAlertEmails(), value).resolves.toBe(1);

      expect(mocks.sendEmail.mock.calls.map(([params]) => params.to).sort(), value).toEqual(['ops@maple.shop', 'owner@maple.shop']);
      expect(alerts(mocks.db, 'affiliate_refund_after_payout')[0].metadata.emailed_at, value).toEqual(expect.any(String));
    }
  });
});

describe('scheduleAffiliateNotification', () => {
  it('defers the task with after() and swallows its errors', async () => {
    const task = vi.fn(async () => {
      throw new Error('boom');
    });
    scheduleAffiliateNotification(task);
    expect(task).not.toHaveBeenCalled();
    expect(mocks.afterCallbacks).toHaveLength(1);
    await expect(Promise.resolve(mocks.afterCallbacks[0]())).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs the task immediately outside a request scope, still without throwing', async () => {
    mocks.afterThrows = true;
    const task = vi.fn(() => {
      throw new Error('sync boom');
    });
    expect(() => scheduleAffiliateNotification(task)).not.toThrow();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('schedules a lifecycle notification', async () => {
    scheduleAffiliateLifecycleNotification('PAGE_PUBLISHED', { affiliateId: 'aff-1' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    await mocks.afterCallbacks[0]();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
});
