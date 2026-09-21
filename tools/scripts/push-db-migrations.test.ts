import { describe, expect, it } from 'vitest';

// CommonJS CLI script. Requiring it is safe: `main()` is guarded by `require.main`,
// so importing here never opens a database connection.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getMigrationVersion, isBaselineMigration, parseMigrationList } = require('./push-db-migrations.js');

/**
 * These cover the migration-status parser that replaced `link` + `db push --dry-run`
 * in the `--check` path. On 2026-08-10 that old probe applied migration
 * 00000000000017 to production while printing "DRY RUN: migrations will *not* be
 * pushed", so the check now runs only the read-only `supabase migration list` and
 * reports what it found. The parser is the part that can silently be wrong.
 */

// Real `supabase migration list` output, trailing spaces and all.
const REAL_OUTPUT = [
  '  ',
  '   Local          | Remote         | Time (UTC)     ',
  '  ----------------|----------------|----------------',
  '   00000000000000 | 00000000000000 | 00000000000000 ',
  '   00000000000001 | 00000000000001 | 00000000000001 ',
  '   00000000000016 | 00000000000016 | 00000000000016 ',
  '   00000000000017 | 00000000000017 | 00000000000017 ',
  '',
].join('\n');

describe('parseMigrationList', () => {
  it('reads a fully-applied history', () => {
    const status = parseMigrationList(REAL_OUTPUT);

    expect(status.applied).toEqual([
      '00000000000000',
      '00000000000001',
      '00000000000016',
      '00000000000017',
    ]);
    expect(status.pending).toEqual([]);
    expect(status.remoteOnly).toEqual([]);
  });

  it('treats a local-only row as pending', () => {
    const status = parseMigrationList(
      [
        '   Local          | Remote         | Time (UTC)     ',
        '  ----------------|----------------|----------------',
        '   00000000000017 | 00000000000017 | 00000000000017 ',
        '   00000000000018 |                |                ',
        '   00000000000019 |                |                ',
      ].join('\n')
    );

    expect(status.pending).toEqual(['00000000000018', '00000000000019']);
    expect(status.applied).toEqual(['00000000000017']);
  });

  it('treats a remote-only row as history with no file', () => {
    // This is the shape that makes a newly-written migration unrunnable: the version
    // is already recorded, so Supabase (which matches by version, never by content)
    // skips the file in silence.
    const status = parseMigrationList(
      [
        '   Local          | Remote         | Time (UTC)     ',
        '  ----------------|----------------|----------------',
        '   00000000000017 | 00000000000017 | 00000000000017 ',
        '                  | 00000000000044 | 00000000000044 ',
      ].join('\n')
    );

    expect(status.remoteOnly).toEqual(['00000000000044']);
    expect(status.pending).toEqual([]);
    expect(status.applied).toEqual(['00000000000017']);
  });

  it('ignores headers, separators, blank lines, and CLI chatter', () => {
    const status = parseMigrationList(
      [
        'Using workdir C:\\repo\\libs\\db\\src',
        'WARN: environment variable is unset: NEXT_PUBLIC_URL',
        'Connecting to remote database...',
        'A new version of Supabase CLI is available: v2.113.0 | currently v2.107.0',
        '   Local          | Remote         | Time (UTC)     ',
        '  ----------------|----------------|----------------',
        '   00000000000017 | 00000000000017 | 00000000000017 ',
      ].join('\n')
    );

    expect(status.applied).toEqual(['00000000000017']);
    expect(status.pending).toEqual([]);
    // The CLI-version line contains a pipe but no 14-digit version — it must not
    // become a phantom migration.
    expect(status.remoteOnly).toEqual([]);
  });

  it('returns null for output with no table at all', () => {
    // NOT empty sets. An unrecognised output and a genuinely empty history lead to opposite
    // actions — the callers apply the baseline to an empty history and refuse on an
    // unreadable one — so the parser must not let the two look alike.
    expect(parseMigrationList('Cannot connect to remote database')).toBeNull();
  });

  it('reads columns by header position, so an outer delimiter cannot invert local and remote', () => {
    // A leading delimiter shifts every cell by one. Read by fixed index, each pending local
    // migration would look like a retired remote version — and `--reconcile-squash` reverts
    // retired versions.
    const status = parseMigrationList(
      [
        '| Local          | Remote         | Time (UTC)     |',
        '|----------------|----------------|----------------|',
        '| 02005          |                |                |',
        '|                | 00000000000042 | 00000000000042 |',
      ].join('\n')
    );

    expect(status.pending).toEqual(['02005']);
    expect(status.remoteOnly).toEqual(['00000000000042']);
    expect(status.applied).toEqual([]);
  });

  it('tolerates a box-drawing table', () => {
    const status = parseMigrationList(
      [
        '   Local          │ Remote         │ Time (UTC)     ',
        '  ────────────────┼────────────────┼────────────────',
        '   02005          │ 02005          │ 02005          ',
      ].join('\n')
    );

    expect(status.applied).toEqual(['02005']);
  });

  it('ignores pipe-bearing chatter printed before the header row', () => {
    const status = parseMigrationList(
      [
        'A new version of Supabase CLI is available: v2.117.0 | currently v2.107.0',
        '   Local          | Remote         | Time (UTC)     ',
        '  ----------------|----------------|----------------',
        '   02005          |                |                ',
      ].join('\n')
    );

    expect(status.pending).toEqual(['02005']);
    expect(status.remoteOnly).toEqual([]);
  });
});

// The same history in both CLI 2.109+ shapes: one retired remote-only version, one applied
// migration, one pending file.
const EXPECTED_MIXED = {
  applied: ['02000'],
  pending: ['02006'],
  remoteOnly: ['01999'],
};

describe('parseMigrationList with CLI 2.109+ output', () => {
  // From 2.109 the text table wraps every cell in backticks and draws a blank cell as a
  // backticked space. The old parser found the header, rejected every cell as a version, and
  // reported "Pending migrations: 0" while migrations were pending.
  const BACKTICK_TABLE = [
    '',
    '  ',
    '   Local   | Remote  | Time (UTC) ',
    '  ---------|---------|------------',
    '   ` `     | `01999` | `01999`    ',
    '   `02000` | `02000` | `02000`    ',
    '   `02006` | ` `     | `02006`    ',
    '',
    'Connecting to remote database...',
  ];

  // `--output-format json`, and the default when the CLI detects an agent (CLAUDECODE /
  // AI_AGENT): one JSON line on stdout, then the stderr chatter the scripts append to it.
  const JSON_OUTPUT = [
    JSON.stringify({
      migrations: [
        { local: '', remote: '01999', time: '01999' },
        { local: '02000', remote: '02000', time: '02000' },
        { local: '02006', remote: '', time: '02006' },
      ],
      message: 'Migrations listed',
    }),
    'Connecting to remote database...',
    'A new version of Supabase CLI is available: v2.118.0 | currently v2.117.0',
  ];

  it('strips backticks from table cells', () => {
    expect(parseMigrationList(BACKTICK_TABLE.join('\n'))).toEqual(EXPECTED_MIXED);
  });

  it('reads a backtick table captured with CRLF line endings', () => {
    expect(parseMigrationList(BACKTICK_TABLE.join('\r\n'))).toEqual(EXPECTED_MIXED);
  });

  it('reads the JSON line and ignores the stderr lines appended after it', () => {
    expect(parseMigrationList(JSON_OUTPUT.join('\n'))).toEqual(EXPECTED_MIXED);
  });

  it('reads the JSON line when stderr chatter comes first and lines end in CRLF', () => {
    const output = ['Using workdir C:\\repo\\libs\\db\\src', ...JSON_OUTPUT].join('\r\n');
    expect(parseMigrationList(output)).toEqual(EXPECTED_MIXED);
  });

  it('treats an empty JSON migrations list as a real, empty history', () => {
    // Unlike unrecognised output, this is a structured answer: no files and no history.
    expect(parseMigrationList('{"migrations":[],"message":"Migrations listed"}')).toEqual({
      applied: [],
      pending: [],
      remoteOnly: [],
    });
  });

  it('returns null for garbage, including JSON without a migrations array', () => {
    expect(parseMigrationList('')).toBeNull();
    expect(
      parseMigrationList(
        [
          '{not json at all',
          '{"message":"Migrations listed"}',
          '{"migrations":"02000"}',
          'Connecting to remote database...',
          'error: failed to connect to postgres | timeout',
        ].join('\n')
      )
    ).toBeNull();
  });
});

describe('baseline guard', () => {
  it('extracts the version from a migration filename', () => {
    expect(getMigrationVersion('00000000000017_cortex_ai_mcp_server.sql')).toBe('00000000000017');
    expect(getMigrationVersion('02001_baseline_schema.sql')).toBe('02001');
  });

  it('flags only the generation baseline (GG001-GG004) as the baseline', () => {
    expect(isBaselineMigration('02001_baseline_schema.sql')).toBe(true);
    expect(isBaselineMigration('02004_baseline_seed.sql')).toBe(true);
    expect(isBaselineMigration('02000_catchup_gen1.sql')).toBe(false);
    expect(isBaselineMigration('02005_add_thing.sql')).toBe(false);
    // Legacy generation-1 names are not GGNNN and never count as a baseline again.
    expect(isBaselineMigration('00000000000000_baseline_schema.sql')).toBe(false);
  });

  it('parses a history that mixes retired 14-digit versions with GGNNN versions (mid-squash)', () => {
    const output = [
      '   Local          | Remote         | Time (UTC)     ',
      '  ----------------|----------------|----------------',
      '                  | 00000000000000 | 00000000000000 ',
      '                  | 00000000000042 | 00000000000042 ',
      '   02000          |                | 02000          ',
      '   02004          |                | 02004          ',
    ].join('\n');
    expect(parseMigrationList(output)).toEqual({
      applied: [],
      pending: ['02000', '02004'],
      remoteOnly: ['00000000000000', '00000000000042'],
    });
  });
});
