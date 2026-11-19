// The testable parts of tools/scripts/rehearse-release.js: what it points at the packed tarballs,
// what it accepts from the scaffold's install, builds and type-check, and how it prepares its work
// folder. Kept apart so the tests exercise them without packing or building anything.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LIBS } = require('./release-pipeline');

/** The libs in publish order, by libs/ folder: the release's own list. */
const REHEARSED_LIBS = LIBS;

/** The name the app and the libs import ecom by; npm knows the package as @nextblock-cms/ecom. */
const ECOM_IMPORT_NAME = '@nextblock-cms/ecommerce';
const ECOM_PUBLISHED_NAME = '@nextblock-cms/ecom';

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * Every name a project or a lib may depend on a packed tarball by, with its `file:` spec relative to
 * `fromDir`. `tarballs` maps a lib folder to `{ name, file }` (the package name npm packed and the
 * tarball's absolute path); ecom is reachable as @nextblock-cms/ecommerce (the alias every consumer
 * declares) and as @nextblock-cms/ecom.
 *
 * @param {Record<string, { name: string, file: string }>} tarballs
 * @param {string} fromDir
 * @returns {Record<string, string>}
 */
function tarballSpecs(tarballs, fromDir) {
  const specs = {};
  for (const [lib, { name, file }] of Object.entries(tarballs)) {
    const spec = `file:${toPosix(path.relative(fromDir, file))}`;
    specs[name] = spec;
    if (lib === 'ecommerce' || name === ECOM_PUBLISHED_NAME) specs[ECOM_IMPORT_NAME] = spec;
  }
  return specs;
}

/**
 * `pkg` (a package.json object, not modified) with every `@nextblock-cms/*` dependency pointed at its
 * tarball and the same specs added to `overrides`, so the libs' own sibling edges (ecom -> db, ui,
 * utils; cortex -> the ecom alias; editor -> ui, utils) install the tarballs too. A dependency and an
 * override of one name must carry the same spec, or npm refuses the install (EOVERRIDE). Throws on a
 * `@nextblock-cms/*` dependency no tarball covers: installing it from the registry would rehearse a
 * mix of the published and the packed packages.
 *
 * @returns {{ pkg: object, changed: string[] }}
 */
function rewireToTarballs(pkg, tarballs, fromDir) {
  const specs = tarballSpecs(tarballs, fromDir);
  const next = JSON.parse(JSON.stringify(pkg));
  const changed = [];

  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(next[section] ?? {})) {
      if (!name.startsWith('@nextblock-cms/')) continue;
      if (!specs[name]) throw new Error(`${section}["${name}"] has no packed tarball; the rehearsal would install it from the registry`);
      changed.push(`${section}.${name}: ${next[section][name]} -> ${specs[name]}`);
      next[section][name] = specs[name];
    }
  }
  next.overrides = { ...(next.overrides ?? {}), ...specs };
  return { pkg: next, changed };
}

/**
 * Every `@nextblock-cms/*` package in an installed package-lock.json (v2/v3 `packages`) that did not
 * come from one of the tarballs: one line each, empty when the whole install is the rehearsal's.
 *
 * @param {{ packages?: Record<string, { resolved?: string, link?: boolean }> }} lock
 * @param {Iterable<string>} tarballFiles absolute paths of the packed tarballs
 */
function findPackagesNotFromTarballs(lock, tarballFiles) {
  const names = new Set([...tarballFiles].map((file) => path.basename(file)));
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!/(^|\/)node_modules\/@nextblock-cms\/[^/]+$/.test(key)) continue;
    const resolved = typeof entry?.resolved === 'string' ? entry.resolved : '';
    if (!resolved.startsWith('file:') || !names.has(path.posix.basename(resolved))) {
      problems.push(`${key} came from ${resolved || '(no "resolved" field)'}, not from a packed tarball`);
    }
  }
  return problems;
}

/**
 * The errors in `tsc --pretty false` output: the total, and counts by error code and by file.
 * Locationless errors (`error TS5083: …`) count under the file "(global)".
 */
function parseTscOutput(text) {
  const byCode = {};
  const byFile = {};
  let total = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const located = /^(.+?)\(\d+,\d+\): error (TS\d+): /.exec(line);
    const global = located ? null : /^error (TS\d+): /.exec(line);
    if (!located && !global) continue;
    const code = located ? located[2] : global[1];
    // The same key on every platform (tsc on Windows may print either separator).
    const file = located ? located[1].replace(/\\/g, '/') : '(global)';
    total += 1;
    byCode[code] = (byCode[code] ?? 0) + 1;
    byFile[file] = (byFile[file] ?? 0) + 1;
  }
  return { total, byCode: sortObject(byCode), byFile: sortObject(byFile) };
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Compares type-check counts with the pinned budget (`{ total, byCode }`). Any count above its
 * budget fails, a code the budget does not list included (its budget is 0). Counts below budget only
 * produce `lower`: the budget to pin instead, so the next regression cannot hide in the slack.
 *
 * @returns {{ ok: boolean, over: string[], lower: { total: number, byCode: Record<string, number> } | null }}
 */
function compareWithBudget(counts, budget) {
  const over = [];
  const budgetCodes = budget.byCode ?? {};
  if (counts.total > budget.total) over.push(`${counts.total} errors in all, budget ${budget.total}`);
  for (const [code, count] of Object.entries(counts.byCode)) {
    const allowed = budgetCodes[code] ?? 0;
    if (count > allowed) over.push(`${code}: ${count}, budget ${allowed}`);
  }
  const improved =
    counts.total < budget.total ||
    Object.entries(budgetCodes).some(([code, allowed]) => (counts.byCode[code] ?? 0) < allowed);
  return {
    ok: over.length === 0,
    over,
    lower: over.length === 0 && improved ? { total: counts.total, byCode: counts.byCode } : null,
  };
}

/** Bundled test tooling in a Next build: module paths and runtime markers, never a word in a comment. */
const TEST_TOOLING_PATTERNS = [
  /node_modules[\\/]+(?:@vitest|vitest|chai)[\\/]/,
  /node_modules_(?:@vitest|vitest|chai)_/,
  /__vitest_worker__/,
  /\[externals\][\\/](?:vitest|chai)\b/,
  /require\(\s*["'](?:vitest|chai|@vitest\/[^"']+)["']\s*\)/,
  /from\s*["'](?:vitest|chai)["']/,
];

/**
 * Lines naming a JS file in a Next build that carries test tooling, or a source map that lists a
 * test file or a test package among its sources. 0.23.0 to 0.23.3 bundled
 * SectionBlockEditor.test.tsx, and with it vitest, into every scaffold build.
 *
 * @param {{ path: string, text: string }[]} files `path` relative to the build folder
 */
function findBundledTestTooling(files) {
  const hits = [];
  for (const { path: file, text } of files) {
    if (file.endsWith('.map')) {
      let sources = [];
      try {
        const map = JSON.parse(text);
        sources = [...(map.sources ?? []), ...(map.sections ?? []).flatMap((section) => section.map?.sources ?? [])];
      } catch {
        continue;
      }
      const bad = sources.filter((source) => /node_modules[\\/]+(?:@vitest|vitest|chai)[\\/]|\.test\.[cm]?[jt]sx?$/.test(source));
      if (bad.length > 0) hits.push(`${file} maps ${bad.slice(0, 3).join(', ')}`);
      continue;
    }
    const match = TEST_TOOLING_PATTERNS.map((pattern) => pattern.exec(text)).find(Boolean);
    if (match) hits.push(`${file} contains ${JSON.stringify(match[0].slice(0, 80))}`);
  }
  return hits;
}

/** Whether `dir` lies inside `root` (or is it). Node resolves packages up the tree, so a scaffold
 * inside the monorepo would find the root node_modules, vitest included, and hide exactly the
 * missing-package failures this rehearsal exists to catch. */
function isInside(dir, root) {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Empties `dir` and creates it again (creates it when missing). Only a folder strictly inside the
 * work folder, whose parent exists: checked as written and by real path, because a link between the
 * work folder and `dir` would aim the removal wherever it points. A link at `dir` itself is refused
 * too, rather than trusting how each platform removes one.
 */
function emptyFolderInside(dir, workdir) {
  const target = path.resolve(dir);
  const root = path.resolve(workdir);
  if (target === root || !isInside(target, root)) {
    throw new Error(`Refusing to empty ${target}: the rehearsal only empties folders inside its work folder ${root}`);
  }
  // The OS's real paths: links resolved, and on Windows 8.3 short names (C:\Users\ABCDEF~1) expanded.
  const realRoot = fs.realpathSync.native(root);
  const realParent = fs.realpathSync.native(path.dirname(target));
  if (!isInside(realParent, realRoot)) {
    throw new Error(`Refusing to empty ${target}: it is really in ${realParent}, outside the work folder ${realRoot}; is a folder on the way a link?`);
  }
  let stat = null;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to empty ${target}: it is a link`);
  // Retries for the Windows locks a scanner or an indexer holds on files an earlier run wrote.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(target);
}

/**
 * The CLI step's folders, empty: `<workdir>/cli`, where it packs create-nextblock, and
 * `cli/extract`, where it unpacks that tarball and runs the CLI. tar only adds and overwrites, so
 * an earlier run's extraction (a --skip-pack re-run reuses the work folder) kept every file deleted
 * from the template since, and the CLI copies its whole template folder into the scaffold. Nothing in
 * cli/ has to survive: every run that reaches the CLI step packs it again.
 *
 * @returns {{ cliDir: string, extractDir: string }}
 */
function prepareCliFolders(workdir) {
  const cliDir = path.join(path.resolve(workdir), 'cli');
  const extractDir = path.join(cliDir, 'extract');
  emptyFolderInside(cliDir, workdir);
  fs.mkdirSync(extractDir);
  return { cliDir, extractDir };
}

module.exports = {
  ECOM_IMPORT_NAME,
  ECOM_PUBLISHED_NAME,
  REHEARSED_LIBS,
  compareWithBudget,
  emptyFolderInside,
  findBundledTestTooling,
  findPackagesNotFromTarballs,
  isInside,
  parseTscOutput,
  prepareCliFolders,
  rewireToTarballs,
  tarballSpecs,
};
