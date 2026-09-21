import {
  CORTEX_MCP_PROMPTS,
  CORTEX_MCP_RESOURCES,
  CortexMcpForbiddenToolError,
  CortexMcpUnknownToolError,
  buildCortexMcpToolDefinitions,
  callCortexMcpTool,
  getCortexMcpPrompt,
  readCortexMcpResource,
  type CortexMcpToolContext,
} from './mcp-tool-registry';
import type { CortexAiMcpScope } from './mcp-tokens';

/**
 * JSON-RPC 2.0 engine for the Cortex AI MCP server.
 *
 * Transport-agnostic on purpose: it takes a parsed message and returns a status +
 * body, so the Next.js route handler stays a thin HTTP shim and this file is testable
 * without a server. It imports nothing from `next`.
 *
 * ## Why hand-rolled rather than @modelcontextprotocol/sdk
 *
 * The protocol surface a CMS tool server needs — initialize, tools/list, tools/call,
 * resources, prompts, ping — is small and entirely declarative. The v1 SDK pulls in
 * express, cors, hono and @hono/node-server, which is a lot of transitive weight for
 * a publishable premium lib that carries only a `next` peer dependency, and its
 * default transport class is built on Node's IncomingMessage/ServerResponse rather
 * than the Web Request/Response the App Router hands you.
 *
 * ## Dual-era
 *
 * The spec forked. `2026-07-28` is stateless: no `initialize` handshake, no session
 * id, protocol metadata rides in a `_meta` envelope on every request. Everything up
 * to `2025-11-25` is handshake-based. As of this writing every shipping client
 * (Claude Code, Claude Desktop, Cursor, VS Code) speaks the legacy era, so that path
 * has to work; the modern path is handled too so an upgraded client keeps working.
 * A dual-era server picks its behaviour from how the client opens — an `initialize`
 * request selects legacy, per-request `_meta` selects modern — which costs us
 * nothing here because the server is stateless either way.
 */

export const CORTEX_MCP_SERVER_NAME = 'nextblock-cortex-ai';
export const CORTEX_MCP_SERVER_TITLE = 'NextBlock Cortex AI';

/** What we answer an `initialize` with when the client asks for something we don't know. */
export const CORTEX_MCP_DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export const CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION = '2025-11-25';

export const CORTEX_MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';

export const CORTEX_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  CORTEX_MCP_MODERN_PROTOCOL_VERSION,
  CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

// JSON-RPC 2.0 reserved codes.
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = number | string | null;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
};

export type CortexMcpResponse = {
  /** HTTP status the transport should use. */
  status: number;
  /** `null` means "no body" — a 202 for a notification. */
  body: Record<string, unknown> | null;
};

export type CortexMcpHandlerDeps = {
  context?: CortexMcpToolContext;
  /** Instructions surfaced to the client at initialize time. */
  instructions?: string;
  scopes: readonly CortexAiMcpScope[];
  serverVersion: string;
};

function jsonRpcResult(id: JsonRpcId, result: Record<string, unknown>): CortexMcpResponse {
  return { body: { id, jsonrpc: '2.0', result }, status: 200 };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  data?: unknown
): CortexMcpResponse {
  return {
    body: {
      error: { code, message, ...(data === undefined ? {} : { data }) },
      id,
      jsonrpc: '2.0',
    },
    status,
  };
}

/** A notification (no `id`) gets 202 + empty body; replying with a result desyncs strict clients. */
const ACCEPTED: CortexMcpResponse = { body: null, status: 202 };

export function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === 'string' && message.id === undefined;
}

/**
 * True when the client is speaking the stateless 2026-07-28 era.
 *
 * Detected from the per-request `_meta` envelope the modern spec requires, with the
 * transport-supplied `MCP-Protocol-Version` header as a secondary signal.
 */
export function isModernEraMessage(
  message: JsonRpcMessage,
  protocolVersionHeader?: string | null
): boolean {
  const meta = message.params?.['_meta'];

  if (meta && typeof meta === 'object') {
    const version = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];

    if (typeof version === 'string' && version >= CORTEX_MCP_MODERN_PROTOCOL_VERSION) {
      return true;
    }
  }

  return Boolean(
    protocolVersionHeader && protocolVersionHeader >= CORTEX_MCP_MODERN_PROTOCOL_VERSION
  );
}

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested !== 'string' || !requested) {
    return CORTEX_MCP_DEFAULT_PROTOCOL_VERSION;
  }

  // Spec: echo the requested version if supported, otherwise answer with one we do
  // support. Never fail the handshake over a version string.
  return (CORTEX_MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION;
}

function buildInitializeResult(deps: CortexMcpHandlerDeps, requestedVersion: unknown) {
  const canWrite = deps.scopes.includes('write');

  return {
    capabilities: {
      // listChanged is deliberately absent: the tool set is static per token, so
      // advertising change notifications we never send would be a lie a client
      // could wait on.
      prompts: {},
      resources: {},
      tools: {},
    },
    instructions:
      deps.instructions ??
      [
        'NextBlock Cortex AI exposes this CMS through typed tools.',
        'Call get_database_schema first when you are unsure what exists.',
        'Conventions: a page or post feature_image_id renders as a full-width title banner above the content and is its share preview — give posts one, never the home page or a page with its own hero section (use update_site_identity social_image for the site-wide preview); mark hero sections is_hero:true; slider:true plus slides makes a carousel.',
        canWrite
          ? 'Page builds should go through generate_jsonb_layout, which stages a reviewable Live Draft rather than publishing directly.'
          : 'This connection is READ-ONLY. Mutating tools are not available on this token.',
      ].join(' '),
    protocolVersion: negotiateProtocolVersion(requestedVersion),
    serverInfo: {
      name: CORTEX_MCP_SERVER_NAME,
      title: CORTEX_MCP_SERVER_TITLE,
      version: deps.serverVersion,
      websiteUrl: 'https://nextblock.dev',
    },
  };
}

export type CortexMcpDiscoveryDocument = {
  authentication: {
    header: 'Authorization';
    instructions: string;
    required: true;
    schemes: ['bearer'];
  };
  capabilities: {
    prompts: Record<string, never>;
    resources: Record<string, never>;
    tools: Record<string, never>;
  };
  endpoint: { transport: 'streamable-http'; url: string };
  name: string;
  protocolVersions: readonly string[];
  serverCard: string;
  status: 'ok';
  title: string;
  version: string;
  websiteUrl: string;
};

/**
 * The document a plain `GET /api/mcp` (no `Accept: text/event-stream`) answers with.
 *
 * Directory crawlers, uptime monitors and people pasting the URL into a browser all GET
 * the endpoint before they ever POST `initialize`. A real MCP client opening the
 * server→client stream sends `Accept: text/event-stream` (a spec MUST), so the route can
 * tell the two apart and keep answering that one with 405. This one is static on
 * purpose: nothing here reads the database or checks a token, so it cannot fail, and it
 * reveals nothing an `initialize` would not — the tool inventory stays on the server
 * card, which is served only where the operator switched MCP on.
 */
export function buildCortexMcpDiscoveryDocument(params: {
  endpointUrl: string;
  serverCardUrl: string;
  serverVersion: string;
}): CortexMcpDiscoveryDocument {
  return {
    authentication: {
      header: 'Authorization',
      instructions:
        'POST JSON-RPC 2.0 messages with `Authorization: Bearer <token>`. Create the token in the NextBlock CMS (Settings → Cortex AI → MCP server access) or set MCP_BEARER_TOKEN in the environment. Cortex AI must be active on the site.',
      required: true,
      schemes: ['bearer'],
    },
    capabilities: { prompts: {}, resources: {}, tools: {} },
    endpoint: { transport: 'streamable-http', url: params.endpointUrl },
    name: CORTEX_MCP_SERVER_NAME,
    protocolVersions: CORTEX_MCP_SUPPORTED_PROTOCOL_VERSIONS,
    serverCard: params.serverCardUrl,
    status: 'ok',
    title: CORTEX_MCP_SERVER_TITLE,
    version: params.serverVersion,
    websiteUrl: 'https://nextblock.dev',
  };
}

/** True when the caller is an MCP client opening the optional server→client SSE stream. */
export function wantsMcpEventStream(acceptHeader: string | null | undefined): boolean {
  return Boolean(acceptHeader && acceptHeader.toLowerCase().includes('text/event-stream'));
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns 202/no-body for notifications and responses (which a server receives but
 * never answers), and a JSON-RPC envelope for requests.
 */
export async function handleCortexMcpMessage(
  message: JsonRpcMessage,
  deps: CortexMcpHandlerDeps
): Promise<CortexMcpResponse> {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    // Batching was removed in 2025-06-18; an array body is not a protocol we speak.
    return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Expected a single JSON-RPC message.', 400);
  }

  if (typeof message.method !== 'string') {
    // A JSON-RPC *response* (result/error, no method) — servers receive these for
    // requests they initiated. We never initiate any, so just accept and drop it.
    if ('result' in message || 'error' in message) {
      return ACCEPTED;
    }

    return jsonRpcError(message.id ?? null, JSON_RPC_INVALID_REQUEST, 'Missing "method".', 400);
  }

  const { method } = message;
  const id = message.id ?? null;
  const isNotification = isJsonRpcNotification(message);

  // Client-side lifecycle chatter. Acknowledge without a body.
  if (method.startsWith('notifications/')) {
    return ACCEPTED;
  }

  switch (method) {
    case 'initialize': {
      if (isNotification) {
        return ACCEPTED;
      }

      return jsonRpcResult(id, buildInitializeResult(deps, message.params?.['protocolVersion']));
    }

    case 'ping': {
      return isNotification ? ACCEPTED : jsonRpcResult(id, {});
    }

    case 'tools/list': {
      if (isNotification) {
        return ACCEPTED;
      }

      return jsonRpcResult(id, {
        tools: buildCortexMcpToolDefinitions({ context: deps.context, scopes: deps.scopes }),
      });
    }

    case 'tools/call': {
      if (isNotification) {
        return ACCEPTED;
      }

      const name = message.params?.['name'];

      if (typeof name !== 'string' || !name) {
        return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires params.name.');
      }

      try {
        const result = await callCortexMcpTool({
          args: message.params?.['arguments'],
          context: deps.context,
          name,
          scopes: deps.scopes,
        });

        return jsonRpcResult(id, result as unknown as Record<string, unknown>);
      } catch (error) {
        // Unknown tool and scope denial are protocol faults, not tool failures: the
        // model cannot fix them by retrying with different arguments, so they belong
        // in the JSON-RPC error channel rather than an isError result.
        if (
          error instanceof CortexMcpUnknownToolError ||
          error instanceof CortexMcpForbiddenToolError
        ) {
          return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, error.message);
        }

        return jsonRpcError(
          id,
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Tool execution failed.'
        );
      }
    }

    case 'resources/list': {
      if (isNotification) {
        return ACCEPTED;
      }

      return jsonRpcResult(id, { resources: CORTEX_MCP_RESOURCES });
    }

    case 'resources/templates/list': {
      return isNotification ? ACCEPTED : jsonRpcResult(id, { resourceTemplates: [] });
    }

    case 'resources/read': {
      if (isNotification) {
        return ACCEPTED;
      }

      const uri = message.params?.['uri'];

      if (typeof uri !== 'string' || !uri) {
        return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'resources/read requires params.uri.');
      }

      try {
        const contents = await readCortexMcpResource({ context: deps.context, uri });

        if (!contents) {
          return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown resource: ${uri}`);
        }

        return jsonRpcResult(id, { contents: [contents] });
      } catch (error) {
        return jsonRpcError(
          id,
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Resource read failed.'
        );
      }
    }

    case 'prompts/list': {
      return isNotification ? ACCEPTED : jsonRpcResult(id, { prompts: CORTEX_MCP_PROMPTS });
    }

    case 'prompts/get': {
      if (isNotification) {
        return ACCEPTED;
      }

      const name = message.params?.['name'];

      if (typeof name !== 'string' || !name) {
        return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'prompts/get requires params.name.');
      }

      const rawArgs = message.params?.['arguments'];
      const args: Record<string, string> = {};

      if (rawArgs && typeof rawArgs === 'object') {
        for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
          if (typeof value === 'string') {
            args[key] = value;
          }
        }
      }

      const prompt = getCortexMcpPrompt({ args, name });

      if (!prompt) {
        return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown prompt: ${name}`);
      }

      return jsonRpcResult(id, prompt as unknown as Record<string, unknown>);
    }

    default: {
      if (isNotification) {
        return ACCEPTED;
      }

      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}
