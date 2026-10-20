// app/cms/users/actions.ts
"use server";

import { createClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@nextblock-cms/db";
import { normalizeCustomerAddress } from "@nextblock-cms/ecommerce";
import { upsertDefaultUserAddresses } from "@nextblock-cms/ecommerce/server";
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { resolveSupabaseServiceKey, resolveSupabaseUrl } from '../../../lib/setup/env-status';

type UserRole = Database['public']['Enums']['user_role'];

// Helper to check admin role using the server client
async function verifyAdmin(supabase: ReturnType<typeof createClient>): Promise<{ isAdmin: boolean; error?: string; userId?: string }> {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { isAdmin: false, error: "Authentication required." };
  }
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return { isAdmin: false, error: "Profile not found or error fetching profile." };
  }
  if (profile.role !== "ADMIN") {
    return { isAdmin: false, error: "Admin privileges required." };
  }
  return { isAdmin: true, userId: user.id };
}

type UpdateUserProfilePayload = {
  role: UserRole;
  full_name?: string | null;
  avatar_url?: string | null;
  website?: string | null;
  phone?: string | null;
};

function createServiceRoleClient() {
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRoleKey = resolveSupabaseServiceKey();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing required environment variables');
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function createUser(formData: FormData) {
  const supabase = createClient();
  const adminCheck = await verifyAdmin(supabase);
  if (!adminCheck.isAdmin) {
    return { error: adminCheck.error || "Unauthorized" };
  }

  const email = (formData.get("email") as string | null)?.trim().toLowerCase() || "";
  const password = (formData.get("password") as string | null) || "";
  const fullName = (formData.get("full_name") as string | null)?.trim() || "";
  const role = formData.get("role") as UserRole;
  // Admin-created accounts are confirmed by default so the user can sign in
  // immediately without an SMTP round-trip (mirrors completeSetup / auto-accept).
  const emailConfirm = formData.get("email_confirm") !== "false";

  if (!email) {
    return { error: "Email is required." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!password || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (!role || !['ADMIN', 'WRITER', 'USER'].includes(role)) {
    return { error: "Invalid role specified." };
  }

  const adminSupabase = createServiceRoleClient();

  const { data: created, error: createError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: emailConfirm,
    user_metadata: fullName ? { full_name: fullName } : {},
  });

  if (createError || !created?.user) {
    if (createError && /already|registered|exists/i.test(createError.message)) {
      return { error: "An account with this email already exists." };
    }
    return { error: `Failed to create user: ${createError?.message ?? 'unknown error'}` };
  }

  // The handle_new_user trigger inserts the profile row during createUser and assigns
  // role USER (an admin already exists, so this account is never the first user). Apply
  // the admin's chosen role and name explicitly afterward.
  const { error: profileError } = await adminSupabase
    .from("profiles")
    .update({ role, full_name: fullName || null })
    .eq("id", created.user.id);

  revalidatePath("/cms/users");

  if (profileError) {
    // The account was created (trigger seeded role USER), but applying the chosen role
    // failed. Land the admin on the edit screen — the recovery path — rather than
    // stranding them on the create form, where a retry would hit "email already exists".
    console.error("Error setting new user profile:", profileError);
    redirect(
      `/cms/users/${created.user.id}/edit?success=${encodeURIComponent(
        "User created, but their role wasn't applied automatically — set it below and save.",
      )}`,
    );
  }

  redirect(`/cms/users/${created.user.id}/edit?success=User created successfully`);
}

export async function updateUserProfile(userIdToUpdate: string, formData: FormData) {
  const supabase = createClient();
  const adminCheck = await verifyAdmin(supabase);
  if (!adminCheck.isAdmin) {
    return { error: adminCheck.error || "Unauthorized" };
  }

  const parseAddressField = (fieldName: string) => {
    const rawValue = formData.get(fieldName) as string | null;
    if (!rawValue) {
      return null;
    }

    try {
      return normalizeCustomerAddress(JSON.parse(rawValue));
    } catch {
      throw new Error(`Invalid JSON for ${fieldName}.`);
    }
  };

  let billingAddressJSON = null;
  let shippingAddressJSON = null;

  try {
    billingAddressJSON = parseAddressField("billing_address");
    shippingAddressJSON = parseAddressField("shipping_address");
  } catch (error: any) {
    return { error: error.message };
  }

  if (formData.get("use_billing_for_shipping") === "true") {
    shippingAddressJSON = billingAddressJSON;
  }

  const rawFormData = {
    role: formData.get("role") as UserRole,
    full_name: formData.get("full_name") as string || null,
    avatar_url: formData.get("avatar_url") as string || null,
    website: formData.get("website") as string || null,
    phone: formData.get("phone") as string || null,
  };

  if (!rawFormData.role) {
    return { error: "Role is a required field." };
  }
  if (!['ADMIN', 'WRITER', 'USER'].includes(rawFormData.role)) {
      return { error: "Invalid role specified." };
  }

  // Prevent an admin from accidentally removing their own admin role if they are the only admin
  // This is a basic check; a more robust system might count admins.
  if (userIdToUpdate === adminCheck.userId && rawFormData.role !== 'ADMIN') {
      // Counted with the service role: other accounts' rows sit behind is_admin_mfa() since
      // migration 02023, so through the cookie client an admin on an aal1 "remember this
      // device" session only sees their own row and would always read as the last admin.
      const { count } = await createServiceRoleClient()
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'ADMIN');
      if (count === 1) {
          return { error: "Cannot remove the last admin's role." };
      }
  }


  const profileData: UpdateUserProfilePayload = {
    role: rawFormData.role,
    full_name: rawFormData.full_name,
    avatar_url: rawFormData.avatar_url,
    website: rawFormData.website,
    phone: rawFormData.phone,
  };

  const adminSupabase = createServiceRoleClient();

  const { error } = await adminSupabase
    .from("profiles")
    .update(profileData)
    .eq("id", userIdToUpdate);

  if (error) {
    console.error("Error updating user profile:", error);
    return { error: `Failed to update profile: ${error.message}` };
  }

  await upsertDefaultUserAddresses({
    userId: userIdToUpdate,
    billingAddress: billingAddressJSON,
    shippingAddress: shippingAddressJSON,
    client: adminSupabase,
  });

  revalidatePath("/cms/users");
  revalidatePath(`/cms/users/${userIdToUpdate}/edit`);
  revalidatePath("/profile");
  revalidatePath("/checkout");
  redirect(`/cms/users/${userIdToUpdate}/edit?success=User profile updated successfully`);
}

export async function deleteUserAndProfile(userIdToDelete: string) {

  // For deleting a user, we need to use the Supabase Admin API,
  // which requires a client initialized with the SERVICE_ROLE_KEY.
  // This ensures the operation has the necessary privileges.
  // IMPORTANT: Ensure SUPABASE_SERVICE_ROLE_KEY is set in your .env.local and Vercel env vars.
  const supabaseAdmin = createClient(
    // Re-create client with service role. This is a common pattern.
    // Ensure your createClient function can be called without args to use env vars,
    // or pass them explicitly if needed. The one from the template should work.
    // If your createClient is specific to user context (cookies), you might need a separate
    // admin client factory. For now, assuming `createClient()` can make a service client
    // if called in a server action without user cookie context, or if it defaults to service key.
    // A safer way:
    // const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    // However, the template's createClient for server components/actions should handle this by not having cookie access.
    // Let's assume for now createClient() is sufficient if it can use service role.
    // A more explicit way for admin actions:
    // import { createClient as createAdminClient } from '@supabase/supabase-js';
    // const supabaseAdmin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  );


  const adminCheck = await verifyAdmin(supabaseAdmin); // Verify current user is admin
  if (!adminCheck.isAdmin) {
    return { error: adminCheck.error || "Unauthorized" };
  }

  if (userIdToDelete === adminCheck.userId) {
    return { error: "Admins cannot delete their own account through this panel." };
  }

  // Use the Supabase Auth Admin API to delete the user
  // This requires the `SERVICE_ROLE_KEY` to be configured for the Supabase client.
  // The standard `createClient` from `utils/supabase/server` might not use the service role by default.
  // You might need a dedicated admin client instance.
  // For this example, we'll assume `supabase.auth.admin.deleteUser` is available and configured.
  // If not, this part needs adjustment to use a service_role client.

  // The `createClient()` from `@supabase/ssr` for server context doesn't directly expose `auth.admin`.
  // We need to create a standard Supabase client with the service role key.
  const { createClient: createServiceRoleClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing required environment variables');
  }

  const serviceSupabase = createServiceRoleClient(supabaseUrl, serviceRoleKey);


  const { error: deletionError } = await serviceSupabase.auth.admin.deleteUser(userIdToDelete);

  if (deletionError) {
    console.error("Error deleting user:", deletionError);
    // If the profile was deleted by cascade but auth user deletion failed, this is an inconsistent state.
    return { error: `Failed to delete user: ${deletionError.message}` };
  }

  // The `profiles` table has ON DELETE CASCADE for the user ID, so it should be deleted automatically.
  revalidatePath("/cms/users");
  redirect("/cms/users?success=User deleted successfully");
}
