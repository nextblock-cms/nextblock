import { createClient } from "@nextblock-cms/db/server";
import { redirect } from "next/navigation";
import { CustomerProfileForm } from "@nextblock-cms/ecommerce/components/CustomerProfileForm";
import { addressesMatch } from "@nextblock-cms/ecommerce/customer";
import { getDefaultUserAddresses } from "@nextblock-cms/ecommerce/customer-addresses";
import MediaPickerDialog from "../cms/media/components/MediaPickerDialog";
import { ProfilePageHeader } from "./ProfilePageHeader";
import { ProfilePageMissingState } from "./ProfilePageMissingState";
import { profileAccountLinks } from "./account-links";

export default async function ProfilePage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/sign-in");
  }

  const [{ data: profile }, { billingAddress, shippingAddress }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    getDefaultUserAddresses(user.id, supabase),
  ]);

  if (!profile) {
    return <ProfilePageMissingState />;
  }

  return (
    <div className="w-full max-w-6xl mx-auto py-12 px-4 md:px-6">
      <ProfilePageHeader />
      
      <CustomerProfileForm 
        initialData={{
            full_name: profile.full_name || '',
            avatar_url: profile.avatar_url || '',
            website: profile.website || '',
            phone: profile.phone || '',
            billing_address: billingAddress,
            shipping_address: shippingAddress,
            use_billing_for_shipping: !shippingAddress || addressesMatch(billingAddress, shippingAddress),
        }} 
        MediaPickerComponent={MediaPickerDialog}
        email={user.email}
        accountLinks={profileAccountLinks}
      />
    </div>
  );
}
