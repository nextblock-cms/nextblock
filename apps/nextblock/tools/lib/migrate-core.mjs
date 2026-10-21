// Shared, dependency-light migration engine.
//
// Consumers:
//   * tools/build-migrate.mjs — the gated `prebuild` hook (Vercel production /
//     NEXTBLOCK_BUILD_MIGRATE=1). It must NEVER fail a build, so it imports this
//     module dynamically inside a try/catch.
//   * tools/update.mjs        — the explicit `npm run update` command, which applies
//     migrations on purpose and reports what it did.
//
// Behaviourally in lockstep with apps/nextblock/lib/setup/schema-apply.ts (the /setup
// wizard's applier): same tracking table, same one-transaction-per-file contract, same
// two backends. This file is plain ESM with no app/server-only imports so it loads in
// any build or CLI context.
//
// The one deliberate difference from schema-apply.ts is collectMigrations(): it UNIONS
// every place migrations can live rather than picking the first hit. That is what keeps
// a standalone (`npm create nextblock`) project honest — see the comment there.

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const MIGRATION_FILE_RE = /^\d+_.*\.sql$/;

/* ------------------------------------------------------------------ env --- */

/** Best-effort .env.local / .env load. dotenv is a dependency; tolerate its absence. */
export async function loadEnvFiles(cwd = process.cwd()) {
  try {
    const dotenv = await import('dotenv');
    for (const file of ['.env.local', '.env']) {
      const p = path.join(cwd, file);
      if (existsSync(p)) dotenv.config({ path: p, override: false, quiet: true });
    }
  } catch {
    /* dotenv unavailable — env may already be injected by the platform */
  }
}

/**
 * Supabase URL through the full alias chain (see docs/12): the hosted Vercel Supabase
 * Marketplace integration injects SUPABASE_URL, the classic integration injects
 * NEXT_PUBLIC_SUPABASE_URL. Accept both, plus the self-hosted API URL.
 */
export function resolveSupabaseUrl() {
  return (
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    process.env['SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_API_URL'] ||
    ''
  ).trim();
}

/** Supabase project ref, from an explicit id or parsed out of a *.supabase.co URL. */
export function resolveProjectRef() {
  const fromId = process.env['SUPABASE_PROJECT_ID']?.trim();
  if (fromId) return fromId;
  try {
    const host = new URL(resolveSupabaseUrl()).hostname;
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return host.split('.')[0];
  } catch {
    /* not a cloud URL */
  }
  return null;
}

/** Direct Postgres connection string, if one is configured. */
export function resolveDbUrl() {
  return (process.env['POSTGRES_URL'] || process.env['DATABASE_URL'] || '').trim() || null;
}

/**
 * TLS setting for a direct Postgres connection.
 *
 * Supabase and every other managed host require TLS, but a self-hosted Postgres on
 * localhost or a Docker service name typically speaks no TLS at all — and the `postgres`
 * driver's `ssl: 'require'` is a hard failure there, not a downgrade. Pick per host, and
 * always defer to an explicit sslmode/ssl in the connection string.
 */
function resolveSslOption(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return 'require'; // unparseable — keep the safe default
  }
  if (url.searchParams.has('sslmode') || url.searchParams.has('ssl')) return undefined;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    !host.includes('.'); // a bare docker-compose service name, e.g. "db"

  // 'prefer' negotiates TLS when offered and falls back to plaintext when it is not.
  return isLoopback || isPrivate ? 'prefer' : 'require';
}

/** Open a driver connection with host-appropriate TLS. */
async function openPostgres(dbUrl) {
  const { default: postgres } = await import('postgres');
  const ssl = resolveSslOption(dbUrl);
  return postgres(dbUrl, {
    ...(ssl === undefined ? {} : { ssl }),
    onnotice: () => undefined,
    max: 1,
  });
}

/** Describe which backend applyMigrations() would use, without connecting. */
export function describeBackend() {
  const ref = resolveProjectRef();
  const token = process.env['SUPABASE_ACCESS_TOKEN']?.trim();
  if (ref && token) return { kind: 'management-api', detail: `Supabase project ${ref}` };
  const dbUrl = resolveDbUrl();
  if (dbUrl) {
    let host = 'the database';
    try {
      host = new URL(dbUrl).host;
    } catch {
      /* unparseable — keep the generic label rather than leaking the string */
    }
    return { kind: 'postgres', detail: host };
  }
  return { kind: 'none', detail: 'no POSTGRES_URL and no SUPABASE_ACCESS_TOKEN' };
}

/* ------------------------------------------------------- discovering SQL --- */

/**
 * Walk up from `startDir` calling `predicate(dir)`. A truthy return is the result; `false`
 * is an explicit "stop here, no result" boundary; `null`/`undefined` continues upward.
 */
function walkUpFor(startDir, predicate, maxDepth = 8) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const hit = predicate(dir);
    if (hit) return hit;
    if (hit === false) return null;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The monorepo's canonical migrations dir, found via the nearest nx.json ancestor. */
function monorepoMigrationsDir(cwd) {
  return walkUpFor(cwd, (dir) => {
    if (!existsSync(path.join(dir, 'nx.json'))) return null;
    const candidate = path.join(dir, 'libs', 'db', 'src', 'supabase', 'migrations');
    return existsSync(candidate) ? candidate : null;
  });
}

/**
 * A standalone project's materialized dir: <projectRoot>/supabase/migrations.
 *
 * The walk stops at the project root — the nearest ancestor holding a package.json — so a
 * NextBlock checkout nested inside an unrelated Supabase CLI project (e.g.
 * ~/work/mysite/nextblock under a ~/work/mysite that has its own supabase/migrations)
 * cannot pick up that project's SQL and apply it to this one's database.
 */
function projectMigrationsDir(cwd) {
  return walkUpFor(cwd, (dir) => {
    const candidate = path.join(dir, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    // Reached the project root without a hit — do not escape into the parent tree.
    return existsSync(path.join(dir, 'package.json')) ? false : null;
  });
}

/**
 * The migrations shipped inside the installed @nextblock-cms/db package.
 *
 * This is the copy that `npm install @nextblock-cms/db@newer` refreshes. A standalone
 * project's <project>/supabase/migrations is materialized ONCE, at scaffold time, and
 * nothing ever refreshed it — so before this existed, upgrading the package moved the
 * generated TypeScript types forward while leaving the schema behind, and the app failed
 * at runtime with `column "…" does not exist`. Including it here closes that gap even for
 * users who never run `npm run update`.
 */
function packageMigrationsDir(cwd) {
  const suffix = path.join('supabase', 'migrations');
  try {
    const require = createRequire(path.join(cwd, 'noop.js'));
    const pkgJson = require.resolve('@nextblock-cms/db/package.json');
    const candidate = path.join(path.dirname(pkgJson), suffix);
    if (existsSync(candidate)) return candidate;
  } catch {
    /* not installed, or an exports map that hides package.json — fall through */
  }
  return walkUpFor(cwd, (dir) => {
    const candidate = path.join(dir, 'node_modules', '@nextblock-cms', 'db', suffix);
    return existsSync(candidate) ? candidate : null;
  });
}

function listMigrationFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => MIGRATION_FILE_RE.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Collect every migration reachable from `cwd`, deduped by version.
 *
 * Precedence is first-source-wins per version, in this order:
 *   1. the monorepo's libs/db (authoritative when you are IN the monorepo),
 *   2. the project's own supabase/migrations (what Docker mounts and what a user may
 *      have hand-added a migration to),
 *   3. node_modules/@nextblock-cms/db (the freshest copy after an npm upgrade).
 *
 * Versions unique to a later source are still included — that union is the point.
 *
 * @returns {{files: Array<{version: string, name: string, dir: string}>,
 *            sources: Array<{label: string, dir: string, count: number, contributed: number}>}}
 */
export function collectMigrations(cwd = process.cwd()) {
  const candidates = [
    { label: 'monorepo', dir: monorepoMigrationsDir(cwd) },
    { label: 'project', dir: projectMigrationsDir(cwd) },
    { label: 'package', dir: packageMigrationsDir(cwd) },
  ];

  const byVersion = new Map();
  const sources = [];
  const seenDirs = new Set();

  for (const { label, dir } of candidates) {
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    if (seenDirs.has(key)) continue; // the monorepo and project probes can land on one dir
    seenDirs.add(key);

    const names = listMigrationFiles(dir);
    let contributed = 0;
    for (const name of names) {
      const version = name.split('_')[0];
      if (byVersion.has(version)) continue;
      byVersion.set(version, { version, name, dir });
      contributed += 1;
    }
    sources.push({ label, dir, count: names.length, contributed });
  }

  const files = [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
  return { files, sources };
}

/** Read one collected migration's SQL. */
export function readMigrationSql(entry) {
  return readFile(path.join(entry.dir, entry.name), 'utf8');
}

/* -------------------------------------------------------------- applying --- */

// SQL kept in lockstep with apps/nextblock/lib/setup/schema-apply.ts.
const TRACKING_DDL =
  'create schema if not exists supabase_migrations;' +
  'create table if not exists supabase_migrations.schema_migrations ' +
  '(version text primary key, name text, statements text[]);';

// The blanket EXECUTE grant below is then taken back from every trigger function: Postgres
// only checks EXECUTE on a trigger function at CREATE TRIGGER time, never when it fires, and
// PostgREST cannot call a `RETURNS trigger` function via /rpc, so the API roles never need
// it. Until 02024 this file had the grant but not the revoke, so every production build
// re-granted anon/authenticated on the SECURITY DEFINER triggers (handle_new_user,
// update_product_ratings) that 02013 revokes, and the Security Advisor flagged them again
// after each deploy. migrate-core.test.mjs keeps this SQL identical to schema-apply.ts.
const TRIGGER_FUNCTION_REVOKE_SQL = `do $nb_trg$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_type t on t.oid = p.prorettype
     where p.pronamespace = 'public'::regnamespace and t.typname = 'trigger'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $nb_trg$;`;

// The blanket grants also hand back what migrations 02021/02022 deliberately take away from
// the API roles: TRUNCATE (not governed by RLS), the invoice-numbering RPCs (service role
// only), anon's EXECUTE on upsert_product_with_variants, and the two service-role-only
// wrappers of 02022 (bump_email_2fa_attempts, redeem_coupon_atomically). Guarded by catalog
// lookups: a database that stopped before those migrations simply has nothing to revoke.
// Migration 02025 added the grant-level hardening this pass must not undo: anon holds no
// write privilege on any table or sequence (no RLS policy lets anon write, so RLS was the only
// barrier), cortex_request_log stays service-role only as 02022 designed it (this pass had been
// re-granting it on every deploy), and authenticated may write every profiles column except
// `role` (and `id` on UPDATE), so the role pin no longer rests on the policy and trigger alone.
// The profiles column list is read from the catalog, so a new profiles column is writable by
// its owner the way it was before; add it to the exclusions if it is sensitive.
// Migration 02026 did the same for authenticated on the tables where no RLS policy lets it
// write: the commands listed per table below (each written only by the service role), plus
// REFERENCES and TRIGGER everywhere. The list is static on purpose: computing it from
// pg_policies here would hand a table back on the deploy after a policy was added by mistake.
// Migration 02027 did the same for SELECT: anon keeps it only on the tables a policy lets anon
// read (the 29 `revoke select` blocks below are every other table), authenticated loses it on
// email_2fa_challenges and ucp_cart_sessions (service role only), and profile_cards stays a
// read card (no anon SELECT, no authenticated writes). A table created later is granted SELECT
// by the blanket grant above: if its migration grants less, add its revoke here too
// (migration-grants.test.ts fails until you do).
// Migration 02028 keeps package_activations.license_key and .meta (the Freemius activation
// response) unreadable by authenticated: table SELECT goes and comes back per column, the
// column list read from the catalog like profiles. It also keeps media_storage_keys_in_use
// service-role only (the media delete/move actions call it after their own role check).
// To open one of these commands to a role, add the policy and the GRANT in a migration and
// remove the table here and in schema-apply.ts.
const API_ROLE_REVOKE_SQL = `do $nb_api$
declare
  v_insert_cols text;
  v_update_cols text;
  v_select_cols text;
begin
  revoke truncate on all tables in schema public from anon, authenticated;
  revoke insert, update, delete, references, trigger on all tables in schema public from anon;
  revoke usage, update on all sequences in schema public from anon;
  revoke references, trigger on all tables in schema public from authenticated;
  if to_regclass('public.cortex_request_log') is not null then
    revoke all on table public.cortex_request_log from public, anon, authenticated;
  end if;
  if to_regclass('public.profiles') is not null then
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) filter (where a.attname <> 'role'),
           string_agg(quote_ident(a.attname), ', ' order by a.attnum) filter (where a.attname not in ('id', 'role'))
      into v_insert_cols, v_update_cols
      from pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped;
    revoke insert, update, delete, references, trigger on table public.profiles from public, anon, authenticated;
    if v_insert_cols is not null then
      execute format('grant insert (%s) on table public.profiles to authenticated', v_insert_cols);
    end if;
    if v_update_cols is not null then
      execute format('grant update (%s) on table public.profiles to authenticated', v_update_cols);
    end if;
  end if;
  if to_regclass('public.cortex_ai_db_mutation_audit') is not null then
    revoke insert, update, delete on table public.cortex_ai_db_mutation_audit from authenticated;
  end if;
  if to_regclass('public.coupon_redemptions') is not null then
    revoke insert, update, delete on table public.coupon_redemptions from authenticated;
  end if;
  if to_regclass('public.email_2fa_challenges') is not null then
    revoke insert, update, delete on table public.email_2fa_challenges from authenticated;
  end if;
  if to_regclass('public.freemius_plans') is not null then
    revoke insert, update, delete on table public.freemius_plans from authenticated;
  end if;
  if to_regclass('public.freemius_pricing') is not null then
    revoke insert, update, delete on table public.freemius_pricing from authenticated;
  end if;
  if to_regclass('public.package_activations') is not null then
    revoke insert, update, delete on table public.package_activations from authenticated;
  end if;
  if to_regclass('public.privacy_consent_logs') is not null then
    revoke insert, update, delete on table public.privacy_consent_logs from authenticated;
  end if;
  if to_regclass('public.thread_messages') is not null then
    revoke insert, update, delete on table public.thread_messages from authenticated;
  end if;
  if to_regclass('public.ucp_cart_sessions') is not null then
    revoke insert, update, delete on table public.ucp_cart_sessions from authenticated;
  end if;
  if to_regclass('public.user_security_settings') is not null then
    revoke insert, update, delete on table public.user_security_settings from authenticated;
  end if;
  if to_regclass('public.message_threads') is not null then
    revoke insert, delete on table public.message_threads from authenticated;
  end if;
  if to_regclass('public.product_inquiries') is not null then
    revoke insert, delete on table public.product_inquiries from authenticated;
  end if;
  if to_regclass('public.system_alerts') is not null then
    revoke insert, delete on table public.system_alerts from authenticated;
  end if;
  if to_regclass('public.site_script_revisions') is not null then
    revoke update, delete on table public.site_script_revisions from authenticated;
  end if;
  if to_regclass('public.user_trusted_devices') is not null then
    revoke insert, update on table public.user_trusted_devices from authenticated;
  end if;
  if to_regclass('public.content_drafts') is not null then
    revoke select on table public.content_drafts from anon;
  end if;
  if to_regclass('public.cortex_ai_db_mutation_audit') is not null then
    revoke select on table public.cortex_ai_db_mutation_audit from anon;
  end if;
  if to_regclass('public.coupon_freemius_mappings') is not null then
    revoke select on table public.coupon_freemius_mappings from anon;
  end if;
  if to_regclass('public.coupon_products') is not null then
    revoke select on table public.coupon_products from anon;
  end if;
  if to_regclass('public.coupon_redemptions') is not null then
    revoke select on table public.coupon_redemptions from anon;
  end if;
  if to_regclass('public.coupons') is not null then
    revoke select on table public.coupons from anon;
  end if;
  if to_regclass('public.email_2fa_challenges') is not null then
    revoke select on table public.email_2fa_challenges from anon, authenticated;
  end if;
  if to_regclass('public.form_endpoints') is not null then
    revoke select on table public.form_endpoints from anon;
  end if;
  if to_regclass('public.mcp_access_tokens') is not null then
    revoke select on table public.mcp_access_tokens from anon;
  end if;
  if to_regclass('public.message_threads') is not null then
    revoke select on table public.message_threads from anon;
  end if;
  if to_regclass('public.order_items') is not null then
    revoke select on table public.order_items from anon;
  end if;
  if to_regclass('public.orders') is not null then
    revoke select on table public.orders from anon;
  end if;
  if to_regclass('public.package_activations') is not null then
    revoke select on table public.package_activations from anon;
  end if;
  if to_regclass('public.page_revisions') is not null then
    revoke select on table public.page_revisions from anon;
  end if;
  if to_regclass('public.post_revisions') is not null then
    revoke select on table public.post_revisions from anon;
  end if;
  if to_regclass('public.privacy_consent_logs') is not null then
    revoke select on table public.privacy_consent_logs from anon;
  end if;
  if to_regclass('public.product_drafts') is not null then
    revoke select on table public.product_drafts from anon;
  end if;
  if to_regclass('public.product_freemius_sale_coupons') is not null then
    revoke select on table public.product_freemius_sale_coupons from anon;
  end if;
  if to_regclass('public.product_inquiries') is not null then
    revoke select on table public.product_inquiries from anon;
  end if;
  if to_regclass('public.product_revisions') is not null then
    revoke select on table public.product_revisions from anon;
  end if;
  if to_regclass('public.profiles') is not null then
    revoke select on table public.profiles from anon;
  end if;
  if to_regclass('public.site_script_revisions') is not null then
    revoke select on table public.site_script_revisions from anon;
  end if;
  if to_regclass('public.system_alerts') is not null then
    revoke select on table public.system_alerts from anon;
  end if;
  if to_regclass('public.system_configuration') is not null then
    revoke select on table public.system_configuration from anon;
  end if;
  if to_regclass('public.thread_messages') is not null then
    revoke select on table public.thread_messages from anon;
  end if;
  if to_regclass('public.ucp_cart_sessions') is not null then
    revoke select on table public.ucp_cart_sessions from anon, authenticated;
  end if;
  if to_regclass('public.user_addresses') is not null then
    revoke select on table public.user_addresses from anon;
  end if;
  if to_regclass('public.user_security_settings') is not null then
    revoke select on table public.user_security_settings from anon;
  end if;
  if to_regclass('public.user_trusted_devices') is not null then
    revoke select on table public.user_trusted_devices from anon;
  end if;
  if to_regclass('public.profile_cards') is not null then
    revoke select on table public.profile_cards from anon;
    revoke insert, update, delete on table public.profile_cards from authenticated;
  end if;
  if to_regclass('public.package_activations') is not null then
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
      into v_select_cols
      from pg_attribute a
     where a.attrelid = 'public.package_activations'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname not in ('license_key', 'meta');
    revoke select on table public.package_activations from authenticated;
    if v_select_cols is not null then
      execute format('grant select (%s) on table public.package_activations to authenticated', v_select_cols);
    end if;
  end if;
  if to_regprocedure('public.generate_order_invoice_number()') is not null then
    revoke execute on function public.generate_order_invoice_number() from public, anon, authenticated;
  end if;
  if to_regprocedure('public.assign_order_invoice_metadata(uuid, timestamp with time zone)') is not null then
    revoke execute on function public.assign_order_invoice_metadata(uuid, timestamp with time zone) from public, anon, authenticated;
  end if;
  if to_regclass('public.order_invoice_number_seq') is not null then
    revoke all on sequence public.order_invoice_number_seq from anon, authenticated;
  end if;
  if to_regprocedure('public.upsert_product_with_variants(jsonb)') is not null then
    revoke execute on function public.upsert_product_with_variants(jsonb) from public, anon;
  end if;
  if to_regprocedure('public.bump_email_2fa_attempts(uuid)') is not null then
    revoke execute on function public.bump_email_2fa_attempts(uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.redeem_coupon_atomically(uuid)') is not null then
    revoke execute on function public.redeem_coupon_atomically(uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.media_storage_keys_in_use(text[], uuid)') is not null then
    revoke execute on function public.media_storage_keys_in_use(text[], uuid) from public, anon, authenticated;
  end if;
end $nb_api$;`;

export const GRANTS_SQL =
  'grant usage on schema public to anon, authenticated, service_role;' +
  'grant select on all tables in schema public to anon;' +
  'grant all on all tables in schema public to authenticated, service_role;' +
  'grant all on all sequences in schema public to anon, authenticated, service_role;' +
  'grant execute on all functions in schema public to anon, authenticated, service_role;' +
  TRIGGER_FUNCTION_REVOKE_SQL +
  API_ROLE_REVOKE_SQL;

function recordSql(version, file) {
  return (
    `insert into supabase_migrations.schema_migrations (version, name) ` +
    `values ('${version}', '${file.replace(/'/g, "''")}') on conflict (version) do nothing;`
  );
}

/** Wrap a migration file + its version record in one transaction (all-or-nothing). */
function transactionalMigration(version, file, sqlText) {
  return `begin;\n${sqlText}\n;\n${recordSql(version, file)}\ncommit;`;
}

function friendlyError(message) {
  const unreachable = /ENOTFOUND|ENOENT|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT/i.test(message);
  return unreachable
    ? `could not reach the database host (${message}); use the Session pooler connection string for IPv4 build networks`
    : message;
}

/** Backend 1: Supabase Management API (HTTPS). Works anywhere outbound HTTPS works. */
async function managementApiQuery(ref, token, query) {
  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : 'network error';
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (!text) return [];
      try {
        return JSON.parse(text);
      } catch {
        return [];
      }
    }
    const body = await res.text().catch(() => '');
    const isHtml = /<!doctype|<html/i.test(body);
    lastError = `Supabase Management API ${res.status}${
      isHtml ? ': gateway error (HTML response)' : body ? `: ${body.slice(0, 200).trim()}` : ''
    }`;
    // 4xx (other than rate limiting) will not get better on retry.
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(lastError);
}

function toRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.result)) return raw.result;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

async function applyViaManagementApi(ref, token, files, readSql, onApplied) {
  const run = (query) => managementApiQuery(ref, token, query);
  let applied = 0;
  try {
    await run(TRACKING_DDL);
    const done = new Set(
      toRows(await run('select version from supabase_migrations.schema_migrations;'))
        .map((r) => r.version)
        .filter(Boolean),
    );
    if (done.size > 0) {
      const exists = toRows(await run("select to_regclass('public.site_settings') as t;"))[0]?.t;
      if (exists == null) {
        await run('delete from supabase_migrations.schema_migrations;');
        done.clear();
      }
    }
    for (const entry of files) {
      if (done.has(entry.version)) continue;
      await run(transactionalMigration(entry.version, entry.name, await readSql(entry)));
      applied += 1;
      onApplied?.(entry);
    }
    await run(GRANTS_SQL);
    await run("notify pgrst, 'reload schema';");
    return { ok: true, applied, backend: 'management-api' };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'unknown error applying migrations';
    return { ok: false, applied, backend: 'management-api', error: friendlyError(message) };
  }
}

/** Backend 2: direct Postgres connection. */
async function applyViaPostgres(dbUrl, files, readSql, onApplied) {
  let db;
  try {
    db = await openPostgres(dbUrl);
  } catch {
    return {
      ok: false,
      applied: 0,
      backend: 'postgres',
      error: 'the "postgres" package is not installed',
    };
  }

  let applied = 0;
  try {
    await db.unsafe(TRACKING_DDL);
    const rows = await db`select version from supabase_migrations.schema_migrations`;
    const done = new Set(rows.map((r) => r.version));

    // Self-heal stale history: recorded versions but a core table missing means the
    // schema was wiped without clearing history (it lives in a separate schema).
    if (done.size > 0) {
      const sentinel = await db`select to_regclass('public.site_settings')::text as t`;
      if (!sentinel[0]?.t) {
        await db`delete from supabase_migrations.schema_migrations`;
        done.clear();
      }
    }

    for (const entry of files) {
      if (done.has(entry.version)) continue;
      await db.unsafe(transactionalMigration(entry.version, entry.name, await readSql(entry)));
      applied += 1;
      onApplied?.(entry);
    }

    await db.unsafe(GRANTS_SQL);
    await db.unsafe("notify pgrst, 'reload schema';");
    return { ok: true, applied, backend: 'postgres' };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'unknown error applying migrations';
    return { ok: false, applied, backend: 'postgres', error: friendlyError(message) };
  } finally {
    try {
      await db.end({ timeout: 5 });
    } catch {
      /* closing should never mask the result */
    }
  }
}

/**
 * Read the versions already recorded in supabase_migrations.schema_migrations, so a
 * caller can preview what is pending without applying anything.
 *
 * @returns {Promise<{ok: boolean, versions: Set<string>, error?: string}>}
 */
export async function readAppliedVersions() {
  const ref = resolveProjectRef();
  const token = process.env['SUPABASE_ACCESS_TOKEN']?.trim();
  if (ref && token) {
    try {
      // Probe for the tracking table before selecting from it. A database that has never
      // been migrated — or one reset by the /setup wizard, whose RESET_SQL drops the
      // supabase_migrations schema — has no such relation, and Postgres raises 42P01 at
      // parse time regardless of any WHERE clause. Without this the preview would fail
      // where the applier (which creates the table itself) would have succeeded.
      const [tracked] = toRows(
        await managementApiQuery(
          ref,
          token,
          "select to_regclass('supabase_migrations.schema_migrations')::text as t;",
        ),
      );
      if (!tracked?.t) return { ok: true, versions: new Set() };

      const [sentinel] = toRows(
        await managementApiQuery(ref, token, "select to_regclass('public.site_settings')::text as t;"),
      );
      if (!sentinel?.t) return { ok: true, versions: new Set() }; // history is lying; all replay

      const rows = toRows(
        await managementApiQuery(ref, token, 'select version from supabase_migrations.schema_migrations;'),
      );
      return { ok: true, versions: new Set(rows.map((r) => r.version).filter(Boolean)) };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown error';
      return { ok: false, versions: new Set(), error: friendlyError(message) };
    }
  }

  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    return { ok: false, versions: new Set(), error: describeBackend().detail };
  }

  let db;
  try {
    db = await openPostgres(dbUrl);
  } catch {
    return { ok: false, versions: new Set(), error: 'the "postgres" package is not installed' };
  }
  try {
    // A brand-new database has neither the tracking table nor public.site_settings.
    const [{ t: tracked }] = await db`
      select to_regclass('supabase_migrations.schema_migrations')::text as t`;
    if (!tracked) return { ok: true, versions: new Set() };
    const [{ t: sentinel }] = await db`select to_regclass('public.site_settings')::text as t`;
    if (!sentinel) return { ok: true, versions: new Set() }; // history is lying; everything replays
    const rows = await db`select version from supabase_migrations.schema_migrations`;
    return { ok: true, versions: new Set(rows.map((r) => r.version)) };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'unknown error';
    return { ok: false, versions: new Set(), error: friendlyError(message) };
  } finally {
    try {
      await db.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run one ad-hoc statement over whichever backend is available. Used for small
 * housekeeping writes (e.g. resolving the dashboard's "update available" alert once an
 * update really landed). Never throws — callers inspect `ok`.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function runSql(sql) {
  const ref = resolveProjectRef();
  const token = process.env['SUPABASE_ACCESS_TOKEN']?.trim();
  if (ref && token) {
    try {
      await managementApiQuery(ref, token, sql);
      return { ok: true };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'unknown error';
      return { ok: false, error: friendlyError(message) };
    }
  }

  const dbUrl = resolveDbUrl();
  if (!dbUrl) return { ok: false, error: describeBackend().detail };

  let db;
  try {
    db = await openPostgres(dbUrl);
  } catch {
    return { ok: false, error: 'the "postgres" package is not installed' };
  }
  try {
    await db.unsafe(sql);
    return { ok: true };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'unknown error';
    return { ok: false, error: friendlyError(message) };
  } finally {
    try {
      await db.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Apply every pending migration, preferring the Management API and falling back to a
 * direct Postgres connection. Never throws — callers inspect `ok`.
 *
 * @param {Array<{version: string, name: string, dir: string}>} files
 * @param {{onApplied?: (entry: object) => void}} [options]
 * @returns {Promise<{ok: boolean, applied: number, backend: string, error?: string}>}
 */
export async function applyMigrations(files, options = {}) {
  const readSql = options.readSql ?? readMigrationSql;
  const ref = resolveProjectRef();
  const token = process.env['SUPABASE_ACCESS_TOKEN']?.trim();
  if (ref && token) {
    return applyViaManagementApi(ref, token, files, readSql, options.onApplied);
  }
  const dbUrl = resolveDbUrl();
  if (dbUrl) {
    return applyViaPostgres(dbUrl, files, readSql, options.onApplied);
  }
  return {
    ok: false,
    applied: 0,
    backend: 'none',
    error:
      'No Supabase access token or Postgres connection string is available to apply migrations.',
  };
}
