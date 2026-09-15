'use server';

import { revalidatePath } from 'next/cache';

import {
  CORTEX_AI_MCP_SETTINGS_KEY,
  CORTEX_AI_MCP_TOKENS_TABLE,
  mintCortexAiMcpToken,
  normalizeCortexAiMcpSettings,
  type CortexAiMcpScope,
  type CortexAiMcpSettings,
} from '@nextblock-cms/cortex';

import { requireAdminSupabaseClient } from './require-admin';

/**
 * Server actions for the "MCP server access" card.
 *
 * Unlike the rest of `actions.ts`, these return values instead of redirecting with a
 * `?success=` message. A minted token is displayed exactly once and must never travel
 * in a URL — it would land in browser history, the referrer header, and the server
 * access log. Returning it to a client component that renders it in-place and forgets
 * it keeps the secret out of every one of those.
 */

const CORTEX_AI_SETTINGS_PATH = '/cms/settings/cortex-ai';

const MAX_TOKEN_NAME_LENGTH = 80;
const MAX_TOKENS = 20;

/**
 * Sandbox writes are refused here, not just in the UI.
 *
 * The settings row and the token table are shared by every sandbox visitor, and the
 * card is now rendered there (read-only) so people can see that MCP access exists —
 * which means these actions are reachable from a sandbox page. A disabled checkbox is
 * a suggestion; this is the actual boundary. Mirrors the guards in `actions.ts`.
 */
function sandboxRejection(what: string): { error: string; success: false } | null {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    return null;
  }

  return { error: `Sandbox environment cannot ${what}.`, success: false };
}

export type McpAccessTokenSummary = {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  scopes: CortexAiMcpScope[];
  tokenPrefix: string;
};

export type McpSettingsStatus = {
  settings: CortexAiMcpSettings;
  tokens: McpAccessTokenSummary[];
};

function toScopeList(raw: unknown): CortexAiMcpScope[] {
  const list = Array.isArray(raw) ? raw : [];
  const scopes = list.filter(
    (entry): entry is CortexAiMcpScope => entry === 'read' || entry === 'write'
  );

  return scopes.length > 0 ? Array.from(new Set(scopes)) : ['read'];
}

/**
 * Load MCP settings and the non-secret token list.
 *
 * Revoked tokens are filtered out rather than deleted at revoke time so the row keeps
 * acting as a tombstone: the hash stays in the unique index, which makes an
 * accidental re-mint of the same value impossible.
 */
export async function getMcpSettingsStatus(): Promise<McpSettingsStatus> {
  const { supabase } = await requireAdminSupabaseClient();

  const [{ data: settingsRow }, { data: tokenRows }] = await Promise.all([
    supabase.from('site_settings').select('value').eq('key', CORTEX_AI_MCP_SETTINGS_KEY).maybeSingle(),
    supabase
      .from(CORTEX_AI_MCP_TOKENS_TABLE)
      .select('id, name, scopes, token_prefix, created_at, expires_at, last_used_at, revoked_at')
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_TOKENS),
  ]);

  return {
    settings: normalizeCortexAiMcpSettings(settingsRow?.value),
    tokens: (tokenRows ?? []).map((row: Record<string, any>) => ({
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      id: row.id,
      lastUsedAt: row.last_used_at,
      name: row.name,
      scopes: toScopeList(row.scopes),
      tokenPrefix: row.token_prefix,
    })),
  };
}

/**
 * `options.revalidate: false` skips the settings-page revalidation. Any revalidation
 * inside a server action makes the client router re-render the CURRENT route in the
 * action response, so the first-run wizard (mounted on `/cms/welcome`, whose server
 * page redirects away as soon as MCP is on) must call these without it.
 */
type McpActionOptions = { revalidate?: boolean };

export async function saveMcpSettingsAction(
  input: {
    allowLocalhostWithoutToken: boolean;
    enabled: boolean;
  },
  options: McpActionOptions = {}
): Promise<{ error?: string; success: boolean }> {
  const rejected = sandboxRejection('change MCP server settings');
  if (rejected) return rejected;

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const value = normalizeCortexAiMcpSettings(input);

    const { error } = await supabase
      .from('site_settings')
      .upsert({ key: CORTEX_AI_MCP_SETTINGS_KEY, value });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to save MCP server settings.',
      success: false,
    };
  }

  if (options.revalidate !== false) {
    revalidatePath(CORTEX_AI_SETTINGS_PATH);
  }
  return { success: true };
}

export async function createMcpAccessTokenAction(
  input: {
    expiresInDays?: number | null;
    name: string;
    scopes: CortexAiMcpScope[];
  },
  options: McpActionOptions = {}
): Promise<{ error?: string; success: boolean; token?: string; tokenPrefix?: string }> {
  const rejected = sandboxRejection('mint MCP access tokens');
  if (rejected) return rejected;

  try {
    const { supabase, userId } = await requireAdminSupabaseClient();

    const name = String(input.name || '').trim().slice(0, MAX_TOKEN_NAME_LENGTH);

    if (!name) {
      throw new Error('Give the token a name so you can tell your clients apart later.');
    }

    const scopes = toScopeList(input.scopes);

    const { count } = await supabase
      .from(CORTEX_AI_MCP_TOKENS_TABLE)
      .select('id', { count: 'exact', head: true })
      .is('revoked_at', null);

    if ((count ?? 0) >= MAX_TOKENS) {
      throw new Error(
        `You already have ${MAX_TOKENS} active MCP tokens. Revoke one before creating another.`
      );
    }

    const expiresInDays =
      typeof input.expiresInDays === 'number' && Number.isFinite(input.expiresInDays)
        ? Math.min(3650, Math.max(1, Math.round(input.expiresInDays)))
        : null;

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const minted = mintCortexAiMcpToken();

    const { error } = await supabase.from(CORTEX_AI_MCP_TOKENS_TABLE).insert({
      created_by: userId,
      expires_at: expiresAt,
      name,
      scopes,
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
    });

    if (error) {
      throw new Error(error.message);
    }

    if (options.revalidate !== false) {
      revalidatePath(CORTEX_AI_SETTINGS_PATH);
    }

    return { success: true, token: minted.token, tokenPrefix: minted.tokenPrefix };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to create the MCP access token.',
      success: false,
    };
  }
}

export async function revokeMcpAccessTokenAction(input: {
  id: string;
}): Promise<{ error?: string; success: boolean }> {
  const rejected = sandboxRejection('revoke MCP access tokens');
  if (rejected) return rejected;

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const id = String(input.id || '').trim();

    if (!id) {
      throw new Error('Missing token id.');
    }

    const { error } = await supabase
      .from(CORTEX_AI_MCP_TOKENS_TABLE)
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to revoke the MCP access token.',
      success: false,
    };
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  return { success: true };
}
