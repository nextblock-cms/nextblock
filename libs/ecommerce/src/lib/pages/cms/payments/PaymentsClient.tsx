'use client';

import { type ReactNode, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
} from '@nextblock-cms/ui';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import type { FreemiusDeveloperStatus } from '../../../freemius-developer-api';
import type { FreemiusDeveloperCredentialSource, PaymentCredentialsView } from '../../../payment-config';
// Events the Stripe endpoint must send (one list, also checked by the Affiliates connection test).
import { STRIPE_REQUIRED_WEBHOOK_EVENTS, stripeCliListenCommand } from '../../../stripe/webhook-events';

interface ConfigStatus {
  stripe: {
    hasKeys: boolean;
    missing: string[];
  };
  freemius: {
    hasKeys: boolean;
    missing: string[];
  };
}

/** What readiness lists while one product's keys are incomplete and no developer pair is usable (payment-config.ts). */
const FREEMIUS_KEY_LABELS: ReadonlySet<string> = new Set(['Public key', 'Secret key']);

/**
 * Freemius lacks nothing but keys, so either way of configuring it works and the guide names both.
 * Any other label (one product's keys that open no checkout: "Developer key pair Freemius accepts,
 * or a Product ID") is what the operator actually has to add, so the guide shows the labels.
 */
function isFreemiusKeyList(missing: readonly string[]): boolean {
  return missing.every((label) => FREEMIUS_KEY_LABELS.has(label));
}

export function PaymentsClient({
  initialEnabledProviders,
  configStatus,
  credentials,
  freemiusDeveloper = null,
  freemiusDeveloperSources = [],
  saveAction,
  saveCredentialsAction,
  partnerPayouts = false,
  digitalPartnerPayouts,
}: {
  initialEnabledProviders: {
    stripe: boolean;
    freemius: boolean;
  };
  configStatus: ConfigStatus;
  credentials: PaymentCredentialsView;
  /** Whether Freemius accepts the developer key pair (and how many products it reaches). */
  freemiusDeveloper?: FreemiusDeveloperStatus | null;
  /**
   * Where each configured developer pair comes from, in the order they are tried: sources only,
   * never key material. Words a refusal: with a Developer ID, the one-product keys are tried as a
   * developer pair too (`cms-legacy` / `env-legacy`).
   */
  freemiusDeveloperSources?: readonly FreemiusDeveloperCredentialSource[];
  saveAction: (formData: FormData) => Promise<void>;
  saveCredentialsAction: (formData: FormData) => Promise<void>;
  /**
   * Stripe pays affiliate partners: the app passes it while the Affiliates program is active and
   * at least one sale type's commissions go through Stripe Connect (`affiliateGatewaysPaidByStripe`).
   * A store paying every commission outside Stripe (by hand or with PayPal) never calls Stripe for
   * partners, so the Stripe section then says nothing about them. Off by default, so a store
   * without the add-on is never told about partners it doesn't have.
   */
  partnerPayouts?: boolean;
  /**
   * Stripe Connect also pays the commissions on digital (Freemius) sales, so a store that sells
   * only digital products still needs a Stripe secret key for its partners. Defaults to
   * `partnerPayouts`: the program's default routing pays every sale type through Stripe Connect.
   */
  digitalPartnerPayouts?: boolean;
}) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const isStripeReady = configStatus.stripe.hasKeys;
  const isFreemiusReady = configStatus.freemius.hasKeys;
  const [enabledProviders, setEnabledProviders] = useState(() => ({
    // Older installs can contain an enabled flag from before providers defaulted off.
    // An unconfigured provider cannot be enabled, so never present that stale flag as
    // an active checkbox. Saving the form also persists this reconciled false value.
    stripe: initialEnabledProviders.stripe && isStripeReady,
    freemius: initialEnabledProviders.freemius && isFreemiusReady,
  }));

  // Persist the toggles, then force a fresh RSC read. `revalidatePath` alone
  // left the client Router Cache serving the pre-save value, so the checkbox
  // snapped back to its old state until a hard reload; `router.refresh()`
  // refetches the route so the reconciled UI matches what we just wrote.
  function handleSaveProviders() {
    const formData = new FormData();
    formData.set('stripe_enabled', enabledProviders.stripe ? 'true' : 'false');
    formData.set(
      'freemius_enabled',
      enabledProviders.freemius ? 'true' : 'false',
    );
    startSaving(async () => {
      await saveAction(formData);
      router.refresh();
    });
  }

  return (
    <div className="max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Payment Settings</h1>
        <p className="text-sm text-muted-foreground">
          Enter your provider API keys, then enable the providers your store
          needs. Physical products use Stripe and digital products use Freemius.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <ProviderCredentialsCard
          credentials={credentials}
          freemiusDeveloper={freemiusDeveloper}
          freemiusDeveloperSources={freemiusDeveloperSources}
          saveAction={saveCredentialsAction}
          partnerPayouts={partnerPayouts || digitalPartnerPayouts === true}
          digitalPartnerPayouts={digitalPartnerPayouts ?? partnerPayouts}
        />

        <Card className="flex h-full flex-col">
          <CardHeader className="pb-3">
            <CardTitle>Payment Providers</CardTitle>
            <CardDescription>
              You can run both providers at the same time. Each product picks
              its provider from its product type.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <div className="space-y-3">
              <ProviderToggleCard
                id="stripe-enabled"
                label="Stripe for Physical Products"
                description="Use Stripe Checkout for physical merchandise and other shippable goods."
                checked={enabledProviders.stripe}
                disabled={!isStripeReady}
                onCheckedChange={(checked) =>
                  setEnabledProviders((current) => ({
                    ...current,
                    stripe: checked,
                  }))
                }
                ready={isStripeReady}
              >
                {!isStripeReady ? (
                  <MissingKeysGuide
                    provider="Stripe"
                    missingKeys={configStatus.stripe.missing}
                    docsUrl="https://dashboard.stripe.com/apikeys"
                    docsLabel="Stripe API keys"
                  />
                ) : (
                  <div className="mt-2 flex items-center gap-2 text-xs text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Ready for physical product checkout</span>
                  </div>
                )}
              </ProviderToggleCard>

              <ProviderToggleCard
                id="freemius-enabled"
                label="Freemius for Digital Products"
                description="Use Freemius for software licenses, SaaS plans, and other digital products."
                checked={enabledProviders.freemius}
                disabled={!isFreemiusReady}
                onCheckedChange={(checked) =>
                  setEnabledProviders((current) => ({
                    ...current,
                    freemius: checked,
                  }))
                }
                ready={isFreemiusReady}
              >
                {!isFreemiusReady ? (
                  <MissingKeysGuide
                    provider="Freemius"
                    missingKeys={configStatus.freemius.missing}
                    requirement={
                      isFreemiusKeyList(configStatus.freemius.missing) ? (
                        <>
                          Freemius needs <strong>a developer key pair</strong> (Developer ID, developer
                          public and secret key) or <strong>one product&rsquo;s public and secret key</strong>.
                        </>
                      ) : undefined
                    }
                    docsUrl="https://dashboard.freemius.com/"
                    docsLabel="Freemius credentials"
                  />
                ) : (
                  <div className="mt-2 flex items-center gap-2 text-xs text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Ready for digital product checkout</span>
                  </div>
                )}
              </ProviderToggleCard>
            </div>

            <div className="mt-auto flex justify-end border-t pt-4">
              <Button
                type="button"
                disabled={isSaving}
                onClick={handleSaveProviders}
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** savePaymentCredentials saves nothing on the sandbox (PAYMENT_SETTINGS_SANDBOX_MESSAGE). */
const SANDBOX_KEYS_NOTE = "Payment keys can't be changed in the sandbox: its checkout is simulated.";
const SANDBOX_KEYS_NOTE_ID = 'payment-keys-sandbox-note';

function SaveButton({ locked = false }: { locked?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      disabled={pending || locked}
      aria-describedby={locked ? SANDBOX_KEYS_NOTE_ID : undefined}
    >
      {pending ? 'Saving...' : 'Save Changes'}
    </Button>
  );
}

function CredentialField({
  id,
  label,
  type = 'text',
  defaultValue,
  placeholder,
  hint,
  removeLabel,
}: {
  id: string;
  label: ReactNode;
  type?: 'text' | 'password';
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  /**
   * Set for a stored secret: a box (`remove_<id>`, value `true`) that deletes it on save while the
   * field stays blank (savePaymentProviderCredentials). Without it a stored key could not be
   * removed, a leaked one included.
   */
  removeLabel?: string;
}) {
  const removeId = `remove_${id}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {removeLabel ? (
        <label htmlFor={removeId} className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            id={removeId}
            name={removeId}
            type="checkbox"
            value="true"
            className="h-3.5 w-3.5 rounded border-slate-300 text-primary focus:ring-primary"
          />
          <span>{removeLabel}</span>
        </label>
      ) : null}
    </div>
  );
}

/** Where a working developer pair was found, when it is not the developer fields of this screen. */
const DEVELOPER_SOURCE_NOTES: Partial<Record<NonNullable<FreemiusDeveloperStatus['source']>, ReactNode>> = {
  env: (
    <>
      They come from the <code>FREEMIUS_DEVELOPER_PUBLIC_KEY</code> and <code>FREEMIUS_DEVELOPER_SECRET_KEY</code>{' '}
      environment variables.
    </>
  ),
  // A supported home for the pair (installs that ran Sync from Freemius kept it there): say where
  // it comes from, as for the developer names, and ask for no move.
  'env-legacy': (
    <>
      They come from the <code>FREEMIUS_PUBLIC_KEY</code> and <code>FREEMIUS_SECRET_KEY</code>{' '}
      environment variables.
    </>
  ),
  'cms-legacy': <>They were entered in the one-product fields below: move them to the developer fields.</>,
};

/** A pair configured under the one-product names (the CMS fields or FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY). */
function isOneProductKeysSource(source: FreemiusDeveloperCredentialSource): boolean {
  return source === 'cms-legacy' || source === 'env-legacy';
}

/**
 * Every pair Freemius refused came from the one-product names: a Developer ID turns those keys
 * into a developer pair candidate, and Freemius refuses one product's keys at developer scope.
 * They are not developer keys, so say what was tried and how to bind them to their product.
 */
function RefusedOneProductKeys({
  sources,
  productId,
}: {
  sources: readonly FreemiusDeveloperCredentialSource[];
  productId: string;
}) {
  const inFields = sources.includes('cms-legacy');
  const bound = productId.trim() !== '';

  return (
    <p className="text-xs text-amber-700">
      {inFields ? (
        <>
          Freemius refused the one-product keys below as a developer key pair: with a Developer ID
          filled in, they are tried as one too.
        </>
      ) : (
        <>
          Freemius refused the one-product keys in <code>FREEMIUS_PUBLIC_KEY</code> and{' '}
          <code>FREEMIUS_SECRET_KEY</code> as a developer key pair: with a Developer ID set, they are
          tried as one too.
        </>
      )}{' '}
      {bound ? (
        'Their Product ID binds them to that product.'
      ) : inFields ? (
        <>If they are one product&rsquo;s keys, fill in its Product ID: that binds them to that product.</>
      ) : (
        <>
          If they are one product&rsquo;s keys, fill in its Product ID below (or set{' '}
          <code>FREEMIUS_PRODUCT_ID</code>): that binds them to that product.
        </>
      )}
    </p>
  );
}

function DeveloperKeysStatus({
  status,
  sources,
  productId,
}: {
  status: FreemiusDeveloperStatus | null;
  sources: readonly FreemiusDeveloperCredentialSource[];
  productId: string;
}) {
  if (!status || status.state === 'missing' || status.state === 'sandbox') {
    return null;
  }

  if (status.state === 'refused' && sources.length > 0 && sources.every(isOneProductKeysSource)) {
    return <RefusedOneProductKeys sources={sources} productId={productId} />;
  }

  if (status.state === 'working') {
    const count = status.productIds.length;
    const note = status.source ? DEVELOPER_SOURCE_NOTES[status.source] : null;

    return (
      <div className="space-y-1 text-xs">
        <p className="flex items-center gap-2 text-green-600">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          <span>
            Freemius accepts the developer keys: they reach {count} {count === 1 ? 'product' : 'products'}.
          </span>
        </p>
        {note ? <p className="text-muted-foreground">{note}</p> : null}
      </div>
    );
  }

  return (
    <p className="text-xs text-amber-700">
      {status.state === 'refused'
        ? 'Freemius refused the developer keys. Check the Developer ID and the key pair (Freemius → My Profile → Keys).'
        : "Freemius couldn't be reached to check the developer keys. They are checked again on the next visit."}
    </p>
  );
}

function ProviderCredentialsCard({
  credentials,
  freemiusDeveloper,
  freemiusDeveloperSources,
  saveAction,
  partnerPayouts,
  digitalPartnerPayouts,
}: {
  credentials: PaymentCredentialsView;
  freemiusDeveloper: FreemiusDeveloperStatus | null;
  freemiusDeveloperSources: readonly FreemiusDeveloperCredentialSource[];
  saveAction: (formData: FormData) => Promise<void>;
  partnerPayouts: boolean;
  digitalPartnerPayouts: boolean;
}) {
  const storedPlaceholder = '•••••••• (stored — leave blank to keep)';
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const freemius = credentials.freemius;
  // The one-product fields matter only without a working developer pair, or once they hold
  // something: fold them away while the developer keys work and every field is empty, so the
  // screen leads with the keys in use. A closed <details> still submits its fields, all blank
  // here, which saves nothing new; it opens on its own once any of them holds a value.
  const oneProductKeysInUse =
    freemius.productId.trim() !== '' ||
    freemius.publicKey.trim() !== '' ||
    freemius.hasSecretKey ||
    freemius.hasApiKey;
  const foldOneProductKeys = freemiusDeveloper?.state === 'working' && !oneProductKeysInUse;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <CardTitle>Provider API Keys</CardTitle>
        <CardDescription>
          Keys are encrypted at rest and used DB-first (these override any{' '}
          <code>.env</code> values). Leave a secret blank to keep the stored
          value, or tick the remove box under it to delete it when you save:
          its environment variable, if one is set, then applies again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <form action={saveAction} className="flex flex-1 flex-col gap-4">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">
              {partnerPayouts
                ? 'Stripe (physical products and partner payouts)'
                : 'Stripe (physical products)'}
            </h3>
            {partnerPayouts ? (
              <p className="text-xs text-muted-foreground">
                {digitalPartnerPayouts ? (
                  <>
                    Stripe also pays your affiliate partners. Freemius doesn&rsquo;t,
                    so a store that sells only digital products still needs a Stripe
                    secret key to run the partner program.
                  </>
                ) : (
                  <>
                    Stripe also pays your affiliate partners their commissions on
                    physical product sales. Commissions on digital product sales are
                    paid outside Stripe.
                  </>
                )}
              </p>
            ) : null}
            <details className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                Stripe webhook setup
              </summary>
              <div className="mt-2 space-y-1.5">
                <p>
                  In Stripe, add{' '}
                  <code>https://your-domain/api/webhooks/stripe</code> as a
                  webhook endpoint and paste its <code>whsec_…</code> signing
                  secret below.
                </p>
                <p>Select these events for the endpoint:</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {STRIPE_REQUIRED_WEBHOOK_EVENTS.map((eventType) => (
                    <li key={eventType}>
                      <code>{eventType}</code>
                    </li>
                  ))}
                </ul>
                <p>
                  The refund and dispute events mark refunded orders and
                  reverse affiliate commissions; an open dispute holds the
                  partner&rsquo;s commission until it closes.
                </p>
                <p>
                  Locally, run{' '}
                  <code className="break-all">
                    {stripeCliListenCommand('localhost:3000/api/webhooks/stripe')}
                  </code>{' '}
                  with your dev server&rsquo;s port, and paste
                  the <code>whsec_…</code> secret it prints below.
                </p>
              </div>
            </details>
            <div className="grid gap-3 sm:grid-cols-3">
              <CredentialField
                id="stripe_publishableKey"
                label="Publishable key"
                defaultValue={credentials.stripe.publishableKey}
                placeholder="pk_live_…"
              />
              <CredentialField
                id="stripe_secretKey"
                label="Secret key"
                type="password"
                placeholder={
                  credentials.stripe.hasSecretKey
                    ? storedPlaceholder
                    : 'sk_live_…'
                }
                removeLabel={credentials.stripe.hasSecretKey ? 'Remove the stored secret key' : undefined}
              />
              <CredentialField
                id="stripe_webhookSecret"
                label="Webhook signing secret"
                type="password"
                placeholder={
                  credentials.stripe.hasWebhookSecret
                    ? storedPlaceholder
                    : 'whsec_…'
                }
                removeLabel={credentials.stripe.hasWebhookSecret ? 'Remove the stored signing secret' : undefined}
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">
              Freemius (digital products)
            </h3>
            <p className="text-xs text-muted-foreground">
              Enter your Freemius developer keys (in Freemius: My Profile
              &rarr; Keys) and every product of your Freemius account works with
              them: checkout, webhooks, license keys on orders, trials and
              coupons each read that product&rsquo;s own keys from Freemius when
              they need them. A product you add in Freemius works after Sync
              from Freemius (CMS &rarr; Products), with nothing to paste.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <CredentialField
                id="freemius_developerId"
                label="Developer ID"
                defaultValue={credentials.freemius.developerId}
                hint="Shown in Freemius under My Profile. Sync from Freemius (CMS → Products) and the developer keys need it."
              />
              <CredentialField
                id="freemius_developerPublicKey"
                label="Developer public key"
                defaultValue={credentials.freemius.developerPublicKey}
                placeholder="pk_…"
              />
              <CredentialField
                id="freemius_developerSecretKey"
                label="Developer secret key"
                type="password"
                placeholder={
                  credentials.freemius.hasDeveloperSecretKey ? storedPlaceholder : 'sk_…'
                }
                hint="Reaches every product of your Freemius account: it stays on the server, encrypted."
                removeLabel={
                  credentials.freemius.hasDeveloperSecretKey ? 'Remove the stored developer secret key' : undefined
                }
              />
            </div>
            <DeveloperKeysStatus
              status={freemiusDeveloper}
              sources={freemiusDeveloperSources}
              productId={credentials.freemius.productId}
            />

            <details
              id="freemius-one-product-keys"
              open={!foldOneProductKeys}
              className="space-y-3 pt-1"
            >
              <summary className="cursor-pointer text-xs font-semibold">
                One product&rsquo;s keys (optional)
                {foldOneProductKeys ? (
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    &middot; not needed while the developer keys work
                  </span>
                ) : null}
              </summary>
              <p className="text-xs text-muted-foreground">
                Only needed without developer keys, or for a product they
                can&rsquo;t reach (one from another Freemius account): these fields
                hold the keys of one Freemius product (in Freemius: the product
                &rarr; Settings &rarr; API &amp; Keys). Each product in CMS &rarr;
                Products keeps its own Freemius Product ID and Plan ID for
                checkout. More such products go in the{' '}
                <code>FREEMIUS_CHECKOUT_PRODUCTS_JSON</code> environment variable.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <CredentialField
                  id="freemius_productId"
                  label="Product ID (optional)"
                  defaultValue={credentials.freemius.productId}
                  hint="The product these keys belong to. Fill it in, also for a product outside your developer account: the keys then serve that product only and keep working while Freemius is slow or busy. Leave it empty only on a one-product store with no Developer ID. Developer keys never go here."
                />
                <CredentialField
                  id="freemius_publicKey"
                  label="Public key"
                  defaultValue={credentials.freemius.publicKey}
                  placeholder="pk_…"
                  hint="Opens the Freemius checkout."
                />
                <CredentialField
                  id="freemius_secretKey"
                  label="Secret key"
                  type="password"
                  placeholder={
                    credentials.freemius.hasSecretKey ? storedPlaceholder : 'sk_…'
                  }
                  hint="Proves that webhooks really come from Freemius."
                  removeLabel={credentials.freemius.hasSecretKey ? 'Remove the stored secret key' : undefined}
                />
                <CredentialField
                  id="freemius_apiKey"
                  label="API key"
                  type="password"
                  placeholder={
                    credentials.freemius.hasApiKey ? storedPlaceholder : 'API key'
                  }
                  hint="The API bearer token from the same Freemius page. Shows license keys on orders and sends coupons to Freemius."
                  removeLabel={credentials.freemius.hasApiKey ? 'Remove the stored API key' : undefined}
                />
              </div>
            </details>
          </div>

          {credentials.envFallbackActive && (
            <p className="text-xs text-amber-700">
              Stripe keys are currently read from environment variables. Saving
              here moves them into the database and takes precedence.
            </p>
          )}

          {sandbox && (
            <p id={SANDBOX_KEYS_NOTE_ID} className="text-xs text-muted-foreground">
              {SANDBOX_KEYS_NOTE}
            </p>
          )}

          <div className="mt-auto flex justify-end border-t pt-4">
            <SaveButton locked={sandbox} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ProviderToggleCard({
  id,
  label,
  description,
  checked,
  disabled,
  ready,
  onCheckedChange,
  children,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  ready: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(Boolean(value))}
          className="mt-1"
        />
        <div className="grid gap-1.5 leading-none w-full">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Label
              htmlFor={id}
              className="font-semibold text-base cursor-pointer"
            >
              {label}
            </Label>
            <span
              className={`text-xs font-medium ${
                checked ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {checked ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
          {!ready && (
            <p className="text-xs text-amber-700">
              Add all required credentials before enabling this provider.
            </p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

function MissingKeysGuide({
  provider,
  missingKeys,
  requirement,
  docsUrl,
  docsLabel,
}: {
  provider: string;
  missingKeys: string[];
  /** Replaces the "{provider} needs …" sentence when there is more than one way to configure it. */
  requirement?: ReactNode;
  docsUrl: string;
  docsLabel: string;
}) {
  return (
    <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-foreground">
      <div className="mb-1.5 flex items-center gap-2 font-semibold text-destructive">
        <AlertCircle className="h-4 w-4" />
        <span>Configuration Required</span>
      </div>
      <p>
        {requirement ?? (
          <>
            {provider} needs <strong>{missingKeys.join(', ')}</strong>.
          </>
        )}{' '}
        Add them in Provider API Keys, save, then enable the provider.{' '}
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-destructive/80"
        >
          Open {docsLabel}
        </a>
        .
      </p>
    </div>
  );
}
