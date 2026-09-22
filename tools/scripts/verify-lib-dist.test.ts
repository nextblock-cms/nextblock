import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// CommonJS script; its CLI entry is guarded by `require.main`, so requiring it runs nothing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findModuleFormatProblems, findPackagePageProblems } = require('./verify-lib-dist.js');

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
