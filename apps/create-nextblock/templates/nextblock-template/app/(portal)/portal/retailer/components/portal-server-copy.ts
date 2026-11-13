import 'server-only';

import { getServerAffiliatesCopy } from '../../../../../lib/affiliates/server-copy';
import { PORTAL_UI_COPY, type PortalTranslate } from './portal-copy';

/** The typed portal `t()` for server components and metadata (operator overrides included). */
export async function getPortalServerCopy(locale?: string | null): Promise<PortalTranslate> {
  return getServerAffiliatesCopy({ locale: locale ?? null, dictionary: PORTAL_UI_COPY });
}
