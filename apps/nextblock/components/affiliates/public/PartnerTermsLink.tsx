import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

export interface PartnerTermsLinkProps {
  /**
   * The built-in terms address of the page's language, or the operator's own page: computed on the
   * server by `partnersTermsHref()` (lib/affiliates/partners-paths.ts) from the checked settings.
   */
  href: string;
  /** The link text. */
  children: ReactNode;
  /** "(opens in a new tab)" in the page's language, read by screen readers only. */
  newTabLabel: string;
  className: string;
}

/** A site path (`/partners/terms`), never a protocol-relative `//host`. */
function isSitePath(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/**
 * A link to the partner terms, opened in a new tab so a half-filled signup form stays put:
 * `next/link` without prefetch for a site path (the built-in terms), a plain anchor with
 * `rel="noopener noreferrer"` for the operator's https page. An aria-hidden external-link icon,
 * and the new-tab notice for screen readers, as on the portal's "View storefront" link. Anything
 * else renders as plain text. No directive: the signup island and server components both render it.
 */
export function PartnerTermsLink({ href, children, newTabLabel, className }: PartnerTermsLinkProps) {
  const content = (
    <>
      {children}
      <ExternalLink aria-hidden="true" className="ml-1 inline-block h-3.5 w-3.5 align-[-0.125em]" />
      <span className="sr-only"> {newTabLabel}</span>
    </>
  );

  if (isSitePath(href)) {
    return (
      <Link href={href} prefetch={false} target="_blank" rel="noopener" className={className}>
        {content}
      </Link>
    );
  }
  if (/^https:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return <>{children}</>;
}
