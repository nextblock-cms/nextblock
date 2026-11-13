import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  cookies: {} as Record<string, string>,
  headersThrow: false,
  cookiesThrow: false,
  languages: [] as Array<{ code: string; is_default: boolean; is_active: boolean | null }>,
  languagesError: null as { message: string } | null,
  languagesThrow: false,
  cacheKeys: [] as unknown[],
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    if (mocks.headersThrow) throw new Error('headers() outside a request scope');
    return { get: (name: string) => mocks.headers[name.toLowerCase()] ?? null };
  },
  cookies: async () => {
    if (mocks.cookiesThrow) throw new Error('cookies() outside a request scope');
    return {
      get: (name: string) => (name in mocks.cookies ? { name, value: mocks.cookies[name] } : undefined),
    };
  },
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: unknown) => {
    mocks.cacheKeys.push(keyParts);
    return fn;
  },
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ({
    from: (table: string) => {
      expect(table).toBe('languages');
      return {
        select: async () => {
          if (mocks.languagesThrow) throw new Error('fetch failed');
          return { data: mocks.languagesError ? null : mocks.languages, error: mocks.languagesError };
        },
      };
    },
  }),
}));

import {
  getActiveRequestLanguages,
  getRequestLocale,
  parseAcceptLanguageBase,
  pickRequestLocale,
  toAffiliatesLocale,
} from './request-locale';

const EN_FR = {
  activeCodes: ['en', 'fr'],
  defaultCode: 'en',
};

beforeEach(() => {
  mocks.headers = {};
  mocks.cookies = {};
  mocks.headersThrow = false;
  mocks.cookiesThrow = false;
  mocks.languages = [
    { code: 'en', is_default: true, is_active: true },
    { code: 'fr', is_default: false, is_active: null },
    { code: 'es', is_default: false, is_active: false },
  ];
  mocks.languagesError = null;
  mocks.languagesThrow = false;
});

describe('pickRequestLocale (the root layout order)', () => {
  it('prefers the proxy header over every cookie and Accept-Language', () => {
    expect(
      pickRequestLocale(
        { headerLocale: 'fr', userLocaleCookie: 'en', nextLocaleCookie: 'en', acceptLanguage: 'en-US' },
        EN_FR,
      ),
    ).toBe('fr');
  });

  it('then NEXT_USER_LOCALE, then NEXT_LOCALE, then Accept-Language', () => {
    expect(pickRequestLocale({ userLocaleCookie: 'fr', nextLocaleCookie: 'en', acceptLanguage: 'en' }, EN_FR)).toBe('fr');
    expect(pickRequestLocale({ nextLocaleCookie: 'fr', acceptLanguage: 'en' }, EN_FR)).toBe('fr');
    expect(pickRequestLocale({ acceptLanguage: 'fr-CA,fr;q=0.9,en;q=0.8' }, EN_FR)).toBe('fr');
  });

  it('skips a candidate that is not an active language', () => {
    expect(pickRequestLocale({ headerLocale: 'es', userLocaleCookie: 'fr' }, EN_FR)).toBe('fr');
    expect(pickRequestLocale({ headerLocale: '<script>', nextLocaleCookie: 'FR' }, EN_FR)).toBe('fr');
  });

  it('falls back to the default language, then en', () => {
    expect(pickRequestLocale({ headerLocale: 'de' }, { activeCodes: ['fr', 'en'], defaultCode: 'fr' })).toBe('fr');
    expect(pickRequestLocale({}, EN_FR)).toBe('en');
    expect(pickRequestLocale({}, { activeCodes: [], defaultCode: null })).toBe('en');
  });

  it('answers with the code as the table stores it', () => {
    expect(pickRequestLocale({ headerLocale: 'pt-br' }, { activeCodes: ['en', 'pt-BR'], defaultCode: 'en' })).toBe('pt-BR');
  });

  it('trusts a two-letter code when the language list is unavailable', () => {
    const none = { activeCodes: [], defaultCode: null };
    expect(pickRequestLocale({ userLocaleCookie: 'fr' }, none)).toBe('fr');
    expect(pickRequestLocale({ userLocaleCookie: 'zz-long-value' }, none)).toBe('en');
  });
});

describe('parseAcceptLanguageBase', () => {
  it('returns the base of the first entry only', () => {
    expect(parseAcceptLanguageBase('fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(parseAcceptLanguageBase('en_US')).toBe('en');
    expect(parseAcceptLanguageBase('  DE ;q=1')).toBe('de');
    expect(parseAcceptLanguageBase('*')).toBeNull();
    expect(parseAcceptLanguageBase('')).toBeNull();
    expect(parseAcceptLanguageBase(null)).toBeNull();
  });
});

describe('getRequestLocale', () => {
  it('reads the request in layout order against the active languages', async () => {
    mocks.headers = { 'x-user-locale': 'fr', 'accept-language': 'en-US' };
    mocks.cookies = { NEXT_USER_LOCALE: 'en' };
    await expect(getRequestLocale()).resolves.toBe('fr');
    expect(mocks.cacheKeys).toContainEqual(['affiliates-request-locale-languages']);
  });

  it('ignores an inactive language from the proxy header and uses the cookie', async () => {
    mocks.headers = { 'x-user-locale': 'es' };
    mocks.cookies = { NEXT_USER_LOCALE: 'fr' };
    await expect(getRequestLocale()).resolves.toBe('fr');
  });

  it('uses NEXT_LOCALE and then Accept-Language when the others are absent', async () => {
    mocks.cookies = { NEXT_LOCALE: 'fr' };
    await expect(getRequestLocale()).resolves.toBe('fr');
    mocks.cookies = {};
    mocks.headers = { 'accept-language': 'fr-FR,fr;q=0.9' };
    await expect(getRequestLocale()).resolves.toBe('fr');
  });

  it('never throws outside a request or when the language table is unreadable', async () => {
    mocks.headersThrow = true;
    mocks.cookiesThrow = true;
    await expect(getRequestLocale()).resolves.toBe('en');

    mocks.headersThrow = false;
    mocks.cookiesThrow = false;
    mocks.languagesThrow = true;
    mocks.cookies = { NEXT_USER_LOCALE: 'fr' };
    await expect(getRequestLocale()).resolves.toBe('fr');

    mocks.languagesThrow = false;
    mocks.languagesError = { message: 'relation does not exist' };
    mocks.cookies = { NEXT_USER_LOCALE: 'fr' };
    await expect(getRequestLocale()).resolves.toBe('fr');
  });
});

describe('getActiveRequestLanguages', () => {
  it('lists the active languages (is_active null counts) with the default, from the cached read', async () => {
    await expect(getActiveRequestLanguages()).resolves.toEqual({ activeCodes: ['en', 'fr'], defaultCode: 'en' });
    expect(mocks.cacheKeys).toContainEqual(['affiliates-request-locale-languages']);
  });

  it('never throws: an unreadable table gives an empty list', async () => {
    mocks.languagesThrow = true;
    await expect(getActiveRequestLanguages()).resolves.toEqual({ activeCodes: [], defaultCode: null });
    mocks.languagesThrow = false;
    mocks.languagesError = { message: 'relation does not exist' };
    await expect(getActiveRequestLanguages()).resolves.toEqual({ activeCodes: [], defaultCode: null });
  });
});

describe('toAffiliatesLocale', () => {
  it('maps every French variant to fr and everything else to en', () => {
    expect(toAffiliatesLocale('fr')).toBe('fr');
    expect(toAffiliatesLocale('fr-CA')).toBe('fr');
    expect(toAffiliatesLocale(' FR ')).toBe('fr');
    expect(toAffiliatesLocale('en')).toBe('en');
    expect(toAffiliatesLocale('es')).toBe('en');
    expect(toAffiliatesLocale('')).toBe('en');
    expect(toAffiliatesLocale(null)).toBe('en');
    expect(toAffiliatesLocale(undefined)).toBe('en');
  });
});
