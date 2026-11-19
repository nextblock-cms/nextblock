import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// CommonJS script; its CLI entry is guarded by `require.main`, so requiring it runs nothing.
const {
  collectDistProblems,
  findModuleFormatProblems,
  findPackagePageProblems,
  findPackedDotPaths,
  findSideEffectsProblems,
  findSupabaseFileProblems,
  findSupabaseFolderProblems,
  findUndeclaredPackageImports,
  findUndeclaredSiblingImports,
  findWorkspaceProtocolDependencies,
  readBundledMigrationNames,
  verifyLibDist,
} = require('./verify-lib-dist.js');
const { AFFILIATES_EXPORTS, publishExportsFor } = require('./lib-publish-exports.js');
const { nextMigrationVersion } = require('./lib/migration-naming.js');

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

describe('findUndeclaredPackageImports (check 15)', () => {
  // What the monorepo installed, as far as these tests need it: the rules for declarations read the
  // installed manifests, so each test hands in its own node_modules instead of the root's.
  const installed = (packages: Record<string, Record<string, unknown>>, extraFiles: Record<string, string> = {}) =>
    dist({
      ...Object.fromEntries(Object.entries(packages).map(([name, manifest]) => [`${name}/package.json`, { name, ...manifest }])),
      ...extraFiles,
    });
  const NODE_MODULES_NONE = () => installed({});
  const check = (library: string, dir: string, packed: string[], nodeModulesDir = NODE_MODULES_NONE()) =>
    findUndeclaredPackageImports(library, dir, new Set(packed), { nodeModulesDir });
  const undeclaredRuntime = (file: string, specifier: string, name: string) =>
    `${file} imports "${specifier}" but the package.json the build writes declares ${name} in none of dependencies, ` +
    'peerDependencies or optionalDependencies, so a project that installs this package can lack it: declare it ' +
    '(react, react-dom and next as peers, anything the package needs to run as a dependency)';
  const unresolvedTypes = (file: string, specifier: string, name: string) =>
    `${file} imports types from "${specifier}", but the package.json the build writes does not declare ${name} and nothing ` +
    'it declares installs it, so TypeScript reads those types as any in every project that installs this package ' +
    "(ui's class-variance-authority cost every scaffold 457 errors): declare it as a dependency";

  // ui as 0.23.5 published it: react and react-dom external and undeclared, cva only in the types.
  const UI_ESM =
    "'use client';\nimport { jsx } from \"react/jsx-runtime\";\nimport * as React from \"react\";\n" +
    'import { createPortal } from "react-dom";\nimport { cn } from "@nextblock-cms/utils/utils";\n' +
    'export const Button = React.forwardRef(() => jsx("button", { className: cn() }));\nexport { createPortal };\n';
  const BUTTON_DTS =
    "import { VariantProps } from 'class-variance-authority';\nimport * as React from 'react';\n" +
    'declare const buttonVariants: (props?: { variant?: "default" | null } | undefined) => string;\n' +
    'export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}\n';
  const UI_FILES = { 'index.mjs': UI_ESM, 'lib/button.d.ts': BUTTON_DTS };
  const UI_PACKED = ['package.json', 'index.mjs', 'lib/button.d.ts'];

  it("refuses ui as 0.23.5 published it: react and react-dom undeclared, and button.d.ts's class-variance-authority", () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/ui', dependencies: { 'react-color': '^2.19.3' }, peerDependencies: { '@nextblock-cms/utils': '^0.23.5' } },
      ...UI_FILES,
    });
    expect(check('ui', dir, UI_PACKED)).toEqual([
      undeclaredRuntime('index.mjs', 'react/jsx-runtime', 'react'),
      undeclaredRuntime('index.mjs', 'react-dom', 'react-dom'),
      unresolvedTypes('lib/button.d.ts', 'class-variance-authority', 'class-variance-authority'),
      unresolvedTypes('lib/button.d.ts', 'react', 'react'),
    ]);
  });

  it('passes the same files once the manifest declares them: react and react-dom as peers, cva as a dependency', () => {
    const dir = dist({
      'package.json': {
        name: '@nextblock-cms/ui',
        dependencies: { 'class-variance-authority': '^0.7.1' },
        peerDependencies: { '@nextblock-cms/utils': '^0.23.5', react: '^19.3.1', 'react-dom': '^19.3.1' },
      },
      ...UI_FILES,
    });
    expect(check('ui', dir, UI_PACKED)).toEqual([]);
    // optionalDependencies count for the JavaScript too (utils and db declare next as an optional peer).
    const optional = dist({
      'package.json': { name: '@nextblock-cms/db', optionalDependencies: { 'server-only': '^0.0.1' } },
      'lib/a.cjs.js': 'require("server-only");exports.a=1;',
    });
    expect(check('db', optional, ['package.json', 'lib/a.cjs.js'])).toEqual([]);
  });

  it("ignores Node's own modules, relative paths, URLs, comments and strings, the package itself, and siblings in JavaScript (check 11's)", () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/utils' },
      'lib/a.es.js':
        'import fs from "node:fs";\nimport { readFile } from "fs/promises";\nimport path from "path";\n' +
        'import { b } from "./b.es.js";\nimport { c } from "../c.es.js";\nimport { d } from "@nextblock-cms/utils/server";\n' +
        'import { e } from "@nextblock-cms/ui";\n// import x from "lodash";\nconst s = "require(\\"left-pad\\")";\n' +
        'export const a = [fs, readFile, path, b, c, d, e, s];\n',
      'lib/a.d.ts': '/// <reference types="node" />\nimport type { Stats } from "node:fs";\nexport declare const a: Stats;\n',
    });
    expect(check('utils', dir, ['package.json', 'lib/a.es.js', 'lib/a.d.ts'])).toEqual([]);
  });

  it('reads only the packed files: a stale file outside the "files" whitelist never reaches a consumer', () => {
    const dir = dist({ 'package.json': { name: '@nextblock-cms/db' }, 'stale.mjs': 'import x from "left-pad";\nexport { x };\n' });
    expect(check('db', dir, ['package.json'])).toEqual([]);
  });

  it('lets a declaration name a package that a declared dependency installs (postgrest-js through supabase-js)', () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/affiliates', dependencies: { '@supabase/supabase-js': '^2.118.0' } },
      'lib/repository/client.d.ts':
        'export declare function load(): Promise<import("@supabase/postgrest-js").PostgrestSingleResponse<unknown>>;\n',
    });
    const packed = ['package.json', 'lib/repository/client.d.ts'];
    const withPostgrest = installed({
      '@supabase/supabase-js': { types: './dist/index.d.ts', dependencies: { '@supabase/postgrest-js': '2.118.0' } },
      '@supabase/postgrest-js': { types: './dist/index.d.ts' },
    });
    expect(check('affiliates', dir, packed, withPostgrest)).toEqual([]);
    // The same import with nothing that installs it: TypeScript would read the type as any.
    expect(check('affiliates', dir, packed)).toEqual([
      unresolvedTypes('lib/repository/client.d.ts', '@supabase/postgrest-js', '@supabase/postgrest-js'),
    ]);
  });

  it('follows required peers of what it installs, never optional ones', () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/editor', dependencies: { '@tiptap/react': '^3.32.0' } },
      'lib/a.d.ts': "import type { Node } from '@tiptap/pm/model';\nimport type { Y } from 'yjs';\nexport type A = [Node, Y];\n",
    });
    const nodeModules = installed({
      '@tiptap/react': { types: './dist/index.d.ts', peerDependencies: { '@tiptap/pm': '^3.32.0', yjs: '^13' }, peerDependenciesMeta: { yjs: { optional: true } } },
      '@tiptap/pm': { exports: { './model': { types: './model/index.d.ts', import: './model/index.js' } } },
    });
    expect(check('editor', dir, ['package.json', 'lib/a.d.ts'], nodeModules)).toEqual([unresolvedTypes('lib/a.d.ts', 'yjs', 'yjs')]);
  });

  it('asks for the @types package of a dependency that ships no declarations, but not of a peer (react brings @types/react with the project)', () => {
    const dts = "import type { ColorResult } from 'react-color';\nimport type { FC } from 'react';\nexport declare const P: FC<{ c: ColorResult }>;\n";
    const nodeModules = installed({ 'react-color': { main: 'lib/index.js' }, react: { main: 'index.js' } });
    const manifest = (extra: Record<string, unknown>) => ({
      name: '@nextblock-cms/ui',
      dependencies: { 'react-color': '^2.19.3' },
      peerDependencies: { react: '^19.3.1' },
      ...extra,
    });
    const packed = ['package.json', 'lib/picker.d.ts'];
    expect(check('ui', dist({ 'package.json': manifest({}), 'lib/picker.d.ts': dts }), packed, nodeModules)).toEqual([
      "lib/picker.d.ts imports types from \"react-color\", but react-color ships no declarations of its own and the package.json the build writes does not declare @types/react-color, so TypeScript reads those types as any: declare @types/react-color as a dependency",
    ]);
    const typed = manifest({ dependencies: { 'react-color': '^2.19.3', '@types/react-color': '^3.0.13' } });
    expect(check('ui', dist({ 'package.json': typed, 'lib/picker.d.ts': dts }), packed, nodeModules)).toEqual([]);
    // A package with an index.d.ts of its own needs nothing more.
    const ownIndex = installed({ 'react-color': { main: 'lib/index.js' }, react: { main: 'index.js' } }, { 'react-color/index.d.ts': 'export {};\n' });
    expect(check('ui', dist({ 'package.json': manifest({}), 'lib/picker.d.ts': dts }), packed, ownIndex)).toEqual([]);
    // Undeclared and only installed through a dependency: declaring it as a peer is the usual fix.
    const viaDependency = dist({ 'package.json': { name: '@nextblock-cms/ui', dependencies: { 'react-color': '^2.19.3' } }, 'lib/picker.d.ts': dts });
    const reactThroughColor = installed({ 'react-color': { types: './index.d.ts', peerDependencies: { react: '*' } }, react: { main: 'index.js' } });
    expect(check('ui', viaDependency, packed, reactThroughColor)).toEqual([
      'lib/picker.d.ts imports types from "react", but react ships no declarations of its own and the package.json the build writes does not declare @types/react, so TypeScript reads those types as any: declare react as a peer (the project then provides its types, as it does @types/react), or @types/react as a dependency',
    ]);
  });

  it('counts a declaration file\'s type references and module augmentations, and its sibling imports', () => {
    const dir = dist({
      'package.json': { name: '@nextblock-cms/editor', peerDependencies: { '@nextblock-cms/ui': '^0.23.5' } },
      'lib/env.d.ts': '/// <reference types="vite/client" />\nexport {};\n',
      'lib/commands.d.ts': "import type { Editor } from '@nextblock-cms/ui';\ndeclare module '@tiptap/core' {\n  interface Commands<R> { x: () => R }\n}\nexport type E = Editor;\n",
      // An ambient module in a script file declares a module; it needs nothing installed.
      'lib/shims.d.ts': "declare module 'virtual:nextblock-shim' {\n  const x: string;\n  export default x;\n}\n",
      'lib/db.d.ts': "import type { Database } from '@nextblock-cms/db/types';\nexport type D = Database;\n",
    });
    const packed = ['package.json', 'lib/env.d.ts', 'lib/commands.d.ts', 'lib/shims.d.ts', 'lib/db.d.ts'];
    expect(check('editor', dir, packed)).toEqual([
      unresolvedTypes('lib/commands.d.ts', '@tiptap/core', '@tiptap/core'),
      'lib/db.d.ts imports types from "@nextblock-cms/db/types" but the package.json the build writes does not declare ' +
        '@nextblock-cms/db, so npm cannot tell which release those types come from: declare it as a dependency or peer',
      unresolvedTypes('lib/env.d.ts', 'vite/client', 'vite'),
    ]);
  });

  it('runs in the release gate (collectDistProblems), with the nodeModulesDir option handed through', () => {
    const dir = dist({ 'package.json': { name: '@nextblock-cms/ui' }, ...UI_FILES });
    const problems = collectDistProblems('ui', dir, new Set(UI_PACKED), { nodeModulesDir: NODE_MODULES_NONE() });
    expect(problems.filter((problem: string) => problem.startsWith('undeclared package: '))).toHaveLength(4);
    // React installed with a declared dependency: the declaration's react resolves, the runtime import still needs declaring.
    const withReact = installed({ 'react-color': { types: './index.d.ts', peerDependencies: { react: '*' } }, react: { types: './index.d.ts' } });
    const declared = dist({ 'package.json': { name: '@nextblock-cms/ui', dependencies: { 'react-color': '^2.19.3', 'class-variance-authority': '^0.7.1' } }, ...UI_FILES });
    expect(
      collectDistProblems('ui', declared, new Set(UI_PACKED), { nodeModulesDir: withReact }).filter((problem: string) =>
        problem.startsWith('undeclared package: ')
      )
    ).toEqual([
      `undeclared package: ${undeclaredRuntime('index.mjs', 'react/jsx-runtime', 'react')}`,
      `undeclared package: ${undeclaredRuntime('index.mjs', 'react-dom', 'react-dom')}`,
    ]);
  });
});

// The db tarball's shape: supabase/ holds config.toml, migrations/ and templates/ (copy-db-supabase.cjs).
// The packed file list is passed in, so these tests never run `npm pack`.
const DB_PACKED = [
  'package.json',
  'README.md',
  'index.es.js',
  'lib/supabase/types.d.ts',
  'supabase/config.toml',
  'supabase/migrations/02000_catchup_gen1.sql',
  'supabase/migrations/02001_baseline_schema.sql',
  'supabase/templates/magic_link.html',
];
// What the /setup bundle (apps/nextblock/lib/setup/migrations-bundle.ts) embeds beside that tarball. Check 14
// compares the packed migrations with it; these tests hand it in instead of reading the real bundle.
const DB_BUNDLE = ['02000_catchup_gen1.sql', '02001_baseline_schema.sql'];
const WITH_DB_BUNDLE = { bundledMigrationNames: DB_BUNDLE };
const dotPath = (file: string, fix: string) =>
  `${file} would be published. Dot folders and dotfiles are local state, tool config or secrets ` +
  `(the Supabase CLI's .temp/, .env files), not package content: ${fix}`;
const DB_FIX =
  'tools/scripts/copy-db-supabase.cjs empties dist/libs/db/supabase and copies no dot entry into it, so a stale ' +
  'build or a step after the copy wrote it; rebuild with nx build db, and find that step if it comes back';
const BUILD_FIX =
  'stop the build from writing it to the dist folder; an ignore file only hides it until that file is renamed or shadowed';
const notShipped = (file: string) =>
  `${file} would be published. supabase/ ships only what consumers read from the package (config.toml, migrations, ` +
  "templates); the rest is the Supabase CLI's local state (local Studio's snippets/, signing_keys.json) or " +
  'monorepo-only (functions/): rebuild with nx build db if dist/libs/db is stale, or add the entry to ' +
  'SUPABASE_PACKAGE_ENTRIES (tools/scripts/copy-db-supabase.cjs) once a consumer reads it';
const missingEntry = (entry: string) =>
  `the tarball has no supabase/${entry}: new projects copy it from the package (create-nextblock refuses a package ` +
  `without config.toml or migrations/, and templates/ holds the Auth emails); check that libs/db/src/supabase/${entry} ` +
  'exists and that the db build ran tools/scripts/copy-db-supabase.cjs';
/** A check-13 problem for an entry packed in the other shape: `shape` is the one consumers read, `inside` the first path below a file entry. */
const misshapen = (entry: string, shape: 'file' | 'folder', inside = '') =>
  `supabase/${entry} would be published as a ${shape === 'file' ? 'folder' : 'file'}${inside ? ` (${inside})` : ''}, but ` +
  `consumers read it as a ${shape}: new projects copy it from the package (create-nextblock refuses a package without ` +
  `config.toml or migrations/, and templates/ holds the Auth emails); check that libs/db/src/supabase/${entry} is a ${shape} ` +
  'and that the db build ran tools/scripts/copy-db-supabase.cjs';
const notMigration = (file: string) =>
  `${file} would be published. supabase/migrations holds only migrations, as top-level GGNNN_<snake_name>.sql files: ` +
  'remove it from libs/db/src/supabase/migrations';
const notTemplate = (file: string) =>
  `${file} would be published. supabase/templates holds only the Auth email templates (*.html) that new projects ` +
  'upload: remove it from libs/db/src/supabase/templates';
const MIGRATIONS_RULE =
  'every install applies the migrations this package ships (migrate-core and npm run update take any <digits>_*.sql), ' +
  "so only the current generation's GGNNN_<snake_name>.sql files may ship: rename or remove it in " +
  "libs/db/src/supabase/migrations (the Supabase CLI's migration new, db diff -f and db pull write timestamped names), " +
  'run npm run db:migrate:check and rebuild';
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A check-14 problem for a migration name validateMigrationNames refuses: where and how, then the rule. */
const badMigration = (start: string) =>
  expect.stringMatching(new RegExp(`^${escapeRegExp(start)}.*; ${escapeRegExp(MIGRATIONS_RULE)}$`));
const BUNDLE_RULE =
  'migrate-core and npm run update apply the migrations this package ships, while /setup on a serverless host applies the ' +
  'ones apps/nextblock/lib/setup/migrations-bundle.ts embeds, so the two lists must match';
const notBundled = (name: string) =>
  `supabase/migrations/${name} would be published, but the /setup bundle does not embed it (${BUNDLE_RULE}): if it is not ` +
  'meant for this release, take it out of libs/db/src/supabase/migrations and rebuild; if it is, run npm run ' +
  'generate:migrations-bundle';
const notPacked = (name: string) =>
  `supabase/migrations/${name} is embedded in the /setup bundle, but the tarball does not ship it (${BUNDLE_RULE}): run npm ` +
  'run generate:migrations-bundle if the bundle is stale, or restore the file in libs/db/src/supabase/migrations ' +
  '(migrations are append-only) and rebuild';
const shipsNone = (count: number) =>
  `the tarball ships none of the ${count} migration${count === 1 ? '' : 's'} the /setup bundle embeds (${BUNDLE_RULE}): ` +
  'restore them in libs/db/src/supabase/migrations as top-level files (migrations are append-only) and rebuild';

describe('findPackedDotPaths (check 12)', () => {
  it('passes a tarball without dot paths, and dots inside a name', () => {
    expect(findPackedDotPaths('db', dist({}), new Set(DB_PACKED))).toEqual([]);
    // An extension, a version or `env` inside a name is not a segment that starts with '.'.
    const names = new Set(['index.d.ts', 'lib/env.es.js', 'lib/load.env.cjs', 'lib/v1.2/a.mjs']);
    expect(findPackedDotPaths('utils', dist({}), names)).toEqual([]);
  });

  it("refuses the Supabase CLI's local state the db build copied into dist through the 0.23.4 rehearsal builds", () => {
    // Only the copied supabase/.gitignore kept these out of the tarball; an .npmignore beside it would not have.
    const packed = new Set([
      ...DB_PACKED,
      'supabase/.temp/project-ref',
      'supabase/.temp/pooler-url',
      'supabase/.branches/_current_branch',
      'supabase/functions/.temp/cli-latest',
      'supabase/.env',
    ]);
    expect(findPackedDotPaths('db', dist({}), packed)).toEqual([
      dotPath('supabase/.branches/_current_branch', DB_FIX),
      dotPath('supabase/.env', DB_FIX),
      dotPath('supabase/.temp/pooler-url', DB_FIX),
      dotPath('supabase/.temp/project-ref', DB_FIX),
      dotPath('supabase/functions/.temp/cli-latest', DB_FIX),
    ]);
  });

  it('refuses dot folders and dotfiles in any lib, .env files included', () => {
    const packed = new Set([
      'package.json',
      'index.es.js',
      '.env',
      '.env.local',
      'lib/.vite/manifest.json',
      // A committed template too: no lib ships a dot path today, so one that must ship gets an explicit exception.
      '.env.example',
    ]);
    expect(findPackedDotPaths('ecommerce', dist({}), packed)).toEqual([
      dotPath('.env', BUILD_FIX),
      dotPath('.env.example', BUILD_FIX),
      dotPath('.env.local', BUILD_FIX),
      dotPath('lib/.vite/manifest.json', BUILD_FIX),
    ]);
    // The copy-step hint is for db's supabase/ folder only.
    expect(findPackedDotPaths('db', dist({}), new Set(['package.json', '.env.local']))).toEqual([
      dotPath('.env.local', BUILD_FIX),
    ]);
  });
});

describe('findSupabaseFolderProblems (check 13)', () => {
  it('passes a db tarball whose supabase/ holds exactly config.toml, migrations/ and templates/', () => {
    expect(findSupabaseFolderProblems('db', dist({}), new Set(DB_PACKED))).toEqual([]);
  });

  it("refuses local state without a dot segment, which check 12 cannot see: local Studio's snippets/, signing_keys.json", () => {
    const packed = new Set([
      ...DB_PACKED,
      'supabase/snippets/local.sql',
      'supabase/snippets/customers.sql',
      'supabase/signing_keys.json',
      // What the denylist copy still shipped: the maintainer-only migration-ingest edge function.
      'supabase/functions/import_map.json',
      'supabase/functions/nextblock-migration-ingest/index.ts',
    ]);
    expect(findPackedDotPaths('db', dist({}), packed)).toEqual([]);
    // One problem per top-level entry, naming its first file.
    expect(findSupabaseFolderProblems('db', dist({}), packed)).toEqual([
      notShipped('supabase/functions/import_map.json'),
      notShipped('supabase/signing_keys.json'),
      notShipped('supabase/snippets/customers.sql'),
    ]);
  });

  it('refuses a db tarball that lost one of them (a scaffold refuses a package without config.toml or migrations/)', () => {
    const packed = new Set(DB_PACKED.filter((file) => file !== 'supabase/config.toml' && !file.startsWith('supabase/templates/')));
    expect(findSupabaseFolderProblems('db', dist({}), packed)).toEqual([missingEntry('config.toml'), missingEntry('templates')]);
    const withoutSupabase = new Set(DB_PACKED.filter((file) => !file.startsWith('supabase/')));
    expect(findSupabaseFolderProblems('db', dist({}), withoutSupabase)).toEqual([
      missingEntry('config.toml'),
      missingEntry('migrations'),
      missingEntry('templates'),
    ]);
  });

  it('counts each of them only in the shape consumers read: a file named supabase/migrations holds no migration', () => {
    // A regular file where the migrations folder goes: checks 12 and 14 see nothing to refuse in it.
    const fileForFolder = new Set(['package.json', 'supabase/config.toml', 'supabase/migrations', 'supabase/templates/magic_link.html']);
    expect(findSupabaseFolderProblems('db', dist({}), fileForFolder)).toEqual([misshapen('migrations', 'folder')]);
    expect(findPackedDotPaths('db', dist({}), fileForFolder)).toEqual([]);
    expect(findSupabaseFileProblems('db', dist({}), fileForFolder, WITH_DB_BUNDLE)).toEqual([]);
    // The other way round: config.toml packed as a folder, templates as a file.
    const swapped = new Set([
      'package.json',
      'supabase/config.toml/config.toml',
      'supabase/migrations/02000_catchup_gen1.sql',
      'supabase/migrations/02001_baseline_schema.sql',
      'supabase/templates',
    ]);
    expect(findSupabaseFolderProblems('db', dist({}), swapped)).toEqual([
      misshapen('config.toml', 'file', 'supabase/config.toml/config.toml'),
      misshapen('templates', 'folder'),
    ]);
  });

  it('leaves dot entries to check 12, and libs other than db alone', () => {
    expect(findSupabaseFolderProblems('db', dist({}), new Set([...DB_PACKED, 'supabase/.temp/project-ref']))).toEqual([]);
    expect(findSupabaseFolderProblems('utils', dist({}), new Set(['package.json', 'supabase/snippets/local.sql']))).toEqual([]);
  });
});

describe('findSupabaseFileProblems (check 14)', () => {
  const SUPABASE_SOURCE = join(__dirname, '../../libs/db/src/supabase');
  const realPacked = () => {
    const migrations = readdirSync(join(SUPABASE_SOURCE, 'migrations'));
    const templates = readdirSync(join(SUPABASE_SOURCE, 'templates'));
    expect(migrations).toContain('02000_catchup_gen1.sql');
    expect(templates).toContain('magic_link.html');
    return {
      migrations,
      packed: new Set([
        'package.json',
        'supabase/config.toml',
        ...migrations.map((name) => `supabase/migrations/${name}`),
        ...templates.map((name) => `supabase/templates/${name}`),
      ]),
    };
  };
  const check = (packed: Iterable<string>, bundle: string[] = DB_BUNDLE) =>
    findSupabaseFileProblems('db', dist({}), new Set(packed), { bundledMigrationNames: bundle });

  it('passes the real libs/db/src/supabase migrations and templates, which the copy ships as they are, against the real /setup bundle', () => {
    // No bundledMigrationNames: the check reads apps/nextblock/lib/setup/migrations-bundle.ts.
    expect(findSupabaseFileProblems('db', dist({}), realPacked().packed)).toEqual([]);
  });

  it('refuses a work-in-progress migration the real /setup bundle does not embed: every install would apply it', () => {
    const { migrations, packed } = realPacked();
    // Named like the next migration, so the naming rule passes it.
    const wip = `${nextMigrationVersion(migrations)}_work_in_progress.sql`;
    expect(findSupabaseFileProblems('db', dist({}), new Set([...packed, `supabase/migrations/${wip}`]))).toEqual([notBundled(wip)]);
  });

  it('refuses a packed migration the /setup bundle lacks and a bundled one the tarball lacks (two checkouts that numbered 02005 apart)', () => {
    const head = [
      '02000_catchup_gen1.sql',
      '02001_baseline_schema.sql',
      '02002_baseline_constraints_and_indexes.sql',
      '02003_baseline_security_and_grants.sql',
      '02004_baseline_seed.sql',
    ];
    const packed = [
      'package.json',
      'supabase/config.toml',
      'supabase/templates/magic_link.html',
      ...[...head, '02005_affiliate_tier_goals.sql'].map((name) => `supabase/migrations/${name}`),
    ];
    expect(check(packed, [...head, '02005_consent_cookie_copy.sql'])).toEqual([
      notBundled('02005_affiliate_tier_goals.sql'),
      notPacked('02005_consent_cookie_copy.sql'),
    ]);
    // Both lists pass the naming rule and checks 12 and 13: only the comparison stops this release.
    expect(findPackedDotPaths('db', dist({}), new Set(packed))).toEqual([]);
    expect(findSupabaseFolderProblems('db', dist({}), new Set(packed))).toEqual([]);
    expect(check(packed, [...head, '02005_affiliate_tier_goals.sql'])).toEqual([]);
  });

  it('refuses a Supabase CLI timestamped migration, a non-SQL file in migrations/ and a non-HTML file in templates/', () => {
    const packed = new Set([
      ...DB_PACKED,
      // `supabase db pull` / `migration new` / `db diff -f` output: migrate-core and npm run update would apply it.
      'supabase/migrations/20261114120000_remote_schema.sql',
      'supabase/migrations/notes.txt',
      'supabase/templates/Thumbs.db',
    ]);
    // The timestamped file is not in the bundle either, but its name is the problem to fix first.
    expect(check(packed)).toEqual([
      notMigration('supabase/migrations/notes.txt'),
      notTemplate('supabase/templates/Thumbs.db'),
      badMigration('supabase/migrations/20261114120000_remote_schema.sql: does not match GGNNN_name.sql'),
    ]);
    // Checks 12 and 13 let all three through: no dot segment, and the folders themselves ship.
    expect(findPackedDotPaths('db', dist({}), packed)).toEqual([]);
    expect(findSupabaseFolderProblems('db', dist({}), packed)).toEqual([]);
  });

  it('gives a .sql file without a <digits>_ prefix the remove-it message, not db:migrate:check, which never lists it', () => {
    const problems = check([...DB_PACKED, 'supabase/migrations/seed.sql']);
    expect(problems).toEqual([notMigration('supabase/migrations/seed.sql')]);
    expect(problems.join('\n')).not.toContain('db:migrate:check');
  });

  it('refuses what validateMigrationNames refuses: a gap (a migration removed upstream), a second generation, a subfolder', () => {
    expect(check([...DB_PACKED, 'supabase/migrations/02099_obsolete.sql'])).toEqual([
      badMigration('supabase/migrations/02099_obsolete.sql: sequence gap or duplicate'),
    ]);
    // The mixed-generation error names no file, so the unbundled 03000 is reported too.
    expect(check([...DB_PACKED, 'supabase/migrations/03000_catchup_gen2.sql'])).toEqual([
      badMigration('supabase/migrations: mixed squash generations on disk: 2, 3'),
      notBundled('03000_catchup_gen2.sql'),
    ]);
    expect(check([...DB_PACKED, 'supabase/migrations/archive/02002_old.sql'])).toEqual([
      notMigration('supabase/migrations/archive/02002_old.sql'),
    ]);
  });

  it('refuses a migrations/ folder that holds no top-level <digits>_*.sql file (only stray files, a subfolder or dot paths), in one problem for the whole bundle', () => {
    const withoutMigrations = DB_PACKED.filter((file) => !file.startsWith('supabase/migrations/'));
    // Only a stray file, a subfolder or a dot path (check 12's) there: nothing to compare name by name.
    expect(check([...withoutMigrations, 'supabase/migrations/seed.sql'])).toEqual([notMigration('supabase/migrations/seed.sql'), shipsNone(2)]);
    expect(check([...withoutMigrations, 'supabase/migrations/archive/02000_catchup_gen1.sql'])).toEqual([
      notMigration('supabase/migrations/archive/02000_catchup_gen1.sql'),
      shipsNone(2),
    ]);
    expect(check([...withoutMigrations, 'supabase/migrations/.temp/cli-latest'])).toEqual([shipsNone(2)]);
    expect(check([...withoutMigrations, 'supabase/migrations/seed.sql'], ['02000_catchup_gen1.sql'])).toEqual([
      notMigration('supabase/migrations/seed.sql'),
      shipsNone(1),
    ]);
    // A bundle that embeds nothing has nothing the tarball could lack.
    expect(check([...withoutMigrations, 'supabase/migrations/seed.sql'], [])).toEqual([notMigration('supabase/migrations/seed.sql')]);
  });

  it('leaves dot entries to check 12, a missing folder or a file in its place to check 13, and libs other than db alone', () => {
    expect(check([...DB_PACKED, 'supabase/migrations/.temp/cli-latest', 'supabase/templates/.DS_Store'])).toEqual([]);
    const withoutMigrations = DB_PACKED.filter((file) => !file.startsWith('supabase/migrations/'));
    expect(check(withoutMigrations)).toEqual([]);
    expect(check([...withoutMigrations, 'supabase/migrations'])).toEqual([]);
    expect(findSupabaseFileProblems('utils', dist({}), new Set(['package.json', 'supabase/migrations/notes.txt']))).toEqual([]);
  });
});

describe('readBundledMigrationNames (the /setup bundle check 14 compares with)', () => {
  /** A bundle file in the shape tools/scripts/generate-migrations-bundle.ts writes. */
  const bundleFile = (body: string) => join(dist({ 'migrations-bundle.ts': body }), 'migrations-bundle.ts');
  const generated = (entries: Array<{ version: string; name: string; sql: string }>) =>
    bundleFile(
      '// AUTO-GENERATED by tools/scripts/generate-migrations-bundle.ts — do not edit by hand.\n\n' +
        'export interface BundledMigration {\n  version: string;\n  name: string;\n  sql: string;\n}\n\n' +
        `export const MIGRATIONS_BUNDLE: BundledMigration[] = ${JSON.stringify(entries, null, 2)};\n`
    );

  it("reads each entry's name, whatever its SQL says (the catch-up quotes retired file names)", () => {
    const file = generated([
      {
        version: '02000',
        name: '02000_catchup_gen1.sql',
        sql: "-- replays 00000000000030_old.sql\nselect '02099_decoy.sql' as name;\n-- {\"version\": \"02098\", \"name\": \"02098_decoy.sql\"}\n",
      },
      { version: '02001', name: '02001_baseline_schema.sql', sql: 'create table t ("name" text);\n' },
    ]);
    expect(readBundledMigrationNames(file)).toEqual(['02000_catchup_gen1.sql', '02001_baseline_schema.sql']);
  });

  it('reads the real bundle: every migration file in libs/db/src/supabase/migrations, in order', () => {
    const folder = readdirSync(join(__dirname, '../../libs/db/src/supabase/migrations')).filter((name) => /^\d+_.*\.sql$/.test(name));
    expect(readBundledMigrationNames()).toEqual(folder.sort());
  });

  it('throws, naming npm run generate:migrations-bundle, when it cannot find the names', () => {
    const regenerate = '; regenerate it with npm run generate:migrations-bundle';
    expect(() => readBundledMigrationNames(join(dist({}), 'missing.ts'))).toThrow(`missing.ts cannot be read (ENOENT)${regenerate}`);
    expect(() => readBundledMigrationNames(bundleFile('export const OTHER_BUNDLE = [];\n'))).toThrow(
      `declares no MIGRATIONS_BUNDLE array${regenerate}`
    );
    expect(() => readBundledMigrationNames(bundleFile('export const MIGRATIONS_BUNDLE = [{ "version": "02000", "sql": "" }];\n'))).toThrow(
      `has a MIGRATIONS_BUNDLE entry (index 0) without a string "name"${regenerate}`
    );
  });
});

// A db dist folder without a build: the manifest and README the other checks read. The packed list
// leaves out the JavaScript and declarations, which checks 5 and 11 would read from disk.
const dbDist = () =>
  dist({
    'package.json': {
      name: '@nextblock-cms/db',
      license: 'AGPL-3.0-or-later',
      repository: { type: 'git', url: 'git+https://github.com/nextblock-cms/nextblock.git', directory: 'libs/db' },
    },
    'README.md': '# @nextblock-cms/db\n',
  });
const SUPABASE_PACKED = ['package.json', 'README.md', ...DB_PACKED.filter((file) => file.startsWith('supabase/'))];

describe('collectDistProblems (the gate verifyLibDist runs on the npm pack file list)', () => {
  // Without a build, check 2 finds the db subpaths the app imports unresolvable; these tests are about 12 to 14.
  const supabaseProblems = (problems: string[]) =>
    problems.filter((problem) => /^(dot path|supabase folder|supabase file): /.test(problem));

  it('passes the db supabase/ folder the copy writes', () => {
    expect(supabaseProblems(collectDistProblems('db', dbDist(), new Set(SUPABASE_PACKED), WITH_DB_BUNDLE))).toEqual([]);
  });

  it('reports a packed supabase/.temp/project-ref (check 12) and local Studio snippets (check 13)', () => {
    const packed = new Set([...SUPABASE_PACKED, 'supabase/.temp/project-ref', 'supabase/snippets/local.sql']);
    expect(supabaseProblems(collectDistProblems('db', dbDist(), packed, WITH_DB_BUNDLE))).toEqual([
      `dot path: ${dotPath('supabase/.temp/project-ref', DB_FIX)}`,
      `supabase folder: ${notShipped('supabase/snippets/local.sql')}`,
    ]);
  });

  it('reports a timestamped migration and a stray template file (check 14)', () => {
    const packed = new Set([...SUPABASE_PACKED, 'supabase/migrations/20261114120000_remote_schema.sql', 'supabase/templates/Thumbs.db']);
    expect(supabaseProblems(collectDistProblems('db', dbDist(), packed, WITH_DB_BUNDLE))).toEqual([
      `supabase file: ${notTemplate('supabase/templates/Thumbs.db')}`,
      badMigration('supabase file: supabase/migrations/20261114120000_remote_schema.sql: does not match GGNNN_name.sql'),
    ]);
  });

  it('reports a regular file where supabase/migrations goes (check 13), and a folder that holds no migration (check 14)', () => {
    const fileForFolder = new Set(['package.json', 'supabase/config.toml', 'supabase/migrations', 'supabase/templates/magic_link.html']);
    expect(supabaseProblems(collectDistProblems('db', dbDist(), fileForFolder, WITH_DB_BUNDLE))).toEqual([
      `supabase folder: ${misshapen('migrations', 'folder')}`,
    ]);
    const strayOnly = new Set(['package.json', 'supabase/config.toml', 'supabase/migrations/seed.sql', 'supabase/templates/magic_link.html']);
    expect(supabaseProblems(collectDistProblems('db', dbDist(), strayOnly, WITH_DB_BUNDLE))).toEqual([
      `supabase file: ${notMigration('supabase/migrations/seed.sql')}`,
      `supabase file: ${shipsNone(2)}`,
    ]);
  });

  it('hands check 14 the bundledMigrationNames option: a migration the bundle lacks, and a bundled one the tarball lacks', () => {
    const packed = new Set([...SUPABASE_PACKED, 'supabase/migrations/02002_baseline_constraints_and_indexes.sql']);
    expect(supabaseProblems(collectDistProblems('db', dbDist(), packed, WITH_DB_BUNDLE))).toEqual([
      `supabase file: ${notBundled('02002_baseline_constraints_and_indexes.sql')}`,
    ]);
    const bundle = [...DB_BUNDLE, '02002_baseline_constraints_and_indexes.sql'];
    expect(supabaseProblems(collectDistProblems('db', dbDist(), new Set(SUPABASE_PACKED), { bundledMigrationNames: bundle }))).toEqual([
      `supabase file: ${notPacked('02002_baseline_constraints_and_indexes.sql')}`,
    ]);
  });
});

describe('verifyLibDist (the release gate release-lib.js runs)', () => {
  it('stops the release with every problem in the file list its packer returns, a packed supabase/.temp/project-ref included', () => {
    const distDir = dbDist();
    const listPackedFiles = vi.fn(() => new Set([...SUPABASE_PACKED, 'supabase/.temp/project-ref']));

    let message = '';
    try {
      verifyLibDist('db', { distDir, listPackedFiles, manifestFinalized: true, ...WITH_DB_BUNDLE });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(listPackedFiles).toHaveBeenCalledTimes(1);
    expect(listPackedFiles).toHaveBeenCalledWith(distDir);
    expect(message).toMatch(/^@nextblock-cms\/db is not publishable \(\d+ problems?\):\n/);
    expect(message.split('\n')).toContain(`  - dot path: ${dotPath('supabase/.temp/project-ref', DB_FIX)}`);
    expect(message).not.toContain('supabase file: ');
  });

  it('hands its other options to the checks: a bundle that embeds a migration the tarball lacks stops the release', () => {
    // A name the real bundle does not hold, so only the bundle handed in can report it.
    const bundledMigrationNames = [...DB_BUNDLE, '02002_from_another_checkout.sql'];

    let message = '';
    try {
      verifyLibDist('db', { distDir: dbDist(), listPackedFiles: () => SUPABASE_PACKED, manifestFinalized: true, bundledMigrationNames });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.split('\n')).toContain(`  - supabase file: ${notPacked('02002_from_another_checkout.sql')}`);
  });
});
