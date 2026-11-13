/**
 * The store's Stripe webhook endpoint: its route and the events it must send. Client-safe (no
 * imports): the CMS payments screen lists the events, and the Affiliates "Test connection" check
 * compares the configured endpoint against them.
 *
 * The checkout events mark orders paid (or keep them pending until a delayed payment settles); the
 * refund and dispute events (`STRIPE_REFUND_EVENT_TYPES`, `STRIPE_DISPUTE_EVENT_TYPES` in
 * `webhooks.ts`) refund orders and reverse affiliate commissions, and an opened dispute holds the
 * order's affiliate commission until it closes. `webhook-events.test.ts` keeps this list in step
 * with what `handleStripeWebhook` and the app's route handle.
 */

/** Path of the app's webhook route (`app/api/webhooks/stripe/route.ts`). */
export const STRIPE_WEBHOOK_ROUTE_PATH = '/api/webhooks/stripe';

export const STRIPE_REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;

export type StripeRequiredWebhookEvent = (typeof STRIPE_REQUIRED_WEBHOOK_EVENTS)[number];

/**
 * The Stripe CLI command that forwards exactly these events to a webhook URL Stripe can't reach
 * (a site on your own computer). Current CLI versions refuse `stripe listen` without an event
 * selection (`--events`, `--all-snapshot` or `--all-thin`), so the list is always spelled out.
 * The monorepo root's `npm run stripe` script is this command for port 4200.
 */
export function stripeCliListenCommand(forwardTo: string): string {
  return `stripe listen --events ${STRIPE_REQUIRED_WEBHOOK_EVENTS.join(',')} --forward-to ${forwardTo}`;
}
