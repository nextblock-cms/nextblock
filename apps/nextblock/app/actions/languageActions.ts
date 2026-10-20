'use server';

import { createClient } from '@nextblock-cms/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLanguageByCode } from '../cms/settings/languages/actions';
import { isSafeInternalPath } from '../../lib/auth-redirects';

export interface Language {
  id: number;
  name: string;
  code: string;
  is_default: boolean;
  created_at?: string;
}

// Every export of this file is a public POST endpoint (dispatched by action id, no
// session required), so each argument below is attacker-controlled at runtime no matter
// what its TypeScript type says.

const CONTENT_TYPES = ['pages', 'posts', 'products'] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

function isContentType(value: unknown): value is ContentType {
  return typeof value === 'string' && (CONTENT_TYPES as readonly string[]).includes(value);
}

/** BCP 47 shape, cheap pre-check before the `languages` lookup (`en`, `fr`, `pt-BR`, ...). */
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_LANGUAGE_CODE_LENGTH = 16;

/**
 * The `code` of an ACTIVE row in `languages` matching `candidate` exactly, else null.
 * Only that value ever reaches the locale cookie.
 */
async function resolveActiveLanguageCode(candidate: unknown): Promise<string | null> {
  if (
    typeof candidate !== 'string' ||
    candidate.length > MAX_LANGUAGE_CODE_LENGTH ||
    !LANGUAGE_CODE_PATTERN.test(candidate)
  ) {
    return null;
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from('languages')
    .select('code, is_active')
    .eq('code', candidate)
    .maybeSingle();

  if (error) {
    console.error(`Error resolving language code ${candidate}:`, error);
    return null;
  }
  // `is_active` is nullable with DEFAULT true; only an explicit false disables a language.
  if (!data || data.is_active === false) return null;
  return data.code;
}

export async function getAvailableLanguages(): Promise<Language[]> {
  const supabase = createClient();
  const { data, error } = await supabase.from('languages').select('id, code, name, is_default, is_active, created_at, updated_at').order('name');
  if (error) {
    console.error('Error fetching languages:', error);
    return [];
  }
  return data as Language[];
}

export async function getCurrentLocale(defaultLocale = 'en'): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore.get('NEXT_LOCALE')?.value || defaultLocale;
}

/**
 * Store the visitor's locale. Only a code that exists (and is active) in `languages` is
 * written; anything else is a no-op and returns false.
 */
export async function setCurrentLocaleCookie(locale: string): Promise<boolean> {
  const code = await resolveActiveLanguageCode(locale);
  if (!code) return false;
  const cookieStore = await cookies();
  cookieStore.set('NEXT_LOCALE', code, { path: '/' });
  return true;
}

export async function getContentTranslations(translationGroupId: string, type: 'pages' | 'posts' | 'products' = 'pages'): Promise<{ slug: string, language_code: string }[]> {
  if (!translationGroupId) {
    console.warn('getContentTranslations called without translationGroupId');
    return [];
  }
  if (!isContentType(type)) {
    console.warn(`getContentTranslations called with an unknown content type: ${String(type)}`);
    return [];
  }
  const supabase = createClient();

  const { data, error } = await supabase
    .from(type)
    .select('slug, languages(code)')
    .eq('translation_group_id', translationGroupId)
    .eq('status', type === 'products' ? 'active' : 'published'); // Products use 'active' or 'draft' status usually, but let's check

  if (error) {
    console.error(`Error fetching translations for ${type}:`, error);
    return [];
  }

  // Map the data to the expected format { slug: string, language_code: string }
  const formattedTranslations = data
    ? (data as any[]).map(item => {
        let langCode = '';
        if (item.languages) {
          if (Array.isArray(item.languages)) {
            langCode = item.languages[0]?.code || '';
          } else {
            langCode = item.languages.code || '';
          }
        }
        return {
          slug: item.slug,
          language_code: langCode,
        };
      }).filter(t => t.language_code)
    : [];

  return formattedTranslations;
}

export async function getPageTranslations(translationGroupId: string): Promise<{ slug: string, language_code: string }[]> {
  return getContentTranslations(translationGroupId, 'pages');
}

// Helper to get language details by code, potentially used by LanguageSwitcher or other components
export async function getLanguageDetails(localeCode: string): Promise<Language | null> {
    const { data, error } = await getLanguageByCode(localeCode);
    if (error || !data) {
        // Optionally log the error or handle it more gracefully
        console.warn(`Could not fetch language details for ${localeCode}: ${error}`);
        return null;
    }
    return data;
}

export async function getContentMetadataBySlugAndLocale(slug: string, localeCode: string, type: 'pages' | 'posts' | 'products' = 'pages'): Promise<{ slug: string; translation_group_id: string | null; type: string } | null> {
  if (!slug || !localeCode) {
    console.warn('getContentMetadataBySlugAndLocale called without slug or localeCode');
    return null;
  }
  if (!isContentType(type)) {
    console.warn(`getContentMetadataBySlugAndLocale called with an unknown content type: ${String(type)}`);
    return null;
  }
  const supabase = createClient();
  const { data: languageData, error: langError } = await getLanguageByCode(localeCode);

  if (langError || !languageData) {
    console.warn(`Language with code ${localeCode} not found or error fetching: ${langError}`);
    return null;
  }

  const { data: item, error } = await supabase
    .from(type)
    .select('slug, translation_group_id')
    .eq('slug', slug)
    .eq('language_id', languageData.id)
    .maybeSingle();

  if (error) {
    console.error(`Error fetching metadata for ${type} slug ${slug} and locale ${localeCode}:`, error);
    return null;
  }
  if (!item) {
    return null;
  }
  return { ...item, type };
}

export async function getPageMetadataBySlugAndLocale(slug: string, localeCode: string): Promise<{ slug: string; translation_group_id: string | null } | null> {
  const metadata = await getContentMetadataBySlugAndLocale(slug, localeCode, 'pages');
  if (!metadata) return null;
  return { slug: metadata.slug, translation_group_id: metadata.translation_group_id };
}

/**
 * Switch the visitor's locale and send them back where they were. The cookie is only
 * written for a known active language, and the destination is only honoured when it is
 * a site-relative path — anything else (an absolute URL, `//host`, a backslash trick)
 * lands on the home page instead of off-site.
 */
export async function changeLanguage(newLocale: string, currentPath: string) {
    await setCurrentLocaleCookie(newLocale);
    redirect(typeof currentPath === 'string' && isSafeInternalPath(currentPath) ? currentPath : '/');
}
