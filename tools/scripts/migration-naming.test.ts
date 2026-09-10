import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isBaselineMigration,
  isCatchupMigration,
  nextMigrationVersion,
  parseMigrationName,
  validateMigrationNames,
} = require('./lib/migration-naming.js');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../libs/db/src/supabase/migrations');

const GEN2 = [
  '02000_catchup_gen1.sql',
  '02001_baseline_schema.sql',
  '02002_baseline_constraints_and_indexes.sql',
  '02003_baseline_security_and_grants.sql',
  '02004_baseline_seed.sql',
];

describe('GGNNN migration naming', () => {
  it('parses generation and sequence', () => {
    expect(parseMigrationName('02000_catchup_gen1.sql')).toEqual({
      file: '02000_catchup_gen1.sql',
      version: '02000',
      generation: 2,
      sequence: 0,
      name: 'catchup_gen1',
    });
    expect(parseMigrationName('00000000000004_default_logo_email_safe.sql')).toBeNull();
    expect(parseMigrationName('squash2_000_x.sql')).toBeNull();
    expect(parseMigrationName('02005_Has-Caps.sql')).toBeNull();
  });

  it('classifies catch-up and baseline files', () => {
    expect(isCatchupMigration('02000_catchup_gen1.sql')).toBe(true);
    expect(isCatchupMigration('02000_catchup_gen2.sql')).toBe(false);
    expect(isCatchupMigration('03000_catchup_gen2.sql')).toBe(true);
    expect(isBaselineMigration('02000_catchup_gen1.sql')).toBe(false);
    expect(GEN2.slice(1).every(isBaselineMigration)).toBe(true);
    expect(isBaselineMigration('02005_add_thing.sql')).toBe(false);
  });

  it('accepts a well-formed generation and computes the next version', () => {
    const result = validateMigrationNames([...GEN2, '02005_add_thing.sql']);
    expect(result.errors).toEqual([]);
    expect(result.generation).toBe(2);
    expect(result.next).toBe('02006');
    expect(nextMigrationVersion(GEN2)).toBe('02005');
  });

  it('rejects legacy 14-digit names, wrong widths and non-digit prefixes', () => {
    const { errors } = validateMigrationNames([
      ...GEN2,
      '00000000000043_late.sql',
      '2005_short.sql',
      'squash2_000_alpha.sql',
    ]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('legacy 14-digit');
    expect(errors[1]).toContain('width');
    expect(errors[2]).toContain('Supabase CLI skips');
  });

  it('rejects gaps, duplicates, mixed generations and misnamed fixed slots', () => {
    expect(validateMigrationNames([...GEN2, '02006_skipped_five.sql']).errors[0]).toContain('sequence gap');
    expect(validateMigrationNames([...GEN2, '02004_duplicate.sql']).errors.join('\n')).toContain('gap or duplicate');
    expect(validateMigrationNames([...GEN2, '03001_baseline_schema.sql']).errors[0]).toContain('mixed squash generations');
    expect(validateMigrationNames(['02000_catchup.sql', ...GEN2.slice(1)]).errors[0]).toContain('must be catchup_gen1');
    expect(validateMigrationNames([GEN2[0], '02001_schema.sql', ...GEN2.slice(2)]).errors[0]).toContain('must be baseline_schema');
  });

  it('the real migrations folder conforms (this is the enforcement)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const result = validateMigrationNames(files);
    expect(result.errors).toEqual([]);
    expect(result.generation).toBeGreaterThanOrEqual(2);
    // The first five slots of every generation are fixed.
    expect(files.filter(isCatchupMigration)).toHaveLength(1);
    expect(files.filter(isBaselineMigration)).toHaveLength(4);
  });
});
