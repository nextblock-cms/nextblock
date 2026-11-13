// app/cms/users/actions.ts
"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSandboxEnvironment } from "@nextblock-cms/db/server";
import { normalizeCustomerAddress } from "@nextblock-cms/ecommerce";
import { upsertDefaultUserAddresses } from "@nextblock-cms/ecommerce/server";
import { revokeCortexAiMcpTokensForUser } from "@nextblock-cms/cortex";
import { requireCmsAdmin, type ServiceRoleClient } from "../../../lib/auth/cms-actor";
import { checkAffiliateUserDeletion } from "../../../lib/affiliates/affiliate-deletion-guard";
import { evictAffiliateStorefrontCache, evictAffiliateTiersCache } from "../../../lib/affiliates/cache";
import { z } from "../../../lib/zod-config";
import { USERS_LOCKED_IN_SANDBOX } from "./sandbox-lock";

/**
 * User management (ADMIN only). Every export is a public POST endpoint, so each one authorizes
 * itself first with `requireCmsAdmin()`: a session, the ADMIN role read from the caller's own
 * profile row, and an enrolled second factor satisfied (the old local `verifyAdmin` skipped the
 * factor, so a stolen password alone reached the service role here). Reads and writes then use
 * the service-role client that helper returns.
 *
 * The public sandbox (2026-11-03): its admin login is published, so every visitor is the admin and
 * shares every account. A visitor could create live accounts with any role, demote the demo partner
 * (locking everyone out of the portal), demote the demo admin, or delete the fixed-id demo users,
 * which the 15-minute reset cannot bring back. So every write action here refuses there with
 * `USERS_LOCKED_IN_SANDBOX`, right after the admin check (a non-admin still gets the admin
 * refusal) and before any parsing, read, MCP token revoke or auth admin call. Reads stay open.
 *
 * Roles: `RTL` is the partner role of the Affiliates package (migration 02029). The generated
 * `user_role` type predates it, so a role is validated as a string here and written through an
 * untyped view of the client (ADDENDUM C10).
 *
 * Failures return `{ ok: false, error }` with a message written for the admin; database and auth
 * errors are logged, never echoed. Success redirects to the edit screen, as before.
 */

type ActionFailure = { ok: false; error: string };

const MANAGED_ROLES = ["ADMIN", "WRITER", "USER", "RTL"] as const;
type ManagedRole = (typeof MANAGED_ROLES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userIdSchema = z.string().max(64).regex(UUID_PATTERN);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_ROLE = "Invalid role specified.";
const PARTNER_LEDGER_MESSAGE =
  "This user is a partner with commission or payout history, so deleting the account would erase that ledger. Pause the partner in Affiliates instead.";

/** Absent, or a string of at most `max` characters; anything else (a File) fails validation. */
const formText = (label: string, max: number) =>
  z
    .string({ error: `${label} must be text.` })
    .max(max, `${label} must be at most ${max} characters.`)
    .optional();

const createUserSchema = z.object({
  email: z
    .string({ error: "Email is required." })
    .trim()
    .toLowerCase()
    .min(1, "Email is required.")
    .max(254, "Enter a valid email address.")
    .regex(EMAIL_PATTERN, "Enter a valid email address."),
  password: z
    .string({ error: "Password must be at least 8 characters." })
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password must be at most 72 characters."),
  full_name: z.string().trim().max(200, "Full name must be at most 200 characters.").optional(),
  role: z.enum(MANAGED_ROLES, { error: INVALID_ROLE }),
  email_confirm: z.enum(["true", "false"]).optional(),
});

const updateProfileSchema = z.object({
  role: z.enum(MANAGED_ROLES, { error: INVALID_ROLE }),
  full_name: formText("Full name", 200),
  avatar_url: formText("Avatar URL", 2048),
  website: formText("Website", 2048),
  phone: formText("Phone", 64),
  billing_address: formText("Billing address", 10_000),
  shipping_address: formText("Shipping address", 10_000),
  use_billing_for_shipping: formText("Shipping preference", 5),
});

function fail(error: string): ActionFailure {
  return { ok: false, error };
}

function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message || fallback;
}

/** The raw form entry, `undefined` when absent; the schema refuses anything but a string. */
function formValue(formData: FormData, name: string): unknown {
  const value = formData.get(name);
  return value === null ? undefined : value;
}

function blankToNull(value: string | undefined): string | null {
  return value ? value : null;
}

/**
 * The ADMIN's service-role client, or the refusal to return. `requireCmsAdmin()` throws
 * `Unauthorized` (no session, or a second factor still owed) or `Forbidden` (any other role).
 */
async function authorizeAdmin(): Promise<
  { ok: true; supabase: ServiceRoleClient; userId: string } | ActionFailure
> {
  try {
    const { supabase, userId } = await requireCmsAdmin();
    return { ok: true, supabase, userId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return fail(message === "Unauthorized" ? "Authentication required." : "Admin privileges required.");
  }
}

/** The generated Database type lacks the RTL role value; writes that may carry it go untyped. */
function untyped(client: ServiceRoleClient): SupabaseClient<any> {
  return client as unknown as SupabaseClient<any>;
}

function describeCreateUserError(error: { code?: string; message?: string; status?: number }): string {
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  if (code === "email_exists" || code === "user_already_exists" || /already|registered|exists/i.test(message)) {
    return "An account with this email already exists.";
  }
  if (code === "weak_password") {
    return "That password does not meet this project's password policy. Choose a longer or more varied one.";
  }
  if (code === "email_address_invalid") {
    return "Enter a valid email address.";
  }
  return "Failed to create the user. Check the server logs for details.";
}

export async function createUser(formData: FormData): Promise<ActionFailure> {
  const auth = await authorizeAdmin();
  if (!auth.ok) {
    return auth;
  }
  if (isSandboxEnvironment()) {
    return fail(USERS_LOCKED_IN_SANDBOX);
  }

  const parsed = createUserSchema.safeParse({
    email: formValue(formData, "email") ?? "",
    password: formValue(formData, "password") ?? "",
    full_name: formValue(formData, "full_name"),
    role: formValue(formData, "role"),
    email_confirm: formValue(formData, "email_confirm"),
  });
  if (!parsed.success) {
    return fail(firstIssue(parsed.error, "Check the form and try again."));
  }

  const { email, password, role } = parsed.data;
  const fullName = parsed.data.full_name ?? "";
  // Admin-created accounts are confirmed by default so the user can sign in
  // immediately without an SMTP round-trip (mirrors completeSetup / auto-accept).
  const emailConfirm = parsed.data.email_confirm !== "false";
  const adminSupabase = auth.supabase;

  const { data: created, error: createError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: emailConfirm,
    user_metadata: fullName ? { full_name: fullName } : {},
  });

  if (createError || !created?.user) {
    if (createError) {
      console.error("Error creating user:", createError);
    }
    return fail(createError ? describeCreateUserError(createError) : "Failed to create the user. Check the server logs for details.");
  }

  // The handle_new_user trigger inserts the profile row during createUser and assigns
  // role USER (an admin already exists, so this account is never the first user). Apply
  // the admin's chosen role and name explicitly afterward.
  const { error: profileError } = await untyped(adminSupabase)
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

export async function updateUserProfile(userIdToUpdate: string, formData: FormData): Promise<ActionFailure> {
  const auth = await authorizeAdmin();
  if (!auth.ok) {
    return auth;
  }
  if (isSandboxEnvironment()) {
    return fail(USERS_LOCKED_IN_SANDBOX);
  }

  const target = userIdSchema.safeParse(userIdToUpdate);
  if (!target.success) {
    return fail("Unknown user.");
  }
  const targetUserId = target.data;

  const parsed = updateProfileSchema.safeParse({
    role: formValue(formData, "role"),
    full_name: formValue(formData, "full_name"),
    avatar_url: formValue(formData, "avatar_url"),
    website: formValue(formData, "website"),
    phone: formValue(formData, "phone"),
    billing_address: formValue(formData, "billing_address"),
    shipping_address: formValue(formData, "shipping_address"),
    use_billing_for_shipping: formValue(formData, "use_billing_for_shipping"),
  });
  if (!parsed.success) {
    const roleIssue = parsed.error.issues.some((issue) => issue.path[0] === "role");
    if (roleIssue) {
      return fail(formValue(formData, "role") ? INVALID_ROLE : "Role is a required field.");
    }
    return fail(firstIssue(parsed.error, "Check the form and try again."));
  }
  const input = parsed.data;
  const role: ManagedRole = input.role;

  const parseAddressField = (rawValue: string | undefined, fieldName: string) => {
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
    billingAddressJSON = parseAddressField(input.billing_address, "billing_address");
    shippingAddressJSON = parseAddressField(input.shipping_address, "shipping_address");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid address.");
  }

  if (input.use_billing_for_shipping === "true") {
    shippingAddressJSON = billingAddressJSON;
  }

  const adminSupabase = auth.supabase;

  // Prevent an admin from accidentally removing their own admin role if they are the only admin
  // This is a basic check; a more robust system might count admins.
  if (targetUserId === auth.userId && role !== "ADMIN") {
    // Counted with the service role: other accounts' rows sit behind is_admin_mfa() since
    // migration 02023, so through the cookie client an admin on an aal1 "remember this
    // device" session only sees their own row and would always read as the last admin.
    const { count } = await adminSupabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "ADMIN");
    if (count === 1) {
      return fail("Cannot remove the last admin's role.");
    }
  }

  const profileData = {
    role,
    full_name: blankToNull(input.full_name),
    avatar_url: blankToNull(input.avatar_url),
    website: blankToNull(input.website),
    phone: blankToNull(input.phone),
  };

  // An MCP token acts as the admin who minted it. /api/mcp re-checks that role on every
  // request; revoking on any role change as well shows the tokens as revoked and keeps
  // them dead if the account is promoted again. Revoke first, so a failure changes nothing.
  const { data: currentProfile, error: currentProfileError } = await adminSupabase
    .from("profiles")
    .select("role")
    .eq("id", targetUserId)
    .maybeSingle();

  if (currentProfileError) {
    console.error("Error reading the current role:", currentProfileError);
    return fail("Failed to read the user's current role. Try again.");
  }

  if (currentProfile && String(currentProfile.role) !== role) {
    const revoked = await revokeCortexAiMcpTokensForUser(adminSupabase, targetUserId);
    if (revoked.error) {
      console.error("Error revoking MCP tokens on a role change:", revoked.error);
      return fail("Role not changed: the user's MCP tokens could not be revoked. Try again.");
    }
  }

  const { error } = await untyped(adminSupabase)
    .from("profiles")
    .update(profileData)
    .eq("id", targetUserId);

  if (error) {
    console.error("Error updating user profile:", error);
    return fail("Failed to update the profile. Check the server logs for details.");
  }

  await upsertDefaultUserAddresses({
    userId: targetUserId,
    billingAddress: billingAddressJSON,
    shippingAddress: shippingAddressJSON,
    client: adminSupabase,
  });

  revalidatePath("/cms/users");
  revalidatePath(`/cms/users/${targetUserId}/edit`);
  revalidatePath("/profile");
  revalidatePath("/checkout");
  redirect(`/cms/users/${targetUserId}/edit?success=User profile updated successfully`);
}

export async function deleteUserAndProfile(userIdToDelete: string): Promise<ActionFailure> {
  const auth = await authorizeAdmin();
  if (!auth.ok) {
    return auth;
  }
  if (isSandboxEnvironment()) {
    return fail(USERS_LOCKED_IN_SANDBOX);
  }

  const target = userIdSchema.safeParse(userIdToDelete);
  if (!target.success) {
    return fail("Unknown user.");
  }
  const targetUserId = target.data;

  if (targetUserId === auth.userId) {
    return fail("Admins cannot delete their own account through this panel.");
  }

  const serviceSupabase = auth.supabase;

  // A partner's commissions and payouts cascade from the account (ADDENDUM A24): refuse before
  // anything changes, so the ledger survives and the admin pauses the partner instead.
  const ledger = await checkAffiliateUserDeletion(untyped(serviceSupabase), targetUserId);
  if (ledger.kind === "blocked") {
    return fail(PARTNER_LEDGER_MESSAGE);
  }
  if (ledger.kind === "unavailable") {
    return fail("Could not check this user's partner records, so the account was not deleted. Try again.");
  }

  // Revoke before deleting: `mcp_access_tokens.created_by` is ON DELETE SET NULL, so once
  // the account is gone its tokens can no longer be found by owner.
  const revoked = await revokeCortexAiMcpTokensForUser(serviceSupabase, targetUserId);
  if (revoked.error) {
    console.error("Error revoking MCP tokens before a delete:", revoked.error);
    return fail("User not deleted: their MCP tokens could not be revoked. Try again.");
  }

  const { error: deletionError } = await serviceSupabase.auth.admin.deleteUser(targetUserId);

  if (deletionError) {
    console.error("Error deleting user:", deletionError);
    return fail("Failed to delete the user. Check the server logs for details.");
  }

  // A partner's profile and storefront cascade away with the account: evict the public storefront
  // reads, the sitemap and the tier list (member count, founding spots), as a suspension does,
  // or /partners/<handle> keeps serving the deleted storefront until the entries expire.
  if (ledger.handle) {
    evictAffiliateStorefrontCache(ledger.handle, "action");
    evictAffiliateTiersCache("action");
  }

  // The `profiles` table has ON DELETE CASCADE for the user ID, so it is deleted automatically.
  revalidatePath("/cms/users");
  redirect("/cms/users?success=User deleted successfully");
}
