import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countMediaHistoryUses,
  countMediaUses,
  describeMediaUsageSite,
  isMediaUnused,
  parseMediaUsageAnswer,
  summarizeMediaUsage,
  withoutAdminOnlyLabels,
  WRITER_READABLE_SITE_SETTING_KEYS,
  type MediaUsage,
  type MediaUsageSite,
} from './media-usage-format';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../libs/db/src/supabase/migrations');

/**
 * How the media library reads public.media_usage's answer (02045) and describes it. A failed or
 * partial answer must never read as "unused": the delete dialogs, the "Unused" view and "Delete
 * unused" all decide from it.
 */

const ID = 'a1111111-1111-4111-8111-11111111111a';
const OTHER = 'b2222222-2222-4222-8222-22222222222b';

const site = (overrides: Partial<Record<string, unknown>> = {}) => ({
  kind: 'block',
  record_id: '41',
  parent_type: 'page',
  parent_id: '7',
  label: 'Home',
  language: 'fr',
  ...overrides,
});

describe('parseMediaUsageAnswer', () => {
  it('reads each id, in any case, into counts and places', () => {
    const usage = parseMediaUsageAnswer(
      { [ID]: { total: 2, by_kind: { block: 1, page_revision: 1 }, sites: [site(), site({ kind: 'page_revision', record_id: '3' })] } },
      [ID.toUpperCase()]
    );

    expect(usage.get(ID)).toEqual({
      total: 2,
      byKind: { block: 1, page_revision: 1 },
      sites: [
        { kind: 'block', recordId: '41', parentType: 'page', parentId: '7', label: 'Home', language: 'fr' },
        { kind: 'page_revision', recordId: '3', parentType: 'page', parentId: '7', label: 'Home', language: 'fr' },
      ],
    });
  });

  it.each<readonly [string, unknown]>([
    ['not an object', [{ id: ID }]],
    ['null', null],
    ['an id left out', { [OTHER]: { total: 0, by_kind: {}, sites: [] } }],
    ['no total', { [ID]: { by_kind: {}, sites: [] } }],
    ['a count that is not a number', { [ID]: { total: 1, by_kind: { block: '1' }, sites: [] } }],
    ['a place without a record id', { [ID]: { total: 1, by_kind: { block: 1 }, sites: [{ kind: 'block' }] } }],
  ])('throws on an answer that is %s', (_label, answer) => {
    expect(() => parseMediaUsageAnswer(answer, [ID])).toThrow(/the lookup/);
  });
});

describe('uses and history', () => {
  const usage = (byKind: Record<string, number>): MediaUsage => ({
    total: Object.values(byKind).reduce((sum, n) => sum + n, 0),
    byKind,
    sites: [],
  });

  it('counts drafts as uses and revisions as history only', () => {
    const mixed = usage({ block: 2, content_draft: 1, page_revision: 3, product_revision: 1 });
    expect(countMediaUses(mixed)).toBe(3);
    expect(countMediaHistoryUses(mixed)).toBe(4);
    expect(isMediaUnused(mixed)).toBe(false);
  });

  it('reads an item named only by revisions, or by nothing, as unused', () => {
    expect(isMediaUnused(usage({ page_revision: 2 }))).toBe(true);
    expect(isMediaUnused(usage({}))).toBe(true);
    expect(isMediaUnused(usage({ product_draft: 1 }))).toBe(false);
  });

  it('summarizes each case in one line', () => {
    expect(summarizeMediaUsage(usage({ block: 1 }))).toBe('Used in 1 place');
    expect(summarizeMediaUsage(usage({ block: 2, post_revision: 1 }))).toBe('Used in 2 places, and in 1 revision');
    expect(summarizeMediaUsage(usage({ page_revision: 2 }))).toBe('Only in revision history (2 revisions)');
    expect(summarizeMediaUsage(usage({}))).toBe('Nothing in this site uses it');
  });

  it('counts an item whose storage keys were not searched as used, and never calls what was found the whole answer', () => {
    expect(isMediaUnused(usage({ unchecked_key: 1 }))).toBe(false);
    expect(isMediaUnused(usage({ unchecked_key: 1, page_revision: 1 }))).toBe(false);
    expect(summarizeMediaUsage(usage({ unchecked_key: 1 }))).toBe('Could not be fully checked');
    expect(summarizeMediaUsage(usage({ unchecked_key: 1, block: 2 }))).toBe('Could not be fully checked; used in at least 2 places');
    expect(summarizeMediaUsage(usage({ unchecked_key: 1, block: 1, page_revision: 1 }))).toBe(
      'Could not be fully checked; used in at least 1 place, and in 1 revision'
    );
    expect(summarizeMediaUsage(usage({ unchecked_key: 1, page_revision: 2 }))).toBe('Could not be fully checked, and in 2 revisions');
  });
});

describe('describeMediaUsageSite', () => {
  const s = (overrides: Partial<MediaUsageSite>): MediaUsageSite => ({
    kind: 'block',
    recordId: '41',
    parentType: 'page',
    parentId: '7',
    label: 'Home',
    language: 'fr',
    ...overrides,
  });

  it.each<readonly [Partial<MediaUsageSite>, string, string | null]>([
    [{}, 'Page "Home" (FR): content block', '/cms/pages/7/edit'],
    [{ kind: 'product_gallery', parentType: 'product', parentId: 'p-1', label: 'Pro', language: 'en' }, 'Product "Pro" (EN): gallery', '/cms/products/p-1/edit'],
    [{ kind: 'post_feature_image', parentType: 'post', parentId: '9' }, 'Post "Home" (FR): feature image', '/cms/posts/9/edit'],
    [{ kind: 'content_draft' }, 'Page "Home" (FR): unpublished draft', '/cms/pages/7/edit'],
    [{ kind: 'page_revision' }, 'Page "Home" (FR): revision history', '/cms/pages/7/edit'],
    [{ kind: 'site_setting', parentType: null, parentId: null, label: 'site_social_image', language: null }, 'Social preview image (Branding)', '/cms/settings/logos'],
    [{ kind: 'site_setting', parentType: null, parentId: null, label: 'footer_extras', language: null }, 'Site setting "footer_extras"', null],
    [{ kind: 'logo', parentType: null, parentId: null, label: 'Main', language: null }, 'Logo "Main"', '/cms/settings/logos'],
    [{ kind: 'custom_block', recordId: 'cb-1', parentType: null, parentId: null, label: 'Hero', language: null }, 'Custom block "Hero": definition', '/cms/custom-blocks/cb-1'],
    [{ kind: 'redirect', parentType: null, parentId: null, label: '/brochure', language: null }, 'Redirect from "/brochure"', '/cms/settings/seo'],
    [{ kind: 'redirect', recordId: '', parentType: null, parentId: null, label: null, language: null }, 'A redirect', null],
    [{ kind: 'partner_page', recordId: 'pp-1', parentType: null, parentId: null, label: 'jane', language: null }, 'Partner storefront "jane"', '/cms/affiliates/approvals/pp-1'],
    [{ kind: 'partner_page', recordId: 'pp-1', parentType: null, parentId: null, label: null, language: null }, 'A partner storefront', null],
    [{ kind: 'profile', parentType: null, parentId: null, label: null, language: null }, "A user's profile picture", null],
    [
      { kind: 'unchecked_key', recordId: ID, parentType: null, parentId: null, label: null, language: null },
      'Its storage key could not be searched; check where it is used before deleting',
      null,
    ],
    [{ label: null }, 'Page #7: content block', '/cms/pages/7/edit'],
  ])('describes %o', (overrides, text, href) => {
    expect(describeMediaUsageSite(s(overrides))).toEqual({ text, href });
  });
});

describe('withoutAdminOnlyLabels', () => {
  const place = (kind: string, recordId: string, label: string | null, parent: Partial<MediaUsageSite> = {}): MediaUsageSite => ({
    kind,
    recordId,
    parentType: null,
    parentId: null,
    label,
    language: null,
    ...parent,
  });

  it("withholds a partner storefront's handle and keeps everything else", () => {
    const usage: MediaUsage = {
      total: 2,
      byKind: { block: 1, partner_page: 1 },
      sites: [
        { kind: 'block', recordId: '41', parentType: 'page', parentId: '7', label: 'Home', language: 'en' },
        { kind: 'partner_page', recordId: 'pp-1', parentType: null, parentId: null, label: 'jane', language: null },
      ],
    };

    const redacted = withoutAdminOnlyLabels(usage);

    expect(redacted.sites.map((entry) => entry.label)).toEqual(['Home', null]);
    expect(redacted.byKind).toEqual(usage.byKind);
    expect(usage.sites[1].label).toBe('jane'); // a copy
  });

  it("names no record a WRITER's RLS hides: partner storefronts, redirects (an inactive one is ADMIN-only) and ADMIN-tier settings", () => {
    const hidden = [
      place('partner_page', 'e5555555-5555-4555-8555-55555555555e', 'jane'),
      place('redirect', 'f6666666-6666-4666-8666-66666666666f', '/old-launch-draft'),
      place('site_setting', 'payment_public', 'payment_public'),
      place('site_setting', 'store_contact', 'store_contact'),
      place('site_setting', 'forms_contact', 'forms_contact'),
      place('site_setting', 'cortex_ai_agent_settings', 'cortex_ai_agent_settings'),
    ];
    const readable = [
      place('block', '41', 'Home', { parentType: 'page', parentId: '7', language: 'en' }),
      place('content_draft', '9', 'Draft page', { parentType: 'page', parentId: '8', language: 'fr' }),
      place('product_revision', '3', 'Pro', { parentType: 'product', parentId: 'p-1', language: 'en' }),
      place('site_setting', 'site_social_image', 'site_social_image'),
      place('site_setting', 'email_public', 'email_public'),
      place('logo', 'l-1', 'Main'),
      place('custom_block', 'cb-1', 'Hero'),
      place('navigation_item', '12', 'Shop'),
      place('category', 'c-1', 'Shoes'),
      place('site_theme', 't-1', 'Dark'),
      place('profile', 'u-1', null),
      place('unchecked_key', ID, null),
    ];
    const usage: MediaUsage = {
      total: hidden.length + readable.length,
      byKind: { partner_page: 1, redirect: 1, site_setting: 6, block: 1 },
      sites: [...hidden, ...readable],
    };

    const redacted = withoutAdminOnlyLabels(usage);

    expect(redacted.sites.slice(0, hidden.length)).toEqual(
      hidden.map((site) => ({ ...site, recordId: '', parentType: null, parentId: null, label: null, language: null }))
    );
    expect(redacted.sites.slice(hidden.length)).toEqual(readable);
    expect(redacted.total).toBe(usage.total);
    expect(redacted.byKind).toEqual(usage.byKind);
    // Nothing of a withheld record reaches the page, link included.
    expect(JSON.stringify(redacted)).not.toMatch(/jane|old-launch-draft|payment_public|store_contact|forms_contact|cortex_ai_agent_settings|e5555555|f6666666/);
    expect(redacted.sites.slice(0, hidden.length).map((site) => describeMediaUsageSite(site).href)).toEqual(hidden.map(() => null));
  });

  it("knows exactly the site_settings keys a WRITER reads: the latest site_settings_read_policy's branches below the ADMIN tier", () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort().reverse();
    const marker = 'CREATE POLICY site_settings_read_policy';
    const latest = names.map((name) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')).find((sql) => sql.includes(marker));
    if (!latest) throw new Error(`no migration has ${marker}`);
    const statement = latest.slice(latest.indexOf(marker));
    const policy = statement.slice(0, statement.indexOf(';'));
    // The two `key = ANY (ARRAY[...])` branches: every authenticated user's keys, and the staff ones
    // (ADMIN or WRITER). The ADMIN tier is `is_admin_mfa()` with `key <> ALL (...)`.
    const branches = [...policy.matchAll(/key\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]*)\]/g)].map((match) =>
      [...match[1].matchAll(/'([^']+)'/g)].map((key) => key[1])
    );
    expect(branches).toHaveLength(2);
    expect(policy).toMatch(/'WRITER'::public\.user_role/);

    expect([...WRITER_READABLE_SITE_SETTING_KEYS].sort()).toEqual(branches.flat().sort());
  });
});
