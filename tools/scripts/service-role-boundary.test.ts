import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const {
  RESOLVE_EXTENSIONS,
  analyzeModule,
  clientSafeEntries,
  createResolver,
  directiveOf,
  findBundlerProblems,
  findClientGraphLeaks,
  findPublicSecretExposure,
  findStaleTwinImports,
  findUnguardedServiceRoleModules,
  importSpecifiers,
  inspectNextConfig,
  isSecretEnvName,
  moduleRecord,
  scanRepository,
  serviceRoleMarkers,
  stripComments,
} = require('./lib/service-role-boundary.js');

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` into a fresh temp directory and scan them like the repository scan does. */
function project(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nb-boundary-'));
  temporaryDirs.push(dir);
  const modules = new Map();
  for (const [name, source] of Object.entries(files)) {
    const absolute = path.join(dir, name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  for (const [name, source] of Object.entries(files)) {
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    const absolute = path.join(dir, name);
    modules.set(absolute, moduleRecord(absolute, source));
  }
  return { dir, modules };
}

const leaksIn = (files: Record<string, string>) => {
  const { modules } = project(files);
  return findClientGraphLeaks(modules, createResolver(), []).map((p: { problem: string }) => p.problem) as string[];
};

const SERVER = "import 'server-only';\nexport const secret = () => process.env.SUPABASE_SECRET_KEY;\n";

describe('service-role boundary helpers', () => {
  it('ignores comments but keeps import specifiers', () => {
    const code = stripComments(
      [
        '// getServiceRoleSupabaseClient() in a comment',
        '/* process.env.SUPABASE_SERVICE_ROLE_KEY */',
        "import x from './x';",
        "const url = 'https://example.com//path';",
      ].join('\n'),
    );
    expect(serviceRoleMarkers(code)).toEqual([]);
    expect(code).toContain("'./x'");
    expect(code).toContain("'https://example.com//path'");
  });

  it('recognises every service-role marker', () => {
    expect(serviceRoleMarkers('const c = getServiceRoleSupabaseClient();')).toEqual(['service-role client factory']);
    expect(serviceRoleMarkers('const k = resolveSupabaseServiceKey();')).toEqual(['service-role key resolver']);
    expect(serviceRoleMarkers("const k = process.env['SUPABASE_SECRET_KEY'];")).toEqual(['secret key read from process.env']);
    expect(serviceRoleMarkers('const k = process.env.SUPABASE_SERVICE_ROLE_KEY;')).toEqual(['secret key read from process.env']);
    expect(serviceRoleMarkers('const { supabase } = await requireCmsAdmin();')).toEqual(['verified-role-then-service-role helper']);
    expect(serviceRoleMarkers("label: 'SUPABASE_SERVICE_ROLE_KEY'")).toEqual([]);
  });

  it('reads the module directive', () => {
    expect(directiveOf("'use client';\nimport x from 'y';")).toBe('use client');
    expect(directiveOf('\n"use server"\n')).toBe('use server');
    expect(directiveOf("import x from 'y';\n'use client';")).toBeNull();
  });

  it('drops type-only imports and keeps every runtime form', () => {
    const specs = importSpecifiers(
      [
        "import type { A } from './types';",
        "import { type B, type C } from './only-types';",
        "import { type D, e } from './mixed';",
        "import f from './default';",
        "import './side-effect';",
        "export * from './barrel';",
        "export type { G } from './type-barrel';",
        "const h = await import('./lazy');",
        "const i = require('./cjs');",
      ].join('\n'),
    );
    expect(specs.sort()).toEqual(['./barrel', './cjs', './default', './lazy', './mixed', './side-effect'].sort());
  });
});

/* ------------------------------------------------------------------------------------------
 * Bypasses found by the 2026-10-21 review. Every case below passed the check before the fix.
 * ---------------------------------------------------------------------------------------- */

describe('module analysis uses the TypeScript parser', () => {
  it('a regex literal containing /* does not blind the rest of the file', () => {
    const source = [
      "'use client';",
      "const trim = (p: string) => p.replace(/\\/*$/, '');",
      "const Panel = dynamic(() => import('./admin-panel'));",
      'export const wipe = () => getServiceRoleSupabaseClient();',
    ].join('\n');
    // the repository scan path: the old hand-rolled stripComments read `/*$/...` as a comment
    // and dropped everything after it
    const record = analyzeModule(source, 'rx.ts');
    expect(record.directive).toBe('use client');
    expect(record.markers).toEqual(['service-role client factory']);
    expect(record.imports).toContain('./admin-panel');
    expect(stripComments(source, 'rx.ts')).toContain('getServiceRoleSupabaseClient()');
  });

  it('reads code inside JSX and template literals, and nothing inside comments', () => {
    const source = [
      "export const A = () => <p>Don't // stop {getServiceRoleSupabaseClient().from('x')}</p>;",
      '/* resolveSupabaseServiceKey() */',
      'export const t = `${process.env.SUPABASE_SECRET_KEY}`;',
    ].join('\n');
    expect(serviceRoleMarkers(source).sort()).toEqual(['secret key read from process.env', 'service-role client factory']);
  });
});

describe('service-role markers', () => {
  const SECRET = ['secret key read from process.env'];

  it('sees the secret key however the env object is reached', () => {
    for (const source of [
      'const { SUPABASE_SECRET_KEY } = process.env;',
      'const { SUPABASE_SERVICE_ROLE_KEY: key } = process.env;',
      'const k = process?.env?.SUPABASE_SECRET_KEY;',
      'const env = process.env;\nconst k = env.SUPABASE_SERVICE_ROLE_KEY;',
      'const { env } = process;\nconst k = env["SUPABASE_SECRET_KEY"];',
      'const k = import.meta.env.SUPABASE_SECRET_KEY;',
      "const k = (process.env as Record<string, string>)['SUPABASE_SECRET_KEY'];",
      'const k = process.env[`SUPABASE_SECRET_KEY`];',
      "const names = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'];\nconst k = names.map((n) => process.env[n]).find(Boolean);",
      "const all = { ...process.env };\nconst k = all['SUPABASE_SECRET_KEY'];",
    ]) {
      expect(serviceRoleMarkers(source, 'a.ts'), source).toEqual(SECRET);
    }
  });

  it('is not fooled by public names, labels or dynamic reads without a secret name', () => {
    for (const source of [
      'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;',
      "const label = 'SUPABASE_SECRET_KEY is missing';",
      'const read = (name: string) => process.env[name];',
      "const { NEXT_PUBLIC_URL } = process.env;",
    ]) {
      expect(serviceRoleMarkers(source, 'a.ts'), source).toEqual([]);
    }
  });

  it('sees the factory aliased, uncalled, re-exported under another name or read by key', () => {
    const FACTORY = ['service-role client factory'];
    for (const source of [
      "import { getServiceRoleSupabaseClient as admin } from '@nextblock-cms/db/server';\nexport const wipe = () => admin().from('orders').delete();",
      "import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';\nconst make = getServiceRoleSupabaseClient;\nexport const wipe = () => make();",
      "export { getServiceRoleSupabaseClient as adminClient } from '@nextblock-cms/db/server';",
      "import * as db from '@nextblock-cms/db/server';\nexport const wipe = () => db['getServiceRoleSupabaseClient']();",
      "import * as db from '@nextblock-cms/db/server';\nexport const wipe = () => db.getServiceRoleSupabaseClient().from('orders').delete();",
    ]) {
      expect(serviceRoleMarkers(source, 'a.ts'), source).toEqual(FACTORY);
    }
  });

  it('a same-name re-export and type-only uses are not markers (the graph check follows the barrel)', () => {
    for (const source of [
      "export { getServiceRoleSupabaseClient } from './lib/supabase/server';",
      "import type { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';\ntype Admin = ReturnType<typeof getServiceRoleSupabaseClient>;",
    ]) {
      expect(serviceRoleMarkers(source, 'a.ts'), source).toEqual([]);
    }
  });

  it('flags each bypass as an unguarded service-role module', () => {
    const { modules } = project({ 'a.ts': 'const { SUPABASE_SECRET_KEY } = process.env;\nexport const k = SUPABASE_SECRET_KEY;' });
    expect(findUnguardedServiceRoleModules(modules)).toEqual([expect.objectContaining({ problem: expect.stringMatching(/without import 'server-only'/) })]);
  });
});

describe('client graphs', () => {
  it('follows a template-literal dynamic import, with next/dynamic too', () => {
    expect(leaksIn({ 'c.tsx': "'use client';\nexport const load = () => import(`./srv`);", 'srv.ts': SERVER })).toHaveLength(1);
    expect(
      leaksIn({
        'c.tsx': "'use client';\nimport dynamic from 'next/dynamic';\nexport const X = dynamic(() => import(`./srv`));",
        'srv.ts': SERVER,
      }),
    ).toHaveLength(1);
  });

  it('follows a dynamic import with substitutions to every file it can match', () => {
    const files = {
      'c.tsx': "'use client';\nexport const load = (lang: string) => import(`./locales/${lang}`);",
      'locales/en.ts': 'export default {};',
      'locales/admin.ts': SERVER,
    };
    expect(leaksIn(files)).toEqual([expect.stringMatching(/locales\/admin\.ts, which imports 'server-only'/)]);
  });

  it("treats 'use client' after 'use strict' as a client module", () => {
    expect(directiveOf("'use strict';\n'use client';\nexport const a = 1;")).toBe('use client');
    expect(leaksIn({ 'c.tsx': "'use strict';\n'use client';\nimport { secret } from './srv';\nexport const C = () => secret();", 'srv.ts': SERVER })).toHaveLength(1);
  });

  it('scans and resolves .cts modules', () => {
    expect(leaksIn({ 'c.tsx': "'use client';\nimport { secret } from './srv.cjs';\nexport const C = () => secret();", 'srv.cts': SERVER })).toHaveLength(1);
  });

  it("never walks into a 'use server' module, not even a root", () => {
    expect(leaksIn({ 'c.tsx': "'use client';\nimport { act } from './actions';\nexport const C = () => act();", 'actions.ts': "'use server';\nimport { secret } from './srv';\nexport async function act() { return secret(); }", 'srv.ts': SERVER })).toEqual([]);
  });

  it('refuses an explicit import of a stale compiled .js twin (the bundler loads the .js, which has no guard)', () => {
    const { modules } = project({
      'a.ts': "import { secret } from './srv.js';\nexport const k = secret();",
      'srv.ts': SERVER,
      'srv.js': 'export const secret = () => process.env.SUPABASE_SECRET_KEY;',
    });
    expect(findStaleTwinImports(modules, createResolver())).toEqual([expect.objectContaining({ problem: expect.stringMatching(/stale compiled twin .*srv\.js/) })]);
  });
});

describe('client-safe library entries come from package.json exports', () => {
  it('derives the roots from every lib manifest and fails when one is missing', () => {
    const { entries, problems } = clientSafeEntries();
    expect(problems).toEqual([]);
    const paths = entries.map((e: { repoPath: string }) => e.repoPath);
    for (const expected of ['libs/db/src/index.ts', 'libs/utils/src/lib/seo/index.ts', 'libs/utils/src/lib/custom-blocks.ts', 'libs/cortex/src/client.ts', 'libs/ui/src/index.ts', 'libs/editor/src/index.ts', 'libs/sdk/src/index.ts', 'libs/ecommerce/src/index.ts']) {
      expect(paths).toContain(expected);
    }
    for (const server of ['libs/db/src/server.ts', 'libs/db/src/secrets.ts', 'libs/utils/src/server.ts', 'libs/ecommerce/src/server.ts', 'libs/cortex/src/index.ts']) {
      expect(paths).not.toContain(server);
    }
  });

  it('reports an export that maps to no source file, a stale server-entry declaration and a lib without a manifest', () => {
    const { dir } = project({
      'libs/alpha/package.json': JSON.stringify({ name: '@x/alpha', exports: { '.': './src/index.ts', './gone': './src/gone.ts' } }),
      'libs/alpha/src/index.ts': 'export const a = 1;',
      'libs/beta/src/index.ts': 'export const b = 1;',
    });
    const { problems } = clientSafeEntries({ libsDir: path.join(dir, 'libs'), serverEntries: { alpha: { './server': 'test' } } });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/alpha.*\.\/gone.*no source file/),
        expect.stringMatching(/alpha.*\.\/server.*not exported/),
        expect.stringMatching(/beta.*no package\.json/),
      ]),
    );
  });
});

describe('secrets behind NEXT_PUBLIC_ names and next.config', () => {
  it('treats every secret-looking NEXT_PUBLIC_ name as a leak, except the public key kinds', () => {
    for (const name of ['NEXT_PUBLIC_SUPABASE_SERVICE_KEY', 'NEXT_PUBLIC_SUPABASE_ADMIN_KEY', 'NEXT_PUBLIC_MCP_BEARER_TOKEN', 'NEXT_PUBLIC_OPENROUTER_API_KEY', 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_STRIPE_SECRET_KEY']) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'NEXT_PUBLIC_URL']) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
    const { modules } = project({ 'a.ts': 'export const t = process.env.NEXT_PUBLIC_MCP_BEARER_TOKEN;' });
    expect(findPublicSecretExposure(modules).map((p: { problem: string }) => p.problem)).toContainEqual(expect.stringMatching(/NEXT_PUBLIC_MCP_BEARER_TOKEN/));
  });

  const configProblems = async (files: Record<string, string>) => {
    const { dir } = project(files);
    return (await inspectNextConfig({ appDir: dir })).problems as string[];
  };
  const PIN = "turbopack: { resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.node'] }";

  it('fails when there is no next.config to read', async () => {
    expect(await configProblems({ 'README.md': '' })).toEqual([expect.stringMatching(/no next\.config/)]);
  });

  it('evaluates the config and inspects the resolved env and compiler.define', async () => {
    for (const config of [
      `module.exports = { ${PIN}, env: { NEXT_PUBLIC_X: process.env.SUPABASE_SECRET_KEY } };`,
      `const env = { NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_SECRET_KEY };\nmodule.exports = { ${PIN}, env };`,
      `const pub = { NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_SECRET_KEY };\nmodule.exports = { ${PIN}, env: { ...pub } };`,
      `module.exports = { ${PIN}, experimental: { env: {} }, env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_SECRET_KEY } };`,
      `module.exports = { ${PIN}, compiler: { define: { 'process.env.NEXT_PUBLIC_ADMIN': JSON.stringify(process.env.SUPABASE_SECRET_KEY) } } };`,
      `const { key } = require('./secret-helper');\nmodule.exports = { ${PIN}, env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: key() } };`,
      `module.exports = { ${PIN}, env: { NEXT_PUBLIC_K: process.env.NB_NEVER_SET ? process.env.SUPABASE_SERVICE_ROLE_KEY : '' } };`,
      `module.exports = () => ({ ${PIN}, env: { NEXT_PUBLIC_K: process.env.SUPABASE_SECRET_KEY } });`,
      `module.exports = { ${PIN}, env: { MCP_BEARER_TOKEN: 'inlined' } };`,
    ]) {
      const problems = await configProblems({
        'next.config.js': config,
        'secret-helper.js': 'exports.key = () => process.env.SUPABASE_SECRET_KEY;',
      });
      expect(problems.length, config).toBeGreaterThan(0);
    }
  });

  it('reads next.config.mjs and next.config.ts too', async () => {
    expect(await configProblems({ 'next.config.mjs': `export default { ${PIN}, env: { NEXT_PUBLIC_X: process.env.SUPABASE_SECRET_KEY } };` })).not.toEqual([]);
    expect(
      await configProblems({ 'next.config.ts': `const config: { env: Record<string, string | undefined> } = { ${PIN}, env: { NEXT_PUBLIC_X: process.env.SUPABASE_SECRET_KEY } } as never;\nexport default config;` }),
    ).not.toEqual([]);
    expect(await configProblems({ 'next.config.ts': `export default { ${PIN}, env: { NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL } };` })).toEqual([]);
  });

  it('requires turbopack.resolveExtensions with TypeScript before JavaScript (stale .js twins)', async () => {
    expect(await configProblems({ 'next.config.js': 'module.exports = {};' })).toEqual([expect.stringMatching(/resolveExtensions/)]);
    expect(await configProblems({ 'next.config.js': "module.exports = { turbopack: { resolveExtensions: ['.js', '.ts', '.tsx'] } };" })).toEqual([
      expect.stringMatching(/resolveExtensions/),
    ]);
  });
});

describe('the service-role boundary holds across the repository', () => {
  const modules = scanRepository();

  it('scans the app and every library', () => {
    const paths = [...modules.values()].map((m: { repoPath: string }) => m.repoPath);
    expect(paths).toContain('libs/db/src/lib/supabase/server.ts');
    expect(paths).toContain('apps/nextblock/lib/auth/cms-actor.ts');
    expect(paths).toContain('apps/nextblock/app/.well-known/mcp/server-card.json/route.ts');
    expect(paths.some((p: string) => p.includes('/templates/') || p.endsWith('.test.ts'))).toBe(false);
  });

  it("every module that builds, hands out or keys a service-role client imports 'server-only'", () => {
    expect(findUnguardedServiceRoleModules(modules).map((p: { problem: string }) => p.problem)).toEqual([]);
  });

  it("no 'use client' file or client-safe library entry reaches server-only or service-role code", () => {
    expect(findClientGraphLeaks(modules).map((p: { problem: string }) => p.problem)).toEqual([]);
  });

  it('no module imports a stale compiled .js twin explicitly', () => {
    expect(findStaleTwinImports(modules).map((p: { problem: string }) => p.problem)).toEqual([]);
  });

  it('no secret is exposed through NEXT_PUBLIC_ or next.config env / compiler.define', async () => {
    expect(findPublicSecretExposure(modules).map((p: { problem: string }) => p.problem)).toEqual([]);
    expect((await inspectNextConfig()).problems).toEqual([]);
  });

  it('next.config.js pins TypeScript-first resolution, the order this check resolves in, and no build opts into webpack', async () => {
    const { config } = await inspectNextConfig();
    const pinned: string[] = config.turbopack.resolveExtensions;
    const shared = RESOLVE_EXTENSIONS.filter((ext: string) => pinned.includes(ext));
    expect(shared).toEqual(pinned.filter((ext: string) => RESOLVE_EXTENSIONS.includes(ext)));
    expect(findBundlerProblems()).toEqual([]);
    expect(readFileSync(path.resolve(__dirname, '../../apps/nextblock/next.config.js'), 'utf8')).toContain('resolveExtensions');
  });
});
