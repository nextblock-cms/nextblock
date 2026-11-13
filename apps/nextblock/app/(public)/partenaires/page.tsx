import type { Metadata } from 'next';
import { AFFILIATE_PARTNERS_PATH_FR } from '@nextblock-cms/affiliates';
import {
  buildPartnersRouteMetadata,
  renderPartnersRoute,
  type PartnersRouteProps,
} from '../partners/_components/partners-route';

// Per request, as `/partners` (segment config must be a literal in each route file).
export const dynamic = 'force-dynamic';

/**
 * `/partenaires`: the partner program's landing page, always in French (proxy.ts pins the request
 * locale on this path while French is an active language), so the French copy has an address of its
 * own that search engines index. Same implementation as `/partners`; while the Affiliates package is
 * inactive, or French is not an active language, this URL serves the CMS page with the slug
 * `partenaires`, if one is published.
 */
export function generateMetadata(props: PartnersRouteProps): Promise<Metadata> {
  return buildPartnersRouteMetadata(AFFILIATE_PARTNERS_PATH_FR, props);
}

export default function PartenairesPage(props: PartnersRouteProps) {
  return renderPartnersRoute(AFFILIATE_PARTNERS_PATH_FR, props);
}
