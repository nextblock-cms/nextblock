import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_TERMS_COPY, AFFILIATE_TERMS_VERSION, type AffiliateTierRow } from '@nextblock-cms/affiliates';

/**
 * The built-in partner terms and their two addresses (`/partners/terms`, `/partenaires/conditions`).
 *
 * - While the Affiliates program is inactive both answer 404 (no CMS fallback: the terms belong to
 *   the program), and so does the French address while French is not an active language.
 * - While it is active each address declares the canonical URL of the language it rendered in, with
 *   hreflang en / fr / x-default while neither language has the operator's own page, and renders
 *   React text only: the clauses, `{company}` from the privacy settings, the contact address (left
 *   out without one) and the live Program details.
 * - An operator page set in the program settings replaces the built-in terms (a redirect), French
 *   falling back to the English page. Only a signed-in ADMIN asking with `?builtin=1` (the CMS
 *   preview) sees the built-in terms instead, marked noindex. An override that leads back to a
 *   built-in address, however it is spelled, never redirects (a loop).
 */

const NBSP = ' ';

const mocks = vi.hoisted(() => ({
  /** `getCmsActor()`: who is signed in (null: nobody). */
  getCmsActor: vi.fn(async (): Promise<{ userId: string; role: string } | null> => null),
  active: true,
  locale: 'en',
  activeCodes: ['en', 'fr'] as string[],
  tiers: [] as unknown[],
  currency: 'USD',
  programSettings: null as null | {
    termsUrlEn: string;
    termsUrlFr: string;
    minPayoutCents: number;
    autoPayoutsEnabled: boolean;
    /** 02036; absent reads as every sale through Stripe Connect. */
    payoutMethods?: { stripeSales: string; freemiusSales: string };
  },
  privacy: { corporate: { legal_name: 'Maple Shop Inc.', address: '', support_email: 'legal@maple-shop.test' } } as {
    corporate: { legal_name: string; address: string; support_email: string };
  },
  privacyError: false,
  translations: [] as Array<{ key: string; translations: unknown }>,
  requestHost: 'shop.example.com',
  contentSetters: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'host' ? mocks.requestHost : null) }),
}));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async (id: string) => (id === 'affiliates' ? mocks.active : true),
}));
vi.mock('../../../lib/site-url', () => ({ resolveSiteUrl: () => 'https://shop.example.com' }));
vi.mock('../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop', socialImage: null }) }));
vi.mock('../../../lib/affiliates/request-locale', () => ({
  getRequestLocale: async () => mocks.locale,
  getActiveRequestLanguages: async () => ({ activeCodes: mocks.activeCodes, defaultCode: 'en' }),
  toAffiliatesLocale: (locale: string | null | undefined) =>
    typeof locale === 'string' && locale.toLowerCase().startsWith('fr') ? 'fr' : 'en',
}));
vi.mock('../../../lib/affiliates/storefront-data', () => ({
  getPublicAffiliateTiers: async () => mocks.tiers,
  getAffiliateStoreBaseCurrency: async () => mocks.currency,
}));
vi.mock('../../../lib/affiliates/settings', () => ({ getPublicAffiliatesProgramSettings: async () => mocks.programSettings }));
vi.mock('../../../lib/affiliates/server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  return {
    getServerAffiliatesCopy: async ({ locale, dictionary }: { locale?: string; dictionary: unknown }) =>
      runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary }),
  };
});
vi.mock('../../../lib/i18n/cached-translations', () => ({ getCachedTranslations: async () => mocks.translations }));
vi.mock('../../../lib/privacy/settings', () => ({
  getPrivacySettings: async () => {
    if (mocks.privacyError) throw new Error('settings unreadable');
    return mocks.privacy;
  },
}));
vi.mock('../../../components/CurrentContentSetter', () => ({
  CurrentContentSetter: (props: Record<string, unknown>) => {
    mocks.contentSetters.push(props);
    return null;
  },
}));
vi.mock('../../../lib/auth/cms-actor', () => ({ getCmsActor: mocks.getCmsActor }));

import TermsPage, { generateMetadata as generateTermsMetadata } from './terms/page';
import ConditionsPage, { generateMetadata as generateConditionsMetadata } from '../partenaires/conditions/page';
import { buildPartnersTermsTierRows, formatPartnersTermsVersion } from './_components/partners-terms-route';

function tier(overrides: Partial<AffiliateTierRow> & Pick<AffiliateTierRow, 'id' | 'name' | 'slug'>): AffiliateTierRow {
  return {
    name_translations: {},
    commission_percentage: 10,
    cookie_duration_days: 30,
    clearance_hold_days: 30,
    is_default_signup_tier: false,
    is_limited_time_promo: false,
    max_ambassadors_cap: null,
    member_count: 0,
    sort_order: 0,
    badge_color: 'violet',
    is_active: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const TIERS = [
  tier({ id: 't1', name: 'Starter Partner', slug: 'starter-partner', commission_percentage: 12.5, cookie_duration_days: 1, clearance_hold_days: 0, sort_order: 1 }),
  tier({
    id: 't4',
    name: 'Founding Ambassador',
    slug: 'founding-ambassador',
    commission_percentage: 50,
    cookie_duration_days: 60,
    clearance_hold_days: 30,
    sort_order: 4,
    name_translations: { fr: 'Ambassadeur fondateur' },
  }),
];

function props(search: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(search) };
}

async function html(page: Promise<unknown> | unknown): Promise<string> {
  return renderToStaticMarkup((await page) as never);
}

function decode(text: string): string {
  return text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.active = true;
  mocks.locale = 'en';
  mocks.activeCodes = ['en', 'fr'];
  mocks.tiers = TIERS;
  mocks.currency = 'USD';
  mocks.programSettings = { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
  mocks.privacy = { corporate: { legal_name: 'Maple Shop Inc.', address: '', support_email: 'legal@maple-shop.test' } };
  mocks.privacyError = false;
  mocks.translations = [];
  mocks.requestHost = 'shop.example.com';
  mocks.contentSetters = [];
  mocks.getCmsActor.mockReset();
  mocks.getCmsActor.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('program inactive: the terms addresses answer 404', () => {
  it('on both addresses, page and metadata alike', async () => {
    mocks.active = false;
    await expect(TermsPage(props())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(generateTermsMetadata(props())).rejects.toThrow('NEXT_NOT_FOUND');
    mocks.locale = 'fr';
    await expect(ConditionsPage(props())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(generateConditionsMetadata(props())).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('/partenaires/conditions also answers 404 while French is not an active language (nothing pins French there)', async () => {
    mocks.activeCodes = ['en'];
    await expect(ConditionsPage(props())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(generateConditionsMetadata(props())).rejects.toThrow('NEXT_NOT_FOUND');
    // The English address still renders.
    expect(await html(TermsPage(props()))).toContain('<h1');
  });
});

describe('/partners/terms in English', () => {
  it('renders the terms as text: one h1, h2 sections, the version, the operator and every clause', async () => {
    const page = await html(TermsPage(props()));

    expect(page).toMatch(/^<div lang="en" class="w-full">/);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).not.toMatch(/<h[3-6]/);
    expect(page).toContain('>Partner program terms</h1>');
    expect(page).toContain(`Last updated: <time dateTime="${AFFILIATE_TERMS_VERSION}">November 11, 2026</time>`);
    expect(page).toContain('The program is run by Maple Shop Inc. (“we” or “us”).');
    expect(page).toContain('These terms are governed by the laws of the place where Maple Shop Inc. is established.');
    for (const key of ['affiliates.terms.earning_consent', 'affiliates.terms.refunds_after_payout', 'affiliates.terms.leave_body'] as const) {
      expect(decode(page)).toContain(AFFILIATES_TERMS_COPY[key].en);
    }
    expect(page).toContain('<li>Buying through your own links or your own storefront.</li>');
    // React text only: no script, no raw markup from the copy.
    expect(page).not.toContain('<script');
    expect(page).not.toContain('{company}');
  });

  it('shows the live Program details: each active tier, the currency, the minimum payout, the method and the schedule', async () => {
    mocks.tiers = [...TIERS, tier({ id: 't9', name: 'Retired', slug: 'retired', is_active: false })];
    const page = await html(TermsPage(props()));

    expect(page).toContain('<caption class="sr-only">Commission, referral window and hold period of each tier</caption>');
    expect(page).toMatch(/<th scope="row"[^>]*>Starter Partner<\/th><td[^>]*>12.5%<\/td><td[^>]*>1 day<\/td><td[^>]*>0 days<\/td>/);
    expect(page).toMatch(/<th scope="row"[^>]*>Founding Ambassador<\/th><td[^>]*>50%<\/td><td[^>]*>60 days<\/td><td[^>]*>30 days<\/td>/);
    expect(page).not.toContain('Retired');
    expect(page).toMatch(/<dt[^>]*>Currency<\/dt><dd>USD<\/dd>/);
    expect(page).toMatch(/<dt[^>]*>Minimum payout<\/dt><dd>\$25\.00<\/dd>/);
    expect(page).toContain('Transfer to your Stripe account (Stripe Connect Express)');
    expect(page).toMatch(/<dt[^>]*>Payout schedule<\/dt><dd>Automatic, every day<\/dd>/);

    mocks.programSettings = { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: false };
    expect(await html(TermsPage(props()))).toMatch(/<dt[^>]*>Payout schedule<\/dt><dd>When we run them<\/dd>/);
  });

  it('puts the tier table in a named, focusable scroll region, so keyboard users can scroll it on a phone', async () => {
    const page = await html(TermsPage(props()));
    // The table is min-w-[32rem] and holds no focusable element: without tabindex Safari keyboard users cannot reach the hidden columns.
    expect(page).toMatch(
      /<div role="region" aria-label="Commission, referral window and hold period of each tier" tabindex="0" class="[^"]*overflow-x-auto[^"]*focus-visible:ring-2[^"]*"><table class="[^"]*min-w-\[32rem\]/,
    );
  });

  it('says what suspension does to the balance, in the partner-facing word ("suspended", as the portal and the email say)', async () => {
    const page = decode(await html(TermsPage(props())));
    expect(page).toContain('<h2 id="partner-terms-pausing" class="text-2xl font-semibold tracking-tight text-foreground">Suspension and leaving</h2>');
    expect(page).toContain('While your account is suspended, your storefront is offline');
    expect(page).toContain(AFFILIATES_TERMS_COPY['affiliates.terms.pause_balance'].en);
    expect(page.indexOf(AFFILIATES_TERMS_COPY['affiliates.terms.pause_balance'].en)).toBeGreaterThan(page.indexOf('While your account is suspended'));
    expect(page).not.toMatch(/\bpaused?\b/i);
    expect(page).toContain('we share your email address, your country and your storefront address with Stripe.');
  });

  it('leaves the payout rows out when the settings cannot be read, and says when no tier is open', async () => {
    mocks.programSettings = null;
    mocks.tiers = [];
    const page = await html(TermsPage(props()));
    expect(page).toContain('No tier is open right now.');
    expect(page).not.toContain('<table');
    expect(page).not.toContain('Minimum payout');
    expect(page).not.toContain('Payout schedule');
    // The method depends on the settings since 02036 (manual payouts): not guessed either.
    expect(page).not.toContain('Payout method');
    expect(page).not.toContain('Transfer to your Stripe account');
  });

  describe('payouts the store sends by hand (02036)', () => {
    const settings = (payoutMethods: { stripeSales: string; freemiusSales: string }, autoPayoutsEnabled = true) => ({
      termsUrlEn: '',
      termsUrlFr: '',
      minPayoutCents: 2500,
      autoPayoutsEnabled,
      payoutMethods,
    });
    const details = (page: string) => page.slice(page.indexOf('id="partner-terms-details"'));

    it('describes both ways of paying, the recovery after a refund and what a direct payout shares, whatever the settings', async () => {
      const page = decode(await html(TermsPage(props())));
      expect(page).toContain(
        'Depending on the sale, we pay you into a Stripe account in your name (Stripe Connect Express), into your PayPal account with PayPal Payouts, or we send the money to you directly, for example by PayPal or Interac e-Transfer.',
      );
      expect(page).toContain('For payouts through Stripe, finish the Stripe setup in your partner portal.');
      expect(page).toContain(AFFILIATES_TERMS_COPY['affiliates.terms.payouts_direct'].en);
      // 02037: a PayPal payout cannot be taken back, so asking the partner to return it is one of the ways.
      expect(page).toContain(
        'we may take that amount back: by reversing the Stripe transfer, by asking you to send it back, or by deducting it from a later payout.',
      );
      expect(page).toContain(AFFILIATES_TERMS_COPY['affiliates.terms.privacy_direct'].en);
      const metadata = await generateTermsMetadata(props());
      expect(metadata.description).toBe(AFFILIATES_TERMS_COPY['affiliates.terms.meta_description'].en);
      expect(metadata.description).not.toContain('Stripe');
    });

    it('names the direct method and its schedule when every sale is paid by hand', async () => {
      mocks.programSettings = settings({ stripeSales: 'manual', freemiusSales: 'manual' });
      const page = details(await html(TermsPage(props())));
      expect(page).toMatch(/<dt[^>]*>Payout method<\/dt><dd>Sent directly by us, for example by PayPal or Interac e-Transfer<\/dd>/);
      expect(page).toMatch(/<dt[^>]*>Payout schedule<\/dt><dd>When we send them<\/dd>/);
      expect(page).not.toContain('Stripe Connect Express');
      expect(page).toMatch(/<dt[^>]*>Minimum payout<\/dt><dd>\$25\.00<\/dd>/);
    });

    it('gives one method row per kind of sale, and both schedules, when the two are paid differently', async () => {
      mocks.programSettings = settings({ stripeSales: 'stripe_connect', freemiusSales: 'manual' });
      const page = details(await html(TermsPage(props())));
      expect(page).toMatch(
        /<dt[^>]*>Payout method, orders paid through Stripe<\/dt><dd>Transfer to your Stripe account \(Stripe Connect Express\)<\/dd>/,
      );
      expect(page).toMatch(
        /<dt[^>]*>Payout method, orders paid through Freemius<\/dt><dd>Sent directly by us, for example by PayPal or Interac e-Transfer<\/dd>/,
      );
      expect(page).not.toMatch(/<dt[^>]*>Payout method<\/dt>/);
      expect(page).toMatch(/<dt[^>]*>Payout schedule<\/dt><dd>Stripe transfers: automatic, every day\. Direct payouts: when we send them\.<\/dd>/);

      mocks.programSettings = settings({ stripeSales: 'manual', freemiusSales: 'stripe_connect' }, false);
      const reversed = details(await html(TermsPage(props())));
      expect(reversed).toMatch(/orders paid through Stripe<\/dt><dd>Sent directly by us/);
      expect(reversed).toMatch(/orders paid through Freemius<\/dt><dd>Transfer to your Stripe account/);
      expect(reversed).toMatch(/<dd>Stripe transfers: when we run them\. Direct payouts: when we send them\.<\/dd>/);
    });

    it('keeps one Stripe row for a program that pays every sale through Stripe (the field missing reads the same)', async () => {
      for (const programSettings of [
        settings({ stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' }),
        { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true },
      ]) {
        mocks.programSettings = programSettings;
        const page = details(await html(TermsPage(props())));
        expect(page).toMatch(/<dt[^>]*>Payout method<\/dt><dd>Transfer to your Stripe account \(Stripe Connect Express\)<\/dd>/);
        expect(page).not.toContain('Sent directly');
      }
    });

    it('reads in Québec French', async () => {
      mocks.locale = 'fr';
      mocks.programSettings = settings({ stripeSales: 'stripe_connect', freemiusSales: 'manual' });
      const page = await html(ConditionsPage(props()));
      expect(page).toContain('Mode de versement, commandes payées par Freemius');
      expect(page).toContain('Envoyé directement par nous, par exemple par PayPal ou virement Interac');
      expect(page).toContain(`Virements Stripe${NBSP}: automatiques, chaque jour. Versements directs${NBSP}: quand nous les envoyons.`);
      expect(decode(page)).toContain("en annulant le virement Stripe, en vous demandant de nous le renvoyer ou en le déduisant d'un versement suivant.");
    });
  });

  describe('payouts PayPal sends automatically (02037)', () => {
    const settings = (payoutMethods: { stripeSales: string; freemiusSales: string }, autoPayoutsEnabled = true) => ({
      termsUrlEn: '',
      termsUrlFr: '',
      minPayoutCents: 2500,
      autoPayoutsEnabled,
      payoutMethods,
    });
    const details = (page: string) => page.slice(page.indexOf('id="partner-terms-details"'));

    it('names PayPal Payouts per kind of sale, with the schedule the daily switch gives it', async () => {
      mocks.programSettings = settings({ stripeSales: 'paypal', freemiusSales: 'paypal' });
      const allPayPal = details(await html(TermsPage(props())));
      expect(allPayPal).toMatch(
        /<dt[^>]*>Payout method<\/dt><dd>Sent to your PayPal account by PayPal Payouts, or by Interac e-Transfer if you choose it<\/dd>/,
      );
      expect(allPayPal).toMatch(/<dt[^>]*>Payout schedule<\/dt><dd>PayPal payouts: automatic, every day\. Interac e-Transfers: when we send them\.<\/dd>/);
      expect(allPayPal).not.toContain('Stripe');
      expect(allPayPal).not.toContain('Sent directly');

      mocks.programSettings = settings({ stripeSales: 'paypal', freemiusSales: 'paypal' }, false);
      expect(details(await html(TermsPage(props())))).toMatch(
        /<dd>PayPal payouts: when we run them\. Interac e-Transfers: when we send them\.<\/dd>/,
      );

      // The usual Canadian setup: physical goods through Stripe, Freemius sales from the PayPal balance.
      mocks.programSettings = settings({ stripeSales: 'stripe_connect', freemiusSales: 'paypal' });
      const stripeAndPayPal = details(await html(TermsPage(props())));
      expect(stripeAndPayPal).toMatch(/orders paid through Stripe<\/dt><dd>Transfer to your Stripe account/);
      expect(stripeAndPayPal).toMatch(/orders paid through Freemius<\/dt><dd>Sent to your PayPal account by PayPal Payouts/);
      expect(stripeAndPayPal).toMatch(
        /<dd>Stripe transfers and PayPal payouts: automatic, every day\. Interac e-Transfers: when we send them\.<\/dd>/,
      );
      // PayPal sales are never "Direct payouts: when we send them".
      expect(stripeAndPayPal).not.toContain('Direct payouts');

      mocks.programSettings = settings({ stripeSales: 'manual', freemiusSales: 'paypal' }, false);
      const payPalAndManual = details(await html(TermsPage(props())));
      expect(payPalAndManual).toMatch(/orders paid through Stripe<\/dt><dd>Sent directly by us/);
      expect(payPalAndManual).toMatch(/orders paid through Freemius<\/dt><dd>Sent to your PayPal account/);
      expect(payPalAndManual).toMatch(/<dd>PayPal payouts: when we run them\. Direct payouts: when we send them\.<\/dd>/);
      expect(payPalAndManual).not.toContain('Stripe transfers');
    });

    it('says how PayPal payouts and Interac e-Transfers work, and that PayPal has its own agreement, whatever the settings', async () => {
      const page = decode(await html(TermsPage(props())));
      const paypal = AFFILIATES_TERMS_COPY['affiliates.terms.payouts_paypal'].en;
      expect(page).toContain(paypal);
      expect(paypal).toContain('use the email of your PayPal account');
      expect(page).toContain('If you choose Interac e-Transfer, we send your payouts by hand.');
      expect(page).toContain("Your PayPal account is covered by PayPal's own agreement with you.");
      expect(page).toContain('our Stripe or PayPal balance is too low');
      expect(page).toContain('add your payout email in your partner portal and choose PayPal or Interac e-Transfer');
      // In reading order: after the payout email clause, and the two agreements last.
      expect(page.indexOf(paypal)).toBeGreaterThan(page.indexOf(AFFILIATES_TERMS_COPY['affiliates.terms.payouts_direct'].en));
      expect(page.indexOf("Your PayPal account is covered")).toBeGreaterThan(page.indexOf("Your Stripe account is covered"));
    });

    it('reads in Québec French', async () => {
      mocks.locale = 'fr';
      mocks.programSettings = settings({ stripeSales: 'stripe_connect', freemiusSales: 'paypal' });
      const page = await html(ConditionsPage(props()));
      expect(page).toContain('Envoyé à votre compte PayPal par PayPal Payouts, ou par virement Interac si vous le choisissez');
      expect(page).toContain(
        `Virements Stripe et versements PayPal${NBSP}: automatiques, chaque jour. Virements Interac${NBSP}: quand nous les envoyons.`,
      );
      expect(decode(page)).toContain('Si vous choisissez le virement Interac, nous envoyons vos versements manuellement.');
      expect(decode(page)).toContain("Votre compte PayPal est soumis à l'entente que PayPal conclut avec vous.");
    });
  });

  it('links the privacy policy like the consent banner, and the contact address by mail', async () => {
    const page = await html(TermsPage(props()));
    expect(page).toMatch(/<a href="\/privacy-policy"[^>]*>Read our privacy policy<\/a>/);
    expect(page).toContain('Questions about these terms? Write to us at <a href="mailto:legal@maple-shop.test"');
    expect(page).toContain('>legal@maple-shop.test</a>.');

    mocks.translations = [{ key: 'privacy.consent.privacy_policy_href', translations: { en: '/legal/privacy', fr: '/legal/confidentialite' } }];
    expect(await html(TermsPage(props()))).toMatch(/<a href="\/legal\/privacy"[^>]*>Read our privacy policy<\/a>/);

    mocks.translations = [{ key: 'privacy.consent.privacy_policy_href', translations: { en: 'javascript:alert(1)' } }];
    expect(await html(TermsPage(props()))).toMatch(/<a href="\/privacy-policy"/);
  });

  it('names the site when no legal name is set, and leaves the contact section out without a real address', async () => {
    mocks.privacy = { corporate: { legal_name: '  ', address: '', support_email: '' } };
    let page = await html(TermsPage(props()));
    expect(page).toContain('The program is run by Maple Shop (“we” or “us”).');
    // resolvePrivacyEmail answers the privacy@example.com placeholder: no contact sentence.
    expect(page).not.toContain('Questions about these terms?');
    expect(page).not.toContain('mailto:');

    mocks.privacyError = true;
    page = await html(TermsPage(props()));
    expect(page).toContain('The program is run by Maple Shop (“we” or “us”).');
    expect(page).not.toContain('mailto:');
  });

  it('declares its canonical URL, hreflang and social metadata, and sets the switcher addresses', async () => {
    const metadata = await generateTermsMetadata(props());
    expect(metadata.title).toBe('Partner program terms');
    expect(metadata.description).toBe(AFFILIATES_TERMS_COPY['affiliates.terms.meta_description'].en);
    expect(metadata.alternates).toEqual({
      canonical: 'https://shop.example.com/partners/terms',
      languages: {
        en: 'https://shop.example.com/partners/terms',
        fr: 'https://shop.example.com/partenaires/conditions',
        'x-default': 'https://shop.example.com/partners/terms',
      },
    });
    expect(metadata.openGraph).toMatchObject({ url: 'https://shop.example.com/partners/terms', locale: 'en_US' });

    await html(TermsPage(props()));
    expect(mocks.contentSetters[0]).toMatchObject({
      id: null,
      localePaths: { en: '/partners/terms', fr: '/partenaires/conditions', 'x-default': '/partners/terms' },
    });
  });

  it('has one address and no hreflang while French is not active', async () => {
    mocks.activeCodes = ['en'];
    const metadata = await generateTermsMetadata(props());
    expect(metadata.alternates).toEqual({ canonical: 'https://shop.example.com/partners/terms' });
  });
});

describe('/partenaires/conditions in Québec French', () => {
  beforeEach(() => {
    // The proxy pins French on /partenaires and below.
    mocks.locale = 'fr';
  });

  it('renders French throughout, with French numbers, dates and the French privacy page', async () => {
    mocks.programSettings = { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: false };
    mocks.currency = 'CAD';
    const page = await html(ConditionsPage(props()));

    expect(page).toMatch(/^<div lang="fr" class="w-full">/);
    expect(page).toContain('>Conditions du programme partenaires</h1>');
    expect(page).toContain(`Dernière mise à jour${NBSP}: <time dateTime="${AFFILIATE_TERMS_VERSION}">11 novembre 2026</time>`);
    expect(page).toContain('Le programme est géré par Maple Shop Inc. («' + NBSP + 'nous' + NBSP + '»).');
    expect(page).toMatch(new RegExp(`>Ambassadeur fondateur</th><td[^>]*>50${NBSP}%</td><td[^>]*>60 jours</td>`));
    // A seeded tier keeps its seeded French name; French counts 0 and 1 as singular.
    expect(page).toMatch(new RegExp(`>Partenaire Départ</th><td[^>]*>12,5${NBSP}%</td><td[^>]*>1 jour</td><td[^>]*>0 jour</td>`));
    expect(page).toContain('Ces conditions sont régies par les lois du lieu où Maple Shop Inc. a son établissement.');
    expect(page).toMatch(/<dt[^>]*>Calendrier des versements<\/dt><dd>Quand nous les lançons<\/dd>/);
    expect(page).toContain('<dd>CAD</dd>');
    expect(page).toMatch(/<a href="\/politique-de-confidentialite"[^>]*>Lire notre politique de confidentialité<\/a>/);
    for (const english of ['How you earn', 'Program details', 'Minimum payout', 'Read our privacy policy']) {
      expect(page).not.toContain(english);
    }
  });

  it('declares /partenaires/conditions as its canonical', async () => {
    const metadata = await generateConditionsMetadata(props());
    expect(metadata.alternates?.canonical).toBe('https://shop.example.com/partenaires/conditions');
    expect(metadata.openGraph).toMatchObject({ url: 'https://shop.example.com/partenaires/conditions', locale: 'fr_FR' });

    // /partners/terms rendered in French (a French visitor) points at the French address too.
    const english = await generateTermsMetadata(props());
    expect(english.alternates?.canonical).toBe('https://shop.example.com/partenaires/conditions');
  });
});

describe("the operator's own terms page", () => {
  it('replaces the built-in terms: both the page and its metadata redirect there', async () => {
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
    await expect(generateTermsMetadata(props())).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
  });

  it('sends French visitors to the French page, else to the English one', async () => {
    mocks.locale = 'fr';
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    await expect(ConditionsPage(props())).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');

    mocks.programSettings = { ...mocks.programSettings, termsUrlFr: 'https://legal.example.com/conditions' };
    await expect(ConditionsPage(props())).rejects.toThrow('NEXT_REDIRECT:https://legal.example.com/conditions');
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:https://legal.example.com/conditions');
  });

  it('keeps English visitors on the built-in terms when only a French page is set, without hreflang to the redirecting French address', async () => {
    mocks.programSettings = { termsUrlEn: '', termsUrlFr: '/legal/conditions', minPayoutCents: 2500, autoPayoutsEnabled: true };
    expect(await html(TermsPage(props()))).toContain('>Partner program terms</h1>');
    // /partenaires/conditions 307s to the operator's page: no alternate points there (the sitemap's rule too).
    const metadata = await generateTermsMetadata(props());
    expect(metadata.alternates).toEqual({ canonical: 'https://shop.example.com/partners/terms' });
    expect(metadata.robots).toBeUndefined();
  });

  it('lets anyone but a signed-in ADMIN through ?builtin to the operator page (a replaced template stays off the public web)', async () => {
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };

    // Anonymous, a WRITER, a customer, or an actor read that fails: redirected like any visit.
    for (const actor of [null, { userId: 'w', role: 'WRITER' }, { userId: 'u', role: 'USER' }, new Error('auth down')] as const) {
      mocks.getCmsActor.mockReset();
      if (actor instanceof Error) mocks.getCmsActor.mockRejectedValue(actor);
      else mocks.getCmsActor.mockResolvedValue(actor);
      await expect(TermsPage(props({ builtin: '1' })), String(actor)).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
      await expect(generateTermsMetadata(props({ builtin: '' })), String(actor)).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
    }
    mocks.locale = 'fr';
    await expect(ConditionsPage(props({ builtin: '1' }))).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
  });

  it('shows a signed-in ADMIN the built-in terms with ?builtin (the CMS preview link), marked noindex', async () => {
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    mocks.getCmsActor.mockResolvedValue({ userId: 'a', role: 'ADMIN' });

    expect(await html(TermsPage(props({ builtin: '1' })))).toContain('>Partner program terms</h1>');
    const metadata = await generateTermsMetadata(props({ builtin: '' }));
    expect(metadata).toMatchObject({ title: 'Partner program terms', robots: { index: false, follow: false } });
    // Both addresses redirect for everyone else: nothing to cross-link.
    expect(metadata.alternates).toEqual({ canonical: 'https://shop.example.com/partners/terms' });

    // Without the parameter an admin is redirected too.
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
  });

  it('never reads the session on an ordinary visit (no override, or no ?builtin)', async () => {
    await html(TermsPage(props({ builtin: '1' })));
    await generateTermsMetadata(props());
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:/legal/partner-terms');
    expect(mocks.getCmsActor).not.toHaveBeenCalled();
  });

  it('never redirects the page to itself, however the built-in address is spelled', async () => {
    for (const termsUrlEn of [
      'https://shop.example.com/partners/terms',
      'https://SHOP.example.com/partners/terms/',
      'https://www.shop.example.com/partenaires/conditions?x=1',
      // Next 308s `//` to the collapsed path, and browsers resolve dot segments: each would loop.
      'https://shop.example.com/partners//terms',
      '/partners//terms',
      '/partners/./terms',
      '/partenaires/../partners/terms',
      '/partners/terms/.',
      '/partners/%74erms',
    ]) {
      mocks.requestHost = 'www.shop.example.com';
      mocks.programSettings = { termsUrlEn, termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
      expect(await html(TermsPage(props())), termsUrlEn).toContain('>Partner program terms</h1>');
    }
    // Another site's terms page at the same path is a real page of its own.
    mocks.programSettings = { termsUrlEn: 'https://other.example.org/partners/terms', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:https://other.example.org/partners/terms');
  });

  it('never puts a raw character above U+00FF in the redirect (Node would answer 500): only the stored, encoded form', async () => {
    mocks.programSettings = { termsUrlEn: '/conditions’partenaires', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    expect(await html(TermsPage(props()))).toContain('>Partner program terms</h1>');

    mocks.programSettings = { termsUrlEn: '/conditions%E2%80%99partenaires', termsUrlFr: '', minPayoutCents: 2500, autoPayoutsEnabled: true };
    await expect(TermsPage(props())).rejects.toThrow('NEXT_REDIRECT:/conditions%E2%80%99partenaires');
  });
});

describe('helpers', () => {
  it('use every affiliates.terms key, so the seed carries no dead copy', () => {
    const sources = ['./_components/partners-terms-view.tsx', './_components/partners-terms-route.tsx']
      .map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))
      .join('\n');
    expect(Object.keys(AFFILIATES_TERMS_COPY).filter((key) => !sources.includes(`'${key}'`))).toEqual([]);
  });

  it('format the version date per language', () => {
    expect(formatPartnersTermsVersion('en')).toBe('November 11, 2026');
    expect(formatPartnersTermsVersion('fr')).toBe('11 novembre 2026');
  });

  it('build the tier rows from active tiers only, with localized names', () => {
    const t = (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values ?? {})}`;
    const rows = buildPartnersTermsTierRows([...TIERS, tier({ id: 'x', name: 'Off', slug: 'off', is_active: false })], 'fr', t);
    expect(rows.map((row) => row.name)).toEqual(['Partenaire Départ', 'Ambassadeur fondateur']);
    expect(rows[0]?.commission).toBe('affiliates.terms.details_rate:{"rate":"12,5"}');
  });
});
