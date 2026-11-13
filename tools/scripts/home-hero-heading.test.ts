import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeAuthoredBlockHtml } from '@nextblock-cms/utils';

/**
 * Migration 02039 rewrites the home hero H1 (EN 'home', FR 'accueil').
 *
 * The highlighted word sits in a relative inline-block (the gradient pill). CSS Text allows a line
 * break after every atomic inline, even right before punctuation, so with the H1's
 * `text-wrap: balance` the period after the pill wrapped to the next line on its own. French also
 * ran to four lines on every desktop width. These checks keep the new markup from regressing, keep
 * English and French on identical markup, and pin the visible-text signatures the migration looks
 * for to the headings the seed actually shipped: a typo there would make the migration a silent
 * no-op on every install, the sandbox included.
 */

const MIGRATIONS = new URL('../../libs/db/src/supabase/migrations/', import.meta.url);
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, MIGRATIONS)), 'utf8').replace(/\r\n/g, '\n');

const sql = read('02039_home_hero_heading_fit.sql');

/** A string between `$tag$` dollar quotes in 02039. */
function dollarQuoted(tag: string): string {
  const match = sql.match(new RegExp(`\\$${tag}\\$(.*?)\\$${tag}\\$`, 's'));
  if (!match) throw new Error(`no $${tag}$ string in 02039`);
  return match[1];
}

const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const RIGHT_SINGLE_QUOTE = String.fromCharCode(0x2019);

/** Mirrors pg_temp.nb_02039_visible_text: a <br> read as a space, other tags dropped, a few entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<br[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(new RegExp(`&nbsp;|&#160;|${NO_BREAK_SPACE}`, 'g'), ' ')
    .replace(new RegExp(`&#39;|&apos;|${RIGHT_SINGLE_QUOTE}`, 'g'), "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first H1 in a seed file that contains `marker`, with SQL-doubled quotes undone if needed. */
function seededH1(file: string, marker: string, sqlQuoted: boolean): string {
  const text = read(file);
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`${file} has no ${marker}`);
  const start = text.lastIndexOf('<h1', at);
  const end = text.indexOf('</h1>', at) + '</h1>'.length;
  const h1 = text.slice(start, end);
  return sqlQuoted ? h1.replace(/''/g, "'") : h1;
}

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The migration compares visible text with every space removed. */
const squeezed = (text: string) => text.replace(/ /g, '');

const newH1 = { en: dollarQuoted('en_h1'), fr: dollarQuoted('fr_h1') };
const seeded = {
  en: seededH1('02004_baseline_seed.sql', 'Prompt to <span', true),
  fr: seededH1('02008_home_fr_parity.sql', 'Du prompt à la <span', false),
};

describe('migration 02039_home_hero_heading_fit', () => {
  it('looks for the headings the seed shipped, and for the hand-edited English one', () => {
    expect(visibleText(seeded.en)).toBe('Prompt to Production. The AI Website Builder CMS.');
    expect(visibleText(seeded.fr)).toBe("Du prompt à la production. Le CMS constructeur de sites web par l'IA.");
    expect(sql).toContain(sqlLiteral(visibleText(seeded.en)));
    expect(sql).toContain(sqlLiteral(visibleText(seeded.fr)));
    // nextblock.dev: the period and the <br> were deleted by hand before this migration.
    expect(sql).toContain(sqlLiteral('Prompt to Production The AI Website Builder CMS.'));
    // The seeded strings are also replaced in page_revisions, so they must be quoted verbatim.
    expect(dollarQuoted('en_seed')).toBe(seeded.en);
    expect(dollarQuoted('fr_seed')).toBe(seeded.fr);
  });

  it('still matches copies the CMS editor re-serialised', () => {
    // A Tiptap re-save drops the <br>'s class and the space after it; deleting the period and the
    // break in the editor leaves the words touching the pill.
    const seedText = { en: visibleText(seeded.en), fr: visibleText(seeded.fr) };
    const doubleQuoteAttributes = (html: string) => html.replace(/='([^']*)'/g, '="$1"');
    const resaved = {
      en: doubleQuoteAttributes(seeded.en.replace(".<br class='md:hidden' /> The", '.<br>The')),
      fr: doubleQuoteAttributes(seeded.fr.replace(".<br class='md:hidden' /> Le", '.<br>Le')),
    };
    expect(squeezed(visibleText(resaved.en))).toBe(squeezed(seedText.en));
    expect(squeezed(visibleText(resaved.fr))).toBe(squeezed(seedText.fr));
    const handEdited = seeded.en.replace(".<br class='md:hidden' /> The", 'The');
    expect(squeezed(visibleText(handEdited))).toBe(squeezed('Prompt to Production The AI Website Builder CMS.'));
    // A reworded heading still does not match.
    expect(squeezed(visibleText(seeded.en.replace('Builder', 'Maker')))).not.toBe(squeezed(seedText.en));
    expect(sql).toContain("replace(pg_temp.nb_02039_visible_text(v_html), ' ', '')");
  });

  it('keeps the highlighted word and its period in one unbreakable span', () => {
    for (const html of Object.values(newH1)) {
      const pill = html.match(
        /<span class='whitespace-nowrap'><span class='relative inline-block[^']*'>(?:(?!<\/span><\/span>).)*<\/span><\/span>\.<\/span>/s,
      );
      if (!pill) throw new Error(`no unbreakable pill + period in: ${html}`);
      // No inline-block anywhere else in the heading is directly followed by punctuation.
      expect(html.replace(pill[0], '')).not.toMatch(/<\/span>[.,;:!?]/);
    }
  });

  it('sizes the heading by its column, over the old sizes, and stacks the sentences by the column', () => {
    for (const html of Object.values(newH1)) {
      // The column size sits behind a container variant: a stylesheet built before 02039 (the
      // deploy window) or a browser without container queries keeps text-5xl md:text-6xl.
      expect(
        html.startsWith(
          "<div class='@container'><h1 class='text-5xl md:text-6xl @min-[1px]:text-[length:clamp(2.5rem,8.5cqi,3.75rem)] mb-0 ",
        ),
      ).toBe(true);
      expect(html.endsWith('</h1></div>')).toBe(true);
      expect(html).toContain("<br class='@md:hidden' />");
      expect(html).not.toContain("class='md:hidden'");
    }
  });

  it('gives English and French identical markup', () => {
    const skeleton = (html: string) => html.replace(/>[^<]*</g, '><');
    expect(skeleton(newH1.fr)).toBe(skeleton(newH1.en));
  });

  it('keeps the words, and fits the French second sentence in the measured three-line budget', () => {
    expect(visibleText(newH1.en)).toBe('Prompt to Production. The AI Website Builder CMS.');
    const fr = visibleText(newH1.fr);
    expect(fr.startsWith('Du prompt à la production. ')).toBe(true);
    // 29 characters at 60px is about 840px in the site's font: the most that keeps the H1 at
    // three lines in a 668px column (measured on nextblock.dev, 2026-11-12). The old sentence had 42.
    expect(fr.slice('Du prompt à la production. '.length).length).toBeLessThanOrEqual(29);
    // No last word on a line of its own: the final words are tied with no-break spaces.
    expect(newH1.en).toMatch(/&nbsp;[^ <]+<\/h1>/);
    expect(newH1.fr).toMatch(/&nbsp;[^ <]+<\/h1>/);
    // French: each clause stays on one line ("L'IA bâtit," / "le CMS publie."); English never ends
    // line 1 on "The" (Roboto fits "Prompt to Production. The" otherwise).
    expect(newH1.fr).toContain("L'IA&nbsp;bâtit, le&nbsp;CMS&nbsp;publie.");
    expect(newH1.en).toContain('The&nbsp;AI');
  });

  it('renders as written: the authored-HTML sanitizer keeps every class', () => {
    for (const html of Object.values(newH1)) {
      const out = sanitizeAuthoredBlockHtml(html);
      for (const cls of html.match(/class='[^']*'/g) ?? []) {
        for (const token of cls.slice("class='".length, -1).split(' ')) {
          expect(out, token).toContain(token);
        }
      }
      expect(visibleText(out)).toBe(visibleText(html));
    }
  });
});
