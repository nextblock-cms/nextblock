/**
 * Pure helpers for the SQL half of a full backup: which schemas pg_dump captures, how psql is
 * invoked, and how a plain-text dump is rewritten into a restore script that a hosted Supabase
 * project can actually apply.
 *
 * Why a rewrite is needed at all: the restore runs as the project's `postgres` role, which owns
 * the application schemas but neither owns `auth`/`storage`/`extensions` nor is a member of
 * `supabase_admin`. A verbatim `pg_dump --clean` therefore contains statements that can only
 * fail there (`DROP SCHEMA public`, `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin`, every
 * `auth.*` DDL in archives made before the dump was scoped). Because the restore now runs with
 * `ON_ERROR_STOP` in a single transaction, each of those would abort the whole restore instead
 * of failing silently as before, so they are removed structurally here (by pg_dump's own object
 * headers, never by guessing at SQL) and the rest is wrapped in a bracket that detaches and
 * re-attaches the cross-schema triggers (`auth.users` → `public.handle_new_user`) that would
 * otherwise block `DROP FUNCTION`.
 */

/** Schemas that belong to the application and that the restoring role can recreate. */
export const FULL_BACKUP_DUMP_SCHEMAS = ["public", "private", "supabase_migrations"] as const;

export interface DatabaseCommandTarget {
  host: string;
  port: string;
  dbName: string;
  user: string;
}

/** Object types that describe project-wide configuration rather than content. */
const TYPES_TO_DROP_EVERYWHERE = new Set(["DEFAULT ACL"]);

// "-- Name: foo; Type: TABLE; Schema: public; Owner: -" and
// "-- Data for Name: foo; Type: TABLE DATA; Schema: public; Owner: -"
const OBJECT_HEADER = /^-- (?:Data for )?Name: (.*); Type: ([^;]*); Schema: ([^;]*); Owner: (.*)$/;
const SCHEMA_ACL_NAME = /^SCHEMA "([^"]+)"$/;
const COPY_START = /^COPY .* FROM stdin;$/;
const COPY_END = /^\\\.$/;
const SESSION_SETTING = /^(SET ([a-z_]+) = .*;|SELECT pg_catalog\.set_config\(.*\);)$/;
/**
 * Session settings a newer pg_dump emits that an older server rejects ("unrecognized
 * configuration parameter"), which under ON_ERROR_STOP would abort the restore. Each is a
 * timeout whose dumped value (0) is the server default anyway.
 */
const VERSION_SPECIFIC_SETTINGS = new Set(["transaction_timeout"]);
const DROP_SCHEMA = /^DROP SCHEMA /;
const CREATE_SCHEMA = /^CREATE SCHEMA "([^"]+)";$/;
const OWNER_TO = /^ALTER .* OWNER TO "[^"]+";$/;
const DEFAULT_PRIVILEGES = /^ALTER DEFAULT PRIVILEGES .*;$/;
const SCHEMALESS_DROP = /^DROP (EXTENSION|PUBLICATION|SUBSCRIPTION|EVENT TRIGGER) /;
const FIRST_QUALIFIED_SCHEMA = /"([^"]+)"\."/;

export function buildPgDumpArgs(target: DatabaseCommandTarget, dumpFile: string) {
  return [
    "--clean",
    "--if-exists",
    "--quote-all-identifiers",
    // Objects are owned by whichever role restores them; the source's owner names are not
    // meaningful on another project.
    "--no-owner",
    "--no-publications",
    "--no-subscriptions",
    ...FULL_BACKUP_DUMP_SCHEMAS.flatMap((schema) => ["-n", schema]),
    "-h",
    target.host,
    "-U",
    target.user,
    "-p",
    target.port,
    "-d",
    target.dbName,
    "-f",
    dumpFile,
  ];
}

export function buildPsqlRestoreArgs(target: DatabaseCommandTarget, scriptFile: string) {
  return [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "--single-transaction",
    "-h",
    target.host,
    "-U",
    target.user,
    "-p",
    target.port,
    "-d",
    target.dbName,
    "-f",
    scriptFile,
  ];
}

export interface PreparedDump {
  sql: string;
  /** One entry per removed object or statement, for diagnostics. */
  removed: string[];
}

function stripCarriageReturn(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function shouldKeepObject(params: { name: string; type: string; schema: string; allowed: Set<string> }) {
  const { name, type, schema, allowed } = params;

  if (TYPES_TO_DROP_EVERYWHERE.has(type)) return false;

  if (schema === "-") {
    // `public` always exists and is owned by the database owner, so it is never recreated;
    // other application schemas are created IF NOT EXISTS by the rewrite below.
    if (type === "SCHEMA") return allowed.has(name) && name !== "public";
    // The USAGE grants on an application schema are part of what makes it reachable.
    if (type === "ACL") {
      const aclSchema = SCHEMA_ACL_NAME.exec(name);
      return Boolean(aclSchema && allowed.has(aclSchema[1]));
    }
    // Extensions, publications, event triggers, schema comments, …: project configuration.
    return false;
  }

  return allowed.has(schema);
}

/**
 * Rewrites a plain-text pg_dump so that it only touches the application schemas and only
 * contains statements the restoring role can execute. Data inside COPY blocks is passed through
 * untouched; every decision is made on pg_dump's object headers or on the single-line
 * `--clean` DROP statements that precede the first header.
 */
export function prepareDumpForRestore(
  dump: string,
  allowedSchemas: readonly string[] = FULL_BACKUP_DUMP_SCHEMAS
): PreparedDump {
  const allowed = new Set(allowedSchemas);
  const lines = dump.split("\n");
  const output: string[] = [];
  const removed: string[] = [];

  let inCopyData = false;
  let keepBlock = true;
  let sawHeader = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = stripCarriageReturn(raw);

    if (inCopyData) {
      if (keepBlock) output.push(raw);
      if (COPY_END.test(line)) inCopyData = false;
      continue;
    }

    if (line === "--" && index + 2 < lines.length) {
      const header = OBJECT_HEADER.exec(stripCarriageReturn(lines[index + 1]));
      if (header && stripCarriageReturn(lines[index + 2]) === "--") {
        const [, name, type, schema] = header;
        sawHeader = true;
        keepBlock = shouldKeepObject({ name, type, schema, allowed });
        if (keepBlock) {
          output.push(raw, lines[index + 1], lines[index + 2]);
        } else {
          removed.push(`${type} ${name}${schema === "-" ? "" : ` (schema ${schema})`}`);
        }
        index += 2;
        continue;
      }
    }

    if (COPY_START.test(line)) {
      inCopyData = true;
      if (keepBlock) output.push(raw);
      continue;
    }

    // pg_dump's session settings sit between objects; they must survive a dropped neighbour.
    const sessionSetting = SESSION_SETTING.exec(line);
    if (sessionSetting) {
      if (sessionSetting[2] && VERSION_SPECIFIC_SETTINGS.has(sessionSetting[2])) {
        removed.push(line);
      } else {
        output.push(raw);
      }
      continue;
    }

    if (!keepBlock) continue;

    if (!sawHeader) {
      // The --clean section: one DROP per line, schema-qualified except for schemas themselves.
      if (DROP_SCHEMA.test(line) || SCHEMALESS_DROP.test(line)) {
        removed.push(line);
        continue;
      }
      if (line.startsWith("DROP ")) {
        const schema = FIRST_QUALIFIED_SCHEMA.exec(line)?.[1];
        if (!schema || !allowed.has(schema)) {
          removed.push(line);
          continue;
        }
      }
      output.push(raw);
      continue;
    }

    const createSchema = CREATE_SCHEMA.exec(line);
    if (createSchema) {
      output.push(`CREATE SCHEMA IF NOT EXISTS "${createSchema[1]}";`);
      continue;
    }
    if (OWNER_TO.test(line) || DEFAULT_PRIVILEGES.test(line)) {
      removed.push(line);
      continue;
    }

    output.push(raw);
  }

  return { sql: output.join("\n"), removed };
}

/** Schemas outside the restorable set that a dump still carries DDL for (pre-scoping archives). */
export function dumpForeignSchemas(dump: string, allowedSchemas: readonly string[] = FULL_BACKUP_DUMP_SCHEMAS) {
  const allowed = new Set(allowedSchemas);
  const foreign = new Set<string>();
  for (const rawLine of dump.split("\n")) {
    const header = OBJECT_HEADER.exec(stripCarriageReturn(rawLine));
    if (header && header[3] !== "-" && !allowed.has(header[3])) {
      foreign.add(header[3]);
    }
  }
  return [...foreign].sort();
}

const SCHEMA_LIST_SQL = FULL_BACKUP_DUMP_SCHEMAS.map((schema) => `'${schema}'`).join(", ");

/**
 * Runs before the dump inside the restore transaction. Captures every trigger that lives on a
 * table outside the application schemas but fires a function inside them (the one NextBlock
 * ships is `auth.users` → `public.handle_new_user`), then detaches it so the dump's
 * `DROP FUNCTION` can succeed. The restoring role holds TRIGGER on `auth.users`; that is how the
 * baseline migration attaches the trigger in the first place.
 */
export const RESTORE_PREAMBLE_SQL = `-- NextBlock full restore: detach cross-schema triggers so in-scope functions can be replaced.
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TEMP TABLE nb_restore_triggers AS
  SELECT n.nspname AS table_schema,
         c.relname AS table_name,
         t.tgname AS trigger_name,
         pg_catalog.pg_get_triggerdef(t.oid) AS definition
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND n.nspname NOT IN (${SCHEMA_LIST_SQL})
    AND pn.nspname IN (${SCHEMA_LIST_SQL});
DO $nb_restore$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_temp.nb_restore_triggers LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', r.trigger_name, r.table_schema, r.table_name);
  END LOOP;
END $nb_restore$;
`;

/**
 * Runs after the dump inside the same transaction: re-attaches the captured triggers and
 * switches off authenticator-app (TOTP) enrolment for every restored account whose TOTP secret
 * does not exist on this project. Secrets live in `auth.mfa_factors`, which the GoTrue admin API
 * cannot recreate, so an account restored with `mfa_type = 'totp'` and no factor would be locked
 * out of the CMS at the second-factor prompt. Email codes need no auth-side state and are kept.
 */
export const RESTORE_POSTAMBLE_SQL = `-- NextBlock full restore: re-attach cross-schema triggers and reconcile TOTP enrolment.
DO $nb_restore$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_temp.nb_restore_triggers LOOP
    EXECUTE r.definition;
  END LOOP;
END $nb_restore$;
DROP TABLE IF EXISTS pg_temp.nb_restore_triggers;
DO $nb_restore$
BEGIN
  IF pg_catalog.to_regclass('public.user_security_settings') IS NOT NULL
     AND pg_catalog.to_regclass('auth.mfa_factors') IS NOT NULL THEN
    UPDATE public.user_security_settings s
       SET mfa_enabled = false, mfa_type = NULL, updated_at = pg_catalog.now()
     WHERE s.mfa_type = 'totp'
       AND NOT EXISTS (
         SELECT 1 FROM auth.mfa_factors f
          WHERE f.user_id = s.user_id AND f.factor_type = 'totp' AND f.status = 'verified'
       );
  END IF;
END $nb_restore$;
`;

/** `afterDumpSql` runs after the dump and before the postamble, inside the same transaction. */
export function buildRestoreScript(preparedDumpSql: string, afterDumpSql = "") {
  return `${RESTORE_PREAMBLE_SQL}\n${preparedDumpSql}\n${afterDumpSql}\n${RESTORE_POSTAMBLE_SQL}`;
}
