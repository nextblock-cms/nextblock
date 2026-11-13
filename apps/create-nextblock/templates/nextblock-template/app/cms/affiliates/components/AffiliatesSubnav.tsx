import Link from 'next/link';
import { cn } from '@nextblock-cms/utils';

export type AffiliatesSection = 'overview' | 'tiers' | 'approvals' | 'payouts' | 'stripe' | 'paypal';

const SECTIONS: ReadonlyArray<{ key: AffiliatesSection; href: string; label: string }> = [
  { key: 'overview', href: '/cms/affiliates', label: 'Overview' },
  { key: 'tiers', href: '/cms/affiliates/tiers', label: 'Tiers' },
  { key: 'approvals', href: '/cms/affiliates/approvals', label: 'Approvals' },
  { key: 'payouts', href: '/cms/affiliates/payouts', label: 'Payouts' },
  { key: 'stripe', href: '/cms/affiliates/stripe', label: 'Stripe payouts' },
  { key: 'paypal', href: '/cms/affiliates/paypal', label: 'PayPal payouts' },
];

/** Section tabs shared by the affiliates screens (plain links: works without JavaScript). */
export function AffiliatesSubnav({ active, pendingApprovals = 0 }: { active: AffiliatesSection; pendingApprovals?: number }) {
  return (
    <nav aria-label="Affiliate program sections" className="border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-1">
        {SECTIONS.map((section) => {
          const isActive = section.key === active;
          return (
            <li key={section.key}>
              <Link
                href={section.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-10 items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                )}
              >
                {section.label}
                {section.key === 'approvals' && pendingApprovals > 0 ? (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-700 dark:text-amber-400">
                    <span className="sr-only">, </span>
                    {pendingApprovals > 99 ? '99+' : pendingApprovals}
                    <span className="sr-only"> pending</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
