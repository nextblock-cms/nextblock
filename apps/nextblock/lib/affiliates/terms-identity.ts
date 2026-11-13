import 'server-only';

import { resolvePrivacyEmail } from '../privacy/contact-emails';
import { getPrivacySettings } from '../privacy/settings';

/**
 * Who runs the partner program and how partners reach them, as the built-in partner terms show it
 * (`/partners/terms`, `/partenaires/conditions`) and as the CMS program settings explain it. Both
 * come from CMS → Settings → Privacy: `{company}` is the legal name (else the site title the caller
 * passes), and the contact address is the support email resolved like the `{{privacy_email}}` merge
 * tag (`resolvePrivacyEmail`). The terms leave their Contact section out when there is no address,
 * and the CMS says so next to the terms fields, so one rule lives here.
 */

/** RFC 2606 domains: `resolvePrivacyEmail` answers `privacy@example.com` while nothing is configured. */
const RESERVED_EXAMPLE_EMAIL = /@(?:[a-z0-9-]+\.)*example\.(?:com|net|org)$/i;
const CONTACT_EMAIL_SHAPE = /^[^\s@<>"'()[\]\\,;:]+@[^\s@<>"'()[\]\\,;:]+\.[^\s@<>"'()[\]\\,;:]+$/;

/**
 * The contact address the built-in terms show, or null when there is none: empty, malformed, longer
 * than 254 characters, or the `privacy@example.com` placeholder (any RFC 2606
 * `example.com/.net/.org` address).
 */
export function affiliateTermsContactEmail(resolved: string): string | null {
  const email = resolved.trim();
  if (!email || email.length > 254 || !CONTACT_EMAIL_SHAPE.test(email) || RESERVED_EXAMPLE_EMAIL.test(email)) return null;
  return email;
}

export interface AffiliateTermsOperatorIdentity {
  /** The privacy settings' legal name, else `siteTitle`. */
  company: string;
  /** The address the terms' Contact section shows, or null (the section is left out). */
  contactEmail: string | null;
  /** False when the privacy settings could not be read (`company` is then the site title). */
  settingsRead: boolean;
}

/** One read of the privacy settings → the operator's identity for the terms. Never throws. */
export async function loadAffiliateTermsOperatorIdentity(siteTitle: string): Promise<AffiliateTermsOperatorIdentity> {
  try {
    const privacy = await getPrivacySettings();
    return {
      company: privacy.corporate.legal_name.trim() || siteTitle,
      // The same resolution as the {{privacy_email}} merge tag (getPrivacyMergeEmail), from this one read.
      contactEmail: affiliateTermsContactEmail(resolvePrivacyEmail(privacy.corporate.support_email)),
      settingsRead: true,
    };
  } catch {
    return { company: siteTitle, contactEmail: null, settingsRead: false };
  }
}
