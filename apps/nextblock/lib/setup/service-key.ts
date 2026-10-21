import 'server-only';

import { isSupabaseConfigured } from './env-status';

// The service-role / secret key resolver, split out of env-status.ts so the one module that
// names the RLS-bypassing key is server-only. env-status.ts stays dependency-free because the
// proxy, next.config.js and client modules (the language REST client, the app-icon context)
// import it; reading the secret there put a secret-reading function in client bundles, where
// it resolved to `undefined` but shipped all the same. Service-role boundary: docs/04.

/** The service-role / secret key — the RLS-bypassing admin key, under either alias. */
export function resolveSupabaseServiceKey(): string | undefined {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    undefined
  );
}

/**
 * True when service-role work is also possible (creating the first admin, applying
 * schema). The wizard's first-admin step and schema-apply step require this.
 */
export function isFullyConfigured(): boolean {
  return isSupabaseConfigured() && Boolean(resolveSupabaseServiceKey());
}
