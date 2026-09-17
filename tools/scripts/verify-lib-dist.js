#!/usr/bin/env node
// Refuses to let a broken library build reach npm.
//
//   node tools/scripts/verify-lib-dist.js <lib>        (utils | ui | sdk | db | editor | ecommerce | cortex)
//
// release-lib.js calls `verifyLibDist` right after the Nx build and before `npm publish`.
// Every check here exists because the failure it catches shipped once and was invisible
// inside the monorepo, where `@nextblock-cms/*` resolves through tsconfig paths straight to
// TypeScript source; it only broke `next build` in scaffolded projects, which install the
// published packages:
//
//   1. Development JSX. The Nx Vite executor builds in development mode unless NODE_ENV is
//      `production`, so plugin-react emitted `jsxDEV(..., this)` with the builder's absolute
//      source paths. Besides leaking `C:/Users/...` and shipping the dev runtime, the `this`
//      argument is illegal inside a file with inline server actions ("Server Actions cannot
//      use `this`"), which failed every scaffold build once ecommerce gained such files.
//   2. Subpaths consumers import that the package does not actually contain. With
//      preserveModules only modules reachable from a build entry are emitted, so a module
//      that is imported ONLY through its subpath (`@nextblock-cms/utils/script-safety`) ships
//      a `.d.ts` and no JavaScript.
//   3. Exports the TypeScript source has but the build lost. `libs/db` and `libs/utils` track
//      stale compiled twins (`foo.js` beside `foo.ts`); Vite's default extension order picked
//      the `.js`, so the package was assembled from months-old code.

const fs = require('node:fs');
const path = require('node:path');
const { publishExportsFor } = require('./lib-publish-exports');

const workspaceRoot = path.resolve(__dirname, '..', '..');

/** The specifier consumers import. The ecommerce lib is published as `@nextblock-cms/ecom`. */
function importNameFor(library) {
  return library === 'ecom' ? '@nextblock-cms/ecommerce' : `@nextblock-cms/${library}`;
}

function distDirFor(library) {
  return path.join(workspaceRoot, 'dist', 'libs', library === 'ecom' ? 'ecommerce' : library);
}

function walk(dir, onFile, skip = new Set(['node_modules', '.next', 'dist', '.git', 'templates'])) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(full, onFile, skip);
      continue;
    }

    onFile(full);
  }
}

/* ------------------------------ 1. production build ------------------------------ */

function findDevelopmentArtifacts(distDir) {
  const offenders = [];
  const leakedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();

  walk(distDir, (file) => {
    if (!/\.(c|m)?js$/.test(file)) return;

    const text = fs.readFileSync(file, 'utf8');
    const reasons = [];

    if (/["']react\/jsx-dev-runtime["']/.test(text)) reasons.push('imports react/jsx-dev-runtime');
    if (text.toLowerCase().includes(leakedRoot)) reasons.push('contains the builder\'s absolute source path');

    if (reasons.length > 0) {
      offenders.push(`${path.relative(distDir, file)} (${reasons.join('; ')})`);
    }
  });

  return offenders;
}

/* ------------------------------ 2. consumed subpaths ------------------------------ */

function collectConsumedSubpaths(importName) {
  const pattern = new RegExp(`['"]${importName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}/([^'"\\s]+)['"]`, 'g');
  const found = new Map();
  const roots = [path.join(workspaceRoot, 'apps', 'nextblock'), path.join(workspaceRoot, 'libs')];

  for (const root of roots) {
    walk(root, (file) => {
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) return;
      if (/\.(test|spec)\.[a-z]+$/.test(file)) return;

      const text = fs.readFileSync(file, 'utf8');

      for (const match of text.matchAll(pattern)) {
        const subpath = match[1];

        // Stylesheets, configs and other assets resolve through their own export keys and
        // are not what this check is about.
        if (/\.(css|json|js|cjs|mjs)$/.test(subpath)) continue;

        // `import type … from` / `export type … from` are erased at build time, so they
        // need no emitted JavaScript (e.g. `@nextblock-cms/db/types`). Look back to the
        // start of the statement, which may be several lines up for a multi-line import.
        const before = text.slice(0, match.index);
        const statementStart = Math.max(before.lastIndexOf('\nimport'), before.lastIndexOf('\nexport'), 0);

        if (/^\s*(?:import|export)\s+type\b/.test(before.slice(statementStart))) continue;

        if (!found.has(subpath)) found.set(subpath, path.relative(workspaceRoot, file));
      }
    });
  }

  return found;
}

function pickTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;

  return pickTarget(entry.default ?? entry.import ?? entry.require ?? null);
}

function resolveThroughExports(exportsMap, subpath) {
  const key = `./${subpath}`;

  if (exportsMap[key] !== undefined) return pickTarget(exportsMap[key]);

  // Longest wildcard prefix wins, as in Node's resolution.
  const wildcards = Object.keys(exportsMap)
    .filter((candidate) => candidate.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*'));

  for (const candidate of wildcards) {
    const [prefix, suffix] = candidate.split('*');

    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      const middle = key.slice(prefix.length, key.length - suffix.length);
      const target = pickTarget(exportsMap[candidate]);

      return target ? target.replace('*', middle) : null;
    }
  }

  return null;
}

function findUnresolvableSubpaths(library, distDir) {
  // The template sync rewrites every `@nextblock-cms/ui/<sub>` import to the package barrel,
  // so scaffolds never consume ui subpaths from npm; checking them would only raise noise.
  if (library === 'ui') return [];

  const manifestPath = path.join(distDir, 'package.json');

  if (!fs.existsSync(manifestPath)) return [`${path.relative(workspaceRoot, manifestPath)} is missing`];

  // A plain `nx build ecommerce` leaves the raw source manifest, which has no `exports`;
  // release-lib.js writes the map just before publish. Judge the map that will ship.
  const exportsMap =
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')).exports ?? publishExportsFor(library) ?? {};
  const problems = [];

  for (const [subpath, firstImporter] of collectConsumedSubpaths(importNameFor(library))) {
    const target = resolveThroughExports(exportsMap, subpath);

    if (!target) {
      problems.push(`"${subpath}" is imported (${firstImporter}) but no "exports" key covers it`);
      continue;
    }

    if (!fs.existsSync(path.join(distDir, target))) {
      problems.push(
        `"${subpath}" is imported (${firstImporter}) but ${target} was not emitted — add it to build.lib.entry`
      );
    }
  }

  return problems;
}

/* ------------------------------ 3. lost exports ------------------------------ */

/**
 * Names a source barrel exports directly (`export const X`, `export function X`, ...),
 * following one level of `export * from './relative'`. Cheap and regex-based on purpose: it
 * only has to be good enough to notice that a whole module's worth of names went missing.
 */
function collectSourceExportNames(entryFile, seen = new Set()) {
  const names = new Set();

  if (seen.has(entryFile) || !fs.existsSync(entryFile)) return names;
  seen.add(entryFile);

  const text = fs.readFileSync(entryFile, 'utf8');

  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }

  for (const match of text.matchAll(/^export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    const base = path.resolve(path.dirname(entryFile), match[1]);
    const candidate = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((file) => fs.existsSync(file));

    if (candidate) {
      for (const name of collectSourceExportNames(candidate, seen)) names.add(name);
    }
  }

  return names;
}

function findLostExports(library, distDir) {
  const srcDir = path.join(workspaceRoot, 'libs', library === 'ecom' ? 'ecommerce' : library, 'src');
  const problems = [];

  for (const entry of ['index', 'server']) {
    const source = path.join(srcDir, `${entry}.ts`);
    const built = path.join(distDir, `${entry}.es.js`);

    if (!fs.existsSync(source) || !fs.existsSync(built)) continue;

    // With preserveModules the entry re-exports from per-module files; read them all.
    let emitted = '';
    walk(distDir, (file) => {
      if (file.endsWith('.es.js')) emitted += `\n${fs.readFileSync(file, 'utf8')}`;
    });

    const missing = [...collectSourceExportNames(source)].filter(
      (name) => !new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(emitted)
    );

    if (missing.length > 0) {
      problems.push(
        `src/${entry}.ts exports ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''} but the build does not contain ${missing.length === 1 ? 'it' : 'them'} — a stale .js twin may be shadowing the .ts source`
      );
    }
  }

  return problems;
}

/* ------------------------------------ driver ------------------------------------ */

function verifyLibDist(library) {
  const distDir = distDirFor(library);

  if (!fs.existsSync(distDir)) {
    throw new Error(`Build output not found at ${distDir}`);
  }

  const problems = [
    ...findDevelopmentArtifacts(distDir).map((entry) => `development build artifact: ${entry}`),
    ...findUnresolvableSubpaths(library, distDir).map((entry) => `unresolvable subpath: ${entry}`),
    ...findLostExports(library, distDir).map((entry) => `lost export: ${entry}`),
  ];

  if (problems.length > 0) {
    const shown = problems.slice(0, 25).map((entry) => `  - ${entry}`).join('\n');
    const more = problems.length > 25 ? `\n  … and ${problems.length - 25} more` : '';

    throw new Error(
      `${importNameFor(library)} is not publishable (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${shown}${more}`
    );
  }

  return { distDir, ok: true };
}

module.exports = { verifyLibDist };

if (require.main === module) {
  const library = process.argv[2];

  if (!library) {
    console.error('Usage: node tools/scripts/verify-lib-dist.js <utils|ui|sdk|db|editor|ecommerce|cortex>');
    process.exit(1);
  }

  try {
    verifyLibDist(library);
    console.log(`✓ dist/libs/${library === 'ecom' ? 'ecommerce' : library} is publishable`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
