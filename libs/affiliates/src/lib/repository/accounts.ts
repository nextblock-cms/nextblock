/**
 * Partner signup through the service-role RPC `public.create_affiliate_account` (migration
 * 02030), which locks the user's profile row, picks the tier under a row lock, inserts the
 * profile and the page, and promotes the role to RTL in one transaction.
 */
import { normalizeAffiliateHandle } from '../core/handle';
import type { AffiliateAccountErrorCode, CreateAffiliateAccountInput, CreateAffiliateAccountResult } from '../core/types';
import { normalizeAffiliateUuid, type AffiliateRepositoryClient } from './client';

const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 120;
const MAX_META_DESCRIPTION_LENGTH = 300;
const MAX_SIGNUP_IP_LENGTH = 64;
/** `affiliate_pages.draft_content` CHECK: `octet_length(draft_content::text) <= 262144`. */
const MAX_STARTER_DOC_BYTES = 262_144;

/** A refused signup. `code` is safe to show (through the copy keys); `cause` keeps the database error. */
export class AffiliateAccountError extends Error {
  readonly code: AffiliateAccountErrorCode;

  constructor(code: AffiliateAccountErrorCode, cause?: unknown) {
    super(`Affiliate account not created: ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'AffiliateAccountError';
    this.code = code;
  }
}

function errorField(error: unknown, field: string): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/**
 * The signup error code for an RPC / PostgREST error:
 * `affiliate_role_conflict` → role_conflict, `affiliate_exists` → affiliate_exists,
 * `affiliate_program_full` → program_full, `affiliate_handle_invalid` (or a handle CHECK
 * violation, 23514) → handle_invalid, a unique violation (23505) → handle_taken (or
 * affiliate_exists when it names `user_id` / `affiliate_id`), anything else → unknown.
 */
export function mapAffiliateRpcError(error: unknown): AffiliateAccountErrorCode {
  if (error instanceof AffiliateAccountError) return error.code;

  const code = errorField(error, 'code');
  const text = [errorField(error, 'message'), errorField(error, 'details'), errorField(error, 'hint')].join(' ').toLowerCase();

  if (text.includes('affiliate_role_conflict')) return 'role_conflict';
  if (text.includes('affiliate_program_full')) return 'program_full';
  if (text.includes('affiliate_handle_invalid')) return 'handle_invalid';
  if (text.includes('affiliate_exists')) return 'affiliate_exists';

  if (code === '23505') {
    if (text.includes('handle')) return 'handle_taken';
    if (text.includes('user_id') || text.includes('affiliate_id')) return 'affiliate_exists';
    return 'handle_taken';
  }

  if (code === '23514' && text.includes('handle')) return 'handle_invalid';

  return 'unknown';
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function starterDocument(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { type: 'doc', content: [] };
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function resultNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Create the partner profile + storefront page for `input.userId`. Call it with the
 * service-role client only (the RPC is granted to service_role alone) AFTER the caller has
 * authenticated the user; nothing here authorizes.
 *
 * @throws AffiliateAccountError with the mapped code (use `mapAffiliateRpcError` on anything caught).
 */
export async function createAffiliateAccountViaRpc(
  supabase: AffiliateRepositoryClient,
  input: CreateAffiliateAccountInput
): Promise<CreateAffiliateAccountResult> {
  const userId = normalizeAffiliateUuid(input.userId);
  const handle = normalizeAffiliateHandle(input.handle);
  const displayName = clip(input.displayName, MAX_DISPLAY_NAME_LENGTH);

  if (!handle) throw new AffiliateAccountError('handle_invalid');
  if (!userId || !displayName) throw new AffiliateAccountError('unknown');

  const locale = typeof input.locale === 'string' && /^[a-z]{2}$/.test(input.locale.trim().toLowerCase())
    ? input.locale.trim().toLowerCase()
    : 'en';
  const starterDoc = starterDocument(input.starterDoc);

  if (jsonByteLength(starterDoc) > MAX_STARTER_DOC_BYTES) throw new AffiliateAccountError('unknown');

  const signupIp = typeof input.signupIpMasked === 'string' ? input.signupIpMasked.trim().slice(0, MAX_SIGNUP_IP_LENGTH) : '';

  const { data, error } = await supabase.rpc('create_affiliate_account', {
    p_user_id: userId,
    p_handle: handle,
    p_display_name: displayName,
    p_locale: locale,
    p_title: clip(input.title, MAX_TITLE_LENGTH),
    p_meta_description: clip(input.metaDescription, MAX_META_DESCRIPTION_LENGTH),
    p_starter_doc: starterDoc,
    p_signup_ip_masked: signupIp || null,
  });

  if (error) throw new AffiliateAccountError(mapAffiliateRpcError(error), error);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  const spotsRemaining = row ? resultNumber(row['spots_remaining']) : null;

  if (!row || typeof row !== 'object' || typeof row['affiliate_id'] !== 'string' || typeof row['page_id'] !== 'string') {
    throw new AffiliateAccountError('unknown', new Error('create_affiliate_account returned no row'));
  }

  return {
    affiliateId: row['affiliate_id'],
    pageId: row['page_id'],
    tierId: typeof row['tier_id'] === 'string' ? row['tier_id'] : '',
    tierName: typeof row['tier_name'] === 'string' ? row['tier_name'] : '',
    tierSlug: typeof row['tier_slug'] === 'string' ? row['tier_slug'] : '',
    commissionPercentage: resultNumber(row['commission_percentage']) ?? 0,
    isLimitedTimePromo: row['is_limited_time_promo'] === true,
    spotsRemaining: spotsRemaining === null ? null : Math.max(0, Math.trunc(spotsRemaining)),
  };
}
