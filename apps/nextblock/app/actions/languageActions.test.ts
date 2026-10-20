import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `changeLanguage` / `setCurrentLocaleCookie` are public server actions: the locale must
 * be a real active row in `languages` before it reaches the cookie, and the redirect
 * target must be a site-relative path before it reaches `redirect()`.
 */

const mocks = vi.hoisted(() => ({
  languagesByCode: {} as Record<string, { code: string; is_active: boolean | null } | undefined>,
  languageLookup: vi.fn(),
  from: vi.fn(),
  cookieSet: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@nextblock-cms/db', () => ({
  createClient: () => ({
    from: (table: string) => {
      mocks.from(table);
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            maybeSingle: async () => {
              mocks.languageLookup(value);
              return { data: mocks.languagesByCode[value] ?? null, error: null };
            },
          }),
        }),
      };
    },
  }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: mocks.cookieSet, get: () => undefined }),
}));

class RedirectSignal extends Error {
  constructor(public readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    mocks.redirect(target);
    throw new RedirectSignal(target);
  },
}));

vi.mock('../cms/settings/languages/actions', () => ({
  getLanguageByCode: vi.fn(async () => ({ data: null, error: 'not used here' })),
}));

import {
  changeLanguage,
  getContentMetadataBySlugAndLocale,
  getContentTranslations,
  setCurrentLocaleCookie,
} from './languageActions';

async function redirectTargetOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error('expected a redirect');
}

describe('setCurrentLocaleCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.languagesByCode = {
      en: { code: 'en', is_active: true },
      fr: { code: 'fr', is_active: true },
      de: { code: 'de', is_active: false },
      pt: { code: 'pt', is_active: null },
    };
  });

  it('writes the cookie for an active language', async () => {
    await expect(setCurrentLocaleCookie('fr')).resolves.toBe(true);
    expect(mocks.cookieSet).toHaveBeenCalledWith('NEXT_LOCALE', 'fr', { path: '/' });
  });

  it('treats a NULL is_active as active (column default)', async () => {
    await expect(setCurrentLocaleCookie('pt')).resolves.toBe(true);
  });

  it('refuses a language the table does not know', async () => {
    await expect(setCurrentLocaleCookie('xx')).resolves.toBe(false);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('refuses a deactivated language', async () => {
    await expect(setCurrentLocaleCookie('de')).resolves.toBe(false);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    'en; Path=/; Domain=evil.com',
    'en\r\nSet-Cookie: x=1',
    '<script>',
    'a'.repeat(40),
    '',
    'e',
  ])('never queries or stores a malformed code %j', async (code) => {
    await expect(setCurrentLocaleCookie(code)).resolves.toBe(false);
    expect(mocks.languageLookup).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('never stores a non-string', async () => {
    await expect(setCurrentLocaleCookie({ toString: () => 'en' } as never)).resolves.toBe(false);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe('changeLanguage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.languagesByCode = { fr: { code: 'fr', is_active: true } };
  });

  it('sets the cookie and returns the visitor to a clean internal path', async () => {
    const target = await redirectTargetOf(() => changeLanguage('fr', '/article/bonjour?x=1#top'));

    expect(target).toBe('/article/bonjour?x=1#top');
    expect(mocks.cookieSet).toHaveBeenCalledWith('NEXT_LOCALE', 'fr', { path: '/' });
  });

  it.each([
    '//evil.com',
    '/\\evil.com',
    '\\/evil.com',
    'https://evil.com',
    'http://evil.com/',
    '/%2F%2Fevil.com',
    '/path\nwith-control',
    'javascript:alert(1)',
    '   /leading-space',
    '',
  ])('falls back to the home page instead of redirecting to %j', async (payload) => {
    const target = await redirectTargetOf(() => changeLanguage('fr', payload));
    expect(target).toBe('/');
  });

  it('falls back to the home page for a non-string destination', async () => {
    const target = await redirectTargetOf(() => changeLanguage('fr', ['/x'] as never));
    expect(target).toBe('/');
  });

  it('leaves the cookie alone for an unknown locale but still navigates on-site', async () => {
    const target = await redirectTargetOf(() => changeLanguage('zz', '/shop'));

    expect(target).toBe('/shop');
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe('content lookups only touch the three content tables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('getContentTranslations ignores an arbitrary table name', async () => {
    const result = await getContentTranslations('group-1', 'profiles' as never);

    expect(result).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('getContentMetadataBySlugAndLocale ignores an arbitrary table name', async () => {
    const result = await getContentMetadataBySlugAndLocale('home', 'en', 'orders' as never);

    expect(result).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
