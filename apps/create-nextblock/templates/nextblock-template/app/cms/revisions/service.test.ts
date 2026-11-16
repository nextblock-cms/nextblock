import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An in-memory stand-in for the PostgREST query builder, covering exactly the surface
 * service.ts uses: chained filters, ordering, single/maybeSingle, head counts, and
 * insert/update/delete. Rows live in plain arrays so a test can assert on what was written.
 */
type Row = Record<string, any>;

/** The UNIQUE(parent_id, version) constraint each revision table carries in the real schema. */
const REVISION_UNIQUE_KEYS: Record<string, string> = {
  page_revisions: 'page_id',
  post_revisions: 'post_id',
  product_revisions: 'product_id',
};

class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every update payload in call order, so a test can tell which write carried a column. */
  updates: Array<{ table: string; payload: Row }> = [];
  /**
   * Simulates a concurrent writer: the next insert into this table raises 23505, and
   * onCollision runs first so the test can apply whatever the winner already committed.
   */
  failNextInsertOn: string | null = null;
  onCollision: (() => void) | null = null;
  nextId = 1000;

  constructor(seed: Record<string, Row[]>) {
    this.tables = JSON.parse(JSON.stringify(seed));
  }

  from(table: string) {
    if (!this.tables[table]) this.tables[table] = [];
    return new FakeQuery(this, table);
  }

  /** Enforces the real unique constraint so version-collision handling is actually exercised. */
  violatesUnique(table: string, row: Row): boolean {
    const parentColumn = REVISION_UNIQUE_KEYS[table];
    if (!parentColumn) return false;
    return this.tables[table].some(
      existing =>
        String(existing[parentColumn]) === String(row[parentColumn]) &&
        existing['version'] === row['version']
    );
  }
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: any = null;
  private orderings: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private headCount = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') {
      this.headCount = Boolean(options?.head);
    }
    return this;
  }

  insert(payload: Row | Row[]) {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row) {
    this.mode = 'update';
    this.payload = payload;
    this.db.updates.push({ table: this.table, payload });
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push(row => String(row[column]) === String(value));
    return this;
  }
  lte(column: string, value: any) {
    this.filters.push(row => row[column] <= value);
    return this;
  }
  gt(column: string, value: any) {
    this.filters.push(row => row[column] > value);
    return this;
  }
  gte(column: string, value: any) {
    this.filters.push(row => row[column] >= value);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderings.push({ ascending: options?.ascending !== false, column });
    return this;
  }
  limit(n: number) {
    this.limitCount = n;
    return this;
  }

  private matching(): Row[] {
    let rows = this.db.tables[this.table].filter(row => this.filters.every(f => f(row)));
    for (const { ascending, column } of [...this.orderings].reverse()) {
      rows = [...rows].sort((a, b) => {
        if (a[column] === b[column]) return 0;
        const cmp = a[column] < b[column] ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  private run() {
    if (this.mode === 'insert') {
      if (this.db.failNextInsertOn === this.table) {
        this.db.failNextInsertOn = null;
        this.db.onCollision?.();
        this.db.onCollision = null;
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of rows) {
        if (this.db.violatesUnique(this.table, row)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        this.db.tables[this.table].push({ id: this.db.nextId++, ...row });
      }
      return { data: rows, error: null };
    }

    if (this.mode === 'update') {
      for (const row of this.matching()) Object.assign(row, this.payload);
      return { data: null, error: null };
    }

    if (this.mode === 'delete') {
      const doomed = new Set(this.matching());
      this.db.tables[this.table] = this.db.tables[this.table].filter(r => !doomed.has(r));
      return { data: null, error: null };
    }

    const rows = this.matching();
    if (this.headCount) return { count: rows.length, data: null, error: null };
    return { data: rows, error: null };
  }

  single() {
    const result = this.run();
    const rows = (result as any).data as Row[] | null;
    if (!rows || rows.length === 0) {
      return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    }
    return Promise.resolve({ data: rows[0], error: null });
  }

  maybeSingle() {
    const result = this.run();
    const rows = (result as any).data as Row[] | null;
    return Promise.resolve({ data: rows && rows.length > 0 ? rows[0] : null, error: null });
  }

  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

let db: FakeDb;

vi.mock("@nextblock-cms/db/server", () => ({
  createClient: () => db as any,
}));
vi.mock("server-only", () => ({}));

import {
  createPageRevision,
  createProductRevision,
  reconstructPageVersionContent,
  restorePageToVersion,
  restorePostToVersion,
  restoreProductToVersion,
} from "./service";

const seededMeta = {
  custom_canonical: null,
  feature_image_id: null,
  language_id: 1,
  meta_description: null,
  meta_title: null,
  published_at: null,
  slug: "home",
  status: "published",
  title: "Home",
};

const seededBlocks = [
  { block_type: "text", content: { html_content: "<p>Seeded</p>" }, language_id: 1, order: 0 },
  { block_type: "heading", content: { level: 2, text: "Welcome" }, language_id: 1, order: 1 },
];

const seededContent = { blocks: seededBlocks, meta: seededMeta };

function pageDb(overrides?: Partial<Record<string, Row[]>>) {
  return new FakeDb({
    blocks: [
      { id: 1, language_id: 1, order: 0, page_id: 1, post_id: null, product_id: null, block_type: "text", content: { html_content: "<p>Seeded</p>" } },
      { id: 2, language_id: 1, order: 1, page_id: 1, post_id: null, product_id: null, block_type: "heading", content: { level: 2, text: "Welcome" } },
    ],
    content_drafts: [],
    page_revisions: [],
    pages: [{ id: 1, version: 1, ...seededMeta }],
    ...overrides,
  });
}

describe("createPageRevision", () => {
  beforeEach(() => {
    db = pageDb();
  });

  it("writes a baseline snapshot of the previous state the first time a page is revised", async () => {
    const next = { ...seededContent, meta: { ...seededMeta, title: "Home v2" } };

    const result = await createPageRevision(1, "user-1", seededContent as any, next as any);

    expect(result).toMatchObject({ recorded: true, success: true, version: 2 });

    const baseline = db.tables['page_revisions'].find(r => r.version === 1);
    expect(baseline).toMatchObject({ revision_type: "snapshot" });
    expect(baseline!.content).toEqual(seededContent);

    const change = db.tables['page_revisions'].find(r => r.version === 2);
    expect(change).toMatchObject({ revision_type: "diff" });
    expect(change!.content).toEqual([{ op: "replace", path: "/meta/title", value: "Home v2" }]);

    expect(db.tables['pages'][0]!.version).toBe(2);
  });

  it("records nothing and burns no version when the content is unchanged", async () => {
    const result = await createPageRevision(1, "user-1", seededContent as any, seededContent as any);

    expect(result).toMatchObject({ recorded: false, success: true, version: 1 });
    expect(db.tables['page_revisions']).toHaveLength(0);
    expect(db.tables['pages'][0]!.version).toBe(1);
  });

  it("stays reconstructible when the version numbering has a gap", async () => {
    // A snapshot at v1 while the page already claims v4, with nothing in between. What
    // matters is not the numbering but that replaying the chain still yields the live
    // content — so a diff is legitimate here, and must round-trip.
    db = pageDb({
      page_revisions: [
        { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
      ],
      pages: [{ id: 1, version: 4, ...seededMeta }],
    });

    const next = { ...seededContent, meta: { ...seededMeta, title: "Repaired" } };
    const result = await createPageRevision(1, "user-1", seededContent as any, next as any);

    expect(result).toMatchObject({ success: true, version: 5 });
    const roundTrip = await reconstructPageVersionContent(1, 5);
    expect((roundTrip as any).content).toEqual(next);
  });

  it("takes the next free version when it loses the race, storing the full document", async () => {
    db = pageDb({
      page_revisions: [
        { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
      ],
      pages: [{ id: 1, version: 3, ...seededMeta }],
    });
    // A concurrent writer wins version 4 and bumps the page while our insert is in flight.
    db.failNextInsertOn = 'page_revisions';
    db.onCollision = () => {
      db.tables['page_revisions'].push({
        author_id: "other-user", content: seededContent, id: 99,
        page_id: 1, revision_type: "snapshot", version: 4,
      });
      db.tables['pages'][0]!.version = 4;
    };

    const next = { ...seededContent, meta: { ...seededMeta, title: "Racy" } };
    const result = await createPageRevision(1, "user-1", seededContent as any, next as any);

    expect(result).toMatchObject({ success: true, version: 5 });
    // Our diff was computed against a base the winner has moved past, so the retry stores
    // the whole document rather than ops that would replay onto the wrong base.
    expect(db.tables['page_revisions'].find(r => r.version === 5)).toMatchObject({
      revision_type: "snapshot",
    });
    expect(db.tables['page_revisions'].find(r => r.version === 4)!.author_id).toBe("other-user");
  });

  it("stores a snapshot when the chain no longer replays to the live content", async () => {
    // A contiguous chain whose diff does NOT reproduce previousContent — the shape left by
    // a live write that bypassed the revision engine without consuming a version number.
    db = pageDb({
      page_revisions: [
        { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
        { id: 2, page_id: 1, version: 2, revision_type: "diff", author_id: null, content: [{ op: "replace", path: "/meta/slug", value: "stale" }] },
      ],
      pages: [{ id: 1, version: 2, ...seededMeta }],
    });

    const drifted = { ...seededContent, meta: { ...seededMeta, title: "Drifted live" } };
    const next = { ...seededContent, meta: { ...seededMeta, title: "Drifted live", subtitle: undefined, slug: "home-2" } };

    const result = await createPageRevision(1, "user-1", drifted as any, next as any);

    expect(result).toMatchObject({ success: true, version: 3 });
    const written = db.tables['page_revisions'].find(r => r.version === 3);
    expect(written).toMatchObject({ revision_type: "snapshot" });
    expect(written!.content).toEqual(next);
  });
});

describe("restorePageToVersion", () => {
  beforeEach(() => {
    db = pageDb();
  });

  it("restores the seeded blocks and metadata from the version 1 baseline", async () => {
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
    ];
    db.tables['pages'][0] = { id: 1, version: 2, ...seededMeta, title: "Rewritten by someone" };
    db.tables['blocks'] = [
      { id: 9, language_id: 1, order: 0, page_id: 1, post_id: null, product_id: null, block_type: "text", content: { html_content: "<p>Replaced</p>" } },
    ];

    const result = await restorePageToVersion(1, 1, "user-1");

    expect(result).toMatchObject({ success: true, version: 3 });
    expect(db.tables['pages'][0]!.title).toBe("Home");
    expect(db.tables['blocks'].map(b => b.block_type)).toEqual(["text", "heading"]);
    expect(db.tables['blocks'][0]!.content).toEqual({ html_content: "<p>Seeded</p>" });
  });

  it("refuses to restore rather than emptying the page when no snapshot exists", async () => {
    db.tables['page_revisions'] = [];
    db.tables['pages'][0]!.version = 5;

    const result = await restorePageToVersion(1, 1, "user-1");

    expect(result).toMatchObject({ error: expect.stringContaining("No stored snapshot") });
    // The regression this guards: the old fallback fabricated "current meta + zero blocks"
    // and deleted every block while reporting success.
    expect(db.tables['blocks']).toHaveLength(2);
  });

  it("never replays visibility, so restoring old wording cannot unpublish a live page", async () => {
    db.tables['page_revisions'] = [
      {
        id: 1, page_id: 1, version: 1, revision_type: "snapshot", author_id: null,
        content: { blocks: seededBlocks, meta: { ...seededMeta, published_at: "2020-01-01T00:00:00.000Z", status: "draft" } },
      },
    ];
    db.tables['pages'][0] = { id: 1, version: 2, ...seededMeta, status: "published", published_at: null };

    await restorePageToVersion(1, 1, "user-1");

    expect(db.tables['pages'][0]!.status).toBe("published");
    expect(db.tables['pages'][0]!.published_at).toBeNull();
  });

  it("clears the pending draft so the restore is not overlaid or replayed away", async () => {
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
    ];
    db.tables['content_drafts'] = [
      { id: 7, parent_type: "page", parent_id: 1, blocks: [], meta: { title: "Stale draft" } },
      { id: 8, parent_type: "post", parent_id: 1, blocks: [], meta: { title: "Unrelated" } },
    ];

    await restorePageToVersion(1, 1, "user-1");

    expect(db.tables['content_drafts'].map(d => d.id)).toEqual([8]);
  });

  it("takes the next free version when a revision already occupies the one after current", async () => {
    // Left behind by a publish whose version bump failed after the revision was written.
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
      { id: 2, page_id: 1, version: 2, revision_type: "snapshot", content: seededContent, author_id: "someone-else" },
    ];
    db.tables['pages'][0]!.version = 1;

    const result = await restorePageToVersion(1, 1, "user-1");

    expect(result).toMatchObject({ success: true });
    // Must not claim v2 — that row belongs to another writer's document.
    expect((result as any).version).toBeGreaterThan(2);
    expect(db.tables['pages'][0]!.version).toBe((result as any).version);
    expect(db.tables['page_revisions'].find(r => r.version === 2)!.author_id).toBe("someone-else");
  });

  it("records the restored state as a new snapshot so history stays append-only", async () => {
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
    ];
    db.tables['pages'][0]!.version = 4;

    await restorePageToVersion(1, 1, "user-2");

    const created = db.tables['page_revisions'].find(r => r.version === 5);
    expect(created).toMatchObject({ author_id: "user-2", revision_type: "snapshot" });
    expect(created!.content).toEqual(seededContent);
    expect(db.tables['page_revisions'].some(r => r.version === 1)).toBe(true);
  });
});

describe("reconstructPageVersionContent", () => {
  beforeEach(() => {
    db = pageDb();
  });

  it("replays diffs onto the nearest snapshot", async () => {
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
      { id: 2, page_id: 1, version: 2, revision_type: "diff", author_id: null, content: [{ op: "replace", path: "/meta/title", value: "Second" }] },
      { id: 3, page_id: 1, version: 3, revision_type: "diff", author_id: null, content: [{ op: "replace", path: "/meta/slug", value: "third" }] },
    ];

    const atTwo = await reconstructPageVersionContent(1, 2);
    expect(atTwo).toMatchObject({ success: true });
    expect((atTwo as any).content.meta.title).toBe("Second");
    expect((atTwo as any).content.meta.slug).toBe("home");

    const atThree = await reconstructPageVersionContent(1, 3);
    expect((atThree as any).content.meta.slug).toBe("third");
  });

  it("reports corruption instead of throwing when a diff payload is not a patch array", async () => {
    db.tables['page_revisions'] = [
      { id: 1, page_id: 1, version: 1, revision_type: "snapshot", content: seededContent, author_id: null },
      { id: 2, page_id: 1, version: 2, revision_type: "diff", content: { nonsense: true }, author_id: null },
    ];

    const result = await reconstructPageVersionContent(1, 2);
    expect(result).toMatchObject({ error: expect.stringContaining("corrupted at version 2") });
  });
});

describe("products", () => {
  const productId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const productMeta = {
    custom_canonical: null,
    description_json: null,
    language_id: 1,
    meta_description: null,
    meta_title: null,
    published_at: null,
    short_description: "A widget",
    slug: "widget",
    status: "active",
    title: "Widget",
  };
  const productContent = { blocks: [], meta: productMeta };

  beforeEach(() => {
    db = new FakeDb({
      blocks: [],
      product_drafts: [],
      product_revisions: [],
      products: [{ id: productId, version: 1, ...productMeta }],
    });
  });

  it("revisions a uuid-keyed product like any other content type", async () => {
    const next = { blocks: [], meta: { ...productMeta, short_description: "A better widget" } };

    const result = await createProductRevision(productId, "user-1", productContent as any, next as any);

    expect(result).toMatchObject({ recorded: true, success: true, version: 2 });
    expect(db.tables['product_revisions'].find(r => r.version === 1)!.content).toEqual(productContent);
    expect(db.tables['products'][0]!.version).toBe(2);
  });

  it("clears the product draft on restore", async () => {
    db.tables['product_revisions'] = [
      { id: 1, product_id: productId, version: 1, revision_type: "snapshot", content: productContent, author_id: null },
    ];
    db.tables['products'][0] = { id: productId, version: 2, ...productMeta, title: "Renamed" };
    db.tables['product_drafts'] = [{ id: 3, product_id: productId, blocks: [], meta: {} }];

    const result = await restoreProductToVersion(productId, 1, "user-1");

    expect(result).toMatchObject({ success: true });
    expect(db.tables['products'][0]!.title).toBe("Widget");
    expect(db.tables['product_drafts']).toHaveLength(0);
  });
});

describe("restore sets updated_at in the write that restores the meta", () => {
  const stale = "2026-01-01T00:00:00.000Z";
  const productId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const productMeta = {
    custom_canonical: null,
    description_json: null,
    language_id: 1,
    meta_description: null,
    meta_title: null,
    published_at: null,
    short_description: "A widget",
    slug: "widget",
    status: "active",
    title: "Widget",
  };
  // Own literals: "replays diffs onto the nearest snapshot" stores the shared seededContent
  // object itself, and reconstructing patches it in place (seededMeta.title becomes "Second").
  const pageMeta = {
    custom_canonical: null,
    feature_image_id: null,
    language_id: 1,
    meta_description: null,
    meta_title: null,
    published_at: null,
    slug: "about",
    status: "published",
    title: "About",
  };
  const postMeta = { ...pageMeta, excerpt: null, label: null, slug: "news", subtitle: null, title: "News" };

  // products.updated_at has no trigger behind it, and the visual editor publishes a pre-0.23.4
  // product draft's copy of the title and descriptions only while products.updated_at is not
  // later than the draft's created_at. A restore that left it alone rewrote those fields while
  // the row still looked unchanged, so a draft that survived (nothing checks the draft delete)
  // could publish its copy straight back over the restore. Pages and posts also get it from
  // their trigger; the write sets it for all three alike.
  const cases = [
    {
      label: "product",
      restore: () => restoreProductToVersion(productId, 1, "user-1"),
      seed: () =>
        new FakeDb({
          blocks: [],
          product_drafts: [],
          product_revisions: [
            {
              author_id: null, content: { blocks: [], meta: productMeta }, id: 1,
              product_id: productId, revision_type: "snapshot", version: 1,
            },
          ],
          products: [{ id: productId, version: 2, ...productMeta, title: "Renamed", updated_at: stale }],
        }),
      table: "products",
      title: "Widget",
    },
    {
      label: "page",
      restore: () => restorePageToVersion(1, 1, "user-1"),
      seed: () =>
        new FakeDb({
          blocks: [],
          content_drafts: [],
          page_revisions: [
            {
              author_id: null, content: { blocks: [], meta: pageMeta }, id: 1,
              page_id: 1, revision_type: "snapshot", version: 1,
            },
          ],
          pages: [{ id: 1, version: 2, ...pageMeta, title: "Rewritten", updated_at: stale }],
        }),
      table: "pages",
      title: "About",
    },
    {
      label: "post",
      restore: () => restorePostToVersion(5, 1, "user-1"),
      seed: () =>
        new FakeDb({
          blocks: [],
          content_drafts: [],
          post_revisions: [
            {
              author_id: null, content: { blocks: [], meta: postMeta }, id: 1,
              post_id: 5, revision_type: "snapshot", version: 1,
            },
          ],
          posts: [{ id: 5, version: 2, ...postMeta, title: "Edited", updated_at: stale }],
        }),
      table: "posts",
      title: "News",
    },
  ];

  it.each(cases)("$label", async ({ restore, seed, table, title }) => {
    db = seed();
    const startedAt = Date.now();

    const result = await restore();

    expect(result).toMatchObject({ success: true });
    const metaWrite = db.updates.find(write => write.table === table && write.payload['title'] === title);
    expect(metaWrite, `the ${table} update that restores the title`).toBeDefined();
    const stamp = metaWrite?.payload['updated_at'];
    expect(stamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(startedAt);
    expect(db.tables[table]?.[0]?.updated_at).toBe(stamp);
  });
});
