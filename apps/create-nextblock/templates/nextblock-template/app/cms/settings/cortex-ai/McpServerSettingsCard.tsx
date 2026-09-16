'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
} from '@nextblock-cms/ui';
import {
  AlertTriangle,
  Info,
  KeyRound,
  Lock,
  Plug,
  Plus,
  Trash2,
} from 'lucide-react';

import { CopyButton } from './CopySnippet';
import { McpClientConfigPanel } from './McpClientConfigPanel';
import { MCP_TOKEN_PLACEHOLDER, buildMcpClientSnippets, type McpClientId } from './mcp-client-snippets';
import {
  createMcpAccessTokenAction,
  revokeMcpAccessTokenAction,
  saveMcpSettingsAction,
  type McpAccessTokenSummary,
} from './mcp-actions';

type McpScope = 'read' | 'write';

type McpServerSettingsCardProps = {
  allowLocalhostWithoutToken: boolean;
  enabled: boolean;
  /** Loopback URL for a locally-running dev server. */
  localMcpUrl: string;
  /** The publicly reachable endpoint, derived from NEXT_PUBLIC_URL. */
  mcpUrl: string;
  /**
   * Locks every control that writes (the toggles, minting, revoking) while leaving
   * the endpoint, the client snippets, and the copy buttons fully usable.
   *
   * Used by the shared sandbox: a visitor must still be able to see that MCP access
   * exists and what connecting looks like, but the settings row and the token table
   * belong to every other visitor too. Hiding the card instead — which is what the
   * sandbox did before this — taught evaluators that NextBlock had no MCP support.
   */
  readOnly?: boolean;
  /** Explains the lock. Required in spirit whenever `readOnly` is set. */
  readOnlyNotice?: string;
  tokens: McpAccessTokenSummary[];
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

export function McpServerSettingsCard({
  allowLocalhostWithoutToken,
  enabled,
  localMcpUrl,
  mcpUrl,
  readOnly = false,
  readOnlyNotice,
  tokens,
}: McpServerSettingsCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [isEnabled, setIsEnabled] = useState(enabled);
  const [allowLocalhost, setAllowLocalhost] = useState(allowLocalhostWithoutToken);
  const [tokenName, setTokenName] = useState('');
  const [allowWrites, setAllowWrites] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeClient, setActiveClient] = useState<McpClientId>('claude-code');
  const [useLocalUrl, setUseLocalUrl] = useState(false);

  const url = useLocalUrl ? localMcpUrl : mcpUrl;

  // Once a token has been minted in this session, bake it into the snippets so the
  // admin can copy a config that actually works instead of hand-substituting.
  const tokenForSnippet = mintedToken ?? MCP_TOKEN_PLACEHOLDER;

  /**
   * Whether the generated snippets should carry an Authorization header at all.
   *
   * A loopback connection covered by localhost trust needs none — and must not send
   * one: the route verifies any bearer it receives and rejects an invalid value
   * outright rather than falling back to localhost trust, so pasting the literal
   * placeholder would 401 instead of silently working. Once a real token exists we
   * include it either way, since it works on both origins.
   */
  const usesLocalhostTrust = useLocalUrl && allowLocalhost && !mintedToken;

  // Shared with the setup wizard so the two can never disagree about a field name.
  const snippets = buildMcpClientSnippets({ token: tokenForSnippet, url, usesLocalhostTrust });

  // Belt-and-braces: the controls below are disabled in read-only mode, and the
  // server actions refuse sandbox writes on their own. These early returns just
  // mean a stray call from here can never even reach the network.
  function persistSettings(next: { allowLocalhostWithoutToken: boolean; enabled: boolean }) {
    if (readOnly) return;

    setError(null);
    startTransition(async () => {
      const result = await saveMcpSettingsAction(next);

      if (!result.success) {
        setError(result.error ?? 'Failed to save MCP settings.');
        // Snap the optimistic toggle back so the UI never claims a state the DB rejected.
        setIsEnabled(enabled);
        setAllowLocalhost(allowLocalhostWithoutToken);
        return;
      }

      router.refresh();
    });
  }

  function handleCreateToken() {
    if (readOnly) return;

    setError(null);
    setMintedToken(null);

    startTransition(async () => {
      const parsedDays = Number.parseInt(expiresInDays, 10);
      const result = await createMcpAccessTokenAction({
        expiresInDays: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : null,
        name: tokenName,
        scopes: allowWrites ? (['read', 'write'] as McpScope[]) : (['read'] as McpScope[]),
      });

      if (!result.success || !result.token) {
        setError(result.error ?? 'Failed to create the token.');
        return;
      }

      setMintedToken(result.token);
      setTokenName('');
      setExpiresInDays('');
      router.refresh();
    });
  }

  function handleRevoke(id: string) {
    if (readOnly) return;

    setError(null);
    startTransition(async () => {
      const result = await revokeMcpAccessTokenAction({ id });

      if (!result.success) {
        setError(result.error ?? 'Failed to revoke the token.');
        return;
      }

      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Plug className="h-4 w-4" />
            MCP server access
            <Badge variant={isEnabled ? 'default' : 'outline'} className="ml-0.5 font-normal">
              {isEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {isEnabled && tokens.length > 0 && (
              <Badge variant="secondary" className="font-normal">
                {tokens.length} active {tokens.length === 1 ? 'token' : 'tokens'}
              </Badge>
            )}
            {readOnly && (
              <Badge variant="outline" className="gap-1 font-normal">
                <Lock className="h-3 w-3" />
                Read-only
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            Expose this CMS to external AI clients over the Model Context Protocol. Claude Code,
            Claude Desktop, Cursor, and VS Code get the same typed Cortex tools the dashboard agent
            uses — building pages, editing blocks, querying analytics — from inside your editor.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {readOnly && readOnlyNotice && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Configured per install</AlertTitle>
            <AlertDescription className="text-xs">{readOnlyNotice}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {/* Toggles */}
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="mcp_enabled"
              checked={isEnabled}
              disabled={isPending || readOnly}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setIsEnabled(next);
                persistSettings({ allowLocalhostWithoutToken: allowLocalhost, enabled: next });
              }}
            />
            <div className="space-y-0.5">
              <Label htmlFor="mcp_enabled" className="text-sm font-medium">
                Enable the MCP server
              </Label>
              <p className="text-xs text-muted-foreground">
                While off, <span className="font-mono">/api/mcp</span> rejects every request. Off by
                default because this is a remote write surface onto your live content.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <Checkbox
              id="mcp_allow_localhost"
              checked={allowLocalhost}
              disabled={isPending || !isEnabled || readOnly}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setAllowLocalhost(next);
                persistSettings({ allowLocalhostWithoutToken: next, enabled: isEnabled });
              }}
            />
            <div className="space-y-0.5">
              <Label htmlFor="mcp_allow_localhost" className="text-sm font-medium">
                Trust localhost without a token
              </Label>
              <p className="text-xs text-muted-foreground">
                Convenience for local development only — it is ignored whenever{' '}
                <span className="font-mono">NODE_ENV=production</span>, so your deployed site always
                requires a token.
              </p>
            </div>
          </div>
        </div>

        {/* Endpoint */}
        <div className="space-y-1.5">
          <Label className="text-xs">Endpoint URL</Label>
          <div className="flex items-center gap-2">
            <Input readOnly value={url} className="font-mono text-xs" />
            <CopyButton value={url} />
          </div>
          {/* Active choice in `default` (primary): `secondary` is near-white in the CMS theme. */}
          <div className="flex gap-1.5 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant={useLocalUrl ? 'ghost' : 'default'}
              className="h-6 text-[11px]"
              onClick={() => setUseLocalUrl(false)}
            >
              Live site
            </Button>
            <Button
              type="button"
              size="sm"
              variant={useLocalUrl ? 'default' : 'ghost'}
              className="h-6 text-[11px]"
              onClick={() => setUseLocalUrl(true)}
            >
              Localhost
            </Button>
          </div>
        </div>

        {/* Token minting */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Access tokens</p>
            <p className="text-xs text-muted-foreground">
              Only the token&rsquo;s hash is stored, so it is shown once and cannot be recovered
              afterwards. A read-only token cannot even list the mutating tools.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label htmlFor="mcp_token_name" className="text-xs">
                Name
              </Label>
              <Input
                id="mcp_token_name"
                value={tokenName}
                maxLength={80}
                disabled={readOnly}
                placeholder="My laptop — Claude Code"
                onChange={(event) => setTokenName(event.target.value)}
              />
            </div>
            <div className="w-28 space-y-1.5">
              <Label htmlFor="mcp_token_expiry" className="text-xs">
                Expires (days)
              </Label>
              <Input
                id="mcp_token_expiry"
                type="number"
                min={1}
                max={3650}
                value={expiresInDays}
                disabled={readOnly}
                placeholder="Never"
                onChange={(event) => setExpiresInDays(event.target.value)}
              />
            </div>
            <div className="flex h-9 items-center gap-2">
              <Checkbox
                id="mcp_token_write"
                checked={allowWrites}
                disabled={readOnly}
                onCheckedChange={(checked) => setAllowWrites(checked === true)}
              />
              <Label htmlFor="mcp_token_write" className="text-xs">
                Allow writes
              </Label>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={isPending || readOnly || !tokenName.trim()}
              onClick={handleCreateToken}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create
            </Button>
          </div>

          {mintedToken && (
            <Alert>
              <KeyRound className="h-4 w-4" />
              <AlertTitle>Copy this token now</AlertTitle>
              <AlertDescription className="space-y-2">
                <p className="text-xs">
                  This is the only time it will be shown. The snippets below already include it.
                </p>
                <div className="flex items-center gap-2">
                  <Input readOnly value={mintedToken} className="font-mono text-xs" />
                  <CopyButton value={mintedToken} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          {tokens.length > 0 && (
            <div className="divide-y rounded-md border">
              {tokens.map((token) => {
                const lastUsed = formatDate(token.lastUsedAt);
                const expires = formatDate(token.expiresAt);

                return (
                  <div key={token.id} className="flex items-center justify-between gap-2 p-2.5">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{token.name}</span>
                        <Badge
                          variant={token.scopes.includes('write') ? 'secondary' : 'outline'}
                          className="font-normal"
                        >
                          {token.scopes.includes('write') ? 'read + write' : 'read only'}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        <span className="font-mono">{token.tokenPrefix}…</span>
                        {' · '}
                        {lastUsed ? `last used ${lastUsed}` : 'never used'}
                        {expires ? ` · expires ${expires}` : ''}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending || readOnly}
                      className="h-7 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => handleRevoke(token.id)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Revoke
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Client configuration */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Connect a client</p>
            <p className="text-xs text-muted-foreground">
              {usesLocalhostTrust
                ? 'No token needed: localhost trust covers this connection while the dev server runs. These snippets deliberately send no Authorization header — an invalid one would be rejected rather than falling back to localhost trust.'
                : mintedToken
                  ? 'These snippets include the token you just created.'
                  : readOnly
                    ? `This is the exact configuration you would paste on your own install, with ${MCP_TOKEN_PLACEHOLDER} standing in for the token you mint there.`
                    : `Create a token above and these snippets will fill it in; otherwise replace ${MCP_TOKEN_PLACEHOLDER}.`}
            </p>
          </div>

          <McpClientConfigPanel
            activeClient={activeClient}
            onActiveClientChange={setActiveClient}
            snippets={snippets}
            url={url}
          />
        </div>
      </CardContent>
    </Card>
  );
}
