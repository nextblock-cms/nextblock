import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = resolve(__dirname, 'server-utils.ts');
// A fresh copy per test (afterEach resets modules), so the window stub and env stubs apply.
const load = () => import('./server-utils');

describe('server-utils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is not a "use server" module, so getEmailServerConfig() can never become a Server Action', () => {
    const source = readFileSync(SOURCE, 'utf8');
    // Strip comments, then look for a directive in the prologue.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trimStart();
    expect(code).not.toMatch(/^['"]use server['"]/);
  });

  it('refuses to load in a browser', async () => {
    vi.stubGlobal('window', {});
    await expect(load()).rejects.toThrow(/cannot be imported from a Client Component/);
  });

  it('hasEnvVars() accepts the key names the Vercel Supabase integration injects', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { hasEnvVars } = await load();
    await expect(hasEnvVars()).resolves.toBe(true);

    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', '');
    await expect(hasEnvVars()).resolves.toBe(false);
  });
});
