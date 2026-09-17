import { revalidatePath } from 'next/cache';

import {
  createClient,
  getServiceRoleSupabaseClient,
  verifyPackageOnline,
} from '@nextblock-cms/db/server';
import { revalidatePublicContent } from '../../../lib/public-content-cache';
import {
  CORTEX_AI_PACKAGE_ID,
  handleCortexMcpMessage,
  isLocalhostHost,
  matchesCortexAiMcpEnvToken,
  parseBearerToken,
  readCortexAiMcpEnvToken,
  resolveCortexAiMcpSettings,
  shouldTrustLocalMcpRequest,
  touchCortexAiMcpToken,
  verifyCortexAiMcpToken,
  type CortexAiMcpScope,
  type CortexMcpToolContext,
  type JsonRpcMessage,
} from '@nextblock-cms/cortex';

import { validateBlockContent } from '../../../lib/blocks/blockRegistry';
import { ensureEnvLicenseActivation } from '../../../lib/packages/env-license';
import { isFullyConfigured, isSupabaseConfigured } from '../../../lib/setup/env-status';
import { importExternalImageToMedia } from '../../cms/media/import-external-image';
import { captureRevisionBaseline, commitRevisionFromBaseline } from '../../cms/revisions/service';
import type { AnyFullContent } from '../../cms/revisions/utils';

/**
 * Model Context Protocol server endpoint.
 *
 * Exposes the Cortex AI tool registry over MCP Streamable HTTP so external clients
 * (Claude Code, Claude Desktop, Cursor, VS Code) can operate this CMS with the same
 * typed, validated tools the in-app dashboard agent uses. The protocol itself lives
 * in `@nextblock-cms/cortex` (`mcp-server.ts`); this file is the HTTP shim plus auth.
 *
 * Node runtime, not Edge: the tool executors reach `node:crypto`, `sharp` (via the
 * media importer) and the service-role Supabase client.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SERVER_VERSION = '1.0.0';

/**
 * Confirmation is skipped for MCP callers, deliberately.
 *
 * The in-app agent's two-phase confirm works by matching a phrase in the user's *next
 * chat message*, which has no analogue in MCP — the model calls a tool and gets a
 * result, with no channel to carry a human phrase back. Every MCP host already gates
 * tool calls behind its own approval UI, so the confirmation would be a second prompt
 * the protocol cannot satisfy, and leaving it on would simply make every mutating
 * tool return a preview forever. The real control for MCP is the token scope: a
 * read-only token never sees a mutating tool at all.
 */
const MCP_SKIP_CONFIRMATION = true;

type McpAuth = {
  actorUserId: string | null;
  /**
   * True when this token outlived the account that minted it (`created_by` is
   * `ON DELETE SET NULL`), so `actorUserId` below is a stand-in rather than the
   * principal that actually holds the credential.
   *
   * A stand-in is fine for *attribution* — a revision needs some author — but it
   * must never be the basis for *authorization*, or deleting an administrator would
   * silently promote their leftover token to whichever admin happens to sort first.
   * Offboarding someone is exactly when their credentials should lose power, not
   * inherit someone else's.
   */
  actorFromOrphanedToken: boolean;
  scopes: CortexAiMcpScope[];
  source: 'admin-session' | 'env-token' | 'localhost' | 'token';
};

/**
 * MCP has no cookie session, so the importer is handed the actor this request already
 * authenticated. Without it every image import fails with "You must be signed in to
 * import an image" — which silently strips the imagery out of any page or product
 * built over MCP, since executors treat an import failure as non-fatal.
 */
function createMcpImageImporter(actorUserId: string | null) {
  return async function importExternalImageForMcp(input: {
    url: string;
    altText?: string;
  }): Promise<{ id: string } | { error: string }> {
    const result = await importExternalImageToMedia({
      ...(actorUserId ? { actorUserId } : {}),
      altText: input.altText,
      url: input.url,
    });

    if ('error' in result) {
      return { error: result.error };
    }

    return { id: result.media.id };
  };
}

/** Mirrors the global-agent route so MCP writes land in Revision History like any other edit. */
function createMcpRevisionRecorder(authorId: string | null) {
  return async function recordRevision(input: {
    baseline?: unknown;
    contentType: 'page' | 'post' | 'product';
    entityId: number | string;
    phase: 'capture' | 'commit';
  }): Promise<unknown> {
    if (input.phase === 'capture') {
      return captureRevisionBaseline(input.contentType, input.entityId);
    }

    const result = await commitRevisionFromBaseline(
      input.contentType,
      input.entityId,
      authorId,
      (input.baseline ?? null) as AnyFullContent | null
    );

    if ('error' in result) {
      console.error('Cortex AI MCP: revision not recorded —', result.error);
    }

    return undefined;
  };
}

/**
 * Reject cross-origin browser calls (DNS-rebinding defence, required by the spec).
 *
 * Only enforced when an `Origin` header is present: native MCP clients are not
 * browsers and send none, so requiring one would lock out every real caller.
 */
function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');

  if (!origin) {
    return true;
  }

  let originHost: string;

  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  if (isLocalhostHost(originHost)) {
    return true;
  }

  const host = request.headers.get('host');

  if (host && originHost.toLowerCase() === host.toLowerCase()) {
    return true;
  }

  const configuredUrl = process.env.NEXT_PUBLIC_URL;

  if (configuredUrl) {
    try {
      return new URL(configuredUrl).host.toLowerCase() === originHost.toLowerCase();
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Establish who is calling.
 *
 * Four accepted paths, in priority order:
 *  0. The environment bootstrap token (`MCP_BEARER_TOKEN`), written by
 *     `create-nextblock --non-interactive` so a coding agent can operate the site
 *     before any admin has opened the dashboard. Setting the variable is the opt-in,
 *     so this path does not wait for the database `enabled` flag; it still needs the
 *     Cortex AI license (checked before we get here) and a provisioned admin to
 *     attribute writes to.
 *  1. A bearer token from `mcp_access_tokens` — the path every external client uses.
 *  2. An authenticated ADMIN cookie session — lets the dashboard's own "Test
 *     connection" button reach the endpoint without minting a token first.
 *  3. Loopback in development, when the operator has left that setting on.
 */
async function authenticateMcpRequest(request: Request): Promise<McpAuth | null> {
  const serviceClient = getServiceRoleSupabaseClient();
  const bearer = parseBearerToken(request.headers.get('authorization'));
  const envToken = readCortexAiMcpEnvToken();

  if (bearer && envToken && matchesCortexAiMcpEnvToken(bearer, envToken)) {
    const actorUserId = await resolveFallbackAdminUserId();

    // No admin yet means nothing can be attributed — refuse rather than let writes
    // land with no author. The status route tells the agent to bootstrap first.
    if (!actorUserId) {
      return null;
    }

    return {
      actorFromOrphanedToken: false,
      actorUserId,
      scopes: ['read', 'write'],
      source: 'env-token',
    };
  }

  const settings = await resolveCortexAiMcpSettings(serviceClient);

  if (!settings.enabled) {
    return null;
  }

  if (bearer) {
    const verification = await verifyCortexAiMcpToken(serviceClient, bearer);

    if (!verification.valid) {
      return null;
    }

    // Bookkeeping only — never block the call on it.
    void touchCortexAiMcpToken(serviceClient, verification.token.id);

    return {
      actorFromOrphanedToken: !verification.token.created_by,
      actorUserId: verification.token.created_by ?? (await resolveFallbackAdminUserId()),
      scopes: verification.scopes,
      source: 'token',
    };
  }

  const adminUserId = await resolveAdminSessionUserId();

  if (adminUserId) {
    return {
      actorFromOrphanedToken: false,
      actorUserId: adminUserId,
      scopes: ['read', 'write'],
      source: 'admin-session',
    };
  }

  if (shouldTrustLocalMcpRequest({ hostHeader: request.headers.get('host'), settings })) {
    // Loopback trust is an explicit opt-in on a development machine, where anyone
    // who can reach this endpoint can already read the service-role key out of
    // .env.local. Not treated as orphaned: it grants nothing new.
    return {
      actorFromOrphanedToken: false,
      actorUserId: await resolveFallbackAdminUserId(),
      scopes: ['read', 'write'],
      source: 'localhost',
    };
  }

  return null;
}

/**
 * Every mutating Cortex executor calls `getActorUserId()` and throws without one, so a
 * connection with no identity behind it can read but never write. Two connections have
 * that problem: localhost trust (nobody signed in) and a token whose creator was since
 * deleted (`created_by` is `ON DELETE SET NULL`).
 *
 * Rather than advertise a `write` scope those connections cannot actually use, fall back
 * to an ADMIN profile so the write is attributed to a real person in Revision History.
 * This grants no new authority — reaching here already required either loopback in
 * development or a valid admin-minted token — it only supplies the author field.
 *
 * `id` ordering is arbitrary but stable, which is what matters: the same fallback admin
 * every time, so revision authorship does not jump between people run to run.
 */
async function resolveFallbackAdminUserId(): Promise<string | null> {
  try {
    const { data } = await getServiceRoleSupabaseClient()
      .from('profiles')
      .select('id')
      .eq('role', 'ADMIN')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    return data?.id ?? null;
  } catch {
    return null;
  }
}

async function resolveAdminSessionUserId(): Promise<string | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return null;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    return profile?.role === 'ADMIN' ? user.id : null;
  } catch {
    return null;
  }
}

function buildToolContext(auth: McpAuth): CortexMcpToolContext {
  return {
    actorFromOrphanedToken: auth.actorFromOrphanedToken,
    actorUserId: auth.actorUserId,
    importExternalImage: createMcpImageImporter(auth.actorUserId),
    // No open editor over MCP: tools that need a target take it in their arguments
    // (`cmsTarget`, `slug`, `entityId`) rather than inheriting one from a UI.
    pageContext: null,
    recordRevision: createMcpRevisionRecorder(auth.actorUserId),
    // Tools revalidate the public path they changed. The cached page/post reads
    // (lib/public-content-cache.ts) are evicted by tag as well, because a path call
    // cannot know a page's aliases — any homepage variant is also served at "/".
    revalidatePath: (path: string, type?: 'layout' | 'page') => {
      revalidatePath(path, type);
      revalidatePublicContent('pages');
      revalidatePublicContent('posts');
    },
    skipConfirmation: MCP_SKIP_CONFIRMATION,
    supabase: getServiceRoleSupabaseClient(),
    validateBlockContent,
  };
}

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

/**
 * 401 for an unauthenticated caller.
 *
 * The `WWW-Authenticate` value is intentionally bare. Adding a `resource_metadata`
 * parameter would advertise RFC 9728 OAuth discovery, and Claude Code responds to
 * that by starting an OAuth flow — which dead-ends against a static-token server.
 * A plain challenge tells the client "send a bearer token" and nothing more.
 */
function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    headers: {
      ...JSON_HEADERS,
      'WWW-Authenticate': 'Bearer realm="NextBlock Cortex AI MCP"',
    },
    status: 401,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isOriginAllowed(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed.' }), {
      headers: JSON_HEADERS,
      status: 403,
    });
  }

  // The proxy lets this route through before the instance is set up (so agents get a
  // real answer instead of a redirect to the wizard); say so plainly when nothing can
  // work yet.
  if (!isSupabaseConfigured()) {
    return new Response(
      JSON.stringify({
        error: 'This NextBlock instance is not configured yet. Poll GET /api/setup/status until it reports initialized.',
      }),
      { headers: { ...JSON_HEADERS, 'Retry-After': '5' }, status: 503 }
    );
  }

  // A key seeded through NEXTBLOCK_LICENSE_KEY is activated on first use; a cached
  // no-op read when there is nothing to do.
  if (isFullyConfigured()) {
    await ensureEnvLicenseActivation();
  }

  const isCortexAiActive = await verifyPackageOnline(CORTEX_AI_PACKAGE_ID);

  if (!isCortexAiActive) {
    return new Response(
      JSON.stringify({ error: 'NextBlock Cortex AI is not active for this workspace.' }),
      { headers: JSON_HEADERS, status: 403 }
    );
  }

  const auth = await authenticateMcpRequest(request);

  if (!auth) {
    return unauthorized(
      'A valid NextBlock MCP access token is required. Generate one in CMS Settings → Cortex AI and confirm the MCP server is enabled there, or set MCP_BEARER_TOKEN in the environment (and make sure the first administrator exists — see GET /api/setup/status).'
    );
  }

  let message: JsonRpcMessage;

  try {
    message = (await request.json()) as JsonRpcMessage;
  } catch {
    return new Response(
      JSON.stringify({
        error: { code: -32700, message: 'Parse error: request body is not valid JSON.' },
        id: null,
        jsonrpc: '2.0',
      }),
      { headers: JSON_HEADERS, status: 400 }
    );
  }

  const response = await handleCortexMcpMessage(message, {
    context: buildToolContext(auth),
    scopes: auth.scopes,
    serverVersion: SERVER_VERSION,
  });

  // Notifications and responses: 202 Accepted with no body. Returning a JSON-RPC
  // envelope for a message that carried no `id` desyncs strict clients.
  if (response.body === null) {
    return new Response(null, { status: response.status });
  }

  return new Response(JSON.stringify(response.body), {
    headers: JSON_HEADERS,
    status: response.status,
  });
}

/**
 * The optional server→client SSE stream.
 *
 * This server never initiates requests or pushes unsolicited notifications — every
 * response is returned inline on the POST — so there is nothing to stream. The spec
 * explicitly permits answering the GET with 405 in that case.
 */
export function GET(): Response {
  return new Response(
    JSON.stringify({
      error:
        'This MCP endpoint does not offer a server-initiated SSE stream. Send JSON-RPC messages via POST.',
    }),
    { headers: { ...JSON_HEADERS, Allow: 'POST, DELETE, OPTIONS' }, status: 405 }
  );
}

/** Session termination. The server is stateless, so there is no session to tear down. */
export function DELETE(): Response {
  return new Response(null, { status: 204 });
}

export function OPTIONS(): Response {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name',
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      Allow: 'POST, DELETE, OPTIONS',
    },
    status: 204,
  });
}
