import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { collectMigrations } from './migrate-core.mjs';
import { RETIRED_MIGRATIONS, retiredMigrationFilesIn } from './retired-migrations.mjs';

// The migration folder, found from this file as collectMigrations finds it (the monorepo's libs/db, from
// here and from the CLI template's copy of this file, which `vitest run ... tools` also collects): a
// path relative to this file reaches libs/db from apps/nextblock only.
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = collectMigrations(here).files;
const CURRENT = MIGRATIONS.map((entry) => entry.name).sort();
const GENERATION = Number.parseInt(CURRENT[CURRENT.length - 1].slice(0, 2), 10);
const CATCHUP = CURRENT.find((name) => /^\d{2}000_catchup_gen\d+\.sql$/.test(name));
const CATCHUP_DIR = MIGRATIONS.find((entry) => entry.name === CATCHUP)?.dir;
const ALL_RETIRED = RETIRED_MIGRATIONS.flatMap((entry) => entry.files);

describe('the retired migration list', () => {
  it('names every file the current catch-up replays, so a squash cannot forget its own', () => {
    expect(CATCHUP).toBeDefined();
    const replayed = [...readFileSync(path.join(CATCHUP_DIR, CATCHUP), 'utf8').matchAll(/^\s*-- >>> FROM: (\S+\.sql)$/gm)].map((match) => match[1]);
    expect(replayed.length).toBeGreaterThan(0);
    const listed = new Set(RETIRED_MIGRATIONS.filter((entry) => entry.retiredBy <= GENERATION).flatMap((entry) => entry.files));
    expect(replayed.filter((name) => !listed.has(name))).toEqual([]);
  });

  it('never names a file of the current folder: updates must leave those in supabase/migrations', () => {
    const current = new Set(CURRENT);
    expect(ALL_RETIRED.filter((name) => current.has(name))).toEqual([]);
  });

  it('holds migration file names, each once, by generations no newer than the current one', () => {
    expect(new Set(ALL_RETIRED).size).toBe(ALL_RETIRED.length);
    for (const name of ALL_RETIRED) expect(name).toMatch(/^\d+_[a-z0-9_]+\.sql$/);
    for (const entry of RETIRED_MIGRATIONS) expect(entry.retiredBy).toBeLessThanOrEqual(GENERATION);
  });
});

describe('retiredMigrationFilesIn', () => {
  const generation1 = '00000000000004_default_logo_email_safe.sql';
  const generation0 = '00000000000004_setup_media.sql';
  const timestamped = '20250513194738_setup_roles_and_profiles.sql';
  const projectsOwn = ['20261201120000_add_loyalty_points.sql', '00000000000045_my_table.sql', '001_local_seed.sql'];

  it("picks NextBlock's retired files by exact name, beside the current generation's catch-up", () => {
    const folder = [...CURRENT, generation1, generation0, timestamped, ...projectsOwn];
    expect(retiredMigrationFilesIn(folder)).toEqual([generation0, generation1, timestamped].sort());
  });

  it("leaves a project's own migrations alone, whatever their numbers", () => {
    expect(retiredMigrationFilesIn([CATCHUP, ...projectsOwn])).toEqual([]);
  });

  it('picks nothing in a folder still on the generation those files belong to (no catch-up that retires them)', () => {
    expect(retiredMigrationFilesIn([generation1, generation0, timestamped])).toEqual([]);
    expect(retiredMigrationFilesIn(['01000_catchup_gen0.sql', generation1])).toEqual([]);
  });
});
