import { describe, expect, it } from 'vitest';
import { slimTranslationsForLocale } from './slim-translations';

const rows = [
  {
    key: 'account_navigation',
    translations: { en: 'Account', fr: 'Compte', de: 'Konto' },
    created_at: '2026-05-27T13:24:01.327641+00:00',
    updated_at: '2026-05-27T13:24:01.327641+00:00',
  },
  {
    key: 'fr_only',
    translations: { fr: 'Seulement en français' },
    created_at: '2026-05-27T13:24:01.327641+00:00',
    updated_at: '2026-05-27T13:24:01.327641+00:00',
  },
  {
    key: 'malformed',
    translations: 'not an object',
    created_at: '2026-05-27T13:24:01.327641+00:00',
    updated_at: '2026-05-27T13:24:01.327641+00:00',
  },
  {
    key: 'empty',
    translations: null,
    created_at: '2026-05-27T13:24:01.327641+00:00',
    updated_at: '2026-05-27T13:24:01.327641+00:00',
  },
];

describe('slimTranslationsForLocale', () => {
  it('keeps only the active locale when it is the fallback locale', () => {
    expect(slimTranslationsForLocale(rows, 'en')).toEqual([
      { key: 'account_navigation', translations: { en: 'Account' } },
    ]);
  });

  it('keeps the active locale plus the en fallback the provider falls back to', () => {
    expect(slimTranslationsForLocale(rows, 'fr')).toEqual([
      { key: 'account_navigation', translations: { en: 'Account', fr: 'Compte' } },
      { key: 'fr_only', translations: { fr: 'Seulement en français' } },
    ]);
  });

  it('drops timestamps and every other locale', () => {
    const [row] = slimTranslationsForLocale(rows, 'de');
    expect(row).toEqual({ key: 'account_navigation', translations: { en: 'Account', de: 'Konto' } });
    expect(row).not.toHaveProperty('created_at');
    expect(row.translations).not.toHaveProperty('fr');
  });

  it('skips rows with no usable value instead of shipping empty objects', () => {
    const keys = slimTranslationsForLocale(rows, 'fr').map((row) => row.key);
    expect(keys).not.toContain('malformed');
    expect(keys).not.toContain('empty');
  });

  it('shrinks the payload substantially for a realistic table', () => {
    const table = Array.from({ length: 385 }, (_, index) => ({
      key: `ui_string_${index}`,
      translations: { en: `English value number ${index}`, fr: `Valeur française numéro ${index}` },
      created_at: '2026-05-27T13:24:01.327641+00:00',
      updated_at: '2026-05-27T13:24:01.327641+00:00',
    }));
    const before = JSON.stringify(table).length;
    const after = JSON.stringify(slimTranslationsForLocale(table, 'en')).length;
    // Real table on nextblock.dev: ~88 KB -> ~23 KB. Synthetic values here are
    // longer than typical UI strings, so only assert the order of magnitude.
    expect(after).toBeLessThan(before / 2);
  });
});
