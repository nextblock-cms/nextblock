import 'server-only';

import { isAffiliatesProgramActive } from './package-state';

/**
 * Whether the sandbox banner on /sign-in and /sign-up lists the demo partner account and links its
 * storefront (`SandboxCredentialsAlert`'s `showDemoPartner`). Only on the sandbox, and only while the
 * Affiliates package is active there: the reset cron activates the package and seeds that partner
 * only when FREEMIUS_AFFILIATES_SANDBOX_KEY is set, and the partner pages 404 while the package is
 * off. Outside the sandbox nothing is read.
 */
export async function shouldShowSandboxDemoPartner(): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') return false;
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}
