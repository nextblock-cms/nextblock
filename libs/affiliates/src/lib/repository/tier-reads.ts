import type { AffiliateTierRow } from '../core/types';
import { AffiliateRepositoryError, affiliateTable, normalizeAffiliateUuid, type AffiliateRepositoryClient } from './client';
import { normalizeAffiliateRows, normalizeAffiliateTierRow } from './rows';

export interface ListAffiliateTiersOptions {
  /** CMS screens list inactive tiers too; public pages never do. */
  includeInactive?: boolean;
}

/** Tiers by `sort_order`, then `created_at`. Active only unless `includeInactive`. */
export async function listAffiliateTiers(
  supabase: AffiliateRepositoryClient,
  options: ListAffiliateTiersOptions = {}
): Promise<AffiliateTierRow[]> {
  let query = affiliateTable(supabase, 'affiliate_tiers').select('*');

  if (!options.includeInactive) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query.order('sort_order', { ascending: true }).order('created_at', { ascending: true });

  if (error) throw new AffiliateRepositoryError('listAffiliateTiers', error);

  return normalizeAffiliateRows(data, normalizeAffiliateTierRow);
}

export async function getAffiliateTierById(supabase: AffiliateRepositoryClient, tierId: string): Promise<AffiliateTierRow | null> {
  const id = normalizeAffiliateUuid(tierId);
  if (!id) return null;

  const { data, error } = await affiliateTable(supabase, 'affiliate_tiers').select('*').eq('id', id).maybeSingle();
  if (error) throw new AffiliateRepositoryError('getAffiliateTierById', error);

  return normalizeAffiliateTierRow(data);
}
