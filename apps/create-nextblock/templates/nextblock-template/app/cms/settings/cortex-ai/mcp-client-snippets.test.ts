import { describe, expect, it } from 'vitest';

import { MCP_TOKEN_PLACEHOLDER, buildMcpClientSnippets } from './mcp-client-snippets';

const url = 'https://example.com/api/mcp';

describe('buildMcpClientSnippets', () => {
  it('bakes the token into every client config and the CLI line', () => {
    const snippets = buildMcpClientSnippets({ token: 'nb_abc', url, usesLocalhostTrust: false });

    expect(JSON.parse(snippets.claudeCode)).toEqual({
      mcpServers: { nextblock: { headers: { Authorization: 'Bearer nb_abc' }, type: 'http', url } },
    });
    expect(JSON.parse(snippets.cursor)).toEqual({
      mcpServers: { nextblock: { headers: { Authorization: 'Bearer nb_abc' }, url } },
    });
    expect(JSON.parse(snippets.claudeDesktop).mcpServers.nextblock.args).toEqual([
      '-y',
      'mcp-remote',
      url,
      '--header',
      'Authorization: Bearer nb_abc',
    ]);
    expect(snippets.claudeCodeCli).toBe(
      `claude mcp add --transport http nextblock ${url} --header "Authorization: Bearer nb_abc"`
    );
    // VS Code prompts for the token instead of storing it.
    const vscode = JSON.parse(snippets.vscode);
    expect(vscode.servers.nextblock.headers.Authorization).toBe('Bearer ${input:nextblockToken}');
    expect(vscode.inputs[0].password).toBe(true);
  });

  it('falls back to the placeholder when no token exists', () => {
    const snippets = buildMcpClientSnippets({ token: null, url, usesLocalhostTrust: false });

    expect(snippets.claudeCodeCli).toContain(MCP_TOKEN_PLACEHOLDER);
  });

  it('sends no Authorization header at all under localhost trust', () => {
    const snippets = buildMcpClientSnippets({
      token: null,
      url: 'http://localhost:4200/api/mcp',
      usesLocalhostTrust: true,
    });

    expect(JSON.parse(snippets.claudeCode).mcpServers.nextblock).toEqual({
      type: 'http',
      url: 'http://localhost:4200/api/mcp',
    });
    expect(JSON.parse(snippets.vscode)).toEqual({
      servers: { nextblock: { type: 'http', url: 'http://localhost:4200/api/mcp' } },
    });
    expect(JSON.parse(snippets.claudeDesktop).mcpServers.nextblock.args).not.toContain('--header');
    expect(snippets.claudeCodeCli).not.toContain('Authorization');
  });
});
