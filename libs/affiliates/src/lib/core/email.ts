/**
 * Email normalization for the self-referral check. TypeScript mirror of the SQL helper
 * `private.affiliate_normalize_email(text)` (migration 02030); both produce the same string for
 * the same input:
 *
 *   1. trim whitespace (space, \t, \n, \v, \f, \r) and lowercase; blank → null;
 *   2. no `@` → step 1's string;
 *   3. split at the LAST `@`, and drop everything from the first `+` in the local part
 *      (`me+promo` → `me`);
 *   4. `googlemail.com` → `gmail.com`, and for `gmail.com` remove every `.` from the local part;
 *   5. `<local>@<domain>`, even when a part is empty (as the SQL concatenates it).
 *
 * So `Me+Promo@GoogleMail.com`, `m.e@gmail.com` and `me@gmail.com` all become `me@gmail.com`.
 * A partner's auth email always has a local part, so a degenerate buyer address (`+x@gmail.com`
 * → `@gmail.com`) can never equal it.
 */

const WHITESPACE_EDGES = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/** The normalized address, or null for a non-string or blank input. Never throws. */
export function normalizeAffiliateEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const email = value.replace(WHITESPACE_EDGES, '').toLowerCase();

  if (!email) return null;

  const at = email.lastIndexOf('@');

  if (at < 0) return email;

  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');

  if (plus >= 0) local = local.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }

  return `${local}@${domain}`;
}

/** True when both addresses normalize to the same value (the self-referral rule of 02030). */
export function affiliateEmailsMatch(a: unknown, b: unknown): boolean {
  const left = normalizeAffiliateEmail(a);
  const right = normalizeAffiliateEmail(b);

  return left !== null && left === right;
}
