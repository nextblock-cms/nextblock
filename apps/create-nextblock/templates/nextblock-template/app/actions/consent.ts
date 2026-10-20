'use server';

import { headers } from 'next/headers';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { z } from '../../lib/zod-config';

/**
 * A server action is a public POST endpoint dispatched by its action id, so everything
 * below runs for anonymous strangers as well as for the consent banner — and it writes
 * with the service-role client because `privacy_consent_logs` has no anon INSERT policy.
 * Two things keep that from being a free "write rows into the compliance log" primitive:
 *
 *  - the payload is validated to the exact shape the banner sends (opaque token, two
 *    booleans), so a row can only ever hold one of the four real decisions;
 *  - inserts are capped per source address inside a sliding window. A visitor decides
 *    once (maybe twice) a year, so the cap costs nobody a row while bounding a flood.
 *
 * `consent_token` is UNIQUE, so replaying a token can never add a second row either.
 */

const MAX_USER_AGENT_LENGTH = 500;

/** Per-source insert cap. Deliberately generous: this is anti-flood, not anti-user. */
const THROTTLE_WINDOW_MINUTES = 10;
const THROTTLE_MAX_DECISIONS = 20;

/** Postgres unique_violation: the token is already logged, which is the outcome we want. */
const UNIQUE_VIOLATION = '23505';

/**
 * The banner's token is `crypto.randomUUID()` (36 chars of `[0-9a-f-]`) or, without
 * WebCrypto, a base36 fallback of ~20 chars. Anything outside that alphabet or size is
 * not a token the banner produced.
 */
const consentLogInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  analytics: z.boolean(),
  marketing: z.boolean(),
});

export interface ConsentLogInput {
  token: string;
  analytics: boolean;
  marketing: boolean;
}

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

/**
 * Best available client address, preferring headers the platform overwrites on every
 * request over `x-forwarded-for`, whose leftmost entry a client can prepend on an
 * appending proxy. The throttle below is keyed on this, so it must not be mintable.
 */
function resolveClientIp(requestHeaders: Headers): string | null {
  return (
    firstHop(requestHeaders.get('x-vercel-forwarded-for')) ??
    firstHop(requestHeaders.get('x-real-ip')) ??
    firstHop(requestHeaders.get('x-forwarded-for'))
  );
}

/** Reduce an IP to a non-identifying form for the consent audit log. */
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(':')) {
    // IPv6: keep the first three hextets, drop the rest.
    const hextets = ip.split(':').filter(Boolean);
    return `${hextets.slice(0, 3).join(':')}::x`;
  }
  const octets = ip.split('.');
  if (octets.length === 4) {
    octets[3] = 'x';
    return octets.join('.');
  }
  return null;
}

/**
 * Record a consent decision for Law 25 / PIPEDA accountability. Best-effort:
 * failures never block the visitor's choice from taking effect client-side.
 */
export async function logConsentDecision(input: ConsentLogInput): Promise<{ ok: boolean }> {
  const parsed = consentLogInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const { token, analytics, marketing } = parsed.data;

  try {
    const requestHeaders = await headers();
    const ipMasked = maskIp(resolveClientIp(requestHeaders));
    const userAgent = requestHeaders.get('user-agent');

    const supabase = getServiceRoleSupabaseClient();

    // Requests whose address cannot be read are throttled TOGETHER (one null bucket),
    // never exempted: "unknown" must not mean "no limit".
    const since = new Date(Date.now() - THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
    const recentFromSource = supabase
      .from('privacy_consent_logs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since);
    const { count } =
      ipMasked === null
        ? await recentFromSource.is('ip_masked', null)
        : await recentFromSource.eq('ip_masked', ipMasked);

    if ((count ?? 0) >= THROTTLE_MAX_DECISIONS) {
      return { ok: false };
    }

    const { error } = await supabase.from('privacy_consent_logs').insert({
      consent_token: token,
      categories: {
        necessary: true,
        analytics,
        marketing,
      },
      ip_masked: ipMasked,
      user_agent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    });

    if (error) {
      // Already logged under this token (a retry, or a replay): nothing to add.
      if (error.code === UNIQUE_VIOLATION) return { ok: true };
      console.error('Failed to record consent decision:', error);
      return { ok: false };
    }

    return { ok: true };
  } catch (error) {
    console.error('Failed to record consent decision:', error);
    return { ok: false };
  }
}
