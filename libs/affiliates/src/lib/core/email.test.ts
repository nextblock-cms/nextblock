import { describe, expect, it } from 'vitest';

import { affiliateEmailsMatch, normalizeAffiliateEmail } from './email';

/**
 * The same vectors must hold for `private.affiliate_normalize_email(text)` in migration 02030
 * (the posture script checks the plus-address case).
 */
describe('normalizeAffiliateEmail (mirror of private.affiliate_normalize_email)', () => {
  it.each([
    ['me+x@gmail.com', 'me@gmail.com'],
    ['m.e@gmail.com', 'me@gmail.com'],
    ['M.E+Promo@GoogleMail.com', 'me@gmail.com'],
    ['  Jane.Doe@Example.COM \n', 'jane.doe@example.com'],
    ['jane+shop@example.com', 'jane@example.com'],
    ['jane+a+b@example.com', 'jane@example.com'],
    ['first.last@outlook.com', 'first.last@outlook.com'],
    ['"a@b"@example.com', '"a@b"@example.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAffiliateEmail(input)).toBe(expected);
  });

  it('treats degenerate addresses exactly as the SQL does (no @ → as is; else local@domain)', () => {
    expect(normalizeAffiliateEmail('Not An Email')).toBe('not an email');
    expect(normalizeAffiliateEmail('@gmail.com')).toBe('@gmail.com');
    expect(normalizeAffiliateEmail('@GoogleMail.com')).toBe('@gmail.com');
    expect(normalizeAffiliateEmail('jane@')).toBe('jane@');
    expect(normalizeAffiliateEmail('me+x@')).toBe('me@');
    expect(normalizeAffiliateEmail('+promo@gmail.com')).toBe('@gmail.com');
    expect(normalizeAffiliateEmail('...@gmail.com')).toBe('@gmail.com');
  });

  it('trims ASCII whitespace only, like btrim with an explicit character list', () => {
    expect(normalizeAffiliateEmail('\t me@gmail.com \r\n')).toBe('me@gmail.com');
    expect(normalizeAffiliateEmail('\u00a0me@example.com')).toBe('\u00a0me@example.com');
  });

  it('answers null for blank and non-string input', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, []]) {
      expect(normalizeAffiliateEmail(value), String(value)).toBeNull();
    }
  });
});

describe('affiliateEmailsMatch', () => {
  it('matches a plus-addressed or dotted Gmail purchase to the partner account', () => {
    expect(affiliateEmailsMatch('me+x@gmail.com', 'm.e@gmail.com')).toBe(true);
    expect(affiliateEmailsMatch('Jane@Example.com', 'jane+deals@example.com')).toBe(true);
  });

  it('does not match different people, or missing addresses', () => {
    expect(affiliateEmailsMatch('jane@example.com', 'john@example.com')).toBe(false);
    expect(affiliateEmailsMatch('j.ane@example.com', 'jane@example.com')).toBe(false);
    expect(affiliateEmailsMatch(null, null)).toBe(false);
    expect(affiliateEmailsMatch('', '')).toBe(false);
  });
});
