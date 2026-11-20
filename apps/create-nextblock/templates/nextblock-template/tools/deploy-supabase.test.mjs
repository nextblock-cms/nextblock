import { describe, expect, it } from 'vitest';

import deploySupabase from './deploy-supabase.js';

// tools/deploy-supabase.js (`npm run deploy:supabase`) ships to every standalone project through
// `npm run update`, including projects still on Supabase CLI 2, so it picks its target flags by the
// installed CLI's major version (docs/04 and docs/13 → "Supabase CLI 3"). CommonJS; requiring it
// runs nothing (`deploy()` is guarded by `require.main`).
const { deployCommands, parseSupabaseMajorVersion } = deploySupabase;

const REF = 'abcdefghijklmnopqrst';

describe("a scaffold's tools/deploy-supabase.js", () => {
  const base = { projectRef: REF, dbPassword: 'pw', workDirFlag: '' };

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
    expect(commands.link).toBe(`npx supabase link --project-ref ${REF}`);
    expect(commands.push).toBe(`npx supabase db push --remote=${REF} --password pw --yes`);
    expect(commands.config).toBe(`npx supabase config push --remote=${REF} --yes`);
  });

  it('keeps CLI 2 projects (npm run update ships this file to them) on their explicit --linked target', () => {
    const commands = deployCommands({ ...base, major: 2 });
    expect(commands.push).toBe('npx supabase db push --linked --password pw --yes');
    expect(commands.push).not.toMatch(/--remote/);
    expect(commands.link).toMatch(/--password pw/);
  });

  it('uses the CLI 3 flags when the version cannot be read, so a CLI 2 stops instead of guessing', () => {
    expect(deployCommands({ ...base, major: null }).push).toMatch(new RegExp(`--remote=${REF}`));
  });

  it('carries the monorepo workdir through', () => {
    expect(deployCommands({ ...base, major: 3, workDirFlag: '--workdir ../../libs/db/src' }).push).toBe(
      `npx supabase db push --remote=${REF} --password pw --yes --workdir ../../libs/db/src`,
    );
  });
});
