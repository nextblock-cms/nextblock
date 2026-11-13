import type { ReactNode } from 'react';
import { cn } from '@nextblock-cms/utils';

/**
 * A status banner of the portal (welcome, in review, changes requested, suspended…). Pure markup
 * with literal colour classes per tone, safe in server and client trees. Static on load, so it
 * carries no live-region role; dynamic messages use their own `role="status"` regions.
 */

const PORTAL_NOTICE_TONES = {
  info: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-50',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50',
  warning: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50',
  danger: 'border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-50',
} as const;

export type PortalNoticeTone = keyof typeof PORTAL_NOTICE_TONES;

export function PortalNotice({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: PortalNoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border p-4', PORTAL_NOTICE_TONES[tone], className)}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 space-y-2 text-sm leading-relaxed">{children}</div> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-3">{action}</div> : null}
    </div>
  );
}

/** Link styling inside a notice: inherits the notice colour, underlined, with a visible focus ring. */
export const PORTAL_NOTICE_LINK_CLASS =
  'font-medium underline underline-offset-4 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
