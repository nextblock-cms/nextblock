import 'server-only';

import { cache } from 'react';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';

/**
 * Whether the affiliate program runs (the Affiliates package AND Commerce Pro, which it is an
 * add-on to: lib/affiliates/package-state.ts), once per request. A failed check counts as
 * inactive. One gate for every partner route: the
 * layout, `/partners` and `/partenaires` (which hand their URL back to the CMS page with that slug
 * while the package is off), the storefronts and their social card (404 while off).
 */
export const isAffiliatesPackageActive = cache(async (): Promise<boolean> => {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
});
