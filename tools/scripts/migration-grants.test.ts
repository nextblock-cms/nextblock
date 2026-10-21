import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { codeOnly, findUngrantedObjects, findTablesWithoutRls, validateMigrationGrants } = require('./lib/migration-grants.js');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../libs/db/src/supabase/migrations');

const CREATE = 'CREATE TABLE IF NOT EXISTS public.widgets (id uuid PRIMARY KEY, name text);';
const GRANT = 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widgets TO anon, authenticated, service_role;';

describe('codeOnly', () => {
  it('drops comments and empties string literals, keeping dollar-quoted bodies', () => {
    const sql = [
      "-- CREATE TABLE public.a (id uuid); don't",
      '/* CREATE TABLE public.b (id uuid); */',
      "INSERT INTO public.notes (body) VALUES ('CREATE TABLE public.c (id uuid) -- not a comment');",
      "SELECT E'it\\'s', 'it''s';",
      'DO $$ BEGIN CREATE TABLE public.d (id uuid); END $$;',
    ].join('\n');
    const code = codeOnly(sql);
    expect(code).not.toMatch(/public\.[abc]\b/);
    expect(code).toContain('CREATE TABLE public.d');
    expect(code).toContain("INSERT INTO public.notes (body) VALUES ('');");
  });
});

describe('explicit grants on new tables, views and sequences', () => {
  it('flags a table created without a grant', () => {
    const problems = findUngrantedObjects('CREATE TABLE public.widgets (id uuid PRIMARY KEY);');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'TABLE', name: 'widgets' });
    expect(problems[0].problem).toContain('GRANT ... ON TABLE public.widgets');
  });

  it('accepts every grant spelling', () => {
    expect(findUngrantedObjects(`${CREATE}\n${GRANT}`)).toEqual([]);
    expect(findUngrantedObjects(`${CREATE}\nGRANT ALL ON public.widgets TO anon;`)).toEqual([]);
    expect(findUngrantedObjects(`${CREATE}\nGRANT ALL ON "public" . "widgets" TO anon;`)).toEqual([]);
    expect(findUngrantedObjects(`${GRANT}\n${CREATE}`)).toEqual([]);
    expect(findUngrantedObjects('CREATE TABLE widgets (id uuid);\nGRANT SELECT ON TABLE widgets TO PUBLIC;')).toEqual([]);
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;`)).toEqual([]);
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON TABLE public.gadgets,\n  public.widgets TO authenticated;`)).toEqual([]);
  });

  it('requires an API role among the grantees', () => {
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON TABLE public.widgets TO postgres;`)).toHaveLength(1);
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON TABLE public.widgets TO postgres, service_role;`)).toEqual([]);
  });

  it('does not accept a grant on a different object or in another schema', () => {
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON TABLE public.widgets_archive TO anon;`)).toHaveLength(1);
    expect(findUngrantedObjects(`${CREATE}\nGRANT SELECT ON TABLE private.widgets TO anon;`)).toHaveLength(1);
  });

  it('handles views and foreign tables like tables', () => {
    expect(findUngrantedObjects('CREATE OR REPLACE VIEW public.cards AS SELECT 1;')).toMatchObject([{ kind: 'VIEW', name: 'cards' }]);
    expect(findUngrantedObjects('CREATE VIEW public.cards AS SELECT 1;\nGRANT SELECT ON public.cards TO anon;')).toEqual([]);
    expect(findUngrantedObjects('CREATE MATERIALIZED VIEW public.stats AS SELECT 1;')).toMatchObject([{ kind: 'MATERIALIZED VIEW' }]);
  });

  it('handles sequences', () => {
    expect(findUngrantedObjects('CREATE SEQUENCE public.widget_seq;')).toMatchObject([{ kind: 'SEQUENCE', name: 'widget_seq' }]);
    expect(findUngrantedObjects('CREATE SEQUENCE IF NOT EXISTS public.widget_seq;\nGRANT USAGE, SELECT ON SEQUENCE public.widget_seq TO anon;')).toEqual([]);
    expect(findUngrantedObjects('CREATE SEQUENCE public.widget_seq;\nGRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon;')).toEqual([]);
    // A table grant does not cover a sequence of the same name.
    expect(findUngrantedObjects('CREATE SEQUENCE public.widgets;\nGRANT SELECT ON TABLE public.widgets TO anon;')).toHaveLength(1);
  });

  it('requires a grant on the implicit sequence of a serial or identity column, by name', () => {
    const identity = `CREATE TABLE public.widgets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);\n${GRANT}`;
    const problems = findUngrantedObjects(identity);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'SEQUENCE', name: 'widgets_id_seq' });
    expect(findUngrantedObjects(`${identity}\nGRANT USAGE, SELECT ON SEQUENCE public.widgets_id_seq TO anon;`)).toEqual([]);
    expect(findUngrantedObjects(`${identity}\nGRANT USAGE ON SEQUENCE public.other_seq TO anon;`)).toHaveLength(1);
    expect(findUngrantedObjects(`${identity}\nGRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon;`)).toEqual([]);
    expect(findUngrantedObjects(`CREATE TABLE public.widgets (id bigserial PRIMARY KEY);\n${GRANT}`)).toHaveLength(1);
    expect(findUngrantedObjects(`CREATE TABLE public.widgets (id serial8 PRIMARY KEY);\n${GRANT}`)).toHaveLength(1);
    expect(findUngrantedObjects(`CREATE TABLE public.widgets (id uuid DEFAULT gen_random_uuid(), kind text DEFAULT 'serial', CHECK (kind IN ('a', 'b')));\n${GRANT}`)).toEqual([]);
  });

  it('ignores comments, string literals, other schemas, TEMP tables and repeats', () => {
    const sql = [
      '-- CREATE TABLE public.commented_out (id uuid);',
      '/* CREATE TABLE public.also_commented (id uuid); */',
      "INSERT INTO public.notes (body) VALUES ('<pre>CREATE TABLE public.from_docs (id serial)</pre>');",
      "DO $$ BEGIN RAISE NOTICE 'CREATE TABLE public.in_a_message'; END $$;",
      'CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text);',
      'CREATE TEMP TABLE scratch (id uuid);',
      'CREATE TABLE public.widgets (id uuid);',
      'CREATE TABLE IF NOT EXISTS public.widgets (id uuid);',
      GRANT,
    ].join('\n');
    expect(findUngrantedObjects(sql)).toEqual([]);
  });

  it('lints forward migrations only', () => {
    const files = ['02000_catchup_gen1.sql', '02001_baseline_schema.sql', '02005_add_widgets.sql', 'notes.txt'];
    // A bare CREATE TABLE in a forward migration now trips BOTH the missing-grant check and the
    // missing-RLS check; baseline/catch-up/non-sql files are not linted.
    const result = validateMigrationGrants(files, () => 'CREATE TABLE public.widgets (id uuid);');
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => e.startsWith('02005_add_widgets.sql: table public.widgets'))).toBe(true);
    expect(result.errors.some((e) => /GRANT/.test(e))).toBe(true);
    expect(result.errors.some((e) => /ROW LEVEL SECURITY/.test(e))).toBe(true);
  });

  it('flags a new table without ENABLE ROW LEVEL SECURITY, accepts one with it', () => {
    const noRls = 'CREATE TABLE public.widgets (id uuid);\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widgets TO anon, authenticated, service_role;';
    expect(findTablesWithoutRls(noRls)).toHaveLength(1);
    const withRls =
      noRls + '\nALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;';
    expect(findTablesWithoutRls(withRls)).toEqual([]);
    // views and sequences are not row-secured, so they are never flagged
    expect(findTablesWithoutRls('CREATE VIEW public.v AS SELECT 1; CREATE SEQUENCE public.s;')).toEqual([]);
  });

  it('passes for every forward migration on disk', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
    const result = validateMigrationGrants(files, (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    expect(result.errors).toEqual([]);
  });
});

describe('GRANT / REVOKE statement parsing', () => {
  const { privilegeStatements, codeOnly: strip } = require('./lib/migration-grants.js');

  it('reads object, privileges and grantees, including ALL ... IN SCHEMA and column lists', () => {
    const statements = privilegeStatements(
      strip(
        [
          'REVOKE ALL ON FUNCTION public.f(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;',
          'revoke usage, update on all sequences in schema public from anon;',
          'REVOKE UPDATE (role) ON public.profiles FROM authenticated CASCADE;',
          'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;',
          'REVOKE ALL ON SCHEMA private FROM PUBLIC;',
          'REVOKE ALL ON FUNCTION private.g() FROM PUBLIC;',
        ].join('\n'),
      ),
    );
    expect(statements).toMatchObject([
      {
        action: 'REVOKE',
        kind: 'function',
        all: false,
        names: ['f'],
        signatures: ['uuid, timestamp with time zone'],
        privileges: ['EXECUTE'],
        grantees: ['public', 'anon', 'authenticated'],
      },
      { action: 'REVOKE', kind: 'sequence', all: true, names: [], privileges: ['USAGE', 'UPDATE'], grantees: ['anon'] },
      { action: 'REVOKE', kind: 'table', all: false, names: ['profiles'], signatures: [null], privileges: ['UPDATE'], grantees: ['authenticated'] },
      { action: 'GRANT', kind: 'table', all: true, names: [], privileges: ['SELECT'], grantees: ['anon'] },
    ]);
    expect(statements).toHaveLength(4);
  });

  it('reads ALTER DEFAULT PRIVILEGES as a grant on every future object', () => {
    expect(privilegeStatements('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE ON TABLES TO anon;')).toMatchObject([
      { action: 'GRANT', kind: 'table', all: true, defaults: true, privileges: ['INSERT', 'UPDATE'], grantees: ['anon'] },
    ]);
    expect(privilegeStatements('ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT INSERT ON TABLES TO anon;')).toEqual([]);
  });
});

describe('SECURITY DEFINER functions in public', () => {
  const { findUnrevokedDefinerFunctions, definerFunctionsInPublic, codeOnly: strip } = require('./lib/migration-grants.js');
  const DEFINER = [
    'CREATE OR REPLACE FUNCTION public.leak(p uuid) RETURNS boolean',
    '    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public',
    '    AS $fn$ BEGIN RETURN true; END; $fn$;',
  ].join('\n');

  it('finds definer functions in public, wherever SECURITY DEFINER sits in the header', () => {
    expect(definerFunctionsInPublic(strip(DEFINER))).toEqual(['leak']);
    expect(definerFunctionsInPublic(strip('CREATE FUNCTION leak2() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql SECURITY DEFINER;'))).toEqual(['leak2']);
    expect(definerFunctionsInPublic(strip('ALTER FUNCTION public.leak3(uuid) SECURITY DEFINER;'))).toEqual(['leak3']);
    // invoker functions, private definer functions and the words inside a body are not findings
    expect(definerFunctionsInPublic(strip('CREATE FUNCTION public.ok() RETURNS int LANGUAGE sql SECURITY INVOKER AS $$ SELECT 1 $$;'))).toEqual([]);
    expect(definerFunctionsInPublic(strip('CREATE FUNCTION private.p() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;'))).toEqual([]);
    expect(definerFunctionsInPublic(strip("CREATE FUNCTION public.doc() RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$; -- SECURITY DEFINER"))).toEqual([]);
  });

  it('flags a definer function without a same-file revoke from PUBLIC, anon and authenticated', () => {
    const problems = findUnrevokedDefinerFunctions(DEFINER);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/missing: public, anon, authenticated/);
  });

  it('a revoke from PUBLIC alone is not enough on Supabase', () => {
    const problems = findUnrevokedDefinerFunctions(`${DEFINER}\nREVOKE ALL ON FUNCTION public.leak(uuid) FROM PUBLIC;`);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/missing: anon, authenticated/);
  });

  it('accepts the full revoke, split or combined, ALL or EXECUTE', () => {
    expect(findUnrevokedDefinerFunctions(`${DEFINER}\nREVOKE ALL ON FUNCTION public.leak(uuid) FROM PUBLIC, anon, authenticated;`)).toEqual([]);
    expect(
      findUnrevokedDefinerFunctions(
        `${DEFINER}\nREVOKE EXECUTE ON FUNCTION public.leak(uuid) FROM PUBLIC;\nREVOKE EXECUTE ON FUNCTION leak(uuid) FROM anon, authenticated;`,
      ),
    ).toEqual([]);
  });

  it('flags a definer function granted back to an API caller', () => {
    const sql = `${DEFINER}\nREVOKE ALL ON FUNCTION public.leak(uuid) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.leak(uuid) TO authenticated, service_role;`;
    const problems = findUnrevokedDefinerFunctions(sql);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/granted EXECUTE to authenticated/);
  });

  it('runs inside validateMigrationGrants for forward migrations only', () => {
    const files = ['02001_baseline_schema.sql', '02030_add_leak.sql'];
    const result = validateMigrationGrants(files, () => DEFINER);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^02030_add_leak\.sql: SECURITY DEFINER function public\.leak/);
  });
});

describe('revokes the post-apply grant pass would undo', () => {
  const { findRevokesUndoneByGrantPass } = require('./lib/migration-grants.js');
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  const read = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');

  it('every revoke from anon/authenticated in a forward migration survives GRANTS_SQL', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    expect(findRevokesUndoneByGrantPass(files, read, GRANTS_SQL).map((p: { problem: string }) => p.problem)).toEqual([]);
  });

  it('catches the 02022 cortex_request_log regression against the pre-02025 grant pass', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const before = GRANTS_SQL.replace(/\n\s*if to_regclass\('public\.cortex_request_log'\)[^]*?end if;/, '');
    expect(before).not.toBe(GRANTS_SQL);
    const problems = findRevokesUndoneByGrantPass(files, read, before);
    expect(problems.some((p: { problem: string }) => /^02022_.*cortex_request_log from authenticated/.test(p.problem))).toBe(true);
  });

  it('flags a 02026 table revoke that the grant pass drops', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const before = GRANTS_SQL.replace(/\n\s*if to_regclass\('public\.user_security_settings'\)[^]*?end if;/, '');
    expect(before).not.toBe(GRANTS_SQL);
    const problems = findRevokesUndoneByGrantPass(files, read, before);
    expect(problems.map((p: { problem: string }) => p.problem)).toEqual([
      expect.stringMatching(/^02026_.*revokes INSERT, UPDATE, DELETE on table public\.user_security_settings from authenticated/),
    ]);
  });

  it('flags a 02027 SELECT revoke that the grant pass drops', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const before = GRANTS_SQL.replace(/\n\s*if to_regclass\('public\.orders'\) is not null then\s+revoke select[^]*?end if;/, '');
    expect(before).not.toBe(GRANTS_SQL);
    const problems = findRevokesUndoneByGrantPass(files, read, before);
    expect(problems.map((p: { problem: string }) => p.problem)).toEqual([
      expect.stringMatching(/^02027_.*revokes SELECT on table public\.orders from anon/),
    ]);
  });

  it('flags a new function revoke that is missing from API_ROLE_REVOKE_SQL, but not a trigger function', () => {
    const pass = 'grant execute on all functions in schema public to anon, authenticated, service_role;' +
      "do $nb_trg$ begin perform 1 from pg_type t where t.typname = 'trigger'; end $nb_trg$;";
    const sql: Record<string, string> = {
      '02001_baseline_schema.sql': 'CREATE FUNCTION public.on_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
      '02030_lock_rpc.sql': 'REVOKE EXECUTE ON FUNCTION public.rpc() FROM anon, authenticated;\nREVOKE EXECUTE ON FUNCTION public.on_write() FROM anon;',
    };
    const problems = findRevokesUndoneByGrantPass(Object.keys(sql), (n: string) => sql[n], pass);
    expect(problems.map((p: { problem: string }) => p.problem)).toEqual([
      expect.stringMatching(/^02030_lock_rpc\.sql: revokes EXECUTE on function public\.rpc\(\) from anon/),
      expect.stringMatching(/^02030_lock_rpc\.sql: revokes EXECUTE on function public\.rpc\(\) from authenticated/),
    ]);
  });
});

describe('new tables and views the post-apply grant pass widens', () => {
  const { findGrantsWidenedByGrantPass } = require('./lib/migration-grants.js');
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  const read = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  // the shape of GRANTS_SQL: blanket grants, then the pass's own revokes
  const PASS =
    'grant select on all tables in schema public to anon;' +
    'grant all on all tables in schema public to authenticated, service_role;' +
    'do $nb_api$ begin revoke truncate on all tables in schema public from anon, authenticated;' +
    ' revoke references, trigger on all tables in schema public from authenticated; end $nb_api$;';
  const SERVICE_ONLY =
    'CREATE TABLE public.ledger (id uuid PRIMARY KEY);\nALTER TABLE public.ledger ENABLE ROW LEVEL SECURITY;\n' +
    'GRANT ALL ON TABLE public.ledger TO service_role;';
  const widened = (sql: Record<string, string>, pass = PASS) =>
    findGrantsWidenedByGrantPass(Object.keys(sql), (n: string) => sql[n], pass).map((p: { problem: string }) => p.problem);

  it('every table and view a forward migration creates keeps its grants through GRANTS_SQL', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    expect(findGrantsWidenedByGrantPass(files, read, GRANTS_SQL).map((p: { problem: string }) => p.problem)).toEqual([]);
  });

  it('catches the 02021 profile_cards writes against the pre-02027 grant pass', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const before = GRANTS_SQL.replace(/\n\s*if to_regclass\('public\.profile_cards'\)[^]*?end if;/, '');
    expect(before).not.toBe(GRANTS_SQL);
    const problems = findGrantsWidenedByGrantPass(files.filter((f) => !f.startsWith('02027_')), read, before);
    expect(problems.map((p: { problem: string }) => p.problem)).toEqual([
      expect.stringMatching(/^02021_.*view public\.profile_cards without granting INSERT, UPDATE, DELETE to authenticated/),
    ]);
  });

  it('flags a service-role-only table until the pass revokes what its blanket grants add', () => {
    expect(widened({ '02030_ledger.sql': SERVICE_ONLY })).toEqual([
      expect.stringMatching(/^02030_ledger\.sql: creates table public\.ledger without granting SELECT to anon.*revoke select on table public\.ledger from anon/),
      expect.stringMatching(/without granting SELECT, INSERT, UPDATE, DELETE to authenticated/),
    ]);
    const pass = PASS.replace(
      ' end $nb_api$;',
      ' if to_regclass(\'public.ledger\') is not null then revoke all on table public.ledger from anon, authenticated; end if; end $nb_api$;',
    );
    expect(widened({ '02030_ledger.sql': SERVICE_ONLY }, pass)).toEqual([]);
  });

  it('accepts a table granted what the pass grants, in the file or a later migration, or to PUBLIC', () => {
    const readable =
      'CREATE TABLE public.notes (id uuid);\nALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;\n' +
      'GRANT SELECT ON TABLE public.notes TO anon;\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated, service_role;';
    expect(widened({ '02030_notes.sql': readable })).toEqual([]);
    expect(
      widened({
        '02030_ledger.sql': SERVICE_ONLY,
        '02031_open_ledger.sql': 'GRANT SELECT ON public.ledger TO PUBLIC;\nGRANT INSERT, UPDATE, DELETE ON public.ledger TO authenticated;',
      }),
    ).toEqual([]);
  });

  it('counts a later revoke and ignores grants made before the CREATE, the baseline and sequences', () => {
    expect(
      widened({
        '02030_notes.sql': 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;\nCREATE VIEW public.cards AS SELECT 1;\nGRANT SELECT ON public.cards TO authenticated;',
      }),
    ).toEqual([
      expect.stringMatching(/view public\.cards without granting SELECT to anon/),
      expect.stringMatching(/view public\.cards without granting INSERT, UPDATE, DELETE to authenticated/),
    ]);
    expect(
      widened({
        '02001_baseline_schema.sql': SERVICE_ONLY,
        '02030_seq.sql': 'CREATE SEQUENCE public.n_seq;\nGRANT USAGE ON SEQUENCE public.n_seq TO service_role;',
      }),
    ).toEqual([]);
    const narrowedLater = {
      '02030_notes.sql': 'CREATE TABLE public.notes (id uuid);\nGRANT ALL ON public.notes TO anon, authenticated;',
      '02031_close_notes.sql': 'REVOKE SELECT ON public.notes FROM anon;',
    };
    expect(widened(narrowedLater)).toEqual([expect.stringMatching(/public\.notes without granting SELECT to anon/)]);
  });
});

describe('anon write grants', () => {
  const { findAnonWriteGrants } = require('./lib/migration-grants.js');

  it('flags table writes granted to anon or PUBLIC, accepts SELECT and writes for other roles', () => {
    expect(findAnonWriteGrants(GRANT)).toHaveLength(1);
    expect(findAnonWriteGrants('GRANT ALL ON TABLE public.widgets TO anon;')[0].problem).toMatch(/grants INSERT, UPDATE, DELETE, TRUNCATE on public\.widgets to anon/);
    expect(findAnonWriteGrants('GRANT INSERT ON ALL TABLES IN SCHEMA public TO PUBLIC;')).toHaveLength(1);
    expect(findAnonWriteGrants('GRANT SELECT ON TABLE public.widgets TO anon;\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widgets TO authenticated, service_role;')).toEqual([]);
    expect(findAnonWriteGrants('GRANT USAGE ON SCHEMA public TO anon;\nGRANT EXECUTE ON FUNCTION public.f() TO anon;')).toEqual([]);
  });

  it('flags sequence writes (nextval / setval) and default-privilege writes for anon', () => {
    expect(findAnonWriteGrants('GRANT USAGE, UPDATE ON SEQUENCE public.order_invoice_number_seq TO anon;')).toEqual([
      expect.objectContaining({ problem: expect.stringMatching(/grants USAGE, UPDATE on sequence public\.order_invoice_number_seq to anon/) }),
    ]);
    expect(findAnonWriteGrants('GRANT SELECT ON SEQUENCE public.s TO anon;')).toEqual([]);
    expect(findAnonWriteGrants('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE ON TABLES TO anon;')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------
 * Bypasses found by the 2026-10-21 review. Every case below passed the lint before the fix.
 * ---------------------------------------------------------------------------------------- */

const lint = (sql: string) => validateMigrationGrants(['02099_review_case.sql'], () => sql).errors as string[];

describe('tokenizer: strings, dollar quotes, comments and identifiers stay in sync', () => {
  it('a dollar-quoted French string with an apostrophe does not hide the DDL after it', () => {
    const sql = [
      "UPDATE public.blocks SET content = jsonb_set(content, '{html_content}', to_jsonb($n$<p>L'outil</p>$n$)) WHERE false;",
      'CREATE TABLE public.leaky (id uuid, secret text);',
      "UPDATE public.blocks SET content = '{}' WHERE false;",
    ].join('\n');
    expect(findUngrantedObjects(sql)).toMatchObject([{ name: 'leaky' }]);
    expect(findTablesWithoutRls(sql)).toMatchObject([{ name: 'leaky' }]);
  });

  it('a dollar-quoted COMMENT with an apostrophe does not hide a SECURITY DEFINER function', () => {
    const sql = [
      "COMMENT ON TABLE public.orders IS $c$Don't expose$c$;",
      'CREATE FUNCTION public.leak() RETURNS setof public.orders LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM public.orders $$;',
      "SELECT 'x';",
    ].join('\n');
    expect(lint(sql).some((e) => /SECURITY DEFINER function public\.leak/.test(e))).toBe(true);
  });

  it('only bodies after DO or AS are code; every other dollar string is a literal', () => {
    expect(findUngrantedObjects('SELECT $q$ CREATE TABLE public.not_code (id uuid) $q$;')).toEqual([]);
    expect(findUngrantedObjects('DO $q$ BEGIN CREATE TABLE public.in_do (id uuid); END $q$;')).toMatchObject([{ name: 'in_do' }]);
    expect(findUngrantedObjects('DO LANGUAGE plpgsql $q$ BEGIN CREATE TABLE public.in_do2 (id uuid); END $q$;')).toMatchObject([{ name: 'in_do2' }]);
    // DO takes any string constant, a single-quoted one included
    expect(findUngrantedObjects("DO 'BEGIN CREATE TABLE public.in_quoted_do (id uuid); END';")).toMatchObject([{ name: 'in_quoted_do' }]);
    // a literal inside a body stays a literal
    expect(findUngrantedObjects("DO $$ BEGIN RAISE NOTICE '%', $m$CREATE TABLE public.msg (id uuid)$m$; END $$;")).toEqual([]);
  });

  it("E'' strings, doubled quotes, nested comments and quoted identifiers keep the tokenizer in sync", () => {
    const hidden = 'CREATE TABLE public.hidden (id uuid);';
    for (const prefix of [
      "UPDATE public.x SET y = 1 WHERE name LIKE'%\\';", // not an E string: the backslash is literal
      "SELECT E'it\\'s';",
      "SELECT 'it''s';",
      '/* outer /* inner */ still a comment; */',
      'CREATE POLICY "Don\'t ; $$ --" ON public.x FOR SELECT TO authenticated USING (auth.uid() = id);',
      'SELECT 1 AS "it\'s";',
    ]) {
      expect(findUngrantedObjects(`${prefix}\n${hidden}`), prefix).toMatchObject([{ name: 'hidden' }]);
    }
  });

  it('a quoted identifier is case-sensitive: RLS on public.secrets does not cover public."Secrets"', () => {
    const sql =
      'CREATE TABLE public."Secrets" (id uuid);\nGRANT SELECT ON public."Secrets" TO authenticated;\nALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;';
    expect(findTablesWithoutRls(sql)).toMatchObject([{ name: '"Secrets"' }]);
    expect(findUngrantedObjects(sql)).toEqual([]);
  });

  it('codeOnly is idempotent, so privilegeStatements(codeOnly(sql)) reads what the lint reads', () => {
    const sql = [
      "COMMENT ON TABLE public.t IS $c$Don't$c$; -- note",
      "DO $$ BEGIN EXECUTE format('REVOKE SELECT ON public.%I FROM anon', 'x'); END $$;",
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      'CREATE POLICY "Mixed Case" ON public."T" USING (true);',
    ].join('\n');
    expect(codeOnly(codeOnly(sql))).toBe(codeOnly(sql));
  });

  it('fails the lint when the tokenizer loses sync', () => {
    for (const broken of [
      'DO $$ BEGIN CREATE TABLE public.x (id uuid); END;',
      "SELECT 'unterminated;",
      '/* never closed',
      'SELECT "never closed;',
      'SELECT (1;',
      'SELECT 1);',
    ]) {
      const errors = lint(broken);
      expect(errors, broken).toHaveLength(1);
      expect(errors[0], broken).toMatch(/^02099_review_case\.sql: could not tokenize/);
    }
  });
});

describe('views and materialized views', () => {
  it('requires security_invoker on a new public view', () => {
    const definer = 'CREATE VIEW public.order_summaries AS SELECT o.id FROM public.orders o;\nGRANT SELECT ON public.order_summaries TO authenticated;';
    expect(lint(definer)).toEqual([expect.stringMatching(/view public\.order_summaries .*security_invoker/)]);
    for (const ok of [
      'CREATE VIEW public.v WITH (security_invoker = true) AS SELECT 1;',
      'CREATE OR REPLACE VIEW public.v WITH (security_barrier, security_invoker) AS SELECT 1;',
      "CREATE VIEW public.v WITH (security_invoker = 'on') AS SELECT 1;",
      'CREATE VIEW public.v AS SELECT 1;\nALTER VIEW public.v SET (security_invoker = true);',
    ]) {
      expect(lint(`${ok}\nGRANT SELECT ON public.v TO authenticated;`), ok).toEqual([]);
    }
    // other schemas are not exposed by the grant pass
    expect(lint('CREATE VIEW private.v AS SELECT 1;')).toEqual([]);
  });

  it('refuses turning security_invoker off on a public view', () => {
    expect(lint('ALTER VIEW public.some_view SET (security_invoker = false);')).toEqual([
      expect.stringMatching(/security_invoker = false on public\.some_view/),
    ]);
    expect(lint('ALTER VIEW public.some_view RESET (security_invoker);')).toHaveLength(1);
    expect(lint('CREATE VIEW public.v WITH (security_invoker = off) AS SELECT 1;\nGRANT SELECT ON public.v TO authenticated;')).toHaveLength(1);
  });

  it('refuses a public materialized view unless the file revokes it from the API roles', () => {
    const matview = 'CREATE MATERIALIZED VIEW public.customer_stats AS SELECT user_id, sum(total) FROM public.orders GROUP BY 1;';
    expect(lint(`${matview}\nGRANT SELECT ON public.customer_stats TO authenticated;`)).toEqual([
      expect.stringMatching(/materialized view public\.customer_stats .*API_ROLE_REVOKE_SQL/),
    ]);
    expect(
      lint(`${matview}\nREVOKE ALL ON public.customer_stats FROM PUBLIC, anon, authenticated;\nGRANT SELECT ON public.customer_stats TO service_role;`),
    ).toEqual([]);
  });
});

describe('RLS policies and row-security switches', () => {
  it('refuses a constant policy for anon, authenticated, PUBLIC or no TO at all', () => {
    for (const policy of [
      'CREATE POLICY "anon read orders" ON public.orders FOR SELECT TO anon USING (true);',
      'CREATE POLICY p ON public.orders FOR SELECT USING (true);',
      'CREATE POLICY p ON public.orders FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY p ON public.orders TO public USING (1 = 1);',
      'CREATE POLICY p ON public.orders FOR UPDATE TO authenticated USING ((TRUE)) WITH CHECK (auth.uid() = user_id);',
      "CREATE POLICY p ON orders FOR DELETE TO anon, authenticated USING ('a' = 'a');",
      'ALTER POLICY p ON public.orders USING (true);',
    ]) {
      expect(lint(policy), policy).toEqual([expect.stringMatching(/policy .* on public\.orders/)]);
    }
  });

  it('accepts real predicates, service_role, RESTRICTIVE, and reads of the public-read tables', () => {
    for (const policy of [
      'CREATE POLICY p ON public.orders FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));',
      'CREATE POLICY p ON public.orders FOR ALL TO service_role USING (true) WITH CHECK (true);',
      'CREATE POLICY p ON public.orders AS RESTRICTIVE FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY p ON public.orders FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));',
      'CREATE POLICY p ON public.languages FOR SELECT TO anon, authenticated USING (true);',
      'CREATE POLICY p ON private.audit FOR SELECT USING (true);',
    ]) {
      expect(lint(policy), policy).toEqual([]);
    }
    // the public-read allowlist covers reads only
    expect(lint('CREATE POLICY p ON public.languages FOR ALL TO authenticated USING (true);')).toHaveLength(1);
  });

  it('refuses DISABLE and NO FORCE ROW LEVEL SECURITY on public tables', () => {
    expect(lint('ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;')).toEqual([
      expect.stringMatching(/DISABLE ROW LEVEL SECURITY on public\.orders/),
    ]);
    expect(lint('ALTER TABLE IF EXISTS ONLY orders NO FORCE ROW LEVEL SECURITY;')).toHaveLength(1);
    const enableThenDisable =
      'CREATE TABLE public.w (id uuid); GRANT SELECT ON public.w TO authenticated; ALTER TABLE public.w ENABLE ROW LEVEL SECURITY; ALTER TABLE public.w DISABLE ROW LEVEL SECURITY;';
    expect(lint(enableThenDisable)).toHaveLength(1);
    expect(lint('ALTER TABLE private.audit DISABLE ROW LEVEL SECURITY;')).toEqual([]);
  });
});

describe('objects that reach public without CREATE TABLE, and role escalation', () => {
  it('refuses a top-level SELECT ... INTO a table, not the plpgsql variable form', () => {
    expect(lint('SELECT * INTO public.orders_backup FROM public.orders;')).toEqual([
      expect.stringMatching(/SELECT \.\.\. INTO creates public\.orders_backup/),
    ]);
    expect(lint('SELECT * INTO TABLE orders_backup FROM public.orders;')).toHaveLength(1);
    expect(lint('SELECT * INTO TEMP scratch FROM public.orders;')).toEqual([]);
    expect(lint("DO $$ DECLARE v_fr bigint; BEGIN SELECT id INTO v_fr FROM public.languages WHERE code = 'fr'; END $$;")).toEqual([]);
  });

  it('refuses SET SCHEMA public', () => {
    expect(lint('CREATE TABLE private.tmp_secrets (id uuid, token text); ALTER TABLE private.tmp_secrets SET SCHEMA public;')).toEqual([
      expect.stringMatching(/SET SCHEMA public/),
    ]);
    expect(lint('ALTER EXTENSION pg_net SET SCHEMA extensions;')).toEqual([]);
  });

  it('refuses role membership for the API roles and BYPASSRLS', () => {
    for (const sql of [
      'GRANT service_role TO anon;',
      'GRANT authenticated TO anon;',
      'CREATE ROLE web_writer NOLOGIN; GRANT INSERT, UPDATE, DELETE ON public.orders TO web_writer; GRANT web_writer TO authenticated;',
      'GRANT web_writer TO PUBLIC WITH ADMIN OPTION;',
      'ALTER ROLE authenticated BYPASSRLS;',
      'CREATE ROLE etl LOGIN BYPASSRLS;',
    ]) {
      expect(lint(sql), sql).toHaveLength(1);
    }
    expect(lint('GRANT web_writer TO service_role;')).toEqual([]);
    expect(lint('GRANT USAGE ON SCHEMA private TO authenticated;')).toEqual([]);
  });

  it('refuses CREATE on schema public for the API roles', () => {
    expect(lint('GRANT CREATE ON SCHEMA public TO anon, authenticated;')).toHaveLength(1);
    expect(lint('GRANT USAGE ON SCHEMA public TO anon, authenticated;')).toEqual([]);
  });

  it('requires SET search_path on a SECURITY DEFINER function in any schema', () => {
    expect(lint('CREATE FUNCTION private.helper() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;')).toEqual([
      expect.stringMatching(/SECURITY DEFINER function private\.helper\(\) .*search_path/),
    ]);
    expect(lint("CREATE FUNCTION private.helper() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;")).toEqual([]);
    expect(lint('CREATE FUNCTION private.helper() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$ SELECT true $$;')).toEqual([]);
    expect(lint('ALTER FUNCTION private.helper() SECURITY DEFINER;')).toHaveLength(1);
    expect(lint('ALTER FUNCTION private.helper() SECURITY DEFINER SET search_path = public;')).toEqual([]);
  });
});

describe('dynamic SQL', () => {
  it('lints the template of EXECUTE format(...) and EXECUTE literal || expression', () => {
    const definer =
      "DO $$ BEGIN EXECUTE 'CREATE FUNCTION public.admin_reset(uid uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS ''DELETE FROM public.orders WHERE user_id = uid'''; END $$;";
    expect(lint(definer).some((e) => /SECURITY DEFINER function public\.admin_reset/.test(e))).toBe(true);
    const table = "DO $$ DECLARE t text := 'leak'; BEGIN EXECUTE 'CREATE TABLE public.' || quote_ident(t) || ' (id uuid)'; END $$;";
    expect(lint(table).length).toBeGreaterThan(0);
    const viaFormat = "DO $$ BEGIN EXECUTE format('CREATE POLICY p ON public.%I FOR SELECT TO anon USING (true)', 'orders'); END $$;";
    expect(lint(viaFormat)).toHaveLength(1);
  });

  it('requires a reviewed marker on EXECUTE of a value the lint cannot read', () => {
    const opaque = "DO $$ DECLARE v_sql text := 'select 1'; BEGIN EXECUTE v_sql; END $$;";
    expect(lint(opaque)).toEqual([expect.stringMatching(/EXECUTE of a non-literal statement/)]);
    const reviewed =
      "DO $$ DECLARE v_sql text := 'select 1'; BEGIN\n  -- nb-lint: dynamic-sql reviewed: runs the SELECT built above, no DDL\n  EXECUTE v_sql;\nEND $$;";
    expect(lint(reviewed)).toEqual([]);
    // a marker without a reason does not count
    expect(lint('DO $$ BEGIN\n  -- nb-lint: dynamic-sql reviewed\n  EXECUTE v_sql;\nEND $$;')).toHaveLength(1);
  });

  it('is not confused by EXECUTE FUNCTION, GRANT EXECUTE or a top-level prepared statement', () => {
    expect(lint('CREATE TRIGGER t BEFORE INSERT ON private.audit FOR EACH ROW EXECUTE FUNCTION private.f();')).toEqual([]);
    expect(lint('GRANT EXECUTE ON FUNCTION private.f() TO service_role;')).toEqual([]);
    expect(lint('EXECUTE my_plan(1);')).toEqual([]);
  });
});

describe('functions are matched by signature', () => {
  const { findUnrevokedDefinerFunctions } = require('./lib/migration-grants.js');
  const definer = (args: string) =>
    `CREATE FUNCTION public.f(${args}) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;`;
  const revoke = (sig: string) => `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`;

  it('a revoke on another overload does not cover the definer function', () => {
    expect(findUnrevokedDefinerFunctions(`${definer('p uuid')}\n${revoke('public.f(text)')}`)).toHaveLength(1);
  });

  it('normalises argument names, modes, defaults and type aliases', () => {
    expect(findUnrevokedDefinerFunctions(`${definer('p_id uuid, p_at timestamptz DEFAULT now()')}\n${revoke('public.f(uuid, timestamp with time zone)')}`)).toEqual([]);
    expect(findUnrevokedDefinerFunctions(`${definer('IN n integer, OUT total bigint')}\n${revoke('f(int4)')}`)).toEqual([]);
    expect(findUnrevokedDefinerFunctions(`${definer('VARIADIC xs text[]')}\n${revoke('public.f(VARIADIC text[])')}`)).toEqual([]);
    expect(findUnrevokedDefinerFunctions(`${definer('"Weird" character varying(20)')}\n${revoke('public.f(varchar)')}`)).toEqual([]);
    // no argument list: the name must be unique, so it covers every overload
    expect(findUnrevokedDefinerFunctions(`${definer('p uuid')}\n${revoke('public.f')}`)).toEqual([]);
  });
});

describe('revokes the post-apply grant pass would undo (review cases)', () => {
  const { findRevokesUndoneByGrantPass, grantPassGuardProblems } = require('./lib/migration-grants.js');
  // review_widgets / export_orders do not exist: the real pass never lists them
  const undone = async (migration: string, mutate: (pass: string) => string = (p) => p) => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const files: Record<string, string> = { '02001_baseline_schema.sql': '', '02099_x.sql': migration };
    return findRevokesUndoneByGrantPass(Object.keys(files), (n: string) => files[n], mutate(GRANTS_SQL)).map(
      (p: { problem: string }) => p.problem,
    ) as string[];
  };
  const addToPass = (sql: string) => (pass: string) => pass.replace('end $nb_api$;', `${sql}\nend $nb_api$;`);

  it('sees a revoke after a dollar-quoted string with an apostrophe', async () => {
    const migration = [
      "UPDATE public.blocks SET content = jsonb_set(content, '{html_content}', to_jsonb($n$<p>L'outil</p>$n$)) WHERE false;",
      'REVOKE SELECT ON TABLE public.review_widgets FROM anon;',
      "UPDATE public.pages SET title = 'x' WHERE false;",
    ].join('\n');
    expect(await undone(migration)).toEqual([expect.stringMatching(/revokes SELECT on table public\.review_widgets from anon/)]);
  });

  it('sees a revoke built with EXECUTE format()', async () => {
    const migration =
      "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['review_widgets'] LOOP EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon', t); END LOOP; END $$;";
    expect(await undone(migration)).toEqual([expect.stringMatching(/revokes SELECT on table public\.%I \(dynamic\) from anon/)]);
  });

  it('accepts a dynamic revoke only when the pass runs the same block (02024 = nb_trg)', async () => {
    const triggerLoop = [
      'do $nb_trg$',
      'declare r record;',
      'begin',
      '  for r in',
      '    select p.oid::regprocedure as sig',
      '      from pg_proc p',
      '      join pg_type t on t.oid = p.prorettype',
      "     where p.pronamespace = 'public'::regnamespace and t.typname = 'trigger'",
      '  loop',
      "    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);",
      '  end loop;',
      'end $nb_trg$;',
    ].join('\n');
    expect(await undone(triggerLoop)).toEqual([]);
    const everyFunction = triggerLoop.replace(" and t.typname = 'trigger'", '');
    expect(await undone(everyFunction)).toEqual([
      expect.stringMatching(/revokes EXECUTE on function public\.%s \(dynamic\) from anon/),
      expect.stringMatching(/revokes EXECUTE on function public\.%s \(dynamic\) from authenticated/),
    ]);
  });

  it('a pass revoke of another overload does not count', async () => {
    const migration = 'REVOKE EXECUTE ON FUNCTION public.export_orders(uuid) FROM anon, authenticated;';
    const other = addToPass('  revoke execute on function public.export_orders(text) from public, anon, authenticated;');
    expect(await undone(migration, other)).toHaveLength(2);
    const same = addToPass('  revoke execute on function public.export_orders(uuid) from public, anon, authenticated;');
    expect(await undone(migration, same)).toEqual([]);
  });

  it("requires a pass entry's to_regprocedure / to_regclass guard to name what it revokes", async () => {
    const migration = 'REVOKE EXECUTE ON FUNCTION public.export_orders(uuid) FROM anon, authenticated;';
    const mismatched = addToPass(
      "  if to_regprocedure('public.export_orders(text)') is not null then\n    revoke execute on function public.export_orders(uuid) from public, anon, authenticated;\n  end if;",
    );
    const problems = await undone(migration, mismatched);
    expect(problems).toContainEqual(expect.stringMatching(/guard to_regprocedure\('public\.export_orders\(text\)'\) .*public\.export_orders\(uuid\)/));
    expect(problems).toContainEqual(expect.stringMatching(/^02099_x\.sql: revokes EXECUTE on function public\.export_orders\(uuid\) from anon/));
    const matched = addToPass(
      "  if to_regprocedure('public.export_orders(uuid)') is not null then\n    revoke execute on function public.export_orders(uuid) from public, anon, authenticated;\n  end if;",
    );
    expect(await undone(migration, matched)).toEqual([]);
    const wrongTable = addToPass(
      "  if to_regclass('public.review_widget') is not null then\n    revoke select on table public.review_widgets from anon;\n  end if;",
    );
    expect(await undone('REVOKE SELECT ON TABLE public.review_widgets FROM anon;', wrongTable)).toContainEqual(
      expect.stringMatching(/guard to_regclass\('public\.review_widget'\)/),
    );
  });

  it('a service-role-only table by omission needs its pass entry, and its USING (true) policy is refused', async () => {
    // The review's case: granted to neither anon nor authenticated, so nothing is revoked, and
    // a policy with no TO. findGrantsWidenedByGrantPass treats it as revoked from both roles.
    const { findGrantsWidenedByGrantPass } = require('./lib/migration-grants.js');
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    const serviceOnly = [
      'CREATE TABLE public.api_secrets (id uuid primary key, token text);',
      'ALTER TABLE public.api_secrets ENABLE ROW LEVEL SECURITY;',
      'GRANT ALL ON TABLE public.api_secrets TO service_role;',
      'CREATE POLICY "svc" ON public.api_secrets FOR ALL USING (true) WITH CHECK (true);',
    ].join('\n');
    const widened = (pass: string) => {
      const files: Record<string, string> = { '02001_baseline_schema.sql': '', '02099_x.sql': serviceOnly };
      return findGrantsWidenedByGrantPass(Object.keys(files), (n: string) => files[n], pass).map((p: { problem: string }) => p.problem);
    };
    expect(widened(GRANTS_SQL)).toEqual([
      expect.stringMatching(/public\.api_secrets without granting SELECT to anon/),
      expect.stringMatching(/public\.api_secrets without granting SELECT, INSERT, UPDATE, DELETE to authenticated/),
    ]);
    const listed = addToPass(
      "  if to_regclass('public.api_secrets') is not null then\n    revoke all on table public.api_secrets from public, anon, authenticated;\n  end if;",
    );
    expect(widened(listed(GRANTS_SQL))).toEqual([]);
    expect(lint(serviceOnly)).toEqual([expect.stringMatching(/policy svc on public\.api_secrets gives every role \(no TO clause\)/)]);
  });

  it('every guard in the real grant pass names the object it revokes', async () => {
    const { GRANTS_SQL } = await import('../../apps/nextblock/tools/lib/migrate-core.mjs');
    expect(grantPassGuardProblems(GRANTS_SQL)).toEqual([]);
  });
});
