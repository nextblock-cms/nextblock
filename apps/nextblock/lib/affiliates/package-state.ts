import 'server-only';

import { cache } from 'react';
import { AFFILIATES_PACKAGE_ID } from '@nextblock-cms/affiliates';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';

/**
 * Affiliates is an add-on to Commerce Pro: partners earn a share of store sales, so without the
 * store there is nothing to sell, attribute or pay out. The program runs only while the Affiliates
 * package AND every package it requires (`NEXTBLOCK_PACKAGES.affiliates.requires`, i.e. Commerce
 * Pro) verify as active. An Affiliates license with Commerce off is dormant: every gate answers
 * "inactive" (the public partner pages, signup, the portal, the CMS screens, payouts, checkout
 * attribution, the copilot), and the data is kept until Commerce is back. Refunds and disputes
 * still reach the ledger whatever the package state (lib/affiliates/refunds.ts).
 *
 * Every Affiliates gate asks this, never `verifyPackageOnline('affiliates')` alone:
 * package-state.test.ts fails on a direct check anywhere in the app. Memoised per request
 * (`verifyPackageOnline` also caches 60 s across requests). Never throws: a failed check reads as
 * inactive, like `verifyPackageOnline` itself.
 */
export const isAffiliatesProgramActive = cache(async (): Promise<boolean> => {
  const packageIds: readonly string[] = [AFFILIATES_PACKAGE_ID, ...NEXTBLOCK_PACKAGES.affiliates.requires];
  try {
    const states = await Promise.all(
      packageIds.map((packageId) => verifyPackageOnline(packageId).catch(() => false)),
    );
    return states.every((active) => active === true);
  } catch {
    return false;
  }
});
