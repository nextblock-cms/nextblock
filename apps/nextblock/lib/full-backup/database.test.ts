import { describe, expect, it } from "vitest";

import {
  FULL_BACKUP_DUMP_SCHEMAS,
  RESTORE_POSTAMBLE_SQL,
  RESTORE_PREAMBLE_SQL,
  buildPgDumpArgs,
  buildPsqlRestoreArgs,
  buildRestoreScript,
  dumpForeignSchemas,
  prepareDumpForRestore,
} from "./database";

const target = { host: "db.example.supabase.co", port: "5432", dbName: "postgres", user: "postgres" };

function block(name: string, type: string, schema: string, body: string, owner = "-") {
  return ["--", `-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: ${owner}`, "--", "", body, "", ""].join("\n");
}

function dataBlock(table: string, schema: string, rows: string[]) {
  return [
    "--",
    `-- Data for Name: ${table}; Type: TABLE DATA; Schema: ${schema}; Owner: -`,
    "--",
    "",
    `COPY "${schema}"."${table}" ("id", "value") FROM stdin;`,
    ...rows,
    "\\.",
    "",
    "",
  ].join("\n");
}

const PREAMBLE = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "SET statement_timeout = 0;",
  "SET transaction_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "SET row_security = off;",
  "",
].join("\n");

describe("pg_dump / psql invocation", () => {
  it("scopes the dump to the application schemas and drops ownership", () => {
    const args = buildPgDumpArgs(target, "/tmp/dump.sql");

    expect(args).toContain("--clean");
    expect(args).toContain("--if-exists");
    expect(args).toContain("--no-owner");
    expect(args).toContain("--no-publications");
    for (const schema of FULL_BACKUP_DUMP_SCHEMAS) {
      expect(args).toContain(schema);
    }
    // auth/storage/extensions are owned by Supabase roles and must never be dumped as DDL.
    expect(args.filter((arg) => arg === "-n")).toHaveLength(FULL_BACKUP_DUMP_SCHEMAS.length);
    expect(args).not.toContain("auth");
    expect(args.slice(-2)).toEqual(["-f", "/tmp/dump.sql"]);
  });

  it("restores in one transaction and stops on the first error", () => {
    const args = buildPsqlRestoreArgs(target, "/tmp/restore.sql");

    expect(args).toContain("--single-transaction");
    expect(args.join(" ")).toContain("-v ON_ERROR_STOP=1");
    expect(args).toContain("-X");
    expect(args.slice(-2)).toEqual(["-f", "/tmp/restore.sql"]);
  });
});

describe("prepareDumpForRestore", () => {
  it("removes schema-level statements the restoring role cannot or must not run", () => {
    const dump = [
      PREAMBLE,
      'DROP TABLE IF EXISTS "public"."pages";',
      'DROP FUNCTION IF EXISTS "private"."bump"("p_user_id" "uuid");',
      'DROP SCHEMA IF EXISTS "supabase_migrations";',
      'DROP SCHEMA IF EXISTS "public";',
      'DROP SCHEMA IF EXISTS "private";',
      "",
      block("private", "SCHEMA", "-", 'CREATE SCHEMA "private";'),
      block("public", "SCHEMA", "-", 'CREATE SCHEMA "public";'),
      block('SCHEMA "public"', "COMMENT", "-", "COMMENT ON SCHEMA \"public\" IS 'standard public schema';"),
      block("supabase_migrations", "SCHEMA", "-", 'CREATE SCHEMA "supabase_migrations";'),
      block("pages", "TABLE", "public", 'CREATE TABLE "public"."pages" (\n    "id" bigint NOT NULL\n);\n\nALTER TABLE "public"."pages" OWNER TO "postgres";'),
      block('SCHEMA "public"', "ACL", "-", 'GRANT USAGE ON SCHEMA "public" TO "anon";'),
      block('SCHEMA "private"', "ACL", "-", 'GRANT USAGE ON SCHEMA "private" TO "authenticated";'),
      block("DEFAULT PRIVILEGES FOR SEQUENCES", "DEFAULT ACL", "public", 'ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";', "supabase_admin"),
      block("DEFAULT PRIVILEGES FOR TABLES", "DEFAULT ACL", "public", 'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";', "postgres"),
    ].join("\n");

    const { sql, removed } = prepareDumpForRestore(dump);

    expect(sql).not.toMatch(/^DROP SCHEMA/m);
    expect(sql).not.toContain('CREATE SCHEMA "public";');
    expect(sql).not.toContain("COMMENT ON SCHEMA");
    expect(sql).not.toContain("ALTER DEFAULT PRIVILEGES");
    expect(sql).not.toContain("OWNER TO");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "private";');
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "supabase_migrations";');
    expect(sql).toContain('DROP TABLE IF EXISTS "public"."pages";');
    expect(sql).toContain('DROP FUNCTION IF EXISTS "private"."bump"("p_user_id" "uuid");');
    expect(sql).toContain('CREATE TABLE "public"."pages"');
    expect(sql).toContain('GRANT USAGE ON SCHEMA "public" TO "anon";');
    expect(sql).toContain('GRANT USAGE ON SCHEMA "private" TO "authenticated";');
    expect(sql).toContain("SELECT pg_catalog.set_config('search_path', '', false);");
    expect(sql).toContain("SET statement_timeout = 0;");
    // pg_dump 17 emits this even against a Postgres 15 server, which does not know it.
    expect(sql).not.toContain("transaction_timeout");
    expect(removed).toEqual(
      expect.arrayContaining([
        'DROP SCHEMA IF EXISTS "public";',
        "SCHEMA public",
        'COMMENT SCHEMA "public"',
        "DEFAULT ACL DEFAULT PRIVILEGES FOR SEQUENCES (schema public)",
        'ALTER TABLE "public"."pages" OWNER TO "postgres";',
      ])
    );
  });

  it("drops every object outside the application schemas from a pre-scoping archive", () => {
    const dump = [
      PREAMBLE,
      'DROP TABLE IF EXISTS "auth"."users";',
      'DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";',
      'DROP POLICY IF EXISTS "pages_read" ON "public"."pages";',
      'DROP EXTENSION IF EXISTS "pgcrypto";',
      'DROP TABLE IF EXISTS "public"."pages";',
      "",
      block("auth", "SCHEMA", "-", 'CREATE SCHEMA "auth";', "supabase_admin"),
      block("pgcrypto", "EXTENSION", "-", 'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";'),
      block("users", "TABLE", "auth", 'CREATE TABLE "auth"."users" (\n    "id" "uuid" NOT NULL\n);', "supabase_auth_admin"),
      block("pages", "TABLE", "public", 'CREATE TABLE "public"."pages" (\n    "id" bigint NOT NULL\n);'),
      "SET default_tablespace = '';",
      "",
      block("objects", "TABLE", "storage", 'CREATE TABLE "storage"."objects" (\n    "id" "uuid" NOT NULL\n);', "supabase_storage_admin"),
      dataBlock("users", "auth", ["1\tDROP SCHEMA IF EXISTS \"public\";"]),
      dataBlock("pages", "public", ["1\tHome", "2\tCREATE SCHEMA \"public\";"]),
      block("users on_auth_user_created", "TRIGGER", "auth", 'CREATE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();', "supabase_auth_admin"),
      block("supabase_realtime", "PUBLICATION", "-", 'CREATE PUBLICATION "supabase_realtime" WITH (publish = \'insert, update, delete, truncate\');'),
    ].join("\n");

    const { sql } = prepareDumpForRestore(dump);

    expect(sql).not.toContain('"auth"."users"');
    expect(sql).not.toContain('"storage"."objects"');
    expect(sql).not.toContain("CREATE EXTENSION");
    expect(sql).not.toContain("CREATE PUBLICATION");
    expect(sql).not.toContain("on_auth_user_created");
    expect(sql).toContain('DROP POLICY IF EXISTS "pages_read" ON "public"."pages";');
    expect(sql).toContain('DROP TABLE IF EXISTS "public"."pages";');
    expect(sql).toContain('CREATE TABLE "public"."pages"');
    // Data rows are never inspected: a row that looks like a schema statement survives intact.
    expect(sql).toContain('COPY "public"."pages" ("id", "value") FROM stdin;\n1\tHome\n2\tCREATE SCHEMA "public";\n\\.');
    // A session setting between two objects survives a dropped neighbour.
    expect(sql).toContain("SET default_tablespace = '';");
    expect(dumpForeignSchemas(dump)).toEqual(["auth", "storage"]);
  });

  it("reports no foreign schema for a scoped dump and keeps CRLF line endings intact", () => {
    const dump = [PREAMBLE, 'DROP TABLE IF EXISTS "public"."pages";', "", block("pages", "TABLE", "public", 'CREATE TABLE "public"."pages" ();')]
      .join("\n")
      .replace(/\n/g, "\r\n");

    const { sql } = prepareDumpForRestore(dump);

    expect(dumpForeignSchemas(dump)).toEqual([]);
    expect(sql).toContain('DROP TABLE IF EXISTS "public"."pages";\r\n');
    expect(sql).toContain('CREATE TABLE "public"."pages" ();');
  });
});

describe("buildRestoreScript", () => {
  it("brackets the dump with the trigger detach/re-attach and the TOTP reconciliation", () => {
    const script = buildRestoreScript("SELECT 1;");

    expect(script.indexOf(RESTORE_PREAMBLE_SQL)).toBe(0);
    expect(script.indexOf("SELECT 1;")).toBeGreaterThan(script.indexOf("DROP TRIGGER IF EXISTS %I ON %I.%I"));
    expect(script.indexOf(RESTORE_POSTAMBLE_SQL)).toBeGreaterThan(script.indexOf("SELECT 1;"));
    expect(RESTORE_PREAMBLE_SQL).toContain("pg_get_triggerdef");
    expect(RESTORE_POSTAMBLE_SQL).toContain("EXECUTE r.definition;");
    expect(RESTORE_POSTAMBLE_SQL).toContain("mfa_type = 'totp'");
    expect(RESTORE_POSTAMBLE_SQL).toContain("auth.mfa_factors");
  });
});
