import 'server-only';

// app/cms/users/[id]/edit/page.tsx
import Link from "next/link";
import UserForm from "../../components/UserForm";
import { updateUserProfile } from "../../actions";
import type { Database } from "@nextblock-cms/db";
import { notFound, unstable_rethrow } from "next/navigation";
import { getDefaultUserAddresses } from "@nextblock-cms/ecommerce/server";
import { requireCmsAdmin, type ServiceRoleClient } from "../../../../../lib/auth/cms-actor";

type Profile = Database['public']['Tables']['profiles']['Row'];
type AuthUser = {
    id: string;
    email: string | undefined;
    created_at: string | undefined;
    last_sign_in_at: string | undefined;
};

async function getUserAndProfileData(serviceSupabase: ServiceRoleClient, userId: string): Promise<{
  authUser: AuthUser;
  profile: Profile | null;
  addresses: Awaited<ReturnType<typeof getDefaultUserAddresses>>;
  isSoleAdmin: boolean;
} | null> {
  // The auth admin API and other accounts' profile rows need the service role; the page has
  // authorized the ADMIN with requireCmsAdmin() first.
  const { data: { user: authUserData }, error: authUserError } = await serviceSupabase.auth.admin.getUserById(userId);

  if (authUserError || !authUserData) {
    console.error("Error fetching auth user for edit:", authUserError);
    return null;
  }

  // Fetch profile from public.profiles using Service Role to bypass RLS
  const { data: profileData, error: profileError } = await serviceSupabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (profileError && profileError.code !== 'PGRST116') { // PGRST116: single row not found, which is okay if profile not created yet
    console.error("Error fetching profile for edit:", profileError);
    // Decide if this is a critical error. A user might exist in auth but not profiles if trigger failed.
  }

  const simplifiedAuthUser: AuthUser = {
      id: authUserData.id,
      email: authUserData.email,
      created_at: authUserData.created_at,
      last_sign_in_at: authUserData.last_sign_in_at,
  };

  const addresses = await getDefaultUserAddresses(userId, serviceSupabase as any);

  // Is this user the only remaining Admin? If so, the edit form locks the role selector
  // so the last admin can't demote themselves out of CMS access (the server action also
  // guards this — the lock just prevents hitting that error).
  let isSoleAdmin = false;
  if ((profileData as Profile | null)?.role === 'ADMIN') {
    const { count } = await serviceSupabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'ADMIN');
    isSoleAdmin = count === 1;
  }

  return {
    authUser: simplifiedAuthUser,
    profile: profileData as Profile | null,
    addresses,
    isSoleAdmin,
  };
}

export default async function EditUserPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userId = params.id;
  if (!userId) {
    return notFound();
  }

  let admin: Awaited<ReturnType<typeof requireCmsAdmin>>;
  try {
    admin = await requireCmsAdmin();
  } catch (error) {
    unstable_rethrow(error);
    return error instanceof Error && error.message === 'Unauthorized'
      ? <p>Access Denied. Not authenticated.</p>
      : <p>Access Denied. Admin privileges required.</p>;
  }

  const userData = await getUserAndProfileData(admin.supabase, userId);

  if (!userData || !userData.authUser) {
    return notFound(); // Or a more specific "User not found" component
  }

  const updateUserActionWithId = updateUserProfile.bind(null, userId);
  // `RTL` (Affiliates partner, migration 02029) is not in the generated enum type yet.
  const isPartner = String(userData.profile?.role ?? '') === 'RTL';

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Edit User: {userData.authUser.email}</h1>
      {isPartner && (
        <p className="mb-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          This account is an Affiliates partner. Its storefront, tier, commissions and payouts are
          managed in{' '}
          <Link
            href="/cms/affiliates"
            className="font-medium text-foreground underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            Affiliates
          </Link>
          ; pause the partner there to cut access while keeping their history.
        </p>
      )}
      <UserForm
        userToEditAuth={userData.authUser}
        userToEditProfile={userData.profile}
        userToEditAddresses={userData.addresses}
        formAction={updateUserActionWithId}
        lockRole={userData.isSoleAdmin}
      />
    </div>
  );
}
