// Re-baseline transform (squash generations).
//
// Turns a pristine FRESH-APPLY pg_dump (schema.sql + data.sql) into the small idempotent
// baseline of a new squash generation, plus the catch-up file that replays the previous
// generation's forward migrations once on databases that sit behind.
//
//   node tools/scripts/rebaseline-transform.mjs <buildDir> <outDir> --generation <G> \
//        [--catchup-from <migrationsDir> --catchup-after <version>]
//
// Inputs (produced by pg_dump against a database where EVERY migration of the previous
// generation was applied, in order, from empty — never against prod):
//   <buildDir>/schema.sql   pg_dump -n public -s --no-owner ...
//   <buildDir>/data.sql     pg_dump -n public -a --column-inserts --on-conflict-do-nothing
//                           --exclude-table-data=public.profiles ...
//
// Outputs, named with the GGNNN scheme (GG = squash generation, NNN = sequence):
//   GG000_catchup_gen<G-1>.sql                 (with --catchup-from) previous generation's
//                                              forward migrations after --catchup-after,
//                                              replayed version-aware (see below)
//   GG001_baseline_schema.sql                  enums, functions, tables, sequences, defaults
//   GG002_baseline_constraints_and_indexes.sql PK / unique / check / FK + every index
//   GG003_baseline_security_and_grants.sql     RLS, policies, triggers, grants, auth trigger
//   GG004_baseline_seed.sql                    demo content, guarded to run on EMPTY dbs only
//
// Why the catch-up comes FIRST: a new generation gets NEW versions, so every file is pending
// on every existing database, including installs that sit behind the previous generation.
// The baseline DDL is idempotent only against the FINAL schema — `CREATE TABLE IF NOT EXISTS`
// skips an old-shape table and the next COMMENT / INDEX / constraint on a newer column fails
// (observed: cms_interactions.parent_id on a database stopped at generation-1 version 020).
// So the catch-up runs first and brings such a database to the end of the previous
// generation with the exact historical DDL; the baseline files are then no-ops. On a
// brand-new database the catch-up sees no schema at all and skips itself.
//
// Why the seed is guarded: unlike the 2026-07 squash (which reused the versions 000..003 that
// every database already had recorded, so the seed was invisible to existing installs), the
// seed is pending on every existing database too. The DDL files are safe to replay; the seed
// is not — its explicit-id INSERTs would re-create demo rows an operator deleted. So the seed
// runs only when the languages and site_settings tables are both empty, i.e. on a brand-new
// database, and then records the generation it was born at (site_settings row
// `migration_baseline_generation`), which is what tells the catch-up to stay out of the way.
//
// It never reorders statements (pg_dump already emits a valid dependency order); it only
// (a) buckets statements into files by kind, (b) adds idempotency guards, (c) re-attaches the
// auth.users trigger the public-only dump drops, (d) normalizes install-state seed rows, and
// (e) drops the Docker migration-runner's tracking table if the dump came from that stack.
// It never re-indents or reflows a statement: seed values contain multi-line string
// literals (theme CSS, HTML) and touching their whitespace changes the data.
//
// Full runbook: docs/04-DATABASE-AND-AUTH.md → "Squashing migrations (re-baseline runbook)".
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// --- args ---------------------------------------------------------------------
const positional = [];
const opts = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { opts[key] = next; i += 1; } else { opts[key] = true; }
  } else {
    positional.push(a);
  }
}
const [buildDir, outDir] = positional;
const generation = Number.parseInt(opts.generation ?? '', 10);
if (!buildDir || !outDir || !Number.isInteger(generation) || generation < 2 || generation > 99) {
  console.error('usage: node tools/scripts/rebaseline-transform.mjs <buildDir> <outDir> --generation <2..99> [--catchup-from <dir> --catchup-after <version>]');
  process.exit(2);
}
if ((opts['catchup-from'] && !opts['catchup-after']) || (!opts['catchup-from'] && opts['catchup-after'])) {
  console.error('--catchup-from and --catchup-after must be given together');
  process.exit(2);
}

const GG = String(generation).padStart(2, '0');
const version = (seq) => `${GG}${String(seq).padStart(3, '0')}`;

// LF everywhere. The repo stores LF (git) but Windows working trees check out CRLF
// (core.autocrlf=true), so a database migrated from such a checkout holds CRLF inside
// multi-line string literals (theme CSS, HTML); pg_dump carries those into the dump AND, on
// Windows, writes its own line breaks as CRLF, so a value's CR shows up as "\r\r\n". Every
// carriage return is a checkout artifact, never content: drop them all (a "\r\n?" → "\n"
// mapping would turn "\r\r\n" into a blank line — that corrupted a theme's CSS on the first
// build). The generated files are the git-canonical form; autocrlf re-adds CRLF on Windows
// checkouts, which keeps a catch-up's multi-line replace() patterns consistent with data that
// was seeded from the same checkout. The validation compare strips \r on both sides.
const lf = (s) => s.replace(/\r/g, '');
const schemaSql = lf(readFileSync(path.join(buildDir, 'schema.sql'), 'utf8'));
const dataSql = lf(readFileSync(path.join(buildDir, 'data.sql'), 'utf8'));

// Tables that describe an INSTALL rather than the product. Never part of a baseline.
const EXCLUDED_TABLES = ['_nextblock_docker_migrations'];
const EXCLUDED_DATA_TABLES = ['profiles', ...EXCLUDED_TABLES];

// --- dollar-quote / string / comment aware statement splitter -----------------
function splitStatements(sql) {
  const out = [];
  let i = 0, start = 0;
  let inLine = false, inBlock = false, inSingle = false, dollar = null;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (inLine) { if (sql[i] === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (two === '*/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; continue; } i++; continue; }
    if (two === '--') { inLine = true; i += 2; continue; }
    if (two === '/*') { inBlock = true; i += 2; continue; }
    if (sql[i] === "'") { inSingle = true; i++; continue; }
    if (sql[i] === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) { dollar = m[0]; i += m[0].length; continue; }
    }
    if (sql[i] === ';') { out.push(sql.slice(start, i + 1)); i++; start = i; continue; }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// Strip leading pg_dump "-- Name: ...; Type: ..." metadata + blank lines.
function stripLead(stmt) {
  const lines = stmt.split('\n');
  let k = 0;
  while (k < lines.length && (lines[k].trim() === '' || lines[k].trim().startsWith('--'))) k++;
  return lines.slice(k).join('\n').trim();
}

function mentionsExcludedTable(body, tables) {
  return tables.some((t) => new RegExp(`public\\.(?:"?)${t}(?:"?)\\b`).test(body));
}

// --- per-statement transforms -------------------------------------------------
function wrapEnum(body) {
  return `DO $rb$ BEGIN\n${body}\nEXCEPTION WHEN duplicate_object THEN null; END $rb$;`;
}
function guardConstraint(body) {
  const m = /^ALTER TABLE (?:ONLY )?public\.("?[A-Za-z0-9_]+"?)\s+ADD CONSTRAINT\s+("?[A-Za-z0-9_]+"?)/.exec(body);
  if (!m) return body;
  const table = m[1].replace(/"/g, '');
  const cname = m[2].replace(/"/g, '');
  return `DO $rb$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${cname}' AND conrelid = 'public.${table}'::regclass) THEN\n    ${body.replace(/\n/g, '\n    ')}\n  END IF;\nEND $rb$;`;
}
function dropBeforePolicy(body) {
  const m = /^CREATE POLICY\s+("[^"]+"|[A-Za-z0-9_]+)\s+ON\s+public\.([A-Za-z0-9_]+)/.exec(body);
  if (!m) return body;
  return `DROP POLICY IF EXISTS ${m[1]} ON public.${m[2]};\n${body}`;
}
function dropBeforeTrigger(body) {
  const m = /^CREATE TRIGGER\s+([A-Za-z0-9_]+)[\s\S]*?\sON\s+public\.([A-Za-z0-9_]+)/.exec(body);
  if (!m) return body;
  return `DROP TRIGGER IF EXISTS ${m[1]} ON public.${m[2]};\n${body}`;
}
function guardIdentity(body) {
  const m = /^ALTER TABLE (?:ONLY )?public\.([A-Za-z0-9_]+) ALTER COLUMN ([A-Za-z0-9_]+) ADD GENERATED/.exec(body);
  if (!m) return body;
  return `DO $rb$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.${m[1]}'::regclass AND attname = '${m[2]}' AND attidentity <> '') THEN\n    ${body.replace(/\n/g, '\n    ')}\n  END IF;\nEND $rb$;`;
}
function idempotentSetval(body) {
  // keep only "true" setvals (seeded tables); rewrite to MAX-based so replay never regresses.
  // PERFORM, not SELECT: the seed runs inside a PL/pgSQL DO block.
  const m = /setval\('public\.([A-Za-z0-9_]+)_id_seq'\s*,\s*\d+\s*,\s*(true|false)\)/.exec(body);
  if (!m) return null;
  if (m[2] === 'false') return null; // empty table — leave sequence at default
  const table = m[1];
  return `PERFORM pg_catalog.setval('public.${table}_id_seq', COALESCE((SELECT MAX(id) FROM public.${table}), 1), true);`;
}

const AUTH_TRIGGER = `-- Re-attached: trigger lives on auth.users, which a public-only pg_dump omits.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;`;

// --- classify + transform schema statements -----------------------------------
const files = { schema: [], constraints: [], security: [] };
const counts = { type: 0, function: 0, table: 0, sequence: 0, index: 0, constraint: 0, fk: 0, policy: 0, trigger: 0, rls: 0, grant: 0, comment: 0, identity: 0, dropped: 0, excluded: 0 };

for (const raw of splitStatements(schemaSql)) {
  const body = stripLead(raw);
  if (!body) continue;
  const head = body.replace(/\s+/g, ' ').toUpperCase();

  if (mentionsExcludedTable(body, EXCLUDED_TABLES)) { counts.excluded++; continue; }
  if (/^SET /.test(body)) { counts.dropped++; continue; }              // pg_dump session SETs (we add our own)
  if (/^SELECT PG_CATALOG\.SET_CONFIG/.test(head)) { counts.dropped++; continue; }
  if (/^CREATE SCHEMA /.test(head)) { files.schema.push(body.replace(/^CREATE SCHEMA /, 'CREATE SCHEMA IF NOT EXISTS ')); continue; }
  if (/^CREATE TYPE /.test(head)) { counts.type++; files.schema.push(wrapEnum(body)); continue; }
  if (/^CREATE (OR REPLACE )?FUNCTION /.test(head)) { counts.function++; files.schema.push(body.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ')); continue; }
  if (/^CREATE TABLE /.test(head)) { counts.table++; files.schema.push(body.replace(/^CREATE TABLE public\./, 'CREATE TABLE IF NOT EXISTS public.')); continue; }
  if (/^CREATE SEQUENCE /.test(head)) { counts.sequence++; files.schema.push(body.replace(/^CREATE SEQUENCE public\./, 'CREATE SEQUENCE IF NOT EXISTS public.')); continue; }
  if (/^ALTER SEQUENCE /.test(head)) { files.schema.push(body); continue; }         // OWNED BY — idempotent
  if (/^ALTER TABLE (ONLY )?PUBLIC\.[A-Z0-9_"]+ ALTER COLUMN .* ADD GENERATED .* AS IDENTITY/.test(head)) { counts.identity++; files.schema.push(guardIdentity(body)); continue; }
  if (/^ALTER TABLE (ONLY )?PUBLIC\.[A-Z0-9_"]+ ALTER COLUMN/.test(head)) { files.schema.push(body); continue; } // SET DEFAULT nextval — idempotent
  if (/^ALTER TABLE (ONLY )?PUBLIC\.[A-Z0-9_"]+ ADD CONSTRAINT/.test(head)) {
    if (/FOREIGN KEY/i.test(body)) counts.fk++; else counts.constraint++;
    files.constraints.push(guardConstraint(body)); continue;
  }
  if (/^CREATE (UNIQUE )?INDEX /.test(head)) {
    counts.index++;
    files.constraints.push(body.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ').replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS '));
    continue;
  }
  if (/ENABLE ROW LEVEL SECURITY/.test(head)) { counts.rls++; files.security.push(body); continue; }
  if (/^CREATE POLICY /.test(head)) { counts.policy++; files.security.push(dropBeforePolicy(body)); continue; }
  if (/^CREATE TRIGGER /.test(head)) { counts.trigger++; files.security.push(dropBeforeTrigger(body)); continue; }
  if (/^(GRANT |REVOKE )/.test(head)) { counts.grant++; files.security.push(body); continue; }
  if (/^COMMENT ON /.test(head)) {
    counts.comment++;
    if (/^COMMENT ON (POLICY)/.test(head)) files.security.push(body);
    else if (/^COMMENT ON (CONSTRAINT|INDEX)/.test(head)) files.constraints.push(body);
    else files.schema.push(body);
    continue;
  }
  if (/^ALTER TABLE .* OWNER TO /.test(head)) { counts.dropped++; continue; }
  if (/^ALTER DEFAULT PRIVILEGES/.test(head)) { counts.dropped++; continue; }  // Supabase platform defaults (not NextBlock schema; supabase_admin-owned)
  // Anything unrecognized: keep in schema verbatim so nothing is silently lost, and flag it.
  files.schema.push(body);
  console.error('UNCLASSIFIED (kept in schema):', head.slice(0, 120));
}

files.security.push(AUTH_TRIGGER);

// --- seed transform -----------------------------------------------------------
const seed = [];
for (const raw of splitStatements(dataSql)) {
  const body = stripLead(raw);
  if (!body) continue;
  const head = body.replace(/\s+/g, ' ').toUpperCase();
  if (/^SET /.test(body) || /^SELECT PG_CATALOG\.SET_CONFIG/.test(head)) { continue; }
  if (mentionsExcludedTable(body, EXCLUDED_DATA_TABLES)) { counts.excluded++; continue; }
  if (/SETVAL\(/.test(head)) { const s = idempotentSetval(body); if (s) seed.push(s); continue; }
  if (/^INSERT INTO PUBLIC\.SITE_SETTINGS/.test(head) && /'IS_ADMIN_CREATED'/.test(head)) {
    // Install state, not product content: the first admin sign-up flips it.
    seed.push(`INSERT INTO public.site_settings (key, value) VALUES ('is_admin_created', 'false') ON CONFLICT DO NOTHING;`);
    continue;
  }
  if (/^INSERT INTO PUBLIC\.SYSTEM_CONFIGURATION/.test(head)) {
    seed.push(`INSERT INTO public.system_configuration (id, auto_accept_signups, settings) VALUES (1, false, '{}'::jsonb) ON CONFLICT DO NOTHING;`);
    continue;
  }
  if (/^INSERT INTO /.test(head)) { seed.push(body); continue; }
  // ignore anything else (comments already stripped)
}

// The generation marker: a site_settings row that says which squash generation a database
// was BORN at (written by the seed) or has been CAUGHT UP to (written by the catch-up).
// The catch-up skips itself entirely when the marker is already >= this generation.
const MARKER_KEY = 'migration_baseline_generation';
const markerUpsert = (indent) =>
  `${indent}INSERT INTO public.site_settings (key, value) VALUES ('${MARKER_KEY}', '${generation}'::jsonb)\n${indent}  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`;

const SEED_TAG = '$nb_baseline_seed$';
if (seed.some((s) => s.includes(SEED_TAG) || s.includes(`'${MARKER_KEY}'`))) {
  console.error(`seed content contains the dollar-quote tag ${SEED_TAG} or the marker key; adjust the transform`);
  process.exit(1);
}
const seedBlock = `-- Guard: the seed runs ONLY on an empty database. Every existing install (prod, sandbox,
-- downstream) has languages + site_settings rows, so this whole block is a no-op there — the
-- explicit-id INSERTs below must never re-create demo rows an operator deleted.
DO ${SEED_TAG}
BEGIN
  IF EXISTS (SELECT 1 FROM public.languages) OR EXISTS (SELECT 1 FROM public.site_settings) THEN
    RAISE NOTICE 'baseline seed skipped: database already holds content';
    RETURN;
  END IF;

${seed.join('\n')}

  -- Born at generation ${generation}: the catch-up file has nothing to replay here.
${markerUpsert('  ')}
END
${SEED_TAG};`;

// --- catch-up (previous generation's forward migrations, verbatim) ---------------
let catchup = null;
if (opts['catchup-from']) {
  const dir = opts['catchup-from'];
  const after = String(opts['catchup-after']);
  const names = readdirSync(dir)
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .sort()
    .filter((n) => n.split('_')[0] > after);
  if (names.length === 0) {
    console.error(`no migrations after ${after} in ${dir}`);
    process.exit(1);
  }
  // Each retired file is replayed ONLY if its version is not already recorded. A verbatim
  // replay is wrong by design: a migration whose guard is "insert unless X exists" fires
  // again once a later migration removed X (006's home promo), and copy-fix chains
  // (021..024) re-apply on content a later step rewrote. Both were observed on a replay
  // over a fully migrated database during the generation-2 build. Version-aware replay is
  // exactly what a normal update would have done, so it converges without drift.
  const parts = names.map((n) => {
    const ver = n.split('_')[0];
    const stem = n.replace(/\.sql$/, '');
    const tag = `$nb_file_${ver}$`;
    const sql = lf(readFileSync(path.join(dir, n), 'utf8'))
      // Runs inside PL/pgSQL EXECUTE, where transaction control is an error (and the applier
      // wraps the whole file in one transaction anyway).
      .replace(/^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$/gim, '-- (transaction control stripped for the catch-up: the applier wraps this file in one transaction)');
    if (sql.includes(tag)) { console.error(`${n} contains its own wrapper tag ${tag}`); process.exit(1); }
    return `  -- >>> FROM: ${n}
  IF NOT pg_temp.nb_recorded('${ver}', '${stem}') THEN
    RAISE NOTICE 'catch-up: applying ${n}';
    EXECUTE ${tag}
${sql.trim()}
${tag};
  ELSE
    RAISE NOTICE 'catch-up: ${n} already recorded, skipped';
  END IF;
  -- <<< END: ${n}`;
  });
  // Applied-version registries. The Supabase CLI, the /setup wizard, the build hook and
  // `npm run update` all record in supabase_migrations.schema_migrations; the Docker
  // migration runner records file stems in public._nextblock_docker_migrations. Either
  // table may be absent, hence to_regclass + EXECUTE instead of static references. The
  // helper lives in pg_temp (session-scoped, never part of the schema) and must be called
  // schema-qualified: Postgres never resolves unqualified function names through pg_temp.
  const helper = `-- Registry lookup helper (session-scoped; dropped again at the end of this file).
CREATE OR REPLACE FUNCTION pg_temp.nb_recorded(p_version text, p_stem text) RETURNS boolean
LANGUAGE plpgsql AS $nb_helper$
DECLARE v boolean := false;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1)' INTO v USING p_version;
    IF v THEN RETURN true; END IF;
  END IF;
  IF to_regclass('public._nextblock_docker_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public._nextblock_docker_migrations WHERE version = $1)' INTO v USING p_stem;
    IF v THEN RETURN true; END IF;
  END IF;
  RETURN false;
END $nb_helper$;`;
  catchup = {
    from: names[0].split('_')[0],
    through: names[names.length - 1].split('_')[0],
    count: names.length,
    sql: `${helper}

DO $nb_catchup$
DECLARE
  v_generation int;
BEGIN
  -- Brand-new database (no schema yet): the baseline files that follow create everything.
  IF to_regclass('public.site_settings') IS NULL THEN
    RAISE NOTICE 'catch-up skipped: empty database, the baseline follows';
    RETURN;
  END IF;

  -- Born at (or already caught up to) this generation: nothing to replay.
  EXECUTE $nb_q$SELECT (value #>> '{}')::int FROM public.site_settings WHERE key = $1$nb_q$
    INTO v_generation USING '${MARKER_KEY}';
  IF v_generation IS NOT NULL AND v_generation >= ${generation} THEN
    RAISE NOTICE 'catch-up skipped: database is already at squash generation ${generation}';
    RETURN;
  END IF;

${parts.join('\n\n')}

  -- Caught up: record the generation so this file never replays anything again.
${markerUpsert('  ')}
END $nb_catchup$;

DROP FUNCTION IF EXISTS pg_temp.nb_recorded(text, text);`,
  };
}

// --- write files --------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const range = catchup ? `${'0'.repeat(14)}..${catchup.through}` : 'the previous generation';
const banner = (title) => `-- AUTO-GENERATED baseline: squash generation ${generation} (of migrations ${range}).
-- ${title}
-- Idempotent; safe to replay. Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.
-- Naming: GGNNN_name.sql (GG = squash generation, NNN = sequence). See docs/04-DATABASE-AND-AUTH.md.

`;

const f1 = `${banner('001 · schema: enums, functions, tables, sequences, defaults')}SET check_function_bodies = false;\n\n${files.schema.join('\n\n')}\n`;
const f2 = `${banner('002 · constraints (PK / unique / check / FK) + indexes')}${files.constraints.join('\n\n')}\n`;
const f3 = `${banner('003 · row-level security, policies, triggers, grants')}${files.security.join('\n\n')}\n`;
const f4 = `${banner('004 · seed: canonical NextBlock demo content (no users, no secrets) — empty databases only')}${seedBlock}\n`;

const written = [];
const write = (seq, name, body) => {
  const file = `${version(seq)}_${name}.sql`;
  writeFileSync(path.join(outDir, file), body);
  written.push(file);
};

if (catchup) {
  const f0 = `-- AUTO-GENERATED catch-up for squash generation ${generation}: replays generation ${generation - 1}'s forward migrations.
-- catchup-from: ${catchup.from}
-- catchup-through: ${catchup.through}
-- files: ${catchup.count}
--
-- Slot 000 of the generation, so it runs BEFORE the baseline: a database that sat behind the
-- previous generation is brought to its end with the exact historical DDL, and the baseline
-- files that follow are then no-ops. Each retired file below runs only if its version is not
-- recorded in supabase_migrations.schema_migrations (or, for Docker installs, its file stem in
-- public._nextblock_docker_migrations) — exactly what a normal update would have applied.
-- The whole file is skipped on an empty database (the baseline creates everything) and on a
-- database whose site_settings.${MARKER_KEY} is already >= ${generation}.
-- A database at exactly catchup-through may record this version as applied without running it
-- (npm run db:migrate:repair-history -- --reconcile-squash).
-- Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.

${catchup.sql}
`;
  write(0, `catchup_gen${generation - 1}`, f0);
}
write(1, 'baseline_schema', f1);
write(2, 'baseline_constraints_and_indexes', f2);
write(3, 'baseline_security_and_grants', f3);
write(4, 'baseline_seed', f4);

console.log('== object counts (from schema dump) ==');
console.log(JSON.stringify(counts));
console.log('seed INSERTs:', seed.filter((s) => s.startsWith('INSERT')).length, '| setvals kept:', seed.filter((s) => s.includes('setval')).length);
console.log('files:', written.join(', '));
console.log('file sizes (lines):', catchup ? `catch-up ${catchup.sql.split('\n').length} + ` : '', [f1, f2, f3, f4].map((f) => f.split('\n').length).join(', '));
