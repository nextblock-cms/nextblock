// Explicit grants on every new table, view and sequence.
//
// Supabase grants nothing on objects created in `public` (changelog 45329: the default for
// projects created since 2026-05-30 and for every existing project from 2026-10-30; existing
// objects keep their grants). The baseline (02003) grants on every table and sequence it ships
// and the catch-up replays generation-1 files that carry their own, so the only way to lose
// the API on an object is a forward migration that creates one without granting on it in the
// same file. PostgREST then answers 42501 for that object whatever its policies say, and
// nothing in the repo notices until a user does. `npm run db:migrate:check` and the bundle
// generator refuse such a file. Rules + the rationale: docs/04 → "Row Level Security Patterns".
//
// Scope: CREATE TABLE / VIEW / MATERIALIZED VIEW / FOREIGN TABLE / SEQUENCE in `public`
// (schema-less names count as public), plus the implicit sequence of a serial or identity
// column. Not covered: ALTER TABLE ... ADD COLUMN ... serial, and DDL built with format().

const { isBaselineMigration, isCatchupMigration, parseMigrationName } = require('./migration-naming');

const API_ROLES = ['anon', 'authenticated', 'service_role', 'public'];
const ROLES_HINT = 'anon, authenticated, service_role';

/**
 * The SQL with comments removed and every string literal emptied, so `CREATE TABLE` inside
 * seed copy or a RAISE message is never mistaken for DDL. Dollar-quoted bodies stay: a DO
 * block that creates a table needs the grant like any other statement.
 */
function codeOnly(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'") {
      // E'...' strings use backslash escapes; plain strings only double the quote.
      const escaped = /[eE]$/.test(out);
      i += 1;
      while (i < n) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      out += "''";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** `CREATE [OR REPLACE] [UNLOGGED] <kind> [IF NOT EXISTS] [schema.]name` — TEMP tables are not matched. */
const CREATE_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(TABLE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;

const SERIAL_RE = /^(?:small|big)?serial[248]?\b/i;
const IDENTITY_RE = /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i;

/** Views and foreign tables are granted with the TABLE keyword (or none). */
function grantKind(kind) {
  return /SEQUENCE/i.test(kind) ? 'SEQUENCE' : 'TABLE';
}

function describe(kind) {
  return kind.toLowerCase().replace(/\s+/g, ' ');
}

/** The parenthesised column list that follows `CREATE TABLE ... name`, split at top-level commas. */
function columnDefinitions(code, from) {
  const open = code.indexOf('(', from);
  if (open === -1) return [];
  const semicolon = code.indexOf(';', from);
  if (semicolon !== -1 && semicolon < open) return [];
  const parts = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        parts.push(code.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Columns of a CREATE TABLE body whose type creates a sequence. */
function implicitSequenceColumns(code, from) {
  const columns = [];
  for (const definition of columnDefinitions(code, from)) {
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/is.exec(definition);
    if (!m) continue;
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/i.test(m[1])) continue;
    const type = m[2];
    if (SERIAL_RE.test(type) || IDENTITY_RE.test(type)) columns.push(m[1].toLowerCase());
  }
  return columns;
}

/**
 * Every GRANT in the code, as { kind, all, names, grantees }. `all` is set for
 * `ON ALL TABLES|SEQUENCES IN SCHEMA public`; names are lower-case and limited to public.
 */
function grants(code) {
  const out = [];
  for (const m of code.matchAll(/\bGRANT\b([^;]*)/gi)) {
    const body = m[1];
    const on = /\bON\s+/i.exec(body);
    const to = /\bTO\s+/i.exec(body);
    if (!on || !to || to.index < on.index) continue;
    const objects = body.slice(on.index + on[0].length, to.index).trim();
    const grantees = body
      .slice(to.index + to[0].length)
      .split(',')
      .map((g) => g.trim().replace(/^"|"$/g, '').toLowerCase());
    const all = /^ALL\s+(TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+"?public"?\s*$/i.exec(objects);
    if (all) {
      out.push({ kind: all[1].toUpperCase() === 'SEQUENCES' ? 'SEQUENCE' : 'TABLE', all: true, names: [], grantees });
      continue;
    }
    const keyword = /^(TABLE|SEQUENCE)\s+/i.exec(objects);
    const kind = keyword ? keyword[1].toUpperCase() : 'TABLE';
    const names = [];
    for (const raw of objects.slice(keyword ? keyword[0].length : 0).split(',')) {
      const name = /^\s*(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*$/i.exec(raw);
      if (!name) continue;
      if (name[1] && name[1].toLowerCase() !== 'public') continue;
      names.push(name[2].toLowerCase());
    }
    out.push({ kind, all: false, names, grantees });
  }
  return out;
}

function covered(allGrants, kind, name) {
  return allGrants.some(
    (g) => g.kind === kind && (g.all || g.names.includes(name)) && g.grantees.some((r) => API_ROLES.includes(r)),
  );
}

/**
 * Objects a migration creates in `public` without granting on them to an API role, as
 * [{ kind, name, problem }]. Empty when the file is fine.
 */
function findUngrantedObjects(sql) {
  const code = codeOnly(sql);
  const allGrants = grants(code);
  const problems = [];
  const seen = new Set();

  for (const match of code.matchAll(CREATE_RE)) {
    const kind = match[1].toUpperCase().replace(/\s+/g, ' ');
    const schema = match[2];
    const name = match[3].toLowerCase();
    if (schema && schema.toLowerCase() !== 'public') continue;
    const key = `${grantKind(kind)}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!covered(allGrants, grantKind(kind), name)) {
      problems.push({
        kind,
        name,
        problem: `${describe(kind)} public.${name} is created without a GRANT ... ON ${grantKind(kind)} public.${name} TO ${ROLES_HINT} in the same file`,
      });
    }

    if (kind === 'TABLE') {
      for (const column of implicitSequenceColumns(code, match.index)) {
        const sequence = `${name}_${column}_seq`;
        if (!covered(allGrants, 'SEQUENCE', sequence)) {
          problems.push({
            kind: 'SEQUENCE',
            name: sequence,
            problem: `table public.${name} column ${column} creates the sequence public.${sequence} (serial/identity) and the file does not GRANT USAGE, SELECT ON SEQUENCE public.${sequence} (or ON ALL SEQUENCES IN SCHEMA public) TO ${ROLES_HINT}`,
          });
        }
      }
    }
  }

  return problems;
}

/** Table names that the file turns row-level security ON for (ALTER TABLE ... ENABLE RLS). */
function rlsEnabledTables(code) {
  const names = new Set();
  for (const m of code.matchAll(
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
  )) {
    if (m[1] && m[1].toLowerCase() !== 'public') continue;
    names.add(m[2].toLowerCase());
  }
  return names;
}

/**
 * Tables a migration creates in `public` without enabling row-level security in the same file,
 * as [{ name, problem }]. RLS is the ONLY thing standing between the public key and a table's
 * rows (the grants above make the table reachable; without RLS + policies that reach is
 * unrestricted). Views/sequences/foreign tables are not row-secured and are not flagged.
 */
function findTablesWithoutRls(sql) {
  const code = codeOnly(sql);
  const enabled = rlsEnabledTables(code);
  const problems = [];
  const seen = new Set();
  for (const match of code.matchAll(CREATE_RE)) {
    const kind = match[1].toUpperCase().replace(/\s+/g, ' ');
    if (kind !== 'TABLE') continue;
    const schema = match[2];
    const name = match[3].toLowerCase();
    if (schema && schema.toLowerCase() !== 'public') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!enabled.has(name)) {
      problems.push({
        name,
        problem: `table public.${name} is created without ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY in the same file; a table reachable by the API roles with no RLS exposes every row to the public key`,
      });
    }
  }
  return problems;
}

/**
 * Lint every forward migration (sequence >= 005) in a directory listing. The catch-up and
 * the baseline are the generation's own business. `readFile(name)` returns the SQL.
 */
function validateMigrationGrants(files, readFile) {
  const errors = [];
  for (const file of files) {
    if (!parseMigrationName(file) || isCatchupMigration(file) || isBaselineMigration(file)) continue;
    const sql = readFile(file);
    for (const problem of findUngrantedObjects(sql)) {
      errors.push(`${file}: ${problem.problem}`);
    }
    for (const problem of findTablesWithoutRls(sql)) {
      errors.push(`${file}: ${problem.problem}`);
    }
  }
  return { errors };
}

module.exports = {
  codeOnly,
  findUngrantedObjects,
  findTablesWithoutRls,
  validateMigrationGrants,
};
