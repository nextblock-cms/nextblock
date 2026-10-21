import { describe, expect, it } from 'vitest';

import { createCortexGlobalAgentTools } from './ai-global-agent-tools';
import { handleCortexMcpMessage } from './mcp-server';
import { CORTEX_MCP_TOOL_KINDS } from './mcp-tool-kinds';

/**
 * 2026-10-21: an MCP token acts as the account that minted it, and only the site and
 * theming tools re-checked that account's role. A token minted by an admin who was later
 * demoted kept every content, navigation, media and database write. The factory now wraps
 * every tool not classified `read` in an ADMIN check that runs before the executor.
 */

function stubSupabase(role: string | null) {
  const touched: string[] = [];
  const supabase = {
    from(table: string) {
      touched.push(table);
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'in', 'ilike', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete']) {
        chain[method] = () => chain;
      }
      chain['maybeSingle'] = async () => ({
        data: table === 'profiles' && role ? { role } : null,
        error: null,
      });
      chain['single'] = chain['maybeSingle'];
      chain['then'] = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      return chain;
    },
  };

  return { supabase, touched };
}

const toolOptions = { messages: [], toolCallId: 'call-1' } as never;

const writeToolNames = Object.entries(CORTEX_MCP_TOOL_KINDS)
  .filter(([, kind]) => kind === 'write')
  .map(([name]) => name);

describe('Cortex tool factory: ADMIN re-check on every write tool', () => {
  it('refuses every write tool for a WRITER before the executor touches anything', async () => {
    for (const name of writeToolNames) {
      const { supabase, touched } = stubSupabase('WRITER');
      const tools = createCortexGlobalAgentTools({ actorUserId: 'writer-1', skipConfirmation: true, supabase });
      const execute = tools[name]?.execute;

      expect(typeof execute, name).toBe('function');
      await expect(execute?.({}, toolOptions), name).rejects.toThrow(/requires the ADMIN role/);
      expect(touched, name).toEqual(['profiles']);
    }
  });

  it('refuses every write tool without an actor or for an orphaned token', async () => {
    for (const name of writeToolNames) {
      const anonymous = createCortexGlobalAgentTools({ skipConfirmation: true, supabase: stubSupabase('ADMIN').supabase });
      await expect(anonymous[name]?.execute?.({}, toolOptions), name).rejects.toThrow(/requires a known CMS user/);

      const orphaned = createCortexGlobalAgentTools({
        actorFromOrphanedToken: true,
        actorUserId: 'admin-1',
        skipConfirmation: true,
        supabase: stubSupabase('ADMIN').supabase,
      });
      await expect(orphaned[name]?.execute?.({}, toolOptions), name).rejects.toThrow(/no longer exists/);
    }
  });

  it('leaves read tools unwrapped', async () => {
    const tools = createCortexGlobalAgentTools({ supabase: stubSupabase(null).supabase });
    const result = await tools['describe_database_schema']?.execute?.({}, toolOptions);

    expect(result).toMatchObject({ success: true });
  });

  it('refuses a write over MCP when the token creator is no longer an ADMIN', async () => {
    const { supabase, touched } = stubSupabase('WRITER');
    const response = await handleCortexMcpMessage(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: { items: [{ label: 'Pwned', url: 'https://evil.example' }], languageCode: 'en', mode: 'append' },
          name: 'update_navigation_bar',
        },
      },
      {
        context: { actorUserId: 'writer-1', pageContext: null, skipConfirmation: true, supabase },
        scopes: ['read', 'write'],
        serverVersion: '1.0.0',
      }
    );
    const result = (response.body?.['result'] ?? null) as { content: Array<{ text: string }>; isError: boolean } | null;

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toMatch(/requires the ADMIN role/);
    expect(touched).toEqual(['profiles']);
  });
});
