import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
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

describe('Cortex AI generic database tools: updated_at', () => {
  const STALE = '2026-01-01T00:00:00.000Z';
  // A later timestamp than the write would make a pre-0.23.4 draft skip its copies: still not kept.
  const FUTURE = '2099-01-01T00:00:00.000Z';

  /** The tool's own stamp: written during the call, so neither older nor later than it. */
  function expectFreshStamp(value: unknown, startedAt: number) {
    expect(value).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
    expect(Date.parse(String(value))).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(String(value))).toBeLessThanOrEqual(Date.now());
  }

  // products.updated_at has no trigger behind it and a raw update writes only the columns it
  // names, so a title changed here left the row looking untouched: the sitemap kept its old
  // lastModified, and the app publishes a pre-0.23.4 product draft's copy of the title, short
  // description and description only while products.updated_at is not later than the draft's
  // created_at, so such a draft could publish its stale title over this change.
  it('stamps a confirmed products update that leaves updated_at out, after the confirmation', async () => {
    const { database, supabase } = createMockSupabase({
      products: [{ id: 'prod-1', title: 'Old title', updated_at: STALE }],
    });
    const input = {
      filters: [{ column: 'id', operator: 'eq' as const, value: 'prod-1' }],
      operation: 'update' as const,
      table: 'products',
      values: { title: 'New title' },
    };

    const preview = asDbConfirmation(await executeDatabaseMutation(input, { actorUserId: 'user_1', supabase }));
    expect(database.products[0]).toEqual({ id: 'prod-1', title: 'Old title', updated_at: STALE });

    const startedAt = Date.now();
    const result = await executeDatabaseMutation(input, {
      actorUserId: 'user_1',
      latestUserMessage: preview.confirmationPhrase,
      supabase,
    });

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.products[0].title).toBe('New title');
    expectFreshStamp(database.products[0].updated_at, startedAt);
    // The phrase matched and the audit holds the input as the user confirmed it, unstamped.
    expect(database.cortex_ai_db_mutation_audit[0].payload.input.values).toEqual({ title: 'New title' });
  });

  // On products the stamp wins over whatever the call carries: read_database_records returns
  // updated_at by default, so a row read, edited and upserted back carries its old timestamp.
  it('stamps every products update and upserted row, whatever updated_at the call carries', async () => {
    const { database, supabase } = createMockSupabase({
      products: [
        { id: 'prod-1', title: 'One', updated_at: STALE },
        { id: 'prod-2', title: 'Two', updated_at: STALE },
        { id: 'prod-3', title: 'Three', updated_at: STALE },
      ],
    });
    const context = { actorUserId: 'user_1', skipConfirmation: true, supabase };
    const startedAt = Date.now();

    const result = await executeDatabaseMutation(
      {
        operation: 'upsert',
        rows: [
          { id: 'prod-1', title: 'One, renamed' },
          { id: 'prod-2', title: 'Two, renamed', updated_at: FUTURE },
        ],
        table: 'products',
      },
      context
    );
    await executeDatabaseMutation(
      {
        filters: [{ column: 'id', operator: 'eq', value: 'prod-3' }],
        operation: 'update',
        table: 'products',
        values: { title: 'Three, renamed', updated_at: null },
      },
      context
    );

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.products.map((row) => row.title)).toEqual(['One, renamed', 'Two, renamed', 'Three, renamed']);
    for (const row of database.products) expectFreshStamp(row.updated_at, startedAt);
  });

  // An insert is written as the call sends it: the column default applies where it leaves updated_at
  // out, and a new product has no pre-0.23.4 draft whose rule the value could steer.
  it('writes a products insert as the call sends it, updated_at included', async () => {
    const { database, supabase } = createMockSupabase({ products: [] });

    const result = await executeDatabaseMutation(
      { operation: 'insert', rows: [{ id: 'prod-9', title: 'Nine', updated_at: STALE }], table: 'products' },
      { actorUserId: 'user_1', skipConfirmation: true, supabase }
    );

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.products).toEqual([{ id: 'prod-9', title: 'Nine', updated_at: STALE }]);
  });

  it('stamps a products row read with read_database_records, edited and upserted back', async () => {
    const { database, supabase } = createMockSupabase({
      products: [
        {
          created_at: STALE,
          id: 'prod-1',
          language_id: 1,
          payment_provider: 'stripe',
          price: 4900,
          product_type: 'physical',
          sku: 'CHANCAPIEDRA',
          slug: 'chanca-piedra',
          status: 'active',
          title: 'Old title',
          updated_at: STALE,
        },
      ],
    });
    const read = await executeReadDatabaseRecords({ table: 'products' }, { supabase });
    expect(read.columns).toContain('updated_at');
    expect(read.rows[0]).toMatchObject({ id: 'prod-1', updated_at: STALE });
    const startedAt = Date.now();

    const result = await executeDatabaseMutation(
      { operation: 'upsert', rows: [{ ...(read.rows[0] as Record<string, unknown>), title: 'New title' }], table: 'products' },
      { actorUserId: 'user_1', skipConfirmation: true, supabase }
    );

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.products[0]).toMatchObject({ created_at: STALE, title: 'New title' });
    expectFreshStamp(database.products[0].updated_at, startedAt);
  });

  it('stamps other tables whose config lists updated_at where the call leaves it out, never one without the column', async () => {
    const { database, supabase } = createMockSupabase({
      product_variants: [
        { id: 'var-1', stock_quantity: 1, updated_at: STALE },
        { id: 'var-2', stock_quantity: 1, updated_at: STALE },
        { id: 'var-3', stock_quantity: 1, updated_at: STALE },
      ],
    });
    const context = { actorUserId: 'user_1', skipConfirmation: true, supabase };
    const startedAt = Date.now();

    await executeDatabaseMutation(
      {
        filters: [{ column: 'id', operator: 'eq', value: 'var-1' }],
        operation: 'update',
        table: 'product_variants',
        values: { stock_quantity: 5 },
      },
      context
    );
    // site_settings has no updated_at column: PostgREST would refuse the whole write.
    await executeDatabaseMutation(
      {
        filters: [{ column: 'key', operator: 'eq', value: 'site_name' }],
        operation: 'update',
        table: 'site_settings',
        values: { value: { en: 'Renamed' } },
      },
      context
    );
    // Outside products, a value the call sets itself, null included, is what it writes.
    await executeDatabaseMutation(
      {
        filters: [{ column: 'id', operator: 'eq', value: 'var-2' }],
        operation: 'update',
        table: 'product_variants',
        values: { stock_quantity: 6, updated_at: null },
      },
      context
    );
    await executeDatabaseMutation(
      {
        operation: 'upsert',
        rows: [{ id: 'var-3', stock_quantity: 7, updated_at: '2026-02-02T00:00:00.000Z' }],
        table: 'product_variants',
      },
      context
    );

    expect(database.product_variants[0].stock_quantity).toBe(5);
    expectFreshStamp(database.product_variants[0].updated_at, startedAt);
    expect(database.site_settings.find((row) => row.key === 'site_name')).toEqual({
      key: 'site_name',
      value: { en: 'Renamed' },
    });
    expect(database.product_variants.slice(1)).toEqual([
      { id: 'var-2', stock_quantity: 6, updated_at: null },
      { id: 'var-3', stock_quantity: 7, updated_at: '2026-02-02T00:00:00.000Z' },
    ]);
  });

  // The stamp names updated_at in every update and upsert of a table whose config lists it, so
  // a config entry for a table without the column would make PostgREST refuse all of them.
  it('lists updated_at only for tables whose migrations create the column', async () => {
    const migrationsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../db/src/supabase/migrations'
    );
    const migrations = readdirSync(migrationsDir)
      .filter((file) => /^\d{5}_[a-z0-9_]+\.sql$/.test(file))
      .map((file) => readFileSync(path.join(migrationsDir, file), 'utf8').replace(/\r\n/g, '\n'));
    const { tables } = await executeDescribeDatabaseSchema({ includeReadOnly: false });
    const stamped = tables.filter((table) => table.columns.includes('updated_at')).map((table) => table.table);

    expect(migrations.length).toBeGreaterThan(0);
    expect(stamped).toContain('products');

    for (const table of stamped) {
      const alter = `ALTER TABLE (?:ONLY )?(?:IF EXISTS )?public\\.${table}\\b[^;]*\\b`;
      const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'i');
      const addColumn = new RegExp(`${alter}ADD COLUMN (?:IF NOT EXISTS )?updated_at\\b`, 'i');
      const dropColumn = new RegExp(`${alter}DROP COLUMN (?:IF EXISTS )?updated_at\\b`, 'i');
      const created = migrations.some(
        (sql) => /^\s*updated_at\s/m.test(sql.match(create)?.[1] ?? '') || addColumn.test(sql)
      );

      expect(created, `a migration creates ${table}.updated_at`).toBe(true);
      expect(migrations.some((sql) => dropColumn.test(sql)), `a migration drops ${table}.updated_at`).toBe(false);
    }
  });
});

/**
 * inventory_items writes go through the inventory functions of migration 02046, which take the rows in
 * SKU order in one statement, the order a product draft publish and a sale's deduction lock them in:
 * PostgREST wrote an insert or upsert in the order given and an update or delete by filter in plan order,
 * so a write holding a later SKU of a publish while the publish held an earlier one deadlocked with it.
 * tools/scripts/product-draft-publish.db.test.ts runs the functions' order against a held row.
 */
describe('Cortex AI database tools and inventory_items', () => {
  function inventoryClient() {
    const mock = createMockSupabase({
      inventory_items: [
        { sku: 'SKU-Z', quantity: 2 },
        { sku: 'SKU-A', quantity: 9 },
        { sku: 'OTHER', quantity: 1 },
      ],
    });
    type RpcAnswer = { data: unknown; error: { code: string; message: string } | null };
    const rpc = vi.fn(async (_fn: string, args: Record<string, any> = {}): Promise<RpcAnswer> => {
      const skus: string[] = args.p_skus ?? (args.p_rows ?? []).map((row: { sku: string }) => row.sku);
      return { data: skus.map((sku) => ({ sku, quantity: args.p_quantity ?? 0 })), error: null };
    });
    const supabase: { from: (table: string) => MockQuery; rpc: (fn: string, args?: Record<string, any>) => Promise<RpcAnswer> } = {
      ...mock.supabase,
      rpc,
    };
    return { database: mock.database, rpc, context: { actorUserId: 'user_1', skipConfirmation: true, supabase } };
  }

  it.each([
    ['insert', 'error'],
    ['upsert', 'update'],
  ] as const)('sends an %s to upsert_inventory_items (%s on an existing row), each row a sku and a quantity, with no updated_at stamp', async (operation, rule) => {
    const { database, rpc, context } = inventoryClient();
    const result = await executeDatabaseMutation(
      {
        operation,
        rows: [
          { sku: 'SKU-Z', quantity: 4 },
          { sku: 'SKU-A', quantity: 7 },
        ],
        table: 'inventory_items',
      },
      context
    );

    expect(result).toMatchObject({ success: true, mutationExecuted: true, affectedCount: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('upsert_inventory_items', {
      p_rows: [
        { sku: 'SKU-Z', quantity: 4 },
        { sku: 'SKU-A', quantity: 7 },
      ],
      p_on_conflict: rule,
    });
    // Nothing went through PostgREST's table write.
    expect(database.inventory_items).toEqual([
      { sku: 'SKU-Z', quantity: 2 },
      { sku: 'SKU-A', quantity: 9 },
      { sku: 'OTHER', quantity: 1 },
    ]);
  });

  it('writes an update or a delete to the rows the filter named when it was confirmed, through update_inventory_quantities and delete_inventory_items', async () => {
    const { rpc, context } = inventoryClient();
    const updated = await executeDatabaseMutation(
      { filters: [{ column: 'sku', operator: 'in', value: ['SKU-Z', 'SKU-A'] }], operation: 'update', table: 'inventory_items', values: { quantity: 5 } },
      context
    );
    expect(updated).toMatchObject({ success: true, affectedCount: 2 });
    expect(rpc).toHaveBeenLastCalledWith('update_inventory_quantities', { p_skus: ['SKU-Z', 'SKU-A'], p_quantity: 5 });

    const deleted = await executeDatabaseMutation(
      { filters: [{ column: 'quantity', operator: 'lt', value: 3 }], operation: 'delete', table: 'inventory_items' },
      context
    );
    expect(deleted).toMatchObject({ success: true, affectedCount: 2 });
    expect(rpc).toHaveBeenLastCalledWith('delete_inventory_items', { p_skus: ['SKU-Z', 'OTHER'] });
  });

  it('refuses, before any confirmation, an inventory row that sets more than a sku and a quantity, a row without either, and an update of anything but the quantity', async () => {
    const { rpc, context } = inventoryClient();
    const confirmable = { ...context, skipConfirmation: false };

    await expect(
      executeDatabaseMutation(
        { operation: 'upsert', rows: [{ sku: 'SKU-A', quantity: 1, updated_at: '2026-01-01T00:00:00Z' }], table: 'inventory_items' },
        confirmable
      )
    ).rejects.toThrow('An inventory_items row is a sku and a quantity');
    await expect(
      executeDatabaseMutation({ operation: 'insert', rows: [{ quantity: 1 }], table: 'inventory_items' }, confirmable)
    ).rejects.toThrow('rows[0] needs a sku.');
    await expect(
      executeDatabaseMutation({ operation: 'insert', rows: [{ sku: 'SKU-N' }], table: 'inventory_items' }, confirmable)
    ).rejects.toThrow('rows[0] (SKU-N) needs a quantity.');
    await expect(
      executeDatabaseMutation(
        { filters: [{ column: 'sku', operator: 'eq', value: 'SKU-A' }], operation: 'update', table: 'inventory_items', values: { sku: 'SKU-B' } },
        confirmable
      )
    ).rejects.toThrow('An inventory_items update sets the quantity only');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a refused write as a failure (the database rolled it back), not as executed', async () => {
    const { context } = inventoryClient();
    context.supabase.rpc = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "inventory_items_pkey"' } }));
    const result = await executeDatabaseMutation(
      { operation: 'insert', rows: [{ sku: 'SKU-A', quantity: 1 }], table: 'inventory_items' },
      { ...context, skipAudit: true }
    );
    expect(result).toMatchObject({ success: false, mutationExecuted: false });
    expect((result as { message: string }).message).toContain('inventory_items_pkey');
  });
});
