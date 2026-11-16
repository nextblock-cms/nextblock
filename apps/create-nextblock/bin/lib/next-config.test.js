import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  STANDALONE_NEXT_CONFIG_PATCHES,
  STANDALONE_TRANSPILE_PACKAGES,
  patchNextConfigForStandalone,
} from './next-config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The real app config: this test is the drift guard between apps/nextblock and the scaffold.
const APP_NEXT_CONFIG = resolve(here, '../../../nextblock/next.config.js');

const appSource = readFileSync(APP_NEXT_CONFIG, 'utf8');

/** Run a next.config.js in a sandbox (stub requires, empty env) and return what it exports, as plain JSON. */
function evaluateNextConfig(source) {
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    __dirname: '/project',
    __filename: '/project/next.config.js',
    process: { env: {}, cwd: () => '/project' },
    URL,
    require: (id) => {
      if (id === 'node:path' || id === 'path') return posix;
      if (id === 'node:fs' || id === 'fs') return { existsSync: () => false };
      if (id === '@vercel/toolbar/plugins/next') return { withVercelToolbar: () => (config) => config };
      throw new Error(`unexpected require('${id}')`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'next.config.js' });
  return JSON.parse(JSON.stringify(cjsModule.exports, (key, value) => (typeof value === 'function' ? `[function ${key}]` : value)));
}

describe('patchNextConfigForStandalone', () => {
  it("every required patch still finds its anchor in the app's next.config.js", () => {
    const normalized = appSource.replace(/\r\n/g, '\n');

    for (const patch of STANDALONE_NEXT_CONFIG_PATCHES.filter((p) => p.required)) {
      const found = patch.regex ? patch.regex.test(normalized) : normalized.includes(patch.from);
      expect(found, `anchor for "${patch.name}"`).toBe(true);
    }
  });

  it('produces syntactically valid JavaScript', () => {
    const patched = patchNextConfigForStandalone(appSource);

    expect(() => new vm.Script(patched, { filename: 'next.config.js' })).not.toThrow();
  });

  it('applies the standalone differences and nothing else', () => {
    const patched = patchNextConfigForStandalone(appSource).replace(/\r\n/g, '\n');

    expect(patched).toContain('outputFileTracingRoot: path.join(__dirname),');
    expect(patched).not.toContain("path.join(__dirname, '../../')");
    expect(patched).toContain('typescript: { ignoreBuildErrors: true },');

    for (const name of STANDALONE_TRANSPILE_PACKAGES) {
      expect(patched).toContain(`'${name}',`);
    }

    // What used to break scaffolds on Next 16: webpack-only options and a webpack() hook.
    expect(patched).not.toContain('cssChunking');
    expect(patched).not.toMatch(/^\s*webpack: \(/m);

    // Inherited from the app untouched.
    expect(patched).toContain('turbopack: {');
    expect(patched).toContain('async headers()');
    expect(patched).toContain('allowedDevOrigins');
  });

  it('transpiles every published @nextblock-cms package a scaffold depends on', () => {
    // Each of these ships 'server-only' / 'use client' modules that Next only processes when it
    // transpiles the package; the premium ones are dependencies of every scaffold.
    expect(STANDALONE_TRANSPILE_PACKAGES).toEqual(
      expect.arrayContaining(['@nextblock-cms/db', '@nextblock-cms/ecommerce', '@nextblock-cms/cortex', '@nextblock-cms/affiliates']),
    );
    expect(new Set(STANDALONE_TRANSPILE_PACKAGES).size).toBe(STANDALONE_TRANSPILE_PACKAGES.length);

    const appDependencies = Object.keys(
      JSON.parse(readFileSync(resolve(here, '../../../nextblock/package.json'), 'utf8')).dependencies,
    ).filter((name) => name.startsWith('@nextblock-cms/'));
    for (const name of appDependencies) {
      expect(STANDALONE_TRANSPILE_PACKAGES, name).toContain(name);
    }

    const patched = patchNextConfigForStandalone(appSource).replace(/\r\n/g, '\n');
    expect(patched).toContain("    '@nextblock-cms/affiliates',\n  ],");
  });

  it("keeps the app's postcss browser alias, so a new scaffold's client bundles get the stub, not postcss", () => {
    const scaffold = evaluateNextConfig(patchNextConfigForStandalone(appSource));

    // No standalone patch touches turbopack.resolveAlias: the scaffold has exactly the app's aliases.
    expect(scaffold.turbopack.resolveAlias).toEqual(evaluateNextConfig(appSource).turbopack.resolveAlias);
    expect(scaffold.turbopack.resolveAlias.postcss).toEqual({ browser: './lib/browser-stubs/postcss.cjs' });
    // The stub ships in the template (lib/ is copied verbatim). Projects scaffolded before 0.23.4
    // get the same entry from `npm run update` (apps/nextblock/tools/lib/postcss-browser-alias.mjs).
    expect(existsSync(resolve(here, '../../../nextblock', scaffold.turbopack.resolveAlias.postcss.browser))).toBe(true);
  });

  it('preserves CRLF line endings when the source uses them', () => {
    const crlf = appSource.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const patched = patchNextConfigForStandalone(crlf);

    expect(patched.includes('\r\n')).toBe(true);
    expect(patched.split('\r\n').length).toBe(patched.split('\n').length);
  });

  it('fails loudly when a required anchor is missing', () => {
    expect(() => patchNextConfigForStandalone('module.exports = {};')).toThrow(/found no anchor/);
  });
});
