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
import type { PaymentCredentialsView } from '../../../payment-config';
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

export function PaymentsClient({
  initialEnabledProviders,
  configStatus,
  credentials,
  saveAction,
  saveCredentialsAction,
  partnerPayouts = false,
}: {
  initialEnabledProviders: {
    stripe: boolean;
    freemius: boolean;
  };
  configStatus: ConfigStatus;
  credentials: PaymentCredentialsView;
  saveAction: (formData: FormData) => Promise<void>;
  saveCredentialsAction: (formData: FormData) => Promise<void>;
  /**
   * The Affiliates program is active (the app passes `isAffiliatesProgramActive()`): Stripe also
   * pays the partners, and the Stripe section says so. Off by default, so a store without the
   * add-on is never told about partners it doesn't have.
   */
  partnerPayouts?: boolean;
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
          saveAction={saveCredentialsAction}
          partnerPayouts={partnerPayouts}
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
}: {
  id: string;
  label: ReactNode;
  type?: 'text' | 'password';
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
}) {
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
    </div>
  );
}

function ProviderCredentialsCard({
  credentials,
  saveAction,
  partnerPayouts,
}: {
  credentials: PaymentCredentialsView;
  saveAction: (formData: FormData) => Promise<void>;
  partnerPayouts: boolean;
}) {
  const storedPlaceholder = '•••••••• (stored — leave blank to keep)';
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <CardTitle>Provider API Keys</CardTitle>
        <CardDescription>
          Keys are encrypted at rest and used DB-first (these override any{' '}
          <code>.env</code> values). Leave a secret blank to keep the stored
          value.
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
                Stripe also pays your affiliate partners. Freemius doesn&rsquo;t,
                so a store that sells only digital products still needs a Stripe
                secret key to run the partner program.
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
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">
              Freemius (digital products)
            </h3>
            <p className="text-xs text-muted-foreground">
              These fields hold the keys of one Freemius product (in Freemius:
              the product &rarr; Settings &rarr; API &amp; Keys). Each product
              in CMS &rarr; Products keeps its own Freemius Product ID and Plan
              ID for checkout. Selling more than one Freemius product? Each one
              signs its webhooks with its own secret key, so also list every
              product&rsquo;s keys in the{' '}
              <code>FREEMIUS_CHECKOUT_PRODUCTS_JSON</code> environment variable.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <CredentialField
                id="freemius_developerId"
                label="Developer ID (optional)"
                defaultValue={credentials.freemius.developerId}
                hint="Only used by Sync from Freemius (CMS → Products), which imports your products, plans and prices."
              />
              <CredentialField
                id="freemius_productId"
                label="Product ID (optional)"
                defaultValue={credentials.freemius.productId}
                hint="Can stay empty: checkout, licenses, coupons and webhooks use the Freemius Product ID saved on each product."
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
              />
              <CredentialField
                id="freemius_apiKey"
                label="API key"
                type="password"
                placeholder={
                  credentials.freemius.hasApiKey ? storedPlaceholder : 'API key'
                }
                hint="The API bearer token from the same Freemius page. Shows license keys on orders and sends coupons to Freemius."
              />
            </div>
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
  docsUrl,
  docsLabel,
}: {
  provider: string;
  missingKeys: string[];
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
        {provider} needs <strong>{missingKeys.join(', ')}</strong>. Add them in
        Provider API Keys, save, then enable the provider.{' '}
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
