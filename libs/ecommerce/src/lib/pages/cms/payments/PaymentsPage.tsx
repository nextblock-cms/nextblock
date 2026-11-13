import { savePaymentProviderCredentials, updatePaymentSettings } from './actions';
import {
  getEnabledPaymentProviders,
  getStoreConfigStatus,
} from './queries';
import { getPaymentCredentialsView } from '../../../payment-config';
import { PaymentsClient } from './PaymentsClient';

/**
 * CMS → Payments. `partnerPayouts`: the app's Affiliates program is active (the lib cannot tell),
 * so the Stripe section also says Stripe pays the partners.
 */
export async function PaymentsPage({ partnerPayouts = false }: { partnerPayouts?: boolean } = {}) {
  const [initialEnabledProviders, configStatus, credentials] = await Promise.all([
    getEnabledPaymentProviders(),
    getStoreConfigStatus(),
    getPaymentCredentialsView(),
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
      saveAction={savePaymentSettings}
      saveCredentialsAction={savePaymentProviderCredentials}
      partnerPayouts={partnerPayouts}
    />
  );
}
