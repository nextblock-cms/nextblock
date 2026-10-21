import 'server-only';

// app/cms/users/[id]/edit/page.tsx
import UserForm from "../../components/UserForm";
import { updateUserProfile } from "../../actions";
import type { Database } from "@nextblock-cms/db";
import { notFound } from "next/navigation";
import { getDefaultUserAddresses } from "@nextblock-cms/ecommerce/server";

type Profile = Database['public']['Tables']['profiles']['Row'];
type AuthUser = {
    id: string;
    email: string | undefined;
    created_at: string | undefined;
    last_sign_in_at: string | undefined;
};

async function getUserAndProfileData(userId: string): Promise<{
  authUser: AuthUser;
  profile: Profile | null;
  addresses: Awaited<ReturnType<typeof getDefaultUserAddresses>>;
  isSoleAdmin: boolean;
} | null> {

  // Fetch user from auth.users
  // For admin operations, you might need a service_role client to fetch any user.
  // However, for just getting user details by ID, this might work if RLS allows admin to read.
  // A more robust way for admin panel is to use supabase.auth.admin.getUserById(userId)
  // This requires a client initialized with SERVICE_ROLE_KEY.

  // Let's use the admin API for fetching the auth user.
   const { createClient: createServiceRoleClient } = await import('@supabase/supabase-js');
   const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
   const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

   if (!supabaseUrl || !serviceRoleKey) {
     throw new Error('Missing required environment variables');
   }
   
   const serviceSupabase = createServiceRoleClient(supabaseUrl, serviceRoleKey);

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

  const userData = await getUserAndProfileData(userId);

  if (!userData || !userData.authUser) {
    return notFound(); // Or a more specific "User not found" component
  }

  const updateUserActionWithId = updateUserProfile.bind(null, userId);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Edit User: {userData.authUser.email}</h1>
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
