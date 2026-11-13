import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The `CRON_SECRET` bearer check of the scheduled routes (sandbox reset, FX-rate sync). Both
 * sides are hashed with SHA-256 and the digests compared with `timingSafeEqual`, so neither the
 * secret's length nor its content leaks through response timing, which a plain string comparison
 * of the header with `Bearer <secret>` allows (it returns at the first differing character).
 *
 * Each route keeps its own policy for a deployment without the secret (`whenUnset`): the sandbox
 * reset fails closed, the FX sync stays open (documented: a zero-config deploy may run the
 * low-harm rate sync). No minimum length here, so existing deployments with a short secret keep
 * working; the affiliate payout route enforces its own 16 characters.
 */

export type CronSecretPolicy = { whenUnset: 'deny' | 'allow' };

type CronEnv = Readonly<Record<string, string | undefined>>;

/** `CRON_SECRET`, trimmed; '' when unset or blank. */
export function readCronSecret(env: CronEnv = process.env): string {
  return env['CRON_SECRET']?.trim() ?? '';
}

/** The token of an `Authorization: Bearer <token>` header (the scheme is case-insensitive), or null. */
export function parseCronBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  return match ? (match[1] as string) : null;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Whether `header` is `Bearer <secret>`, compared in constant time. Always false for an empty secret. */
export function cronBearerMatches(header: string | null | undefined, secret: string): boolean {
  if (!secret) return false;
  const presented = parseCronBearerToken(header);
  if (presented === null) return false;
  return timingSafeEqual(sha256(presented), sha256(secret));
}

/**
 * Whether a scheduled request may run. With `CRON_SECRET` set, only `Authorization: Bearer
 * <CRON_SECRET>` passes; without it, the route's `whenUnset` policy decides.
 */
export function isCronRequestAuthorized(
  request: { headers: Pick<Headers, 'get'> },
  policy: CronSecretPolicy,
  env: CronEnv = process.env,
): boolean {
  const secret = readCronSecret(env);
  if (!secret) return policy.whenUnset === 'allow';
  return cronBearerMatches(request.headers.get('authorization'), secret);
}
