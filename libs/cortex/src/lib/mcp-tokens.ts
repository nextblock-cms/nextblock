import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token store and settings resolver for the Cortex AI MCP server (`/api/mcp`).
 *
 * Tokens are stored as SHA-256 hashes in `public.mcp_access_tokens` (migration
 * 00000000000017). The plaintext is returned to the admin exactly once at mint time
 * and is unrecoverable afterwards, so a database leak cannot be replayed against the
 * endpoint. This mirrors how GitHub/Stripe treat personal access tokens, and is
 * deliberately NOT the reversible-envelope approach used for the OpenRouter BYOK key
 * — that key has to be handed back to OpenRouter, whereas an MCP token only ever
 * needs to be *compared*.
 */

const SERVER_ONLY_ERROR_MESSAGE =
  'Cortex AI MCP token utilities can only be imported from server-side code.';

function assertServerOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

export const CORTEX_AI_MCP_SETTINGS_KEY = 'cortex_ai_mcp_settings';
export const CORTEX_AI_MCP_TOKENS_TABLE = 'mcp_access_tokens';

/** Human-recognisable prefix so a leaked string is greppable and self-identifying. */
export const CORTEX_AI_MCP_TOKEN_PREFIX = 'nbmcp_';

/** 32 random bytes → 43 base64url chars. 256 bits of entropy; brute force is not a threat model. */
const CORTEX_AI_MCP_TOKEN_BYTES = 32;

/** Length of the non-secret fragment stored for display (prefix + 8 chars). */
const CORTEX_AI_MCP_TOKEN_DISPLAY_CHARS = 8;

export type CortexAiMcpScope = 'read' | 'write';

export const CORTEX_AI_MCP_SCOPES: readonly CortexAiMcpScope[] = ['read', 'write'] as const;

export type CortexAiMcpSettings = {
  /**
   * When false the endpoint answers 404 for everything. Off by default: an MCP server
   * is a remote write surface onto the CMS, so it must be an explicit opt-in rather
   * than something a fresh install exposes silently.
   */
  enabled: boolean;
  /**
   * Trust loopback callers without a token. Convenient for `npx nx serve nextblock`
   * plus a local Claude Code, and safe because the request must already originate on
   * the machine running the CMS. Ignored entirely in production (see
   * `shouldTrustLocalMcpRequest`).
   */
  allowLocalhostWithoutToken: boolean;
};

export const CORTEX_AI_MCP_SETTINGS_DEFAULTS: CortexAiMcpSettings = {
  allowLocalhostWithoutToken: true,
  enabled: false,
};

export function normalizeCortexAiMcpSettings(raw: unknown): CortexAiMcpSettings {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  return {
    allowLocalhostWithoutToken:
      typeof record.allowLocalhostWithoutToken === 'boolean'
        ? record.allowLocalhostWithoutToken
        : CORTEX_AI_MCP_SETTINGS_DEFAULTS.allowLocalhostWithoutToken,
    enabled:
      typeof record.enabled === 'boolean' ? record.enabled : CORTEX_AI_MCP_SETTINGS_DEFAULTS.enabled,
  };
}

type SupabaseLike = {
  from: (table: string) => any;
};

/** Read the MCP server settings row, falling back to defaults on any failure. */
export async function resolveCortexAiMcpSettings(
  supabase?: SupabaseLike | null
): Promise<CortexAiMcpSettings> {
  if (supabase) {
    try {
      const { data } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', CORTEX_AI_MCP_SETTINGS_KEY)
        .maybeSingle();

      if (data?.value) {
        return normalizeCortexAiMcpSettings(data.value);
      }
    } catch {
      // A settings read failure must not silently *enable* the server, and the
      // defaults are closed (enabled: false), so falling through is safe.
    }
  }

  return { ...CORTEX_AI_MCP_SETTINGS_DEFAULTS };
}

export function hashCortexAiMcpToken(token: string): string {
  assertServerOnly();
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

export type MintedCortexAiMcpToken = {
  /** Plaintext. Shown to the admin once, never persisted. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

export function mintCortexAiMcpToken(): MintedCortexAiMcpToken {
  assertServerOnly();

  const token = `${CORTEX_AI_MCP_TOKEN_PREFIX}${randomBytes(CORTEX_AI_MCP_TOKEN_BYTES).toString(
    'base64url'
  )}`;

  return {
    token,
    tokenHash: hashCortexAiMcpToken(token),
    tokenPrefix: token.slice(
      0,
      CORTEX_AI_MCP_TOKEN_PREFIX.length + CORTEX_AI_MCP_TOKEN_DISPLAY_CHARS
    ),
  };
}

/**
 * Pull the bearer credential out of an Authorization header.
 *
 * Accepts `Bearer <token>` (case-insensitive scheme, per RFC 7235) and also a bare
 * token, because Claude Desktop's connector UI asks the user to type the scheme by
 * hand and people routinely paste the token alone.
 */
export function parseBearerToken(headerValue: string | null | undefined): string | null {
  const value = headerValue?.trim();

  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = (match ? match[1] : value).trim();

  return token || null;
}

export type CortexAiMcpTokenRow = {
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  revoked_at: string | null;
  scopes: string[];
  token_prefix: string;
};

export type CortexAiMcpTokenVerification =
  | { reason: 'expired' | 'malformed' | 'revoked' | 'unknown'; valid: false }
  | { scopes: CortexAiMcpScope[]; token: CortexAiMcpTokenRow; valid: true };

function normalizeScopes(raw: unknown): CortexAiMcpScope[] {
  const list = Array.isArray(raw) ? raw : [];
  const scopes = list.filter((entry): entry is CortexAiMcpScope =>
    CORTEX_AI_MCP_SCOPES.includes(entry as CortexAiMcpScope)
  );

  // A token with no recognised scope would silently authenticate but grant nothing,
  // which reads to the operator as "the server is broken". Default to read.
  return scopes.length > 0 ? Array.from(new Set(scopes)) : ['read'];
}

/**
 * Look a plaintext token up by hash and report whether it may be used.
 *
 * The lookup is an indexed equality probe on the hash rather than a scan-and-compare,
 * so there is no per-row timing signal to leak. The `timingSafeEqual` re-check below
 * costs nothing and keeps the comparison constant-time even if a future caller passes
 * a candidate row in directly.
 */
export async function verifyCortexAiMcpToken(
  supabase: SupabaseLike,
  plaintextToken: string,
  now: Date = new Date()
): Promise<CortexAiMcpTokenVerification> {
  assertServerOnly();

  const token = plaintextToken?.trim();

  if (!token || token.length < 16) {
    return { reason: 'malformed', valid: false };
  }

  const tokenHash = hashCortexAiMcpToken(token);

  const { data, error } = await supabase
    .from(CORTEX_AI_MCP_TOKENS_TABLE)
    .select('id, name, scopes, token_prefix, created_at, created_by, expires_at, last_used_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !data) {
    return { reason: 'unknown', valid: false };
  }

  const storedHashBuffer = Buffer.from(tokenHash, 'utf8');
  if (!timingSafeEqual(storedHashBuffer, Buffer.from(hashCortexAiMcpToken(token), 'utf8'))) {
    return { reason: 'unknown', valid: false };
  }

  const row = data as CortexAiMcpTokenRow;

  if (row.revoked_at) {
    return { reason: 'revoked', valid: false };
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return { reason: 'expired', valid: false };
  }

  return { scopes: normalizeScopes(row.scopes), token: row, valid: true };
}

/**
 * Stamp `last_used_at` so an admin can spot a token that is still live but unused.
 *
 * Fire-and-forget: a failed bookkeeping write must never fail the MCP call that
 * already authenticated successfully.
 */
export async function touchCortexAiMcpToken(
  supabase: SupabaseLike,
  tokenId: string,
  now: Date = new Date()
): Promise<void> {
  try {
    await supabase
      .from(CORTEX_AI_MCP_TOKENS_TABLE)
      .update({ last_used_at: now.toISOString() })
      .eq('id', tokenId);
  } catch {
    // Intentionally ignored — see doc comment.
  }
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** True when `value` is a loopback host, with or without a port. */
export function isLocalhostHost(value: string | null | undefined): boolean {
  const host = value?.trim().toLowerCase();

  if (!host) {
    return false;
  }

  // Strip a trailing :port, but not the colons inside a bracketed IPv6 literal.
  const withoutPort = host.startsWith('[') ? host.replace(/\]:\d+$/, ']') : host.replace(/:\d+$/, '');

  return LOCALHOST_HOSTNAMES.has(withoutPort) || withoutPort.endsWith('.localhost');
}

/**
 * Decide whether a tokenless request may be trusted as local.
 *
 * Requires all three of: the setting on, a loopback Host header, and a non-production
 * `NODE_ENV`. The last condition is the important one — behind a reverse proxy the
 * Host header is attacker-controllable, so localhost trust is a development
 * affordance only and must never be the thing standing between the public internet
 * and a write-capable CMS endpoint.
 */
export function shouldTrustLocalMcpRequest(params: {
  hostHeader: string | null | undefined;
  settings: CortexAiMcpSettings;
}): boolean {
  if (!params.settings.allowLocalhostWithoutToken) {
    return false;
  }

  if (process.env['NODE_ENV'] === 'production') {
    return false;
  }

  return isLocalhostHost(params.hostHeader);
}

/* -------------------------------------------------------------------------- */
/* Environment-provided bootstrap token                                        */
/* -------------------------------------------------------------------------- */

/**
 * Name of the environment variable that carries an operator-provisioned MCP bearer
 * token. `create-nextblock --non-interactive` generates one at scaffold time and writes
 * it to the project's `.env` / `.env.local` (Docker / cloud) together with the agent
 * client configs, so a coding agent can reach `/api/mcp` before any admin has opened
 * the dashboard to mint a database token.
 *
 * Setting the variable is the opt-in: the endpoint accepts this token even while the
 * database `enabled` flag is still off (the flag guards *unattended* exposure, and an
 * operator who put a secret in the environment has attended to it). Everything else
 * still applies — the Cortex AI license gate, the Origin check, and the scope rules.
 */
export const CORTEX_AI_MCP_ENV_TOKEN_VAR = 'MCP_BEARER_TOKEN';

/**
 * Anything shorter is refused outright rather than honoured: a short value is far more
 * likely to be a placeholder left in an example file than a deliberate secret.
 */
export const CORTEX_AI_MCP_ENV_TOKEN_MIN_LENGTH = 32;

/** Read the configured environment token, or null when unset, blank or too short. */
export function readCortexAiMcpEnvToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  const value = env[CORTEX_AI_MCP_ENV_TOKEN_VAR]?.trim();

  if (!value || value.length < CORTEX_AI_MCP_ENV_TOKEN_MIN_LENGTH) {
    return null;
  }

  return value;
}

/**
 * Constant-time comparison of a presented bearer credential against the configured
 * environment token. Both sides are hashed first so the comparison length never
 * depends on the caller's input, which keeps `timingSafeEqual`'s precondition (equal
 * buffer lengths) satisfied without leaking the configured token's length.
 */
export function matchesCortexAiMcpEnvToken(
  presented: string | null | undefined,
  configured: string | null | undefined
): boolean {
  assertServerOnly();

  const candidate = presented?.trim();
  const expected = configured?.trim();

  if (!candidate || !expected || expected.length < CORTEX_AI_MCP_ENV_TOKEN_MIN_LENGTH) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(hashCortexAiMcpToken(candidate), 'utf8'),
    Buffer.from(hashCortexAiMcpToken(expected), 'utf8')
  );
}
