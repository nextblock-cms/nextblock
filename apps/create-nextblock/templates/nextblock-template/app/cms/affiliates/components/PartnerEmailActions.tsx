import { Mail } from 'lucide-react';
import { buildAffiliatePartnerMailtoHref } from '../../../../lib/affiliates/partner-contact';
import { CopyTextButton } from './CopyTextButton';

/** No address could be read: the auth lookup failed (`loadAffiliatePartnerEmails` left the key out). */
export const PARTNER_EMAIL_UNAVAILABLE = 'Email unavailable right now';
/** The account was read, but its address cannot receive mail (invalid, or a placeholder domain). */
export const PARTNER_EMAIL_UNUSABLE = 'No usable email';
/** The copy hint where the address is not printed beside the button (the review page prints it). */
export const PARTNER_EMAIL_COPY_FAILED = 'Copy failed. The review page shows the address.';

/**
 * "Email" (a same-tab `mailto:` the admin's own mail client opens, subject prefilled) and "Copy"
 * for a partner's sign-in address, read from `auth.users` for the visible rows only
 * (`loadAffiliatePartnerEmails`). The site sends nothing. Server component: the address never
 * reaches a client bundle except as the copy button's value.
 *
 * `email` is the loader's value as is: a string, `null` (no usable address) or `undefined` (the
 * lookup failed, so nothing is known: never shown as "no address").
 */
export function PartnerEmailActions({
  email,
  subject,
  handle,
  showAddress = false,
}: {
  email: string | null | undefined;
  subject: string;
  handle: string;
  /** Print the address itself before the link (the review page's Partner card). */
  showAddress?: boolean;
}) {
  if (email === undefined) {
    return <span className="text-xs text-muted-foreground">{PARTNER_EMAIL_UNAVAILABLE}</span>;
  }
  const href = email ? buildAffiliatePartnerMailtoHref(email, subject) : null;
  if (!email || !href) {
    return <span className="text-xs text-muted-foreground">{PARTNER_EMAIL_UNUSABLE}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {showAddress ? <span className="break-all text-sm text-foreground">{email}</span> : null}
      <a
        href={href}
        aria-label={`Email @${handle}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        Email
      </a>
      <CopyTextButton
        value={email}
        label={`Copy the email address of @${handle}`}
        // Only the review page prints the address: elsewhere there is no text to select by hand.
        failureMessage={showAddress ? undefined : PARTNER_EMAIL_COPY_FAILED}
      />
    </span>
  );
}
