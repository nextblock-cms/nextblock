import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storefront social card: 404 without a published storefront, the approved snapshot only, and an
 * avatar fetched from nowhere but the deployment's own media origin — no redirects, bounded in time
 * and size, PNG/JPEG checked by content type and magic bytes.
 */

const mocks = vi.hoisted(() => ({
  page: null as unknown,
  pageError: null as unknown,
  responses: [] as Array<{ element: ReactElement; options: Record<string, unknown> }>,
}));

vi.mock('next/og', () => ({
  ImageResponse: class extends Response {
    constructor(element: ReactElement, options: Record<string, unknown>) {
      super('png', { status: 200, headers: { 'content-type': 'image/png' } });
      mocks.responses.push({ element, options });
    }
  },
}));
vi.mock('../../../../lib/storage/provider', () => ({ resolveMediaBaseUrl: () => 'https://media.example.com' }));
vi.mock('../../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop' }) }));
vi.mock('../../../../lib/affiliates/server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string) => string;
  };
  return {
    getServerAffiliatesCopy: async ({ locale, dictionary }: { locale?: string; dictionary: unknown }) =>
      runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary }),
  };
});
vi.mock('./storefront-loader', () => ({
  loadAffiliateStorefrontPage: async () => {
    if (mocks.pageError) throw mocks.pageError;
    return mocks.page;
  },
  getStorefrontMediaOrigins: () => new Set(['https://media.example.com']),
}));

import Image, { contentType, generateImageMetadata, size } from '../[handle]/opengraph-image';
import { STOREFRONT_CARD_AVATAR_MAX_BYTES, loadStorefrontCardAvatar } from './storefront-card-avatar';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const fetchMock = vi.fn();

function imageResponse(body: BodyInit | null, headers: Record<string, string>): Response {
  return new Response(body, { status: 200, headers });
}

function storefrontPage(avatarKey: string | null) {
  return {
    handle: 'jane-picks',
    siteUrl: 'https://shop.example.com',
    siteLocale: 'fr',
    storefront: {
      tier: { name: 'Founding Ambassador', nameTranslations: { fr: 'Ambassadeur fondateur' }, badgeColor: 'amber' },
      profile: { display_name: 'Jane Doe', avatar_object_key: avatarKey },
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mocks.page = storefrontPage(null);
  mocks.pageError = null;
  mocks.responses = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadStorefrontCardAvatar', () => {
  it('fetches only from the media origin, without following redirects', async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES, { 'content-type': 'image/png' }));
    await expect(loadStorefrontCardAvatar('affiliates/avatars/jane.png')).resolves.toBe(
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://media.example.com/affiliates/avatars/jane.png');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never fetches a key that resolves off the media origin', async () => {
    // A bundled site image resolves to a site path, not the media bucket.
    await expect(loadStorefrontCardAvatar('images/NBcover.webp')).resolves.toBeNull();
    await expect(loadStorefrontCardAvatar(null)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses other image types, oversized files and bytes that are not what they claim', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse(PNG_BYTES, { 'content-type': 'image/webp' }));
    await expect(loadStorefrontCardAvatar('affiliates/avatars/a.png')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(
      imageResponse(PNG_BYTES, { 'content-type': 'image/png', 'content-length': String(STOREFRONT_CARD_AVATAR_MAX_BYTES + 1) }),
    );
    await expect(loadStorefrontCardAvatar('affiliates/avatars/a.png')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(imageResponse(new Uint8Array(STOREFRONT_CARD_AVATAR_MAX_BYTES + 10), { 'content-type': 'image/png' }));
    await expect(loadStorefrontCardAvatar('affiliates/avatars/a.png')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(imageResponse(new TextEncoder().encode('<svg onload=alert(1)>'), { 'content-type': 'image/png' }));
    await expect(loadStorefrontCardAvatar('affiliates/avatars/a.png')).resolves.toBeNull();

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: redirect mode is set to error'));
    await expect(loadStorefrontCardAvatar('affiliates/avatars/a.png')).resolves.toBeNull();
  });
});

describe('opengraph-image', () => {
  it('declares a 1200x630 PNG', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe('image/png');
  });

  it('answers 404 without a published storefront and 503 when the read fails', async () => {
    mocks.page = null;
    expect((await Image({ params: Promise.resolve({ handle: 'nobody-here' }) })).status).toBe(404);

    mocks.pageError = new Error('AffiliateStorefrontReadFailed');
    expect((await Image({ params: Promise.resolve({ handle: 'jane-picks' }) })).status).toBe(503);
    expect(mocks.responses).toEqual([]);
  });

  it('draws the approved name, the address, the localized tier and the site, with initials when there is no avatar', async () => {
    const response = await Image({ params: Promise.resolve({ handle: 'jane-picks' }) });
    expect(response.status).toBe(200);
    expect(mocks.responses).toHaveLength(1);
    expect(mocks.responses[0]?.options).toMatchObject({ width: 1200, height: 630 });

    const markup = renderToStaticMarkup(mocks.responses[0]?.element as ReactElement);
    expect(markup).toContain('Jane Doe');
    expect(markup).toContain('shop.example.com/partners/jane-picks');
    expect(markup).toContain('Ambassadeur fondateur');
    expect(markup).toContain('Magasinez ma sélection');
    expect(markup).toContain('Maple Shop');
    expect(markup).toContain('>JD<');
    expect(markup).not.toContain('<img');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embeds a valid avatar as a data URL', async () => {
    mocks.page = storefrontPage('affiliates/avatars/jane.png');
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES, { 'content-type': 'image/png' }));
    await Image({ params: Promise.resolve({ handle: 'jane-picks' }) });
    const markup = renderToStaticMarkup(mocks.responses[0]?.element as ReactElement);
    expect(markup).toContain('src="data:image/png;base64,');
  });

  it("speaks the partner's language when the approved snapshot names it", async () => {
    const page = storefrontPage(null);
    mocks.page = { ...page, storefront: { ...page.storefront, profile: { ...page.storefront.profile, locale: 'en' } } };
    await Image({ params: Promise.resolve({ handle: 'jane-picks' }) });
    const markup = renderToStaticMarkup(mocks.responses[0]?.element as ReactElement);
    expect(markup).toContain('Founding Ambassador');
    expect(markup).toContain('Shop my picks');
    expect(markup).not.toContain('Magasinez ma sélection');
  });
});

describe('opengraph-image generateImageMetadata (og:image:alt)', () => {
  it('describes the card with the social title, like og:title', async () => {
    await expect(generateImageMetadata({ params: { handle: 'jane-picks' } })).resolves.toEqual([
      { id: 'card', alt: 'La sélection de Jane Doe | Maple Shop', size: { width: 1200, height: 630 }, contentType: 'image/png' },
    ]);

    const page = storefrontPage(null);
    mocks.page = { ...page, storefront: { ...page.storefront, title: 'Mes outils de cuisine' } };
    const [card] = await generateImageMetadata({ params: { handle: 'jane-picks' } });
    expect(card?.alt).toBe('Mes outils de cuisine | Maple Shop');
  });

  it('names no card without a published storefront, and fails loudly when the read fails', async () => {
    mocks.page = null;
    await expect(generateImageMetadata({ params: { handle: 'nobody-here' } })).resolves.toEqual([]);
    await expect(generateImageMetadata({ params: {} })).resolves.toEqual([]);

    mocks.pageError = new Error('AffiliateStorefrontReadFailed');
    await expect(generateImageMetadata({ params: { handle: 'jane-picks' } })).rejects.toThrow('AffiliateStorefrontReadFailed');
  });
});
