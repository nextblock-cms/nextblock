import 'server-only';

import { headers } from 'next/headers';

/**
 * The origin an external MCP client should dial.
 *
 * Prefers NEXT_PUBLIC_URL (the deployed canonical origin) and falls back to the
 * request's own host, so the snippet is correct on a preview deployment or a custom
 * domain that was never written into the env.
 */
export async function resolveSiteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_URL?.trim();

  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const headerList = await headers();
  const host = headerList.get('host');

  if (!host) {
    return 'https://your-site.com';
  }

  const protocol = headerList.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');

  return `${protocol}://${host}`;
}

/**
 * The loopback origin to show in the "Localhost" client snippets.
 *
 * Ports differ per setup — `nx serve nextblock` uses Nx's default 4200, not Next's
 * plain 3000 — and a snippet pointing at the wrong port fails with a bare connection
 * error that gives the reader nothing to go on. When this page is itself being viewed
 * over loopback, that request's own host is the authoritative answer.
 */
export async function resolveLocalOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get('host')?.trim();

  if (host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
    return `http://${host}`;
  }

  return 'http://localhost:4200';
}
