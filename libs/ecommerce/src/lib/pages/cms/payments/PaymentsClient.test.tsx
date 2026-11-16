import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The payment keys form on the public sandbox: savePaymentCredentials saves nothing there
 * (payment-config.test.ts), so the form says so and its Save button is disabled and described
 * by that note. Off the sandbox the form renders exactly as before.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { FreemiusDeveloperStatus } from '../../../freemius-developer-api';
import { PaymentsClient } from './PaymentsClient';

const NOTE = "Payment keys can&#x27;t be changed in the sandbox: its checkout is simulated.";

function render(partnerPayouts?: boolean, freemiusDeveloper: FreemiusDeveloperStatus | null = null): string {
  return renderToStaticMarkup(
    <PaymentsClient
      initialEnabledProviders={{ stripe: false, freemius: false }}
      configStatus={{ stripe: { hasKeys: false, missing: ['STRIPE_SECRET_KEY'] }, freemius: { hasKeys: false, missing: [] } }}
      credentials={{
        stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
        freemius: {
          developerId: '',
          developerPublicKey: '',
          hasDeveloperSecretKey: false,
          publicKey: '',
          productId: '',
          hasSecretKey: false,
          hasApiKey: false,
        },
        envFallbackActive: false,
      }}
      freemiusDeveloper={freemiusDeveloper}
      saveAction={async () => undefined}
      saveCredentialsAction={async () => undefined}
      partnerPayouts={partnerPayouts}
    />
  );
}

type PaymentsClientProps = ComponentProps<typeof PaymentsClient>;

/** The screen with these props over a store that has no keys yet (`freemiusMissing` replaces Freemius' missing list). */
function renderWith(
  props: Partial<PaymentsClientProps> & { freemiusMissing?: string[]; freemiusProductId?: string } = {}
): string {
  const { freemiusMissing = [], freemiusProductId = '', ...rest } = props;

  return renderToStaticMarkup(
    <PaymentsClient
      initialEnabledProviders={{ stripe: false, freemius: false }}
      configStatus={{
        stripe: { hasKeys: false, missing: ['Secret key'] },
        freemius: { hasKeys: false, missing: freemiusMissing },
      }}
      credentials={{
        stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
        freemius: {
          developerId: '4242',
          developerPublicKey: '',
          hasDeveloperSecretKey: false,
          publicKey: 'pk_product_public',
          productId: freemiusProductId,
          hasSecretKey: true,
          hasApiKey: false,
        },
        envFallbackActive: false,
      }}
      saveAction={async () => undefined}
      saveCredentialsAction={async () => undefined}
      {...rest}
    />
  );
}

const DIGITAL_ONLY_NEEDS_STRIPE = 'a store that sells only digital products still needs a Stripe secret key';
const GENERIC_FREEMIUS_REQUIREMENT =
  'Freemius needs <strong>a developer key pair</strong> (Developer ID, developer public and secret key) or <strong>one product’s public and secret key</strong>.';
const REFUSED_DEDICATED_PAIR =
  'Freemius refused the developer keys. Check the Developer ID and the key pair (Freemius → My Profile → Keys).';
const REFUSED_PAIR_MISSING = 'Developer key pair Freemius accepts, or a Product ID';

/** The submit button of the keys form (the provider toggles have their own button). */
function keysSaveButton(markup: string): string {
  const match = markup.match(/<button[^>]*type="submit"[^>]*>[^<]*<\/button>/);
  expect(match, 'the keys form has a submit button').not.toBeNull();
  return match?.[0] ?? '';
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
  it('leads with the developer keys, which cover every product, and keeps one product’s keys optional', () => {
    const markup = render();

    expect(markup).toContain('every product of your Freemius account works with them');
    expect(markup).toContain('A product you add in Freemius works after Sync from Freemius');
    expect(markup).toMatch(/<label[^>]*for="freemius_developerId">Developer ID<\/label>/);
    expect(markup).toMatch(/<label[^>]*for="freemius_developerPublicKey">Developer public key<\/label>/);
    expect(markup).toMatch(/id="freemius_developerSecretKey"[^>]*type="password"|type="password"[^>]*id="freemius_developerSecretKey"/);
    expect(markup).toContain('One product’s keys (optional)');
    expect(markup).toContain('Product ID (optional)');
    // The Product ID decides which products the one-product keys serve (freemius-key-policy.ts):
    // bound keys work offline for that product, so the hint asks for it whenever they are a
    // product's keys, and keeps the developer pair out of these fields.
    expect(markup).toContain(
      'Fill it in, also for a product outside your developer account: the keys then serve that product only and keep working while Freemius is slow or busy.'
    );
    expect(markup).toContain('Leave it empty only on a one-product store with no Developer ID. Developer keys never go here.');
    expect(markup).toContain('Proves that webhooks really come from Freemius.');
    expect(markup).toContain('these fields hold the keys of one Freemius product');
    expect(markup).toContain('<code>FREEMIUS_CHECKOUT_PRODUCTS_JSON</code>');
    // Nothing is said about the pair until it has been checked.
    expect(markup).not.toContain('Freemius accepts the developer keys');
  });

  it('never puts a stored developer secret in the form', () => {
    const markup = renderToStaticMarkup(
      <PaymentsClient
        initialEnabledProviders={{ stripe: false, freemius: false }}
        configStatus={{ stripe: { hasKeys: false, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
        credentials={{
          stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
          freemius: {
            developerId: '4242',
            developerPublicKey: 'pk_dev_public',
            hasDeveloperSecretKey: true,
            publicKey: '',
            productId: '',
            hasSecretKey: false,
            hasApiKey: false,
          },
          envFallbackActive: false,
        }}
        saveAction={async () => undefined}
        saveCredentialsAction={async () => undefined}
      />
    );

    expect(markup).toMatch(/id="freemius_developerSecretKey"[^>]*placeholder="•••••••• \(stored — leave blank to keep\)"/);
    expect(markup).not.toMatch(/id="freemius_developerSecretKey"[^>]*value=/);
    expect(markup).toContain('value="pk_dev_public"');
  });

  it('says how many products a working developer pair reaches, and where an env pair should move', () => {
    const working = render(false, { state: 'working', source: 'cms', productIds: ['24851', '28609', '43273'] });
    expect(working).toContain('Freemius accepts the developer keys: they reach 3 products.');
    expect(working).not.toContain('FREEMIUS_DEVELOPER_PUBLIC_KEY');

    const legacy = render(false, { state: 'working', source: 'env-legacy', productIds: ['24851'] });
    expect(legacy).toContain('they reach 1 product.');
    expect(legacy).toContain('<code>FREEMIUS_PUBLIC_KEY</code>');
    expect(legacy).toContain('rename those <code>FREEMIUS_DEVELOPER_PUBLIC_KEY</code>');
  });

  it.each([
    ['refused', 'Freemius refused the developer keys.'],
    ['unreachable', 'couldn&#x27;t be reached to check the developer keys'],
  ] as const)('reports a %s pair', (state, text) => {
    expect(render(false, { state, source: null, productIds: [] })).toContain(text);
  });

  it.each(['missing', 'sandbox'] as const)('says nothing about a %s pair', (state) => {
    const markup = render(false, { state, source: null, productIds: [] });

    expect(markup).not.toContain('developer keys: they reach');
    expect(markup).not.toContain('refused the developer keys');
    expect(markup).not.toContain('reached to check the developer keys');
  });

  it('names both ways to make Freemius ready', () => {
    expect(render()).toContain(
      'Freemius needs <strong>a developer key pair</strong> (Developer ID, developer public and secret key) or <strong>one product’s public and secret key</strong>.'
    );
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

/**
 * 0.23 production review: with the Affiliates program active the screen told every store, a
 * digital-only one included, that it needs a Stripe secret key for the partner program, whatever
 * the payout methods. Stripe pays only the commissions of the sale types routed to Stripe Connect
 * (affiliateGatewaysPaidByStripe): a store paying every gateway by hand or with PayPal never calls
 * Stripe, and one paying only physical sales through Stripe needs no Stripe key for digital ones.
 */
describe('PaymentsClient Stripe section and the partner payout routing', () => {
  it('routes nothing to Stripe Connect: no partner payouts and no Stripe key asked of a digital-only store', () => {
    const markup = renderWith({ partnerPayouts: false, digitalPartnerPayouts: false });

    expect(markup).toContain('<h3 class="text-sm font-semibold">Stripe (physical products)</h3>');
    expect(markup).not.toContain('partner payouts');
    expect(markup).not.toContain('Stripe also pays your affiliate partners');
    expect(markup).not.toContain(DIGITAL_ONLY_NEEDS_STRIPE);
  });

  it('routes only physical sales to Stripe Connect: Stripe pays those commissions, digital ones need no Stripe key', () => {
    const markup = renderWith({ partnerPayouts: true, digitalPartnerPayouts: false });

    expect(markup).toContain('<h3 class="text-sm font-semibold">Stripe (physical products and partner payouts)</h3>');
    expect(markup).toContain(
      'Stripe also pays your affiliate partners their commissions on physical product sales. Commissions on digital product sales are paid outside Stripe.'
    );
    expect(markup).not.toContain(DIGITAL_ONLY_NEEDS_STRIPE);
  });

  it.each([
    ['every sale type', true],
    ['digital sales only', false],
  ])('routes %s to Stripe Connect: a digital-only store still needs a Stripe secret key', (_label, partnerPayouts) => {
    const markup = renderWith({ partnerPayouts, digitalPartnerPayouts: true });

    expect(markup).toContain('<h3 class="text-sm font-semibold">Stripe (physical products and partner payouts)</h3>');
    expect(markup).toContain(`Stripe also pays your affiliate partners. Freemius doesn’t, so ${DIGITAL_ONLY_NEEDS_STRIPE} to run the partner program.`);
  });
});

/**
 * Round 3 review of the developer keys: readiness also reads not ready for one product's keys that
 * open no checkout (Freemius refuses a dedicated pair, no Product ID, no JSON entry), and lists
 * what is missing then. The guide replaced that list with "a developer key pair or one product's
 * public and secret key", which the operator already has.
 */
describe('PaymentsClient Freemius guide', () => {
  it.each([[[]], [['Public key']], [['Public key', 'Secret key']]])(
    'names both ways to configure Freemius while only keys are missing (%j)',
    (freemiusMissing) => {
      const markup = renderWith({ freemiusMissing });

      expect(markup).toContain(GENERIC_FREEMIUS_REQUIREMENT);
      expect(markup).not.toContain('Freemius needs <strong>Public key');
    }
  );

  it('shows what one product’s keys that open no checkout still need, not the keys the store already has', () => {
    const markup = renderWith({
      freemiusMissing: [REFUSED_PAIR_MISSING],
      freemiusDeveloper: { state: 'refused', source: null, productIds: [] },
      freemiusDeveloperSources: ['cms', 'cms-legacy'],
    });

    expect(markup).toContain(`Freemius needs <strong>${REFUSED_PAIR_MISSING}</strong>.`);
    expect(markup).not.toContain('one product’s public and secret key');
    expect(markup).not.toContain('a developer key pair</strong>');
  });

  it('shows the labels whenever the list holds anything but keys', () => {
    const markup = renderWith({ freemiusMissing: ['Secret key', 'Something new'] });

    expect(markup).toContain('Freemius needs <strong>Secret key, Something new</strong>.');
    expect(markup).not.toContain(GENERIC_FREEMIUS_REQUIREMENT);
  });
});

/**
 * Round 3 review: a one-product store that filled in its Developer ID has its one-product keys tried
 * as a developer pair (a legacy candidate: cms-legacy or env-legacy), Freemius refuses them, and the
 * screen said "Freemius refused the developer keys" to a store that has none.
 */
describe('PaymentsClient refused developer keys', () => {
  const refused: FreemiusDeveloperStatus = { state: 'refused', source: null, productIds: [] };

  it('says the one-product fields were tried as a developer pair, and that their Product ID binds them', () => {
    const markup = renderWith({ freemiusDeveloper: refused, freemiusDeveloperSources: ['cms-legacy'] });

    expect(markup).toContain(
      'Freemius refused the one-product keys below as a developer key pair: with a Developer ID filled in, they are tried as one too.'
    );
    expect(markup).toContain('If they are one product’s keys, fill in its Product ID: that binds them to that product.');
    expect(markup).not.toContain('Freemius refused the developer keys');
  });

  it('says so of FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY when the env holds the one-product keys', () => {
    const markup = renderWith({ freemiusDeveloper: refused, freemiusDeveloperSources: ['env-legacy'] });

    expect(markup).toContain(
      'Freemius refused the one-product keys in <code>FREEMIUS_PUBLIC_KEY</code> and <code>FREEMIUS_SECRET_KEY</code> as a developer key pair: with a Developer ID set, they are tried as one too.'
    );
    expect(markup).toContain(
      'fill in its Product ID below (or set <code>FREEMIUS_PRODUCT_ID</code>): that binds them to that product.'
    );
    expect(markup).not.toContain('Freemius refused the developer keys');
  });

  it('does not ask for a Product ID the fields already hold', () => {
    const markup = renderWith({
      freemiusDeveloper: refused,
      freemiusDeveloperSources: ['cms-legacy', 'env-legacy'],
      freemiusProductId: '24851',
    });

    expect(markup).toContain('Freemius refused the one-product keys below as a developer key pair');
    expect(markup).toContain('Their Product ID binds them to that product.');
    expect(markup).not.toContain('fill in its Product ID');
  });

  it.each([[['cms']], [['env']], [['cms', 'cms-legacy']], [['env', 'env-legacy']], [[]]] as const)(
    'keeps the developer keys copy when a dedicated pair was refused (%j)',
    (freemiusDeveloperSources) => {
      const markup = renderWith({ freemiusDeveloper: refused, freemiusDeveloperSources: [...freemiusDeveloperSources] });

      expect(markup).toContain(REFUSED_DEDICATED_PAIR);
      expect(markup).not.toContain('one-product keys below as a developer key pair');
      expect(markup).not.toContain('<code>FREEMIUS_SECRET_KEY</code> as a developer key pair');
    }
  );

  // The client cannot import the server module's predicate, so its own copy is held to it here.
  it.each(['cms', 'env', 'cms-legacy', 'env-legacy'] as const)(
    'words a refused %s pair as freemius-developer-api classifies that source',
    async (source) => {
      const { isLegacyFreemiusDeveloperSource } = await import('../../../freemius-developer-api');
      const markup = renderWith({ freemiusDeveloper: refused, freemiusDeveloperSources: [source] });

      expect(markup.includes(REFUSED_DEDICATED_PAIR)).toBe(!isLegacyFreemiusDeveloperSource(source));
      expect(markup.includes('as a developer key pair: with a Developer ID')).toBe(isLegacyFreemiusDeveloperSource(source));
    }
  );

  it('keeps the unreachable copy for one-product keys Freemius could not be asked about', () => {
    const markup = renderWith({
      freemiusDeveloper: { state: 'unreachable', source: null, productIds: [] },
      freemiusDeveloperSources: ['cms-legacy'],
    });

    expect(markup).toContain('couldn&#x27;t be reached to check the developer keys');
    expect(markup).not.toContain('as a developer key pair');
  });
});

/**
 * 0.23.4 verification (F3): a stored secret showed only a "stored — leave blank to keep" placeholder,
 * so nothing could delete it, a leaked developer pair in the one-product fields included. Each
 * stored secret now has a remove box, submitted with the keys form (savePaymentProviderCredentials
 * maps `remove_<field id>` = `true` to the stored secret).
 */
describe('PaymentsClient remove boxes', () => {
  const BOXES = [
    ['stripe_secretKey', 'Remove the stored secret key'],
    ['stripe_webhookSecret', 'Remove the stored signing secret'],
    ['freemius_developerSecretKey', 'Remove the stored developer secret key'],
    ['freemius_secretKey', 'Remove the stored secret key'],
    ['freemius_apiKey', 'Remove the stored API key'],
  ] as const;

  function renderStored(stored: { stripe?: boolean; webhook?: boolean; developer?: boolean; secret?: boolean; api?: boolean }): string {
    return renderToStaticMarkup(
      <PaymentsClient
        initialEnabledProviders={{ stripe: false, freemius: false }}
        configStatus={{ stripe: { hasKeys: false, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
        credentials={{
          stripe: { publishableKey: 'pk_test_public', hasSecretKey: Boolean(stored.stripe), hasWebhookSecret: Boolean(stored.webhook) },
          freemius: {
            developerId: '4242',
            developerPublicKey: 'pk_dev_public',
            hasDeveloperSecretKey: Boolean(stored.developer),
            publicKey: 'pk_product_public',
            productId: '24851',
            hasSecretKey: Boolean(stored.secret),
            hasApiKey: Boolean(stored.api),
          },
          envFallbackActive: false,
        }}
        saveAction={async () => undefined}
        saveCredentialsAction={async () => undefined}
      />
    );
  }

  it('offers an unticked, labelled remove box in the keys form under each stored secret', () => {
    const markup = renderStored({ stripe: true, webhook: true, developer: true, secret: true, api: true });
    const form = markup.match(/<form[\s\S]*?<\/form>/)?.[0] ?? '';

    for (const [field, label] of BOXES) {
      const box = form.match(new RegExp(`<input[^>]*id="remove_${field}"[^>]*>`))?.[0] ?? '';
      expect(box, field).toContain(`name="remove_${field}"`);
      expect(box, field).toContain('type="checkbox"');
      expect(box, field).toContain('value="true"');
      expect(box, field).not.toMatch(/checked/);
      expect(form, field).toMatch(new RegExp(`<label for="remove_${field}"[^>]*><input[^>]*><span>${label}</span></label>`));
    }
    expect(form.match(/name="remove_/g)).toHaveLength(BOXES.length);
  });

  it('offers a box only for the secrets that are stored', () => {
    const markup = renderStored({ developer: true, api: true });

    expect(markup.match(/name="remove_[^"]*"/g)).toEqual(['name="remove_freemius_developerSecretKey"', 'name="remove_freemius_apiKey"']);
  });

  it('offers none when nothing is stored, as on the sandbox, whose form shows nothing stored', () => {
    expect(renderStored({})).not.toContain('remove_');

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(render()).not.toContain('remove_');
  });

  it('says what a remove box does, and that the environment variable applies again', () => {
    expect(render()).toContain(
      'Leave a secret blank to keep the stored value, or tick the remove box under it to delete it when you save: its environment variable, if one is set, then applies again.'
    );
  });
});
