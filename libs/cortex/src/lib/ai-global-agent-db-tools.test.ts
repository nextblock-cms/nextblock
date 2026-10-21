import { describe, expect, it } from 'vitest';
import {
  executeDatabaseActionPlan,
  executeDatabaseMutation,
  executeDescribeDatabaseSchema,
  executeReadDatabaseRecords,
} from './ai-global-agent-db-tools';

// The mutation helpers return an inferred union (confirmation preview | executed
// result | failure). These tests deliberately drive the confirmation-preview
// branch, so narrow to the preview shape for the confirmation-only fields; the
// runtime expect() assertions still validate the actual values.
function asDbConfirmation(result: unknown) {
  return result as {
    confirmationPhrase: string;
    message: string;
    requiresConfirmation: boolean;
  };
}

type MockRow = Record<string, any>;
type MockDatabase = Record<string, MockRow[]>;

class MockQuery {
  private filters: Array<{ column: string; operator: string; value: any }> = [];
  private limitCount: number | null = null;
  private operation: 'delete' | 'insert' | 'select' | 'update' | 'upsert' = 'select';
  private orderBy: { ascending: boolean; column: string } | null = null;
  private payload: MockRow | MockRow[] | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private selectedColumns: string[] | null = null;

  constructor(
    private readonly database: MockDatabase,
    private readonly table: string
  ) {}

  select(columns?: string) {
    if (columns) {
      this.selectedColumns = columns.split(',').map((column) => column.trim());
    }
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

  gt(column: string, value: unknown) {
    this.filters.push({ column, operator: 'gt', value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, operator: 'gte', value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ column, operator: 'lt', value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ column, operator: 'lte', value });
    return this;
  }

  ilike(column: string, value: unknown) {
    this.filters.push({ column, operator: 'ilike', value });
    return this;
  }

  in(column: string, value: unknown) {
    this.filters.push({ column, operator: 'in', value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, operator: 'is', value });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number) {
    this.rangeBounds = { from, to };
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { ascending: options?.ascending ?? true, column };
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  insert(payload: MockRow | MockRow[]) {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: MockRow) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  upsert(payload: MockRow | MockRow[]) {
    this.operation = 'upsert';
    this.payload = payload;
    return this;
  }

  async maybeSingle() {
    const { data, error } = await this.execute();
    return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matchesFilters(row: MockRow) {
    return this.filters.every((filter) => {
      const value = row[filter.column];

      switch (filter.operator) {
        case 'eq':
          return value === filter.value;
        case 'neq':
          return value !== filter.value;
        case 'gt':
          return value > filter.value;
        case 'gte':
          return value >= filter.value;
        case 'lt':
          return value < filter.value;
        case 'lte':
          return value <= filter.value;
        case 'ilike': {
          const pattern = String(filter.value).replace(/%/g, '').toLowerCase();
          return String(value).toLowerCase().includes(pattern);
        }
        case 'in':
          return Array.isArray(filter.value) && filter.value.includes(value);
        case 'is':
          return value === filter.value;
        default:
          return true;
      }
    });
  }

  private project(row: MockRow) {
    if (!this.selectedColumns) {
      return row;
    }

    return Object.fromEntries(this.selectedColumns.map((column) => [column, row[column]]));
  }

  private async execute() {
    if (!(this.table in this.database)) {
      throw new Error(`Unexpected mock table: ${this.table}`);
    }

    if (this.operation === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as MockRow[];
      const inserted = rows.map((row) => ({ ...row }));
      this.database[this.table].push(...inserted);
      return { data: inserted.map((row) => this.project(row)), error: null };
    }

    if (this.operation === 'upsert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as MockRow[];

      for (const row of rows) {
        const keyColumn = 'id' in row ? 'id' : 'key' in row ? 'key' : Object.keys(row)[0];
        const existingIndex = this.database[this.table].findIndex((current) => current[keyColumn] === row[keyColumn]);

        if (existingIndex >= 0) {
          this.database[this.table][existingIndex] = { ...this.database[this.table][existingIndex], ...row };
        } else {
          this.database[this.table].push({ ...row });
        }
      }

      return { data: rows.map((row) => this.project(row)), error: null };
    }

    if (this.operation === 'update') {
      const payload = (Array.isArray(this.payload) ? this.payload[0] : this.payload) || {};
      const updated: MockRow[] = [];

      this.database[this.table] = this.database[this.table].map((row) => {
        if (!this.matchesFilters(row)) {
          return row;
        }

        const nextRow = { ...row, ...payload };
        updated.push(nextRow);
        return nextRow;
      });

      return { data: updated.map((row) => this.project(row)), error: null };
    }

    if (this.operation === 'delete') {
      const removed = this.database[this.table].filter((row) => this.matchesFilters(row));
      this.database[this.table] = this.database[this.table].filter((row) => !this.matchesFilters(row));
      return { data: removed.map((row) => this.project(row)), error: null };
    }

    let rows = this.database[this.table].filter((row) => this.matchesFilters(row));

    if (this.orderBy) {
      const { ascending, column } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        if (a[column] === b[column]) return 0;
        return (a[column] > b[column] ? 1 : -1) * (ascending ? 1 : -1);
      });
    }

    if (this.rangeBounds) {
      rows = rows.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    }

    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }

    return { data: rows.map((row) => this.project(row)), error: null };
  }
}

function createMockSupabase(overrides?: Partial<MockDatabase>) {
  const database: MockDatabase = {
    cortex_ai_db_mutation_audit: [],
    pages: [
      { id: 1, language_id: 1, slug: 'home', status: 'draft', title: 'Home' },
      { id: 2, language_id: 1, slug: 'about', status: 'draft', title: 'About' },
    ],
    profiles: [{ id: 'user_1', full_name: 'Admin', role: 'ADMIN' }],
    site_settings: [
      { key: 'site_name', value: { en: 'NextBlock' } },
      { key: 'cortex_ai_openrouter_api_key', value: 'sk-secret' },
    ],
    translations: [{ key: 'hello', translations: { en: 'Hello' } }],
    user_addresses: [{ id: 'addr_1', user_id: 'user_1', city: 'Montreal' }],
    ...overrides,
  };

  return {
    database,
    supabase: {
      from: (table: string) => new MockQuery(database, table),
    },
  };
}

describe('Cortex AI generic database tools', () => {
  it('describes allowed schema and marks PII tables read-only', async () => {
    const result = await executeDescribeDatabaseSchema({});

    expect(result.success).toBe(true);
    expect(result.tables.some((table) => table.table === 'profiles' && table.readOnly)).toBe(true);
    expect(result.tables.some((table) => table.table === 'user_addresses' && table.readOnly)).toBe(true);
    expect(result.tables.some((table) => (table.table as string) === 'auth.users')).toBe(false);
  });

  it('reads profiles and user addresses but refuses to mutate them', async () => {
    const { supabase } = createMockSupabase();

    const profiles = await executeReadDatabaseRecords(
      { table: 'profiles', columns: ['id', 'full_name', 'role'] },
      { supabase }
    );
    const addresses = await executeReadDatabaseRecords(
      { table: 'user_addresses', columns: ['id', 'city'] },
      { supabase }
    );

    expect(profiles.rows).toEqual([{ id: 'user_1', full_name: 'Admin', role: 'ADMIN' }]);
    expect(addresses.rows).toEqual([{ id: 'addr_1', city: 'Montreal' }]);
    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'id', operator: 'eq', value: 'user_1' }],
          operation: 'update',
          table: 'profiles',
          values: { full_name: 'Changed' },
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow('read-only');
  });

  it('blocks auth tables, secret-like fields, and protected Cortex site setting reads', async () => {
    const { supabase } = createMockSupabase();

    await expect(executeReadDatabaseRecords({ table: 'auth.users' }, { supabase })).rejects.toThrow(
      'auth schema'
    );
    await expect(
      executeDatabaseMutation(
        {
          operation: 'insert',
          rows: [{ key: 'demo', api_key: 'secret' }],
          table: 'site_settings',
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow('Protected field');

    const settings = await executeReadDatabaseRecords({ table: 'site_settings' }, { supabase });

    expect(settings.rows).toEqual([{ key: 'site_name', value: { en: 'NextBlock' } }]);
  });

  it('redacts every protected site_settings key, not just the OpenRouter one', async () => {
    const { supabase } = createMockSupabase({
      site_settings: [
        { key: 'site_name', value: { en: 'NextBlock' } },
        { key: 'cortex_ai_pexels_api_key', value: { ciphertext: 'abc', iv: 'def' } },
        { key: 'cortex_ai_unsplash_access_key', value: { ciphertext: 'ghi', iv: 'jkl' } },
        { key: 'payment_secret', value: 'sk_live_should_never_appear' },
      ],
    });

    const settings = await executeReadDatabaseRecords({ table: 'site_settings' }, { supabase });
    const serialized = JSON.stringify(settings.rows);

    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('sk_live_should_never_appear');
    expect(settings.rows).toEqual([
      { key: 'site_name', value: { en: 'NextBlock' } },
      { key: 'cortex_ai_pexels_api_key', value: '[REDACTED]' },
      { key: 'cortex_ai_unsplash_access_key', value: '[REDACTED]' },
      { key: 'payment_secret', value: '[REDACTED]' },
    ]);
  });

  it('redacts protected site_settings rows even when the key column is not selected', async () => {
    const envelope = {
      algorithm: 'aes-256-gcm',
      authTag: 'CB0cnt8bv6+2NgG0CKmKLw==',
      ciphertext: '7zeCzkxZshi26TAZDE50aX0ZrLUtPvM1h62zXD8=',
      iv: 'wdRLiafQbg+ndsBJ',
      last4: 'EAK9',
      updatedAt: '2026-10-19T18:13:39.171Z',
      version: 1,
    };
    const { supabase } = createMockSupabase({
      site_settings: [
        { key: 'site_name', value: { en: 'NextBlock' } },
        // SMTP credentials: no sub-key name trips isSensitiveKey, so only the row key protects them.
        { key: 'email_secret', value: { pass: envelope, user: envelope } },
        // A bare envelope stored directly as the value.
        { key: 'cortex_ai_pexels_api_key', value: envelope },
      ],
    });

    const filtered = await executeReadDatabaseRecords(
      {
        columns: ['value'],
        filters: [{ column: 'key', operator: 'eq', value: 'email_secret' }],
        table: 'site_settings',
      },
      { supabase }
    );

    expect(filtered.columns).toEqual(['value']);
    expect(filtered.rows).toEqual([{ value: '[REDACTED]' }]);

    const unfiltered = await executeReadDatabaseRecords({ columns: ['value'], table: 'site_settings' }, { supabase });

    expect(unfiltered.rows).toEqual([{ value: { en: 'NextBlock' } }, { value: '[REDACTED]' }, { value: '[REDACTED]' }]);
    expect(JSON.stringify(unfiltered.rows)).not.toMatch(/ciphertext|authTag|last4|EAK9/);

    const keysOnly = await executeReadDatabaseRecords({ columns: ['key'], table: 'site_settings' }, { supabase });

    expect(keysOnly.rows).toEqual([{ key: 'site_name' }, { key: 'email_secret' }, { key: 'cortex_ai_pexels_api_key' }]);
  });

  it('protects credential-shaped and MCP-control site_settings keys that are not listed by name', async () => {
    const { supabase } = createMockSupabase({
      site_settings: [
        { key: 'cortex_ai_mcp_settings', value: { enabled: true, trustLocalhost: true } },
        { key: 'smtp_relay_api_key', value: 'rk_live_123' },
        { key: 'webhook_signing_secret', value: { ciphertext: 'b', iv: 'a' } },
        { key: 'design_tokens', value: { primary: '#000' } },
      ],
      translations: [{ key: 'payment_secret', translations: { en: 'Payment secret' } }],
    });

    const settings = await executeReadDatabaseRecords({ columns: ['value'], table: 'site_settings' }, { supabase });

    expect(settings.rows).toEqual([
      { value: '[REDACTED]' },
      { value: '[REDACTED]' },
      { value: '[REDACTED]' },
      { value: { primary: '#000' } },
    ]);

    // Key-based protection is a site_settings rule; a translation string that happens
    // to share a protected name is ordinary content.
    const translations = await executeReadDatabaseRecords({ table: 'translations' }, { supabase });

    expect(translations.rows).toEqual([{ key: 'payment_secret', translations: { en: 'Payment secret' } }]);
  });

  it('refuses to write any protected site_settings key', async () => {
    const { supabase } = createMockSupabase();

    for (const key of [
      'cortex_ai_pexels_api_key',
      'cortex_ai_unsplash_access_key',
      'payment_secret',
    ]) {
      await expect(
        executeDatabaseMutation(
          { operation: 'insert', rows: [{ key, value: 'x' }], table: 'site_settings' },
          { actorUserId: 'user_1', supabase }
        )
      ).rejects.toThrow('is protected');
    }
  });

  it('refuses credential-shaped site_settings keys and protected rows reached through broad filters', async () => {
    const { database, supabase } = createMockSupabase({
      site_settings: [
        { key: 'site_name', value: { en: 'NextBlock' } },
        { key: 'email_secret', value: { pass: { ciphertext: 'x' } } },
      ],
    });
    // skipConfirmation: a guard that failed to fire would really mutate the rows below.
    const context = { actorUserId: 'user_1', skipConfirmation: true, supabase };

    await expect(
      executeDatabaseMutation(
        { operation: 'upsert', rows: [{ key: 'smtp_relay_api_key', value: 'rk_live_123' }], table: 'site_settings' },
        context
      )
    ).rejects.toThrow('"smtp_relay_api_key" site setting is protected');

    // Renaming an ordinary row to a protected name is the same write.
    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'key', operator: 'eq', value: 'site_name' }],
          operation: 'update',
          table: 'site_settings',
          values: { key: 'cortex_ai_mcp_token' },
        },
        context
      )
    ).rejects.toThrow('"cortex_ai_mcp_token" site setting is protected');

    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'key', operator: 'in', value: ['site_name', 'webhook_signing_secret'] }],
          operation: 'delete',
          table: 'site_settings',
        },
        context
      )
    ).rejects.toThrow('"webhook_signing_secret" site setting is protected');

    // These filters never name the protected row, but they match it.
    await expect(
      executeDatabaseMutation(
        { filters: [{ column: 'key', operator: 'ilike', value: '%' }], operation: 'delete', table: 'site_settings' },
        context
      )
    ).rejects.toThrow('"email_secret" site setting is protected');

    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'key', operator: 'neq', value: 'site_name' }],
          operation: 'update',
          table: 'site_settings',
          values: { value: {} },
        },
        context
      )
    ).rejects.toThrow('"email_secret" site setting is protected');

    expect(database.site_settings).toEqual([
      { key: 'site_name', value: { en: 'NextBlock' } },
      { key: 'email_secret', value: { pass: { ciphertext: 'x' } } },
    ]);
  });

  // 2026-10-21: the write-protected list was checked only for rows[].key, values.key and the
  // first `eq` filter on key, so a write-scope MCP token could delete `is_admin_created`
  // (the proxy then sends every request to /setup) or rewrite `security_settings` through an
  // `in` or `ilike` filter.
  it('refuses write-protected site_settings rows however the filter or operation reaches them', async () => {
    const original = [
      { key: 'site_name', value: { en: 'NextBlock' } },
      { key: 'is_admin_created', value: true },
      { key: 'security_settings', value: { enforce_2fa: true } },
      { key: 'cortex_ai_build_session', value: { id: 'real' } },
    ];
    const { database, supabase } = createMockSupabase({ site_settings: original.map((row) => ({ ...row })) });
    const context = { actorUserId: 'user_1', skipConfirmation: true, supabase };
    const attempts = [
      { filters: [{ column: 'key', operator: 'eq' as const, value: 'is_admin_created' }], operation: 'delete' as const },
      { filters: [{ column: 'key', operator: 'in' as const, value: ['site_name', 'is_admin_created'] }], operation: 'delete' as const },
      { filters: [{ column: 'key', operator: 'ilike' as const, value: '%admin%' }], operation: 'delete' as const },
      { filters: [{ column: 'key', operator: 'neq' as const, value: 'site_name' }], operation: 'delete' as const },
      {
        filters: [{ column: 'key', operator: 'in' as const, value: ['security_settings'] }],
        operation: 'update' as const,
        values: { value: { enforce_2fa: false } },
      },
      {
        filters: [{ column: 'key', operator: 'ilike' as const, value: '%build_session' }],
        operation: 'update' as const,
        values: { value: { id: 'forged' } },
      },
      // Renaming a write-protected row away is a write to it too.
      {
        filters: [{ column: 'key', operator: 'ilike' as const, value: 'is_admin%' }],
        operation: 'update' as const,
        values: { key: 'renamed' },
      },
    ];

    for (const attempt of attempts) {
      await expect(
        executeDatabaseMutation({ ...attempt, table: 'site_settings' }, context),
        JSON.stringify(attempt)
      ).rejects.toThrow(/cannot be written through Cortex AI database tools/);
    }

    await expect(
      executeDatabaseActionPlan(
        {
          actions: [
            {
              filters: [{ column: 'key', operator: 'in', value: ['is_admin_created'] }],
              operation: 'delete',
              table: 'site_settings',
            },
          ],
        },
        context
      )
    ).rejects.toThrow(/cannot be written through Cortex AI database tools/);

    expect(database.site_settings).toEqual(original);
  });

  it('validates a site_settings value against every row an update reaches, not just an eq filter', async () => {
    const { supabase } = createMockSupabase({
      site_settings: [{ key: 'footer_copyright', value: { en: '© {year} Acme' } }],
    });

    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'key', operator: 'in', value: ['footer_copyright'] }],
          operation: 'update',
          table: 'site_settings',
          values: { value: 'plain string' },
        },
        { actorUserId: 'user_1', skipConfirmation: true, supabase }
      )
    ).rejects.toThrow(/Invalid value for site setting "footer_copyright"/);
  });

  // 2026-10-21: the DB tools never re-checked the actor's role, so a token minted by an
  // admin who was later demoted kept full raw-table write access.
  it('requires an ADMIN actor for database mutations and action plans', async () => {
    const { database, supabase } = createMockSupabase({
      profiles: [
        { id: 'user_1', role: 'ADMIN' },
        { id: 'writer_1', role: 'WRITER' },
      ],
    });
    const input = {
      filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
      operation: 'update' as const,
      table: 'pages',
      values: { status: 'published' },
    };

    await expect(
      executeDatabaseMutation(input, { actorUserId: 'writer_1', skipConfirmation: true, supabase })
    ).rejects.toThrow(/requires the ADMIN role/);
    await expect(
      executeDatabaseActionPlan({ actions: [input] }, { actorUserId: 'writer_1', skipConfirmation: true, supabase })
    ).rejects.toThrow(/requires the ADMIN role/);
    await expect(executeDatabaseMutation(input, { skipConfirmation: true, supabase })).rejects.toThrow(
      /requires a known CMS user/
    );
    await expect(
      executeDatabaseMutation(input, {
        actorFromOrphanedToken: true,
        actorUserId: 'user_1',
        skipConfirmation: true,
        supabase,
      })
    ).rejects.toThrow(/no longer exists/);
    expect(database.pages.find((page) => page.id === 1)?.status).toBe('draft');

    const result = await executeDatabaseMutation(input, { actorUserId: 'user_1', skipConfirmation: true, supabase });
    expect(result).toMatchObject({ mutationExecuted: true, success: true });
  });

  // 2026-10-21: read_database_records returned package_activations.license_key in clear.
  it('never returns, filters on, or writes a license key', async () => {
    const { supabase } = createMockSupabase({
      package_activations: [
        {
          id: 'act_1',
          instance_name: 'prod',
          license_key: 'sk_live_license_abc',
          meta: { nested: { license_key: 'sk_live_license_abc' } },
          package_id: 'cortex-ai',
          status: 'active',
        },
      ],
    });

    const result = await executeReadDatabaseRecords({ table: 'package_activations' }, { supabase });

    expect(JSON.stringify(result.rows)).not.toContain('sk_live_license_abc');
    expect(result.columns).not.toContain('license_key');
    expect(result.rows[0]).toMatchObject({ id: 'act_1', meta: { nested: { license_key: '[REDACTED]' } } });

    await expect(
      executeReadDatabaseRecords({ columns: ['license_key'], table: 'package_activations' }, { supabase })
    ).rejects.toThrow(/protected/);
    await expect(
      executeReadDatabaseRecords(
        { filters: [{ column: 'license_key', operator: 'ilike', value: 'sk_live%' }], table: 'package_activations' },
        { supabase }
      )
    ).rejects.toThrow(/protected/);
    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'id', operator: 'eq', value: 'act_1' }],
          operation: 'update',
          table: 'package_activations',
          values: { license_key: 'stolen' },
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/Protected field/);

    const schema = await executeDescribeDatabaseSchema({ table: 'package_activations' });
    expect(schema.tables[0]?.columns).not.toContain('license_key');
  });

  it('previews and confirms a mutation before changing rows and writing an audit record', async () => {
    const { database, supabase } = createMockSupabase();
    const input = {
      filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
      operation: 'update' as const,
      summary: 'Publish the home page.',
      table: 'pages',
      values: { status: 'published' },
    };

    const preview = asDbConfirmation(
      await executeDatabaseMutation(input, { actorUserId: 'user_1', supabase })
    );

    expect(preview.requiresConfirmation).toBe(true);
    expect(database.pages[0].status).toBe('draft');

    const result = await executeDatabaseMutation(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result.success).toBe(true);
    expect(result.mutationExecuted).toBe(true);
    expect(database.pages[0].status).toBe('published');
    expect(database.cortex_ai_db_mutation_audit).toHaveLength(1);
    expect(database.cortex_ai_db_mutation_audit[0].status).toBe('success');
  });

  it('requires a fresh confirmation when update targets change', async () => {
    const { database, supabase } = createMockSupabase();
    const input = {
      filters: [{ column: 'status', operator: 'eq' as const, value: 'draft' }],
      operation: 'update' as const,
      table: 'pages',
      values: { status: 'published' },
    };
    const preview = asDbConfirmation(
      await executeDatabaseMutation(input, { actorUserId: 'user_1', supabase })
    );

    database.pages.pop();
    const staleResult = asDbConfirmation(
      await executeDatabaseMutation(input, {
        actorUserId: 'user_1',
        latestUserMessage: preview.confirmationPhrase,
        supabase,
      })
    );

    expect(staleResult.requiresConfirmation).toBe(true);
    expect(staleResult.message).toMatch(/target changed/i);
    expect(database.pages[0].status).toBe('draft');
  });

  it('confirms a multi-action database plan and writes one combined audit row', async () => {
    const { database, supabase } = createMockSupabase();
    const input = {
      actions: [
        {
          filters: [{ column: 'id', operator: 'eq' as const, value: 1 }],
          operation: 'update' as const,
          table: 'pages',
          values: { status: 'published' },
        },
        {
          operation: 'insert' as const,
          rows: [{ key: 'goodbye', translations: { en: 'Goodbye' } }],
          table: 'translations',
        },
      ],
      summary: 'Publish home and add a translation.',
    };

    const preview = asDbConfirmation(
      await executeDatabaseActionPlan(input, { actorUserId: 'user_1', supabase })
    );
    expect(preview.requiresConfirmation).toBe(true);

    const result = await executeDatabaseActionPlan(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result.success).toBe(true);
    expect(result.mutationExecuted).toBe(true);
    expect(database.pages[0].status).toBe('published');
    expect(database.translations.some((row) => row.key === 'goodbye')).toBe(true);
    expect(database.cortex_ai_db_mutation_audit).toHaveLength(1);
    expect(database.cortex_ai_db_mutation_audit[0].tool_name).toBe('execute_database_action_plan');
  });
});

describe('Cortex AI generic database tools: JSONB payload validation', () => {
  const heading = { level: 2, text_content: 'Our story' };

  it('rejects a blocks insert whose content does not fit its block_type', async () => {
    const { supabase } = createMockSupabase({ blocks: [], custom_block_definitions: [] });

    await expect(
      executeDatabaseMutation(
        {
          operation: 'insert',
          rows: [{ block_type: 'heading', content: { level: 'big' }, language_id: 1, order: 0, page_id: 1 }],
          table: 'blocks',
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/content is invalid for block type "heading"/);

    await expect(
      executeDatabaseMutation(
        {
          operation: 'insert',
          rows: [{ content: heading, language_id: 1, order: 0, page_id: 1 }],
          table: 'blocks',
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/block_type is required/);
  });

  it('accepts a valid built-in block and previews it like any other mutation', async () => {
    const { supabase } = createMockSupabase({ blocks: [], custom_block_definitions: [] });

    const preview = asDbConfirmation(
      await executeDatabaseMutation(
        {
          operation: 'insert',
          rows: [{ block_type: 'heading', content: heading, language_id: 1, order: 0, page_id: 1 }],
          table: 'blocks',
        },
        { actorUserId: 'user_1', supabase }
      )
    );

    expect(preview.requiresConfirmation).toBe(true);
  });

  it('prefers the injected app validator when one is supplied', async () => {
    const { supabase } = createMockSupabase({ blocks: [], custom_block_definitions: [] });
    const seen: string[] = [];

    await expect(
      executeDatabaseMutation(
        {
          operation: 'insert',
          rows: [{ block_type: 'heading', content: heading, language_id: 1, order: 0, page_id: 1 }],
          table: 'blocks',
        },
        {
          actorUserId: 'user_1',
          supabase,
          validateBlockContent: (blockType) => {
            seen.push(blockType);
            return { errors: ['app says no'], isValid: false, warnings: [] };
          },
        }
      )
    ).rejects.toThrow(/app says no/);

    expect(seen).toEqual(['heading']);
  });

  it('validates a custom block instance against its definition', async () => {
    const { supabase } = createMockSupabase({
      blocks: [],
      custom_block_definitions: [
        {
          fields: [
            { key: 'title', required: true, type: 'text' },
            { key: 'photo', type: 'image_r2' },
          ],
          name: 'Promo card',
          slug: 'promo-card',
        },
      ],
    });
    const row = (content: Record<string, unknown>, blockType = 'promo-card') => ({
      block_type: blockType,
      content,
      language_id: 1,
      order: 0,
      page_id: 1,
    });

    await expect(
      executeDatabaseMutation({ operation: 'insert', rows: [row({}, 'no-such-block')], table: 'blocks' }, { actorUserId: 'user_1', supabase })
    ).rejects.toThrow(/neither a built-in block type nor a custom block slug/);

    await expect(
      executeDatabaseMutation({ operation: 'insert', rows: [row({ headline: 'Sale' })], table: 'blocks' }, { actorUserId: 'user_1', supabase })
    ).rejects.toThrow(/Unknown field "headline".*Field "title" is required/);

    await expect(
      executeDatabaseMutation({ operation: 'insert', rows: [row({ title: 'Sale', photo: 'https://x/y.jpg' })], table: 'blocks' }, { actorUserId: 'user_1', supabase })
    ).rejects.toThrow(/"photo" must be an uploaded image object/);

    const preview = asDbConfirmation(
      await executeDatabaseMutation(
        { operation: 'insert', rows: [row({ title: 'Sale', photo: { object_key: 'uploads/a.jpg', url: 'https://cdn/a.jpg' } })], table: 'blocks' },
        { actorUserId: 'user_1', supabase }
      )
    );
    expect(preview.requiresConfirmation).toBe(true);
  });

  it('validates an update against the block type of every targeted row', async () => {
    const { supabase } = createMockSupabase({
      blocks: [
        { id: 10, block_type: 'heading', content: heading, page_id: 1 },
        { id: 11, block_type: 'text', content: { html_content: '<p>Hi</p>' }, page_id: 1 },
      ],
      custom_block_definitions: [],
    });

    // Content that fits a heading is rejected because a text block is also targeted.
    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'page_id', operator: 'eq', value: 1 }],
          operation: 'update',
          table: 'blocks',
          values: { content: heading },
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/block_type "text"/);

    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'id', operator: 'eq', value: 10 }],
          operation: 'update',
          table: 'blocks',
          values: { block_type: 'text' },
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/requires the new content/);

    const preview = asDbConfirmation(
      await executeDatabaseMutation(
        {
          filters: [{ column: 'id', operator: 'eq', value: 10 }],
          operation: 'update',
          table: 'blocks',
          values: { content: { level: 3, text_content: 'Renamed' } },
        },
        { actorUserId: 'user_1', supabase }
      )
    );
    expect(preview.requiresConfirmation).toBe(true);
  });

  it('checks known site_settings values and refuses write-protected keys', async () => {
    const { supabase } = createMockSupabase();

    await expect(
      executeDatabaseMutation(
        { operation: 'upsert', rows: [{ key: 'footer_copyright', value: 'plain string' }], table: 'site_settings' },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/Invalid value for site setting "footer_copyright"/);

    await expect(
      executeDatabaseMutation(
        { operation: 'upsert', rows: [{ key: 'cortex_ai_build_session', value: { id: 'x' } }], table: 'site_settings' },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/cannot be written through Cortex AI database tools/);

    await expect(
      executeDatabaseMutation(
        {
          filters: [{ column: 'key', operator: 'eq', value: 'is_admin_created' }],
          operation: 'update',
          table: 'site_settings',
          values: { value: 'false' },
        },
        { actorUserId: 'user_1', supabase }
      )
    ).rejects.toThrow(/cannot be written/);

    const preview = asDbConfirmation(
      await executeDatabaseMutation(
        { operation: 'upsert', rows: [{ key: 'footer_copyright', value: { en: '© {year} Acme' } }], table: 'site_settings' },
        { actorUserId: 'user_1', supabase }
      )
    );
    expect(preview.requiresConfirmation).toBe(true);
  });
});
