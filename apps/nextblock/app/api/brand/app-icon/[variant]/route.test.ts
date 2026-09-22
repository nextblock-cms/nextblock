import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppIconContext } from '../../../../../lib/branding/app-icon-context';

const mocks = vi.hoisted(() => ({
  isSupabaseConfigured: vi.fn(() => true),
  loadAppIconContext: vi.fn(),
}));

vi.mock('../../../../../lib/setup/env-status', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
}));
vi.mock('../../../../../lib/branding/app-icon-context', () => ({
  loadAppIconContext: mocks.loadAppIconContext,
}));
// No Data Cache outside Next: render on every call.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import { GET } from './route';

const VERSION = 'abc123def456';
const LOGO_CONTEXT: AppIconContext = {
  background: '#ffffff',
  source: { kind: 'logo', url: 'https://media.example.com/uploads/acme.svg', version: VERSION },
};
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#123456"/></svg>';

function call(variant: string, query = '') {
  const request = new NextRequest(`https://site.example.com/api/brand/app-icon/${variant}${query}`);
  return GET(request, { params: Promise.resolve({ variant }) });
}

describe('GET /api/brand/app-icon/[variant]', () => {
  beforeEach(() => {
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.loadAppIconContext.mockResolvedValue(LOGO_CONTEXT);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('404s an unknown variant', async () => {
    const response = await call('1024');
    expect(response.status).toBe(404);
  });

  it('redirects to the static icon while unconfigured, uncached', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false);
    const response = await call('512');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://site.example.com/favicon/android-chrome-512x512.png');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects to the static icon when the site has no logo of its own', async () => {
    mocks.loadAppIconContext.mockResolvedValue({ background: '#ffffff', source: { kind: 'default' } });
    const response = await call('maskable-512');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://site.example.com/favicon/maskable-512x512.png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  });

  it('serves the rendered PNG, immutable when ?v matches the current version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LOGO_SVG)));
    const response = await call('apple-180', `?v=${VERSION}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 180, height: 180 });
  });

  it('caches briefly when ?v is stale or missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LOGO_SVG)));

    expect((await call('192', '?v=000000000000')).headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=300'
    );
    expect((await call('192')).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  });

  it('falls back to the static icon, uncached, when the logo cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const response = await call('192', `?v=${VERSION}`);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://site.example.com/favicon/android-chrome-192x192.png');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('falls back when the logo is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>')));
    const response = await call('apple-180', `?v=${VERSION}`);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://site.example.com/favicon/apple-touch-icon.png');
  });
});
