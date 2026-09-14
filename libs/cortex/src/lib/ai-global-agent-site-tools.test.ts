import { describe, expect, it } from 'vitest';

import {
  executeFinishSiteBuild,
  executeGetSiteOverview,
  executeResetSiteContent,
  executeSaveSiteBrief,
  executeStartSiteBuild,
  executeUpdateSiteIdentity,
  resolveCortexBuildSession,
} from './ai-global-agent-site-tools';
import { CORTEX_AI_BUILD_SESSION_SETTING_KEY, CORTEX_AI_SITE_BRIEF_SETTING_KEY } from './site-brief';

type MockRow = Record<string, any>;
type MockDatabase = Record<string, MockRow[]>;

/**
 * Minimal PostgREST-shaped query builder over in-memory tables. Only the methods
 * the site tools use are implemented; anything else throws loudly so a new query
 * shape in the executors shows up here rather than silently returning nothing.
 */
class MockQuery {
  private filters: Array<{ column: string; operator: 'eq' | 'in' | 'neq'; value: unknown }> = [];
  private limitCount: number | null = null;
  private operation: 'delete' | 'insert' | 'select' | 'update' | 'upsert' = 'select';
  private payload: MockRow | MockRow[] | null = null;
  private single: 'maybe' | 'one' | null = null;

  constructor(
    private readonly database: MockDatabase,
    private readonly table: string,
    private readonly writes: Array<{ op: string; table: string }>
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, operator: 'neq', value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ column, operator: 'in', value });
    return this;
  }

  order() {
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  maybeSingle() {
    this.single = 'maybe';
    return this;
  }

  delete() {
    this.operation = 'delete';
    this.writes.push({ op: 'delete', table: this.table });
    return this;
  }

  insert(payload: MockRow | MockRow[]) {
    this.operation = 'insert';
    this.payload = payload;
    this.writes.push({ op: 'insert', table: this.table });
    return this;
  }

  update(payload: MockRow) {
    this.operation = 'update';
    this.payload = payload;
    this.writes.push({ op: 'update', table: this.table });
    return this;
  }

  upsert(payload: MockRow | MockRow[]) {
    this.operation = 'upsert';
    this.payload = payload;
    this.writes.push({ op: 'upsert', table: this.table });
    return this;
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matches(row: MockRow) {
    return this.filters.every((filter) => {
      const value = row[filter.column];
      if (filter.operator === 'eq') return value === filter.value;
      if (filter.operator === 'neq') return value !== filter.value;
      return Array.isArray(filter.value) && filter.value.includes(value);
    });
  }

  private async execute() {
    if (!(this.table in this.database)) {
      throw new Error(`Unexpected mock table: ${this.table}`);
    }

    const rows = this.database[this.table];

    if (this.operation === 'insert') {
      const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as MockRow[];
      rows.push(...inserted.map((row) => ({ ...row })));
      return { data: inserted, error: null };
    }

    if (this.operation === 'upsert') {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as MockRow[];
      for (const row of incoming) {
        const keyColumn = 'id' in row ? 'id' : 'key' in row ? 'key' : Object.keys(row)[0];
        const index = rows.findIndex((current) => current[keyColumn] === row[keyColumn]);
        if (index >= 0) rows[index] = { ...rows[index], ...row };
        else rows.push({ ...row });
      }
      return { data: incoming, error: null };
    }

    if (this.operation === 'update') {
      const updated: MockRow[] = [];
      this.database[this.table] = rows.map((row) => {
        if (!this.matches(row)) return row;
        const next = { ...row, ...(this.payload as MockRow) };
        updated.push(next);
        return next;
      });
      return { data: updated, error: null };
    }

    if (this.operation === 'delete') {
      const removed = rows.filter((row) => this.matches(row));
      this.database[this.table] = rows.filter((row) => !this.matches(row));
      return { data: removed, error: null };
    }

    let data = rows.filter((row) => this.matches(row));
    if (this.limitCount !== null) data = data.slice(0, this.limitCount);
    if (this.single) return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }
}

const SEED_HOME_GROUP = '0098e4f0-e5f3-4e28-acfc-bb9fdb3a4a6b';
const SEED_CONTACT_GROUP = 'e3b28669-7e38-47bd-9189-7db2353b52dc';
const SEED_POST_GROUP = 'de8b8593-1ef6-4e66-8d1f-8b3e7ffb811d';
const SEED_LOGO_MEDIA = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function createMockSupabase(overrides?: Partial<MockDatabase>, profileRole: string | null = 'ADMIN') {
  const writes: Array<{ op: string; table: string }> = [];
  const database: MockDatabase = {
    blocks: [
      { id: 1, block_type: 'section', content: {}, page_id: 1, post_id: null },
      { id: 2, block_type: 'text', content: {}, page_id: 2, post_id: null },
      { id: 3, block_type: 'text', content: {}, page_id: 3, post_id: null },
      { id: 4, block_type: 'text', content: {}, page_id: null, post_id: 1 },
      { id: 5, block_type: 'text', content: {}, page_id: 5, post_id: null },
    ],
    content_drafts: [{ id: 'd1', parent_type: 'page', parent_id: 3 }],
    custom_block_definitions: [{ slug: 'promo-card', name: 'Promo card', fields: [{ key: 'title', type: 'text' }] }],
    languages: [
      { id: 1, code: 'en', name: 'English', is_default: true, is_active: true },
      { id: 2, code: 'fr', name: 'Français', is_default: false, is_active: true },
    ],
    logos: [{ id: 'logo-1', name: 'NextBlock Logo', media_id: SEED_LOGO_MEDIA, created_at: '2024-01-01' }],
    media: [
      { id: SEED_LOGO_MEDIA, object_key: 'images/nextblock-logo-button-tiny.png', file_name: 'logo.png', created_at: '2024-01-01' },
      { id: 'media-user', object_key: 'uploads/team.jpg', file_name: 'team.jpg', created_at: '2024-02-01' },
    ],
    navigation_items: [
      { id: 1, label: 'Home', url: '/', menu_key: 'HEADER', language_id: 1, parent_id: null, order: 0, page_id: 1 },
      { id: 2, label: 'Contact', url: '/contact', menu_key: 'HEADER', language_id: 1, parent_id: null, order: 1, page_id: 3 },
      { id: 3, label: 'Accueil', url: '/accueil', menu_key: 'HEADER', language_id: 2, parent_id: null, order: 0, page_id: 2 },
    ],
    pages: [
      { id: 1, slug: 'home', title: 'Home', status: 'published', language_id: 1, translation_group_id: SEED_HOME_GROUP, author_id: null },
      { id: 2, slug: 'accueil', title: 'Accueil', status: 'published', language_id: 2, translation_group_id: SEED_HOME_GROUP, author_id: null },
      { id: 3, slug: 'contact', title: 'Contact Us', status: 'published', language_id: 1, translation_group_id: SEED_CONTACT_GROUP, author_id: null },
      { id: 4, slug: 'contact', title: 'Contactez-nous', status: 'published', language_id: 2, translation_group_id: SEED_CONTACT_GROUP, author_id: null },
      { id: 5, slug: 'about-us', title: 'About us', status: 'draft', language_id: 1, translation_group_id: 'user-group-1', author_id: 'user_1' },
    ],
    posts: [
      { id: 1, slug: 'how-nextblock-works', title: 'How NextBlock Works', status: 'published', language_id: 1, translation_group_id: SEED_POST_GROUP, author_id: null },
      { id: 2, slug: 'our-story', title: 'Our story', status: 'published', language_id: 1, translation_group_id: 'user-post-1', author_id: 'user_1' },
    ],
    products: [],
    profiles: profileRole ? [{ id: 'user_1', role: profileRole }] : [],
    site_settings: [
      { key: 'site_title', value: 'NextBlock™ CMS' },
      { key: 'site_description', value: 'The block CMS' },
      { key: 'footer_copyright', value: { en: '© {year} Nextblock CMS. All rights reserved.', fr: '© {year} Nextblock CMS. Tous droits réservés.' } },
      { key: 'active_logo_id', value: 'logo-1' },
    ],
    site_themes: [{ slug: 'light', name: 'Light', is_default: true, is_active: true, color_scheme: 'light', sort_order: 0 }],
    ...overrides,
  };

  return {
    database,
    supabase: { from: (table: string) => new MockQuery(database, table, writes) },
    writes,
  };
}

function expectConfirmation(result: unknown) {
  expect(result).toMatchObject({ mutationExecuted: false, requiresConfirmation: true, success: true });
  const phrase = (result as { confirmationPhrase?: unknown }).confirmationPhrase;
  expect(phrase).toEqual(expect.stringMatching(/^CONFIRM .+ #[a-f0-9]{8}$/));
  return result as { confirmationPhrase: string; preview: Record<string, any> };
}

describe('get_site_overview', () => {
  it('summarizes languages, content, navigation, identity, and the seeded demo content', async () => {
    const { supabase } = createMockSupabase();

    const overview = await executeGetSiteOverview({}, { supabase });

    expect(overview.success).toBe(true);
    expect(overview.languages.map((language) => language.code)).toEqual(['en', 'fr']);
    expect(overview.homePage).toMatchObject({ id: 1, slug: 'home', blockCount: 1, isSeeded: true });
    expect(overview.pages.find((page) => page.slug === 'about-us')).toMatchObject({ isSeeded: false, languageCode: 'en' });
    expect(overview.navigation?.header['en'].map((item) => item.label)).toEqual(['Home', 'Contact']);
    expect(overview.navigation?.header['fr'].map((item) => item.label)).toEqual(['Accueil']);
    expect(overview.identity.siteTitle).toBe('NextBlock™ CMS');
    expect(overview.identity.activeLogo).toMatchObject({ id: 'logo-1', isSeeded: true });
    expect(overview.seeded).toMatchObject({ anyPresent: true, copyright: true, logo: true, media: 1, pages: 4, posts: 1, siteTitle: true });
    expect(overview.brief).toBeNull();
    expect(overview.drafts).toEqual([{ parentId: 3, parentType: 'page' }]);
    expect(overview.customBlocks).toEqual([
      { fieldCount: 1, fields: [{ key: 'title', required: false, type: 'text' }], name: 'Promo card', slug: 'promo-card' },
    ]);
    expect(overview.nextSteps.join(' ')).toMatch(/demo content is still present/);
    expect(overview.nextSteps.join(' ')).toMatch(/No site brief/);
  });
});

describe('update_site_identity', () => {
  it('requires a confirmation, then upserts only the supplied keys', async () => {
    const { database, supabase, writes } = createMockSupabase(undefined, 'WRITER');
    const input = { footer_show_attribution: false, site_title: 'Acme Bakery' };

    const preview = expectConfirmation(await executeUpdateSiteIdentity(input, { actorUserId: 'user_1', supabase }));
    expect(preview.preview.changes).toEqual(input);
    expect(writes.filter((write) => write.op === 'upsert')).toHaveLength(0);

    const result = await executeUpdateSiteIdentity(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result).toMatchObject({ mutationExecuted: true, success: true, updatedKeys: ['footer_show_attribution', 'site_title'] });
    expect(database.site_settings.find((row) => row.key === 'site_title')?.value).toBe('Acme Bakery');
    expect(database.site_settings.find((row) => row.key === 'footer_show_attribution')?.value).toBe(false);
    expect(database.site_settings.find((row) => row.key === 'site_description')?.value).toBe('The block CMS');
  });

  it('refuses an empty update and an unknown actor', async () => {
    const { supabase } = createMockSupabase();

    await expect(executeUpdateSiteIdentity({}, { actorUserId: 'user_1', supabase })).rejects.toThrow(/at least one/i);
    await expect(executeUpdateSiteIdentity({ site_title: 'X' }, { supabase })).rejects.toThrow(/requires a known CMS user/);
  });
});

describe('save_site_brief', () => {
  it('merges over the saved brief and validates the result', async () => {
    const { database, supabase } = createMockSupabase();

    const first = await executeSaveSiteBrief(
      { brief: { business_name: 'Acme Bakery', languages: ['en', 'fr'], site_type: 'landing-page' } },
      { supabase }
    );
    expect(first).toMatchObject({ created: true, mutationExecuted: true, success: true });
    expect(first.brief.status).toBe('draft');

    const second = await executeSaveSiteBrief(
      { brief: { brand: { primary_color: '#b45309', tone: 'warm' }, pages: [{ slug: 'home', title: 'Home' }] } },
      { supabase }
    );
    expect(second.created).toBe(false);
    expect(second.brief).toMatchObject({
      brand: { primary_color: '#b45309', tone: 'warm' },
      business_name: 'Acme Bakery',
      languages: ['en', 'fr'],
      pages: [{ slug: 'home', title: 'Home' }],
      site_type: 'landing-page',
    });

    const stored = database.site_settings.find((row) => row.key === CORTEX_AI_SITE_BRIEF_SETTING_KEY)?.value;
    expect(stored).toMatchObject({ business_name: 'Acme Bakery' });

    await expect(executeSaveSiteBrief({ brief: { site_type: 'store' }, mode: 'replace' }, { supabase })).rejects.toThrow();
  });
});

describe('reset_site_content', () => {
  it('is ADMIN only', async () => {
    const { supabase, writes } = createMockSupabase(undefined, 'WRITER');

    await expect(executeResetSiteContent({}, { actorUserId: 'user_1', supabase })).rejects.toThrow(/requires the ADMIN role/);
    expect(writes).toHaveLength(0);
  });

  it('reports a dry run without writing', async () => {
    const { supabase, writes } = createMockSupabase();

    const result = await executeResetSiteContent({ dryRun: true }, { actorUserId: 'user_1', supabase });

    expect(result).toMatchObject({ dryRun: true, mutationExecuted: false, success: true });
    expect((result as any).summary).toMatchObject({
      blocksClearedOnPages: 2,
      identityCleared: true,
      logos: 1,
      media: 1,
      navigationItems: 3,
      pages: 3,
      pagesKept: ['home (en)', 'accueil (fr)'],
      posts: 2,
    });
    expect(writes).toHaveLength(0);
  });

  it('keeps the home group, empties it, and removes everything else after confirmation', async () => {
    const { database, supabase } = createMockSupabase();
    const input = { keepLanguages: ['en'] };

    const preview = expectConfirmation(await executeResetSiteContent(input, { actorUserId: 'user_1', supabase }));
    expect(preview.preview.irreversible).toBe(true);
    expect(preview.preview.summary).toMatch(/backup-restore/);
    expect(database.pages).toHaveLength(5);

    const result = await executeResetSiteContent(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    // Only the default-language home survives; the FR home goes with its language.
    expect(database.pages.map((page) => page.slug)).toEqual(['home']);
    expect(database.blocks.filter((block) => block.page_id === 1)).toHaveLength(0);
    expect(database.posts).toHaveLength(0);
    expect(database.navigation_items).toHaveLength(0);
    expect(database.content_drafts).toHaveLength(0);
    expect(database.media.map((row) => row.object_key)).toEqual(['uploads/team.jpg']);
    expect(database.logos).toHaveLength(0);
    expect(database.site_settings.find((row) => row.key === 'site_title')?.value).toBe('');
    expect(database.site_settings.find((row) => row.key === 'footer_copyright')?.value).toEqual({ en: '© {year}' });
    expect(database.site_settings.find((row) => row.key === 'active_logo_id')?.value).toBeNull();
    expect(database.languages.find((row) => row.code === 'fr')).toMatchObject({ is_active: false, is_default: false });
    expect(database.languages.find((row) => row.code === 'en')).toMatchObject({ is_active: true, is_default: true });
    expect((result as any).nextSteps.join(' ')).toMatch(/home page was kept but is now empty/);
  });

  it('removes only seeded rows when onlySeeded is set, and leaves the demo images alone when out of scope', async () => {
    const { database, supabase } = createMockSupabase();
    const input = { onlySeeded: true, scope: { identity: false, navigation: false, seededMedia: false } };

    const preview = expectConfirmation(await executeResetSiteContent(input, { actorUserId: 'user_1', supabase }));
    await executeResetSiteContent(input, { actorUserId: 'user_1', latestUserMessage: preview.confirmationPhrase, supabase });

    expect(database.pages.map((page) => page.slug).sort()).toEqual(['about-us', 'accueil', 'home']);
    expect(database.posts.map((post) => post.slug)).toEqual(['our-story']);
    // Navigation was out of scope, but links to deleted pages never dangle.
    expect(database.navigation_items.map((item) => item.label)).toEqual(['Home', 'Accueil']);
    expect(database.media).toHaveLength(2);
    expect(database.logos).toHaveLength(1);
    expect(database.site_settings.find((row) => row.key === 'site_title')?.value).toBe('NextBlock™ CMS');
  });
});

describe('start_site_build / finish_site_build', () => {
  it('approves a plan with one confirmation: saves the brief, runs the reset, opens a session', async () => {
    const { database, supabase } = createMockSupabase();
    const input = {
      brief: { business_name: 'Acme Bakery', languages: ['en'], site_type: 'landing-page' as const },
      reset: { keepLanguages: ['en'] },
      summary: 'Remove the demo content, then build a one-page English landing site for Acme Bakery with a hero, menu, story, and contact form.',
    };

    const preview = expectConfirmation(await executeStartSiteBuild(input, { actorUserId: 'user_1', supabase }));
    // Four pages: every non-home page plus the FR home, since only English is kept.
    expect(preview.preview.reset).toMatchObject({ pages: 4, posts: 2 });
    expect(preview.preview.summary).toMatch(/without asking again/);
    expect(database.pages).toHaveLength(5);
    expect(await resolveCortexBuildSession(supabase, 'user_1')).toBeNull();

    const result = await executeStartSiteBuild(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect((result as any).buildSession.id).toEqual(expect.any(String));
    expect((result as any).continuePrompt).toMatch(/finish_site_build/);
    expect((result as any).brief).toMatchObject({ business_name: 'Acme Bakery', status: 'confirmed' });
    expect((result as any).resetResult).toMatchObject({ mutationExecuted: true });
    expect(database.pages.map((page) => page.slug)).toEqual(['home']);

    const session = await resolveCortexBuildSession(supabase, 'user_1');
    expect(session).toMatchObject({ actorUserId: 'user_1', id: (result as any).buildSession.id });
    // Another admin, or an expired clock, gets nothing.
    expect(await resolveCortexBuildSession(supabase, 'user_2')).toBeNull();

    const finished = await executeFinishSiteBuild({ summary: 'Landing page published.' }, { actorUserId: 'user_1', supabase });

    expect(finished).toMatchObject({ buildSessionEnded: true, hadSession: true, outcome: 'built', success: true });
    expect((finished as any).brief).toMatchObject({ status: 'built' });
    expect(database.site_settings.find((row) => row.key === CORTEX_AI_BUILD_SESSION_SETTING_KEY)).toBeUndefined();
    expect(await resolveCortexBuildSession(supabase, 'user_1')).toBeNull();
  });

  it('refuses a stand-in actor from an orphaned token', async () => {
    const { supabase } = createMockSupabase();

    await expect(
      executeStartSiteBuild(
        { summary: 'Build the whole site from the brief we agreed on together.' },
        { actorFromOrphanedToken: true, actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/no longer exists/);
  });
});
