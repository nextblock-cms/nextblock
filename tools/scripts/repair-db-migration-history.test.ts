import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { emptyHistoryRefusal } from '../../apps/nextblock/tools/lib/migrate-core.mjs';

/**
 * `npm run db:migrate:repair-history` (auto-detect) records this generation's versions and leaves
 * the catch-up pending. On a database that never crossed the last squash, with a wiped history, the
 * catch-up would then find no retired version recorded and replay the whole retired generation over
 * the content. Until 2026-11-19 only the docs said so ("restore the history instead"); now the
 * command refuses, by the rule every applier honours (migrate-core's emptyHistoryRefusal).
 */

const { autoDetectRefusal } = require('./repair-db-migration-history.js') as {
  autoDetectRefusal: (options: {
    names: string[];
    baseline: { readable: boolean; generation: number | null };
    catchupRecorded: boolean;
    emptyHistoryRefusal: typeof emptyHistoryRefusal;
  }) => string | null;
};

const MIGRATIONS_DIR = path.resolve(__dirname, '../../libs/db/src/supabase/migrations');
const NAMES = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
const GENERATION = Number.parseInt(NAMES[NAMES.length - 1].slice(0, 2), 10);

const refusalFor = (baseline: { readable: boolean; generation: number | null }, catchupRecorded = false) =>
  autoDetectRefusal({ names: NAMES, baseline, catchupRecorded, emptyHistoryRefusal });

describe('repair-history auto-detect on a database that never crossed the last squash', () => {
  it('reads the real folder: one generation, its catch-up first', () => {
    expect(NAMES[0]).toMatch(new RegExp(`^${String(GENERATION).padStart(2, '0')}000_catchup_gen\\d+\\.sql$`));
  });

  it('refuses when the marker is unset or below the folder generation, and says to restore the history', () => {
    for (const generation of [null, GENERATION - 1]) {
      const refusal = refusalFor({ readable: true, generation });
      expect(refusal).toContain(`never crossed squash generation ${GENERATION}`);
      expect(refusal).toContain(`site_settings.migration_baseline_generation is ${generation ?? 'unset'}`);
      expect(refusal).toContain('Restore supabase_migrations.schema_migrations');
    }
  });

  it('lets the repair run on a database born at or crossed to the folder generation', () => {
    expect(refusalFor({ readable: true, generation: GENERATION })).toBeNull();
    expect(refusalFor({ readable: true, generation: GENERATION + 1 })).toBeNull();
  });

  it('refuses when the marker cannot be read: unknown is never taken for crossed', () => {
    expect(refusalFor({ readable: false, generation: null })).toMatch(/could not be read/);
    expect(refusalFor({ readable: false, generation: GENERATION })).toMatch(/could not be read/);
  });

  it('does not stand in the way when the history records the catch-up already (it will not run again)', () => {
    expect(refusalFor({ readable: true, generation: null }, true)).toBeNull();
    expect(refusalFor({ readable: false, generation: null }, true)).toBeNull();
  });
});
