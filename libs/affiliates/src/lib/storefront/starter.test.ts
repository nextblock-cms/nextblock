import { describe, expect, it } from 'vitest';
import { isStorefrontDocEmpty, storefrontDocToPlainText } from './helpers';
import { sanitizeStorefrontDoc } from './sanitize';
import {
  buildStorefrontStarterDoc,
  buildStorefrontStarterMetaDescription,
  buildStorefrontStarterTitle,
} from './starter';
import type { StorefrontDoc } from './types';

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const OPTIONS = { allowedImageOrigins: ['https://images.pexels.com'] };

const NAMES: Array<string | null | undefined> = [
  'Jane',
  'Jane Doe',
  `${ch(0xc9)}lodie Tremblay`,
  "O'Neil & Sons <b>shop</b>",
  '<script>alert(1)</script>',
  `Emoji ${ch(0x1f680)} Star`,
  `  Tabs${ch(0x09)}and${ch(0x0a)}newlines${ch(0x00)}  `,
  `${ch(0x202e)}reversed`,
  'x'.repeat(500),
  `${'y'.repeat(79)}${ch(0x1f600)}`,
  '',
  '   ',
  null,
  undefined,
];

const headingText = (doc: StorefrontDoc): string => {
  const [first] = doc.content;
  return first && first.type === 'heading' ? (first.content?.[0] as { text: string } | undefined)?.text ?? '' : '';
};

describe('buildStorefrontStarterDoc', () => {
  it('builds the English starter: heading, intro, tip callout, empty grid, closing line', () => {
    const doc = buildStorefrontStarterDoc({ locale: 'en', displayName: 'Jane' });
    expect(doc.content.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'storefrontCallout',
      'affiliateProductGrid',
      'paragraph',
    ]);
    expect(headingText(doc)).toBe("Welcome to Jane's picks");
    expect(doc.content[2]).toMatchObject({ type: 'storefrontCallout', attrs: { tone: 'tip' } });
    expect(storefrontDocToPlainText(doc)).toContain('/promote');
    expect(doc.content[3]).toEqual({
      type: 'affiliateProductGrid',
      attrs: { productIds: [], title: 'My favorite products', columns: 3 },
    });
    expect(storefrontDocToPlainText(doc)).toContain('commission');
  });

  it('builds the French starter for fr and fr-CA', () => {
    for (const locale of ['fr', 'fr-CA', 'FR-ca', ' fr ']) {
      const doc = buildStorefrontStarterDoc({ locale, displayName: `${ch(0xc9)}lodie` });
      expect(headingText(doc)).toBe(`Bienvenue dans la s${ch(0xe9)}lection de ${ch(0xc9)}lodie`);
      expect(doc.content[3]).toEqual({
        type: 'affiliateProductGrid',
        attrs: { productIds: [], title: `Mes produits pr${ch(0xe9)}f${ch(0xe9)}r${ch(0xe9)}s`, columns: 3 },
      });
      expect(storefrontDocToPlainText(doc)).toContain('/promote');
    }
  });

  it('falls back to English for other or missing locales', () => {
    for (const locale of ['en-US', 'es', '', null, undefined]) {
      expect(headingText(buildStorefrontStarterDoc({ locale, displayName: 'Jane' }))).toBe("Welcome to Jane's picks");
    }
  });

  it('uses a name-free heading when the display name is blank', () => {
    expect(headingText(buildStorefrontStarterDoc({ locale: 'en', displayName: '  ' }))).toBe('Welcome to my picks');
    expect(headingText(buildStorefrontStarterDoc({ locale: 'fr', displayName: null }))).toBe(`Bienvenue dans ma s${ch(0xe9)}lection`);
  });

  it('cleans and shortens the display name', () => {
    expect(headingText(buildStorefrontStarterDoc({ locale: 'en', displayName: `  Tabs${ch(0x09)}and${ch(0x0a)}newlines${ch(0x00)}  ` }))).toBe(
      "Welcome to Tabs and newlines's picks",
    );
    const long = headingText(buildStorefrontStarterDoc({ locale: 'en', displayName: 'x'.repeat(500) }));
    expect(long).toBe(`Welcome to ${'x'.repeat(80)}'s picks`);
  });

  it.each(['en', 'fr'])('passes the sanitizer unchanged for every name (%s)', (locale) => {
    for (const displayName of NAMES) {
      const doc = buildStorefrontStarterDoc({ locale, displayName });
      const result = sanitizeStorefrontDoc(doc, OPTIONS);
      expect(result.issues, String(displayName)).toEqual([]);
      expect(result.changed, String(displayName)).toBe(false);
      expect(result.doc).toEqual(doc);
      expect(isStorefrontDocEmpty(doc)).toBe(false);
    }
  });

  it('returns a fresh document every call', () => {
    const first = buildStorefrontStarterDoc({ locale: 'en', displayName: 'Jane' });
    first.content.length = 0;
    expect(buildStorefrontStarterDoc({ locale: 'en', displayName: 'Jane' }).content).toHaveLength(5);
  });
});

describe('buildStorefrontStarterTitle', () => {
  it('builds a localized title of at most 120 characters', () => {
    expect(buildStorefrontStarterTitle({ locale: 'en', displayName: 'Jane' })).toBe("Jane's picks");
    expect(buildStorefrontStarterTitle({ locale: 'fr-CA', displayName: 'Jane' })).toBe(`La s${ch(0xe9)}lection de Jane`);
    expect(buildStorefrontStarterTitle({ locale: 'en', displayName: '' })).toBe('My picks');
    expect(buildStorefrontStarterTitle({ locale: 'fr', displayName: undefined })).toBe(`Ma s${ch(0xe9)}lection`);
    for (const locale of ['en', 'fr']) {
      for (const displayName of NAMES) {
        expect(buildStorefrontStarterTitle({ locale, displayName }).length).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe('buildStorefrontStarterMetaDescription', () => {
  it('stays between 70 and 160 characters for every name length, in both languages', () => {
    for (const locale of ['en', 'fr']) {
      for (let length = 0; length <= 80; length += 1) {
        const description = buildStorefrontStarterMetaDescription({ locale, displayName: 'n'.repeat(length) });
        expect(description.length, `${locale} ${length}`).toBeGreaterThanOrEqual(70);
        expect(description.length, `${locale} ${length}`).toBeLessThanOrEqual(160);
      }
      for (const displayName of NAMES) {
        const description = buildStorefrontStarterMetaDescription({ locale, displayName });
        expect(description.length).toBeGreaterThanOrEqual(70);
        expect(description.length).toBeLessThanOrEqual(160);
      }
    }
  });

  it('names the partner and the language', () => {
    expect(buildStorefrontStarterMetaDescription({ locale: 'en', displayName: 'Jane' })).toBe(
      "Discover Jane's favorite products, hand-picked and personally recommended. Shop the picks with confidence.",
    );
    expect(buildStorefrontStarterMetaDescription({ locale: 'fr', displayName: 'Jane' })).toContain('Jane');
    expect(buildStorefrontStarterMetaDescription({ locale: 'fr', displayName: 'Jane' })).toMatch(/^D/);
    expect(buildStorefrontStarterMetaDescription({ locale: 'en', displayName: '' })).toBe(
      'Discover my favorite products, hand-picked and personally recommended. Shop the picks with confidence.',
    );
  });
});
