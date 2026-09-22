import { describe, expect, it } from 'vitest';

import { DEFAULT_SITE_TITLE } from '../../app/lib/seo';
import {
  appIconHref,
  brandNameFromTitle,
  buildWebManifest,
  resolveAppIconSource,
  STATIC_APP_ICONS,
  type AppIconLogoLike,
} from './app-icon';

const BASE = 'https://media.example.com';
const WHITE = '#ffffff';

function logo(overrides: Partial<NonNullable<AppIconLogoLike['media']>> = {}, id = 'logo-1'): AppIconLogoLike {
  return {
    id,
    media: {
      id: 'media-1',
      object_key: 'uploads/acme-logo.avif',
      updated_at: '2026-09-01T00:00:00.000Z',
      variants: [],
      ...overrides,
    },
  };
}

describe('brandNameFromTitle', () => {
  it('keeps a title with no separator whole', () => {
    expect(brandNameFromTitle('NextBlock™ CMS')).toBe('NextBlock™ CMS');
    expect(brandNameFromTitle('Acme Bakery')).toBe('Acme Bakery');
  });

  it('takes the part before a space-padded pipe or dash', () => {
    expect(brandNameFromTitle('Acme Bakery | Fresh bread')).toBe('Acme Bakery');
    expect(brandNameFromTitle('Acme Bakery – Montréal')).toBe('Acme Bakery');
    expect(brandNameFromTitle('Acme — Fresh bread daily')).toBe('Acme');
    expect(brandNameFromTitle('Acme - Fresh bread')).toBe('Acme');
  });

  it('takes the part before a colon followed by whitespace', () => {
    expect(brandNameFromTitle('NextBlock™ CMS: Developer-First Headless CMS')).toBe('NextBlock™ CMS');
    expect(brandNameFromTitle('Acme: Fresh bread')).toBe('Acme');
  });

  it('never splits on bare hyphens, clock times or plain spaces', () => {
    expect(brandNameFromTitle('Rock-n-Roll Café')).toBe('Rock-n-Roll Café');
    expect(brandNameFromTitle('Café 10:30')).toBe('Café 10:30');
    expect(brandNameFromTitle('Acme -5% Sale')).toBe('Acme -5% Sale');
  });

  it('skips an empty leading segment', () => {
    expect(brandNameFromTitle('  | x')).toBe('x');
    expect(brandNameFromTitle('Acme |')).toBe('Acme');
  });

  it('falls back to the default site title for an empty title', () => {
    expect(brandNameFromTitle('')).toBe(DEFAULT_SITE_TITLE);
    expect(brandNameFromTitle('   ')).toBe(DEFAULT_SITE_TITLE);
    expect(brandNameFromTitle(null)).toBe(DEFAULT_SITE_TITLE);
  });

  it('does not truncate a long brand', () => {
    const long = 'The Extraordinarily Long Neighbourhood Bakery';
    expect(brandNameFromTitle(`${long} | Home`)).toBe(long);
  });
});

describe('resolveAppIconSource', () => {
  const options = { mediaBaseUrl: BASE, background: WHITE };

  it('is the default without a logo or media', () => {
    expect(resolveAppIconSource(null, options)).toEqual({ kind: 'default' });
    expect(resolveAppIconSource({ id: 'logo-1', media: null }, options)).toEqual({ kind: 'default' });
  });

  it('is the default for the bundled NextBlock logo', () => {
    expect(
      resolveAppIconSource(logo({ object_key: 'images/nextblock-logo-button-tiny.png' }), options)
    ).toEqual({ kind: 'default' });
    expect(resolveAppIconSource(logo({ object_key: 'images/nextblock-logo-small.webp' }), options)).toEqual({
      kind: 'default',
    });
  });

  it('is the default when the media URL is relative (no media host)', () => {
    expect(resolveAppIconSource(logo(), { mediaBaseUrl: '', background: WHITE })).toEqual({ kind: 'default' });
    expect(resolveAppIconSource(logo({ object_key: '/uploads/logo.png' }), options)).toEqual({ kind: 'default' });
  });

  it('renders an uploaded logo from its absolute URL', () => {
    const source = resolveAppIconSource(logo(), options);
    expect(source).toMatchObject({ kind: 'logo', url: `${BASE}/uploads/acme-logo.avif` });
    expect(source.kind === 'logo' && source.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never renders a URL outside the site media store (the server fetches it)', () => {
    for (const object_key of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://localhost:5432/logo.png',
      'https://media.example.com.evil.test/logo.png',
      'https://elsewhere.example/logo.png',
    ]) {
      expect(resolveAppIconSource(logo({ object_key }), options)).toEqual({ kind: 'default' });
    }
    // An absolute key that IS inside the store still renders.
    expect(resolveAppIconSource(logo({ object_key: `${BASE}/uploads/abs.png` }), options)).toMatchObject({
      kind: 'logo',
      url: `${BASE}/uploads/abs.png`,
    });
  });

  it('prefers the original upload over the AVIF derivative', () => {
    const source = resolveAppIconSource(
      logo({
        variants: [
          { objectKey: 'uploads/acme-logo-xlarge.avif', variantLabel: 'xlarge_avif' },
          { objectKey: 'uploads/acme-logo.svg', variantLabel: 'original_uploaded' },
        ],
      }),
      options
    );
    expect(source).toMatchObject({ kind: 'logo', url: `${BASE}/uploads/acme-logo.svg` });
  });

  it('changes version with the media row, the file and the background', () => {
    const version = (input: AppIconLogoLike, background = WHITE) => {
      const source = resolveAppIconSource(input, { mediaBaseUrl: BASE, background });
      return source.kind === 'logo' ? source.version : null;
    };
    const base = version(logo());

    expect(version(logo())).toBe(base);
    expect(version(logo({ updated_at: '2026-09-02T00:00:00.000Z' }))).not.toBe(base);
    expect(version(logo({ id: 'media-2' }))).not.toBe(base);
    expect(version(logo({}, 'logo-2'))).not.toBe(base);
    expect(version(logo(), 'hsl(222, 47%, 4%)')).not.toBe(base);
  });
});

describe('appIconHref', () => {
  it('links the static icons for the default source', () => {
    expect(appIconHref('apple-180', { kind: 'default' })).toBe(STATIC_APP_ICONS['apple-180']);
    expect(appIconHref('maskable-512', { kind: 'default' })).toBe('/favicon/maskable-512x512.png');
  });

  it('links the versioned route for a logo', () => {
    expect(appIconHref('192', { kind: 'logo', url: `${BASE}/a.png`, version: 'abc123def456' })).toBe(
      '/api/brand/app-icon/192?v=abc123def456'
    );
  });
});

describe('buildWebManifest', () => {
  it('declares id, scope and start_url as the site root, and the brand as both names', () => {
    const manifest = buildWebManifest({
      siteTitle: 'Acme Bakery | Fresh bread',
      siteDescription: 'Bread.',
      background: WHITE,
      source: { kind: 'default' },
    });

    expect(manifest).toMatchObject({
      id: '/',
      scope: '/',
      start_url: '/',
      name: 'Acme Bakery',
      short_name: 'Acme Bakery',
      description: 'Bread.',
      display: 'standalone',
      background_color: WHITE,
      theme_color: WHITE,
    });
  });

  it('lists 192 and 512 "any" icons plus a 512 maskable icon', () => {
    const { icons } = buildWebManifest({ siteTitle: 'Acme', background: WHITE, source: { kind: 'default' } });

    expect(icons).toEqual([
      { src: '/favicon/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/favicon/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/favicon/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('uses versioned icon URLs only for a custom logo', () => {
    const custom = buildWebManifest({
      siteTitle: 'Acme',
      background: WHITE,
      source: { kind: 'logo', url: `${BASE}/a.png`, version: 'abc123def456' },
    });

    expect(custom.icons?.map((icon) => icon.src)).toEqual([
      '/api/brand/app-icon/192?v=abc123def456',
      '/api/brand/app-icon/512?v=abc123def456',
      '/api/brand/app-icon/maskable-512?v=abc123def456',
    ]);
  });

  it('omits an empty description', () => {
    expect(
      buildWebManifest({ siteTitle: 'Acme', siteDescription: '', background: WHITE, source: { kind: 'default' } })
        .description
    ).toBeUndefined();
  });
});
