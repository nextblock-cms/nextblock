'use server';

import { createClient } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';

import type { EnabledPaymentProviders } from '../../../types';
import { savePaymentCredentials, type RemovablePaymentSecret } from '../../../payment-config';

/**
 * The keys form's remove boxes (PaymentsClient renders `remove_<field id>` under a stored secret),
 * each with the stored secret it deletes. Only the value `true` ticks one.
 */
const REMOVE_SECRET_BOXES: ReadonlyArray<readonly [box: string, field: RemovablePaymentSecret]> = [
  ['remove_stripe_secretKey', 'stripeSecretKey'],
  ['remove_stripe_webhookSecret', 'stripeWebhookSecret'],
  ['remove_freemius_developerSecretKey', 'freemiusDeveloperSecretKey'],
  ['remove_freemius_secretKey', 'freemiusSecretKey'],
  ['remove_freemius_apiKey', 'freemiusApiKey'],
];

async function assertAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('Unauthorized');
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!profile || profile.role !== 'ADMIN') {
    throw new Error('Forbidden');
  }
}

/**
 * CMS → Payments' keys form. `savePaymentCredentials` checks the actor again with the second factor
 * (`requireEcomAdmin()`) before it reads or writes anything, refuses on the sandbox, and deletes
 * each stored secret whose remove box is ticked while its field is blank.
 */
export async function savePaymentProviderCredentials(formData: FormData) {
  await assertAdmin();

  await savePaymentCredentials({
    stripe: {
      publishableKey: String(formData.get('stripe_publishableKey') ?? ''),
      secretKey: String(formData.get('stripe_secretKey') ?? ''),
      webhookSecret: String(formData.get('stripe_webhookSecret') ?? ''),
    },
    freemius: {
      developerId: String(formData.get('freemius_developerId') ?? ''),
      developerPublicKey: String(formData.get('freemius_developerPublicKey') ?? ''),
      developerSecretKey: String(formData.get('freemius_developerSecretKey') ?? ''),
      publicKey: String(formData.get('freemius_publicKey') ?? ''),
      productId: String(formData.get('freemius_productId') ?? ''),
      secretKey: String(formData.get('freemius_secretKey') ?? ''),
      apiKey: String(formData.get('freemius_apiKey') ?? ''),
    },
    remove: REMOVE_SECRET_BOXES.filter(([box]) => formData.get(box) === 'true').map(([, field]) => field),
  });

  // The storefront buy CTAs, the CMS payments banner and the publish warning all read
  // readiness. Without a layout-wide revalidate they keep showing "can't take payments"
  // after the admin has just pasted working keys.
  revalidatePath('/cms/payments');
  revalidatePath('/cms/dashboard');
  revalidatePath('/', 'layout');
}

export async function updatePaymentSettings(
  enabledProviders: EnabledPaymentProviders
) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('Unauthorized');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'ADMIN') {
    throw new Error('Forbidden');
  }

  const { error } = await supabase.from('site_settings').upsert({
    key: 'enabled_payment_providers',
    value: enabledProviders,
  });

  if (error) {
    console.error('Error updating payment providers:', error);
    throw new Error('Failed to update settings');
  }

  revalidatePath('/cms/payments');
  revalidatePath('/cms/taxes');
  revalidatePath('/', 'layout');

  return { success: true };
}
