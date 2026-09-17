import { describe, expect, it, vi } from 'vitest';

import {
  CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION,
  CORTEX_MCP_MODERN_PROTOCOL_VERSION,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  handleCortexMcpMessage,
  isModernEraMessage,
  type CortexMcpHandlerDeps,
} from './mcp-server';
import {
  CORTEX_MCP_TOOL_ALIASES,
  CORTEX_MCP_TOOL_KINDS,
  assertCortexMcpToolCoverage,
  buildCortexMcpToolDefinitions,
  callCortexMcpTool,
  cortexMcpScopesAllow,
  resolveCortexMcpToolName,
} from './mcp-tool-registry';
import {
  hashCortexAiMcpToken,
  isLocalhostHost,
  matchesCortexAiMcpEnvToken,
  mintCortexAiMcpToken,
  normalizeCortexAiMcpSettings,
  parseBearerToken,
  readCortexAiMcpEnvToken,
  shouldTrustLocalMcpRequest,
  verifyCortexAiMcpToken,
} from './mcp-tokens';

const deps = (overrides: Partial<CortexMcpHandlerDeps> = {}): CortexMcpHandlerDeps => ({
  scopes: ['read', 'write'],
  serverVersion: '1.0.0',
  ...overrides,
});

function resultOf(response: { body: Record<string, unknown> | null }) {
  return (response.body?.['result'] ?? null) as Record<string, any> | null;
}

function errorOf(response: { body: Record<string, unknown> | null }) {
  return (response.body?.['error'] ?? null) as { code: number; message: string } | null;
}

describe('MCP token utilities', () => {
  it('mints a prefixed token whose hash matches and whose plaintext is not derivable from the prefix', () => {
    const minted = mintCortexAiMcpToken();

    expect(minted.token.startsWith('nbmcp_')).toBe(true);
    expect(minted.tokenHash).toBe(hashCortexAiMcpToken(minted.token));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenPrefix.length).toBeLessThan(minted.token.length);
    expect(minted.token.startsWith(minted.tokenPrefix)).toBe(true);
  });

  it('mints distinct tokens', () => {
    const a = mintCortexAiMcpToken();
    const b = mintCortexAiMcpToken();

    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('parses bearer headers, including the bare-token form Claude Desktop users paste', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123');
    expect(parseBearerToken('bearer abc123')).toBe('abc123');
    expect(parseBearerToken('  Bearer   abc123  ')).toBe('abc123');
    expect(parseBearerToken('abc123')).toBe('abc123');
    expect(parseBearerToken('')).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });

  it('recognises loopback hosts with and without ports', () => {
    expect(isLocalhostHost('localhost')).toBe(true);
    expect(isLocalhostHost('localhost:3000')).toBe(true);
    expect(isLocalhostHost('127.0.0.1:3000')).toBe(true);
    expect(isLocalhostHost('[::1]:3000')).toBe(true);
    expect(isLocalhostHost('app.localhost')).toBe(true);
    expect(isLocalhostHost('example.com')).toBe(false);
    expect(isLocalhostHost('notlocalhost.com')).toBe(false);
    expect(isLocalhostHost(null)).toBe(false);
  });

  it('never trusts localhost in production, even with the setting on', () => {
    const settings = { allowLocalhostWithoutToken: true, enabled: true };

    try {
      vi.stubEnv('NODE_ENV', 'development');
      expect(shouldTrustLocalMcpRequest({ hostHeader: 'localhost:3000', settings })).toBe(true);
      expect(shouldTrustLocalMcpRequest({ hostHeader: 'example.com', settings })).toBe(false);

      vi.stubEnv('NODE_ENV', 'production');
      expect(shouldTrustLocalMcpRequest({ hostHeader: 'localhost:3000', settings })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not trust localhost when the setting is off', () => {
    try {
      vi.stubEnv('NODE_ENV', 'development');
      expect(
        shouldTrustLocalMcpRequest({
          hostHeader: 'localhost:3000',
          settings: { allowLocalhostWithoutToken: false, enabled: true },
        })
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults the MCP server to disabled so a fresh install exposes nothing', () => {
    expect(normalizeCortexAiMcpSettings(undefined).enabled).toBe(false);
    expect(normalizeCortexAiMcpSettings({ enabled: 'yes' }).enabled).toBe(false);
    expect(normalizeCortexAiMcpSettings({ enabled: true }).enabled).toBe(true);
  });

  it('rejects revoked and expired tokens', async () => {
    const minted = mintCortexAiMcpToken();
    const baseRow = {
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'admin-1',
      expires_at: null as string | null,
      id: 'token-1',
      last_used_at: null,
      name: 'Laptop',
      revoked_at: null as string | null,
      scopes: ['read', 'write'],
      token_prefix: minted.tokenPrefix,
    };

    const makeSupabase = (row: unknown) => ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
        }),
      }),
    });

    await expect(
      verifyCortexAiMcpToken(makeSupabase(baseRow) as any, minted.token)
    ).resolves.toMatchObject({ valid: true });

    await expect(
      verifyCortexAiMcpToken(
        makeSupabase({ ...baseRow, revoked_at: '2026-02-01T00:00:00.000Z' }) as any,
        minted.token
      )
    ).resolves.toEqual({ reason: 'revoked', valid: false });

    await expect(
      verifyCortexAiMcpToken(
        makeSupabase({ ...baseRow, expires_at: '2020-01-01T00:00:00.000Z' }) as any,
        minted.token
      )
    ).resolves.toEqual({ reason: 'expired', valid: false });

    await expect(
      verifyCortexAiMcpToken(makeSupabase(null) as any, minted.token)
    ).resolves.toEqual({ reason: 'unknown', valid: false });

    await expect(verifyCortexAiMcpToken(makeSupabase(baseRow) as any, 'short')).resolves.toEqual({
      reason: 'malformed',
      valid: false,
    });
  });
});

describe('MCP tool registry', () => {
  it('classifies every tool the agent registry actually exposes', () => {
    const coverage = assertCortexMcpToolCoverage();

    // A tool added to the agent but not classified here would be withheld from MCP;
    // a classification with no tool behind it is dead config. Both are bugs.
    expect(coverage.unclassified).toEqual([]);
    expect(coverage.missingFromRegistry).toEqual([]);
  });

  it('produces a valid JSON Schema object for every listed tool', () => {
    const definitions = buildCortexMcpToolDefinitions({ scopes: ['read', 'write'] });

    expect(definitions.length).toBeGreaterThan(0);

    for (const definition of definitions) {
      // MCP: inputSchema MUST be a JSON Schema object and MUST NOT be null.
      expect(definition.inputSchema).toBeTypeOf('object');
      expect(definition.inputSchema['type']).toBe('object');
      // $schema is stripped: MCP defines the dialect, and some clients reject the key.
      expect(definition.inputSchema['$schema']).toBeUndefined();
      // Tool names: 1-128 chars from [A-Za-z0-9_.-].
      expect(definition.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(JSON.stringify(definition)).toBeTypeOf('string');
    }
  });

  it('exposes every MCP-contract alias alongside its canonical tool', () => {
    const definitions = buildCortexMcpToolDefinitions({ scopes: ['read', 'write'] });
    const names = new Set(definitions.map((entry) => entry.name));

    for (const [alias, config] of Object.entries(CORTEX_MCP_TOOL_ALIASES)) {
      expect(names.has(alias)).toBe(true);
      expect(names.has(config.canonical)).toBe(true);
      expect(resolveCortexMcpToolName(alias)).toBe(config.canonical);
    }

    // The five names promised by the MCP integration contract.
    for (const required of [
      'get_database_schema',
      'generate_jsonb_layout',
      'query_site_analytics',
      'update_site_navigation',
      'search_stock_media',
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  it('gives an alias the same input schema as the tool it forwards to', () => {
    const definitions = buildCortexMcpToolDefinitions({ scopes: ['read', 'write'] });
    const byName = new Map(definitions.map((entry) => [entry.name, entry]));

    for (const [alias, config] of Object.entries(CORTEX_MCP_TOOL_ALIASES)) {
      expect(byName.get(alias)?.inputSchema).toEqual(byName.get(config.canonical)?.inputSchema);
    }
  });

  it('hides every mutating tool from a read-only token', () => {
    const readOnly = buildCortexMcpToolDefinitions({ scopes: ['read'] });

    for (const definition of readOnly) {
      expect(cortexMcpScopesAllow(['read'], definition.name)).toBe(true);
    }

    const writeNames = Object.entries(CORTEX_MCP_TOOL_KINDS)
      .filter(([, kind]) => kind === 'write')
      .map(([name]) => name);

    expect(writeNames.length).toBeGreaterThan(0);

    const readOnlyNames = new Set(readOnly.map((entry) => entry.name));
    for (const name of writeNames) {
      expect(readOnlyNames.has(name)).toBe(false);
    }

    // The alias for a mutating tool must be hidden too — otherwise the scope check
    // is trivially bypassed by calling the alias.
    expect(readOnlyNames.has('generate_jsonb_layout')).toBe(false);
    expect(readOnlyNames.has('update_site_navigation')).toBe(false);
    expect(readOnlyNames.has('get_database_schema')).toBe(true);
  });

  it('refuses a mutating call made with a read-only scope', async () => {
    await expect(
      callCortexMcpTool({ args: {}, name: 'update_navigation_bar', scopes: ['read'] })
    ).rejects.toThrow(/read-only/i);

    await expect(
      callCortexMcpTool({ args: {}, name: 'generate_jsonb_layout', scopes: ['read'] })
    ).rejects.toThrow(/read-only/i);
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      callCortexMcpTool({ args: {}, name: 'drop_all_tables', scopes: ['read', 'write'] })
    ).rejects.toThrow(/Unknown tool/);
  });

  it('reports argument validation failures as isError, not as a thrown protocol fault', async () => {
    const result = await callCortexMcpTool({
      // `table` is required by read_database_records.
      args: { limit: 'not-a-number' },
      name: 'read_database_records',
      scopes: ['read'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Invalid arguments/);
  });
});

describe('MCP JSON-RPC protocol', () => {
  it('answers initialize with capabilities and echoes a supported protocol version', async () => {
    const response = await handleCortexMcpMessage(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION },
      },
      deps()
    );

    const result = resultOf(response);

    expect(response.status).toBe(200);
    expect(result?.['protocolVersion']).toBe(CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION);
    expect(result?.['capabilities']).toMatchObject({ prompts: {}, resources: {}, tools: {} });
    expect(result?.['serverInfo']).toMatchObject({ name: 'nextblock-cortex-ai' });
  });

  it('falls back to a supported version rather than failing the handshake', async () => {
    const response = await handleCortexMcpMessage(
      { id: 1, jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      deps()
    );

    expect(resultOf(response)?.['protocolVersion']).toBe(
      CORTEX_MCP_LATEST_LEGACY_PROTOCOL_VERSION
    );
  });

  it('tells a read-only client so in the initialize instructions', async () => {
    const response = await handleCortexMcpMessage(
      { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} },
      deps({ scopes: ['read'] })
    );

    expect(String(resultOf(response)?.['instructions'])).toMatch(/READ-ONLY/);
  });

  it('answers a notification with 202 and no body', async () => {
    const response = await handleCortexMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      deps()
    );

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it('accepts and drops an inbound JSON-RPC response', async () => {
    const response = await handleCortexMcpMessage(
      { id: 7, jsonrpc: '2.0', result: {} } as any,
      deps()
    );

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it('lists tools', async () => {
    const response = await handleCortexMcpMessage(
      { id: 2, jsonrpc: '2.0', method: 'tools/list' },
      deps()
    );

    const tools = resultOf(response)?.['tools'] as Array<{ name: string }>;

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((entry) => entry.name)).toContain('get_database_schema');
  });

  it('lists fewer tools for a read-only scope', async () => {
    const all = await handleCortexMcpMessage(
      { id: 1, jsonrpc: '2.0', method: 'tools/list' },
      deps()
    );
    const readOnly = await handleCortexMcpMessage(
      { id: 1, jsonrpc: '2.0', method: 'tools/list' },
      deps({ scopes: ['read'] })
    );

    const allCount = (resultOf(all)?.['tools'] as unknown[]).length;
    const readCount = (resultOf(readOnly)?.['tools'] as unknown[]).length;

    expect(readCount).toBeGreaterThan(0);
    expect(readCount).toBeLessThan(allCount);
  });

  it('answers ping', async () => {
    const response = await handleCortexMcpMessage({ id: 3, jsonrpc: '2.0', method: 'ping' }, deps());

    expect(resultOf(response)).toEqual({});
  });

  it('returns a JSON-RPC error for an unknown method', async () => {
    const response = await handleCortexMcpMessage(
      { id: 4, jsonrpc: '2.0', method: 'does/not/exist' },
      deps()
    );

    expect(errorOf(response)?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it('turns an unknown tool into a JSON-RPC error but a bad argument into an isError result', async () => {
    const unknownTool = await handleCortexMcpMessage(
      { id: 5, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'nope' } },
      deps()
    );

    expect(errorOf(unknownTool)?.code).toBe(JSON_RPC_INVALID_PARAMS);

    const badArgs = await handleCortexMcpMessage(
      {
        id: 6,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { limit: 'nope' }, name: 'read_database_records' },
      },
      deps()
    );

    expect(errorOf(badArgs)).toBeNull();
    expect(resultOf(badArgs)?.['isError']).toBe(true);
  });

  it('requires params.name on tools/call', async () => {
    const response = await handleCortexMcpMessage(
      { id: 8, jsonrpc: '2.0', method: 'tools/call', params: {} },
      deps()
    );

    expect(errorOf(response)?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it('lists resources and rejects an unknown resource uri', async () => {
    const list = await handleCortexMcpMessage(
      { id: 9, jsonrpc: '2.0', method: 'resources/list' },
      deps()
    );

    expect((resultOf(list)?.['resources'] as unknown[]).length).toBeGreaterThan(0);

    const read = await handleCortexMcpMessage(
      { id: 10, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'cortex://nope' } },
      deps()
    );

    expect(errorOf(read)?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it('serves the static block-types resource without a database', async () => {
    const response = await handleCortexMcpMessage(
      { id: 11, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'cortex://schema/blocks' } },
      deps()
    );

    const contents = resultOf(response)?.['contents'] as Array<{ text: string }>;

    expect(JSON.parse(contents[0].text).blockTypes).toContain('section');
  });

  it('lists prompts and renders one with its arguments interpolated', async () => {
    const list = await handleCortexMcpMessage(
      { id: 12, jsonrpc: '2.0', method: 'prompts/list' },
      deps()
    );

    expect((resultOf(list)?.['prompts'] as unknown[]).length).toBeGreaterThan(0);

    const get = await handleCortexMcpMessage(
      {
        id: 13,
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: { arguments: { brief: 'A pricing page', slug: 'pricing' }, name: 'build-page' },
      },
      deps()
    );

    const messages = resultOf(get)?.['messages'] as Array<{ content: { text: string } }>;

    expect(messages[0].content.text).toContain('pricing');
    expect(messages[0].content.text).toContain('A pricing page');
  });

  it('rejects a batched (array) body — batching was removed from the spec', async () => {
    const response = await handleCortexMcpMessage([] as any, deps());

    expect(response.status).toBe(400);
    expect(errorOf(response)?.code).toBe(-32600);
  });

  it('detects the modern stateless era from the _meta envelope', () => {
    expect(
      isModernEraMessage({
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': CORTEX_MCP_MODERN_PROTOCOL_VERSION },
        },
      })
    ).toBe(true);

    expect(isModernEraMessage({ method: 'tools/list', params: {} })).toBe(false);
    expect(isModernEraMessage({ method: 'tools/list' }, '2025-11-25')).toBe(false);
    expect(isModernEraMessage({ method: 'tools/list' }, CORTEX_MCP_MODERN_PROTOCOL_VERSION)).toBe(
      true
    );
  });

  it('serves a modern-era tools/call identically — the server is stateless either way', async () => {
    const response = await handleCortexMcpMessage(
      {
        id: 14,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': CORTEX_MCP_MODERN_PROTOCOL_VERSION },
        },
      },
      deps()
    );

    expect((resultOf(response)?.['tools'] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('MCP environment bootstrap token', () => {
  it('reads the token only when it is long enough to be a real secret', () => {
    expect(readCortexAiMcpEnvToken({})).toBeNull();
    expect(readCortexAiMcpEnvToken({ MCP_BEARER_TOKEN: '   ' })).toBeNull();
    expect(readCortexAiMcpEnvToken({ MCP_BEARER_TOKEN: 'short-placeholder' })).toBeNull();
    expect(readCortexAiMcpEnvToken({ MCP_BEARER_TOKEN: ` ${'a'.repeat(64)} ` })).toBe('a'.repeat(64));
  });

  it('matches the presented bearer against the configured token in constant time', () => {
    const configured = 'f'.repeat(64);

    expect(matchesCortexAiMcpEnvToken(configured, configured)).toBe(true);
    expect(matchesCortexAiMcpEnvToken(` ${configured} `, configured)).toBe(true);
    expect(matchesCortexAiMcpEnvToken(`${configured}0`, configured)).toBe(false);
    expect(matchesCortexAiMcpEnvToken('e'.repeat(64), configured)).toBe(false);
    expect(matchesCortexAiMcpEnvToken(configured, null)).toBe(false);
    expect(matchesCortexAiMcpEnvToken(null, configured)).toBe(false);
  });

  it('never honours a configured token below the minimum length, even on an exact match', () => {
    expect(matchesCortexAiMcpEnvToken('tooshort', 'tooshort')).toBe(false);
  });
});
