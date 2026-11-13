import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { isSchemaMissingError } from '../seo/redirect-store';

/**
 * Whether deleting a user, or removing their partner account, would erase a partner's money
 * history (Affiliates, ADDENDUM A24).
 *
 * `affiliate_profiles`, and through it every commission and payout row, cascade from
 * `auth.users` (the sandbox reset deletes auth users before it drops `public`, so the foreign
 * keys stay ON DELETE CASCADE). Deleting the account of a partner who earned anything would
 * therefore silently erase the ledger. Two callers ask this first and refuse:
 *
 * - the /cms/users delete action (`app/cms/users/actions.ts`), before the auth user is deleted;
 * - "Remove partner" in /cms/affiliates (`removeAffiliatePartner` in `review.ts`), after it has
 *   paused the partner, so that no commission or payout can appear between this check and the
 *   delete of the `affiliate_profiles` row.
 *
 * Pausing (suspending) the partner in Affiliates is the way to cut access while keeping the
 * records.
 *
 * Blocking history is any payout, or any commission that is not a tombstone. A tombstone is the
 * zero-amount `VOIDED_REFUND` row `apply_affiliate_refund` leaves for an order refunded before
 * its commission was recorded (`void_reason` 'refunded_before_commission'): it carries no money.
 *
 * Takes the service-role client from the caller, which has authorized the ADMIN first
 * (`requireCmsAdmin()`). Fails closed: any read error other than "the Affiliates schema is not
 * installed" answers `unavailable`, and the caller keeps the account.
 *
 * `allowed` carries the partner's handle (null when the user is not a partner): the delete
 * cascades the profile and the storefront away, so the caller evicts the public storefront and
 * tier caches for that handle once the account is gone.
 */

export type AffiliateDeletionCheck =
  | { kind: 'allowed'; handle: string | null }
  | { kind: 'blocked'; reason: 'payouts' | 'commissions' }
  | { kind: 'unavailable' };

const TOMBSTONE_STATUS = 'VOIDED_REFUND';

type CountResult = { count: number | null; error: { code?: string; message?: string } | null };

function countOf(result: CountResult): number | null {
  return result.error || typeof result.count !== 'number' ? null : result.count;
}

export async function checkAffiliateUserDeletion(
  serviceClient: SupabaseClient<any>,
  userIdToDelete: string,
): Promise<AffiliateDeletionCheck> {
  try {
    const { data: affiliate, error } = await serviceClient
      .from('affiliate_profiles')
      .select('id, handle')
      .eq('user_id', userIdToDelete)
      .maybeSingle();

    if (error) {
      // No Affiliates schema on this install: nobody can have a partner ledger.
      return isSchemaMissingError(error) ? { kind: 'allowed', handle: null } : { kind: 'unavailable' };
    }
    const affiliateId = typeof affiliate?.id === 'string' ? affiliate.id : null;
    if (!affiliateId) {
      return { kind: 'allowed', handle: null };
    }
    const handle = typeof affiliate?.handle === 'string' && affiliate.handle.trim() ? affiliate.handle.trim() : null;

    const payouts = countOf(
      await serviceClient
        .from('affiliate_payouts')
        .select('id', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId),
    );
    if (payouts === null) return { kind: 'unavailable' };
    if (payouts > 0) return { kind: 'blocked', reason: 'payouts' };

    // Every commission except a tombstone (VOIDED_REFUND with a zero amount) is ledger history,
    // a voided real commission included. Two counts keep the filters free of a PostgREST `or`.
    const live = countOf(
      await serviceClient
        .from('affiliate_commissions')
        .select('id', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId)
        .neq('status', TOMBSTONE_STATUS),
    );
    if (live === null) return { kind: 'unavailable' };
    if (live > 0) return { kind: 'blocked', reason: 'commissions' };

    const voidedWithAmount = countOf(
      await serviceClient
        .from('affiliate_commissions')
        .select('id', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId)
        .eq('status', TOMBSTONE_STATUS)
        .gt('commission_amount_cents', 0),
    );
    if (voidedWithAmount === null) return { kind: 'unavailable' };
    if (voidedWithAmount > 0) return { kind: 'blocked', reason: 'commissions' };

    return { kind: 'allowed', handle };
  } catch (error) {
    console.error('[affiliates] partner ledger check failed:', error);
    return { kind: 'unavailable' };
  }
}
