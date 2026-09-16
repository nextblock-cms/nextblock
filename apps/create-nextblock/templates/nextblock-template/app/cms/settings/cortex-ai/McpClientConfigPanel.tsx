'use client';

import { Alert, AlertDescription, AlertTitle, Button, Input, Label } from '@nextblock-cms/ui';
import { AlertTriangle } from 'lucide-react';

import { CopyButton, Snippet } from './CopySnippet';
import { MCP_CLIENTS, type McpClientId, type McpClientSnippets } from './mcp-client-snippets';

/**
 * The per-client "how to connect" block: a client picker and, for the chosen client,
 * either a copyable config snippet or (Claude Code's VS Code extension, which has no
 * config file) the values to type into its "Add MCP server" dialog.
 *
 * Shared by the MCP settings card and the setup wizard so a client is documented once.
 * The caller owns the picker state so it can persist across its own re-renders.
 */
export function McpClientConfigPanel({
  activeClient,
  onActiveClientChange,
  snippets,
  url,
}: {
  activeClient: McpClientId;
  onActiveClientChange: (client: McpClientId) => void;
  snippets: McpClientSnippets;
  /** The endpoint the snippets point at, for the prose that quotes it. */
  url: string;
}) {
  const extension = snippets.claudeCodeExtension;

  return (
    <div className="space-y-3">
      {/*
        The active tab is `default` (primary), not `secondary`: the CMS theme's
        secondary is Slate 100, which is invisible against the white card, and a site
        theme can set it to anything. Primary always contrasts with its foreground.
      */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="MCP client">
        {MCP_CLIENTS.map(([key, label]) => (
          <Button
            key={key}
            aria-selected={activeClient === key}
            className="h-7 text-xs"
            onClick={() => onActiveClientChange(key)}
            role="tab"
            size="sm"
            type="button"
            variant={activeClient === key ? 'default' : 'ghost'}
          >
            {label}
          </Button>
        ))}
      </div>

      {activeClient === 'claude-code' && (
        <div className="space-y-3">
          <Snippet code={snippets.claudeCodeCli} title="One-line CLI setup" />
          <Snippet code={snippets.claudeCode} title="…or add to .mcp.json in your project root" />
          <p className="text-[11px] text-muted-foreground">
            The <span className="font-mono">type</span> field is required — Claude Code skips a server
            entry that has a <span className="font-mono">url</span> but no{' '}
            <span className="font-mono">type</span>.
          </p>
        </div>
      )}

      {activeClient === 'claude-code-vscode' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            In the Claude Code panel open <span className="font-medium">MCP servers → Add MCP server</span>{' '}
            and fill the dialog with these values. Pick the scope you prefer: <em>Local</em> keeps it
            to you in this project, <em>User</em> makes it available in all your projects.
          </p>
          <dl className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
            <ExtensionField label="Name" value={extension.name} />
            <ExtensionField label="Transport" value={extension.transport} copyable={false} />
            <ExtensionField label="URL" value={extension.url} />
            <ExtensionField
              label="Headers"
              value={extension.headers}
              emptyHint="Leave empty: localhost trust covers this connection."
            />
          </dl>
        </div>
      )}

      {activeClient === 'claude-desktop' && (
        <div className="space-y-3">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Two options, and the easy one has a catch</AlertTitle>
            <AlertDescription className="text-xs">
              Settings &rarr; Connectors &rarr; Add custom connector accepts{' '}
              <span className="font-mono">{url}</span> directly (type{' '}
              <span className="font-mono">Bearer YOUR_TOKEN</span>, including the space, in the auth
              field) — but custom connectors dial out from Anthropic&rsquo;s cloud, so a localhost or
              firewalled site will not connect that way. Use the config below instead in that case; it
              bridges over stdio from your own machine.
            </AlertDescription>
          </Alert>
          <Snippet code={snippets.claudeDesktop} title="claude_desktop_config.json" />
        </div>
      )}

      {activeClient === 'cursor' && <Snippet code={snippets.cursor} title=".cursor/mcp.json" />}

      {activeClient === 'vscode' && (
        <div className="space-y-3">
          <Snippet code={snippets.vscode} title=".vscode/mcp.json" />
          <p className="text-[11px] text-muted-foreground">
            For GitHub Copilot&rsquo;s MCP support. VS Code uses <span className="font-mono">servers</span>{' '}
            at the top level, not <span className="font-mono">mcpServers</span>, and prompts for the token
            rather than storing it in the file. Using the Claude Code extension instead? Pick
            &ldquo;Claude Code in VS Code&rdquo; above.
          </p>
        </div>
      )}
    </div>
  );
}

function ExtensionField({
  copyable = true,
  emptyHint,
  label,
  value,
}: {
  copyable?: boolean;
  emptyHint?: string;
  label: string;
  value: string;
}) {
  const id = `mcp-ext-${label.toLowerCase()}`;

  return (
    <div className="grid gap-1 sm:grid-cols-[6rem_1fr_auto] sm:items-center sm:gap-2">
      <dt>
        <Label className="text-xs" htmlFor={id}>
          {label}
        </Label>
      </dt>
      <dd className="min-w-0">
        {value ? (
          <Input className="h-8 font-mono text-xs" id={id} readOnly value={value} />
        ) : (
          <p className="text-xs text-muted-foreground" id={id}>
            {emptyHint ?? '—'}
          </p>
        )}
      </dd>
      <dd className="sm:justify-self-end">{copyable && value ? <CopyButton value={value} /> : null}</dd>
    </div>
  );
}
