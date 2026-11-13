import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The payment keys form on the public sandbox: savePaymentCredentials saves nothing there
 * (payment-config.test.ts), so the form says so and its Save button is disabled and described
 * by that note. Off the sandbox the form renders exactly as before.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PaymentsClient } from './PaymentsClient';

const NOTE = "Payment keys can&#x27;t be changed in the sandbox: its checkout is simulated.";

function render(partnerPayouts?: boolean): string {
  return renderToStaticMarkup(
    <PaymentsClient
      initialEnabledProviders={{ stripe: false, freemius: false }}
      configStatus={{ stripe: { hasKeys: false, missing: ['STRIPE_SECRET_KEY'] }, freemius: { hasKeys: false, missing: [] } }}
      credentials={{
        stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
        freemius: { developerId: '', publicKey: '', productId: '', hasSecretKey: false, hasApiKey: false },
        envFallbackActive: false,
      }}
      saveAction={async () => undefined}
      saveCredentialsAction={async () => undefined}
      partnerPayouts={partnerPayouts}
    />
  );
}

/** The submit button of the keys form (the provider toggles have their own button). */
function keysSaveButton(markup: string): string {
  const match = markup.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/);
  expect(match, 'the keys form has a submit button').not.toBeNull();
  return match![0];
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PaymentsClient Stripe section', () => {
  it('with the Affiliates program active, says Stripe also pays the partners, Freemius sales included', () => {
    const markup = render(true);

    expect(markup).toContain('<h3 class="text-sm font-semibold">Stripe (physical products and partner payouts)</h3>');
    expect(markup).toContain(
      'Stripe also pays your affiliate partners. Freemius doesn’t, so a store that sells only digital products still needs a Stripe secret key to run the partner program.'
    );
    // The webhook events come from the shared list (stripe/webhook-events.ts).
    expect(markup).toContain('<code>charge.dispute.closed</code>');
  });

  it.each([
    ['without the prop', undefined],
    ['with the program inactive', false],
  ])('%s, mentions no partners the store does not have', (_label, partnerPayouts) => {
    const markup = render(partnerPayouts);

    expect(markup).toContain('<h3 class="text-sm font-semibold">Stripe (physical products)</h3>');
    expect(markup).not.toContain('partner payouts');
    expect(markup).not.toContain('Stripe also pays your affiliate partners');
  });

  it('gives the plain Stripe CLI command for local webhooks (npm run stripe exists only in the monorepo)', () => {
    const markup = render();

    expect(markup).toContain('<code class="break-all">stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to localhost:3000/api/webhooks/stripe</code>');
    expect(markup).not.toContain('npm run stripe');
    expect(markup).toContain('<code>whsec_…</code> secret it prints below');
  });
});

describe('PaymentsClient Freemius section', () => {
  it('marks the Developer ID and Product ID optional and says what every Freemius key is for', () => {
    const markup = render();

    expect(markup).toContain('Developer ID (optional)');
    expect(markup).toContain('Product ID (optional)');
    expect(markup).toContain('use the Freemius Product ID saved on each product');
    expect(markup).toContain('Proves that webhooks really come from Freemius.');
    // One product’s keys here; several products need each product’s keys in the env map.
    expect(markup).toContain('These fields hold the keys of one Freemius product');
    expect(markup).toContain('<code>FREEMIUS_CHECKOUT_PRODUCTS_JSON</code>');
  });

  it('announces each hint with its field', () => {
    const markup = render();

    expect(markup).toMatch(/id="freemius_productId"[^>]*aria-describedby="freemius_productId-hint"/);
    expect(markup).toContain('id="freemius_productId-hint"');
  });
});

describe('PaymentsClient keys form', () => {
  it('on the sandbox shows the note and disables Save, described by it', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const markup = render();

    expect(markup).toContain(`<p id="payment-keys-sandbox-note" class="text-xs text-muted-foreground">${NOTE}</p>`);
    const button = keysSaveButton(markup);
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-describedby="payment-keys-sandbox-note"');
  });

  it.each(['', 'false', 'TRUE', '1'])('with NEXT_PUBLIC_IS_SANDBOX=%j renders no note and an enabled Save', (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const markup = render();

    expect(markup).not.toContain('payment-keys-sandbox-note');
    expect(markup).not.toContain('changed in the sandbox');
    const button = keysSaveButton(markup);
    expect(button).not.toContain('disabled=""');
    expect(button).not.toContain('aria-describedby');
  });
});
