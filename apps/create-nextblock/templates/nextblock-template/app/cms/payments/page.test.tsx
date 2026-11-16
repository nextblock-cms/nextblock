import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffiliatesPayoutMethods } from '@nextblock-cms/affiliates';

/**
 * CMS → Payments tells the Stripe section whether Stripe pays affiliate partners. 0.23 production
 * review: it passed `isAffiliatesProgramActive()` alone, so a digital-only store paying every
 * commission by hand or with PayPal (affiliates_settings.payoutMethods, 02036/02037) was told it
 * needs a Stripe secret key for the partner program, although its payout run never calls Stripe.
 * Only the sale types routed to Stripe Connect count now (affiliateGatewaysPaidByStripe).
 */

const mocks = vi.hoisted(() => ({
  verifyPackageOnline: vi.fn<(id: string) => Promise<boolean>>(),
  isAffiliatesProgramActive: vi.fn<() => Promise<boolean>>(),
  readAffiliatesSettingsStrict: vi.fn<() => Promise<{ payoutMethods: AffiliatesPayoutMethods } | null>>(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  }),
}));

vi.mock('@nextblock-cms/db/server', () => ({ verifyPackageOnline: mocks.verifyPackageOnline }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }));
// The lib's server page: these tests read the props the app hands it.
vi.mock('@nextblock-cms/ecommerce/server', () => ({ PaymentsPage: () => null }));
vi.mock('../../../lib/affiliates/package-state', () => ({ isAffiliatesProgramActive: mocks.isAffiliatesProgramActive }));
vi.mock('../../../lib/affiliates/settings', () => ({ readAffiliatesSettingsStrict: mocks.readAffiliatesSettingsStrict }));

import { PaymentsClient } from '@nextblock-cms/ecommerce/pages/cms/payments/PaymentsClient';
import PaymentsPageWrapper from './page';

type PartnerProps = { partnerPayouts: boolean; digitalPartnerPayouts: boolean };

async function partnerProps(): Promise<PartnerProps> {
  const element = (await PaymentsPageWrapper()) as ReactElement<PartnerProps>;
  return element.props;
}

/** The Stripe section of the screen the lib renders with those props. */
function stripeSection(props: PartnerProps): string {
  const clientProps: ComponentProps<typeof PaymentsClient> = {
    initialEnabledProviders: { stripe: false, freemius: true },
    configStatus: { stripe: { hasKeys: false, missing: ['Secret key'] }, freemius: { hasKeys: true, missing: [] } },
    credentials: {
      stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
      freemius: {
        developerId: '4242',
        developerPublicKey: 'pk_dev',
        hasDeveloperSecretKey: true,
        publicKey: '',
        productId: '',
        hasSecretKey: false,
        hasApiKey: false,
      },
      envFallbackActive: false,
    },
    saveAction: async () => undefined,
    saveCredentialsAction: async () => undefined,
    ...props,
  };
  const markup = renderToStaticMarkup(<PaymentsClient {...clientProps} />);
  return markup.slice(markup.indexOf('<h3'), markup.indexOf('Stripe webhook setup'));
}

const routed = (stripeSales: string, freemiusSales: string) => ({ payoutMethods: { stripeSales, freemiusSales } as AffiliatesPayoutMethods });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyPackageOnline.mockResolvedValue(true);
  mocks.isAffiliatesProgramActive.mockResolvedValue(true);
  mocks.readAffiliatesSettingsStrict.mockResolvedValue(routed('stripe_connect', 'stripe_connect'));
});

describe('CMS Payments page: partner payouts in the Stripe section', () => {
  it('says nothing about partners while the Affiliates program is off, and reads no settings', async () => {
    mocks.isAffiliatesProgramActive.mockResolvedValue(false);

    await expect(partnerProps()).resolves.toEqual({ partnerPayouts: false, digitalPartnerPayouts: false });
    expect(mocks.readAffiliatesSettingsStrict).not.toHaveBeenCalled();
  });

  it.each([
    ['every gateway paid by hand', routed('manual', 'manual')],
    ['every gateway paid with PayPal', routed('paypal', 'paypal')],
    ['by hand and with PayPal', routed('manual', 'paypal')],
  ])('%s: Stripe pays no partner, so a digital-only store is asked for no Stripe key', async (_label, settings) => {
    mocks.readAffiliatesSettingsStrict.mockResolvedValue(settings);

    const props = await partnerProps();

    expect(props).toEqual({ partnerPayouts: false, digitalPartnerPayouts: false });
    const section = stripeSection(props);
    expect(section).toContain('Stripe (physical products)</h3>');
    expect(section).not.toContain('partner');
    expect(section).not.toContain('still needs a Stripe');
  });

  it('physical sales through Stripe Connect, digital ones outside it: no Stripe key asked for digital sales', async () => {
    mocks.readAffiliatesSettingsStrict.mockResolvedValue(routed('stripe_connect', 'manual'));

    const props = await partnerProps();

    expect(props).toEqual({ partnerPayouts: true, digitalPartnerPayouts: false });
    const section = stripeSection(props);
    expect(section).toContain('Stripe (physical products and partner payouts)</h3>');
    expect(section).not.toContain('still needs a Stripe');
  });

  it.each([
    ['the default routing', routed('stripe_connect', 'stripe_connect')],
    ['digital sales only through Stripe Connect', routed('paypal', 'stripe_connect')],
    // Unknown settings count as the default routing, as on the Affiliates → Stripe screen.
    ['settings that cannot be read', null],
  ])('%s: a digital-only store still needs a Stripe secret key', async (_label, settings) => {
    mocks.readAffiliatesSettingsStrict.mockResolvedValue(settings);

    const props = await partnerProps();

    expect(props).toEqual({ partnerPayouts: true, digitalPartnerPayouts: true });
    expect(stripeSection(props)).toContain('a store that sells only digital products still needs a Stripe secret key');
  });

  it('sends a store without Commerce Pro to the packages screen first', async () => {
    mocks.verifyPackageOnline.mockResolvedValue(false);

    await expect(PaymentsPageWrapper()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/cms/settings/packages');
    expect(mocks.isAffiliatesProgramActive).not.toHaveBeenCalled();
  });
});
