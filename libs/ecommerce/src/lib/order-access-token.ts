import 'server-only';
import crypto from 'node:crypto';

/**
 * Capability token for the checkout-success page.
 *
 * The success page finalizes a Freemius order by its id. That id is the order's primary key and
 * can leak (referer, logs, a shared link), so it must not be the sole proof of ownership: a
 * guest order has no account to gate it, and a signed-in buyer's order must not be readable by
 * another signed-in account. We mint an HMAC of the order id at checkout time and hand it back in
 * the success redirect; the success action accepts the order only when the token verifies (or the
 * caller is the order's owner / staff). The secret is the server-only service-role key, so the
 * token cannot be forged by a client. Verification is constant-time.
 */
function secret(): string {
  const value =
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ||
    process.env['SUPABASE_SECRET_KEY'] ||
    process.env['NB_2FA_SECRET'];
  if (!value) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY for order access tokens.');
  }
  return value;
}

export function mintOrderAccessToken(orderId: string): string {
  return crypto.createHmac('sha256', secret()).update(`order:${orderId}`).digest('base64url');
}

export function verifyOrderAccessToken(orderId: string, token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const expected = mintOrderAccessToken(orderId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
