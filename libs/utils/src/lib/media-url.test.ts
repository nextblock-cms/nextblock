import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPublicMediaBaseUrl,
  getSupabaseMediaBaseUrl,
  isBundledPublicMediaKey,
  resolveMediaUrl,
  resolveMediaUrlWithSupabaseFallback,
} from './media-url';

const BASE = 'https://media.example.com';
const BUNDLED_KEY = 'images/affiliates-square.webp';
const STORAGE_KEY = 'uploads/products/cover.webp';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveMediaUrl', () => {
  it('serves a bundled key from the app’s /images whatever the base', () => {
    expect(resolveMediaUrl(BUNDLED_KEY, BASE)).toBe('/images/affiliates-square.webp');
    expect(resolveMediaUrl(BUNDLED_KEY, '')).toBe('/images/affiliates-square.webp');
  });

  it('serves a bundled key from /images when NEXT_PUBLIC_R2_BASE_URL is set (the 02032 covers)', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);

    expect(resolveMediaUrl(BUNDLED_KEY)).toBe('/images/affiliates-square.webp');
    expect(resolveMediaUrlWithSupabaseFallback(BUNDLED_KEY)).toBe('/images/affiliates-square.webp');
  });

  it('joins a storage key to the base, with one slash between them', () => {
    expect(resolveMediaUrl(STORAGE_KEY, BASE)).toBe(`${BASE}/uploads/products/cover.webp`);
    expect(resolveMediaUrl(STORAGE_KEY, `${BASE}///`)).toBe(`${BASE}/uploads/products/cover.webp`);
    // A bucket key that happens to sit under images/ but is not a bundled file stays in the bucket.
    expect(resolveMediaUrl('images/uploaded-later.webp', BASE)).toBe(`${BASE}/images/uploaded-later.webp`);
  });

  it('joins a storage key to NEXT_PUBLIC_R2_BASE_URL by default', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', `${BASE}/`);

    expect(resolveMediaUrl(STORAGE_KEY)).toBe(`${BASE}/uploads/products/cover.webp`);
  });

  it('passes an absolute URL or a root-relative path through', () => {
    expect(resolveMediaUrl('https://cdn.example.org/a.webp', BASE)).toBe('https://cdn.example.org/a.webp');
    expect(resolveMediaUrl('http://localhost:9000/media/a.webp', BASE)).toBe('http://localhost:9000/media/a.webp');
    expect(resolveMediaUrl('/images/affiliates-square.webp', BASE)).toBe('/images/affiliates-square.webp');
  });

  it('treats a key that only starts with "http" as a storage key', () => {
    expect(resolveMediaUrl('httpd-logo.png', BASE)).toBe(`${BASE}/httpd-logo.png`);
  });

  it('returns the relative /key for a storage key when no base is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');

    expect(resolveMediaUrl(STORAGE_KEY)).toBe('/uploads/products/cover.webp');
    expect(resolveMediaUrl(STORAGE_KEY, '')).toBe('/uploads/products/cover.webp');
    expect(resolveMediaUrl(STORAGE_KEY, null)).toBe('/uploads/products/cover.webp');
  });

  it('returns null without a key', () => {
    expect(resolveMediaUrl(null, BASE)).toBeNull();
    expect(resolveMediaUrl(undefined, BASE)).toBeNull();
    expect(resolveMediaUrl('', BASE)).toBeNull();
  });
});

describe('getPublicMediaBaseUrl', () => {
  it('reads NEXT_PUBLIC_R2_BASE_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);

    expect(getPublicMediaBaseUrl()).toBe(BASE);
  });

  it('falls back to the runtime base <PublicEnvBootstrap> injects in the browser', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
    vi.stubGlobal('window', { __NEXTBLOCK_PUBLIC_ENV__: { r2Base: 'https://runtime.example.com' } });

    expect(getPublicMediaBaseUrl()).toBe('https://runtime.example.com');
    expect(resolveMediaUrl(STORAGE_KEY)).toBe('https://runtime.example.com/uploads/products/cover.webp');
  });

  it('prefers the inlined value over the runtime one', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);
    vi.stubGlobal('window', { __NEXTBLOCK_PUBLIC_ENV__: { r2Base: 'https://runtime.example.com' } });

    expect(getPublicMediaBaseUrl()).toBe(BASE);
  });

  it('is empty when neither is set', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
    vi.stubGlobal('window', {});

    expect(getPublicMediaBaseUrl()).toBe('');
  });
});

describe('resolveMediaUrlWithSupabaseFallback', () => {
  it('uses the public media base when one is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc.supabase.co');

    expect(resolveMediaUrlWithSupabaseFallback(STORAGE_KEY)).toBe(`${BASE}/uploads/products/cover.webp`);
  });

  it('falls back to Supabase Storage’s public media bucket without one', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc.supabase.co/');

    expect(resolveMediaUrlWithSupabaseFallback(STORAGE_KEY)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/media/uploads/products/cover.webp'
    );
    expect(resolveMediaUrlWithSupabaseFallback(BUNDLED_KEY)).toBe('/images/affiliates-square.webp');
  });

  it('returns the relative /key with neither base', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');

    expect(resolveMediaUrlWithSupabaseFallback(STORAGE_KEY)).toBe('/uploads/products/cover.webp');
    expect(getSupabaseMediaBaseUrl()).toBe('');
  });
});

describe('isBundledPublicMediaKey', () => {
  it('knows the bundled files and nothing else', () => {
    expect(isBundledPublicMediaKey(BUNDLED_KEY)).toBe(true);
    expect(isBundledPublicMediaKey('images/affiliate-demo-avatar.png')).toBe(true);
    expect(isBundledPublicMediaKey('uploads/products/affiliates-square.webp')).toBe(false);
    expect(isBundledPublicMediaKey('/images/affiliates-square.webp')).toBe(false);
    expect(isBundledPublicMediaKey(null)).toBe(false);
    expect(isBundledPublicMediaKey(undefined)).toBe(false);
  });
});
