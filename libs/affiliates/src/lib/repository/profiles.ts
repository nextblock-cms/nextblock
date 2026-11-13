/**
 * Partner profile and storefront page reads. The caller picks the client (the app passes the
 * service-role client only after it has established who is asking); nothing here authorizes.
 */
import { AFFILIATE_HANDLE_PATTERN } from '../core/handle';
import { isAffiliateStatus } from '../core/statuses';
import type { AffiliatePageRow, AffiliateProfileRow, AffiliateStatus } from '../core/types';
import {
  AffiliateRepositoryError,
  affiliateTable,
  clampAffiliatePageOffset,
  clampAffiliatePageSize,
  escapeAffiliateLikePattern,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
  type AffiliateRepositoryPage,
} from './client';
import { normalizeAffiliatePageRow, normalizeAffiliateProfileRow, normalizeAffiliateRows } from './rows';

async function maybeSingleProfile(
  operation: string,
  query: PromiseLike<{ data: unknown; error: unknown }>
): Promise<AffiliateProfileRow | null> {
  const { data, error } = await query;
  if (error) throw new AffiliateRepositoryError(operation, error);
  return normalizeAffiliateProfileRow(data);
}

export async function getAffiliateProfileByUserId(
  supabase: AffiliateRepositoryClient,
  userId: string
): Promise<AffiliateProfileRow | null> {
  const id = normalizeAffiliateUuid(userId);
  if (!id) return null;

  return maybeSingleProfile(
    'getAffiliateProfileByUserId',
    affiliateTable(supabase, 'affiliate_profiles').select('*').eq('user_id', id).maybeSingle()
  );
}

export async function getAffiliateProfileById(
  supabase: AffiliateRepositoryClient,
  affiliateId: string
): Promise<AffiliateProfileRow | null> {
  const id = normalizeAffiliateUuid(affiliateId);
  if (!id) return null;

  return maybeSingleProfile(
    'getAffiliateProfileById',
    affiliateTable(supabase, 'affiliate_profiles').select('*').eq('id', id).maybeSingle()
  );
}

/**
 * By handle, compared lowercased. A string that cannot be a handle returns null without a
 * query (reserved handles are still looked up: the database, not this list, is the record).
 */
export async function getAffiliateProfileByHandle(
  supabase: AffiliateRepositoryClient,
  handle: string
): Promise<AffiliateProfileRow | null> {
  const normalized = typeof handle === 'string' ? handle.trim().toLowerCase() : '';
  if (!AFFILIATE_HANDLE_PATTERN.test(normalized)) return null;

  return maybeSingleProfile(
    'getAffiliateProfileByHandle',
    affiliateTable(supabase, 'affiliate_profiles').select('*').eq('handle', normalized).maybeSingle()
  );
}

export async function getAffiliatePageByAffiliateId(
  supabase: AffiliateRepositoryClient,
  affiliateId: string
): Promise<AffiliatePageRow | null> {
  const id = normalizeAffiliateUuid(affiliateId);
  if (!id) return null;

  const { data, error } = await affiliateTable(supabase, 'affiliate_pages').select('*').eq('affiliate_id', id).maybeSingle();
  if (error) throw new AffiliateRepositoryError('getAffiliatePageByAffiliateId', error);

  return normalizeAffiliatePageRow(data);
}

export async function getAffiliatePageById(supabase: AffiliateRepositoryClient, pageId: string): Promise<AffiliatePageRow | null> {
  const id = normalizeAffiliateUuid(pageId);
  if (!id) return null;

  const { data, error } = await affiliateTable(supabase, 'affiliate_pages').select('*').eq('id', id).maybeSingle();
  if (error) throw new AffiliateRepositoryError('getAffiliatePageById', error);

  return normalizeAffiliatePageRow(data);
}

export interface ListAffiliateProfilesOptions {
  status?: AffiliateStatus | null;
  tierId?: string | null;
  /**
   * Free text. A term made only of handle characters (`a-z`, `0-9`, `-`) matches handles;
   * anything else matches display names. One column, `.ilike()` with an escaped pattern —
   * never an `.or()` string.
   */
  search?: string | null;
  limit?: number;
  offset?: number;
}

/** Newest first. For the CMS overview. */
export async function listAffiliateProfiles(
  supabase: AffiliateRepositoryClient,
  options: ListAffiliateProfilesOptions = {}
): Promise<AffiliateRepositoryPage<AffiliateProfileRow>> {
  const hasStatus = options.status !== undefined && options.status !== null;
  const hasTier = options.tierId !== undefined && options.tierId !== null;
  const tierId = hasTier ? normalizeAffiliateUuid(options.tierId) : null;

  // A filter that cannot match answers without a query.
  if ((hasStatus && !isAffiliateStatus(options.status)) || (hasTier && !tierId)) {
    return { rows: [], count: 0 };
  }

  const limit = clampAffiliatePageSize(options.limit);
  const offset = clampAffiliatePageOffset(options.offset);
  let query = affiliateTable(supabase, 'affiliate_profiles').select('*', { count: 'exact' });

  if (hasStatus) query = query.eq('status', options.status);
  if (tierId) query = query.eq('tier_id', tierId);

  const term = typeof options.search === 'string' ? options.search.trim().slice(0, 80) : '';

  if (term) {
    const column = /^[a-z0-9-]+$/i.test(term) ? 'handle' : 'display_name';
    query = query.ilike(column, `%${escapeAffiliateLikePattern(column === 'handle' ? term.toLowerCase() : term)}%`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new AffiliateRepositoryError('listAffiliateProfiles', error);

  const rows = normalizeAffiliateRows(data, normalizeAffiliateProfileRow);
  return { rows, count: typeof count === 'number' ? count : rows.length };
}
