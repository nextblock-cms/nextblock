import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS PayPal payouts screen (02037): ADMIN only and program-gated; it shows the environment, where
 * the credentials come from and the client id's last 4 characters (never a secret), the open PayPal
 * alerts, the credentials form with a write-only secret, the payouts in flight with Cancel for an
 * UNCLAIMED item and Release for one PayPal never confirmed, and on the sandbox nothing to act on.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  active: vi.fn(),
  overview: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/cms/affiliates/paypal',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: vi.fn() }));
vi.mock('../../../../lib/auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('../../../../lib/affiliates/package-state', () => ({ isAffiliatesProgramActive: mocks.active }));
vi.mock('../../../../lib/affiliates/paypal/admin', () => ({ loadAffiliatePayPalPayoutsOverview: mocks.overview }));
vi.mock('../../../../lib/affiliates/paypal/events', () => ({
  describeAffiliatePayPalFailure: (reason: string | null) => `Failure ${reason}.`,
}));
vi.mock('./actions', () => ({
  saveAffiliatePayPalCredentialsAction: vi.fn(),
  testAffiliatePayPalConnectionAction: vi.fn(),
  syncAffiliatePayPalPayoutsAction: vi.fn(),
  cancelAffiliatePayPalPayoutAction: vi.fn(),
}));
vi.mock('../components/ResolveAlertButton', () => ({
  ResolveAlertButton: ({ title }: { title: string }) => <button type="button">Mark as done: {title}</button>,
}));

import PayPalPayoutsPage from './page';

const SECRET = 'paypal-secret-never-shown';

function status(overrides: Record<string, unknown> = {}) {
  const live = { configured: true, source: 'cms', clientIdLast4: '9876', storedSecretUnreadable: false, savedInCms: true };
  return {
    sandbox: false,
    environment: 'live',
    environmentSource: 'cms',
    active: live,
    environments: { live, sandbox: { configured: false, source: null, clientIdLast4: null, storedSecretUnreadable: false, savedInCms: false } },
    ...overrides,
  };
}

function overview(overrides: Record<string, unknown> = {}) {
  return {
    sandbox: false,
    credentials: status(),
    connection: { checked: true, payoutsEnabled: true, appId: 'APP-1', error: null },
    settings: { minPayoutCents: 2500, autoPayoutsEnabled: true, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } },
    paypalGateways: ['FREEMIUS'],
    baseCurrency: 'CAD',
    inFlight: {
      total: 2,
      rows: [
        {
          payoutId: '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111',
          affiliateId: 'a1',
          handle: 'jane',
          displayName: 'Jane',
          receiver: 'jane@example.com',
          amountCents: 5000,
          currency: 'CAD',
          environment: 'live',
          itemStatus: 'UNCLAIMED',
          batchId: 'BATCH1',
          senderBatchId: 'sb-1',
          createdAt: '2026-11-10T00:00:00.000Z',
          lastAttemptAt: '2026-11-10T00:00:00.000Z',
          checkedAt: '2026-11-11T00:00:00.000Z',
          action: 'cancel',
        },
        {
          payoutId: '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a222',
          affiliateId: 'a2',
          handle: 'max',
          displayName: 'Max',
          receiver: 'max@example.com',
          amountCents: 3000,
          currency: 'CAD',
          environment: 'live',
          itemStatus: null,
          batchId: null,
          senderBatchId: 'sb-2',
          createdAt: '2026-11-10T00:00:00.000Z',
          lastAttemptAt: '2026-11-10T00:00:00.000Z',
          checkedAt: null,
          action: 'release',
        },
      ],
    },
    recentFailed: [
      { payoutId: 'f1', handle: 'pat', amountCents: 2000, currency: 'CAD', reason: 'paypal_returned', itemStatus: 'RETURNED', environment: 'live', failedAt: '2026-11-09T00:00:00.000Z' },
    ],
    alerts: [{ id: 'al-1', title: 'PayPal balance too low for partner payouts', message: 'Add CAD to your PayPal balance.', kind: 'paypal_insufficient_funds', createdAt: '2026-11-11T00:00:00.000Z' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of [mocks.requireCmsAdmin, mocks.active, mocks.overview]) mock.mockReset();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: {}, userId: 'admin-1' });
  mocks.active.mockResolvedValue(true);
  mocks.overview.mockResolvedValue(overview());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the PayPal payouts screen', () => {
  it('needs an ADMIN and an active program', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(PayPalPayoutsPage()).rejects.toThrow('Forbidden');
    mocks.active.mockResolvedValueOnce(false);
    await expect(PayPalPayoutsPage()).rejects.toThrow('redirect:/cms/settings/packages');
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('shows the status, the alerts, the credentials form and the payouts in flight, never a secret', async () => {
    const html = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(html).toContain('PayPal payouts');
    expect(html).toContain('Live (real money) · chosen in the CMS');
    expect(html).toContain('Saved in the CMS · client ID ending in 9876');
    expect(html).toContain('Credentials accepted · Payouts enabled');
    expect(html).toContain('Commissions on Freemius sales');
    expect(html).toContain('PayPal balance too low for partner payouts');
    expect(html).toContain('Mark as done: PayPal balance too low for partner payouts');
    // The secret field is write-only: a password input, never pre-filled.
    expect(html).toMatch(/<input[^>]*type="password"[^>]*value=""/);
    expect(html).not.toContain(SECRET);
    // In flight: Stop payment for the unclaimed item, Release for the one PayPal never confirmed (its
    // sender batch id shown, to look it up in PayPal).
    expect(html).toContain('UNCLAIMED');
    expect(html).toContain('Batch BATCH1');
    expect(html).toContain('Sent, PayPal has not confirmed it yet');
    expect(html).toContain('Sender batch sb-2');
    // "Stop payment", never a second "Cancel" next to the dialog's own Cancel button
    expect(html).toContain('aria-label="Stop the CA$50.00 PayPal payment to @jane"');
    expect(html).toContain('>Stop payment</button>');
    expect(html).not.toContain('>Cancel</button>');
    expect(html).toContain('aria-label="Release the CA$30.00 PayPal payout to @max"');
    expect(html).toContain('Check PayPal status now');
    expect(html).toContain('Failure paypal_returned.');
    // the failures card says who waits for a new save of the payout email, and where they are paid meanwhile
    expect(html).toContain('or that you stopped, is not paid by PayPal at that payout email again until they save it again');
    expect(html).toContain('request Payouts access (PayPal Canada)');
    // the checklist names the verified account, the fees, the conversion and the live proof
    expect(html).toContain('A verified PayPal Business account (confirmed email, identity and linked bank)');
    expect(html).toContain('about US$0.25 per payout to Canada or the US and 2% (at most US$20) elsewhere; partners pay nothing');
    expect(html).toContain('PayPal’s conversion (about 4%)');
    expect(html).toContain('Only a first real payout proves PayPal approved live Payouts');
    // live credentials with the Payouts scope: the access step is done
    expect(html).toMatch(/<span class="sr-only">Done: <\/span>Ask PayPal to enable Payouts on the live account/);
  });

  it('never marks Payouts access done from a sandbox app, and warns that live sales routed to PayPal wait meanwhile', async () => {
    const sandboxApp = { configured: true, source: 'env', clientIdLast4: '1234', storedSecretUnreadable: false, savedInCms: false };
    mocks.overview.mockResolvedValue(
      overview({
        credentials: status({
          environment: 'sandbox',
          environmentSource: 'default',
          active: sandboxApp,
          environments: { sandbox: sandboxApp, live: { configured: false, source: null, clientIdLast4: null, storedSecretUnreadable: false, savedInCms: false } },
        }),
      })
    );
    const html = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(html).toContain('Credentials accepted · Payouts enabled (sandbox app: live Payouts needs PayPal’s approval)');
    expect(html).not.toMatch(/Done: <\/span>Ask PayPal to enable Payouts/);
    expect(html).not.toMatch(/Done: <\/span>In the PayPal Developer Dashboard/);
    expect(html).toContain('PayPal is in Sandbox: commissions on real (live) sales routed to PayPal are not sent');
  });

  it('warns when PayPal Payouts cannot send the store currency, or sends it in whole units only', async () => {
    mocks.overview.mockResolvedValue(overview({ baseCurrency: 'KRW' }));
    expect(renderToStaticMarkup(await PayPalPayoutsPage())).toContain('PayPal Payouts does not send KRW, the store currency');
    mocks.overview.mockResolvedValue(overview({ baseCurrency: 'HUF' }));
    expect(renderToStaticMarkup(await PayPalPayoutsPage())).toContain('PayPal sends HUF in whole units only');
    mocks.overview.mockResolvedValue(overview({ baseCurrency: 'USD' }));
    const usd = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(usd).not.toContain('does not send USD');
    expect(usd).not.toContain('whole units only');
  });

  it('offers Release for a payout PayPal accepted but never settled, with its own warning', async () => {
    const base = overview();
    mocks.overview.mockResolvedValue(
      overview({
        inFlight: {
          total: 1,
          rows: [{ ...(base.inFlight.rows[0] as Record<string, unknown>), itemStatus: 'MYSTERY', action: 'release_acknowledged' }],
        },
      })
    );
    const html = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(html).toContain('aria-label="Release the CA$50.00 PayPal payout to @jane"');
    expect(html).not.toContain('Stop payment');
  });

  it('on the sandbox shows nothing to act on', async () => {
    mocks.overview.mockResolvedValue(
      overview({
        sandbox: true,
        credentials: status({
          sandbox: true,
          environment: 'sandbox',
          environmentSource: 'default',
          active: { configured: false, source: null, clientIdLast4: null, storedSecretUnreadable: false, savedInCms: false },
        }),
        connection: { checked: false, payoutsEnabled: null, appId: null, error: null },
      })
    );
    const html = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(html).toContain('This is the public sandbox: PayPal is never called');
    expect(html).not.toContain('aria-label="Stop the');
    expect(html).not.toContain('aria-label="Release the');
    expect(html).not.toContain('PayPal is in Sandbox: commissions on real');
    expect(html).not.toContain('ending in 9876');
  });

  it('says when no commission is paid with PayPal yet', async () => {
    mocks.overview.mockResolvedValue(
      overview({ paypalGateways: [], settings: { minPayoutCents: 2500, autoPayoutsEnabled: true, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } } })
    );
    const html = renderToStaticMarkup(await PayPalPayoutsPage());
    expect(html).toContain('No commission is paid with PayPal yet');
  });
});
