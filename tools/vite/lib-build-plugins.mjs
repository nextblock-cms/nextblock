// Vite plugins shared by the libs/* build configs.
//
// The libraries build with plain `vite build` (the inferred @nx/vite/plugin target), not the
// @nx/vite:build executor, which Nx 24 removes. These two plugins cover what the configs used
// to lean on the executor, or on vite-plugin-dts's afterBuild hook, for; rootPackageRanges gives
// the manifests they write their third-party ranges.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT_MANIFEST = fileURLToPath(new URL('../../package.json', import.meta.url));

/**
 * `{ name: range }` for the manifest a lib's build writes, each range read from the root
 * package.json, so a published range always names the version the monorepo builds and tests
 * against. `sameRangeAs` maps a package the root does not list to one it does that releases in
 * lockstep with it (@tiptap/extension-list ships with @tiptap/core); anything else the root lacks
 * throws, so a typo cannot publish a manifest without the package.
 * `tools/scripts/verify-lib-dist.js` check 15 refuses a dist that imports a package it does not
 * declare.
 *
 * @param {string[]} names
 * @param {{ sameRangeAs?: Record<string, string> }} [options]
 * @returns {Record<string, string>}
 */
export function rootPackageRanges(names, { sameRangeAs = {} } = {}) {
  const root = JSON.parse(fs.readFileSync(ROOT_MANIFEST, 'utf8'));
  const ranges = { ...root.devDependencies, ...root.dependencies };
  return Object.fromEntries(
    names.map((name) => {
      const range = ranges[name] ?? (sameRangeAs[name] ? ranges[sameRangeAs[name]] : undefined);
      if (typeof range !== 'string' || range.trim() === '') {
        throw new Error(`${name} is not in the root package.json, so the lib build cannot take its published range from there`);
      }
      return [name, range];
    }),
  );
}
