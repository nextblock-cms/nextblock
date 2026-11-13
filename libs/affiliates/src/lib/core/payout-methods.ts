/**
 * How the program pays the commissions of each sale gateway (`affiliates_settings.payoutMethods`,
 * migration 02036), and the partner's manual payout address. Pure and client-safe.
 *
 * Partners are paid by Stripe Connect transfers from the platform's Stripe balance. Freemius pays
 * the operator (monthly, by PayPal), never the partners, and its money never reaches Stripe (and
 * Canada has no Stripe top-ups), so a store can route a gateway's commissions to `manual`: the daily
 * run then leaves them out of every transfer, and the operator sends that money from PayPal, Interac
 * e-Transfer, Wise or a bank, preparing and recording each payout on the CMS Payouts screen
 * (`claim_manual_affiliate_payout`, `record_manual_affiliate_payout`). Since 02037 a gateway can
 * also be routed to `paypal`: the daily run pays its commissions from the operator's PayPal balance
 * with the PayPal Payouts API (`claim_paypal_affiliate_payout`), to partners whose payout email is a
 * PayPal account (`payout_email_kind`); a partner with an Interac e-Transfer address, or none, is
 * paid by hand under Pay manually instead. The default routes both gateways to Stripe Connect,
 * which is what every store did before 02036.
 */
import { AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH, AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH } from './constants';
import { AFFILIATE_GATEWAYS, isAffiliatePayoutEmailKind, isAffiliatePayoutMethod } from './statuses';
import type { AffiliateGateway, AffiliatePayoutEmailKind, AffiliatePayoutMethod, AffiliatesPayoutMethods } from './types';

/** Anything that may carry `payoutMethods` (normalized settings, a stored row, an old mock without the field). */
export type AffiliatePayoutMethodsSource = { payoutMethods?: unknown } | null | undefined;

/** A fresh copy of the default: every gateway through Stripe Connect (the behaviour before 02036). */
export function defaultAffiliatePayoutMethods(): AffiliatesPayoutMethods {
  return { stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' };
}

/** Any stored or submitted value → valid payout methods: an unknown or missing choice reads as `stripe_connect`. */
export function normalizeAffiliatePayoutMethods(value: unknown): AffiliatesPayoutMethods {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const defaults = defaultAffiliatePayoutMethods();
  const stripeSales = raw['stripeSales'];
  const freemiusSales = raw['freemiusSales'];
  return {
    stripeSales: isAffiliatePayoutMethod(stripeSales) ? stripeSales : defaults.stripeSales,
    freemiusSales: isAffiliatePayoutMethod(freemiusSales) ? freemiusSales : defaults.freemiusSales,
  };
}

/** The method that pays a gateway's commissions under these settings. */
export function affiliatePayoutMethodForGateway(settings: AffiliatePayoutMethodsSource, gateway: AffiliateGateway): AffiliatePayoutMethod {
  const methods = normalizeAffiliatePayoutMethods(settings?.payoutMethods);
  return gateway === 'FREEMIUS' ? methods.freemiusSales : methods.stripeSales;
}

/**
 * The gateways whose commissions Stripe Connect transfers pay (in `AFFILIATE_GATEWAYS` order): what
 * the daily run passes to `claim_affiliate_payout` as `p_gateways`. Empty when every gateway is paid
 * manually: the run then never calls Stripe.
 */
export function affiliateGatewaysPaidByStripe(settings: AffiliatePayoutMethodsSource): AffiliateGateway[] {
  return AFFILIATE_GATEWAYS.filter((gateway) => affiliatePayoutMethodForGateway(settings, gateway) === 'stripe_connect');
}

/**
 * The gateways whose commissions the operator pays outside Stripe and records in the CMS (in
 * `AFFILIATE_GATEWAYS` order): what the CMS passes to `claim_manual_affiliate_payout` as
 * `p_gateways`. Empty by default.
 */
export function affiliateGatewaysPaidManually(settings: AffiliatePayoutMethodsSource): AffiliateGateway[] {
  return AFFILIATE_GATEWAYS.filter((gateway) => affiliatePayoutMethodForGateway(settings, gateway) === 'manual');
}

/**
 * The gateways whose commissions the daily run pays with PayPal Payouts from the operator's PayPal
 * balance (02037, in `AFFILIATE_GATEWAYS` order): what the app passes to
 * `claim_paypal_affiliate_payout` as `p_gateways`. Partners without a PayPal payout email are paid
 * these by hand (Pay manually). Empty by default.
 */
export function affiliateGatewaysPaidByPayPal(settings: AffiliatePayoutMethodsSource): AffiliateGateway[] {
  return AFFILIATE_GATEWAYS.filter((gateway) => affiliatePayoutMethodForGateway(settings, gateway) === 'paypal');
}

/**
 * The gateways whose commissions never need the Stripe balance: those paid with PayPal and those
 * paid by hand (in `AFFILIATE_GATEWAYS` order). Their commissions are left out of every Stripe
 * transfer and of what the Stripe balance must cover; partners need a payout email for them.
 */
export function affiliateGatewaysPaidOutsideStripe(settings: AffiliatePayoutMethodsSource): AffiliateGateway[] {
  return AFFILIATE_GATEWAYS.filter((gateway) => affiliatePayoutMethodForGateway(settings, gateway) !== 'stripe_connect');
}

/** Any stored or submitted value → a payout email kind: anything but `interac` reads as `paypal` (the column default). */
export function normalizeAffiliatePayoutEmailKind(value: unknown): AffiliatePayoutEmailKind {
  return isAffiliatePayoutEmailKind(value) ? value : 'paypal';
}

/**
 * Whether PayPal can pay a partner automatically at this payout email (02037): the kind is
 * `paypal`, the address passes {@link normalizeAffiliatePayoutEmail} unchanged (no formula-first
 * character, no quote or whitespace) and fits PayPal's 127-character `receiver`. The database's
 * claim (`claim_paypal_affiliate_payout`) applies the same rule; a partner it refuses is paid by
 * hand under Pay manually.
 */
export function isAffiliatePayPalPayoutReceiver(email: unknown, kind: unknown): boolean {
  if (normalizeAffiliatePayoutEmailKind(kind) !== 'paypal' || typeof email !== 'string') return false;
  const normalized = normalizeAffiliatePayoutEmail(email);
  return Boolean(normalized) && normalized === email && email.length <= AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH;
}

/**
 * PayPal failure reasons (02037, `affiliate_payouts.failure_reason`) that mean PayPal cannot pay the
 * address the payout went to: returned (nobody claimed it within 30 days, or the account could not take
 * it), blocked, refunded, reversed, cancelled before it was claimed, or refused for the receiver
 * (`paypal_failed:receiver_*`, `paypal_failed:self_pay`). The run stops sending PayPal payouts to that
 * address (the partner is paid by hand under Pay manually) until the partner saves their payout email
 * again; the partner's email says so instead of promising a retry. Other failures (the operator's
 * balance, a refused batch, an admin release) leave the address alone: the next run pays it again.
 */
export function isAffiliatePayPalReceiverFailureReason(reason: unknown): boolean {
  return (
    typeof reason === 'string' &&
    /^paypal_(?:returned|blocked|refunded|reversed|cancelled|canceled)|^paypal_failed:(?:receiver_|self_pay)/.test(reason.trim().toLowerCase())
  );
}

// HTML's "valid e-mail address" grammar (lowercased first), with a dot in the domain: no whitespace,
// quotes, commas, angle brackets or control characters, so the address is safe in a mail header, a
// CSV cell and a PayPal recipient field. The database's CHECK (02036) is looser (one @, no
// whitespace, at most 254 characters, no leading = + - @): this is the rule the app writes with.
const PAYOUT_EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A first character a spreadsheet reads as the start of a formula. The PayPal payouts file would
 * have to prefix such an address with an apostrophe, which turns it into a different (still valid)
 * recipient, so an address starting with one is refused instead (02036's CHECK refuses it too).
 */
const FORMULA_FIRST_CHARACTER = /^[=+\-@]/;

/**
 * A partner's manual payout address (PayPal or Interac e-Transfer) as it is stored: trimmed and
 * lowercased, or `''` for a blank value (clears it), or null when it is not a deliverable-looking
 * address (more than 254 characters, whitespace inside, no dot in the domain, a quote, a comma, a
 * first character a spreadsheet would read as a formula: = + - @…).
 */
export function normalizeAffiliatePayoutEmail(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email) return '';
  if (email.length < 3 || email.length > AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH) return null;
  if (FORMULA_FIRST_CHARACTER.test(email)) return null;
  return PAYOUT_EMAIL_PATTERN.test(email) ? email : null;
}
