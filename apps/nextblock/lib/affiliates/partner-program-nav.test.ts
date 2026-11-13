import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PARTNER_PROGRAM_NAV_GROUP_IDS,
  hideDormantPartnerProgramNav,
  isPartnerProgramHeaderItem,
  isPartnerProgramNavItem,
} from './partner-program-nav';
import { PARTNERS_LANDING_PATH, PARTNERS_LANDING_PATH_FR } from './partners-paths';
import { validateBlockContent } from '../blocks/blockRegistry';
import type { BlockType } from '../blocks/blockTypes';

/**
 * The seeded partner program links (02034) are recognised by their fixed translation groups: the
 * root layout hides them while the program is inactive, the header styles one as a pill and both
 * menus give it a "New" badge. The ids must stay equal to the migration's, and the module
 * import-free (the header and footer are client components).
 */

const HEADER_GROUP = PARTNER_PROGRAM_NAV_GROUP_IDS.header;
const FOOTER_GROUP = PARTNER_PROGRAM_NAV_GROUP_IDS.footer;

interface Row {
  id: number;
  parent_id: number | null;
  translation_group_id: string;
  label: string;
}

function row(id: number, label: string, group?: string, parentId: number | null = null): Row {
  return {
    id,
    parent_id: parentId,
    translation_group_id: group ?? `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    label,
  };
}

const labels = (rows: readonly Row[]) => rows.map((item) => item.label);

describe('isPartnerProgramNavItem / isPartnerProgramHeaderItem', () => {
  it('recognise the two seeded groups, whatever the case or padding of the stored id', () => {
    expect(isPartnerProgramNavItem({ translation_group_id: HEADER_GROUP })).toBe(true);
    expect(isPartnerProgramNavItem({ translation_group_id: FOOTER_GROUP })).toBe(true);
    expect(isPartnerProgramNavItem({ translation_group_id: ` ${HEADER_GROUP.toUpperCase()} ` })).toBe(true);
    expect(isPartnerProgramHeaderItem({ translation_group_id: HEADER_GROUP })).toBe(true);
    expect(isPartnerProgramHeaderItem({ translation_group_id: FOOTER_GROUP })).toBe(false);
  });

  it('answer false for any other row, and for missing input', () => {
    for (const item of [row(1, 'Contact'), { translation_group_id: null }, {}, null, undefined]) {
      expect(isPartnerProgramNavItem(item)).toBe(false);
      expect(isPartnerProgramHeaderItem(item)).toBe(false);
    }
  });

  it('never key on the URL: an operator link to /partners is an ordinary link', () => {
    const own = { ...row(9, 'Our partners'), url: PARTNERS_LANDING_PATH };
    expect(isPartnerProgramNavItem(own)).toBe(false);
  });
});

describe('hideDormantPartnerProgramNav', () => {
  const menu: Row[] = [
    row(1, 'Home'),
    row(2, 'Articles'),
    row(3, 'Become a partner', HEADER_GROUP),
    row(4, 'Partner FAQ', undefined, 3),
    row(5, 'Partner FAQ, French', undefined, 4),
    row(6, 'Contact'),
    row(7, 'Contact form', undefined, 6),
    row(8, 'Partner program', FOOTER_GROUP),
  ];

  it('keeps every row, in order, while the program is active', () => {
    expect(hideDormantPartnerProgramNav(menu, true)).toEqual(menu);
  });

  it('drops both groups and every row nested under them while the program is inactive', () => {
    // Without the descendants, buildHierarchy would promote "Partner FAQ" to the top level.
    expect(labels(hideDormantPartnerProgramNav(menu, false))).toEqual(['Home', 'Articles', 'Contact', 'Contact form']);
  });

  it('finds descendants listed before their parent', () => {
    const shuffled = [row(5, 'Grandchild', undefined, 4), row(4, 'Child', undefined, 3), row(3, 'Become a partner', HEADER_GROUP), row(1, 'Home')];
    expect(labels(hideDormantPartnerProgramNav(shuffled, false))).toEqual(['Home']);
  });

  it('matches parents by value when ids and parent ids differ in type', () => {
    const mixed = [
      { id: '3', parent_id: null, translation_group_id: HEADER_GROUP, label: 'Become a partner' },
      { id: 4, parent_id: '3', translation_group_id: 'x', label: 'Child' },
      { id: 6, parent_id: null, translation_group_id: 'y', label: 'Contact' },
    ];
    expect(hideDormantPartnerProgramNav(mixed, false).map((item) => item.label)).toEqual(['Contact']);
  });

  it('ends on a parent_id cycle', () => {
    const cyclic = [row(3, 'Become a partner', HEADER_GROUP, 5), row(4, 'A', undefined, 3), row(5, 'B', undefined, 4), row(6, 'Contact')];
    expect(labels(hideDormantPartnerProgramNav(cyclic, false))).toEqual(['Contact']);
  });

  it('returns a copy and leaves the input alone', () => {
    const input = [...menu];
    const kept = hideDormantPartnerProgramNav(input, true);
    expect(kept).not.toBe(input);
    hideDormantPartnerProgramNav(input, false);
    expect(input).toEqual(menu);
    expect(hideDormantPartnerProgramNav([], false)).toEqual([]);
  });

  it('keeps an operator link to /partners outside the seeded groups', () => {
    const own = [row(1, 'Home'), { ...row(2, 'Our partners'), url: PARTNERS_LANDING_PATH }];
    expect(labels(hideDormantPartnerProgramNav(own, false))).toEqual(['Home', 'Our partners']);
  });
});

describe('partner-program-nav module', () => {
  it('imports nothing (client components bundle it)', () => {
    const source = readFileSync(fileURLToPath(new URL('./partner-program-nav.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('app/layout.tsx wiring', () => {
  // A source check, like cached-translations.test.ts: the layout (headers, cookies, a dozen
  // readers) is not unit rendered.
  const layout = readFileSync(fileURLToPath(new URL('../../app/layout.tsx', import.meta.url)), 'utf8');

  it('reads the program state for every visitor, not only signed-in ones', () => {
    expect(layout).not.toMatch(/user\s*\?\s*isAffiliatesProgramActive\(\)/);
    expect(layout).toMatch(/^\s*isAffiliatesProgramActive\(\),$/m);
  });

  it('filters both menus with it and keeps the portal link for signed-in visitors only', () => {
    expect(layout).toContain('hideDormantPartnerProgramNav(headerNavRows, isAffiliatesActive)');
    expect(layout).toContain('hideDormantPartnerProgramNav(footerNavRows, isAffiliatesActive)');
    expect(layout).toContain('const isPartnerPortalActive = Boolean(user) && isAffiliatesActive === true;');
  });
});

describe('migration 02034_partner_program_nav_and_home', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../libs/db/src/supabase/migrations/02034_partner_program_nav_and_home.sql', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('declares the same two translation groups as the code', () => {
    expect(sql).toContain(`c_header_group constant uuid := '${HEADER_GROUP}';`);
    expect(sql).toContain(`c_footer_group constant uuid := '${FOOTER_GROUP}';`);
    expect(HEADER_GROUP).not.toBe(FOOTER_GROUP);
  });

  it('seeds the four rows: each menu in English and French, with the program addresses', () => {
    expect(PARTNERS_LANDING_PATH).toBe('/partners');
    expect(PARTNERS_LANDING_PATH_FR).toBe('/partenaires');
    const rows: Array<[string, string, string, string, string]> = [
      ['en', 'HEADER', 'c_header_group', 'Become a partner', PARTNERS_LANDING_PATH],
      ['fr', 'HEADER', 'c_header_group', 'Devenir partenaire', PARTNERS_LANDING_PATH_FR],
      ['en', 'FOOTER', 'c_footer_group', 'Partner program', PARTNERS_LANDING_PATH],
      ['fr', 'FOOTER', 'c_footer_group', 'Programme de partenaires', PARTNERS_LANDING_PATH_FR],
    ];
    for (const [code, menu, group, label, url] of rows) {
      expect(sql).toContain(`('${code}', '${menu}'::public.menu_location, ${group}, '${label}', '${url}')`);
    }
  });

  /** A home section's JSON, between its `$en$` / `$fr$` dollar quotes. */
  function section(tag: 'en' | 'fr'): {
    column_blocks: Array<Array<{ block_type: string; content: Record<string, unknown> }>>;
  } & Record<string, unknown> {
    const match = sql.match(new RegExp(`\\$${tag}\\$(\\{.*?\\})\\$${tag}\\$`, 's'));
    if (!match) throw new Error(`no $${tag}$ section in the migration`);
    return JSON.parse(match[1]);
  }

  it('seeds valid section blocks, the French one with the English structure and markup', () => {
    const skeleton = (html: unknown) => String(html).replace(/>[^<]*</g, '><');
    const en = section('en');
    const fr = section('fr');
    for (const body of [en, fr]) {
      expect(validateBlockContent('section', body).errors).toEqual([]);
      for (const block of body.column_blocks.flat()) {
        expect(validateBlockContent(block.block_type as BlockType, block.content).errors).toEqual([]);
      }
      expect(body.column_blocks.map((column) => column.map((block) => block.block_type))).toEqual([['text', 'button', 'button'], ['text']]);
    }
    const { column_blocks: enColumns, ...enRest } = en;
    const { column_blocks: frColumns, ...frRest } = fr;
    expect(frRest).toEqual(enRest);
    enColumns.forEach((column, c) =>
      column.forEach((block, b) => {
        const frBlock = frColumns[c][b];
        if (block.block_type === 'text') {
          expect(skeleton(frBlock.content.html_content)).toBe(skeleton(block.content.html_content));
        } else {
          expect({ ...frBlock.content, text: '', url: '' }).toEqual({ ...block.content, text: '', url: '' });
        }
      }),
    );
    // Quebec French: a plain space before % (and no glued "50%" left over from the English).
    expect(JSON.stringify(fr)).not.toMatch(/\d%/);
  });

  it('marks the home sections with the sentinel and links them to nextblock.dev in each language', () => {
    expect(sql.match(/<div class='nb-partner-program'>/g)).toHaveLength(2);
    expect(sql).toContain('"url":"https://nextblock.dev/partners"');
    expect(sql).toContain('"url":"https://nextblock.dev/partenaires"');
    expect(sql).toContain('"url":"https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license"');
    expect(sql).toContain('"url":"https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license-fr"');
  });

  it('stays out of the sandbox strip, the translations table and the hero rules', () => {
    expect(sql).not.toMatch(/sandbox/i);
    expect(sql).not.toContain(' ');
    expect(sql).not.toMatch(/public\.translations/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sql).not.toContain('backdrop-blur');
    expect(sql).not.toContain('<img');
  });
});
