import { NextResponse } from 'next/server';

import { collectReadinessReport } from '../../../../lib/setup/readiness-service';

/**
 * Public readiness probe for headless installs.
 *
 * `create-nextblock --non-interactive` and the coding agent driving it poll this route
 * until the instance can take MCP mutations, instead of guessing from log output. It
 * answers 200 once the instance is initialized (Supabase connected, schema applied, a
 * first admin exists) and 503 before that, always with the same JSON body, so a plain
 * `curl -f` loop works and the body explains what is still missing (`nextSteps`).
 *
 * The prefix `/api/setup` is exempt from the proxy's first-boot redirect, which is what
 * makes this reachable on an unprovisioned instance. It reveals only booleans and
 * generic guidance — never keys, tokens, or emails.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const report = await collectReadinessReport();

  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
      ...(report.initialized ? {} : { 'Retry-After': '3' }),
    },
    status: report.initialized ? 200 : 503,
  });
}
