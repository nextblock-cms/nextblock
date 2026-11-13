import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mediaBase: '' as string,
  mediaThrows: false,
  siteUrl: 'https://shop.example.com',
}));

// Only the pre-created constants contract (the rest of the lib is still being written). Loaded
// with vi.importActual, not import(): a dynamic import() of the lib would make Nx treat it as
// lazy-loaded and fail enforce-module-boundaries on every static import of it.
vi.mock('@nextblock-cms/affiliates', () => vi.importActual('../../../../libs/affiliates/src/lib/core/constants'));

vi.mock('../storage/provider', () => ({
  resolveMediaBaseUrl: () => {
    if (mocks.mediaThrows) throw new Error('boom');
    return mocks.mediaBase;
  },
}));

vi.mock('../site-url', () => ({
  resolveSiteUrl: () => mocks.siteUrl,
}));

import { getStorefrontImageOrigins, toStorefrontImageOrigin } from './image-origins';

const STOCK = ['https://images.pexels.com', 'https://images.unsplash.com', 'https://plus.unsplash.com'];

beforeEach(() => {
  mocks.mediaBase = '';
  mocks.mediaThrows = false;
  mocks.siteUrl = 'https://shop.example.com';
  vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_R2_PUBLIC_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('toStorefrontImageOrigin', () => {
  it('reduces a URL to its lowercase origin', () => {
    expect(toStorefrontImageOrigin('https://Media.Example.COM/bucket/path/?x=1')).toBe('https://media.example.com');
    expect(toStorefrontImageOrigin('https://cdn.example.com:8443/a')).toBe('https://cdn.example.com:8443');
    expect(toStorefrontImageOrigin('https://cdn.example.com:443/a')).toBe('https://cdn.example.com');
  });

  it('refuses non-https schemes, credentials and garbage', () => {
    expect(toStorefrontImageOrigin('http://media.example.com')).toBeNull();
    expect(toStorefrontImageOrigin('https://user:pass@media.example.com')).toBeNull();
    expect(toStorefrontImageOrigin('javascript:alert(1)')).toBeNull();
    expect(toStorefrontImageOrigin('data:image/png;base64,AAAA')).toBeNull();
    expect(toStorefrontImageOrigin('/images/a.webp')).toBeNull();
    expect(toStorefrontImageOrigin('')).toBeNull();
    expect(toStorefrontImageOrigin(null)).toBeNull();
  });

  it('allows plain http only for localhost, and only when asked', () => {
    expect(toStorefrontImageOrigin('http://localhost:9000/media', { allowLocalHttp: true })).toBe('http://localhost:9000');
    expect(toStorefrontImageOrigin('http://127.0.0.1:3000', { allowLocalHttp: true })).toBe('http://127.0.0.1:3000');
    expect(toStorefrontImageOrigin('http://[::1]:3000', { allowLocalHttp: true })).toBe('http://[::1]:3000');
    expect(toStorefrontImageOrigin('http://minio.localhost', { allowLocalHttp: true })).toBe('http://minio.localhost');
    expect(toStorefrontImageOrigin('http://localhost:9000/media')).toBeNull();
    expect(toStorefrontImageOrigin('http://evil.example.com', { allowLocalHttp: true })).toBeNull();
  });
});

describe('getStorefrontImageOrigins', () => {
  it('lists the media base, both R2 variables, the site and the stock hosts, de-duplicated', () => {
    mocks.mediaBase = 'https://pub-123.r2.dev';
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', 'https://pub-123.r2.dev/');
    vi.stubEnv('NEXT_PUBLIC_R2_PUBLIC_URL', 'https://Media.Shop.Example.com/assets');

    expect(getStorefrontImageOrigins()).toEqual([
      'https://pub-123.r2.dev',
      'https://media.shop.example.com',
      'https://shop.example.com',
      ...STOCK,
    ]);
  });

  it('includes the native Supabase storage origin when that is the media base', () => {
    mocks.mediaBase = 'https://abc.supabase.co/storage/v1/object/public/media';
    expect(getStorefrontImageOrigins()).toEqual(['https://abc.supabase.co', 'https://shop.example.com', ...STOCK]);
  });

  it('drops the local http fallbacks outside development', () => {
    mocks.siteUrl = 'http://localhost:3000';
    mocks.mediaBase = 'http://localhost:9000/media';
    vi.stubEnv('NODE_ENV', 'production');
    expect(getStorefrontImageOrigins()).toEqual(STOCK);
  });

  it('keeps localhost http origins in development', () => {
    mocks.siteUrl = 'http://localhost:3000';
    mocks.mediaBase = 'http://localhost:9000/media';
    vi.stubEnv('NODE_ENV', 'development');
    expect(getStorefrontImageOrigins()).toEqual(['http://localhost:9000', 'http://localhost:3000', ...STOCK]);
  });

  it('survives an unresolvable media base', () => {
    mocks.mediaThrows = true;
    expect(getStorefrontImageOrigins()).toEqual(['https://shop.example.com', ...STOCK]);
  });

  it('returns lowercase https origins only, never paths', () => {
    mocks.mediaBase = 'https://pub-123.r2.dev/some/prefix';
    for (const origin of getStorefrontImageOrigins()) {
      expect(origin).toBe(origin.toLowerCase());
      expect(origin).toMatch(/^https:\/\/[^/]+$/);
    }
  });
});
