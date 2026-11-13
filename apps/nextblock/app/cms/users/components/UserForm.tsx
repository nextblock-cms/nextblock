"use client";

import { CustomerProfileForm, ExtendedProfileUpdateData, addressesMatch, type CustomerAddressInput } from "@nextblock-cms/ecommerce";
import MediaPickerDialog from "../../media/components/MediaPickerDialog";
import type { Database } from "@nextblock-cms/db";
import { useSearchParams } from "next/navigation";
import { USERS_LOCKED_IN_SANDBOX, USERS_SANDBOX_NOTE_CLASS, USERS_SANDBOX_NOTE_ID } from "../sandbox-lock";


type Profile = Database['public']['Tables']['profiles']['Row'];

interface UserFormProps {
  userToEditAuth: { email: string | undefined; id: string };
  userToEditProfile: Profile | null;
  userToEditAddresses: {
    billingAddress: CustomerAddressInput | null;
    shippingAddress: CustomerAddressInput | null;
  };
  formAction: (formData: FormData) => Promise<{ error?: string } | void>;
  /** Lock the role selector — true when this user is the only remaining Admin. */
  lockRole?: boolean;
}

export default function UserForm({ userToEditAuth, userToEditProfile, userToEditAddresses, formAction, lockRole }: UserFormProps) {
  const searchParams = useSearchParams();
  const successMsg = searchParams.get('success');

  // The public sandbox shares every account with every visitor, so updateUserProfile refuses
  // there. Save lives inside CustomerProfileForm (libs/ecommerce), so on the sandbox the whole form
  // sits in a disabled fieldset described by the visible note: that disables Save and every field
  // natively. The role select is also locked with the same reason (Radix opens a select on
  // pointerdown, which a disabled fieldset does not stop). Read inline, as SandboxCredentialsAlert does.
  const sandboxLocked = process.env.NEXT_PUBLIC_IS_SANDBOX === "true";

  const handleAdminSave = async (data: ExtendedProfileUpdateData) => {
      const formData = new FormData();
      // Only append if defined to avoid null string issues if server doesn't handle them, 
      // but server action expects strings or checks presence.
      // Standard practice: append everything that has a value.
      if (data.full_name !== undefined) formData.append('full_name', data.full_name || '');
      if (data.avatar_url !== undefined) formData.append('avatar_url', data.avatar_url || '');
      if (data.website !== undefined) formData.append('website', data.website || '');
      if (data.phone !== undefined) formData.append('phone', data.phone || '');
      if (data.role !== undefined) formData.append('role', data.role);
      
      formData.append('billing_address', JSON.stringify(data.billing_address ?? null));
      formData.append('shipping_address', JSON.stringify(data.shipping_address ?? null));
      formData.append('use_billing_for_shipping', data.use_billing_for_shipping ? 'true' : 'false');

      return await formAction(formData);
  };

  const profileForm = (
      <CustomerProfileForm
          initialData={{
              full_name: userToEditProfile?.full_name || '',
              avatar_url: userToEditProfile?.avatar_url || '',
              website: userToEditProfile?.website || '',
              phone: userToEditProfile?.phone || '',
              role: userToEditProfile?.role || 'USER',
              billing_address: userToEditAddresses.billingAddress,
              shipping_address: userToEditAddresses.shippingAddress,
              use_billing_for_shipping:
                !userToEditAddresses.shippingAddress ||
                addressesMatch(
                  userToEditAddresses.billingAddress,
                  userToEditAddresses.shippingAddress
                ),
          }}
          MediaPickerComponent={MediaPickerDialog}
          isAdmin={true}
          email={userToEditAuth.email}
          onAction={handleAdminSave}
          initialSuccessMessage={successMsg}
          lockRole={sandboxLocked ? true : lockRole}
          {...(sandboxLocked ? { lockRoleReason: USERS_LOCKED_IN_SANDBOX } : {})}
      />
  );

  return (
    <div className="max-w-4xl mx-auto">
      {sandboxLocked ? (
        <>
          <p id={USERS_SANDBOX_NOTE_ID} className={USERS_SANDBOX_NOTE_CLASS}>
            {USERS_LOCKED_IN_SANDBOX}
          </p>
          <fieldset disabled aria-describedby={USERS_SANDBOX_NOTE_ID} className="m-0 min-w-0 border-0 p-0">
            {profileForm}
          </fieldset>
        </>
      ) : (
        profileForm
      )}
    </div>
  );
}
