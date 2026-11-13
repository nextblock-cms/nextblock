import type { Metadata } from 'next';
import { AFFILIATE_PARTNERS_TERMS_PATH_FR } from '@nextblock-cms/affiliates';
import {
  buildPartnersTermsRouteMetadata,
  renderPartnersTermsRoute,
  type PartnersTermsRouteProps,
} from '../../partners/_components/partners-terms-route';

// Per request, as `/partners/terms` (segment config must be a literal in each route file).
export const dynamic = 'force-dynamic';

/**
 * `/partenaires/conditions`: the built-in partner terms, always in French (proxy.ts pins the request
 * locale on `/partenaires` and below while French is an active language). Same implementation as
 * `/partners/terms`; 404 while the Affiliates program is inactive or French is not an active
 * language, and a redirect to the operator's own French (else English) terms page when one is set.
 */
export function generateMetadata(props: PartnersTermsRouteProps): Promise<Metadata> {
  return buildPartnersTermsRouteMetadata(AFFILIATE_PARTNERS_TERMS_PATH_FR, props);
}

export default function PartenairesConditionsPage(props: PartnersTermsRouteProps) {
  return renderPartnersTermsRoute(AFFILIATE_PARTNERS_TERMS_PATH_FR, props);
}
