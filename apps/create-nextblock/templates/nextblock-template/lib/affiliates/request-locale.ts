import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import type { AffiliateLocale } from '@nextblock-cms/affiliates';

/**
 * The visitor's site language for the partner pages, resolved in the same order as the root
 * layout (app/layout.tsx), so a partner page always speaks the language of the chrome around it:
 *
 *   `x-user-locale` (set by proxy.ts from the CMS language-detection settings)
 *   → `NEXT_USER_LOCALE` cookie → `NEXT_LOCALE` cookie → the first Accept-Language base → `en`.
 *
 * Each candidate must be an active site language; when none is, the default language wins, as
 * in the layout. The affiliates copy itself exists in English and French only:
 * {@link toAffiliatesLocale} maps any site language onto one of the two.
 */

const DEFAULT_REQUEST_LOCALE = 'en';
const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const FALLBACK_CODE_RE = /^[a-z]{2}$/;

export interface RequestLocaleLanguages {
  /** Active `languages.code` values as stored. Empty when the table could not be read. */
  activeCodes: string[];
  defaultCode: string | null;
}

export interface RequestLocaleCandidates {
  headerLocale?: string | null;
  userLocaleCookie?: string | null;
  nextLocaleCookie?: string | null;
  acceptLanguage?: string | null;
}

// Same lifetime as the root layout's language read; languages change about never.
const getCachedRequestLanguages = unstable_cache(
  async (): Promise<RequestLocaleLanguages> => {
    const { data, error } = await getSsgSupabaseClient()
      .from('languages')
      .select('code, is_default, is_active');
    if (error || !Array.isArray(data)) return { activeCodes: [], defaultCode: null };

    // `is_active` NULL counts as active, as in the proxy and the root layout.
    const active = (data as Array<{ code: unknown; is_default: unknown; is_active: unknown }>).filter(
      (row) => typeof row.code === 'string' && row.code.trim() !== '' && row.is_active !== false,
    );
    const activeCodes = active.map((row) => String(row.code).trim());
    const defaultRow = active.find((row) => row.is_default === true);
    return {
      activeCodes,
      defaultCode: defaultRow ? String(defaultRow.code).trim() : activeCodes[0] ?? null,
    };
  },
  ['affiliates-request-locale-languages'],
  { revalidate: 300 },
);

function normalizeCandidate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().replace(/_/g, '-');
  return code && code.length <= 16 && LOCALE_CODE_RE.test(code) ? code : null;
}

/** The base language of the first Accept-Language entry (`fr-CA,fr;q=0.9` → `fr`), or null. */
export function parseAcceptLanguageBase(header: string | null | undefined): string | null {
  if (typeof header !== 'string' || !header.trim()) return null;
  const first = header.slice(0, 256).split(',')[0]?.split(';')[0]?.trim() ?? '';
  const base = first.split(/[-_]/)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/**
 * Pure resolution (exported for tests): the first candidate that is an active language. With no
 * readable language list, a two-letter code is accepted as-is (the layout's legacy behaviour when
 * the table is unreadable is to trust the cookie). Otherwise the default language, then `en`.
 */
export function pickRequestLocale(
  candidates: RequestLocaleCandidates,
  languages: RequestLocaleLanguages,
): string {
  const ordered = [
    normalizeCandidate(candidates.headerLocale),
    normalizeCandidate(candidates.userLocaleCookie),
    normalizeCandidate(candidates.nextLocaleCookie),
    parseAcceptLanguageBase(candidates.acceptLanguage),
  ];
  // Compare case-insensitively, answer with the code as the table stores it.
  const active = new Map<string, string>();
  for (const code of languages.activeCodes) {
    if (typeof code === 'string' && code.trim()) active.set(code.trim().toLowerCase(), code.trim());
  }

  for (const candidate of ordered) {
    if (!candidate) continue;
    if (active.size > 0) {
      const match = active.get(candidate);
      if (match) return match;
    } else if (FALLBACK_CODE_RE.test(candidate)) {
      return candidate;
    }
  }

  const defaultCode = languages.defaultCode?.trim();
  if (defaultCode && (active.size === 0 || active.has(defaultCode.toLowerCase()))) {
    return active.get(defaultCode.toLowerCase()) ?? defaultCode;
  }
  return DEFAULT_REQUEST_LOCALE;
}

async function readRequestLanguages(): Promise<RequestLocaleLanguages> {
  try {
    return await getCachedRequestLanguages();
  } catch {
    return { activeCodes: [], defaultCode: null };
  }
}

/**
 * The site's active languages (the same cached read `getRequestLocale` uses; no request API, so the
 * sitemap may call it too). Never throws: `activeCodes` is empty when the table is unreadable.
 */
export function getActiveRequestLanguages(): Promise<RequestLocaleLanguages> {
  return readRequestLanguages();
}

/**
 * The request's site language (a `languages.code`). Memoised per request. Never throws: outside a
 * request (no headers/cookies) or with the language table unreadable it degrades to the
 * candidates it has, then `en`.
 */
export const getRequestLocale = cache(async (): Promise<string> => {
  const candidates: RequestLocaleCandidates = {};
  try {
    const headerList = await headers();
    candidates.headerLocale = headerList.get('x-user-locale');
    candidates.acceptLanguage = headerList.get('accept-language');
  } catch {
    // Not in a request scope.
  }
  try {
    const cookieStore = await cookies();
    candidates.userLocaleCookie = cookieStore.get('NEXT_USER_LOCALE')?.value ?? null;
    candidates.nextLocaleCookie = cookieStore.get('NEXT_LOCALE')?.value ?? null;
  } catch {
    // Not in a request scope.
  }
  return pickRequestLocale(candidates, await readRequestLanguages());
});

/** The affiliates copy language for a site language: French for any `fr…`, English otherwise. */
export function toAffiliatesLocale(locale: string | null | undefined): AffiliateLocale {
  return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}
