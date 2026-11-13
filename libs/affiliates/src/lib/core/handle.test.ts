import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_HANDLE_MAX_LENGTH,
  AFFILIATE_HANDLE_MIN_LENGTH,
  AFFILIATE_HANDLE_PATTERN,
  RESERVED_AFFILIATE_HANDLES,
  isReservedAffiliateHandle,
  normalizeAffiliateHandle,
  suggestAffiliateHandle,
} from './handle';

describe('AFFILIATE_HANDLE_PATTERN', () => {
  it('is the regex of the affiliate_profiles.handle CHECK in migration 02030', () => {
    expect(AFFILIATE_HANDLE_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$');
    expect(AFFILIATE_HANDLE_PATTERN.flags).toBe('');
  });

  it('accepts 3 to 32 lowercase letters, digits and inner hyphens', () => {
    for (const handle of ['abc', 'a-b', 'a1b', 'jane-doe', '007', 'a'.repeat(32), 'a--b']) {
      expect(AFFILIATE_HANDLE_PATTERN.test(handle), handle).toBe(true);
    }
    expect(AFFILIATE_HANDLE_MIN_LENGTH).toBe(3);
    expect(AFFILIATE_HANDLE_MAX_LENGTH).toBe(32);
  });

  it('refuses short, long, edge-hyphen, uppercase and non-ASCII handles', () => {
    for (const handle of ['', 'ab', 'a'.repeat(33), '-abc', 'abc-', 'ABC', 'jane_doe', 'jane.doe', 'jané', 'ja ne', 'ｊａｎｅ']) {
      expect(AFFILIATE_HANDLE_PATTERN.test(handle), handle).toBe(false);
    }
  });
});

describe('RESERVED_AFFILIATE_HANDLES', () => {
  it('lists exactly the reserved names of the spec (the proxy keeps a parity copy)', () => {
    expect([...RESERVED_AFFILIATE_HANDLES].sort()).toEqual(
      [
        'admin', 'api', 'apply', 'cms', 'conditions', 'dashboard', 'help', 'join', 'login', 'logout', 'new', 'nextblock',
        'opengraph-image', 'partner', 'partners', 'portal', 'retailer', 'settings', 'signin', 'signup', 'sign-in',
        'sign-up', 'sitemap', 'store', 'support', 'terms', 'twitter-image', 'www',
      ].sort()
    );
  });

  it('reserves the partner terms addresses (/partners/terms, /partenaires/conditions)', () => {
    for (const handle of ['terms', 'Terms', 'conditions', ' CONDITIONS ']) {
      expect(isReservedAffiliateHandle(handle), handle).toBe(true);
      expect(normalizeAffiliateHandle(handle), handle).toBeNull();
    }
    expect(suggestAffiliateHandle('Terms')).toBe('terms-picks');
  });

  it('only holds strings that would otherwise be valid handles', () => {
    for (const handle of RESERVED_AFFILIATE_HANDLES) {
      expect(AFFILIATE_HANDLE_PATTERN.test(handle), handle).toBe(true);
    }
  });
});

describe('normalizeAffiliateHandle', () => {
  it('trims and lowercases a valid handle', () => {
    expect(normalizeAffiliateHandle('  Jane-Doe ')).toBe('jane-doe');
    expect(normalizeAffiliateHandle('JANE')).toBe('jane');
  });

  it('refuses reserved handles in any case', () => {
    expect(normalizeAffiliateHandle('admin')).toBeNull();
    expect(normalizeAffiliateHandle(' Partners ')).toBeNull();
    expect(normalizeAffiliateHandle('OPENGRAPH-IMAGE')).toBeNull();
    expect(isReservedAffiliateHandle(' Sign-Up ')).toBe(true);
    expect(isReservedAffiliateHandle('jane')).toBe(false);
  });

  it('refuses anything that is not a handle string', () => {
    for (const value of [null, undefined, 42, {}, ['jane'], 'ab', 'jane doe', 'jane/../admin', '@jane', 'x'.repeat(300)]) {
      expect(normalizeAffiliateHandle(value), String(value)).toBeNull();
    }
  });
});

describe('suggestAffiliateHandle', () => {
  it('slugifies display names, stripping accents', () => {
    expect(suggestAffiliateHandle('Jane Doe')).toBe('jane-doe');
    expect(suggestAffiliateHandle('Émilie Côté')).toBe('emilie-cote');
    expect(suggestAffiliateHandle("  O'Brien & Sons!! ")).toBe('o-brien-sons');
    expect(suggestAffiliateHandle('Ça Va Bien 2026')).toBe('ca-va-bien-2026');
  });

  it('pads short or reserved results and falls back when nothing usable is left', () => {
    expect(suggestAffiliateHandle('Al')).toBe('al-picks');
    expect(suggestAffiliateHandle('Admin')).toBe('admin-picks');
    expect(suggestAffiliateHandle('')).toBe('my-picks');
    expect(suggestAffiliateHandle('李小龍')).toBe('my-picks');
    expect(suggestAffiliateHandle('!!!')).toBe('my-picks');
  });

  it('truncates to 32 characters without a trailing hyphen', () => {
    const suggestion = suggestAffiliateHandle('The Very Long Display Name Of A Creator Studio');
    expect(suggestion.length).toBeLessThanOrEqual(32);
    expect(suggestion.endsWith('-')).toBe(false);
    expect(suggestion).toBe('the-very-long-display-name-of-a');
  });

  it('always returns a handle normalizeAffiliateHandle accepts', () => {
    const names = [
      'Jane', 'J', 'jo', 'Zoë Saldaña', 'ñ', '—', 'www', 'Partner', 'Store', 'A B', 'abc-', '-abc', '123',
      'x'.repeat(100), 'a-'.repeat(40), 'Ünïcödé Ñame With Spaces And Ümlauts', '   ', 'new', 'api',
    ];
    for (const name of names) {
      const suggestion = suggestAffiliateHandle(name);
      expect(normalizeAffiliateHandle(suggestion), `${name} → ${suggestion}`).toBe(suggestion);
    }
  });
});
