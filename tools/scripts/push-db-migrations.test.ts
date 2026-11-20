import { describe, expect, it } from 'vitest';

// CommonJS CLI script. Requiring it is safe: `main()` is guarded by `require.main`,
// so importing here never opens a database connection.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  cliEnv,
  getMigrationVersion,
  isBaselineMigration,
  parseMigrationList,
  runCheck,
  workdir,
} = require('./push-db-migrations.js');

type Versions = { applied: string[]; pending: string[]; remoteOnly: string[] };

/** The three version lists, without the `target` the parser also reports. */
function versionsOf(status: Versions | null): Versions | null {
  if (!status) return status;
  return { applied: status.applied, pending: status.pending, remoteOnly: status.remoteOnly };
}

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
    expect(versionsOf(parseMigrationList(BACKTICK_TABLE.join('\n')))).toEqual(EXPECTED_MIXED);
  });

  it('reads a backtick table captured with CRLF line endings', () => {
    expect(versionsOf(parseMigrationList(BACKTICK_TABLE.join('\r\n')))).toEqual(EXPECTED_MIXED);
  });

  it('reads the JSON line and ignores the stderr lines appended after it', () => {
    expect(versionsOf(parseMigrationList(JSON_OUTPUT.join('\n')))).toEqual(EXPECTED_MIXED);
  });

  it('reads the JSON line when stderr chatter comes first and lines end in CRLF', () => {
    const output = ['Using workdir C:\\repo\\libs\\db\\src', ...JSON_OUTPUT].join('\r\n');
    expect(versionsOf(parseMigrationList(output))).toEqual(EXPECTED_MIXED);
  });

  it('treats an empty JSON migrations list as a real, empty history', () => {
    // Unlike unrecognised output, this is a structured answer: no files and no history.
    expect(parseMigrationList('{"migrations":[],"message":"Migrations listed"}')).toEqual({
      applied: [],
      pending: [],
      remoteOnly: [],
      target: null,
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
    expect(versionsOf(parseMigrationList(output))).toEqual({
      applied: [],
      pending: ['02000', '02004'],
      remoteOnly: ['00000000000000', '00000000000042'],
    });
  });
});

// Captured from Supabase CLI 3.2.0 against a disposable local stack (2026-11-20), the migrations
// list trimmed to a few rows. The keys stay `local` / `remote` whichever database the CLI read:
// only `target` tells the local stack from the project.
const CLI3_LOCAL_JSON = [
  '{"migrations":[{"local":"02000","remote":"02000","time":"02000"},{"local":"02047","remote":"02047","time":"02047"},{"local":"02048","remote":"","time":"02048"}],"message":"Migrations listed","target":{"kind":"local","host":"127.0.0.1","port":55522}}',
  'Target: local stack (127.0.0.1:55522)',
].join('\n');
const CLI3_URL_JSON = [
  '{"migrations":[{"local":"02000","remote":"02000","time":"02000"}],"message":"Migrations listed","target":{"kind":"db-url","host":"127.0.0.1","port":55522}}',
  'Target: custom Postgres (127.0.0.1:55522)',
].join('\n');
const CLI3_LOCAL_TABLE = [
  'Target: local stack (127.0.0.1:55522)',
  '',
  '  ',
  '   Local   | Local DB | Time (UTC) ',
  '  ---------|----------|------------',
  '   `02000` | `02000`  | `02000`    ',
  '   `02048` | ` `      | `02048`    ',
].join('\n');
const REF = 'abcdefghijklmnopqrst';

/** The `--remote=<ref>` shape: the target object as CLI 3.2.0 printed it for a project ref. */
function cli3ProjectJson(projectRef: string): string {
  return [
    JSON.stringify({
      migrations: [
        { local: '', remote: '01999', time: '01999' },
        { local: '02000', remote: '02000', time: '02000' },
        { local: '02006', remote: '', time: '02006' },
      ],
      message: 'Migrations listed',
      target: { kind: 'linked', project_ref: projectRef, environment: 'production' },
    }),
    `Target: project nextblock (${projectRef}) · production`,
  ].join('\n');
}

describe('parseMigrationList with CLI 3 output', () => {
  it('reports the target the CLI read alongside the versions', () => {
    expect(parseMigrationList(cli3ProjectJson(REF))).toEqual({
      ...EXPECTED_MIXED,
      target: { kind: 'linked', project_ref: REF, environment: 'production' },
    });
    expect(parseMigrationList(CLI3_LOCAL_JSON)).toEqual({
      applied: ['02000', '02047'],
      pending: ['02048'],
      remoteOnly: [],
      target: { kind: 'local', host: '127.0.0.1', port: 55522 },
    });
    expect(parseMigrationList(CLI3_URL_JSON).target).toEqual({ kind: 'db-url', host: '127.0.0.1', port: 55522 });
  });

  it('reads the "Local DB" column CLI 3 prints for the local stack, and marks it local', () => {
    expect(parseMigrationList(CLI3_LOCAL_TABLE)).toEqual({
      applied: ['02000'],
      pending: ['02048'],
      remoteOnly: [],
      target: { kind: 'local' },
    });
  });
});

/**
 * `npm run db:migrate:check` must stay read-only by construction (AGENTS.md; docs/04 → "Why
 * `db:migrate:check` is read-only"): on 2026-08-10 the check path's `link` + `db push --dry-run`
 * applied a migration to production. These run the whole check path with a recording runner and
 * pin every Supabase CLI call it makes.
 */
describe('the db:migrate:check call sequence', () => {
  type Call = { args: string[]; options: Record<string, unknown> };

  function record(output: string, failed = false) {
    const calls: Call[] = [];
    const runSupabase = (args: string[], options: Record<string, unknown>) => {
      calls.push({ args, options });
      return { failed, output };
    };
    return { calls, runSupabase };
  }

  it('makes exactly one CLI call: migration list against --remote=<ref>, as JSON', () => {
    const { calls, runSupabase } = record(cli3ProjectJson(REF));
    const result = runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase });

    expect(calls.map((call) => call.args)).toEqual([
      ['migration', 'list', '--workdir', workdir, `--remote=${REF}`, '--password', 'pw', '--output-format', 'json'],
    ]);
    expect(calls[0].options).toMatchObject({ allowFailure: true, capture: true });
    expect(result.error).toBeUndefined();
    expect(result.status.pending).toEqual(['02006']);
  });

  it('passes nothing that links, pushes, repairs, confirms or dry-runs', () => {
    const { calls, runSupabase } = record(cli3ProjectJson(REF));
    runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase });
    const argv = calls.flatMap((call) => call.args);
    for (const forbidden of ['link', 'push', 'repair', 'reset', 'db', '--yes', '--dry-run', '--include-all', '--linked', '--db-url', '--local']) {
      expect(argv).not.toContain(forbidden);
    }
    // The password keeps CLI 3 from minting a temporary login role through the Management API.
    expect(argv).toContain('--password');
  });

  it('refuses a history the CLI read from the local stack, even one that parses', () => {
    for (const output of [CLI3_LOCAL_JSON, CLI3_LOCAL_TABLE]) {
      const { calls, runSupabase } = record(output);
      const result = runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase });
      expect(result.status).toBeUndefined();
      expect(result.error).toMatch(/LOCAL database/);
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses another project, a database URL and a history with no target', () => {
    const cases: Array<[string, RegExp]> = [
      [cli3ProjectJson('zzzzzzzzzzzzzzzzzzzz'), /zzzzzzzzzzzzzzzzzzzz, not abcdefghijklmnopqrst/],
      [CLI3_URL_JSON, /db-url/],
      ['{"migrations":[{"local":"02000","remote":"02000","time":"02000"}],"message":"Migrations listed"}', /did not say/],
    ];
    for (const [output, reason] of cases) {
      const { runSupabase } = record(output);
      const result = runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase });
      expect(result.status).toBeUndefined();
      expect(result.error).toMatch(reason);
    }
  });

  it('reports a pre-3.0 CLI as "run npm ci" and does not retry with an implicit target', () => {
    const { calls, runSupabase } = record('unknown flag: --remote=abcdefghijklmnopqrst', true);
    const result = runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase });
    expect(result.error).toMatch(/npm ci/);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the CLI's own error from its JSON envelope", () => {
    const { runSupabase } = record(
      '{"target":{"kind":"linked","project_ref":"abcdefghijklmnopqrst","environment":"unverified"},"_tag":"Error","error":{"code":"DbConfigIpv6Error","message":"IPv6 is not supported on your current network"}}',
      true,
    );
    expect(runCheck({ projectRef: REF, dbPassword: 'pw', runSupabase }).error).toMatch(/DbConfigIpv6Error/);
  });

  it('runs the CLI without SUPABASE_YES, so a value dotenv copied from .env.local is no consent', () => {
    const before = process.env.SUPABASE_YES;
    process.env.SUPABASE_YES = '1';
    try {
      const env = cliEnv();
      expect(env).not.toHaveProperty('SUPABASE_YES');
      expect(env.PATH ?? env.Path).toBeDefined();
      expect(process.env.SUPABASE_YES).toBe('1');
    } finally {
      if (before === undefined) delete process.env.SUPABASE_YES;
      else process.env.SUPABASE_YES = before;
    }
  });

  it('builds no command at all for a malformed ref or an empty password', () => {
    const { calls, runSupabase } = record(cli3ProjectJson(REF));
    expect(() => runCheck({ projectRef: 'nextblock-ci', dbPassword: 'pw', runSupabase })).toThrow(/20 lowercase letters/);
    expect(() => runCheck({ projectRef: REF, dbPassword: '', runSupabase })).toThrow(/password/);
    expect(calls).toHaveLength(0);
  });
});
