import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The copilot's stock photo lookup: the service-role client reaches Cortex's search (the provider
 * keys are ADMIN-tier secrets), and only a validated photo comes back, never a key, a provider
 * message or an error.
 */

const mocks = vi.hoisted(() => ({
  executeSearchStockPhotos: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
}));

vi.mock('@nextblock-cms/cortex', () => ({ executeSearchStockPhotos: mocks.executeSearchStockPhotos }));
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient }));

import {
  RETAILER_COPILOT_STOCK_SEARCH_TIMEOUT_MS,
  pickRetailerCopilotStockImage,
  searchRetailerCopilotStockImage,
} from './copilot-stock-images';

const SERVICE_CLIENT = { from: vi.fn(), marker: 'service-role' };

const UNSPLASH_PHOTO = {
  alt: 'Lavender bundles on a wooden table',
  credit: 'Photo by Jane Doe on Unsplash',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
  height: 3000,
  photographer: 'Jane Doe',
  photographerUrl: 'https://unsplash.com/@janedoe',
  provider: 'unsplash',
  sourceUrl: 'https://unsplash.com/photos/abc123',
  thumbnailUrl: 'https://images.unsplash.com/photo-1?w=400',
  url: 'https://images.unsplash.com/photo-1?w=1080',
  utmSource: 'nextblock_shop',
  width: 4500,
};

const PEXELS_PHOTO = {
  alt: 'Candles on a shelf',
  credit: 'Photo by Sam Lee on Pexels',
  downloadLocation: null,
  height: 800,
  photographer: 'Sam Lee',
  photographerUrl: 'https://www.pexels.com/@sam-lee',
  provider: 'pexels',
  sourceUrl: 'https://www.pexels.com/photo/candles-123/',
  thumbnailUrl: 'https://images.pexels.com/photos/123/small.jpeg',
  url: 'https://images.pexels.com/photos/123/large.jpeg',
  width: 1200,
};

function found(...photos: unknown[]) {
  return { attemptedProviders: ['unsplash'], photos, provider: 'unsplash', query: 'q', success: true, usageGuidance: '…' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServiceRoleSupabaseClient.mockReturnValue(SERVICE_CLIENT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchRetailerCopilotStockImage', () => {
  it('searches with the service-role client and returns the first photo with its Unsplash credit', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValue(found(UNSPLASH_PHOTO, PEXELS_PHOTO));

    const image = await searchRetailerCopilotStockImage('  lavender   bundles ');

    expect(mocks.executeSearchStockPhotos).toHaveBeenCalledTimes(1);
    const [input, context] = mocks.executeSearchStockPhotos.mock.calls[0];
    expect(input).toEqual({ count: 5, orientation: 'landscape', query: 'lavender bundles' });
    expect(context).toEqual({ supabase: SERVICE_CLIENT });
    expect(image).toEqual({
      src: 'https://images.unsplash.com/photo-1?w=1080',
      alt: 'Lavender bundles on a wooden table',
      title: null,
      // Raw provider sizes: the section converter scales them and the sanitizer validates them.
      width: 4500,
      height: 3000,
      credit: {
        provider: 'unsplash',
        photographer: 'Jane Doe',
        photographerUrl: 'https://unsplash.com/@janedoe',
        sourceUrl: 'https://unsplash.com/photos/abc123',
        downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        utmSource: 'nextblock_shop',
      },
    });
  });

  it('keeps a Pexels credit without Unsplash fields', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValue(found(PEXELS_PHOTO));

    const image = await searchRetailerCopilotStockImage('candles');

    expect(image?.src).toBe('https://images.pexels.com/photos/123/large.jpeg');
    expect(image?.credit).toEqual({
      provider: 'pexels',
      photographer: 'Sam Lee',
      photographerUrl: 'https://www.pexels.com/@sam-lee',
      sourceUrl: 'https://www.pexels.com/photo/candles-123/',
      downloadLocation: null,
      utmSource: null,
    });
  });

  it('returns only photo fields, never a provider key or message', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValue({ ...found(PEXELS_PHOTO), apiKey: 'secret-key' });

    const image = await searchRetailerCopilotStockImage('candles');

    expect(Object.keys(image ?? {}).sort()).toEqual(['alt', 'credit', 'height', 'src', 'title', 'width']);
    expect(JSON.stringify(image)).not.toContain('secret-key');
  });

  it('is null when no provider is configured or nothing matched', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValueOnce({
      message: 'No stock photo provider is configured. Add a free Pexels or Unsplash API key in /cms/settings/cortex-ai.',
      photos: [],
      success: false,
    });
    await expect(searchRetailerCopilotStockImage('candles')).resolves.toBeNull();

    mocks.executeSearchStockPhotos.mockResolvedValueOnce(found());
    await expect(searchRetailerCopilotStockImage('candles')).resolves.toBeNull();
  });

  it('skips photos off the stock hosts and Unsplash photos without attribution', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValue(
      found(
        { ...UNSPLASH_PHOTO, url: 'https://evil.example/photo.jpg' },
        { ...UNSPLASH_PHOTO, url: 'http://images.unsplash.com/photo-2' },
        { ...UNSPLASH_PHOTO, photographer: '' },
        { ...UNSPLASH_PHOTO, downloadLocation: 'https://evil.example/ping' },
        { ...UNSPLASH_PHOTO, provider: 'flickr' },
        PEXELS_PHOTO,
      ),
    );

    const image = await searchRetailerCopilotStockImage('candles');

    expect(image?.src).toBe(PEXELS_PHOTO.url);
  });

  it('never throws: provider errors and a missing service key resolve to null', async () => {
    mocks.executeSearchStockPhotos.mockRejectedValueOnce(new Error('Stock photo provider responded with HTTP 429.'));
    await expect(searchRetailerCopilotStockImage('candles')).resolves.toBeNull();

    mocks.getServiceRoleSupabaseClient.mockImplementationOnce(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
    await expect(searchRetailerCopilotStockImage('candles')).resolves.toBeNull();
  });

  it('gives up after 8 seconds', async () => {
    vi.useFakeTimers();
    mocks.executeSearchStockPhotos.mockReturnValue(new Promise(() => undefined));

    const pending = searchRetailerCopilotStockImage('candles');
    await vi.advanceTimersByTimeAsync(RETAILER_COPILOT_STOCK_SEARCH_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(RETAILER_COPILOT_STOCK_SEARCH_TIMEOUT_MS).toBe(8000);
  });

  it('does not search for an empty, too short or non-text query', async () => {
    await expect(searchRetailerCopilotStockImage('')).resolves.toBeNull();
    await expect(searchRetailerCopilotStockImage(' a ')).resolves.toBeNull();
    await expect(searchRetailerCopilotStockImage(42 as unknown as string)).resolves.toBeNull();

    expect(mocks.executeSearchStockPhotos).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('caps the query at 120 characters', async () => {
    mocks.executeSearchStockPhotos.mockResolvedValue(found());

    await searchRetailerCopilotStockImage(`${'x'.repeat(300)}`);

    expect(mocks.executeSearchStockPhotos.mock.calls[0][0].query).toHaveLength(120);
  });
});

describe('pickRetailerCopilotStockImage', () => {
  it('ignores malformed results', () => {
    expect(pickRetailerCopilotStockImage(null)).toBeNull();
    expect(pickRetailerCopilotStockImage({ success: true, photos: 'nope' })).toBeNull();
    expect(pickRetailerCopilotStockImage({ success: true, photos: [null, 42, 'x'] })).toBeNull();
  });

  it('nulls sizes the provider did not report', () => {
    const image = pickRetailerCopilotStockImage(found({ ...PEXELS_PHOTO, width: null, height: 'tall' }));

    expect(image).toMatchObject({ width: null, height: null });
  });
});
