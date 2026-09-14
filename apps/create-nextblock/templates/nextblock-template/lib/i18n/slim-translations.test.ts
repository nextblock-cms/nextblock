import { describe, expect, it } from 'vitest';
import {
  compactTranslationsForLocale,
  expandCompactTranslations,
  isCompactTranslations,
  slimTranslationsForLocale,
} from './slim-translations';

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
    key: 'en_only',
    translations: { en: 'English only' },
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
      { key: 'en_only', translations: { en: 'English only' } },
    ]);
  });

  it('keeps the active locale plus the en fallback the provider falls back to', () => {
    expect(slimTranslationsForLocale(rows, 'fr')).toEqual([
      { key: 'account_navigation', translations: { en: 'Account', fr: 'Compte' } },
      { key: 'fr_only', translations: { fr: 'Seulement en français' } },
      { key: 'en_only', translations: { en: 'English only' } },
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
});

describe('compactTranslationsForLocale', () => {
  it('emits tuples for the active locale and separate fallback-only tuples', () => {
    expect(compactTranslationsForLocale(rows, 'fr')).toEqual({
      lang: 'fr',
      fallbackLang: 'en',
      entries: [
        ['account_navigation', 'Compte'],
        ['fr_only', 'Seulement en français'],
      ],
      fallbackEntries: [['en_only', 'English only']],
    });
  });

  it('round-trips to the provider row shape through expandCompactTranslations', () => {
    const compact = compactTranslationsForLocale(rows, 'fr');
    expect(expandCompactTranslations(compact)).toEqual([
      { key: 'account_navigation', translations: { fr: 'Compte' } },
      { key: 'fr_only', translations: { fr: 'Seulement en français' } },
      { key: 'en_only', translations: { en: 'English only' } },
    ]);
    expect(isCompactTranslations(compact)).toBe(true);
    expect(isCompactTranslations(rows)).toBe(false);
  });

  it('is markedly smaller on the wire than the row shape for a realistic table', () => {
    const table = Array.from({ length: 385 }, (_, index) => ({
      key: `ui_string_${index}`,
      translations: { en: `English value number ${index}`, fr: `Valeur française numéro ${index}` },
      created_at: '2026-05-27T13:24:01.327641+00:00',
      updated_at: '2026-05-27T13:24:01.327641+00:00',
    }));
    const raw = JSON.stringify(table).length;
    const slim = JSON.stringify(slimTranslationsForLocale(table, 'en')).length;
    const compact = JSON.stringify(compactTranslationsForLocale(table, 'en')).length;
    // Real table on nextblock.dev: ~88 KB raw -> ~33 KB rows -> ~21 KB compact.
    expect(slim).toBeLessThan(raw / 2);
    expect(compact).toBeLessThan(slim * 0.8);
  });
});
