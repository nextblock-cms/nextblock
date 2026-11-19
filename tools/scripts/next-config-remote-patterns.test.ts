import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// apps/nextblock/next.config.js reads the environment once, when Next loads it: the image optimizer
// then fetches only URLs its remotePatterns allow, and `env` inlines the media base every
// resolveMediaUrl() display call builds on. With no NEXT_PUBLIC_R2_BASE_URL that base is Supabase
// Storage's public endpoint, and through 0.23.5 its host was allowed only on Supabase Cloud
// (`**.supabase.co`): a self-hosted Supabase answered every thumbnail with 400.

const requireFromHere = createRequire(__filename);
const CONFIG = path.resolve(__dirname, '../../apps/nextblock/next.config.js');
const { hasRemoteMatch } = requireFromHere('next/dist/shared/lib/match-remote-pattern.js') as {
  hasRemoteMatch: (domains: string[], patterns: unknown[], url: URL) => boolean;
};

/** Everything getRemotePatterns and computeSupabaseMediaBaseUrl read, blank unless a test sets it. */
const MEDIA_ENV = [
  'NEXT_PUBLIC_R2_BASE_URL',
  'NEXT_PUBLIC_R2_PUBLIC_URL',
  'NEXT_PUBLIC_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'STORAGE_PROVIDER',
  'STORAGE_BUCKET',
  'R2_BUCKET_NAME',
  'NEXTBLOCK_VERCEL_TOOLBAR_ENABLED',
  'DOCKER_BUILD',
];

type LoadedConfig = { env: Record<string, string | undefined>; images: { remotePatterns: unknown[] } };

function loadConfig(env: Record<string, string>): LoadedConfig {
  for (const name of MEDIA_ENV) vi.stubEnv(name, env[name] ?? '');
  delete requireFromHere.cache[CONFIG];
  return requireFromHere(CONFIG) as LoadedConfig;
}

const allows = (config: LoadedConfig, url: string) => hasRemoteMatch([], config.images.remotePatterns, new URL(url));

afterEach(() => {
  vi.unstubAllEnvs();
  delete requireFromHere.cache[CONFIG];
});

describe('next.config.js image remotePatterns', () => {
  const SELF_HOSTED = { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.org/', SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder' };

  it('allows the native Supabase Storage base it inlines for a self-hosted Supabase, and only its public bucket path', () => {
    const config = loadConfig(SELF_HOSTED);
    expect(config.env.NEXT_PUBLIC_R2_BASE_URL).toBe('https://supabase.example.org/storage/v1/object/public/media');
    expect(allows(config, 'https://supabase.example.org/storage/v1/object/public/media/uploads/hero.webp')).toBe(true);
    expect(allows(config, 'https://supabase.example.org/auth/v1/user')).toBe(false);
    expect(allows(config, 'https://supabase.example.org/storage/v1/object/public/other/x.webp')).toBe(false);
  });

  it('follows the bucket and the protocol of the URL, with any port', () => {
    const config = loadConfig({ ...SELF_HOSTED, NEXT_PUBLIC_SUPABASE_URL: 'http://storage.internal.example:8000', STORAGE_BUCKET: 'site-media' });
    expect(config.env.NEXT_PUBLIC_R2_BASE_URL).toBe('http://storage.internal.example:8000/storage/v1/object/public/site-media');
    expect(allows(config, 'http://storage.internal.example:8000/storage/v1/object/public/site-media/a.png')).toBe(true);
    expect(allows(config, 'https://storage.internal.example:8000/storage/v1/object/public/site-media/a.png')).toBe(false);
  });

  it('keeps an explicit NEXT_PUBLIC_R2_BASE_URL as the only media host it adds', () => {
    const config = loadConfig({ ...SELF_HOSTED, NEXT_PUBLIC_R2_BASE_URL: 'https://media.example.com' });
    expect(config.env.NEXT_PUBLIC_R2_BASE_URL).toBe('https://media.example.com');
    expect(allows(config, 'https://media.example.com/uploads/a.webp')).toBe(true);
    expect(allows(config, 'https://supabase.example.org/storage/v1/object/public/media/a.webp')).toBe(false);
  });

  it('adds no Supabase host when media lives in R2 or Supabase is not connected', () => {
    const r2 = loadConfig({ ...SELF_HOSTED, R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' });
    expect(allows(r2, 'https://supabase.example.org/storage/v1/object/public/media/a.webp')).toBe(false);
    const unconfigured = loadConfig({});
    expect(unconfigured.env.NEXT_PUBLIC_R2_BASE_URL).toBeUndefined();
    expect(allows(unconfigured, 'https://supabase.example.org/storage/v1/object/public/media/a.webp')).toBe(false);
    // Supabase Cloud stays covered by its wildcard either way.
    expect(allows(unconfigured, 'https://abc.supabase.co/storage/v1/object/public/media/a.webp')).toBe(true);
  });
});
