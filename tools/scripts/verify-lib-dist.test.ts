import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// CommonJS script; its CLI entry is guarded by `require.main`, so requiring it runs nothing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  findModuleFormatProblems,
  findPackagePageProblems,
  findSideEffectsProblems,
  findUndeclaredSiblingImports,
  findWorkspaceProtocolDependencies,
} = require('./verify-lib-dist.js');
const { AFFILIATES_EXPORTS, publishExportsFor } = require('./lib-publish-exports.js');

const dirs: string[] = [];

/** A throwaway dist directory holding exactly `files`. */
function dist(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-lib-dist-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ESM = 'import { x } from "y";\nexport const a = x;\n';
const CJS = 'Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});let e=require("y");exports.a=e.x;';

describe('findModuleFormatProblems (check 7)', () => {
  it('passes a package whose CommonJS files are .cjs and whose directives match', () => {
    const dir = dist({
      'package.json': {
        type: 'module',
        main: './index.cjs',
        exports: { '.': { import: './index.es.js', require: './index.cjs' } },
      },
      'index.es.js': `'use client';\n${ESM}`,
      'index.cjs': `"use client";${CJS}`,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([]);
  });

  it('rejects CommonJS named .js in a "type": "module" package (cortex/ecom through 0.20)', () => {
    const dir = dist({
      'package.json': {
        type: 'module',
        main: './index.cjs.js',
        exports: { '.': { import: './index.es.js', require: './index.cjs.js' } },
      },
      'index.es.js': ESM,
      'index.cjs.js': CJS,
    });
    const problems = findModuleFormatProblems('fixture', dir);
    expect(problems).toContain(
      '"main" is ./index.cjs.js: this package is "type": "module", so a CommonJS file needs the .cjs extension'
    );
    expect(problems).toContain(
      '"exports" . require is ./index.cjs.js: this package is "type": "module", so a CommonJS file needs the .cjs extension'
    );
    expect(problems).toContain(
      'index.cjs.js is CommonJS in a "type": "module" package, so Node loads it as ESM; emit it as .cjs'
    );
  });

  it("rejects a 'use client' that only the ESM entry carries (ui/editor through 0.20)", () => {
    const dir = dist({
      'package.json': { exports: { '.': { import: './index.mjs', require: './index.js' } } },
      'index.mjs': `'use client';\n${ESM}`,
      'index.js': CJS,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([
      '"exports" .: ./index.mjs starts with use client but ./index.js starts with none; ' +
        'a require() consumer would get a different kind of module',
    ]);
  });

  it("compares a { require, default } export, the shape utils and db publish (utils' server entry through 0.20)", () => {
    const dir = dist({
      'package.json': {
        exports: { './server': { types: './server.d.ts', require: './server.cjs.js', default: './server.es.js' } },
      },
      'server.es.js': `'use server';\n${ESM}`,
      'server.cjs.js': CJS,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([
      '"exports" ./server: ./server.es.js starts with use server but ./server.cjs.js starts with none; ' +
        'a require() consumer would get a different kind of module',
    ]);
  });

  it('compares every module behind a wildcard export', () => {
    const dir = dist({
      'package.json': {
        type: 'module',
        exports: { './*': { types: './lib/*.d.ts', import: './lib/*.es.js', require: './lib/*.cjs' } },
      },
      'lib/components/Cart.es.js': `'use client';\n${ESM}`,
      'lib/components/Cart.cjs': CJS,
      'lib/types.es.js': ESM,
      'lib/types.cjs': CJS,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([
      '"exports" ./components/Cart: ./lib/components/Cart.es.js starts with use client but ' +
        './lib/components/Cart.cjs starts with none; a require() consumer would get a different kind of module',
    ]);
  });

  it('does not take ESM that mentions exports in a string for CommonJS', () => {
    const dir = dist({
      'package.json': { type: 'module', exports: { '.': { import: './index.es.js', require: './index.cjs' } } },
      'index.es.js': 'export const hint = "never write module.exports = {} or exports.x = 1 here";\n',
      'index.cjs': CJS,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([]);
  });

  it('reads directives after comments and "use strict"', () => {
    const dir = dist({
      'package.json': { exports: { './server': { import: './server.es.js', require: './server.cjs.js' } } },
      'server.es.js': `/* banner */\n'use server';\n${ESM}`,
      'server.cjs.js': `"use strict";\n// generated\n"use server";${CJS}`,
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([]);
  });

  it('rejects main/module fields that name files the build never wrote (ui through 0.20)', () => {
    const dir = dist({
      'package.json': {
        main: 'index.cjs.js',
        module: 'index.es.js',
        types: 'index.d.ts',
        exports: { '.': { import: './index.mjs', require: './index.js' } },
      },
      'index.mjs': ESM,
      'index.js': CJS,
      'index.d.ts': 'export declare const a: number;\n',
    });
    expect(findModuleFormatProblems('fixture', dir)).toEqual([
      '"main" is index.cjs.js, which the build did not write',
      '"module" is index.es.js, which the build did not write',
    ]);
  });
});

describe('findWorkspaceProtocolDependencies (check 9)', () => {
  const RAW_PREMIUM_MANIFEST = {
    name: '@nextblock-cms/affiliates',
    dependencies: { '@nextblock-cms/utils': 'workspace:*', zod: '^4.6.7' },
    peerDependencies: { react: '^19.2.5' },
    nx: { tags: ['scope:premium'] },
  };

  it('refuses a workspace: spec in the manifest that will be published', () => {
    const dir = dist({ 'package.json': RAW_PREMIUM_MANIFEST });
    expect(findWorkspaceProtocolDependencies('affiliates', dir, { manifestFinalized: true })).toEqual([
      'dependencies["@nextblock-cms/utils"] is "workspace:*": npm cannot install the workspace protocol; resolve it to a published version (release-lib.js finalizes premium manifests through publishExportsFor)',
    ]);
  });

  it('refuses one in every install section, and in a lib release-lib.js never finalizes', () => {
    const dir = dist({
      'package.json': {
        name: '@nextblock-cms/example',
        dependencies: { '@nextblock-cms/ui': 'workspace:^' },
        optionalDependencies: { '@nextblock-cms/sdk': ' workspace:~' },
        peerDependencies: { '@nextblock-cms/db': 'workspace:*' },
      },
    });
    // 'example' has no publishExportsFor map, so its dist manifest is final even after a plain build.
    expect(findWorkspaceProtocolDependencies('example', dir)).toHaveLength(3);
  });

  it('lets a plain build of a finalized lib through: release-lib.js resolves its dependencies before publishing', () => {
    const dir = dist({ 'package.json': RAW_PREMIUM_MANIFEST });
    expect(findWorkspaceProtocolDependencies('affiliates', dir)).toEqual([]);
    expect(findWorkspaceProtocolDependencies('cortex', dir)).toEqual([]);
    expect(
      findWorkspaceProtocolDependencies('affiliates', dist({ 'package.json': { devDependencies: { x: 'workspace:*' } } }))
    ).toHaveLength(1);
  });

  it('passes resolved manifests and a missing manifest (check 5 reports that)', () => {
    const resolved = dist({
      'package.json': { dependencies: { '@nextblock-cms/utils': '^0.22.5', '@nextblock-cms/ecommerce': 'npm:@nextblock-cms/ecom@^0.22.5' } },
    });
    expect(findWorkspaceProtocolDependencies('affiliates', resolved, { manifestFinalized: true })).toEqual([]);
    expect(findWorkspaceProtocolDependencies('affiliates', dist({}), { manifestFinalized: true })).toEqual([]);
  });

  it('knows affiliates as a finalized lib with its three entry points', () => {
    expect(publishExportsFor('affiliates')).toBe(AFFILIATES_EXPORTS);
    expect(Object.keys(AFFILIATES_EXPORTS)).toEqual(['.', './editor', './server', './package.json']);
    for (const key of ['.', './editor', './server']) {
      expect(AFFILIATES_EXPORTS[key].require).toMatch(/\.cjs$/);
      expect(AFFILIATES_EXPORTS[key].import).toMatch(/\.es\.js$/);
    }
    // The source manifest the build copies declares the same map.
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../libs/affiliates/package.json'), 'utf8'));
    expect(manifest.exports).toEqual(AFFILIATES_EXPORTS);
  });
});

describe('findPackagePageProblems (check 8)', () => {
  const MANIFEST = {
    name: '@nextblock-cms/example',
    license: 'AGPL-3.0-or-later',
    repository: { type: 'git', url: 'git+https://github.com/nextblock-cms/nextblock.git', directory: 'libs/example' },
  };
  // The packed file list is passed in, so these tests never run `npm pack`.
  const PACKED = new Set(['package.json', 'README.md', 'index.js']);

  it('passes a real README with absolute links and a manifest with license and repository', () => {
    const dir = dist({
      'package.json': MANIFEST,
      'README.md': '# Example\n\nSee [the docs](https://github.com/nextblock-cms/nextblock) and [below](#usage).\n',
    });
    expect(findPackagePageProblems('fixture', dir, PACKED)).toEqual([]);
  });

  it('rejects a tarball without a README, and a manifest without license or repository', () => {
    const dir = dist({ 'package.json': { name: '@nextblock-cms/example' } });
    expect(findPackagePageProblems('fixture', dir, new Set(['package.json']))).toEqual([
      "the tarball has no README.md: copy the lib's README into the dist folder",
      'package.json has no "license"',
      'package.json has no "repository"',
    ]);
  });

  it("rejects Nx's generated stub and links that only resolve inside the monorepo", () => {
    const dir = dist({
      'package.json': MANIFEST,
      'README.md': '# ui\n\nThis library was generated with [Nx](https://nx.dev).\n\n- [Docs](../../docs/03-CMS-AND-EDITOR.md)\n',
    });
    expect(findPackagePageProblems('fixture', dir, PACKED)).toEqual([
      'README.md is Nx\'s generated stub ("This library was generated with Nx"); write a real one',
      'README.md links to "../../docs/03-CMS-AND-EDITOR.md", which only resolves inside the monorepo; use an absolute URL',
    ]);
  });
});

describe('findSideEffectsProblems (check 10)', () => {
  const SIDE_EFFECTS = [
    './src/server.ts',
    './src/lib/zod-config.ts',
    './server.es.js',
    './server.cjs',
    './lib/zod-config.es.js',
    './lib/zod-config.cjs',
  ];
  const SOURCE = { name: '@nextblock-cms/affiliates', sideEffects: SIDE_EFFECTS };
  // The packed file list is passed in, so these tests never run `npm pack`.
  const PACKED = new Set([
    'package.json',
    'index.es.js',
    'index.cjs',
    'server.es.js',
    'server.cjs',
    'lib/zod-config.es.js',
    'lib/zod-config.cjs',
    'lib/styles/base.css',
  ]);

  it('passes a dist manifest that carries the source list, with every dist entry in the tarball', () => {
    const dir = dist({ 'package.json': SOURCE });
    // The ./src/ entries are the monorepo's source form; they never ship and are not looked up.
    expect(findSideEffectsProblems('affiliates', dir, PACKED, SOURCE)).toEqual([]);
  });

  it('refuses an entry the tarball does not contain (a renamed entry would drop its server-only guard)', () => {
    const renamed = ['./src/server.ts', './server.mjs', './server.cjs'];
    const dir = dist({ 'package.json': { sideEffects: renamed } });
    expect(findSideEffectsProblems('affiliates', dir, PACKED, { sideEffects: renamed })).toEqual([
      '"sideEffects" lists ./server.mjs but the tarball does not contain it, so bundlers may drop the side effect of the module it meant',
    ]);
  });

  it('refuses a dist manifest that lost or changed the source list', () => {
    expect(findSideEffectsProblems('affiliates', dist({ 'package.json': { name: 'x' } }), PACKED, SOURCE)).toEqual([
      '"sideEffects" differs from the source package.json; the dist manifest must carry the same list',
    ]);
    expect(
      findSideEffectsProblems('affiliates', dist({ 'package.json': { sideEffects: false } }), PACKED, SOURCE)
    ).toEqual(['"sideEffects" differs from the source package.json; the dist manifest must carry the same list']);
  });

  it('checks wildcards against the tarball and leaves libs without the field alone', () => {
    const wildcards = ['./lib/**/*.css', '*.css', './dist-only/*.js'];
    const dir = dist({ 'package.json': { sideEffects: wildcards } });
    expect(findSideEffectsProblems('fixture', dir, PACKED, { sideEffects: wildcards })).toEqual([
      '"sideEffects" pattern ./dist-only/*.js matches no file in the tarball',
    ]);
    expect(findSideEffectsProblems('fixture', dist({ 'package.json': { name: 'x' } }), PACKED, { name: 'x' })).toEqual([]);
    expect(findSideEffectsProblems('fixture', dist({ 'package.json': { sideEffects: false } }), PACKED, null)).toEqual([]);
    expect(findSideEffectsProblems('fixture', dist({}), PACKED, SOURCE)).toEqual([]);
  });

  it('refuses entries that are not paths', () => {
    const dir = dist({ 'package.json': { sideEffects: ['./server.cjs', 42, ''] } });
    expect(findSideEffectsProblems('fixture', dir, PACKED, null)).toEqual([
      '"sideEffects" has an entry that is not a path: 42',
      '"sideEffects" has an entry that is not a path: ""',
    ]);
    expect(findSideEffectsProblems('fixture', dist({ 'package.json': { sideEffects: './server.cjs' } }), PACKED, null)).toEqual([
      '"sideEffects" must be a boolean or an array of paths',
    ]);
  });

  it('reads the affiliates source manifest the build copies', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../libs/affiliates/package.json'), 'utf8'));
    expect(manifest.sideEffects).toEqual(expect.arrayContaining(['./server.es.js', './server.cjs']));
    // The real list passes against the file names the affiliates build emits.
    const dir = dist({ 'package.json': manifest });
    expect(findSideEffectsProblems('affiliates', dir, PACKED)).toEqual([]);
  });
});

describe('findUndeclaredSiblingImports (check 11)', () => {
  // The bundles as the editor build writes them: every @nextblock-cms/* import left external.
  const EDITOR_ESM =
    "'use client';\nimport { sanitizeAuthoredBlockHtml } from \"@nextblock-cms/utils\";\n" +
    'import { Button } from "@nextblock-cms/ui/button";\nexport const a = [sanitizeAuthoredBlockHtml, Button];\n';
  const EDITOR_CJS =
    '"use client";let e=require("@nextblock-cms/utils"),t=require("@nextblock-cms/ui/button");exports.a=[e,t];';
  const EDITOR_FILES = { 'index.mjs': EDITOR_ESM, 'index.js': EDITOR_CJS, 'index.d.ts': 'export declare const a: unknown[];\n' };
  // The packed file list is passed in, so these tests never run `npm pack`.
  const EDITOR_PACKED = new Set(['package.json', 'index.mjs', 'index.js', 'index.d.ts']);
  const undeclared = (file: string, specifier: string, name: string) =>
    `${file} imports "${specifier}" but neither "dependencies" nor "peerDependencies" declares ${name}, so npm cannot ` +
    'tell which release this build needs; declare it in the package.json the build writes';

  it('refuses a sibling the shipped JavaScript imports but the manifest does not declare (editor and ui through 0.22.5)', () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/editor', dependencies: { 'use-sync-external-store': '^1.7.0' } },
      ...EDITOR_FILES,
    });
    expect(findUndeclaredSiblingImports('editor', dir, EDITOR_PACKED)).toEqual([
      undeclared('index.js', '@nextblock-cms/utils', '@nextblock-cms/utils'),
      undeclared('index.js', '@nextblock-cms/ui/button', '@nextblock-cms/ui'),
    ]);
    // One declared, one not: only the missing one is reported.
    const half = dist({
      'package.json': { name: '@nextblock-cms/editor', peerDependencies: { '@nextblock-cms/ui': '^0.22.6' } },
      ...EDITOR_FILES,
    });
    expect(findUndeclaredSiblingImports('editor', half, EDITOR_PACKED)).toEqual([
      undeclared('index.js', '@nextblock-cms/utils', '@nextblock-cms/utils'),
    ]);
  });

  it('passes siblings declared as peers or dependencies, including a workspace: spec release-lib.js resolves later', () => {
    const peers = dist({
      'package.json': {
        name: '@nextblock-cms/editor',
        dependencies: { 'use-sync-external-store': '^1.7.0' },
        peerDependencies: { '@nextblock-cms/ui': '^0.22.6', '@nextblock-cms/utils': '^0.22.6' },
      },
      ...EDITOR_FILES,
    });
    expect(findUndeclaredSiblingImports('editor', peers, EDITOR_PACKED)).toEqual([]);

    const raw = dist({
      'package.json': { name: '@nextblock-cms/affiliates', dependencies: { '@nextblock-cms/utils': 'workspace:*' } },
      'lib/core/money.es.js': 'import { formatPrice } from "@nextblock-cms/utils/client-utils";\nexport { formatPrice };\n',
    });
    expect(findUndeclaredSiblingImports('affiliates', raw, new Set(['package.json', 'lib/core/money.es.js']))).toEqual([]);
  });

  it('reads real imports in the shipped JavaScript only: not strings, comments, declarations or unpacked files', () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/db' },
      // utils' server entry throws a message that names the package; a regex took it for an import.
      'server.es.js':
        'if (typeof window < "u") throw Error("@nextblock-cms/utils server helpers cannot be imported from a Client Component.");\n' +
        '// import { x } from "@nextblock-cms/ui";\n/* require("@nextblock-cms/ecommerce") */\nexport const a = 1;\n',
      // Types only: check 4 resolves declaration imports through the sibling's exports.
      'server.d.ts': "import type { BlockDefinition } from '@nextblock-cms/sdk';\nexport type D = BlockDefinition;\n",
      // On disk but outside the "files" whitelist, so it never reaches a consumer.
      'stale.mjs': 'import { x } from "@nextblock-cms/cortex";\nexport { x };\n',
    });
    expect(findUndeclaredSiblingImports('db', dir, new Set(['package.json', 'server.es.js', 'server.d.ts']))).toEqual([]);
    // The same import does count once the tarball ships the file (dynamic import() too).
    const shipped = dist({
      'package.json': { name: '@nextblock-cms/db' },
      'lib/media-actions.es.js': 'export const load = () => import("@nextblock-cms/utils/server");\n',
    });
    expect(findUndeclaredSiblingImports('db', shipped, new Set(['package.json', 'lib/media-actions.es.js']))).toEqual([
      undeclared('lib/media-actions.es.js', '@nextblock-cms/utils/server', '@nextblock-cms/utils'),
    ]);
  });

  it('lets a package import itself, ecom by its @nextblock-cms/ecommerce import name', () => {
    const utils = dist({
      'package.json': { name: '@nextblock-cms/utils' },
      'lib/a.es.js': 'export * from "@nextblock-cms/utils/server";\n',
    });
    expect(findUndeclaredSiblingImports('utils', utils, new Set(['package.json', 'lib/a.es.js']))).toEqual([]);
    const ecom = dist({
      'package.json': { name: '@nextblock-cms/ecom' },
      'lib/a.cjs': 'let e=require("@nextblock-cms/ecommerce/server");exports.a=e;',
    });
    expect(findUndeclaredSiblingImports('ecommerce', ecom, new Set(['package.json', 'lib/a.cjs']))).toEqual([]);
  });

  it('takes @nextblock-cms/ecommerce as the alias of the published @nextblock-cms/ecom (cortex)', () => {
    const files = { 'lib/tools.es.js': 'import { p } from "@nextblock-cms/ecommerce/product-actions";\nexport { p };\n' };
    const packed = new Set(['package.json', 'lib/tools.es.js']);
    const withDeps = (dependencies: Record<string, string>) =>
      findUndeclaredSiblingImports('cortex', dist({ 'package.json': { name: '@nextblock-cms/cortex', dependencies }, ...files }), packed);

    // What release-lib.js writes, and the raw spec it resolves to that.
    expect(withDeps({ '@nextblock-cms/ecommerce': 'npm:@nextblock-cms/ecom@^0.22.6' })).toEqual([]);
    expect(withDeps({ '@nextblock-cms/ecommerce': 'workspace:*' })).toEqual([]);
    // A plain range under the alias name installs a package NextBlock does not publish.
    expect(withDeps({ '@nextblock-cms/ecommerce': '^0.22.6' })).toEqual([
      'dependencies["@nextblock-cms/ecommerce"] is "^0.22.6", which installs a package named @nextblock-cms/ecommerce; ' +
        'NextBlock publishes it as @nextblock-cms/ecom, so the spec must be "npm:@nextblock-cms/ecom@<range>"',
    ]);
    // The published name alone lands in node_modules/@nextblock-cms/ecom, where the import never looks.
    expect(withDeps({ '@nextblock-cms/ecom': '^0.22.6' })).toEqual([
      `${undeclared('lib/tools.es.js', '@nextblock-cms/ecommerce/product-actions', '@nextblock-cms/ecommerce')}; ` +
        'declaring @nextblock-cms/ecom installs it under that name, so declare "@nextblock-cms/ecommerce": ' +
        '"npm:@nextblock-cms/ecom@<range>" instead',
    ]);
  });
});
