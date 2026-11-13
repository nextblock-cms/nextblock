// Server-side reads and the signup RPC. Every function takes the Supabase client as its first
// argument (the app decides which one); nothing here builds a client or authorizes a caller.
export {
  AFFILIATE_REPOSITORY_DEFAULT_PAGE_SIZE,
  AFFILIATE_REPOSITORY_MAX_PAGE_SIZE,
  AffiliateRepositoryError,
  clampAffiliatePageOffset,
  clampAffiliatePageSize,
  escapeAffiliateLikePattern,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
  type AffiliateRepositoryPage,
} from './client';
export {
  normalizeAffiliateCommissionRow,
  normalizeAffiliatePageRow,
  normalizeAffiliatePayoutRow,
  normalizeAffiliateProfileRow,
  normalizeAffiliateRows,
  normalizeAffiliateTierRow,
} from './rows';
export {
  getAffiliatePageByAffiliateId,
  getAffiliatePageById,
  getAffiliateProfileByHandle,
  getAffiliateProfileById,
  getAffiliateProfileByUserId,
  listAffiliateProfiles,
  type ListAffiliateProfilesOptions,
} from './profiles';
export { getAffiliateTierById, listAffiliateTiers, type ListAffiliateTiersOptions } from './tier-reads';
export {
  computeAffiliateBalances,
  getAffiliateBalances,
  listAffiliateCommissions,
  listAffiliatePayouts,
  type AffiliateBalanceInputRow,
  type AffiliateBalancesOptions,
  type ListAffiliateLedgerOptions,
} from './ledger';
export { AffiliateAccountError, createAffiliateAccountViaRpc, mapAffiliateRpcError } from './accounts';
