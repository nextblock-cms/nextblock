// Vite plugins shared by the libs/* build configs.
//
// The libraries build with plain `vite build` (the inferred @nx/vite/plugin target), not the
// @nx/vite:build executor, which Nx 24 removes. These two plugins cover what the configs used
// to lean on the executor, or on vite-plugin-dts's afterBuild hook, for.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Put `'use client';` at the top of every entry chunk, in every output format.
 *
 * For libraries that bundle into a single entry (ui, editor). Rolldown drops module-level
 * directives when it merges modules into one chunk, so the directive has to be added back.
 * Doing that from vite-plugin-dts's `afterBuild` only ever reached the ESM file: the hook runs
 * after the first output is written and before the CommonJS one, which then lands without it,
 * so a `require()` consumer (or a bundler that picks the `require` condition) got a module
 * Next.js treats as a Server Component. `generateBundle` runs once per output format, after
 * minification, on the code about to be written.
 *
 * @returns {import('vite').Plugin}
 */
export function clientDirectiveOnEntries() {
  return {
    name: 'nextblock:client-directive-on-entries',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
        if (/^\s*['"]use client['"]/.test(chunk.code)) continue;
        chunk.code = `'use client';\n${chunk.code}`;
      }
    },
  };
}

/**
 * Copy files from the library's folder into its dist folder once the build has finished.
 *
 * Replaces the `assets` option of the retired @nx/vite:build executor. That option was not in
 * the executor's schema, so it copied nothing: the executor only copied `package.json`, and only
 * when the build had not written one. A missing source file is skipped.
 *
 * @param {string} libDir absolute path of the library (the config's `__dirname`)
 * @param {string} outDir absolute path of the dist folder
 * @param {string[]} files file names relative to `libDir`, e.g. `['README.md', 'package.json']`
 * @returns {import('vite').Plugin}
 */
export function copyIntoDist(libDir, outDir, files) {
  return {
    name: 'nextblock:copy-into-dist',
    apply: 'build',
    closeBundle() {
      for (const file of files) {
        const source = path.join(libDir, file);
        if (!fs.existsSync(source)) continue;
        const destination = path.join(outDir, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
    },
  };
}
