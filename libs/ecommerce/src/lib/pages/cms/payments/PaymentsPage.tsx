import { savePaymentProviderCredentials, updatePaymentSettings } from './actions';
import {
  getEnabledPaymentProviders,
  getStoreConfigStatus,
} from './queries';
import { describeFreemiusDeveloperPairs, getFreemiusDeveloperStatus } from '../../../freemius-developer-api';
import { getPaymentCredentialsView } from '../../../payment-config';
import { PaymentsClient } from './PaymentsClient';

/**
 * The developer pair's check with Freemius first, then readiness. Readiness (getStoreConfigStatus,
 * the same predicate as the storefront's) never waits on Freemius: it reads the pair's verdict from
 * memory and counts a pair nobody has checked yet as ready. After a cold start, and after every key
 * save (which forgets the verdicts), a pair Freemius refuses would then show as ready here, and the
 * toggle action below, which keeps the readiness this render saw, would let the admin switch
 * Freemius on with it. Waiting for the check records the verdict that readiness then reads.
 */
async function readFreemiusDeveloperThenReadiness() {
  // Facts only (working or not, where from, the product ids): never key material.
  const freemiusDeveloper = await getFreemiusDeveloperStatus().catch(() => null);
  const configStatus = await getStoreConfigStatus();
  // A refusal says nothing of which pairs were tried. Their sources do (never their keys): with a
  // Developer ID, one product's keys are tried as a developer pair too, and the screen words that
  // refusal for them instead of asking to check developer keys the store may not have.
  const freemiusDeveloperSources =
    freemiusDeveloper?.state === 'refused'
      ? ((await describeFreemiusDeveloperPairs({ publicKey: null, secretKey: null }).catch(() => null))?.sources ?? [])
      : [];

  return { freemiusDeveloper, configStatus, freemiusDeveloperSources };
}

/**
 * CMS → Payments. The lib cannot tell whether the app's Affiliates program pays partners through
 * Stripe, so the app says: `partnerPayouts` when Stripe Connect pays the commissions of at least
 * one sale type, `digitalPartnerPayouts` when that includes digital (Freemius) sales (defaults to
 * `partnerPayouts`). The Stripe section then says Stripe also pays the partners.
 */
export async function PaymentsPage({
  partnerPayouts = false,
  digitalPartnerPayouts,
}: { partnerPayouts?: boolean; digitalPartnerPayouts?: boolean } = {}) {
  // The other reads do not depend on the pair's verdict, so they run while Freemius answers.
  const [initialEnabledProviders, credentials, { freemiusDeveloper, configStatus, freemiusDeveloperSources }] = await Promise.all([
    getEnabledPaymentProviders(),
    getPaymentCredentialsView(),
    readFreemiusDeveloperThenReadiness(),
  ]);

  async function savePaymentSettings(formData: FormData) {
    'use server';

    const nextSettings = {
      stripe:
        formData.get('stripe_enabled') === 'true' && configStatus.stripe.hasKeys,
      freemius:
        formData.get('freemius_enabled') === 'true' &&
        configStatus.freemius.hasKeys,
    };

    await updatePaymentSettings(nextSettings);
  }

  return (
    <PaymentsClient
      initialEnabledProviders={initialEnabledProviders}
      configStatus={configStatus}
      credentials={credentials}
      freemiusDeveloper={freemiusDeveloper}
      freemiusDeveloperSources={freemiusDeveloperSources}
      saveAction={savePaymentSettings}
      saveCredentialsAction={savePaymentProviderCredentials}
      partnerPayouts={partnerPayouts}
      digitalPartnerPayouts={digitalPartnerPayouts}
    />
  );
}
