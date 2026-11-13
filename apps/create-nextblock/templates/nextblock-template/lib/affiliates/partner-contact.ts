import 'server-only';

import { DEFAULT_SITE_TITLE } from '../../app/lib/seo';
import { getSiteSettings } from '../../app/lib/site-settings';

/**
 * The "Email" link the /cms/affiliates screens show beside a partner: a `mailto:` the admin's own
 * mail client opens, with a fixed subject. The site never sends anything here (the sandbox mails
 * nobody either way), and the address comes from `loadAffiliatePartnerEmails()` (admin-data.ts).
 */

/** "Your partner storefront on {site name}" (the site title from Settings, else the default). */
export async function getAffiliatePartnerEmailSubject(): Promise<string> {
  let siteName = DEFAULT_SITE_TITLE;
  try {
    const settings = await getSiteSettings();
    siteName = settings?.siteTitle?.trim() || DEFAULT_SITE_TITLE;
  } catch {
    // The default title.
  }
  return `Your partner storefront on ${siteName}`;
}

const ADDRESS_SHAPE = /^[^\s@<>"]+@[a-z0-9.-]+$/i;

/**
 * `mailto:<address>?subject=<subject>`, or null for something that is not one plain address.
 *
 * The local part of a valid address may hold `?`, `&`, `#`, `%` or `=` (HTML's grammar allows
 * them), which a raw `mailto:` would read as the start of its query: `a?cc=x%40evil.example@shop.test`
 * would add a recipient in the admin's mail client. So the local part is percent-encoded (RFC 6068)
 * and the domain must be a plain host name.
 */
export function buildAffiliatePartnerMailtoHref(email: string, subject: string): string | null {
  const address = typeof email === 'string' ? email.trim() : '';
  if (!ADDRESS_SHAPE.test(address)) return null;
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  return `mailto:${encodeURIComponent(local)}@${domain}?subject=${encodeURIComponent(subject)}`;
}
