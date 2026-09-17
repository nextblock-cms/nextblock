'use server';
// Server actions backing the browser /setup wizard. Every mutating action is guarded
// by assertNotProvisioned() so setup can only run once (until a first admin exists).

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { isLocalWritableEnv } from './env-status';
import { writeEnvLocal } from './env-write';
import {
  assertNotProvisioned,
  getProvisioningStatus,
  type ProvisioningStatus,
} from './provisioning';
import { provisionFirstAdmin } from './provision-admin';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  restartRecommended?: boolean;
  schemaReady?: boolean;
}

export interface ConnectionInput {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  postgresUrl?: string;
  siteUrl?: string;
  /** Supabase personal access token — needed by `npm run db:migrate` to link + push. */
  accessToken?: string;
}

/**
 * Sanity-check a Supabase API key offline. Legacy keys are JWTs carrying { role, ref };
 * newer keys are opaque sb_secret_* / sb_publishable_* strings. We use this to reject an
 * anon key pasted into the service-role field (and vice-versa) BEFORE it gets written —
 * otherwise it only surfaces much later as "permission denied" on the first write, since
 * a SELECT probe can't tell the keys apart (anon can also read site_settings).
 */
function inspectSupabaseKey(key: string): {
  role?: string;
  ref?: string;
  format: 'jwt' | 'secret' | 'publishable' | 'unknown';
} {
  if (key.startsWith('sb_secret_')) return { role: 'service_role', format: 'secret' };
  if (key.startsWith('sb_publishable_')) return { role: 'anon', format: 'publishable' };
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return {
        role: typeof payload?.role === 'string' ? payload.role : undefined,
        ref: typeof payload?.ref === 'string' ? payload.ref : undefined,
        format: 'jwt',
      };
    } catch {
      // not a decodable JWT — fall through to 'unknown'
    }
  }
  return { format: 'unknown' };
}

/**
 * Step (Profile B / local only): validate the Supabase credentials, then persist them
 * to `.env.local` and the live process. Probes with the service-role key so we can
 * also report whether the schema has been applied yet.
 */
export async function saveSupabaseConnection(input: ConnectionInput): Promise<ActionResult> {
  await assertNotProvisioned();

  const supabaseUrl = input.supabaseUrl?.trim();
  const anonKey = input.anonKey?.trim();
  const serviceRoleKey = input.serviceRoleKey?.trim();

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return {
      ok: false,
      error: 'Supabase URL, anon key, and service-role key are all required.',
    };
  }
  try {
    new URL(supabaseUrl);
  } catch {
    return { ok: false, error: 'The Supabase URL is not a valid URL.' };
  }

  // The anon and service-role keys are easy to swap (both start with "eyJ"). Catch a
  // swapped or wrong-project key here, offline, with a clear message.
  const svcKey = inspectSupabaseKey(serviceRoleKey);
  if (svcKey.role && svcKey.role !== 'service_role') {
    return {
      ok: false,
      error: `That service-role key is actually the "${svcKey.role}" key. Paste the secret service_role key from Supabase → Project Settings → API.`,
    };
  }
  const anonKeyInfo = inspectSupabaseKey(anonKey);
  if (anonKeyInfo.role && anonKeyInfo.role !== 'anon') {
    return {
      ok: false,
      error: `That anon key is actually the "${anonKeyInfo.role}" key. Paste the public anon key from Supabase → Project Settings → API.`,
    };
  }
  let urlRef: string | undefined;
  try {
    const host = new URL(supabaseUrl).hostname;
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) {
      urlRef = host.split('.')[0];
    }
  } catch {
    // already validated above
  }
  if (urlRef && svcKey.ref && svcKey.ref !== urlRef) {
    return {
      ok: false,
      error: `That service-role key belongs to project "${svcKey.ref}", but the URL is project "${urlRef}". Use keys from the same project.`,
    };
  }

  if (!isLocalWritableEnv()) {
    return {
      ok: false,
      error:
        'This environment is read-only. Set the Supabase variables on your hosting platform instead of here.',
    };
  }

  // Validate the credentials with a service-role probe before writing anything.
  const probe = createSupabaseJsClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Definitive service-role check: only the service_role can call the GoTrue admin API.
  // A SELECT on site_settings can't tell service_role from anon (both can read it), so
  // this catches a rotated/invalid key that the offline inspection above can't. Works on
  // a fresh project too (the auth schema always exists, independent of the public schema).
  try {
    const { error: adminErr } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (adminErr) {
      return {
        ok: false,
        error: `That key can't perform admin actions (${adminErr.message}). Confirm you pasted the secret service_role key from Supabase → Project Settings → API.`,
      };
    }
  } catch (caught) {
    return {
      ok: false,
      error: `Could not verify the service-role key: ${
        caught instanceof Error ? caught.message : 'unknown error'
      }`,
    };
  }

  let schemaReady = false;
  try {
    const { error } = await probe.from('site_settings').select('key').limit(1);
    if (error) {
      const missing = /relation|does not exist|schema cache/i.test(error.message);
      if (!missing) {
        return {
          ok: false,
          error: `Could not reach Supabase with those credentials: ${error.message}`,
        };
      }
      schemaReady = false; // reachable, but the schema isn't applied yet
    } else {
      schemaReady = true;
    }
  } catch (caught) {
    return {
      ok: false,
      error: `Could not connect to Supabase: ${
        caught instanceof Error ? caught.message : 'unknown error'
      }`,
    };
  }

  const values: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    // Enable the build-time migration hook for this install (Milestone 4). On Vercel
    // VERCEL_ENV gates it instead; off-Vercel (local / Docker / standalone) production
    // builds read this flag. Only written to a local-writable .env (no-op on Vercel).
    NEXTBLOCK_BUILD_MIGRATE: '1',
  };
  if (input.siteUrl?.trim()) values.NEXT_PUBLIC_URL = input.siteUrl.trim();
  if (input.postgresUrl?.trim()) values.POSTGRES_URL = input.postgresUrl.trim();
  if (input.accessToken?.trim()) values.SUPABASE_ACCESS_TOKEN = input.accessToken.trim();

  // Derive the project ref from the URL (https://<ref>.supabase.co) so the CLI schema
  // step (`npm run db:migrate`) links + pushes to THIS project, not a stale one.
  try {
    const host = new URL(supabaseUrl).hostname;
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) {
      values.SUPABASE_PROJECT_ID = host.split('.')[0];
    }
  } catch {
    // already validated above; ignore
  }

  try {
    await writeEnvLocal(values);
  } catch (caught) {
    return {
      ok: false,
      error: `Could not write .env.local: ${
        caught instanceof Error ? caught.message : 'unknown error'
      }`,
    };
  }

  return {
    ok: true,
    schemaReady,
    restartRecommended: true,
    message: schemaReady
      ? 'Connection saved and verified.'
      : 'Connection saved. The database schema is not applied yet — run "npm run db:migrate", then re-check below.',
  };
}

/** Poll provisioning status (used by the wizard to advance past connection/schema). */
export async function recheckStatus(): Promise<ProvisioningStatus & { writable: boolean }> {
  const status = await getProvisioningStatus();
  return { ...status, writable: isLocalWritableEnv() };
}

export interface CompleteSetupInput {
  admin: { email: string; password: string; fullName: string };
  /** Local-only extra env (media storage) collected by the wizard. */
  envValues?: Record<string, string>;
  /** "Start from a clean database" — wipe before installing (local dev only, server-gated). */
  resetFirst?: boolean;
}

/**
 * Final step: persist remaining settings and create the first admin. The schema,
 * settings and account work lives in `provisionFirstAdmin` (./provision-admin.ts) so the
 * headless bootstrap route (`POST /api/setup/bootstrap`) runs exactly the same steps.
 */
export async function completeSetup(input: CompleteSetupInput): Promise<ActionResult> {
  // "Start from a clean database" (local dev only) deliberately re-installs over an
  // existing DB — it wipes everything first. Two reliable guards: provisionFirstAdmin's
  // one-shot check means a reset only ever runs when no admin exists (a live site is
  // immune), and isLocalWritableEnv() restricts it to local dev (a deployed app can
  // never be tricked into wiping itself, even by a crafted request).
  const willReset = input.resetFirst === true && isLocalWritableEnv();

  const email = input.admin?.email?.trim().toLowerCase();
  const password = input.admin?.password ?? '';
  const fullName = input.admin?.fullName?.trim() ?? '';

  if (!email || !password) {
    return { ok: false, error: 'Administrator email and password are required.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Use an administrator password of at least 8 characters.' };
  }

  // 1) Persist any local env extras (media storage) for Profile B.
  if (
    input.envValues &&
    Object.keys(input.envValues).length > 0 &&
    isLocalWritableEnv()
  ) {
    try {
      await writeEnvLocal(input.envValues);
    } catch (caught) {
      return {
        ok: false,
        error: `Could not write .env.local: ${
          caught instanceof Error ? caught.message : 'unknown error'
        }`,
      };
    }
  }

  // 2) Schema, settings, and the admin account itself.
  const result = await provisionFirstAdmin({ email, fullName, password, resetFirst: willReset });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // The wizard establishes the session afterwards via the canonical signInAction (a more
  // reliable cookie path than signing in here), so we just report success.
  return { ok: true, message: result.message };
}
