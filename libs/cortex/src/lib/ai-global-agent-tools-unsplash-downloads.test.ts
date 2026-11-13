import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { maybeTriggerStockPhotoDownloads } from './ai-global-agent-tools';

/**
 * 2026-11-03: maybeTriggerStockPhotoDownloads pinged every `attribution.downloadLocation` in
 * block content with the operator's Unsplash key (`Authorization: Client-ID …`) through a plain
 * fetch that followed redirects to any host. The content schema accepts any string there, so
 * whoever saved the block (any visitor on the public sandbox; a WRITER whose block a later admin
 * Cortex edit merges) chose where the key went, or which internal URL the server requested.
 */

const OPERATOR_KEY = 'operator-unsplash-key';
const VALID_TRIGGER = 'https://api.unsplash.com/photos/abc/download?ixid=1';

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchMock: Mock<FetchStub>;

function unsplashAttribution(downloadLocation: string) {
  return { downloadLocation, photographer: 'A. Photographer', provider: 'unsplash' };
}

function imageBlock(downloadLocation: string) {
  return { content: { attribution: unsplashAttribution(downloadLocation) } };
}

function fetchedUrls() {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

beforeEach(() => {
  vi.stubEnv('UNSPLASH_ACCESS_KEY', OPERATOR_KEY);
  fetchMock = vi.fn<FetchStub>(
    async () => new Response('{"url":"https://images.unsplash.com/photo"}', { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('maybeTriggerStockPhotoDownloads', () => {
  it('pings only https://api.unsplash.com/photos/ triggers', async () => {
    await maybeTriggerStockPhotoDownloads([
      imageBlock('https://evil.example/x'),
      imageBlock('http://127.0.0.1/x'),
      imageBlock('https://api.unsplash.com.evil.example/photos/x/download'),
      imageBlock('https://api.unsplash.com:444/photos/x/download'),
      imageBlock('https://user:pw@api.unsplash.com/photos/x/download'),
      imageBlock('https://user@api.unsplash.com/photos/x/download'),
      imageBlock('https://:pw@api.unsplash.com/photos/x/download'),
      imageBlock('http://api.unsplash.com/photos/x/download'),
      imageBlock('https://api.unsplash.com./photos/x/download'),
      imageBlock('https://api.unsplash.com/me'),
      imageBlock('https://api.unsplash.com/photos/../me'),
      imageBlock('not a url'),
      imageBlock(VALID_TRIGGER),
    ]);

    expect(fetchedUrls()).toEqual([VALID_TRIGGER]);
  });

  it('sends the key with redirects refused and a timeout signal', async () => {
    await maybeTriggerStockPhotoDownloads([imageBlock(VALID_TRIGGER)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0][1];

    expect(init?.headers).toEqual({ Authorization: `Client-ID ${OPERATOR_KEY}` });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('applies the same rule in nested columns, slides and section backgrounds', async () => {
    // Each refused value differs from a real trigger only in its host.
    await maybeTriggerStockPhotoDownloads([
      {
        content: {
          background: {
            image: { attribution: unsplashAttribution('https://evil.example/photos/bg/download') },
          },
          column_blocks: [
            [
              {
                block_type: 'image',
                content: {
                  attribution: unsplashAttribution('https://169.254.169.254/photos/x/download'),
                },
              },
              {
                block_type: 'image',
                content: {
                  attribution: unsplashAttribution('https://api.unsplash.com/photos/nested/download'),
                },
              },
            ],
          ],
        },
      },
      {
        content: {
          slides: [
            { attribution: unsplashAttribution('https://evil.example/photos/slide/download') },
            { attribution: unsplashAttribution('https://api.unsplash.com/photos/slide/download') },
          ],
        },
      },
      {
        content: {
          background: {
            image: {
              attribution: unsplashAttribution('https://api.unsplash.com/photos/bg/download'),
            },
          },
        },
      },
    ]);

    expect(fetchedUrls().sort()).toEqual(
      [
        'https://api.unsplash.com/photos/bg/download',
        'https://api.unsplash.com/photos/nested/download',
        'https://api.unsplash.com/photos/slide/download',
      ].sort()
    );
  });

  it('caps the pings per call at 20', async () => {
    const triggers = Array.from(
      { length: 25 },
      (_, index) => `https://api.unsplash.com/photos/photo-${index}/download?ixid=${index}`
    );

    await maybeTriggerStockPhotoDownloads(triggers.map(imageBlock));

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(fetchedUrls()).toEqual(triggers.slice(0, 20));
  });

  it('never rejects when a ping fails (refused redirect, timeout, network error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      maybeTriggerStockPhotoDownloads([imageBlock(VALID_TRIGGER)])
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pings nothing when no Unsplash key is configured', async () => {
    vi.stubEnv('UNSPLASH_ACCESS_KEY', '');

    await maybeTriggerStockPhotoDownloads([imageBlock(VALID_TRIGGER)]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
