import type { Metadata } from 'next';
import { AFFILIATE_PARTNERS_PATH } from '@nextblock-cms/affiliates';
import { buildPartnersRouteMetadata, renderPartnersRoute, type PartnersRouteProps } from './_components/partners-route';

// Per request (locale, CSP nonce, the visitor's session for the signup panel). The tier, currency
// and bot-protection reads are cached across requests; `fetchCache` stays off (docs/05).
export const dynamic = 'force-dynamic';

/**
 * `/partners`: the partner program's landing page in the visitor's language (its French address is
 * `/partenaires`, which shares this implementation). While the Affiliates package is inactive this
 * URL serves the CMS page with the slug `partners`, if one is published.
 */
export function generateMetadata(props: PartnersRouteProps): Promise<Metadata> {
  return buildPartnersRouteMetadata(AFFILIATE_PARTNERS_PATH, props);
}

export default function PartnersPage(props: PartnersRouteProps) {
  return renderPartnersRoute(AFFILIATE_PARTNERS_PATH, props);
}
