import { NextResponse } from 'next/server';

/**
 * /.well-known/glama.json — proof of ownership for a Glama MCP Connector listing.
 *
 * Glama (glama.ai/mcp/connectors) lists remote MCP servers by their public URL and lets
 * the operator "claim" the listing by serving a token it hands out in the claim panel.
 * The token is not a secret in the usual sense (it is meant to be published), but it is
 * specific to one listing, so it comes from the environment of the instance being
 * listed — the vendor's own site — and every other NextBlock site answers 404.
 *
 * Schema: https://glama.ai/mcp/schemas/connector.json (the older `maintainers` form is
 * deprecated in favour of `claim`).
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

export function GET(): Response {
  const claim = process.env['GLAMA_CLAIM_TOKEN']?.trim();

  if (!claim || !/^glama_claim_[A-Za-z0-9_-]{32}$/.test(claim)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return NextResponse.json(
    { $schema: 'https://glama.ai/mcp/schemas/connector.json', claim },
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=3600' } }
  );
}
