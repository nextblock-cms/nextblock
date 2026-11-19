import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { validateMigrationNames } = require('./lib/migration-naming.js');

/**
 * Every migration file replays over a database that already ran them all, once only `public` is
 * dropped. The sandbox reset does that every 15 minutes (apps/nextblock/app/api/cron/reset-sandbox:
 * DROP SCHEMA public CASCADE, then every file in one transaction, concatenated by
 * tools/scripts/generate-sandbox-reset.ts), and so do the stale-history self-heal of /setup and of
 * the build hook, and /setup's local reset. What lives outside `public` survives the drop (the
 * `private` helpers of 02021 and 02043, for instance), so each file must stay valid over what a LATER
 * file left there. Before release (2026-11-18) 02043 created private.apply_product_draft_values RETURNS
 * void and 02044 re-created it RETURNS jsonb: from its second run on, the reset would have stopped at
 * 02043 (42P13, CREATE OR REPLACE cannot change a return type) and rolled back. CI's `supabase start`
 * replays every file once, on an empty database, so only this test sees that.
 *
 * Runs only with NEXTBLOCK_TEST_DB_URL pointing at a LOCAL database where every migration already ran
 * (it refuses any other host), as the CI db-posture job does:
 *
 *   NEXTBLOCK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx vitest run tools/scripts/migration-replay.db.test.ts
 *
 * It changes nothing: it refuses a script holding a top-level statement that would end the
 * transaction, every replay runs in one transaction that is always rolled back, and the test compares
 * the catalog before and after. While it runs, every object in `public` is locked, so it
 * holds DB_TESTS_LOCK exclusively and product-draft-publish.db.test.ts holds it shared: the two wait
 * for each other instead of colliding when vitest runs them side by side.
 */

const DB_URL = process.env.NEXTBLOCK_TEST_DB_URL ?? '';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

if (DB_URL && !LOCAL_HOSTS.has(new URL(DB_URL).hostname)) {
  throw new Error(`Refusing ${new URL(DB_URL).hostname}: this test drops schema public (rolled back); use a local replay.`);
}

/** The advisory lock key of the DB tests (product-draft-publish.db.test.ts takes it shared). */
const DB_TESTS_LOCK = 2_043_111_800;
/** Long enough for the other DB test to finish, then a replay. */
const LOCK_WAIT_MS = 300_000;

type Sql = ReturnType<typeof postgres>;

const MIGRATIONS_DIR = path.resolve(__dirname, '../../libs/db/src/supabase/migrations');

/** The files the sandbox reset replays, chosen and ordered as generate-sandbox-reset.ts does. */
function resetMigrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => !file.toLowerCase().includes('sandbox'))
    .filter((file) => file !== '99999999999999_auto_sandbox_reset.sql')
    .sort();
  const naming = validateMigrationNames(files);
  if (naming.errors.length > 0) {
    throw new Error(`Migration file names break the GGNNN scheme:\n${naming.errors.join('\n')}`);
  }
  return files;
}

/** One file as the reset embeds it: LF line endings, BEGIN; and COMMIT; stripped (generate-sandbox-reset.ts). */
function resetFileSql(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .replace(/\r\n/g, '\n')
    .replace(/(?:^|\n)\s*BEGIN\s*;/gi, '\n')
    .replace(/(?:^|\n)\s*COMMIT\s*;/gi, '\n');
}

/** Step C of the reset: every file in order, each after its `-- >>> FROM:` line, nothing in between. */
function resetMigrationSql(files: string[]): string {
  return files.map((file) => `\n\n-- >>> FROM: ${file} <<<\n${resetFileSql(file)}`).join('');
}

/** Step B of the reset, as generate-sandbox-reset.ts writes it: `public` re-created empty, the history emptied. */
const RESET_STEP_B = `
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
  TRUNCATE TABLE supabase_migrations.schema_migrations;
`;

/** Comments, quoted strings and identifiers, and dollar-quoted bodies, matched left to right. */
const SQL_NOT_CODE =
  /--[^\n]*|\/\*[\s\S]*?\*\/|(?<![\w$])[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;

/**
 * Top-level statements that end the transaction (best effort). The reset strips BEGIN; and COMMIT;
 * at line starts only; any other such statement would commit half a reset on the sandbox, and this
 * test's DROP SCHEMA for real.
 */
function transactionEndingStatements(script: string): string[] {
  const code = script.replace(SQL_NOT_CODE, (match) => (match.startsWith('--') || match.startsWith('/*') || match.startsWith('$') ? ' ' : "''"));
  return code
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /^(commit|end|rollback|abort|prepare\s+transaction)\b/i.test(statement));
}

function describeError(error: unknown): string {
  const e = error as { code?: string; message?: string; hint?: string; where?: string };
  return [e.code, e.message ?? String(error), e.hint && `(hint: ${e.hint})`, e.where && `[${e.where}]`]
    .filter(Boolean)
    .join(' ');
}

class RolledBack extends Error {}

/** Runs `run` in a transaction that is always rolled back, and returns what it returned. */
async function inRolledBackTransaction<T>(sql: Sql, run: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await sql.begin(async (tx) => {
      result = await run(tx as unknown as Sql);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return result as T;
}

/**
 * What a replay must leave as the first run left it: the functions, relations, policies and triggers
 * of `public` and `private`, without OIDs or grants (the post-apply grant pass changes grants after
 * the first run, and never after a reset). Function bodies without carriage returns: the reset
 * replays LF text, and a Windows checkout may have applied the files with CRLF.
 */
async function definitions(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe(`
    select format('function %s returns %s %s %s %s', p.oid::regprocedure, pg_get_function_result(p.oid),
                  case when p.prosecdef then 'definer' else 'invoker' end, coalesce(array_to_string(p.proconfig, ','), ''),
                  md5(replace(p.prosrc, chr(13), ''))) as item
      from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all
    select format('relation %I.%I %s', n.nspname, c.relname, c.relkind)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private')
    union all
    select format('policy %I.%I %I %s %s %s', schemaname, tablename, policyname, cmd, roles::text,
                  md5(coalesce(qual, '') || '|' || coalesce(with_check, '')))
      from pg_policies
    union all
    select format('trigger %s %I %s', t.tgrelid::regclass, t.tgname, t.tgfoid::regprocedure)
      from pg_trigger t
     where not t.tgisinternal
       and (t.tgrelid in (select c.oid from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace))
            or t.tgfoid in (select p.oid from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)))
     order by 1`);
  return rows.map((row) => String(row.item));
}

/** The catalog as it is, OIDs and grants included, the migration history and a few row counts: a rollback restores all of it. */
async function catalogState(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe(`
    select format('function %s %s %s %s', p.oid, p.oid::regprocedure, md5(p.prosrc), coalesce(p.proacl::text, '')) as item
      from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all
    select format('relation %s %I.%I %s', c.oid, n.nspname, c.relname, coalesce(c.relacl::text, ''))
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private')
    union all
    select format('schema %s %I %s', n.oid, n.nspname, coalesce(n.nspacl::text, ''))
      from pg_namespace n
     where n.nspname in ('public', 'private')
    union all
    select format('default acl %s', d.defaclacl::text) from pg_default_acl d
    union all
    select format('migration %s', m.version) from supabase_migrations.schema_migrations m
    union all
    select format('rows site_settings %s, pages %s, products %s, blocks %s',
                  (select count(*) from public.site_settings), (select count(*) from public.pages),
                  (select count(*) from public.products), (select count(*) from public.blocks))
     order by 1`);
  return rows.map((row) => String(row.item));
}

describe('the sandbox reset’s migration replay, without a database', () => {
  it('replays every migration file the reset embeds, in order', () => {
    const files = resetMigrationFiles();
    expect(files[0]).toMatch(/^\d{2}000_catchup_gen\d+\.sql$/);
    expect(files).toContain('02043_atomic_product_draft_publish.sql');
    expect(resetMigrationSql(files)).toContain('\n\n-- >>> FROM: 02044_product_draft_publish_stock_baseline.sql <<<\n');
  });

  it('no migration ends the transaction at top level (the reset runs every file in one)', () => {
    expect(transactionEndingStatements(resetMigrationSql(resetMigrationFiles()))).toEqual([]);
    // The scan itself: statements count, bodies, comments and strings do not.
    expect(
      transactionEndingStatements(
        "-- a DO $$ block:\nDO $b$ BEGIN IF x THEN NULL; END IF; END $b$;\n-- COMMIT;\nSELECT 'END; it''s', E'\\' END;';\nCOMMIT;\nend;"
      )
    ).toEqual(['COMMIT', 'end']);
  });
});

const describeDb = DB_URL ? describe : describe.skip;

describeDb('every migration replayed over a migrated database (the sandbox reset from its second run on)', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
    // Exclusive for the whole file, so the catalog compared below cannot move under another test.
    await sql.unsafe(`select pg_advisory_lock(${DB_TESTS_LOCK})`);
  }, LOCK_WAIT_MS);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it(
    'runs Step B (DROP SCHEMA public CASCADE) and every file in one transaction with no error, ends where the first run ended, and leaves the database as it was',
    async () => {
      const files = resetMigrationFiles();
      const script = RESET_STEP_B + resetMigrationSql(files);
      // A statement that ends the transaction would commit the drop for real: never run such a script.
      expect(transactionEndingStatements(script), 'a migration ends the transaction at top level').toEqual([]);
      const before = await catalogState(sql);
      const firstRun = await definitions(sql);

      let replayed: string[] = [];
      try {
        replayed = await inRolledBackTransaction(sql, async (tx) => {
          await tx.unsafe(script);
          return definitions(tx);
        });
      } catch (error) {
        // Name the file: the same replay again, one file at a time.
        let where = 'no file fails on its own: does one end without a semicolon, so the next one joins its last statement?';
        try {
          await inRolledBackTransaction(sql, async (tx) => {
            await tx.unsafe(RESET_STEP_B);
            for (const file of files) {
              await tx.unsafe(resetFileSql(file)).catch((fileError: unknown) => {
                throw new Error(`${file}: ${describeError(fileError)}`);
              });
            }
          });
        } catch (fileError) {
          where = (fileError as Error).message;
        }
        throw new Error(`The replay failed: ${describeError(error)}\nFirst failing file: ${where}`);
      }

      expect(replayed, 'the replay ends with the definitions the first run left (a database migrated from older copies of these files differs: re-create it)').toEqual(firstRun);
      expect(await catalogState(sql), 'the rollback leaves the database as it was').toEqual(before);
    },
    LOCK_WAIT_MS
  );

  it(
    '02044 still upgrades a database whose 02043 created private.apply_product_draft_values RETURNS void (before 2026-11-18)',
    async () => {
      const upgrade = resetFileSql('02044_product_draft_publish_stock_baseline.sql');
      expect(transactionEndingStatements(upgrade)).toEqual([]);
      const before = await catalogState(sql);

      const upgraded = await inRolledBackTransaction(sql, async (tx) => {
        await tx.unsafe(`
          DROP FUNCTION IF EXISTS private.apply_product_draft_values(uuid, jsonb);
          CREATE FUNCTION private.apply_product_draft_values(p_product_id uuid, p_values jsonb)
              RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $$ BEGIN END $$;`);
        await tx.unsafe(upgrade);
        const [row] = await tx.unsafe(`
          select pg_get_function_result('private.apply_product_draft_values(uuid, jsonb)'::regprocedure) as returns,
                 has_function_privilege('anon', 'private.apply_product_draft_values(uuid, jsonb)', 'execute') as anon,
                 has_function_privilege('authenticated', 'private.apply_product_draft_values(uuid, jsonb)', 'execute') as authenticated`);
        return row;
      });

      expect(upgraded).toEqual({ returns: 'jsonb', anon: false, authenticated: true });
      expect(await catalogState(sql)).toEqual(before);
    },
    LOCK_WAIT_MS
  );

  it(
    '02043 replays over a database whose earlier copy of 02043 created private.apply_product_draft_values RETURNS void, with 02044 not yet run (a developer stack before 2026-11-18)',
    async () => {
      const file = resetFileSql('02043_atomic_product_draft_publish.sql');
      expect(transactionEndingStatements(file)).toEqual([]);
      const before = await catalogState(sql);

      const replayed = await inRolledBackTransaction(sql, async (tx) => {
        await tx.unsafe(`
          DROP FUNCTION IF EXISTS private.apply_product_draft_values(uuid, jsonb);
          CREATE FUNCTION private.apply_product_draft_values(p_product_id uuid, p_values jsonb)
              RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $$ BEGIN END $$;`);
        await tx.unsafe(file);
        const [row] = await tx.unsafe(`
          select pg_get_function_result('private.apply_product_draft_values(uuid, jsonb)'::regprocedure) as returns,
                 has_function_privilege('anon', 'private.apply_product_draft_values(uuid, jsonb)', 'execute') as anon,
                 has_function_privilege('authenticated', 'private.apply_product_draft_values(uuid, jsonb)', 'execute') as authenticated`);
        return row;
      });

      expect(replayed).toEqual({ returns: 'jsonb', anon: false, authenticated: true });
      expect(await catalogState(sql)).toEqual(before);
    },
    LOCK_WAIT_MS
  );
});
