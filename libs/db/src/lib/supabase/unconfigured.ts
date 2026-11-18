/**
 * What the Supabase client factories build on when the project has no Supabase env yet: a fresh
 * scaffold or clone before /setup, whose first `npm run build` or deploy may come before its owner
 * connects Supabase (create-nextblock never runs such a build: its cloud profile builds nothing,
 * and its Docker profile builds with a URL and key). The client keeps the shape every caller
 * expects, and it cannot reach any network:
 *
 * - its URL is on `.invalid`, the top-level domain RFC 2606 reserves so that it never resolves;
 * - its fetch answers every PostgREST, Auth, Storage and Functions request on the spot with a "not
 *   configured" error: no DNS lookup, no socket, no retry.
 *
 * Callers already read a failed query as "no data" and fall back to their defaults. The fallback this
 * replaces, `https://dummy.supabase.co`, sat on Supabase's own domain, and postgrest-js retries a
 * failed GET three times, 1 s, 2 s and 4 s apart: a 0.23.5 scaffold made about 1,300 connection
 * attempts to it per build (post-publish check, 2026-11-17). Guard: `unconfigured.test.ts` beside
 * this file; docs/04 → "Unconfigured clients".
 */

/** Never resolves (RFC 2606 reserves `.invalid`), so not even a stray WebSocket leaves the machine. */
export const UNCONFIGURED_SUPABASE_URL = 'https://unconfigured.supabase.invalid';

/** supabase-js refuses an empty key. No `sb_` prefix: supabase-js warns about an `sb_` key it does not know. */
export const UNCONFIGURED_SUPABASE_KEY = 'unconfigured-supabase-key';

/** The `code` of every error an unconfigured client answers with. */
export const SUPABASE_NOT_CONFIGURED_CODE = 'NEXTBLOCK_SUPABASE_NOT_CONFIGURED';

const SUPABASE_NOT_CONFIGURED_MESSAGE =
  'Supabase is not configured, so no request was sent. Finish /setup, or set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.';

// 421 Misdirected Request: no server is configured to answer this URL. Never a 5xx: postgrest-js
// retries a GET answered 503 or 520 (and a rejected fetch), and auth-js treats every 5xx as
// retryable. Never 404: postgrest-js reads a 404 with an array body as an empty result.
const SUPABASE_NOT_CONFIGURED_STATUS = 421;

/**
 * The `global.fetch` of every unconfigured client: it answers locally and never calls the global
 * fetch.
 */
export const unconfiguredSupabaseFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      code: SUPABASE_NOT_CONFIGURED_CODE,
      // auth-js takes an error's code from `error_code`.
      error_code: SUPABASE_NOT_CONFIGURED_CODE,
      message: SUPABASE_NOT_CONFIGURED_MESSAGE,
      details: null,
      hint: null,
    }),
    { status: SUPABASE_NOT_CONFIGURED_STATUS, headers: { 'Content-Type': 'application/json' } }
  );
