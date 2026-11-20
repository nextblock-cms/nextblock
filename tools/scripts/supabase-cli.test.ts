import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Supabase CLI 3 points `migration list`, `migration repair`, `db push` and `gen types` at the LOCAL
 * stack unless `--remote` is passed, and never falls back to the remote project. A script that
 * kept CLI 2's implicit target would read or write the wrong database while printing the
 * production ref. These tests hold every caller to an explicit target (docs/04 → "Supabase CLI 3:
 * every command names its target").
 */

// CommonJS module; nothing here spawns the CLI. The scaffold's tools/deploy-supabase.js has its own
// test beside it (apps/nextblock/tools/deploy-supabase.test.mjs).
const cli = require('./lib/supabase-cli.js');

const ROOT = join(__dirname, '..', '..');
const REF = 'abcdefghijklmnopqrst';
const WORKDIR = '/repo/libs/db/src';

describe('assertProjectRef', () => {
  it('accepts exactly 20 lowercase letters', () => {
    expect(cli.assertProjectRef(REF)).toBe(REF);
  });

  it('refuses anything CLI 3 would look up as a branch name instead', () => {
    // CI sets SUPABASE_PROJECT_ID=nextblock-ci for its local stack: never a ref.
    for (const value of ['nextblock-ci', 'ABCDEFGHIJKLMNOPQRST', 'abcdefghijklmnopqrs', 'abcdefghijklmnopqrstu', '', undefined, 'abcdefghijklmnopqr1t']) {
      expect(() => cli.assertProjectRef(value)).toThrow(/20 lowercase letters/);
    }
  });

  it('never echoes the rejected value', () => {
    expect(() => cli.assertProjectRef('postgresql://user:secret@host/db')).toThrow(/^(?!.*secret)/s);
  });
});

describe('argv builders', () => {
  it('migration list: --remote=<ref>, a password, JSON, and nothing that writes', () => {
    expect(cli.migrationListArgs({ workdir: WORKDIR, projectRef: REF, password: 'pw' })).toEqual([
      'migration',
      'list',
      '--workdir',
      WORKDIR,
      `--remote=${REF}`,
      '--password',
      'pw',
      '--output-format',
      'json',
    ]);
  });

  it('db push: --remote=<ref>, a password and the --yes consent CLI 3 needs for a hosted write', () => {
    expect(cli.dbPushArgs({ workdir: WORKDIR, projectRef: REF, password: 'pw' })).toEqual([
      'db',
      'push',
      '--workdir',
      WORKDIR,
      `--remote=${REF}`,
      '--password',
      'pw',
      '--yes',
    ]);
  });

  it('migration repair: versions first, then the = form of --remote so no operand is read as its value', () => {
    expect(
      cli.migrationRepairArgs({ versions: ['02005', '02006'], status: 'applied', workdir: WORKDIR, projectRef: REF, password: 'pw' }),
    ).toEqual(['migration', 'repair', '02005', '02006', '--status', 'applied', '--workdir', WORKDIR, `--remote=${REF}`, '--password', 'pw', '--yes']);
    expect(() => cli.migrationRepairArgs({ versions: [], status: 'applied', workdir: WORKDIR, projectRef: REF, password: 'pw' })).toThrow();
    expect(() => cli.migrationRepairArgs({ versions: ['02005'], status: 'deleted', workdir: WORKDIR, projectRef: REF, password: 'pw' })).toThrow();
  });

  it('link: the ref and the workdir only (CLI 3 ignores --password there and warns)', () => {
    expect(cli.linkArgs({ workdir: WORKDIR, projectRef: REF })).toEqual(['link', '--project-ref', REF, '--workdir', WORKDIR]);
  });

  it('config push and gen types name the project too', () => {
    expect(cli.configPushArgs({ workdir: WORKDIR, projectRef: REF })).toEqual(['config', 'push', '--workdir', WORKDIR, `--remote=${REF}`, '--yes']);
    // No --workdir: from the repo root, with no link there, CLI 3 generates through the
    // Management API exactly as CLI 2's --project-id did (formatted output).
    expect(cli.genTypesArgs({ projectRef: REF })).toEqual(['gen', 'types', '--lang', 'typescript', '--schema', 'public', `--remote=${REF}`]);
  });

  it('refuses an empty password: CLI 3 would mint a temporary login role (read_only: false) instead', () => {
    for (const build of [cli.migrationListArgs, cli.dbPushArgs]) {
      expect(() => build({ workdir: WORKDIR, projectRef: REF, password: '' })).toThrow(/password/);
      expect(() => build({ workdir: WORKDIR, projectRef: REF, password: undefined })).toThrow(/password/);
    }
  });

  it('refuses a missing workdir and a malformed ref on every builder', () => {
    expect(() => cli.migrationListArgs({ workdir: '', projectRef: REF, password: 'pw' })).toThrow(/workdir/);
    for (const build of [cli.migrationListArgs, cli.dbPushArgs, cli.linkArgs, cli.configPushArgs, cli.genTypesArgs]) {
      expect(() => build({ workdir: WORKDIR, projectRef: 'nextblock-ci', password: 'pw' })).toThrow(/20 lowercase letters/);
    }
  });
});

describe('isStaleCliRefusal', () => {
  it('recognises a pre-3.0 CLI refusing --remote, or a pre-2.107 one refusing --output-format', () => {
    expect(cli.isStaleCliRefusal('Usage:\n  supabase migration list [flags]\n\nunknown flag: --remote=abcdefghijklmnopqrst\n')).toBe(true);
    expect(cli.isStaleCliRefusal('unknown flag: --output-format')).toBe(true);
  });

  it('ignores every other failure', () => {
    expect(cli.isStaleCliRefusal('failed to connect to postgres: password authentication failed')).toBe(false);
    expect(cli.isStaleCliRefusal('')).toBe(false);
    expect(cli.isStaleCliRefusal(undefined)).toBe(false);
  });
});

describe('describeCliError', () => {
  it("reads CLI 3's JSON error envelope (captured from 3.2.0)", () => {
    const output = [
      '{"target":{"kind":"linked","project_ref":"aaaaaaaaaaaaaaaaaaaa","environment":"unverified"},"_tag":"Error","error":{"code":"DbConfigIpv6Error","message":"IPv6 is not supported on your current network","suggestion":"Pass the project\'s connection pooler URL with --remote=<pooler db-url> to connect over IPv4."}}',
      'Target: project aaaaaaaaaaaaaaaaaaaa',
    ].join('\n');
    expect(cli.describeCliError(output)).toMatch(/^DbConfigIpv6Error: IPv6 is not supported/);
  });

  it('returns null for output with no envelope', () => {
    expect(cli.describeCliError('error: something')).toBeNull();
    expect(cli.describeCliError('{"migrations":[]}')).toBeNull();
  });
});

describe('migrationListTargetProblem', () => {
  const versions = { applied: [], pending: [], remoteOnly: [] };

  it('accepts the project the scripts asked for', () => {
    expect(cli.migrationListTargetProblem({ ...versions, target: { kind: 'linked', project_ref: REF } }, REF)).toBeNull();
  });

  it('refuses the local stack, a URL, another project, and an unnamed target', () => {
    expect(cli.migrationListTargetProblem({ ...versions, target: { kind: 'local', host: '127.0.0.1', port: 54322 } }, REF)).toMatch(/LOCAL/);
    expect(cli.migrationListTargetProblem({ ...versions, target: { kind: 'db-url', host: 'x', port: 5432 } }, REF)).toMatch(/db-url/);
    expect(cli.migrationListTargetProblem({ ...versions, target: { kind: 'linked', project_ref: 'zzzzzzzzzzzzzzzzzzzz' } }, REF)).toMatch(/zzzz/);
    expect(cli.migrationListTargetProblem({ ...versions, target: null }, REF)).toMatch(/did not say/);
    // A text table carries no ref, so it is refused too: the scripts always ask for JSON.
    expect(cli.migrationListTargetProblem({ ...versions, target: { kind: 'remote' } }, REF)).toMatch(/remote target/);
  });
});

/** `npx supabase <command…>` segments of an npm script, split on `&&`. */
function supabaseSegments(script: string): string[] {
  return script
    .split('&&')
    .map((segment) => segment.trim())
    .filter((segment) => /\bnpx supabase\s/.test(segment));
}

/** Commands that never select a database or a hosted project. */
const TARGETLESS = /\bnpx supabase\s+(link|start|stop|status|init|--version|-v)\b/;

describe('npm scripts that run the Supabase CLI directly', () => {
  // `db:reset` resets the LOCAL database, the CLI's own default with no --remote, and is never run
  // against a shared one (CLAUDE.md → "Do not modify").
  const LOCAL_BY_DESIGN = new Set(['db:reset']);

  for (const manifest of ['package.json', 'apps/nextblock/package.json']) {
    it(`${manifest}: every database or hosted command passes --remote`, () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8'));
      const offenders: string[] = [];
      for (const [name, script] of Object.entries<string>(pkg.scripts ?? {})) {
        if (LOCAL_BY_DESIGN.has(name)) continue;
        for (const segment of supabaseSegments(script)) {
          if (TARGETLESS.test(segment)) continue;
          if (!/\s--remote(=\S+)?(\s|$)/.test(segment)) offenders.push(`${name}: ${segment}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('db:reset stays local: no --remote, and nothing else selects a hosted project', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:reset']).toMatch(/npx supabase db reset/);
    expect(pkg.scripts['db:reset']).not.toMatch(/--remote|--linked|--db-url|--project-ref/);
  });
});

describe('create-nextblock', () => {
  const source = readFileSync(join(ROOT, 'apps/create-nextblock/bin/create-nextblock.js'), 'utf8');

  it('pushes the schema with --remote=<projectId> and --yes, never a piped "y"', () => {
    const push = /sbArgs\(\[\s*'db',\s*'push'[\s\S]*?\]\)/.exec(source);
    expect(push?.[0]).toMatch(/`--remote=\$\{projectId\}`/);
    expect(push?.[0]).toMatch(/'--yes'/);
    expect(source).not.toMatch(/input:\s*'y\\n'/);
  });

  it('links without --password', () => {
    expect(source).toMatch(/sbArgs\(\['link', '--project-ref', projectId\]\)/);
  });

  it("writes the repo root's supabase devDependency into a scaffold, and its baked-in fallback matches it", () => {
    const fallback = /let supabaseCliVersion = '([^']+)'/.exec(source)?.[1];
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(fallback).toBe(root.devDependencies.supabase);
    expect(root.devDependencies.supabase).toMatch(/^\^3\./);
  });
});
