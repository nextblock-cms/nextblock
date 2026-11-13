import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  splitAffiliatesCopyAtPlaceholder,
  type AffiliateLocale,
  type AffiliatePayoutMethod,
  type AffiliatesCopyTranslate,
  type AffiliatesPayoutMethods,
  type AFFILIATES_TERMS_COPY,
} from '@nextblock-cms/affiliates';

/**
 * The built-in partner terms (`/partners/terms`, `/partenaires/conditions`). A pure server component:
 * every sentence comes from the `affiliates.terms.*` copy through `t`, every number from the model
 * (the live "Program details" table at the end), and React builds all markup. Nothing is rendered as
 * HTML. One h1, then one h2 per section.
 */

type TermsKey = keyof typeof AFFILIATES_TERMS_COPY;

/** One tier row of the Program details table, formatted for the page's language. */
export interface PartnersTermsTierRow {
  id: string;
  name: string;
  /** `12.5%` / `12,5 %`. */
  commission: string;
  /** `30 days` / `30 jours`. */
  referralWindow: string;
  /** `30 days` / `0 jour`. */
  hold: string;
}

export interface PartnersTermsModel {
  locale: AffiliateLocale;
  /** Who runs the program: the legal name from the privacy settings, else the site title. */
  company: string;
  /** The privacy contact address, or null (the contact section is left out). */
  contactEmail: string | null;
  /** The privacy policy page (a site path or an https URL), resolved like the consent banner's link. */
  privacyHref: string;
  /** `AFFILIATE_TERMS_VERSION` and its localized date. */
  version: { iso: string; label: string };
  tiers: PartnersTermsTierRow[];
  /** The store base currency (commissions are recorded and paid in it). */
  currency: string;
  /**
   * Null when the program settings could not be read: the payout rows (minimum, method, schedule)
   * are left out rather than guessed. `schedule` is the daily run's switch (Stripe transfers and, since
   * 02037, PayPal Payouts); `methods` how each kind of sale is paid (`affiliates_settings.payoutMethods`:
   * Stripe Connect, sent by hand (02036) or PayPal Payouts (02037)).
   */
  payouts: { minimum: string; schedule: 'daily' | 'manual'; methods: AffiliatesPayoutMethods } | null;
}

export interface PartnersTermsViewProps {
  t: AffiliatesCopyTranslate;
  model: PartnersTermsModel;
}

type TermsBlock = { kind: 'p'; key: TermsKey } | { kind: 'list'; intro: TermsKey; items: readonly TermsKey[] };

interface TermsSection {
  id: string;
  title: TermsKey;
  blocks: readonly TermsBlock[];
}

const p = (key: TermsKey): TermsBlock => ({ kind: 'p', key });

/** The clauses, in reading order. The privacy, contact and details sections are built below. */
const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    id: 'joining',
    title: 'affiliates.terms.joining_title',
    blocks: [
      p('affiliates.terms.joining_free'),
      p('affiliates.terms.joining_review'),
      p('affiliates.terms.joining_changes'),
      p('affiliates.terms.joining_refuse'),
    ],
  },
  {
    id: 'earning',
    title: 'affiliates.terms.earning_title',
    blocks: [
      p('affiliates.terms.earning_start'),
      p('affiliates.terms.earning_referral'),
      p('affiliates.terms.earning_one_partner'),
      p('affiliates.terms.earning_consent'),
      p('affiliates.terms.earning_self'),
      p('affiliates.terms.earning_base'),
      p('affiliates.terms.earning_first_payment'),
      p('affiliates.terms.earning_currency'),
      p('affiliates.terms.earning_tiers'),
      p('affiliates.terms.earning_rate_changes'),
    ],
  },
  {
    id: 'hold',
    title: 'affiliates.terms.hold_title',
    blocks: [p('affiliates.terms.hold_body'), p('affiliates.terms.hold_dispute')],
  },
  {
    id: 'refunds',
    title: 'affiliates.terms.refunds_title',
    blocks: [
      p('affiliates.terms.refunds_full'),
      p('affiliates.terms.refunds_partial'),
      p('affiliates.terms.refunds_dispute'),
      p('affiliates.terms.refunds_after_payout'),
    ],
  },
  {
    id: 'payouts',
    title: 'affiliates.terms.payouts_title',
    blocks: [
      p('affiliates.terms.payouts_stripe'),
      p('affiliates.terms.payouts_setup'),
      p('affiliates.terms.payouts_direct'),
      p('affiliates.terms.payouts_paypal'),
      p('affiliates.terms.payouts_interac'),
      p('affiliates.terms.payouts_currency'),
      p('affiliates.terms.payouts_minimum'),
      p('affiliates.terms.payouts_schedule'),
      p('affiliates.terms.payouts_stripe_agreement'),
      p('affiliates.terms.payouts_paypal_agreement'),
    ],
  },
  { id: 'taxes', title: 'affiliates.terms.taxes_title', blocks: [p('affiliates.terms.taxes_body')] },
  {
    id: 'rules',
    title: 'affiliates.terms.rules_title',
    blocks: [
      p('affiliates.terms.rules_disclosure'),
      {
        kind: 'list',
        intro: 'affiliates.terms.rules_forbidden_intro',
        items: [
          'affiliates.terms.rules_forbidden_self',
          'affiliates.terms.rules_forbidden_spam',
          'affiliates.terms.rules_forbidden_claims',
          'affiliates.terms.rules_forbidden_cookies',
          'affiliates.terms.rules_forbidden_impersonation',
        ],
      },
      p('affiliates.terms.rules_breach'),
    ],
  },
  {
    id: 'content',
    title: 'affiliates.terms.content_title',
    blocks: [
      p('affiliates.terms.content_ownership'),
      p('affiliates.terms.content_licence'),
      p('affiliates.terms.content_responsibility'),
    ],
  },
  {
    id: 'pausing',
    title: 'affiliates.terms.pause_title',
    blocks: [
      p('affiliates.terms.pause_body'),
      p('affiliates.terms.pause_effects'),
      p('affiliates.terms.pause_balance'),
      p('affiliates.terms.pause_records'),
      p('affiliates.terms.leave_body'),
      p('affiliates.terms.leave_records'),
    ],
  },
  {
    id: 'changes',
    title: 'affiliates.terms.changes_title',
    blocks: [p('affiliates.terms.changes_body'), p('affiliates.terms.changes_accept')],
  },
  { id: 'law', title: 'affiliates.terms.law_title', blocks: [p('affiliates.terms.law_body')] },
];

/** A payout method as the Program details table states it. */
const PAYOUT_METHOD_TEXT: Readonly<Record<AffiliatePayoutMethod, TermsKey>> = {
  stripe_connect: 'affiliates.terms.details_payout_method_stripe',
  // 02037: automatic PayPal Payouts, or by hand for a partner who chose Interac e-Transfer.
  paypal: 'affiliates.terms.details_payout_method_paypal',
  manual: 'affiliates.terms.details_payout_method_manual',
};

/** One method for every sale (one "Payout method" row), or one per kind of sale (`mixed`). */
function payoutModeOf(methods: AffiliatesPayoutMethods): 'same' | 'mixed' {
  return methods.stripeSales === methods.freemiusSales ? 'same' : 'mixed';
}

/** The schedule row per pair of methods (`[daily, switch off]`), sorted so the order of the sales does not matter. */
const PAYOUT_SCHEDULE_KEYS: Readonly<Record<string, readonly [TermsKey, TermsKey]>> = {
  'stripe_connect+stripe_connect': ['affiliates.terms.details_schedule_daily', 'affiliates.terms.details_schedule_manual'],
  'manual+manual': ['affiliates.terms.details_schedule_direct', 'affiliates.terms.details_schedule_direct'],
  'manual+stripe_connect': ['affiliates.terms.details_schedule_mixed_daily', 'affiliates.terms.details_schedule_mixed_manual'],
  'paypal+paypal': ['affiliates.terms.details_schedule_paypal_daily', 'affiliates.terms.details_schedule_paypal_manual'],
  'paypal+stripe_connect': ['affiliates.terms.details_schedule_stripe_paypal_daily', 'affiliates.terms.details_schedule_stripe_paypal_manual'],
  'manual+paypal': ['affiliates.terms.details_schedule_paypal_direct_daily', 'affiliates.terms.details_schedule_paypal_direct_manual'],
};

/**
 * The schedule row: the daily run's switch for Stripe transfers and PayPal Payouts (02037: the same
 * switch sends both); payouts sent by hand, and Interac e-Transfers to partners who chose them, go out
 * when the store sends them.
 */
function payoutScheduleKey(payouts: NonNullable<PartnersTermsModel['payouts']>): TermsKey {
  const pair = [payouts.methods.stripeSales, payouts.methods.freemiusSales].sort().join('+');
  const keys = PAYOUT_SCHEDULE_KEYS[pair] ?? PAYOUT_SCHEDULE_KEYS['stripe_connect+stripe_connect'];
  return (payouts.schedule === 'daily' ? keys?.[0] : keys?.[1]) ?? 'affiliates.terms.details_schedule_daily';
}

const H2_CLASS = 'text-2xl font-semibold tracking-tight text-foreground';
const BODY_CLASS = 'mt-4 space-y-3 leading-7 text-muted-foreground';
/** Underlined at rest: inside a sentence a link must not differ from the text by colour alone. */
const TEXT_LINK_CLASS =
  'rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const CELL_CLASS = 'border-b border-border px-3 py-2 align-top';

function sectionHeadingId(id: string): string {
  return `partner-terms-${id}`;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={sectionHeadingId(id)} className="mt-10">
      <h2 id={sectionHeadingId(id)} className={H2_CLASS}>
        {title}
      </h2>
      <div className={BODY_CLASS}>{children}</div>
    </section>
  );
}

/** A site path stays in the app (no prefetch); anything else is the operator's https page. */
function TermsLink({ href, children }: { href: string; children: ReactNode }) {
  return href.startsWith('/') && !href.startsWith('//') ? (
    <Link href={href} prefetch={false} className={TEXT_LINK_CLASS}>
      {children}
    </Link>
  ) : (
    <a href={href} rel="noopener noreferrer" className={TEXT_LINK_CLASS}>
      {children}
    </a>
  );
}

export function PartnersTermsView({ t, model }: PartnersTermsViewProps) {
  const values = { company: model.company };
  const updated = splitAffiliatesCopyAtPlaceholder(t('affiliates.terms.last_updated'), 'date');
  const contact = model.contactEmail ? splitAffiliatesCopyAtPlaceholder(t('affiliates.terms.contact_body'), 'email') : null;

  return (
    <div lang={model.locale} className="w-full">
      <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{t('affiliates.terms.title')}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {updated.before}
            <time dateTime={model.version.iso}>{model.version.label}</time>
            {updated.after}
          </p>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">{t('affiliates.terms.intro')}</p>
          <p className="mt-4 leading-7 text-foreground">{t('affiliates.terms.operator', values)}</p>
        </header>

        {TERMS_SECTIONS.map((section) => (
          <Section key={section.id} id={section.id} title={t(section.title)}>
            {section.blocks.map((block) =>
              block.kind === 'p' ? (
                <p key={block.key}>{t(block.key, values)}</p>
              ) : (
                <div key={block.intro}>
                  <p>{t(block.intro)}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-6">
                    {block.items.map((item) => (
                      <li key={item}>{t(item, values)}</li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </Section>
        ))}

        <Section id="privacy" title={t('affiliates.terms.privacy_title')}>
          <p>{t('affiliates.terms.privacy_body')}</p>
          <p>{t('affiliates.terms.privacy_stripe')}</p>
          <p>{t('affiliates.terms.privacy_direct')}</p>
          <p>
            <TermsLink href={model.privacyHref}>{t('affiliates.terms.privacy_link')}</TermsLink>
          </p>
        </Section>

        {model.contactEmail && contact ? (
          <Section id="contact" title={t('affiliates.terms.contact_title')}>
            <p>
              {contact.before}
              {contact.found ? (
                <a href={`mailto:${model.contactEmail}`} className={TEXT_LINK_CLASS}>
                  {model.contactEmail}
                </a>
              ) : null}
              {contact.after}
            </p>
          </Section>
        ) : null}

        <Section id="details" title={t('affiliates.terms.details_title')}>
          <p>{t('affiliates.terms.details_intro')}</p>
          {model.tiers.length > 0 ? (
            // Scrolls sideways on a phone: a named, focusable region so keyboard users can scroll it
            // too (the cells hold no focusable element). The portal's TableFrame pattern.
            <div
              role="region"
              aria-label={t('affiliates.terms.details_tiers_caption')}
              tabIndex={0}
              className="overflow-x-auto rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm text-foreground">
                <caption className="sr-only">{t('affiliates.terms.details_tiers_caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${CELL_CLASS} font-semibold`}>
                      {t('affiliates.terms.details_tier')}
                    </th>
                    <th scope="col" className={`${CELL_CLASS} font-semibold`}>
                      {t('affiliates.terms.details_commission')}
                    </th>
                    <th scope="col" className={`${CELL_CLASS} font-semibold`}>
                      {t('affiliates.terms.details_window')}
                    </th>
                    <th scope="col" className={`${CELL_CLASS} font-semibold`}>
                      {t('affiliates.terms.details_hold')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {model.tiers.map((tier) => (
                    <tr key={tier.id}>
                      <th scope="row" className={`${CELL_CLASS} font-medium`}>
                        {tier.name}
                      </th>
                      <td className={CELL_CLASS}>{tier.commission}</td>
                      <td className={CELL_CLASS}>{tier.referralWindow}</td>
                      <td className={CELL_CLASS}>{tier.hold}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{t('affiliates.terms.details_no_tiers')}</p>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm text-foreground sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t('affiliates.terms.details_currency')}</dt>
            <dd>{model.currency}</dd>
            {model.payouts ? (
              <>
                <dt className="font-semibold">{t('affiliates.terms.details_minimum_payout')}</dt>
                <dd>{model.payouts.minimum}</dd>
                {payoutModeOf(model.payouts.methods) === 'mixed' ? (
                  <>
                    <dt className="font-semibold">{t('affiliates.terms.details_payout_method_stripe_orders')}</dt>
                    <dd>{t(PAYOUT_METHOD_TEXT[model.payouts.methods.stripeSales])}</dd>
                    <dt className="font-semibold">{t('affiliates.terms.details_payout_method_freemius_orders')}</dt>
                    <dd>{t(PAYOUT_METHOD_TEXT[model.payouts.methods.freemiusSales])}</dd>
                  </>
                ) : (
                  <>
                    <dt className="font-semibold">{t('affiliates.terms.details_payout_method')}</dt>
                    <dd>{t(PAYOUT_METHOD_TEXT[model.payouts.methods.stripeSales])}</dd>
                  </>
                )}
                <dt className="font-semibold">{t('affiliates.terms.details_schedule')}</dt>
                <dd>{t(payoutScheduleKey(model.payouts))}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      </article>
    </div>
  );
}
