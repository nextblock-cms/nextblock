import { PortalLoading } from './components/PortalLoading';

/**
 * The partner portal's loading state. It renders inside the retailer layout, so the header and
 * the nav stay put while a page's data loads: every portal page is dynamic and the nav links skip
 * prefetching, so without it a click left the old page on screen until the new one was ready.
 */
export default function RetailerPortalLoading() {
  return <PortalLoading />;
}
