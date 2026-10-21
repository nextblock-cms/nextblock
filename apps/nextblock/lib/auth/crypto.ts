import 'server-only';

// Server-only crypto helpers for 2FA tokens, trusted-device hashing, and the
// signed "second factor satisfied" session marker. Uses Node's crypto module.
import crypto from 'node:crypto';

/** SHA-256 hex digest. Used to store device/code hashes (never the raw value). */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Cryptographically random URL-safe token (default 32 bytes -> 43 chars). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Random fixed-length numeric code, e.g. a 6-digit email 2FA code. */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return crypto.randomInt(0, max).toString().padStart(digits, '0');
}

function getSecret(): string {
  // Dedicated secret if provided, otherwise fall back to the service-role key
  // (server-only, never shipped to the client).
  const secret =
    process.env.NB_2FA_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;
  if (!secret) {
    throw new Error('Missing NB_2FA_SECRET / SUPABASE_SERVICE_ROLE_KEY for 2FA signing.');
  }
  return secret;
}

/** HMAC-SHA256 signature (base64url) of an arbitrary payload string. */
export function hmacSign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
