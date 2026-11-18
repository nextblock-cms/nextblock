import net from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The server client reads the request's cookies: outside a request, an empty jar.
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined, delete: () => undefined }),
}));

import { createClient as createServerSupabaseClient, getServiceRoleSupabaseClient } from './server';
import { getSsgSupabaseClient } from './ssg-client';
import {
  SUPABASE_NOT_CONFIGURED_CODE,
  UNCONFIGURED_SUPABASE_URL,
  unconfiguredSupabaseFetch,
} from './unconfigured';

// Every name a factory reads, so a developer's shell cannot configure a test by accident.
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
    throw new Error('unconfigured.test: a socket was opened');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One call per Supabase service, PostgREST through every method a caller uses. */
async function exerciseEveryService(client: SupabaseClient) {
  const queries = await Promise.all([
    client.from('pages').select('slug'), // GET: postgrest-js retries a failed one 3 times
    client.from('site_settings').select('value').eq('key', 'global_css').maybeSingle(),
    client.from('site_settings').select('value').eq('key', 'global_css').single(),
    client.from('pages').select('*', { count: 'exact', head: true }), // HEAD
    client.rpc('list_affiliate_storefronts', { p_limit: 1 }), // POST
    client.from('pages').insert({ slug: 'never-written' }),
  ]);
  const storage = await client.storage.from('media').list();
  const signIn = await client.auth.signInWithPassword({ email: 'owner@example.com', password: 'not-a-password' });
  const user = await client.auth.getUser();
  const fn = await client.functions.invoke('nextblock-migration-ingest');
  return { queries, storage, signIn, user, fn };
}

describe('an unconfigured Supabase client', () => {
  const factories: Array<[string, () => SupabaseClient]> = [
    ['getSsgSupabaseClient', getSsgSupabaseClient],
    ['createClient (server)', () => createServerSupabaseClient() as unknown as SupabaseClient],
  ];

  it.each(factories)('%s answers every service on the spot and opens no connection', async (_name, factory) => {
    const client = factory();
    const started = performance.now();
    const { queries, storage, signIn, user, fn } = await exerciseEveryService(client);

    for (const result of queries) {
      expect(result.data).toBeNull();
      expect(result.error).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE });
    }
    expect(storage.data).toBeNull();
    expect(storage.error?.message).toMatch(/Supabase is not configured/);
    expect(signIn.error).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE });
    // No session cookie or token to read: the user lookup never needs the network.
    expect(user.data.user).toBeNull();
    expect(fn.error).not.toBeNull();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
    // postgrest-js waits 1 s before it retries a GET; nothing here may have waited at all.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['a URL without a key', { NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL }],
    ['a key without a URL', { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key' }],
    ['the non-prefixed URL without a key', { SUPABASE_URL: PROJECT_URL }],
  ])('stays unconfigured on half an env (%s): nothing goes to the project', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    for (const [, factory] of factories) {
      const { error } = await factory().from('pages').select('slug');
      expect(error).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE });
    }
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
  });

  it('is built on a host that can never resolve', () => {
    const url = new URL(UNCONFIGURED_SUPABASE_URL);
    // RFC 2606 reserves `.invalid`: no resolver answers it, so no connection can follow.
    expect(url.hostname.endsWith('.invalid')).toBe(true);
    expect(url.hostname).not.toMatch(/supabase\.(?:co|in)$/);
  });

  it('answers with a status no Supabase client retries', async () => {
    const response = await unconfiguredSupabaseFetch(`${UNCONFIGURED_SUPABASE_URL}/rest/v1/pages`);
    // auth-js retries any 5xx, postgrest-js a 503 or 520; postgrest-js reads a 404 as an empty result.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(404);
    expect(await response.json()).toMatchObject({ code: SUPABASE_NOT_CONFIGURED_CODE, error_code: SUPABASE_NOT_CONFIGURED_CODE });
  });

  it('warns once per process, not once per call', async () => {
    vi.resetModules();
    const { getSsgSupabaseClient: freshSsgClient } = await import('./ssg-client');
    freshSsgClient();
    freshSsgClient();
    freshSsgClient();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('leaves the service-role client refusing to build without its env', () => {
    expect(() => getServiceRoleSupabaseClient()).toThrow(/Missing Supabase Service Role environment variables/);
  });
});

describe('a configured Supabase client', () => {
  it.each([
    ['the prefixed names', { NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key' }],
    ['the integration names', { SUPABASE_URL: PROJECT_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }],
  ])('queries the project through the global fetch (%s)', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const clients = [getSsgSupabaseClient(), createServerSupabaseClient() as unknown as SupabaseClient];
    for (const client of clients) {
      const { data, error } = await client.from('pages').select('slug');
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }

    expect(globalFetch).toHaveBeenCalledTimes(clients.length);
    for (const [input] of globalFetch.mock.calls) {
      expect(String(input).startsWith(`${PROJECT_URL}/rest/v1/pages`)).toBe(true);
    }
  });
});
