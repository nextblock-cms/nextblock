import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * The events the CMS asks the store's Stripe endpoint to send (and the Affiliates connection test
 * checks for) must be every event the webhook handler acts on: a missing one silently drops paid
 * orders, refunds or dispute holds.
 */

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({ createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}) }));
vi.mock('../payment-config', () => ({ resolveStripeSecretKey: vi.fn(), resolveStripeWebhookSecret: vi.fn() }));
vi.mock('./order-sync', () => ({ syncStripeOrderFromSession: vi.fn() }));
vi.mock('./client', () => ({ getStripeClient: vi.fn() }));

import { STRIPE_REQUIRED_WEBHOOK_EVENTS, STRIPE_WEBHOOK_ROUTE_PATH, stripeCliListenCommand } from './webhook-events';
import { STRIPE_DISPUTE_EVENT_TYPES, STRIPE_REFUND_EVENT_TYPES } from './webhooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('STRIPE_REQUIRED_WEBHOOK_EVENTS', () => {
  it('holds every refund, dispute and checkout event the handler acts on, once', () => {
    const required: readonly string[] = STRIPE_REQUIRED_WEBHOOK_EVENTS;
    for (const type of [...STRIPE_REFUND_EVENT_TYPES, ...STRIPE_DISPUTE_EVENT_TYPES]) expect(required, type).toContain(type);

    const handler = readFileSync(path.join(HERE, 'webhooks.ts'), 'utf8');
    const cases = [...handler.matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]);
    expect(cases.length).toBeGreaterThan(0);
    for (const type of cases) expect(required, type).toContain(type);

    expect(new Set(required).size).toBe(required.length);
  });

  it('is what the payments screen lists (it imports the same constant)', () => {
    const client = readFileSync(path.join(HERE, '..', 'pages', 'cms', 'payments', 'PaymentsClient.tsx'), 'utf8');
    expect(client).toContain("from '../../../stripe/webhook-events'");
    expect(client).not.toMatch(/const STRIPE_REQUIRED_WEBHOOK_EVENTS\s*=/);
  });

  it('names the route the app serves', () => {
    expect(STRIPE_WEBHOOK_ROUTE_PATH).toBe('/api/webhooks/stripe');
  });
});

describe('stripeCliListenCommand', () => {
  it('spells out every required event, because the Stripe CLI refuses listen without an event selection', () => {
    expect(stripeCliListenCommand('http://localhost:4300/api/webhooks/stripe')).toBe(
      'stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to http://localhost:4300/api/webhooks/stripe'
    );
  });

  it('is what the monorepo root runs for npm run stripe', () => {
    const root = JSON.parse(readFileSync(path.resolve(HERE, '../../../../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts['stripe']).toBe(stripeCliListenCommand('localhost:4200/api/webhooks/stripe'));
  });
});
