import 'server-only';
// The first-admin provisioning core shared by the browser /setup wizard (`completeSetup`
// in ./actions.ts) and the headless bootstrap route (`POST /api/setup/bootstrap`). It is
// everything `completeSetup` did after the optional `.env.local` write: schema, settings,
// admin account, and the concurrent-setup race guard. Kept out of the 'use server'
// module so a route handler can call it without going through the server-action wire
// format.

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { assertNotProvisioned, getProvisioningStatus } from './provisioning';
import { applyMigrations, resetDatabase } from './schema-apply';
import { setSystemConfigurationServiceRole } from './system-config';
import { getStorageBackend } from '../storage/provider';
import { ensureStorageBucket } from '../storage/supabase-storage';

export interface ProvisionFirstAdminInput {
  email: string;
  fullName: string;
  password: string;
  /**
   * "Start from a clean database": wipe before installing. The caller has already
   * gated this on `isLocalWritableEnv()`; it is never honoured on a deployed app.
   */
  resetFirst?: boolean;
}

export type ProvisionFirstAdminFailure =
  | 'already_provisioned'
  | 'create_failed'
  | 'email_exists'
  | 'invalid_input'
  | 'race_lost'
  | 'reset_failed'
  | 'schema_failed'
  | 'service_role_missing'
  | 'settings_failed';

export type ProvisionFirstAdminResult =
  | { code: ProvisionFirstAdminFailure; error: string; ok: false }
  | { email: string; message: string; ok: true; userId: string };

/**
 * After a fresh migration, PostgREST may briefly not see the new tables (its schema
 * cache). applyMigrations issues a reload, but it's async — poll until a known new
 * table reads cleanly so the REST reads/writes below don't hit a false "table not
 * found". Best-effort: gives up after ~6s and lets the caller proceed.
 */
async function waitForSchemaCache(
  supabase: ReturnType<typeof getServiceRoleSupabaseClient>,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { error } = await supabase.from('system_configuration').select('id').limit(1);
    if (!error) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Create the first administrator. The handle_new_user trigger assigns the ADMIN role
 * and flips is_admin_created, so we never set the role ourselves. `email_confirm: true`
 * means no SMTP round-trip is required, which keeps every channel (including
 * cloud-without-SMTP and headless Docker) unblocked.
 */
export async function provisionFirstAdmin(
  input: ProvisionFirstAdminInput,
): Promise<ProvisionFirstAdminResult> {
  const willReset = input.resetFirst === true;

  // A reset deliberately re-installs over an existing DB, so the one-shot guard is
  // skipped in that case. Otherwise a provisioned instance can't be re-setup.
  if (!willReset) {
    try {
      await assertNotProvisioned();
    } catch {
      return {
        code: 'already_provisioned',
        error:
          'Setup has already been completed. Enable "Start from a clean database" to reinstall, or sign in instead.',
        ok: false,
      };
    }
  }

  const email = input.email?.trim().toLowerCase();
  const password = input.password ?? '';
  const fullName = input.fullName?.trim() ?? '';

  if (!email || !password) {
    return { code: 'invalid_input', error: 'Administrator email and password are required.', ok: false };
  }
  if (password.length < 8) {
    return {
      code: 'invalid_input',
      error: 'Use an administrator password of at least 8 characters.',
      ok: false,
    };
  }

  // 1) Service-role access is required from here on.
  let admin: ReturnType<typeof getServiceRoleSupabaseClient>;
  try {
    admin = getServiceRoleSupabaseClient();
  } catch {
    return {
      code: 'service_role_missing',
      error:
        'The service-role key is not loaded yet. Restart the dev server after saving the connection, then retry.',
      ok: false,
    };
  }

  // 1.5) "Start from a clean database": wipe the DB (public schema + migration history
  //      + auth users) before installing, so each fresh setup starts clean.
  if (willReset) {
    const reset = await resetDatabase();
    if (!reset.ok) {
      return { code: 'reset_failed', error: `Could not reset the database: ${reset.error}`, ok: false };
    }
    // Clear auth users via the admin API (reliable — SQL on the auth schema can be
    // permission-restricted), so the admin email is free to reuse on this fresh install.
    try {
      const { data: list } = await admin.auth.admin.listUsers();
      for (const existing of list?.users ?? []) {
        await admin.auth.admin.deleteUser(existing.id);
      }
    } catch {
      // Non-fatal — the createUser "already exists" fallback below also handles leftovers.
    }
  }

  // 2) Apply the database schema if it isn't there yet (e.g. a fresh Supabase project).
  //    Idempotent (tracks applied migrations), so it's a no-op when the schema already
  //    exists (Docker, or a re-run).
  const schemaStatus = await getProvisioningStatus();
  if (!schemaStatus.schemaReady) {
    const schema = await applyMigrations();
    if (!schema.ok) {
      return {
        code: 'schema_failed',
        error: `Could not apply the database schema: ${schema.error}`,
        ok: false,
      };
    }
  }

  // Ensure PostgREST has the schema cached before ANY REST read/write below — covers a
  // fresh apply AND a cold cache over a pre-existing schema (Docker boot race / re-run).
  await waitForSchemaCache(admin);

  // On the native Supabase Storage backend (zero-key Vercel deploy), provision the public
  // media bucket now so the first upload doesn't have to. Best-effort — the upload path
  // also ensures it lazily, so a transient failure here never blocks finishing setup.
  if (getStorageBackend() === 'supabase') {
    try {
      await ensureStorageBucket();
    } catch (caught) {
      console.warn(
        'Could not pre-create the Supabase Storage media bucket (will retry on first upload):',
        caught instanceof Error ? caught.message : caught,
      );
    }
  }

  // 3) Persist DB-backed settings (service role bypasses RLS — no admin exists yet).
  //    New sign-ups default to requiring email verification as a safe default.
  try {
    await setSystemConfigurationServiceRole({ auto_accept_signups: false });
  } catch (caught) {
    return {
      code: 'settings_failed',
      error: `Failed to save settings: ${caught instanceof Error ? caught.message : 'unknown error'}`,
      ok: false,
    };
  }

  // 4) Create the first admin account (already confirmed).
  const createPayload = {
    email,
    email_confirm: true,
    password,
    user_metadata: { full_name: fullName },
  };
  let { data: created, error: createError } = await admin.auth.admin.createUser(createPayload);

  // If a clean-install reset left a stale auth user (admin-API cleanup above hit an edge
  // case), remove it and retry once so the operator can reuse their email.
  if (createError && willReset && /already|registered|exists/i.test(createError.message)) {
    try {
      const { data: list } = await admin.auth.admin.listUsers();
      const stale = list?.users?.find((u) => u.email?.toLowerCase() === email);
      if (stale) {
        await admin.auth.admin.deleteUser(stale.id);
        ({ data: created, error: createError } = await admin.auth.admin.createUser(createPayload));
      }
    } catch {
      // fall through to the error handling below
    }
  }

  if (createError || !created?.user) {
    if (createError && /already|registered|exists/i.test(createError.message)) {
      return {
        code: 'email_exists',
        error:
          'An account with this email already exists. Enable "Start from a clean database", or use a different email.',
        ok: false,
      };
    }
    return {
      code: 'create_failed',
      error: `Could not create the administrator account: ${createError?.message ?? 'unknown error'}`,
      ok: false,
    };
  }

  // Guard against a concurrent-setup race: assertNotProvisioned() is a check-then-act,
  // so two simultaneous submissions could both pass it. The trigger still grants ADMIN
  // to only the first user — so if this account came back as anything other than ADMIN,
  // another session won the race. Undo this spurious account and report it, rather than
  // signing the operator in as a non-admin.
  const { data: createdProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', created.user.id)
    .maybeSingle();
  if (createdProfile?.role !== 'ADMIN') {
    await admin.auth.admin.deleteUser(created.user.id).catch((err) => {
      console.warn('Failed to clean up stale admin user after race condition:', err);
    });
    return {
      code: 'race_lost',
      error: 'Setup was just completed by another session. Please sign in instead.',
      ok: false,
    };
  }

  return { email, message: 'Setup complete.', ok: true, userId: created.user.id };
}
