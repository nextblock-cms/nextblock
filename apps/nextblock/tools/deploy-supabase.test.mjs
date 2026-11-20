import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import deploySupabase from './deploy-supabase.js';

// tools/deploy-supabase.js (`npm run deploy:supabase`) ships to every standalone project through
// `npm run update`, including projects still on Supabase CLI 2, so it picks its target flags by the
// installed CLI's major version (docs/04 and docs/13 → "Supabase CLI 3"). CommonJS; requiring it
// runs nothing (`deploy()` is guarded by `require.main`).
const { deployCommands, parseSupabaseMajorVersion, printableCommand, supabaseCliInvocation } = deploySupabase;

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = 'abcdefghijklmnopqrst';

describe("a scaffold's tools/deploy-supabase.js", () => {
  const base = { projectRef: REF, dbPassword: 'pw', workDirArgs: [] };

  it('reads the installed major from `supabase --version`, never from CLI 2\'s update notice', () => {
    // Both as the real binaries print them (3.2.0; 2.122.1 with its notice on the next lines).
    expect(parseSupabaseMajorVersion('3.2.0\n')).toBe(3);
    expect(
      parseSupabaseMajorVersion(
        '2.122.1\nA new version of Supabase CLI is available: v3.2.0 (currently installed v2.122.1)\nWe recommend updating regularly\n',
      ),
    ).toBe(2);
    expect(parseSupabaseMajorVersion('A new version of Supabase CLI is available: v3.2.0 (currently installed v2.122.1)')).toBeNull();
    expect(parseSupabaseMajorVersion('')).toBeNull();
  });

  it('names the project with --remote=<ref> on CLI 3, and links without --password', () => {
    const commands = deployCommands({ ...base, major: 3 });
    expect(commands.link).toEqual(['link', '--project-ref', REF]);
    expect(commands.push).toEqual(['db', 'push', `--remote=${REF}`, '--password', 'pw', '--yes']);
    expect(commands.config).toEqual(['config', 'push', `--remote=${REF}`, '--yes']);
  });

  it('keeps CLI 2 projects (npm run update ships this file to them) on their explicit --linked target', () => {
    const commands = deployCommands({ ...base, major: 2 });
    expect(commands.push).toEqual(['db', 'push', '--linked', '--password', 'pw', '--yes']);
    expect(commands.push.join(' ')).not.toMatch(/--remote/);
    expect(commands.link).toEqual(['link', '--project-ref', REF, '--password', 'pw', '--yes']);
  });

  it('uses the CLI 3 flags when the version cannot be read, so a CLI 2 stops instead of guessing', () => {
    expect(deployCommands({ ...base, major: null }).push).toContain(`--remote=${REF}`);
  });

  it('carries the monorepo workdir through as two arguments', () => {
    expect(deployCommands({ ...base, major: 3, workDirArgs: ['--workdir', '../../libs/db/src'] }).push).toEqual([
      'db', 'push', `--remote=${REF}`, '--password', 'pw', '--yes', '--workdir', '../../libs/db/src',
    ]);
  });

  it('keeps a password with shell metacharacters as ONE argument, and prints it masked', () => {
    const password = 'p&w|o"r^d%x$y;z`';
    const push = deployCommands({ ...base, major: 3, dbPassword: password }).push;
    expect(push[push.indexOf('--password') + 1]).toBe(password);
    const shown = printableCommand(push, password);
    expect(shown).toBe(`supabase db push --remote=${REF} --password <db-password> --yes`);
    expect(shown).not.toContain(password);
  });
});

describe("deploy-supabase.js's supabaseCliInvocation (no shell)", () => {
  const fakePackage = (bin) => ({
    resolvePackageJson: () => '/p/node_modules/supabase/package.json',
    readFile: () => JSON.stringify({ version: '9.9.9', bin }),
    nodePath: '/usr/bin/node',
  });

  it('runs a Node-script bin (2.117+ and 3.x) under this Node', () => {
    expect(supabaseCliInvocation(fakePackage({ supabase: 'dist/supabase.js' }))).toEqual({
      command: '/usr/bin/node',
      prefix: [path.resolve('/p/node_modules/supabase', 'dist/supabase.js')],
    });
  });

  it('starts a binary bin directly, with its .exe on Windows', () => {
    const bin = path.resolve('/p/node_modules/supabase', 'bin/supabase');
    expect(supabaseCliInvocation({ ...fakePackage({ supabase: 'bin/supabase' }), platform: 'linux' })).toEqual({ command: bin, prefix: [] });
    expect(
      supabaseCliInvocation({ ...fakePackage('bin/supabase'), platform: 'win32', exists: (file) => file === `${bin}.exe` }),
    ).toEqual({ command: `${bin}.exe`, prefix: [] });
  });

  it('falls back to npm exec through npm-cli.js when no supabase package is installed, and refuses otherwise', () => {
    const missing = () => {
      throw new Error('Cannot find module');
    };
    expect(
      supabaseCliInvocation({ resolvePackageJson: missing, nodePath: '/usr/bin/node', npmExecPath: '/npm/bin/npm-cli.js' }),
    ).toEqual({ command: '/usr/bin/node', prefix: ['/npm/bin/npm-cli.js', 'exec', '--yes', '--', 'supabase'] });
    // '' rather than undefined, which would take the default: vitest itself runs under npm.
    expect(() => supabaseCliInvocation({ resolvePackageJson: missing, npmExecPath: '' })).toThrow(/Run `npm install`/);
    expect(() => supabaseCliInvocation(fakePackage(undefined))).toThrow(/no `supabase` bin/);
  });

  it('never builds a command string or turns a shell on', () => {
    // Code only: the comments explain why, naming what they forbid.
    const source = readFileSync(path.join(here, 'deploy-supabase.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).toMatch(/spawnSync\(cli\.command, \[\.\.\.cli\.prefix, \.\.\.args\]/);
    // child_process's exec / execSync (a RegExp's `.exec(` is fine).
    expect(source).not.toMatch(/\bexecSync\b|(?<![.\w])exec\(|shell\s*:/);
    expect(source).not.toMatch(/['"`]npx(\.cmd)?\b/);
  });

  it("starts this project's installed CLI with no shell", () => {
    const cli = supabaseCliInvocation({ from: here });
    const result = spawnSync(cli.command, [...cli.prefix, '--version'], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(parseSupabaseMajorVersion(result.stdout)).toBeGreaterThanOrEqual(2);
  });

  // The monorepo's tools/scripts/lib/supabase-cli.js carries the same function (a standalone project
  // has no tools/scripts, so this case runs in the monorepo only).
  const monorepoLib = path.join(here, '../../../tools/scripts/lib/supabase-cli.js');
  it.skipIf(!existsSync(monorepoLib))('answers as the monorepo copy does', () => {
    const { supabaseCliInvocation: monorepoInvocation } = createRequire(import.meta.url)(monorepoLib);
    expect(supabaseCliInvocation({ from: here })).toEqual(monorepoInvocation({ from: here }));
    for (const bin of [{ supabase: 'dist/supabase.js' }, 'bin/supabase']) {
      for (const platform of ['linux', 'win32']) {
        const options = { ...fakePackage(bin), platform, exists: () => true };
        expect(supabaseCliInvocation(options)).toEqual(monorepoInvocation(options));
      }
    }
  });
});
