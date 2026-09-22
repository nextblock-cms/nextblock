/**
 * The copy-paste configuration for every MCP client NextBlock documents.
 *
 * Shared by the MCP settings card and the first-run setup wizard so the two can
 * never disagree about a field name (Claude Code silently skips a server entry
 * without `type`; VS Code wants `servers`, not `mcpServers`; Codex reads TOML).
 */

export const MCP_TOKEN_PLACEHOLDER = 'YOUR_TOKEN';

export type McpClientId = 'claude-code' | 'claude-code-vscode' | 'claude-desktop' | 'cursor' | 'vscode' | 'codex';

export const MCP_CLIENTS: ReadonlyArray<readonly [McpClientId, string]> = [
  ['claude-code', 'Claude Code (terminal)'],
  ['claude-code-vscode', 'Claude Code in VS Code'],
  ['claude-desktop', 'Claude Desktop'],
  ['cursor', 'Cursor'],
  ['vscode', 'VS Code (Copilot)'],
  ['codex', 'Codex (ChatGPT plans)'],
];

/**
 * The Claude Code VS Code extension has no config file to paste: its "Add MCP server"
 * dialog asks for these fields one by one, so they are offered as separate values.
 */
export type McpClaudeCodeExtensionFields = {
  /** Value for the "Headers (Header-Name: value, one per line)" box; empty under localhost trust. */
  headers: string;
  name: string;
  /** The transport option to pick in the dialog. */
  transport: 'HTTP (remote)';
  url: string;
};

export type McpClientSnippets = {
  claudeCode: string;
  claudeCodeCli: string;
  claudeCodeExtension: McpClaudeCodeExtensionFields;
  claudeDesktop: string;
  /**
   * `~/.codex/config.toml`, shared by the ChatGPT desktop app's Codex mode, the Codex CLI and
   * its IDE extension. ChatGPT's regular chat (web or desktop) never reads it: its connectors
   * are OAuth-only.
   */
  codex: string;
  cursor: string;
  vscode: string;
};

/** A TOML basic string: every escape JSON emits (`\"`, `\\`, `\n`, `\u0000`) is valid TOML too. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildMcpClientSnippets(params: {
  /** The bearer token to bake in; the placeholder when none has been minted yet. */
  token: string | null;
  url: string;
  /**
   * Loopback connection covered by localhost trust: the snippets must carry NO
   * Authorization header, because the route rejects an invalid bearer outright
   * rather than falling back to localhost trust.
   */
  usesLocalhostTrust: boolean;
}): McpClientSnippets {
  const { url, usesLocalhostTrust } = params;
  const token = params.token ?? MCP_TOKEN_PLACEHOLDER;
  const authHeader = usesLocalhostTrust ? undefined : { Authorization: `Bearer ${token}` };

  const claudeCode = JSON.stringify(
    {
      mcpServers: {
        nextblock: {
          ...(authHeader ? { headers: authHeader } : {}),
          type: 'http',
          url,
        },
      },
    },
    null,
    2
  );

  const cursor = JSON.stringify(
    {
      mcpServers: {
        nextblock: {
          ...(authHeader ? { headers: authHeader } : {}),
          url,
        },
      },
    },
    null,
    2
  );

  const vscode = JSON.stringify(
    usesLocalhostTrust
      ? { servers: { nextblock: { type: 'http', url } } }
      : {
          inputs: [
            {
              description: 'NextBlock MCP access token',
              id: 'nextblockToken',
              password: true,
              type: 'promptString',
            },
          ],
          servers: {
            nextblock: {
              headers: { Authorization: 'Bearer ${input:nextblockToken}' },
              type: 'http',
              url,
            },
          },
        },
    null,
    2
  );

  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        nextblock: {
          args: [
            '-y',
            'mcp-remote',
            url,
            ...(usesLocalhostTrust ? [] : ['--header', `Authorization: Bearer ${token}`]),
          ],
          command: 'npx',
        },
      },
    },
    null,
    2
  );

  const codex = [
    '[mcp_servers.nextblock]',
    `url = ${tomlString(url)}`,
    ...(usesLocalhostTrust ? [] : [`http_headers = { "Authorization" = ${tomlString(`Bearer ${token}`)} }`]),
  ].join('\n');

  const claudeCodeCli = usesLocalhostTrust
    ? `claude mcp add --transport http nextblock ${url}`
    : `claude mcp add --transport http nextblock ${url} --header "Authorization: Bearer ${token}"`;

  const claudeCodeExtension: McpClaudeCodeExtensionFields = {
    headers: usesLocalhostTrust ? '' : `Authorization: Bearer ${token}`,
    name: 'nextblock',
    transport: 'HTTP (remote)',
    url,
  };

  return { claudeCode, claudeCodeCli, claudeCodeExtension, claudeDesktop, codex, cursor, vscode };
}
