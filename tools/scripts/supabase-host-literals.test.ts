import { describe, expect, it } from 'vitest';

const { SUPABASE_HOST_LITERALS, findSupabaseHostLiteralProblems, hostLiteralModules, supabaseUrlLiteralsInSource } = require('./lib/supabase-host-literals.js');

type Allowed = Map<string, { literals: string[]; why: string }>;

/** Fixture modules under /repo/. */
function problemsFor(files: Record<string, string>, allowed: Allowed): string[] {
  const modules = new Map(Object.keys(files).map((repoPath) => [`/repo/${repoPath}`, { absolute: `/repo/${repoPath}`, repoPath }]));
  return findSupabaseHostLiteralProblems(modules, allowed, (absolute: string) => files[absolute.slice('/repo/'.length)]);
}

describe('Supabase host literal check', () => {
  it('finds a Supabase URL in a string or template literal, and nothing else', () => {
    const source = [
      '// Fall back to https://dummy.supabase.co in a comment is prose',
      "const a = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy.supabase.co';",
      'const b = `https://${ref}.supabase.co/rest/v1`;',
      'const c = "http://SUPABASE.IN";',
      "const d = 'https://supabase.com/dashboard/project/_/settings/api';",
      "const e = host.endsWith('.supabase.co');",
      "const f = 'https://unconfigured.supabase.invalid';",
      "const g = 'https://example.com/?next=https://abc.supabase.co';",
    ].join('\n');

    expect(supabaseUrlLiteralsInSource('fixture.ts', source)).toEqual([
      { text: 'https://dummy.supabase.co', line: 2 },
      { text: 'https://x.supabase.co/rest/v1', line: 3 },
      { text: 'http://SUPABASE.IN', line: 4 },
      { text: 'https://example.com/?next=https://abc.supabase.co', line: 8 },
    ]);
  });

  it('reads JSX attributes but not JSX text', () => {
    expect(
      supabaseUrlLiteralsInSource(
        'Field.tsx',
        'export const F = () => <label>Like https://ref.supabase.co<input placeholder="https://ref.supabase.co" /></label>;'
      )
    ).toEqual([{ text: 'https://ref.supabase.co', line: 1 }]);
  });

  it('fails a literal the allow-list does not name, a module it cannot parse, and a stale entry', () => {
    expect(
      problemsFor(
        {
          'libs/db/src/lib/supabase/ssg-client.ts': "export const url = process.env.SUPABASE_URL || 'https://dummy.supabase.co';",
          'apps/nextblock/app/setup/Wizard.tsx':
            'export const W = () => <input placeholder="https://YOUR-PROJECT.supabase.co" data-x={"https://other.supabase.co"} />;',
          'apps/nextblock/lib/Broken.tsx': "export const B = () => <a href='https://x.supabase.co'> ;",
          'apps/nextblock/lib/Gone.ts': 'export const nothing = 1;',
        },
        new Map([
          ['apps/nextblock/app/setup/Wizard.tsx', { literals: ['https://YOUR-PROJECT.supabase.co'], why: 'placeholder text' }],
          ['apps/nextblock/lib/Gone.ts', { literals: ['https://gone.supabase.co'], why: 'was here once' }],
        ])
      )
    ).toEqual([
      expect.stringMatching(/^libs\/db\/src\/lib\/supabase\/ssg-client\.ts \(line 1\) writes a Supabase URL into code: "https:\/\/dummy\.supabase\.co"\. .*UNCONFIGURED_SUPABASE_URL/),
      expect.stringMatching(/^apps\/nextblock\/app\/setup\/Wizard\.tsx \(line 1\) writes a Supabase URL into code: "https:\/\/other\.supabase\.co"/),
      'apps/nextblock/lib/Broken.tsx cannot be parsed, so the Supabase host scan cannot check it: fix the syntax error.',
      'SUPABASE_HOST_LITERALS lists "https://gone.supabase.co" for apps/nextblock/lib/Gone.ts, which no longer holds it: remove the entry.',
    ]);
  });

  it('says why each allow-listed literal never becomes a request target', () => {
    for (const [repoPath, { literals, why }] of SUPABASE_HOST_LITERALS as Allowed) {
      expect(literals.length, repoPath).toBeGreaterThan(0);
      expect(why.trim(), repoPath).not.toBe('');
    }
  });
});

describe('the repository', () => {
  // Scanned once at collection time, like the other repository-wide gates.
  const modules: Map<string, { absolute: string; repoPath: string }> = hostLiteralModules();
  const problems: string[] = findSupabaseHostLiteralProblems(modules);

  it('writes no Supabase host into apps/nextblock or libs', () => {
    expect(problems).toEqual([]);
  });

  // The service-role boundary scan skips these folders (nothing bundles them), but they ship in
  // every scaffold: tools/build-migrate.mjs is its `prebuild`, so it runs before /setup.
  it('reads the build hook and the Node scripts too, but not their tests', () => {
    const paths = new Set([...modules.values()].map((mod) => mod.repoPath));
    for (const shipped of ['apps/nextblock/tools/build-migrate.mjs', 'apps/nextblock/tools/lib/migrate-core.mjs', 'apps/nextblock/tools/update.mjs', 'apps/nextblock/scripts/backup.js']) {
      expect(paths.has(shipped), shipped).toBe(true);
    }
    expect(paths.has('apps/nextblock/tools/lib/migrate-core.test.mjs')).toBe(false);
    expect(paths.has('libs/db/src/lib/supabase/unconfigured.ts')).toBe(true);
  });
});
