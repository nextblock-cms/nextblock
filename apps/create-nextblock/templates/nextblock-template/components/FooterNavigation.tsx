import Link from 'next/link';
import type { Database } from '@nextblock-cms/db';
import { isPartnerProgramNavItem } from '../lib/affiliates/partner-program-nav';

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];

interface FooterNavigationProps {
  navItems: NavigationItem[];
  /** Landmark name in the visitor's language; AppShell resolves it. */
  ariaLabel?: string;
  /** Text of the badge on the partner program link ("New" / "Nouveau"); AppShell resolves it. */
  newBadgeLabel?: string;
}

export default function FooterNavigation({
  navItems,
  ariaLabel = 'Footer navigation',
  newBadgeLabel = 'New',
}: FooterNavigationProps) {
  if (navItems.length === 0) {
    return null;
  }

  const renderNavItems = (items: NavigationItem[]) =>
    items
      .filter((item) => !item.parent_id)
      .map((item) => isPartnerProgramNavItem(item) ? (
        // The partner program link seeded by 02034 (the layout drops it while the program is off).
        // Only the label underlines on hover: a decoration on the link would run under the badge.
        <Link
          key={item.id}
          href={item.url}
          className="group/partner inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-2 py-1"
        >
          <span className="group-hover/partner:underline">{item.label}</span>
          <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-primary-foreground">
            {newBadgeLabel}
          </span>
        </Link>
      ) : (
        <Link
          key={item.id}
          href={item.url}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline px-2 py-1"
        >
          {item.label}
        </Link>
      ));

  return (
    <nav className="flex flex-wrap justify-center items-center gap-x-4 gap-y-2" aria-label={ariaLabel}>
      {renderNavItems(navItems)}
    </nav>
  );
}
