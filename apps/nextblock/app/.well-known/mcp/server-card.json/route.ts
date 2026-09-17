import { NextResponse } from 'next/server';

import {
  CORTEX_MCP_PROMPTS,
  CORTEX_MCP_RESOURCES,
  buildCortexMcpToolDefinitions,
  readCortexAiMcpEnvToken,
  resolveCortexAiMcpSettings,
} from '@nextblock-cms/cortex';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { resolveSiteUrl } from '../../../../lib/site-url';

/**
 * /.well-known/mcp/server-card.json — a static description of this site's MCP server.
 *
 * Directories that crawl remote MCP servers (Smithery's scanner, for one) cannot complete
 * a `tools/list` behind a bearer-token wall, and NextBlock deliberately does not offer
 * OAuth discovery on `/api/mcp` (that would send Claude Code into a dead-end OAuth flow).
 * The card gives crawlers, and any agent that lands on the site, the same tool, resource
 * and prompt inventory an authenticated `tools/list` would return — descriptions and
 * input schemas, never data — plus how to authenticate.
 *
 * Served only where the MCP server is actually on (the database `enabled` flag or an
 * environment bootstrap token); otherwise 404, so a site that never opted in advertises
 * nothing. Built from the same registry the endpoint serves, so it cannot drift.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SERVER_VERSION = '1.0.0';

export async function GET(): Promise<Response> {
  let enabled = readCortexAiMcpEnvToken() !== null;

  if (!enabled) {
    try {
      enabled = (await resolveCortexAiMcpSettings(getServiceRoleSupabaseClient())).enabled;
    } catch {
      enabled = false;
    }
  }

  if (!enabled) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const siteUrl = resolveSiteUrl().replace(/\/+$/, '');

  return NextResponse.json(
    {
      serverInfo: {
        name: 'nextblock',
        title: 'NextBlock CMS',
        version: SERVER_VERSION,
        websiteUrl: 'https://nextblock.dev',
      },
      endpoint: { transport: 'streamable-http', url: `${siteUrl}/api/mcp` },
      authentication: {
        type: 'bearer',
        header: 'Authorization',
        instructions:
          'Create an MCP access token in the NextBlock CMS (Settings → Cortex AI → MCP server access) and send it as `Authorization: Bearer <token>`. Cortex AI must be active on the site.',
      },
      tools: buildCortexMcpToolDefinitions({ scopes: ['read', 'write'] }),
      resources: CORTEX_MCP_RESOURCES,
      prompts: CORTEX_MCP_PROMPTS,
    },
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=3600' } }
  );
}
