'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@nextblock-cms/utils';
import {
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  AFFILIATE_PORTAL_STOREFRONT_PATH,
} from '@nextblock-cms/affiliates';

import type { PortalCopyKey } from './portal-copy';
import { usePortalCopy } from './use-portal-copy';

const PORTAL_NAV_ITEMS: ReadonlyArray<{ href: string; label: PortalCopyKey; exact: boolean }> = [
  { href: AFFILIATE_PORTAL_PATH, label: 'affiliates.portal.nav_overview', exact: true },
  { href: AFFILIATE_PORTAL_STOREFRONT_PATH, label: 'affiliates.portal.nav_storefront', exact: false },
  { href: AFFILIATE_PORTAL_PAYOUTS_PATH, label: 'affiliates.portal.nav_payouts', exact: false },
];

/**
 * A fixed-size dot inside a nav link that fades in while the click is still navigating. The links
 * skip prefetching (a prefetch would render the portal layout and its payout trigger), so a click
 * waits for the server; the delay keeps fast navigations from flashing it. Decorative: the
 * loading skeleton announces the wait.
 */
function PortalNavPendingHint() {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden="true"
      data-pending={pending ? 'true' : 'false'}
      className={cn(
        'ml-2 inline-block size-1.5 shrink-0 rounded-full bg-current transition-opacity',
        pending ? 'opacity-70 delay-150 duration-200' : 'opacity-0 duration-0',
      )}
    />
  );
}

/** The portal's sub-navigation (Overview, Storefront, Payouts); the current page is `aria-current`. */
export function PortalNav() {
  const pathname = usePathname() ?? '';
  const { t } = usePortalCopy();

  return (
    <nav aria-label={t('affiliates.portal.nav_label')} className="border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-1">
        {PORTAL_NAV_ITEMS.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center rounded-t-md border-b-2 px-4 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                {t(item.label)}
                <PortalNavPendingHint />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
