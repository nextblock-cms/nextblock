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
 * Why this Node cannot run Vite's native config loader on the libs' configs, or null when it can.
 *
 * The configs are ES modules written in TypeScript (`vite.config.mts`). Vite reads them with its
 * bundle loader today, which works on any Node; its native loader imports them as they are, which
 * needs Node's TypeScript type stripping, on by default from Node 22.18 (23.6 on the 23 line). When
 * Vite makes the native loader its default, a lib build on an older Node fails before it starts, so
 * every lib build says so ahead of time (docs/05 → "Node.js floor"). Scaffolds run no Vite config:
 * the create-nextblock floor (22.12, in its `engines`) stays.
 *
 * @param {string} [version] process.versions.node
 * @returns {string | null}
 */
export function nativeConfigLoaderNodeWarning(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const supported = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  return supported
    ? null
    : `Node ${version}: Vite's native config loader, which reads the libs' vite.config.mts files, needs Node 22.18 or later. ` +
        'Builds still work on the bundle loader Vite uses today; upgrade Node before Vite makes the native loader its default (docs/05-DEVELOPER-GUIDE.md, "Node.js floor").';
}

{
  const warning = process.env['VITEST'] ? null : nativeConfigLoaderNodeWarning();
  if (warning) console.warn(`[nextblock] ${warning}`);
}

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
