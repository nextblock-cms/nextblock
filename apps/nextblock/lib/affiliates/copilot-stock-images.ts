import 'server-only';

import {
  AFFILIATE_STOCK_IMAGE_ORIGINS,
  STOREFRONT_LIMITS,
  isAllowedStorefrontImageSrc,
  sanitizeStorefrontImageCredit,
  type StorefrontImageAttrs,
  type StorefrontImageCredit,
} from '@nextblock-cms/affiliates';
import { executeSearchStockPhotos } from '@nextblock-cms/cortex';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

/**
 * The stock photo search behind the partner copilot's `generate_storefront_section` tool
 * (`RetailerCopilotToolDeps.searchStockImage`, SPEC §8 + ADDENDUM C13).
 *
 * It runs Cortex's `executeSearchStockPhotos` with the service-role client because the Pexels and
 * Unsplash keys are ADMIN-tier encrypted `site_settings` rows (env fallback). The keys stay inside
 * that call: this module returns only the photo (address, description, size and credit), never a
 * key, a provider message or an error. A partner reaches it only through the copilot route, after
 * `requireRetailer()` and the AI request quotas; the request's tool set caps it at 3 lookups in
 * all (`RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST`, whatever the number of sections), so the
 * operator's Pexels / Unsplash keys see at most 3 searches per copilot request.
 *
 * The result is the first usable photo as `StorefrontImageAttrs`:
 * - its address must be on a stock photo host (`AFFILIATE_STOCK_IMAGE_ORIGINS`);
 * - an Unsplash photo needs a valid credit (the photographer is named on every use, and its
 *   `downloadLocation` is the `api.unsplash.com/photos/…` trigger the route pings after the reply);
 * - a Pexels credit is kept when valid (attribution is appreciated, not required).
 * Width and height stay as the provider reports them: the section converter scales an oversized
 * photo down and the storefront sanitizer validates the whole node again.
 *
 * Never throws: no provider, no result, a provider error, a missing service key or a lookup slower
 * than 8 s all resolve to null, and the image block is then left out of the section.
 */

/** A lookup slower than this resolves to null (the copilot tool applies the same cut-off). */
export const RETAILER_COPILOT_STOCK_SEARCH_TIMEOUT_MS = 8000;

/** Photos requested per lookup; the first usable one wins. */
const STOCK_SEARCH_RESULT_COUNT = 5;

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One line, collapsed whitespace, no control characters; '' when too short or not text. */
function normalizeStockQuery(query: unknown): string {
  if (typeof query !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- strips control characters from a search query
  const cleaned = query.slice(0, MAX_QUERY_LENGTH * 4).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < MIN_QUERY_LENGTH) return '';
  return cleaned.length > MAX_QUERY_LENGTH ? cleaned.slice(0, MAX_QUERY_LENGTH).trim() : cleaned;
}

/** A positive pixel size rounded to an integer, or null. */
function pixelSize(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.round(parsed);
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trim() : value;
}

function photoCredit(photo: UnknownRecord, provider: 'pexels' | 'unsplash'): StorefrontImageCredit | null {
  const photographer = text(photo['photographer']);
  if (photographer === '') return null;
  return sanitizeStorefrontImageCredit({
    provider,
    photographer,
    photographerUrl: text(photo['photographerUrl']),
    sourceUrl: text(photo['sourceUrl']),
    downloadLocation: provider === 'unsplash' ? text(photo['downloadLocation']) || null : null,
    utmSource: provider === 'unsplash' ? text(photo['utmSource']) || null : null,
  });
}

/** The photo as storefront image attributes, or null when it is not usable. */
function toStorefrontImage(photo: unknown): StorefrontImageAttrs | null {
  if (!isRecord(photo)) return null;
  const provider = photo['provider'] === 'unsplash' ? 'unsplash' : photo['provider'] === 'pexels' ? 'pexels' : null;
  if (provider === null) return null;

  const src = text(photo['url']);
  if (!isAllowedStorefrontImageSrc(src, AFFILIATE_STOCK_IMAGE_ORIGINS)) return null;

  const credit = photoCredit(photo, provider);
  // Unsplash photos are used only with their attribution and download trigger.
  if (provider === 'unsplash' && (credit === null || credit.downloadLocation === null)) return null;

  return {
    src,
    alt: clip(text(photo['alt']), STOREFRONT_LIMITS.maxAltLength),
    title: null,
    width: pixelSize(photo['width']),
    height: pixelSize(photo['height']),
    credit,
  };
}

/** The first usable photo of an `executeSearchStockPhotos` result, or null. */
export function pickRetailerCopilotStockImage(result: unknown): StorefrontImageAttrs | null {
  if (!isRecord(result) || result['success'] !== true || !Array.isArray(result['photos'])) return null;
  for (const photo of result['photos'].slice(0, STOCK_SEARCH_RESULT_COUNT * 2)) {
    const image = toStorefrontImage(photo);
    if (image) return image;
  }
  return null;
}

async function runStockSearch(query: string): Promise<StorefrontImageAttrs | null> {
  const supabase = getServiceRoleSupabaseClient();
  const result = await executeSearchStockPhotos(
    { count: STOCK_SEARCH_RESULT_COUNT, orientation: 'landscape', query },
    { supabase },
  );
  return pickRetailerCopilotStockImage(result);
}

/**
 * The first usable stock photo for `query` (Pexels first, then Unsplash, as configured by the
 * operator), or null. See the module comment for what is returned and what never is.
 */
export async function searchRetailerCopilotStockImage(query: string): Promise<StorefrontImageAttrs | null> {
  const normalized = normalizeStockQuery(query);
  if (normalized === '') return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = Promise.resolve()
      .then(() => runStockSearch(normalized))
      .catch(() => null);
    const cutoff = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), RETAILER_COPILOT_STOCK_SEARCH_TIMEOUT_MS);
    });
    return await Promise.race([lookup, cutoff]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
