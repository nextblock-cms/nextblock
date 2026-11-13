/**
 * The site-wide UI strings the Affiliates & Creator Storefronts feature added outside the
 * package's own `affiliates.*` namespace: copy that app components render whether or not a
 * partner page is open (the account menu, the header and footer partner program links,
 * `/unauthorized`, the sandbox credentials banner).
 *
 * - Migration 02031 seeds these rows, English and French, next to the package dictionaries
 *   (`tools/scripts/generate-affiliates-translations.ts` writes both from this list and
 *   `AFFILIATES_COPY`), and `libs/affiliates/src/lib/i18n/translations-migration.test.ts` replays
 *   the migrations to check that the database holds exactly this text.
 * - Unlike `affiliates.*` rows these keys stay in the root layout's global payload
 *   (`excludeAffiliateTranslationRows` drops only the `affiliates.` prefix), so components read
 *   them through `useLabel()` / `label()` with the same EN + FR text inline: that fallback is
 *   what an install renders before 02031 has run (`t()` answers an unseeded key with the key).
 *
 * Adding a key: list it here with its English and Québec French text (a space before `:` and
 * `%`, `…` not `...`, each `{placeholder}` at most once, because `t()` replaces only the first),
 * use the same text as the component's inline fallback, and seed it in a NEW forward migration.
 * 02031 is append-only once applied; the parity test fails until a migration seeds the key.
 *
 * Plain data with no imports on purpose: the generator (tsx), the lib test and app code all
 * load this module.
 */

/** One site-wide string in both public-site languages (structurally `AffiliatesCopyEntry`). */
export interface AffiliateGlobalTranslation {
  readonly en: string;
  readonly fr: string;
}

export const AFFILIATE_GLOBAL_TRANSLATIONS = {
  // components/header-auth.tsx: the account menu link to the partner portal (RTL accounts).
  partner_portal: {
    en: 'Partner portal',
    fr: 'Portail partenaire',
  },
  // app/unauthorized/page.tsx, ?reason=retailer_only: a staff account opened the partner portal.
  'unauthorized.retailer_only': {
    en: 'The partner portal is for partner accounts only. Staff accounts manage partners from the CMS.',
    fr: 'Le portail partenaire est réservé aux comptes partenaires. Les comptes du personnel gèrent les partenaires à partir du CMS.',
  },
  // app/unauthorized/page.tsx, ?reason=retailer_suspended: a suspended partner opened the portal.
  'unauthorized.retailer_suspended': {
    en: 'Your partner account is suspended, so the partner portal is unavailable. Contact the store if you think this is a mistake.',
    fr: "Votre compte partenaire est suspendu : le portail partenaire n'est donc pas accessible. Communiquez avec la boutique si vous croyez qu'il s'agit d'une erreur.",
  },
  // components/SandboxCredentialsAlert.tsx (sandbox only): the demo partner sign-in.
  demo_partner_access_desc: {
    en: 'To explore the partner portal, sign in with the demo partner account:',
    fr: 'Pour explorer le portail partenaire, connectez-vous avec le compte partenaire de démonstration :',
  },
  // components/SandboxCredentialsAlert.tsx (sandbox only): the link to the demo storefront.
  demo_partner_storefront_link: {
    en: "View the demo partner's public storefront",
    fr: 'Voir la vitrine publique du partenaire de démonstration',
  },
  // app/(auth-pages)/sign-up/SignUpForm.tsx (sandbox only): the notice above the demo accounts.
  // Also the error key signUpAction and forgotPasswordAction (app/actions.ts) redirect with on the sandbox.
  sandbox_signup_disabled: {
    en: 'Sign-up is turned off in this demo. Sign in with a demo account below instead.',
    fr: "L'inscription est désactivée dans cette démo. Connectez-vous plutôt avec un compte de démonstration ci-dessous.",
  },
  // components/ResponsiveNav.tsx and components/FooterNavigation.tsx: the badge on the 02034 partner program links.
  'nav.badge_new': {
    en: 'New',
    fr: 'Nouveau',
  },
} as const satisfies Readonly<Record<string, AffiliateGlobalTranslation>>;

export type AffiliateGlobalTranslationKey = keyof typeof AFFILIATE_GLOBAL_TRANSLATIONS;
