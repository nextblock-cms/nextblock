// Dependency-free environment / provisioning detection.
//
// This module is imported from places that run in very different runtimes — the
// `proxy.ts` middleware (Edge), server components, server actions, and even
// `next.config.js` (Node, at build time). It therefore MUST stay free of
// `server-only`, of any Node-only imports (`node:fs`, etc.), and of any Supabase
// client so it is safe to evaluate anywhere.
//
// "Configured" here means the Supabase connection vars exist — there is no
// `DATABASE_URL` in NextBlock; the database is reached through
// `NEXT_PUBLIC_SUPABASE_URL` + the anon / service-role keys. Only the public names
// are resolved here; the secret key is resolved by the server-only ./service-key.ts.

export type DeployChannel = 'docker' | 'vercel' | 'local';

// --- Supabase env-var resolution (naming-tolerant) ---------------------------
//
// NextBlock's own vars are NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY. But the Supabase Vercel Marketplace integration
// (the one-click `stores` deploy flow) injects a DIFFERENT set of names:
//   - URL:     SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
//   - anon:    SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
//   - service: SUPABASE_SECRET_KEY
// (the new `sb_publishable_…` / `sb_secret_…` API keys, which supabase-js accepts
// in place of the legacy anon / service_role JWTs). Resolving every alias here is
// what makes auto-injected credentials work with zero manual entry. Keep the alias
// order identical anywhere this chain is duplicated (the published `libs/db`
// clients can't import this module, so they inline the same order).

/** The Supabase project URL, under either the prefixed or non-prefixed name. */
export function resolveSupabaseUrl(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || undefined
  );
}

/** The anon / publishable key — the RLS-respecting public key, under any alias. */
export function resolveSupabaseAnonKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    undefined
  );
}

// The service-role / secret key resolver (`resolveSupabaseServiceKey`) and
// `isFullyConfigured` live in ./service-key.ts, which is server-only: client modules import
// this file, and the RLS-bypassing key must never be named in a module a browser bundle can
// reach. Service-role boundary: docs/04.

/**
 * True when the public Supabase connection vars are present — enough to create an
 * anon client and reach the database. This is the single predicate the boot path,
 * the middleware gate, and the wizard all use to decide "is this instance wired up?".
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(resolveSupabaseUrl() && resolveSupabaseAnonKey());
}

/**
 * Which of the four deploy channels we appear to be running in. Drives the wizard's
 * channel-aware prefills (Docker -> MinIO storage, Vercel -> Supabase Storage S3,
 * local -> the user's own Cloudflare R2).
 */
export function detectChannel(): DeployChannel {
  if (process.env.VERCEL === '1') return 'vercel';

  // Docker is identified by the internal Supabase gateway URL (Kong :8000) or the MinIO
  // storage marker the docker setup writes — NOT by NEXT_PUBLIC_IS_SANDBOX, which the
  // managed cloud sandbox also sets.
  const url = resolveSupabaseUrl() ?? '';
  if (
    url.includes('localhost:8000') ||
    url.includes('127.0.0.1:8000') ||
    url.includes('kong:8000') ||
    process.env.R2_ACCOUNT_ID === 'minio'
  ) {
    return 'docker';
  }

  return 'local';
}

/**
 * True only where the wizard may safely write `.env.local` to the working directory:
 * local dev. NOT on Vercel (read-only FS, env is injected by the platform) and NOT
 * inside the baked standalone Docker runner (env is set by compose, FS is read-only).
 */
export function isLocalWritableEnv(): boolean {
  // Require NODE_ENV === 'development' explicitly (not `!== 'production'`): an UNSET
  // NODE_ENV must NOT count as local. `next dev` / `nx serve` set it to 'development';
  // `next build`/`next start`, Vercel, and the Docker runner set it to 'production'.
  // The remaining checks are belt-and-suspenders. This is a SAFETY boundary (it gates
  // destructive setup actions), so it must fail closed.
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.VERCEL !== '1' &&
    process.env.DOCKER_BUILD !== 'true' &&
    process.env.NEXTBLOCK_RUNTIME !== 'standalone'
  );
}

/**
 * Records the unconfigured state on `process.env.NEXTBLOCK_UNCONFIGURED` so other
 * call sites (CSP construction, middleware) can read it without recomputing.
 * Idempotent; returns the boolean it set.
 */
export function markUnconfiguredFlag(): boolean {
  const unconfigured = !isSupabaseConfigured();
  process.env.NEXTBLOCK_UNCONFIGURED = unconfigured ? 'true' : 'false';
  return unconfigured;
}
