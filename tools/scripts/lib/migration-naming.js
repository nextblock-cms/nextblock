// Migration file naming — the GGNNN scheme (squash generations).
//
//   GGNNN_name.sql      GG  = squash generation (two digits, 02 and up)
//                       NNN = sequence inside that generation (000 and up, contiguous)
//
//   02000_catchup_gen1.sql                        replays generation 1's forward migrations
//                                                 once, version-aware, on databases behind —
//                                                 FIRST, so the baseline below is a no-op there
//   02001_baseline_schema.sql                   ┐
//   02002_baseline_constraints_and_indexes.sql  │ the generation's baseline (idempotent DDL,
//   02003_baseline_security_and_grants.sql      │ seed guarded to empty databases only)
//   02004_baseline_seed.sql                     ┘
//   02005_<whatever>.sql                          first ordinary forward migration
//   03000_catchup_gen2.sql                        the NEXT squash starts generation 3
//
// Why digits only: the Supabase CLI silently skips any file that does not match
// `<digits>_name.sql` (verified against CLI 2.107: "squash2_000_x.sql" is skipped with a
// warning, "02000_x.sql" is accepted). Why a fixed width: every applier in the chain — the
// CLI's pending walk, Postgres' ORDER BY on supabase_migrations.schema_migrations, and this
// repo's own appliers — compares versions as plain strings, so "020" and "0200" would
// interleave. Why the second character is never 0: the legacy generation-1 versions were
// 14-digit zero-padded numbers (00000000000000..00000000000042) and every database created
// before the generation-2 squash still carries them in its history; any new version must
// sort after them, which "0G…" with G >= 1 does. Why no timestamps: this repo never used
// `supabase migration new`; a 14-digit timestamp would still sort after every generation
// below 20, but the lint below rejects it so nobody has to reason about that.
//
// Generation 1 = the legacy 14-digit files (all retired by the generation-2 squash).
// Full rules + the squash runbook: docs/04-DATABASE-AND-AUTH.md → "Migration structure".

/** What every applier accepts (Supabase CLI: `<digits>_name.sql`). */
const MIGRATION_FILE_RE = /^\d+_.*\.sql$/;

/** What this repository enforces. */
const GGNNN_RE = /^(\d{2})(\d{3})_([a-z0-9_]+)\.sql$/;

/** Fixed slots at the head of every generation. Sequence 0 is the catch-up. */
const CATCHUP_SEQUENCE = 0;
const BASELINE_SLOTS = {
  1: 'baseline_schema',
  2: 'baseline_constraints_and_indexes',
  3: 'baseline_security_and_grants',
  4: 'baseline_seed',
};
const FIRST_FORWARD_SEQUENCE = 5;

function formatVersion(generation, sequence) {
  return `${String(generation).padStart(2, '0')}${String(sequence).padStart(3, '0')}`;
}

function catchupName(generation) {
  return `catchup_gen${generation - 1}`;
}

/** Parse `GGNNN_name.sql`; null for anything else (including the legacy 14-digit files). */
function parseMigrationName(file) {
  const m = GGNNN_RE.exec(file);
  if (!m) return null;
  return {
    file,
    version: `${m[1]}${m[2]}`,
    generation: Number.parseInt(m[1], 10),
    sequence: Number.parseInt(m[2], 10),
    name: m[3],
  };
}

function isBaselineMigration(file) {
  const p = parseMigrationName(file);
  return Boolean(p && BASELINE_SLOTS[p.sequence]);
}

function isCatchupMigration(file) {
  const p = parseMigrationName(file);
  return Boolean(p && p.sequence === CATCHUP_SEQUENCE && p.name === catchupName(p.generation));
}

/**
 * Validate a migration directory listing. Returns { errors, generation, next } where `next`
 * is the version the next new migration must use (highest sequence + 1, same generation).
 */
function validateMigrationNames(files) {
  const errors = [];
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();
  if (sqlFiles.length === 0) {
    return { errors: ['no .sql migration files found'], generation: null, next: null };
  }

  const parsed = [];
  for (const file of sqlFiles) {
    const p = parseMigrationName(file);
    if (!p) {
      const hint = /^\d{14}_/.test(file)
        ? ' (legacy 14-digit generation-1 name — those were retired by the generation-2 squash)'
        : /^\d+_/.test(file)
          ? ' (digits are right but the width is not: use exactly 5 digits GGNNN)'
          : ' (must be <5 digits>_<lowercase_snake_case>.sql — the Supabase CLI skips anything else)';
      errors.push(`${file}: does not match GGNNN_name.sql${hint}`);
      continue;
    }
    parsed.push(p);
  }
  if (parsed.length === 0) return { errors, generation: null, next: null };

  const generations = [...new Set(parsed.map((p) => p.generation))];
  if (generations.length > 1) {
    errors.push(`mixed squash generations on disk: ${generations.join(', ')} — a squash replaces the whole folder`);
  }
  const generation = Math.max(...generations);
  if (generation < 2) {
    errors.push(`generation ${generation} is reserved for the legacy 14-digit files; squash generations start at 02`);
  }

  const inGen = parsed.filter((p) => p.generation === generation).sort((a, b) => a.sequence - b.sequence);
  inGen.forEach((p, i) => {
    if (p.sequence !== i) {
      errors.push(`${p.file}: sequence gap or duplicate — expected ${formatVersion(generation, i)} (sequences must be contiguous from 000)`);
    }
  });

  const slot0 = inGen.find((x) => x.sequence === CATCHUP_SEQUENCE);
  if (slot0 && slot0.name !== catchupName(generation)) {
    errors.push(`${slot0.file}: sequence 000 must be ${catchupName(generation)}`);
  }
  for (const [seq, name] of Object.entries(BASELINE_SLOTS)) {
    const p = inGen.find((x) => x.sequence === Number(seq));
    if (p && p.name !== name) errors.push(`${p.file}: sequence ${String(seq).padStart(3, '0')} must be ${name}`);
  }

  const highest = inGen.length ? inGen[inGen.length - 1].sequence : -1;
  return { errors, generation, next: formatVersion(generation, Math.max(highest + 1, FIRST_FORWARD_SEQUENCE)) };
}

/** Convenience: the version the next new migration must use, from a directory listing. */
function nextMigrationVersion(files) {
  return validateMigrationNames(files).next;
}

module.exports = {
  MIGRATION_FILE_RE,
  GGNNN_RE,
  CATCHUP_SEQUENCE,
  BASELINE_SLOTS,
  FIRST_FORWARD_SEQUENCE,
  formatVersion,
  catchupName,
  parseMigrationName,
  isBaselineMigration,
  isCatchupMigration,
  validateMigrationNames,
  nextMigrationVersion,
};
