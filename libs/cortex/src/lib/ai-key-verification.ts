/**
 * Live verification of the third-party keys the Cortex setup wizard collects.
 *
 * Each helper makes one cheap, read-only call to the provider with the key the
 * operator just typed and reports whether the provider accepted it. The wizard
 * refuses to store a key that fails here, so a typo surfaces on the setup screen
 * with a precise message instead of hours later as a bare "request failed" in the
 * chat drawer. Network trouble is reported separately from a rejected key so the
 * UI can offer "save anyway" for the former and never for the latter.
 *
 * Nothing here touches the database or the encryption layer; that stays in the
 * settings actions. `fetch` is injectable for tests.
 */

type FetchFunction = typeof globalThis.fetch;

export type CortexAiKeyVerification =
  | { ok: true; detail: string | null; isFreeTier: boolean | null }
  | { ok: false; reason: 'invalid' | 'unreachable'; message: string };

const VERIFY_TIMEOUT_MS = 10_000;

const OPENROUTER_AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';
const PEXELS_PROBE_URL = 'https://api.pexels.com/v1/curated?per_page=1';
const UNSPLASH_PROBE_URL = 'https://api.unsplash.com/photos?per_page=1';

async function probe(
  fetchImpl: FetchFunction,
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown } | { failed: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);

    return { body, status: response.status };
  } catch (error) {
    return {
      failed:
        error instanceof Error && error.name === 'AbortError'
          ? 'The provider did not answer within 10 seconds.'
          : error instanceof Error
            ? error.message
            : 'The provider could not be reached.',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function unreachable(provider: string, detail: string): CortexAiKeyVerification {
  return {
    message: `${provider} could not be reached to check the key (${detail}). Check the connection and try again.`,
    ok: false,
    reason: 'unreachable',
  };
}

function invalid(message: string): CortexAiKeyVerification {
  return { message, ok: false, reason: 'invalid' };
}

/**
 * OpenRouter's `/auth/key` returns the key's own metadata (label, spend limit, free
 * tier) for a valid key and 401 for anything else, so it is the one endpoint that
 * checks a key without spending credits.
 */
export async function verifyOpenRouterApiKey(params: {
  apiKey: string;
  fetch?: FetchFunction;
}): Promise<CortexAiKeyVerification> {
  const apiKey = params.apiKey.trim();

  if (!apiKey) {
    return invalid('Enter an OpenRouter API key.');
  }

  if (!apiKey.startsWith('sk-or-')) {
    return invalid('That does not look like an OpenRouter key: they start with "sk-or-".');
  }

  const result = await probe(params.fetch || globalThis.fetch, OPENROUTER_AUTH_KEY_URL, {
    Authorization: `Bearer ${apiKey}`,
  });

  if ('failed' in result) {
    return unreachable('OpenRouter', result.failed);
  }

  if (result.status === 401 || result.status === 403) {
    return invalid('OpenRouter rejected this key. Copy it again from openrouter.ai/keys.');
  }

  if (result.status < 200 || result.status >= 300) {
    return unreachable('OpenRouter', `HTTP ${result.status}`);
  }

  const data =
    result.body && typeof result.body === 'object' && 'data' in result.body
      ? ((result.body as { data?: unknown }).data as Record<string, unknown> | undefined)
      : undefined;
  const label = typeof data?.['label'] === 'string' ? data['label'].trim() : '';
  const isFreeTier = data?.['is_free_tier'] === true;
  const limitRemaining =
    typeof data?.['limit_remaining'] === 'number' ? data['limit_remaining'] : null;

  const notes: string[] = [];

  if (label) {
    notes.push(`key "${label}"`);
  }

  if (isFreeTier) {
    notes.push('free tier: only free models until you add credits');
  } else if (limitRemaining !== null) {
    notes.push(`$${limitRemaining.toFixed(2)} of credit left`);
  }

  return { detail: notes.length > 0 ? notes.join(' · ') : null, isFreeTier: data ? isFreeTier : null, ok: true };
}

/** Pexels answers every request with 401 for an unknown key and 200 otherwise. */
export async function verifyPexelsApiKey(params: {
  apiKey: string;
  fetch?: FetchFunction;
}): Promise<CortexAiKeyVerification> {
  const apiKey = params.apiKey.trim();

  if (!apiKey) {
    return invalid('Enter a Pexels API key.');
  }

  const result = await probe(params.fetch || globalThis.fetch, PEXELS_PROBE_URL, {
    Authorization: apiKey,
  });

  if ('failed' in result) {
    return unreachable('Pexels', result.failed);
  }

  if (result.status === 401 || result.status === 403) {
    return invalid('Pexels rejected this key. Copy it again from pexels.com/api.');
  }

  if (result.status === 429) {
    // Rate-limited means authenticated: Pexels only counts requests it accepted.
    return { detail: 'Pexels accepted the key (its hourly quota is currently exhausted).', isFreeTier: null, ok: true };
  }

  if (result.status < 200 || result.status >= 300) {
    return unreachable('Pexels', `HTTP ${result.status}`);
  }

  return { detail: null, isFreeTier: null, ok: true };
}

/**
 * Unsplash returns 401 for a bad access key. A 403 is "Rate Limit Exceeded" for a
 * demo app (50 requests/hour), which only happens to a key that authenticated, so it
 * counts as accepted.
 */
export async function verifyUnsplashAccessKey(params: {
  accessKey: string;
  fetch?: FetchFunction;
}): Promise<CortexAiKeyVerification> {
  const accessKey = params.accessKey.trim();

  if (!accessKey) {
    return invalid('Enter an Unsplash access key.');
  }

  const result = await probe(params.fetch || globalThis.fetch, UNSPLASH_PROBE_URL, {
    Authorization: `Client-ID ${accessKey}`,
  });

  if ('failed' in result) {
    return unreachable('Unsplash', result.failed);
  }

  if (result.status === 401) {
    return invalid('Unsplash rejected this key. Use the Access Key (not the Secret Key) from unsplash.com/developers.');
  }

  if (result.status === 403 || result.status === 429) {
    return { detail: 'Unsplash accepted the key (its demo quota is currently exhausted).', isFreeTier: null, ok: true };
  }

  if (result.status < 200 || result.status >= 300) {
    return unreachable('Unsplash', `HTTP ${result.status}`);
  }

  return { detail: null, isFreeTier: null, ok: true };
}
