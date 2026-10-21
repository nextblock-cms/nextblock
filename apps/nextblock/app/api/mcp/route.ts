import 'server-only';

import { revalidatePath } from 'next/cache';

import {
  createClient,
  getServiceRoleSupabaseClient,
  verifyPackageOnline,
} from '@nextblock-cms/db/server';
import { revalidatePublicContent } from '../../../lib/public-content-cache';
import {
  CORTEX_AI_PACKAGE_ID,
  buildCortexMcpDiscoveryDocument,
  handleCortexMcpMessage,
  isLocalhostHost,
  matchesCortexAiMcpEnvToken,
  parseBearerToken,
  readCortexAiMcpEnvToken,
  resolveCortexAiMcpSettings,
  resolveCortexAiMcpTokenActor,
  shouldTrustLocalMcpRequest,
  touchCortexAiMcpToken,
  verifyCortexAiMcpToken,
  wantsMcpEventStream,
  type CortexAiMcpScope,
  type CortexMcpToolContext,
  type JsonRpcMessage,
} from '@nextblock-cms/cortex';

import { validateBlockContent } from '../../../lib/blocks/blockRegistry';
import { ensureEnvLicenseActivation } from '../../../lib/packages/env-license';
import { evaluateTwoFactor } from '../../../lib/auth/twoFactor';
import {
  isForwardedPeerLoopback,
  isMcpLocalhostTrustOptedIn,
} from '../../../lib/cortex-ai/mcp-loopback-trust';
import { isFullyConfigured } from '../../../lib/setup/service-key';
import { hasResolvedSiteUrl, resolveSiteUrl } from '../../../lib/site-url';
import { importExternalImageAsActor } from '../../../lib/media/external-image-import';
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
  /**
   * The ADMIN this request acts as. For a minted token it is the token's creator,
   * re-checked on every request (`resolveCortexAiMcpTokenActor`): a token whose creator
   * was demoted or deleted is refused rather than handed a stand-in, because offboarding
   * someone is exactly when their credentials should lose power, not inherit someone
   * else's.
   */
  actorUserId: string | null;
  scopes: CortexAiMcpScope[];
  source: 'admin-session' | 'env-token' | 'localhost' | 'token';
};

/**
 * MCP has no cookie session, so the importer is handed the actor this request already
 * authenticated, through the server-only `importExternalImageAsActor` (never through the
 * `importExternalImageToMedia` server action, which takes no actor). Without it every
 * image import would fail, which silently strips the imagery out of any page or product
 * built over MCP, since executors treat an import failure as non-fatal.
 */
function createMcpImageImporter(actorUserId: string | null) {
  return async function importExternalImageForMcp(input: {
    url: string;
    altText?: string;
  }): Promise<{ id: string } | { error: string }> {
    if (!actorUserId) {
      return { error: 'Importing an image requires a known CMS user.' };
    }

    const result = await importExternalImageAsActor({
      actorUserId,
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
 *  3. Loopback in development — and only with an explicit environment opt-in.
 *     The `Host` header used to be the whole test, and `Host` is whatever the client
 *     or the proxy in front says it is: `Host: localhost` from the public internet
 *     opened a full read+write session on any instance running with a non-production
 *     `NODE_ENV`. The tokenless path now exists only when
 *     `NEXTBLOCK_MCP_TRUST_LOCALHOST=true` is set, the forwarded-peer headers (if any)
 *     name only loopback addresses, the dashboard setting is on, `NODE_ENV` is not
 *     production and `Host` is loopback. Without the variable, a developer's own
 *     machine needs a bearer token (`MCP_BEARER_TOKEN` or a minted one) or an admin
 *     session like anywhere else. See lib/cortex-ai/mcp-loopback-trust.ts.
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

    // The token acts as its creator, so the creator's CURRENT role decides, on every
    // request: a demoted or deleted admin's token stops working at once. A failed
    // lookup throws, and POST answers 503 rather than 401.
    const actorUserId = await resolveCortexAiMcpTokenActor(serviceClient, verification.token);

    if (!actorUserId) {
      return null;
    }

    // Bookkeeping only — never block the call on it.
    void touchCortexAiMcpToken(serviceClient, verification.token.id);

    return {
      actorUserId,
      scopes: verification.scopes,
      source: 'token',
    };
  }

  const adminUserId = await resolveAdminSessionUserId();

  if (adminUserId) {
    return {
      actorUserId: adminUserId,
      scopes: ['read', 'write'],
      source: 'admin-session',
    };
  }

  // Safer of the two options considered for mcp-localhost-host-spoof: rather than try to
  // recover the real socket peer (route handlers never see it, and Next fills
  // `x-forwarded-for` from the socket only when the client sent none, so a direct
  // caller can forge it), the tokenless path is OFF unless the operator sets
  // `NEXTBLOCK_MCP_TRUST_LOCALHOST=true`. The forwarded-peer check is defence in depth
  // for the proxied case, where the proxy appends the real client address.
  if (
    isMcpLocalhostTrustOptedIn() &&
    isForwardedPeerLoopback(request.headers, { isLocalhostHost }) &&
    shouldTrustLocalMcpRequest({ hostHeader: request.headers.get('host'), settings })
  ) {
    // Loopback trust is a double opt-in (NEXTBLOCK_MCP_TRUST_LOCALHOST in the
    // environment plus the dashboard setting) on a development machine, where anyone
    // who can reach this endpoint can already read the service-role key out of
    // .env.local. It grants nothing new.
    return {
      actorUserId: await resolveFallbackAdminUserId(),
      scopes: ['read', 'write'],
      source: 'localhost',
    };
  }

  return null;
}

/**
 * Every mutating Cortex executor requires an ADMIN actor, so a connection with no
 * identity behind it can read but never write. Two connections have none of their own:
 * localhost trust (nobody signed in) and the environment bootstrap token.
 *
 * Rather than advertise a `write` scope those connections cannot actually use, fall back
 * to an ADMIN profile so the write is attributed to a real person in Revision History.
 * This grants no new authority — reaching here already required either loopback in
 * development or the operator's own environment secret — it only supplies the author
 * field. A minted token never falls back: it acts as its creator or not at all.
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

    if (profile?.role !== 'ADMIN') {
      return null;
    }

    // The admin-session MCP path grants full read/write tool scope from a cookie session, so it
    // must require a satisfied second factor just like /cms does — otherwise an ADMIN session JWT
    // alone (first factor) drives the MCP tools against PostgREST's separate endpoint. An admin
    // with no factor enrolled still passes ('not_required'), matching the aal2-in-RLS posture.
    const twoFactor = await evaluateTwoFactor();
    if (twoFactor.status !== 'satisfied' && twoFactor.status !== 'not_required') {
      return null;
    }

    return user.id;
  } catch {
    return null;
  }
}

function buildToolContext(auth: McpAuth): CortexMcpToolContext {
  return {
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

/** 503 + Retry-After: "not now", never "not ever". */
function serviceUnavailable(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    headers: { ...JSON_HEADERS, 'Retry-After': '5' },
    status: 503,
  });
}

const ALLOWED_METHODS = 'GET, HEAD, POST, DELETE, OPTIONS';

/**
 * The absolute URL of this endpoint and of the server card, for the discovery document.
 *
 * Prefers the configured site URL (behind Vercel or a reverse proxy `request.url` is the
 * internal origin); falls back to the request origin so a fresh install with no
 * NEXT_PUBLIC_URL still answers with a URL that works for whoever is asking.
 */
function resolvePublicOrigin(request: Request): string {
  if (hasResolvedSiteUrl()) {
    return resolveSiteUrl().replace(/\/+$/, '');
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return resolveSiteUrl().replace(/\/+$/, '');
  }
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
  // work yet. The check is for the *service role*, not just the URL + anon key: every
  // path below (token lookup, the tool context) goes through
  // `getServiceRoleSupabaseClient()`, which throws without the secret key — and an
  // uncaught throw here is a 500 to a client that only needed to hear "not ready".
  if (!isFullyConfigured()) {
    return serviceUnavailable(
      'This NextBlock instance is not configured yet. Poll GET /api/setup/status until it reports initialized.'
    );
  }

  // A key seeded through NEXTBLOCK_LICENSE_KEY is activated on first use; a cached
  // no-op read when there is nothing to do.
  await ensureEnvLicenseActivation();

  const isCortexAiActive = await verifyPackageOnline(CORTEX_AI_PACKAGE_ID);

  if (!isCortexAiActive) {
    return new Response(
      JSON.stringify({ error: 'NextBlock Cortex AI is not active for this workspace.' }),
      { headers: JSON_HEADERS, status: 403 }
    );
  }

  let auth: McpAuth | null;

  try {
    auth = await authenticateMcpRequest(request);
  } catch (error) {
    // The token table or profiles being unreachable is an outage, not a bad credential:
    // say 503 + Retry-After so a well-behaved client backs off instead of dropping the
    // server as broken (a 500) or as misconfigured (a 401).
    console.error('Cortex AI MCP: authentication backend unavailable —', error);
    return serviceUnavailable('Authentication is temporarily unavailable. Retry shortly.');
  }

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
 * GET is two different requests wearing one method.
 *
 * An MCP client opening the optional server→client SSE stream sends
 * `Accept: text/event-stream` (a spec MUST). This server never initiates requests or
 * pushes unsolicited notifications — every response is returned inline on the POST — so
 * there is nothing to stream, and the spec explicitly permits answering that GET with
 * 405. Unchanged.
 *
 * Everything else that GETs this URL — a directory's health probe, an uptime monitor, a
 * person pasting the endpoint into a browser — is asking "is there an MCP server here?"
 * and used to be told 405 too, which several crawlers score as down. They now get a
 * small static discovery document: identity, protocol versions, capabilities, how to
 * authenticate, and where the full server card lives. It reads nothing and checks
 * nothing, so it cannot fail, and it discloses nothing an `initialize` would not.
 */
export function GET(request: Request): Response {
  if (wantsMcpEventStream(request.headers.get('accept'))) {
    return new Response(
      JSON.stringify({
        error:
          'This MCP endpoint does not offer a server-initiated SSE stream. Send JSON-RPC messages via POST.',
      }),
      { headers: { ...JSON_HEADERS, Allow: ALLOWED_METHODS }, status: 405 }
    );
  }

  const origin = resolvePublicOrigin(request);

  return new Response(
    JSON.stringify(
      buildCortexMcpDiscoveryDocument({
        endpointUrl: `${origin}/api/mcp`,
        serverCardUrl: `${origin}/.well-known/mcp/server-card.json`,
        serverVersion: SERVER_VERSION,
      })
    ),
    {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/json; charset=utf-8',
      },
      status: 200,
    }
  );
}

/** Same negotiation as GET, no body: what most health checkers actually send. */
export function HEAD(request: Request): Response {
  const full = GET(request);

  return new Response(null, { headers: full.headers, status: full.status });
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
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      Allow: ALLOWED_METHODS,
    },
    status: 204,
  });
}
