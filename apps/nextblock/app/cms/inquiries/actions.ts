'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';

import { requireCmsAdmin } from '../../../lib/auth/cms-actor';
import { STORE_CONTACT_SETTINGS_KEY } from '../../../lib/commerce/seller-contact';

export interface InquiryActionState {
  success: boolean;
  message: string;
}

/**
 * Set where storefront enquiries are emailed. Stored in site_settings — it is a business
 * address, not a credential — but never rendered to the storefront: the public form posts a
 * product id and the server resolves the recipient.
 *
 * Written with the service-role client after requireCmsAdmin(): `store_contact` is above the
 * staff read tier, so the cookie client's upsert (INSERT ... ON CONFLICT DO UPDATE checks the
 * read policy on the existing row) failed for an admin on an aal1 session, and since migration
 * 02028 the key's write tier needs public.is_admin_mfa() as well. A redirected address would
 * receive every future enquiry, so the in-code ADMIN check (second factor included) is the
 * boundary.
 */
export async function saveStoreContactEmail(
  _prevState: unknown,
  formData: FormData
): Promise<InquiryActionState> {
  try {
    const { supabase } = await requireCmsAdmin();

    const contactEmail = String(formData.get('contact_email') ?? '').trim();
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return { success: false, message: "That doesn't look like a valid email address." };
    }

    const { error } = await supabase
      .from('site_settings')
      .upsert({ key: STORE_CONTACT_SETTINGS_KEY, value: { contactEmail } });

    if (error) {
      console.error('Error saving store contact email:', error.message);
      return { success: false, message: 'Could not save the contact address.' };
    }

    revalidatePath('/cms/inquiries');
    return {
      success: true,
      message: contactEmail
        ? 'Enquiries will now be sent to that address.'
        : 'Cleared — enquiries will fall back to your invoice or support address.',
    };
  } catch (error) {
    console.error('saveStoreContactEmail failed:', error);
    return { success: false, message: 'You do not have permission to change this.' };
  }
}
