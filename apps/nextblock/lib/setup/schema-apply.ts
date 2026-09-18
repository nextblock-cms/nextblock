import 'server-only';
// Server-side schema applier for the /setup wizard. Two backends, preferred in order:
//
//   1. Supabase Management API (HTTPS) — used when a SUPABASE_ACCESS_TOKEN + project ref
//      are available. Robust on any network (IPv4, no direct-DB host to resolve) and
//      needs no Postgres connection string. This is the default for Supabase Cloud.
//   2. Direct Postgres connection via POSTGRES_URL (the 'postgres' driver, same pattern
//      as app/api/cron/reset-sandbox/route.ts) — fallback for self-hosted / no-token.
//
// Either way, migrations run in version order; each file is applied AND recorded in
// supabase_migrations.schema_migrations inside one transaction, so a failure rolls back
// cleanly and a retry re-runs from a clean state (critical: some migrations aren't
// idempotent). Applied versions are tracked exactly like the Supabase CLI.
import path from 'node:path';
import postgres from 'postgres';
import { isLocalWritableEnv } from './env-status';
import { MIGRATIONS_BUNDLE } from './migrations-bundle';

export interface SchemaApplyResult {
  ok: boolean;
  applied: number;
  error?: string;
}

/**
 * Locate the migrations directory: the Nx monorepo keeps them at
 * <workspaceRoot>/libs/db/src/supabase/migrations; a standalone create-nextblock
 * project materializes them at <projectRoot>/supabase/migrations.
 */
async function resolveMigrationsDir(): Promise<string | null> {
  const { existsSync } = await loadFs();

  // Monorepo first: find the nearest nx.json ancestor (the workspace root) and use its
  // libs/db migrations. Checking nx.json before any supabase/ dir avoids accidentally
  // picking up a stray app-level supabase/migrations folder.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(
        /* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, 'nx.json')
      )
    ) {
      const monorepo = path.join(
        /* turbopackIgnore: true */ dir,
        'libs',
        'db',
        'src',
        'supabase',
        'migrations'
      );
      if (existsSync(/* turbopackIgnore: true */ monorepo)) return monorepo;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Standalone create-nextblock project: nearest supabase/migrations from cwd upward.
  dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const standalone = path.join(/* turbopackIgnore: true */ dir, 'supabase', 'migrations');
    if (existsSync(/* turbopackIgnore: true */ standalone)) return standalone;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Supabase project ref, from SUPABASE_PROJECT_ID or the project URL host. */
function resolveProjectRef(): string | null {
  const fromId = process.env.SUPABASE_PROJECT_ID?.trim();
  if (fromId) return fromId;
  try {
    const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname;
    if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) {
      return host.split('.')[0];
    }
  } catch {
    // not a cloud URL
  }
  return null;
}

/** Turn a non-2xx Management API response into a short, non-HTML error message. */
function summarizeApiError(status: number, body: string): string {
  const isHtml = /<!doctype|<html/i.test(body);
  const detail = isHtml ? 'gateway error (HTML response)' : body.slice(0, 200).trim();
  return `Supabase Management API ${status}${detail ? `: ${detail}` : ''}`;
}

/**
 * Run a SQL query via the Supabase Management API with retry + timeout. Transient
 * gateway/server errors (5xx) and rate limits (429) are retried with backoff — applying
 * ~31 migrations is many sequential calls, and the gateway occasionally returns a 502
 * HTML page. 4xx errors fail fast (they won't get better on retry). Returns the parsed
 * JSON body (or null).
 */
async function managementApiQuery(ref: string, token: string, query: string): Promise<unknown> {
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  const maxAttempts = 4;
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (caught) {
      // Network error / timeout — retry.
      lastError = caught instanceof Error ? caught.message : 'network error';
      continue;
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }

    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    lastError = summarizeApiError(res.status, body);

    // Retry transient gateway/server errors and rate limits; fail fast on 4xx.
    if (res.status >= 500 || res.status === 429) {
      continue;
    }
    throw new Error(lastError);
  }

  throw new Error(`${lastError} (after ${maxAttempts} attempts)`);
}

const TRACKING_DDL =
  'create schema if not exists supabase_migrations;' +
  'create table if not exists supabase_migrations.schema_migrations ' +
  '(version text primary key, name text, statements text[]);';

// Re-grant the Supabase API roles on everything in `public` after all migrations run.
// Migration 06 grants ON ALL TABLES, but only covers tables that exist at that point;
// later migrations (e.g. content_drafts in 14) rely on the schema's DEFAULT PRIVILEGES,
// which a `DROP SCHEMA public CASCADE` reset wipes. This final, idempotent pass mirrors
// migration 06's grants over the FINAL table set, so no table is left ungranted
// ("permission denied"). RLS still governs row access on top of these base grants.
//
// The blanket EXECUTE grant is then taken back from every trigger function: Postgres only
// checks EXECUTE on a trigger function at CREATE TRIGGER time, never when it fires, and
// PostgREST cannot call a `RETURNS trigger` function via /rpc, so the API roles never
// need it. Without this pass every apply re-granted anon/authenticated on the SECURITY
// DEFINER triggers (handle_new_user, update_product_ratings) that migration 02013 revokes,
// and the Supabase Security Advisor flagged them again after each deploy.
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

const GRANTS_SQL =
  'grant usage on schema public to anon, authenticated, service_role;' +
  'grant select on all tables in schema public to anon;' +
  'grant all on all tables in schema public to authenticated, service_role;' +
  'grant all on all sequences in schema public to anon, authenticated, service_role;' +
  'grant execute on all functions in schema public to anon, authenticated, service_role;' +
  TRIGGER_FUNCTION_REVOKE_SQL;

function recordSql(version: string, file: string): string {
  return (
    `insert into supabase_migrations.schema_migrations (version, name) ` +
    `values ('${version}', '${file.replace(/'/g, "''")}') on conflict (version) do nothing;`
  );
}

/**
 * Wrap a migration file + its version record in one explicit transaction. A mid-file
 * failure aborts the whole thing (nothing applied, nothing recorded) so a retry re-runs
 * from a clean state — essential for non-idempotent migrations (e.g. 25's ADD CONSTRAINT).
 */
function transactionalMigration(version: string, file: string, sqlText: string): string {
  return `begin;\n${sqlText}\n;\n${recordSql(version, file)}\ncommit;`;
}

// Destructive reset: drop the public schema (all app tables + triggers) and the
// migration history (separate schema — survives a plain DROP SCHEMA public). Wrapped in
// one transaction so it's all-or-nothing. Auth users are NOT cleared here (SQL on the
// auth schema can be permission-restricted via the Management API); the caller clears
// them with the admin API instead. The ONLY caller (completeSetup) gates this on BOTH
// assertNotProvisioned() (no admin exists — a live site is immune) AND isLocalWritableEnv()
// (local dev only). Plus this function self-guards on isLocalWritableEnv(). Never unguarded.
const RESET_SQL =
  'begin;' +
  'drop schema if exists public cascade;' +
  'create schema public;' +
  'grant all on schema public to postgres;' +
  'grant all on schema public to anon;' +
  'grant all on schema public to authenticated;' +
  'grant all on schema public to service_role;' +
  'drop schema if exists supabase_migrations cascade;' +
  'commit;';

export async function resetDatabase(): Promise<{ ok: boolean; error?: string }> {
  // Defense-in-depth: refuse to wipe anything outside local development, regardless of
  // the caller. This is the last line guarding an irreversible, destructive operation.
  if (!isLocalWritableEnv()) {
    return { ok: false, error: 'Database reset is only allowed in local development.' };
  }

  const ref = resolveProjectRef();
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();

  if (ref && token) {
    try {
      await managementApiQuery(ref, token, RESET_SQL);
      return { ok: true };
    } catch (caught) {
      return {
        ok: false,
        error: caught instanceof Error ? caught.message : 'unknown error resetting the database',
      };
    }
  }

  const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    const db = postgres(dbUrl, { ssl: 'require', onnotice: () => undefined, max: 1 });
    try {
      await db.unsafe(RESET_SQL);
      return { ok: true };
    } catch (caught) {
      return {
        ok: false,
        error: caught instanceof Error ? caught.message : 'unknown error resetting the database',
      };
    } finally {
      try {
        await db.end({ timeout: 5 });
      } catch {
        /* ignore */
      }
    }
  }

  return {
    ok: false,
    error: 'No Supabase access token or Postgres connection string is available to reset.',
  };
}

/**
 * Load node:fs through a dynamic import the bundler is told to leave alone.
 *
 * Next's output file tracing (Turbopack / nft) follows every fs call it can see
 * (`existsSync`, `readdir`, `readFile`) and, because the paths here derive from
 * `process.cwd()` and a runtime directory listing, gives up and traces the WHOLE project
 * into every serverless function that transitively imports this module ("Encountered
 * unexpected file in NFT list" / "Dynamic filesystem access causes tracing of the whole
 * project"). The .sql files are never meant to be bundled: on Vercel the directory does
 * not exist at runtime and applyMigrations() falls back to the embedded MIGRATIONS_BUNDLE;
 * only local dev / Docker read the real files. This module therefore has NO static fs
 * import: every fs call goes through this ignored dynamic import, and every fs /
 * `path.join(process.cwd()…)` argument carries the `turbopackIgnore` hint the warning asks
 * for (Next's own dist code hints both the fs call and the path.join inside it).
 * `webpackIgnore` is honoured by both webpack and Turbopack (Next.js "Magic Comments").
 * Runtime behaviour is exactly as before.
 */
function loadFs(): Promise<typeof import('node:fs')> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs');
}

export async function applyMigrations(): Promise<SchemaApplyResult> {
  const migrationsDir = await resolveMigrationsDir();

  let files: string[];
  let readSql: (file: string) => Promise<string>;

  if (migrationsDir) {
    // Local dev / Docker: read the canonical .sql files from disk (always current).
    const { readdir, readFile } = (await loadFs()).promises;
    files = (await readdir(/* turbopackIgnore: true */ migrationsDir))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort();
    readSql = (file: string) =>
      readFile(
        /* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ migrationsDir, file),
        'utf8'
      );
  } else if (MIGRATIONS_BUNDLE.length > 0) {
    // Serverless (Vercel): libs/db isn't on the function filesystem, so fall back to the
    // build-time embedded bundle (npm run generate:migrations-bundle).
    files = MIGRATIONS_BUNDLE.map((m) => m.name).sort();
    const sqlByName = new Map(MIGRATIONS_BUNDLE.map((m) => [m.name, m.sql]));
    readSql = async (file: string) => sqlByName.get(file) ?? '';
  } else {
    return {
      ok: false,
      applied: 0,
      error: 'Could not locate the migrations (no directory and no embedded bundle).',
    };
  }

  const ref = resolveProjectRef();
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (ref && token) {
    return applyViaManagementApi(ref, token, files, readSql);
  }

  const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    return applyViaPostgres(dbUrl, files, readSql);
  }

  return {
    ok: false,
    applied: 0,
    error:
      'No Supabase access token or Postgres connection string is available to apply the schema.',
  };
}

/** Backend 1: Supabase Management API (HTTPS). */
async function applyViaManagementApi(
  ref: string,
  token: string,
  files: string[],
  readSql: (file: string) => Promise<string>,
): Promise<SchemaApplyResult> {
  const run = (query: string) => managementApiQuery(ref, token, query);

  const toRows = (raw: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
    const obj = raw as { result?: unknown; data?: unknown } | null;
    if (Array.isArray(obj?.result)) return obj!.result as Array<Record<string, unknown>>;
    if (Array.isArray(obj?.data)) return obj!.data as Array<Record<string, unknown>>;
    return [];
  };

  let applied = 0;
  try {
    await run(TRACKING_DDL);
    const done = new Set(
      toRows(await run('select version from supabase_migrations.schema_migrations;'))
        .map((r) => r.version)
        .filter(Boolean) as string[],
    );

    // Self-heal stale history: if versions are recorded but a core table is missing
    // (e.g. someone ran DROP SCHEMA public CASCADE without clearing the history, which
    // lives in the separate supabase_migrations schema), those records are lying — clear
    // them and re-apply everything from scratch.
    if (done.size > 0) {
      const exists =
        toRows(await run("select to_regclass('public.site_settings') as t;"))[0]?.t != null;
      if (!exists) {
        await run('delete from supabase_migrations.schema_migrations;');
        done.clear();
      }
    }

    for (const file of files) {
      const version = file.split('_')[0];
      if (done.has(version)) continue;
      const sqlText = await readSql(file);
      await run(transactionalMigration(version, file, sqlText));
      applied += 1;
    }

    await run(GRANTS_SQL);
    await run("notify pgrst, 'reload schema';");
    return { ok: true, applied };
  } catch (caught) {
    return {
      ok: false,
      applied,
      error:
        caught instanceof Error
          ? caught.message
          : 'unknown error applying migrations via the Management API',
    };
  }
}

/** Backend 2: direct Postgres connection. */
async function applyViaPostgres(
  dbUrl: string,
  files: string[],
  readSql: (file: string) => Promise<string>,
): Promise<SchemaApplyResult> {
  const db = postgres(dbUrl, { ssl: 'require', onnotice: () => undefined, max: 1 });
  let applied = 0;
  try {
    await db.unsafe(TRACKING_DDL);
    const rows = await db<{ version: string }[]>`
      select version from supabase_migrations.schema_migrations
    `;
    const done = new Set(rows.map((r) => r.version));

    // Self-heal stale history (see Management API backend): recorded versions but a core
    // table missing means the schema was wiped without clearing history — re-apply all.
    if (done.size > 0) {
      const sentinel = await db<{ t: string | null }[]>`
        select to_regclass('public.site_settings')::text as t
      `;
      if (!sentinel[0]?.t) {
        await db`delete from supabase_migrations.schema_migrations`;
        done.clear();
      }
    }

    for (const file of files) {
      const version = file.split('_')[0];
      if (done.has(version)) continue;
      const sqlText = await readSql(file);
      await db.unsafe(transactionalMigration(version, file, sqlText));
      applied += 1;
    }

    await db.unsafe(GRANTS_SQL);
    await db.unsafe("notify pgrst, 'reload schema';");
    return { ok: true, applied };
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : 'unknown error applying migrations';
    // Newer Supabase projects expose no IPv4 address for the DIRECT db.<ref>.supabase.co
    // host, so on an IPv4-only network DNS fails (ENOTFOUND/ENOENT). The Session pooler
    // host is IPv4 — point users there.
    const isUnreachable = /ENOTFOUND|ENOENT|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT/i.test(
      message,
    );
    return {
      ok: false,
      applied,
      error: isUnreachable
        ? `Could not reach the database host (${message}). Provide a Supabase access token (so the wizard can use the Management API over HTTPS), or use the Session pooler connection string (Supabase dashboard → Connect → Session pooler), which works on IPv4 networks.`
        : message,
    };
  } finally {
    try {
      await db.end({ timeout: 5 });
    } catch {
      // Closing a connection should never mask the real result.
    }
  }
}
