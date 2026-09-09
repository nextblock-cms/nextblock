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
}: {
  initialEnabledProviders: {
    stripe: boolean;
    freemius: boolean;
  };
  configStatus: ConfigStatus;
  credentials: PaymentCredentialsView;
  saveAction: (formData: FormData) => Promise<void>;
  saveCredentialsAction: (formData: FormData) => Promise<void>;
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

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
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
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ProviderCredentialsCard({
  credentials,
  saveAction,
}: {
  credentials: PaymentCredentialsView;
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const storedPlaceholder = '•••••••• (stored — leave blank to keep)';

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
              Stripe (physical products)
            </h3>
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
                <p>
                  Locally, run{' '}
                  <code>
                    stripe listen --forward-to
                    localhost:4200/api/webhooks/stripe
                  </code>{' '}
                  or <code>npm run stripe</code>.
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <CredentialField
                id="freemius_developerId"
                label="Developer ID"
                defaultValue={credentials.freemius.developerId}
              />
              <CredentialField
                id="freemius_productId"
                label="Product ID"
                defaultValue={credentials.freemius.productId}
              />
              <CredentialField
                id="freemius_publicKey"
                label="Public key"
                defaultValue={credentials.freemius.publicKey}
                placeholder="pk_…"
              />
              <CredentialField
                id="freemius_secretKey"
                label="Secret key"
                type="password"
                placeholder={
                  credentials.freemius.hasSecretKey ? storedPlaceholder : 'sk_…'
                }
              />
              <CredentialField
                id="freemius_apiKey"
                label="API key"
                type="password"
                placeholder={
                  credentials.freemius.hasApiKey ? storedPlaceholder : 'API key'
                }
              />
            </div>
          </div>

          {credentials.envFallbackActive && (
            <p className="text-xs text-amber-700">
              Stripe keys are currently read from environment variables. Saving
              here moves them into the database and takes precedence.
            </p>
          )}

          <div className="mt-auto flex justify-end border-t pt-4">
            <SaveButton />
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
