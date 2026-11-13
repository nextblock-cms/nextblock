import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_SANDBOX_COPY } from '@nextblock-cms/affiliates';

/**
 * The partner program's landing page and its two addresses.
 *
 * - While the Affiliates package is inactive, `/partners` and `/partenaires` are the CMS pages with
 *   those slugs (a static route always beats `[slug]`, so the program route must hand the URL back
 *   itself), and 404 when there is none. The layout no longer answers 404 for them.
 * - While it is active, `/partners` serves the visitor's language and `/partenaires` French; each
 *   declares the canonical URL of the language it rendered in, hreflang en / fr / x-default while
 *   French is active, and the switcher addresses.
 * - On the public sandbox (its signup creates no account) a guide card above the page links the
 *   seeded demo partner's storefront and the two demo sign-ins.
 */

const mocks = vi.hoisted(() => ({
  active: true,
  locale: 'en',
  activeCodes: ['en', 'fr'] as string[],
  cmsPage: vi.fn(),
  cmsMetadata: vi.fn(),
  contentSetters: [] as Array<Record<string, unknown>>,
  signupForms: [] as Array<Record<string, unknown>>,
  /** The dictionary each `getAffiliateCopyOverrides` call loaded overrides for (the layout's provider). */
  overrideDictionaries: [] as Array<Record<string, unknown>>,
  showcaseCatalog: vi.fn(async () => null as unknown),
  /** The public program settings projection (`null`: unreadable). */
  programSettings: null as null | { termsUrlEn: string; termsUrlFr: string; minPayoutCents: number; autoPayoutsEnabled: boolean },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async (id: string) => (id === 'affiliates' ? mocks.active : true),
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (name: string) => (name === 'x-nonce' ? 'nonce-1' : null) }) }));
vi.mock('../../[slug]/page', () => ({ default: mocks.cmsPage, generateMetadata: mocks.cmsMetadata }));
vi.mock('../../../lib/site-url', () => ({ resolveSiteUrl: () => 'https://shop.example.com' }));
vi.mock('../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop', socialImage: null }) }));
vi.mock('../../../lib/affiliates/request-locale', () => ({
  getRequestLocale: async () => mocks.locale,
  getActiveRequestLanguages: async () => ({ activeCodes: mocks.activeCodes, defaultCode: 'en' }),
  toAffiliatesLocale: (locale: string | null | undefined) =>
    typeof locale === 'string' && locale.toLowerCase().startsWith('fr') ? 'fr' : 'en',
}));
vi.mock('../../../lib/affiliates/storefront-data', () => ({
  getPublicAffiliateTiers: async () => [],
  getAffiliateStoreBaseCurrency: async () => 'USD',
  getPartnersBotProtectionPublic: async () => ({ provider: 'none', siteKey: '' }),
}));
// The calculator's product picker read (anon catalog, cached): hermetic here. The selection itself is
// the real pure function.
vi.mock('../../../lib/affiliates/partners-showcase', async () => {
  const actual = (await vi.importActual('../../../lib/affiliates/partners-showcase')) as Record<string, unknown>;
  return { selectPartnersShowcaseForLocale: actual['selectPartnersShowcaseForLocale'], getPartnersShowcaseCatalog: mocks.showcaseCatalog };
});
vi.mock('../../../lib/affiliates/signup', () => ({ resolvePartnerSignupViewer: async () => ({ kind: 'anonymous' }) }));
vi.mock('../../../lib/affiliates/settings', () => ({ getPublicAffiliatesProgramSettings: async () => mocks.programSettings }));
vi.mock('../../../lib/affiliates/server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  return {
    getServerAffiliatesCopy: async ({ locale, dictionary }: { locale?: string; dictionary: unknown }) =>
      runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary }),
    getAffiliateCopyOverrides: async ({ dictionary }: { dictionary: Record<string, unknown> }) => {
      mocks.overrideDictionaries.push(dictionary);
      return {};
    },
  };
});
vi.mock('./actions', () => ({
  submitPartnerSignup: async () => ({ ok: null, attempt: 0 }),
  checkPartnerHandleAvailability: async () => ({ ok: true, status: 'available' }),
}));
vi.mock('../../../components/CurrentContentSetter', () => ({
  CurrentContentSetter: (props: Record<string, unknown>) => {
    mocks.contentSetters.push(props);
    return null;
  },
}));
vi.mock('../../../components/affiliates/public/PartnerSignupForm', () => ({
  PartnerSignupForm: (props: Record<string, unknown>) => {
    mocks.signupForms.push(props);
    return <div data-signup="" />;
  },
}));
vi.mock('../../../components/affiliates/public/PartnerRevenueCalculator', () => ({ PartnerRevenueCalculator: () => null }));

import PartnersLayout from './layout';
import PartnersPage, { generateMetadata } from './page';
import PartenairesLayout from '../partenaires/layout';
import PartenairesPage, { generateMetadata as generatePartenairesMetadata } from '../partenaires/page';
import {
  SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
  SANDBOX_AFFILIATE_DEMO_EMAIL,
  SANDBOX_AFFILIATE_DEMO_HANDLE,
} from '../../api/cron/reset-sandbox/affiliate-demo';

const SEARCH = { page: '2' };

function props() {
  return { searchParams: Promise.resolve(SEARCH) };
}

function notFoundError() {
  return Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
}

beforeEach(() => {
  // Not the sandbox unless a case says so, whatever the shell running the tests exports.
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.active = true;
  mocks.locale = 'en';
  mocks.activeCodes = ['en', 'fr'];
  mocks.showcaseCatalog.mockClear();
  mocks.cmsPage.mockReset();
  mocks.cmsPage.mockImplementation(async () => <main data-cms-page="" />);
  mocks.cmsMetadata.mockReset();
  mocks.cmsMetadata.mockImplementation(async () => ({ title: 'Our partners' }));
  mocks.contentSetters = [];
  mocks.signupForms = [];
  mocks.overrideDictionaries = [];
  mocks.programSettings = { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: true };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function cmsSlugOf(call: unknown[]): Promise<{ slug: string; searchParams: unknown }> {
  const arg = call[0] as { params: Promise<{ slug: string }>; searchParams: Promise<unknown> };
  return { slug: (await arg.params).slug, searchParams: await arg.searchParams };
}

describe('package inactive: the URLs belong to the CMS', () => {
  beforeEach(() => {
    mocks.active = false;
  });

  it('the layout passes its children through instead of answering 404', async () => {
    const element = await PartnersLayout({ children: <p>cms content</p> as ReactNode });
    expect(renderToStaticMarkup(element)).toBe('<p>cms content</p>');
  });

  it('/partners renders the CMS page with the slug partners, metadata included', async () => {
    const page = await PartnersPage(props());
    expect(renderToStaticMarkup(page)).toBe('<main data-cms-page=""></main>');
    expect(mocks.cmsPage).toHaveBeenCalledTimes(1);
    await expect(cmsSlugOf(mocks.cmsPage.mock.calls[0])).resolves.toEqual({ slug: 'partners', searchParams: SEARCH });

    await expect(generateMetadata(props())).resolves.toEqual({ title: 'Our partners' });
    await expect(cmsSlugOf(mocks.cmsMetadata.mock.calls[0])).resolves.toEqual({ slug: 'partners', searchParams: SEARCH });
    expect(mocks.signupForms).toEqual([]);
  });

  it('/partenaires renders the CMS page with the slug partenaires', async () => {
    await PartenairesPage(props());
    await expect(cmsSlugOf(mocks.cmsPage.mock.calls[0])).resolves.toMatchObject({ slug: 'partenaires' });
    await generatePartenairesMetadata(props());
    await expect(cmsSlugOf(mocks.cmsMetadata.mock.calls[0])).resolves.toMatchObject({ slug: 'partenaires' });
  });

  it('still answers 404 when no CMS page has the slug', async () => {
    mocks.cmsPage.mockImplementation(async () => {
      throw notFoundError();
    });
    await expect(PartnersPage(props())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('package active: /partners and /partenaires', () => {
  it('serves the program, never the CMS page', async () => {
    const html = renderToStaticMarkup(await PartnersPage(props()));
    expect(mocks.cmsPage).not.toHaveBeenCalled();
    expect(mocks.signupForms).toHaveLength(1);
    expect(html).toContain('<div lang="en" class="w-full">');
    // The catalog is read beside the tiers (one cached read per request).
    expect(mocks.showcaseCatalog).toHaveBeenCalledTimes(1);
  });

  it('/partners in English: canonical /partners, hreflang en / fr / x-default', async () => {
    const metadata = await generateMetadata(props());
    expect(mocks.cmsMetadata).not.toHaveBeenCalled();
    expect(metadata.alternates).toEqual({
      canonical: 'https://shop.example.com/partners',
      languages: {
        en: 'https://shop.example.com/partners',
        fr: 'https://shop.example.com/partenaires',
        'x-default': 'https://shop.example.com/partners',
      },
    });
    expect(metadata.openGraph).toMatchObject({ url: 'https://shop.example.com/partners', locale: 'en_US' });
  });

  it('/partners rendered in French (a French visitor) declares /partenaires as its canonical', async () => {
    mocks.locale = 'fr';
    const metadata = await generateMetadata(props());
    expect(metadata.alternates?.canonical).toBe('https://shop.example.com/partenaires');
    expect(metadata.openGraph).toMatchObject({ url: 'https://shop.example.com/partenaires', locale: 'fr_FR' });
  });

  it('/partenaires is the French page: canonical, JSON-LD, sign-in return and switcher addresses', async () => {
    // The proxy pins French on this path.
    mocks.locale = 'fr';
    const metadata = await generatePartenairesMetadata(props());
    expect(metadata.alternates).toEqual({
      canonical: 'https://shop.example.com/partenaires',
      languages: {
        en: 'https://shop.example.com/partners',
        fr: 'https://shop.example.com/partenaires',
        'x-default': 'https://shop.example.com/partners',
      },
    });

    const html = renderToStaticMarkup(await PartenairesPage(props()));
    expect(html).toContain('<div lang="fr" class="w-full">');
    const jsonLd = JSON.parse(/<script type="application\/ld\+json" nonce="nonce-1">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as {
      '@graph': Array<{ url?: string; inLanguage?: string }>;
    };
    expect(jsonLd['@graph'][0]).toMatchObject({ url: 'https://shop.example.com/partenaires', inLanguage: 'fr-CA' });
    expect(mocks.signupForms[0]).toMatchObject({
      signInHref: '/sign-in?redirect=%2Fpartenaires',
      twoFactorHref: '/two-factor?redirect_to=%2Fpartenaires',
      storefrontPrefix: 'shop.example.com/partners/',
    });
    expect(mocks.contentSetters[0]).toMatchObject({
      id: null,
      localePaths: { en: '/partners', fr: '/partenaires', 'x-default': '/partners' },
    });
  });

  it('/partners keeps its own sign-in return address', async () => {
    renderToStaticMarkup(await PartnersPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({
      signInHref: '/sign-in?redirect=%2Fpartners',
      twoFactorHref: '/two-factor?redirect_to=%2Fpartners',
    });
  });

  it('never promises that payouts go through Stripe or come automatically, in the page or its description (02036)', async () => {
    // A store may pay some commissions by hand (PayPal, Interac e-Transfer) or with PayPal Payouts
    // (02037), and a partner may choose Interac e-Transfer: the copy holds in every setup, and names no
    // payment service at all (the partner portal and the terms say which one applies).
    const setups = [
      { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: true },
      { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: false },
      {
        termsUrlEn: '',
        termsUrlFr: '',
        minPayoutCents: 100,
        autoPayoutsEnabled: true,
        payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
      },
      {
        termsUrlEn: '',
        termsUrlFr: '',
        minPayoutCents: 100,
        autoPayoutsEnabled: true,
        payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' },
      },
      {
        termsUrlEn: '',
        termsUrlFr: '',
        minPayoutCents: 100,
        autoPayoutsEnabled: false,
        payoutMethods: { stripeSales: 'paypal', freemiusSales: 'paypal' },
      },
    ];
    for (const locale of ['en', 'fr']) {
      mocks.locale = locale;
      for (const setup of setups) {
        mocks.programSettings = setup as typeof mocks.programSettings;
        const html = renderToStaticMarkup(await PartnersPage(props()));
        expect(html, `${locale} page`).not.toMatch(/stripe|paypal|interac/i);
        expect(html, `${locale} page`).not.toMatch(/automati/i);
        const { description } = await generateMetadata(props());
        expect(String(description), `${locale} description`).not.toMatch(/stripe|paypal|interac|automati/i);
      }
    }
  });

  it('without French: one address, no hreflang, and /partenaires goes back to the CMS', async () => {
    mocks.activeCodes = ['en'];
    const metadata = await generateMetadata(props());
    expect(metadata.alternates).toEqual({ canonical: 'https://shop.example.com/partners' });

    // The proxy pins nothing (French is not active), so the request renders in English.
    await PartenairesPage(props());
    await expect(cmsSlugOf(mocks.cmsPage.mock.calls[0])).resolves.toMatchObject({ slug: 'partenaires' });
    await generatePartenairesMetadata(props());
    expect(mocks.cmsMetadata).toHaveBeenCalledTimes(1);
  });
});

describe("the signup form's terms link (termsHref)", () => {
  it('points at the built-in terms of the language the page rendered in', async () => {
    renderToStaticMarkup(await PartnersPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: '/partners/terms' });

    mocks.locale = 'fr';
    mocks.signupForms = [];
    renderToStaticMarkup(await PartenairesPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: '/partenaires/conditions' });
  });

  it("points at the operator's own page for that language, French falling back to the English page", async () => {
    mocks.programSettings = { termsUrlEn: '/legal/partner-terms', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: true };
    renderToStaticMarkup(await PartnersPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: '/legal/partner-terms' });

    mocks.locale = 'fr';
    mocks.signupForms = [];
    renderToStaticMarkup(await PartenairesPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: '/legal/partner-terms' });

    mocks.programSettings = { ...mocks.programSettings, termsUrlFr: 'https://legal.example.com/conditions' };
    mocks.signupForms = [];
    renderToStaticMarkup(await PartenairesPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: 'https://legal.example.com/conditions' });
  });

  it('falls back to the built-in terms when the settings cannot be read', async () => {
    mocks.programSettings = null;
    renderToStaticMarkup(await PartnersPage(props()));
    expect(mocks.signupForms[0]).toMatchObject({ termsHref: '/partners/terms' });
  });
});

describe('the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true): the demo guide card', () => {
  function decode(text: string): string {
    return text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  /** The guide card's markup, or null when the page has none. */
  function guideOf(html: string): string | null {
    return /<aside[^>]*aria-labelledby="partners-sandbox-guide-title"[^>]*>[\s\S]*?<\/aside>/.exec(html)?.[0] ?? null;
  }

  /** Each link of the guide as [href, text]. */
  function linksOf(guide: string | null): Array<[string, string]> {
    return [...(guide ?? '').matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((match) => [
      decode(match[1] ?? ''),
      decode(match[2] ?? ''),
    ]);
  }

  it('sits between the JSON-LD and the landing page on /partners, in English, with no heading', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = renderToStaticMarkup(await PartnersPage(props()));
    const guide = guideOf(html);

    expect(html).toMatch(/<\/script><aside lang="en" aria-labelledby="partners-sandbox-guide-title"[\s\S]*?<\/aside><div lang="en" class="w-full">/);
    expect(guide).toContain('<p id="partners-sandbox-guide-title" class="text-lg font-semibold">Explore the program in this demo</p>');
    expect(guide).toContain('This shared demo resets every 15 minutes. Try the program three ways:');
    expect(linksOf(guide)).toEqual([
      ['/partners/studio-nova', "Browse the demo partner's storefront, as shoppers see it"],
      ['/sign-in?redirect=%2Fportal%2Fretailer', 'Sign in as partner@nextblock.dev to see the partner portal and edit the demo storefront'],
      ['/sign-in?redirect=%2Fcms%2Faffiliates', 'Sign in as demo@nextblock.dev to approve storefronts and see the commission ledger'],
    ]);
    // A labelled landmark, not a heading: the page outline still opens with the hero's h1.
    expect(guide).not.toMatch(/<h[1-6]/);
    expect(guide).toMatch(/<svg(?=[^>]*aria-hidden="true")[^>]*>/);
  });

  it('is written in Québec French on /partenaires', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.locale = 'fr';
    const guide = guideOf(renderToStaticMarkup(await PartenairesPage(props())));

    expect(guide).toMatch(/^<aside lang="fr"/);
    expect(guide).toContain('>Explorez le programme dans cette démo</p>');
    expect(guide).toContain('Cette démo partagée est réinitialisée toutes les 15 minutes. Essayez le programme de trois façons :');
    expect(linksOf(guide).map(([, text]) => text)).toEqual([
      'Parcourez la vitrine du partenaire de démonstration, telle que la voient les clients',
      'Connectez-vous avec partner@nextblock.dev pour voir le portail partenaire et modifier la vitrine de démonstration',
      'Connectez-vous avec demo@nextblock.dev pour approuver les vitrines et consulter le registre des commissions',
    ]);
  });

  it('links the storefront and the logins the reset cron seeds', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const links = linksOf(guideOf(renderToStaticMarkup(await PartnersPage(props()))));
    expect(links[0]?.[0]).toBe(`/partners/${SANDBOX_AFFILIATE_DEMO_HANDLE}`);
    expect(links[1]?.[1]).toContain(SANDBOX_AFFILIATE_DEMO_EMAIL);
    expect(links[2]?.[1]).toContain(SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL);
  });

  it.each(['', 'false', '1'])('is absent when NEXT_PUBLIC_IS_SANDBOX is %j: the landing page follows the JSON-LD', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const html = renderToStaticMarkup(await PartnersPage(props()));
    expect(guideOf(html)).toBeNull();
    expect(html).not.toContain('<aside');
    expect(html).toMatch(/<\/script><div lang="en" class="w-full">/);
  });

  it('reaches the client islands: the /partners and /partenaires layout loads the sandbox overrides', async () => {
    renderToStaticMarkup(await PartnersLayout({ children: <p>page</p> as ReactNode }));
    expect(mocks.overrideDictionaries).toHaveLength(1);
    for (const key of Object.keys(AFFILIATES_SANDBOX_COPY)) {
      expect(mocks.overrideDictionaries[0], key).toHaveProperty([key]);
    }
    expect(PartenairesLayout).toBe(PartnersLayout);
  });
});
