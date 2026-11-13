import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two consumers carry the NextBlock™ Affiliates & Creator Storefronts product page: the sandbox
 * reset (affiliates-product-copy.ts, applied after every reset) and migration 02032, which creates
 * the page on nextblock.dev. The migration was generated from the copy file; this guard fails when
 * either changes alone, and when the migration's product, plan, price, trial or slug drift from the
 * package registry (the dashboard quotes the registry, the checkout charges the Freemius plan).
 * A later copy change ships as a new migration: point MIGRATION at it.
 */

const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = 'libs/db/src/supabase/migrations/02032_affiliates_store_product.sql';
const sql = readFileSync(path.join(ROOT, MIGRATION), 'utf8').replace(/\r\n/g, '\n');

type ProductCopy = {
  title: string;
  short_description: string;
  meta_title: string;
  meta_description: string;
  sections: ReadonlyArray<Record<string, unknown>>;
};

// Loaded by URL: both live in other Nx projects, and neither file imports anything.
const copyModule = await import(
  pathToFileURL(path.join(ROOT, 'apps/nextblock/app/api/cron/reset-sandbox/affiliates-product-copy.ts')).href
);
const registryModule = await import(pathToFileURL(path.join(ROOT, 'libs/utils/src/lib/nextblock-packages.ts')).href);
const AFFILIATES_PRODUCT_COPY: Record<'en' | 'fr', ProductCopy> = copyModule.AFFILIATES_PRODUCT_COPY;
const AFFILIATES_PRODUCT_URL_PLACEHOLDER: string = copyModule.AFFILIATES_PRODUCT_URL_PLACEHOLDER;
const NEXTBLOCK_PACKAGES = registryModule.NEXTBLOCK_PACKAGES;
const affiliates = NEXTBLOCK_PACKAGES.affiliates;

/** A no-break space: the migration writes it as {{NBSP}} in text, which SQL turns back into chr(160). */
const NBSP = String.fromCharCode(160);

/** The text between `$tag$` and `$tag$`; fails the test when the tag is missing or repeated. */
function dollarQuoted(tag: string): string {
  const parts = sql.split(`$${tag}$`);
  expect(parts.length, `$${tag}$ should open and close exactly once`).toBe(3);
  return parts[1];
}

/** A text field as SQL stores it: the {{NBSP}} token becomes a no-break space again. */
function textField(tag: string): string {
  return dollarQuoted(tag).split('{{NBSP}}').join(NBSP);
}

describe('migration 02032 (the nextblock.dev Affiliates product page)', () => {
  it('carries the copy file sections, in both languages and in order', () => {
    for (const lang of ['en', 'fr'] as const) {
      const sections = AFFILIATES_PRODUCT_COPY[lang].sections;
      sections.forEach((section, index) => {
        expect(JSON.parse(dollarQuoted(`nbaf_${lang}_${index}`)), `${lang} section ${index}`).toEqual(section);
      });
      expect(sql.includes(`$nbaf_${lang}_${sections.length}$`), `${lang} has no extra section`).toBe(false);
    }
  });

  it('carries the copy file title, short description and meta, in both languages', () => {
    for (const lang of ['en', 'fr'] as const) {
      const copy = AFFILIATES_PRODUCT_COPY[lang];
      const fields: Array<[string, string]> = [
        [`nbaf_${lang}_title`, copy.title],
        [`nbaf_${lang}_new_title`, copy.title],
        [`nbaf_${lang}_short`, copy.short_description],
        [`nbaf_${lang}_meta_title`, copy.meta_title],
        [`nbaf_${lang}_meta_description`, copy.meta_description],
      ];
      for (const [tag, value] of fields) {
        expect(textField(tag), tag).toBe(value);
        // A tokenised field is wrapped in the replace() that turns the token back into chr(160).
        if (dollarQuoted(tag).includes('{{NBSP}}')) {
          expect(sql, tag).toContain(`$${tag}$, '{{NBSP}}', chr(160))`);
        }
      }
    }
  });

  it('holds no raw irregular whitespace (the generated bundles embed it in TS template strings)', () => {
    // ESLint's no-irregular-whitespace set, built from code points so this file stays clean too.
    const irregular = [0x0b, 0x0c, 0x85, 0xa0, 0x1680, 0x180e, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
      .concat(Array.from({ length: 12 }, (_, offset) => 0x2000 + offset))
      .map((codePoint) => String.fromCharCode(codePoint));
    for (const char of irregular) {
      expect(sql.includes(char), `U+${char.charCodeAt(0).toString(16).padStart(4, '0')}`).toBe(false);
    }
  });

  it('recognises its own copy by a phrase both languages still carry', () => {
    for (const lang of ['en', 'fr'] as const) {
      const signature = dollarQuoted(`nbaf_${lang}_sig`).replace(/^%|%$/g, '');
      expect(JSON.stringify(AFFILIATES_PRODUCT_COPY[lang].sections)).toContain(signature);
    }
  });

  it("points the call to action at the product's own page", () => {
    expect(sql).toContain(`'${AFFILIATES_PRODUCT_URL_PLACEHOLDER}', 'https://nextblock.dev/product/' || v_slug)`);
    expect(sql).toContain(`'${AFFILIATES_PRODUCT_URL_PLACEHOLDER}', 'https://nextblock.dev/product/' || v_fr_slug)`);
  });

  it('creates the row the registry sells, at the registry price and trial', () => {
    const slug = new URL(affiliates.purchase_url).pathname.replace(/^\/product\//, '');
    expect(affiliates.purchase_url).toBe(`https://nextblock.dev/product/${slug}`);
    expect(sql).toContain(`'${slug}', 'digital', 'freemius', ${affiliates.pricing.annual * 100}, 999, 'draft'`);
    expect(sql).toContain(
      `'FM-${affiliates.fm_product_id}-${affiliates.fm_plan_id}'`
    );
    expect(sql).toContain(
      `'${affiliates.fm_product_id}', '${affiliates.fm_plan_id}', ${affiliates.trial.days}, ${affiliates.trial.requiresPaymentMethod}`
    );
    expect(sql).toContain(`VALUES (v_plan, 1, ${affiliates.pricing.monthly}, ${affiliates.pricing.annual}, NULL)`);
  });

  it('runs on the vendor store only, and its file name keeps it in the reset bundle', () => {
    expect(sql).toContain(`IF NOT EXISTS (SELECT 1 FROM public.products WHERE freemius_product_id = '${NEXTBLOCK_PACKAGES.ecommerce.fm_product_id}') THEN`);
    expect(path.basename(MIGRATION)).not.toMatch(/sandbox/i);
  });
});
