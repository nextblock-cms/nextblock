import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: <T>(fn: T) => fn }));

import { SUPABASE_NOT_CONFIGURED_CODE } from '@nextblock-cms/db/server';
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_KEYWORDS, DEFAULT_SITE_TITLE } from './seo';
import { createStaticSupabaseClient, getSiteSettings } from './site-settings';

// Every name the static client reads, so a developer's shell cannot configure a test by accident.
const SUPABASE_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
];
const PROJECT_URL = 'https://abcdefghijklmnopqrst.supabase.co';

let globalFetch: ReturnType<typeof vi.fn>;
let sockets: unknown[];

beforeEach(() => {
  for (const name of SUPABASE_ENV) vi.stubEnv(name, '');
  globalFetch = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', globalFetch);
  // Every TCP or TLS connection (fetch, a WebSocket, a raw socket) goes through Socket#connect.
  sockets = [];
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function refuse(this: net.Socket, ...args: unknown[]) {
    sockets.push(args[0]);
    throw new Error('site-settings.test: a socket was opened');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createStaticSupabaseClient', () => {
  it.each([
    ['no Supabase env', {}],
    ['a URL without any key', { NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL }],
    ['a key without a URL', { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' }],
  ])('answers "not configured" without a request on %s', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const supabase = createStaticSupabaseClient();
    const started = performance.now();

    const [list, single] = await Promise.all([
      supabase.from('languages').select('id, code'),
      supabase.from('site_settings').select('value').eq('key', 'footer_copyright').single(),
    ]);

    expect(list.error).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE });
    expect(single.error).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
    // postgrest-js waits 1 s before it retries a GET; nothing here may have waited at all.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads the project through the global fetch once the URL and a key are set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROJECT_URL);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');

    const { data, error } = await createStaticSupabaseClient().from('languages').select('id, code');

    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String(globalFetch.mock.calls[0][0]).startsWith(`${PROJECT_URL}/rest/v1/languages`)).toBe(true);
  });
});

describe('getSiteSettings', () => {
  it('serves the SEO defaults on an unconfigured install without a request', async () => {
    await expect(getSiteSettings()).resolves.toEqual({
      siteTitle: DEFAULT_SITE_TITLE,
      siteDescription: DEFAULT_SITE_DESCRIPTION,
      siteKeywords: DEFAULT_SITE_KEYWORDS,
      socialImage: null,
    });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
  });
});
