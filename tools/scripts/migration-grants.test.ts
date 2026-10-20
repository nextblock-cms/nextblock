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
