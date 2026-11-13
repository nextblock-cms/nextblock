import type { Metadata } from 'next';
import { AFFILIATE_PARTNERS_TERMS_PATH } from '@nextblock-cms/affiliates';
import {
  buildPartnersTermsRouteMetadata,
  renderPartnersTermsRoute,
  type PartnersTermsRouteProps,
} from '../_components/partners-terms-route';

// Per request (locale, the operator's terms override). The tier, currency and settings reads are
// cached across requests; `fetchCache` stays off (docs/05).
export const dynamic = 'force-dynamic';

/**
 * `/partners/terms`: the built-in partner terms in the visitor's language (its French address is
 * `/partenaires/conditions`, which shares this implementation). 404 while the Affiliates program is
 * inactive; redirects to the operator's own terms page when one is set for the rendered language.
 * A static segment, so it wins over `/partners/[handle]` (the handle `terms` is reserved).
 */
export function generateMetadata(props: PartnersTermsRouteProps): Promise<Metadata> {
  return buildPartnersTermsRouteMetadata(AFFILIATE_PARTNERS_TERMS_PATH, props);
}

export default function PartnersTermsPage(props: PartnersTermsRouteProps) {
  return renderPartnersTermsRoute(AFFILIATE_PARTNERS_TERMS_PATH, props);
}
