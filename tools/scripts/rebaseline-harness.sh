#!/bin/sh
# Throwaway-database harness for a migration squash (docs/04 → "Squashing migrations").
# POSIX sh; run from Git Bash on Windows or any shell on Linux/macOS. Needs Docker Desktop,
# psql and pg_dump (17) on PATH, and node.
#
#   tools/scripts/rebaseline-harness.sh init <workdir> [port]   write <workdir>/.env for the stack
#   tools/scripts/rebaseline-harness.sh up <workdir>            fresh db + auth (drops volumes first)
#   tools/scripts/rebaseline-harness.sh apply <workdir> [--record supabase|docker|none] <file...>
#   tools/scripts/rebaseline-harness.sh dump <workdir> <label>  schema/data/counts into <workdir>/<label>/
#   tools/scripts/rebaseline-harness.sh cmp <workdir> <labelA> <labelB>
#   tools/scripts/rebaseline-harness.sh lf <workdir> <srcDir> <dstDir>     LF-normalized copies (git-canonical)
#   tools/scripts/rebaseline-harness.sh down <workdir>
#
# Always apply LF-normalized copies, never the working tree as-is: with core.autocrlf=true the
# tree mixes CRLF (git checkouts) and LF (tool-written files), and a multi-line replace()
# pattern only matches content seeded with the same line endings (building generation 2 from
# the raw tree silently lost migration 042's copy change).
#
# Typical generation-G build, with M = libs/db/src/supabase/migrations (the CURRENT generation):
#   init W; lf W $M W/old
#   up W; apply W W/old/*.sql; dump W old_fresh
#   node tools/scripts/rebaseline-transform.mjs W/old_fresh W/new --generation G --catchup-from W/old --catchup-after <old seed version>
#   up W; apply W W/new/*.sql; dump W new_fresh; cmp W old_fresh new_fresh
#   apply W --record none W/new/*.sql; dump W new_twice; cmp W new_fresh new_twice
#   up W; apply W $(ls W/old/*.sql | head -21); apply W W/new/*.sql; dump W up20; cmp W old_fresh up20
#   up W; apply W W/old/*.sql; apply W W/new/*.sql; dump W up_full; cmp W old_fresh up_full
#   up W; apply W --record docker $(ls W/old/*.sql | head -31); apply W --record docker W/new/*.sql; dump W up30_docker; cmp W old_fresh up30_docker
#   down W
# Expected: schema identical everywhere; data identical except the migration_baseline_generation row.
set -eu

cmd="${1:-}"; W="${2:-}"
[ -n "$cmd" ] && [ -n "$W" ] || { sed -n 2,25p "$0"; exit 2; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT=nbsquash

pgenv() {
  PGHOST=127.0.0.1; PGUSER=postgres; PGDATABASE=postgres; PGCLIENTENCODING=UTF8
  PGPORT="$(grep '^POSTGRES_PORT_EXTERNAL=' "$W/.env" | cut -d= -f2)"
  PGPASSWORD="$(grep '^POSTGRES_PASSWORD=' "$W/.env" | cut -d= -f2)"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGCLIENTENCODING
}

compose() { (cd "$REPO" && docker compose -p "$PROJECT" --env-file "$W/.env" -f docker-compose.yml "$@" 2>&1 | grep -v 'variable is not set' || true); }

case "$cmd" in
  init)
    mkdir -p "$W"
    port="${3:-15432}"   # 54329 is inside a Hyper-V reserved range on some Windows machines
    cat > "$W/.env" <<EOF
POSTGRES_PASSWORD=nbsquash_pw
POSTGRES_DB=postgres
JWT_SECRET=nbsquash-throwaway-jwt-secret-0123456789abcdefghij
JWT_EXP=3600
POSTGRES_PORT_EXTERNAL=$port
ANON_KEY=unused
SERVICE_ROLE_KEY=unused
API_EXTERNAL_URL=http://localhost:8000
SITE_URL=http://localhost:3000
GOTRUE_MAILER_AUTOCONFIRM=true
MINIO_ROOT_USER=unused
MINIO_ROOT_PASSWORD=unusedunused
STORAGE_BUCKET=unused
EOF
    echo "wrote $W/.env (port $port)";;

  up)
    compose down -v | tail -1
    compose up -d db auth | tail -1
    pgenv
    i=0
    while [ "$(psql -tAc "select to_regclass('auth.users') is not null;" 2>/dev/null || true)" != "t" ]; do
      i=$((i+1)); [ $i -le 90 ] || { echo "timeout waiting for auth.users"; exit 1; }; sleep 2
    done
    echo "fresh stack ready (auth.users present after ${i}x2s)";;

  apply)
    pgenv; shift 2
    mode=supabase
    if [ "${1:-}" = "--record" ]; then mode="$2"; shift 2; fi
    case "$mode" in
      supabase) psql -q -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);";;
      docker) psql -q -c "create table if not exists public._nextblock_docker_migrations (version text primary key, applied_at timestamptz not null default now());";;
    esac
    n=0
    for f in "$@"; do
      out="$(psql -v ON_ERROR_STOP=1 -q -1 -f "$f" 2>&1)" || { echo "FAILED: $f"; echo "$out" | tail -20; exit 1; }
      echo "$out" | grep -i "error\|warning\|catch-up\|baseline seed" | grep -v "already a transaction\|no transaction in progress" | head -8 || true
      b="$(basename "$f")"; v="${b%%_*}"
      case "$mode" in
        supabase) psql -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$b') on conflict do nothing;";;
        docker) psql -q -c "insert into public._nextblock_docker_migrations (version) values ('${b%.sql}') on conflict do nothing;";;
      esac
      n=$((n+1))
    done
    echo "applied $n file(s) [record=$mode]";;

  dump)
    pgenv; D="$W/$3"; mkdir -p "$D"
    pg_dump -n public -s --no-owner --no-tablespaces --no-security-labels --no-publications --no-subscriptions \
      -T 'public._nextblock_docker_migrations' > "$D/schema.sql"
    pg_dump -n public -a --column-inserts --on-conflict-do-nothing --no-owner \
      --exclude-table-data=public.profiles -T 'public._nextblock_docker_migrations' > "$D/data.sql"
    psql -tA > "$D/counts.txt" <<'SQL'
select 'types', count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e'
union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
union all select 'tables', count(*) from pg_tables where schemaname='public'
union all select 'indexes', count(*) from pg_indexes where schemaname='public'
union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'
union all select 'policies', count(*) from pg_policies where schemaname='public'
union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
union all select 'auth_triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal
union all select 'rls_tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity;
SQL
    psql -tA -c "select string_agg(format('select %L, count(*) from public.%I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public' and tablename <> '_nextblock_docker_migrations'" \
      | psql -tA > "$D/rowcounts.txt"
    tr -d '\r' < "$D/schema.sql" | grep -v '^--' | grep -v '^$' > "$D/schema.norm.sql"
    # INSERTs only, CR-stripped, apply-time values masked (SQL + JSON timestamps, form keys,
    # form_endpoints keys, site_themes ids — all generated at seed time), sorted.
    node -e '
      const fs = require("fs"); const d = process.argv[1];
      const raw = fs.readFileSync(d + "/data.sql", "utf8").replace(/\r/g, "");
      const stmts = raw.split(/ON CONFLICT DO NOTHING;\n/).map((s) => s.replace(/^(?:(?!INSERT INTO)[^\n]*\n)*/, "").trim()).filter((s) => s.startsWith("INSERT"));
      const norm = stmts.map((s) => s
        .replace(/\x27\d{4}-\d\d-\d\d[ T][0-9:.+]+\x27/g, "\x27<ts>\x27")
        .replace(/"\d{4}-\d\d-\d\dT[0-9:.]+Z"/g, "\"<ts>\"")
        .replace(/"form_key": "[0-9a-f-]{36}"/g, "\"form_key\": \"<uuid>\"")
        .replace(/^(INSERT INTO public\.form_endpoints \([^)]*\) VALUES \()\x27[0-9a-f-]{36}\x27/, "$1\x27<uuid>\x27")
        .replace(/^(INSERT INTO public\.site_themes \([^)]*\) VALUES \()\x27[0-9a-f-]{36}\x27/, "$1\x27<uuid>\x27")).sort();
      fs.writeFileSync(d + "/data.sorted.sql", norm.join("\nON CONFLICT DO NOTHING;\n") + "\n");
      console.log(norm.length + " insert statements normalized");
    ' "$D"
    echo "dumped $3:"; tr '\n' ' ' < "$D/counts.txt"; echo;;

  cmp)
    A="$W/$3"; B="$W/$4"; echo "== $3 vs $4 =="
    printf 'counts:    '; diff "$A/counts.txt" "$B/counts.txt" > /dev/null && echo identical || { echo DIFFERS; diff "$A/counts.txt" "$B/counts.txt" || true; }
    printf 'rowcounts: '; diff "$A/rowcounts.txt" "$B/rowcounts.txt" > /dev/null && echo identical || { echo DIFFERS; diff "$A/rowcounts.txt" "$B/rowcounts.txt" || true; }
    printf 'schema:    '; diff "$A/schema.norm.sql" "$B/schema.norm.sql" > "$W/diff_schema_$3_$4.txt" && echo identical || echo "DIFFERS -> $W/diff_schema_$3_$4.txt"
    printf 'data:      '; diff "$A/data.sorted.sql" "$B/data.sorted.sql" > "$W/diff_data_$3_$4.txt" && echo identical || echo "DIFFERS -> $W/diff_data_$3_$4.txt (expected: only the migration_baseline_generation row)";;

  lf)
    src="$3"; dst="$4"; rm -rf "$dst"; mkdir -p "$dst"
    for f in "$src"/*.sql; do tr -d '\r' < "$f" > "$dst/$(basename "$f")"; done
    echo "LF copies in $dst: $(ls "$dst" | wc -l) files";;

  down)
    compose down -v | tail -1;;

  *) sed -n 2,25p "$0"; exit 2;;
esac
