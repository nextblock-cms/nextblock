import type { ReactNode } from 'react';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_COPY,
  AFFILIATES_SANDBOX_COPY,
  AFFILIATES_STOREFRONT_COPY,
  AffiliatesCopyProvider,
} from '@nextblock-cms/affiliates';
import { getRequestLocale } from '../../../lib/affiliates/request-locale';
import { getAffiliateCopyOverrides } from '../../../lib/affiliates/server-copy';
import { isAffiliatesPackageActive } from './_components/package-gate';

// Per request: the CSP nonce, the locale cookie and the visitor's session (signup form) all vary.
// Never `fetchCache`: it would switch off every `unstable_cache` read beneath this segment.
export const dynamic = 'force-dynamic';

/**
 * The areas the partner pages render (the root layout keeps `affiliates.*` rows out of its payload),
 * the public sandbox's included (the signup form's demo notice and panel).
 */
const PARTNERS_LAYOUT_COPY = {
  ...AFFILIATES_COMMON_COPY,
  ...AFFILIATES_PARTNERS_COPY,
  ...AFFILIATES_STOREFRONT_COPY,
  ...AFFILIATES_SANDBOX_COPY,
};

/**
 * `/partners`, `/partenaires` and `/partners/<handle>`. While the Affiliates package is inactive this
 * is a pass-through: the two landing addresses then serve the CMS page with their slug and the
 * storefronts answer 404 (each route checks the package itself). While it is active, the operator's
 * copy overrides for these areas (only the rows that differ from the built-in strings, in the
 * visitor's language) reach the client islands through `AffiliatesCopyProvider`.
 */
export default async function PartnersLayout({ children }: { children: ReactNode }) {
  if (!(await isAffiliatesPackageActive())) return <>{children}</>;

  const locale = await getRequestLocale();
  const overrides = await getAffiliateCopyOverrides({ locale, dictionary: PARTNERS_LAYOUT_COPY });

  return (
    <AffiliatesCopyProvider locale={locale} overrides={overrides}>
      {children}
    </AffiliatesCopyProvider>
  );
}
