import { describe, expect, it, vi } from 'vitest';

import {
  verifyOpenRouterApiKey,
  verifyPexelsApiKey,
  verifyUnsplashAccessKey,
} from './ai-key-verification';

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

describe('verifyOpenRouterApiKey', () => {
  it('rejects a key with the wrong shape without calling the network', async () => {
    const fetch = vi.fn();

    const result = await verifyOpenRouterApiKey({ apiKey: 'abc123', fetch });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the key as a bearer token to /auth/key and summarises the response', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, { data: { is_free_tier: false, label: 'nextblock', limit_remaining: 12.5 } })
    );

    const result = await verifyOpenRouterApiKey({ apiKey: 'sk-or-v1-abc', fetch });

    expect(result).toEqual({ detail: 'key "nextblock" · $12.50 of credit left', isFreeTier: false, ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/key');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-or-v1-abc');
  });

  it('flags the free tier so the wizard can warn about model choice', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { data: { is_free_tier: true } }));

    const result = await verifyOpenRouterApiKey({ apiKey: 'sk-or-v1-abc', fetch });

    expect(result).toEqual({
      detail: 'free tier: only free models until you add credits',
      isFreeTier: true,
      ok: true,
    });
  });

  it('reports a 401 as an invalid key', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { error: { message: 'No auth' } }));

    const result = await verifyOpenRouterApiKey({ apiKey: 'sk-or-v1-abc', fetch });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('reports a network failure as unreachable, not invalid', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    const result = await verifyOpenRouterApiKey({ apiKey: 'sk-or-v1-abc', fetch });

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((result as { message: string }).message).toContain('ECONNRESET');
  });

  it('treats a 5xx as unreachable', async () => {
    const fetch = vi.fn(async () => jsonResponse(503));

    const result = await verifyOpenRouterApiKey({ apiKey: 'sk-or-v1-abc', fetch });

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('verifyPexelsApiKey', () => {
  it('sends the raw key as the Authorization header', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { photos: [] }));

    const result = await verifyPexelsApiKey({ apiKey: 'pexels-key', fetch });

    expect(result).toEqual({ detail: null, isFreeTier: null, ok: true });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('pexels-key');
  });

  it('reports 401 as invalid and 429 as accepted-but-quota-exhausted', async () => {
    expect(
      await verifyPexelsApiKey({ apiKey: 'x', fetch: vi.fn(async () => jsonResponse(401)) })
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(
      await verifyPexelsApiKey({ apiKey: 'x', fetch: vi.fn(async () => jsonResponse(429)) })
    ).toMatchObject({ ok: true });
  });

  it('rejects an empty key without a request', async () => {
    const fetch = vi.fn();

    expect(await verifyPexelsApiKey({ apiKey: '  ', fetch })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('verifyUnsplashAccessKey', () => {
  it('sends the key as Client-ID', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, []));

    const result = await verifyUnsplashAccessKey({ accessKey: 'unsplash-key', fetch });

    expect(result).toEqual({ detail: null, isFreeTier: null, ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.unsplash.com');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Client-ID unsplash-key');
  });

  it('treats 401 as invalid and 403 (demo rate limit) as accepted', async () => {
    expect(
      await verifyUnsplashAccessKey({ accessKey: 'x', fetch: vi.fn(async () => jsonResponse(401)) })
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(
      await verifyUnsplashAccessKey({ accessKey: 'x', fetch: vi.fn(async () => jsonResponse(403)) })
    ).toMatchObject({ ok: true });
  });
});
