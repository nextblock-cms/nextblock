#!/usr/bin/env node
// Refuses to let a broken library build reach npm.
//
//   node tools/scripts/verify-lib-dist.js <lib>        (utils | ui | sdk | db | editor | ecommerce | cortex)
//   node tools/scripts/verify-lib-dist.js              (every lib that has a dist/libs/<lib> build)
//
// release-lib.js calls `verifyLibDist` right after the Nx build and before `npm publish`.
// Every check here exists because the failure it catches shipped once and was invisible
// inside the monorepo, where `@nextblock-cms/*` resolves through tsconfig paths straight to
// TypeScript source; it only broke `next build` in scaffolded projects, which install the
// published packages:
//
//   1. Development JSX. Unless NODE_ENV is `production`, a release build can inherit
//      NODE_ENV=development from Nx's project-graph step (see release-lib.js), so plugin-react
//      emitted `jsxDEV(..., this)` with the builder's absolute source paths. Besides leaking
//      `C:/Users/...` and shipping the dev runtime, the `this` argument is illegal inside a file
//      with inline server actions ("Server Actions cannot use `this`"), which failed every
//      scaffold build once ecommerce gained such files.
//   2. Subpaths consumers import that the package does not actually contain. With
//      preserveModules only modules reachable from a build entry are emitted, so a module
//      that is imported ONLY through its subpath (`@nextblock-cms/utils/script-safety`) ships
//      a `.d.ts` and no JavaScript.
//   3. Exports the TypeScript source has but the build lost. `libs/db` and `libs/utils` track
//      stale compiled twins (`foo.js` beside `foo.ts`); Vite's default extension order picked
//      the `.js`, so the package was assembled from months-old code.
//   4. Declaration files that were never written. vite-plugin-dts only LOGS TypeScript's
//      declaration-emit errors (TS4058 "... cannot be named", TS2742, ...) and carries on: the
//      build exits 0, the JavaScript is fine, and the module whose types could not be written
//      gets no `.d.ts` at all. cortex shipped that way through 0.19.2: `index.d.ts` re-exported
//      `./lib/ai-global-agent-tools`, the file did not exist, and because scaffolds compile
//      with `skipLibCheck` nothing failed. `createCortexGlobalAgentTools` was just `any`.
//   5. Files the tarball leaves out. Checks 1-4 read the dist directory, but `npm publish`
//      packs only what the manifest's `files` whitelist lets through. libs/ui listed its
//      code-split chunks as `index-*.mjs`; Vite 8 (Rolldown) names them differently, and
//      `index.mjs` imports one of them statically, so the tarball would have shipped an entry
//      point that cannot load. This check asks `npm pack --dry-run` for the real file list
//      and resolves every relative import in it.
//   6. Rolldown's require() shim in ESM output (see the check for details).
//   7. A CommonJS side that cannot load, or loads as the wrong kind of module. Only the ESM
//      files run in scaffolds, so these shipped unnoticed: cortex and ecom are
//      `"type": "module"` and published their `require` entries as `index.cjs.js`, which
//      Node parses as ESM; ui and editor put 'use client' back on `index.mjs` only; utils
//      published a hand-written ESM server entry with a 'use server' its compiled CommonJS
//      twin lacked; and ui's `main` / `module` named files that were never built.
//   8. The npm package page. Through 0.20 no package but sdk shipped a README (the old
//      executor's `assets` option copied nothing), the first fix published Nx's generated
//      "This library was generated with Nx" stubs, the READMEs that did exist linked to
//      `../../docs/...` (a 404 on npmjs.com), five manifests dropped `license`, and cortex and
//      ecom pointed `repository` at a GitHub repo that does not exist.

const { execSync } = require('node:child_process');
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
      // Build configs talk ABOUT specifiers (comments, export maps); they do not import them.
      if (/^vite\.config\.[a-z]+$/.test(path.basename(file))) return;

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

/** The declaration file TypeScript would load for an `exports` entry, as it resolves it. */
function pickTypesTarget(entry) {
  if (typeof entry === 'string') {
    // No `types` condition: TypeScript looks for the `.d.ts` beside the JavaScript file.
    return /\.d\.(c|m)?ts$/.test(entry) ? entry : entry.replace(/\.(c|m)?js$/i, '.d.ts');
  }
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.types === 'string') return entry.types;

  for (const condition of ['import', 'default', 'require']) {
    const nested = pickTypesTarget(entry[condition]);
    if (nested) return nested;
  }

  return null;
}

function resolveThroughExports(exportsMap, subpath, pick = pickTarget) {
  const key = subpath ? `./${subpath}` : '.';

  if (exportsMap[key] !== undefined) return pick(exportsMap[key]);

  // Longest wildcard prefix wins, as in Node's resolution.
  const wildcards = Object.keys(exportsMap)
    .filter((candidate) => candidate.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*'));

  for (const candidate of wildcards) {
    const [prefix, suffix] = candidate.split('*');

    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      const middle = key.slice(prefix.length, key.length - suffix.length);
      const target = pick(exportsMap[candidate]);

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

/* ------------------------------ 4. declaration files ------------------------------ */

const NON_CODE_SPECIFIER = /\.(css|scss|json|svg|png|jpe?g|webp|gif|woff2?)$/i;

function declarationExists(base) {
  const withoutJsExtension = base.replace(/\.(c|m)?js$/i, '');

  return [
    `${withoutJsExtension}.d.ts`,
    `${withoutJsExtension}.d.mts`,
    `${withoutJsExtension}.d.cts`,
    path.join(withoutJsExtension, 'index.d.ts'),
  ].some((candidate) => fs.existsSync(candidate));
}

/** Relative imports inside emitted `.d.ts` files that resolve to no declaration file. */
function findDanglingDeclarationImports(distDir) {
  const problems = [];
  const seen = new Set();

  walk(distDir, (file) => {
    if (!/\.d\.(c|m)?ts$/.test(file)) return;

    const text = fs.readFileSync(file, 'utf8');

    // `from './x'`, `import './x'` and `import('./x')`.
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const specifier = match[1];

      if (NON_CODE_SPECIFIER.test(specifier)) continue;

      const target = path.resolve(path.dirname(file), specifier);
      const key = `${file}|${specifier}`;

      if (seen.has(key) || declarationExists(target)) continue;
      seen.add(key);

      problems.push(
        `${path.relative(distDir, file)} imports "${specifier}" but no declaration file was emitted for it — ` +
          (specifier.includes('/src/')
            ? 'a workspace alias was rewritten to a monorepo source path; the dts plugin needs aliasesExclude'
            : 'look for "error TS" in the build log (usually TS4058: export the type it cannot name)')
      );
    }

    // Sibling libraries, by package name. They must resolve through the sibling's OWN
    // published `exports` to a declaration file, or the type is `any` for every consumer
    // (`@nextblock-cms/db/types` resolved through a tsconfig path here and nowhere else).
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]@nextblock-cms\/([^'"/]+)(?:\/([^'"]+))?['"]/g)) {
      const [, packageName, subpath = ''] = match;
      const siblingDir = distDirFor(packageName);
      const siblingManifest = path.join(siblingDir, 'package.json');
      const key = `bare|${packageName}|${subpath}`;

      // Not built in this run: nothing to check it against.
      if (seen.has(key) || !fs.existsSync(siblingManifest)) continue;
      seen.add(key);

      const manifest = JSON.parse(fs.readFileSync(siblingManifest, 'utf8'));
      const exportsMap = manifest.exports ?? publishExportsFor(packageName) ?? { '.': manifest.types ?? './index.d.ts' };
      const target = resolveThroughExports(exportsMap, subpath, pickTypesTarget);
      const specifier = `@nextblock-cms/${packageName}${subpath ? `/${subpath}` : ''}`;

      if (!target) {
        problems.push(`${path.relative(distDir, file)} imports "${specifier}" but that package has no "exports" key for it`);
      } else if (!fs.existsSync(path.join(siblingDir, target))) {
        problems.push(`${path.relative(distDir, file)} imports "${specifier}" but ${target} does not exist in that package`);
      }
    }
  });

  return problems;
}

/* ------------------------------ 5. packed files ------------------------------ */

/** The paths `npm publish` would put in the tarball, relative to the package root, with `/`. */
function listPackedFiles(distDir) {
  let output;

  try {
    // --ignore-scripts: a copied source manifest may carry lifecycle scripts, and they must
    // not run from inside dist/. The file list does not depend on them.
    output = execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: distDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`npm pack --dry-run failed in ${path.relative(workspaceRoot, distDir) || distDir}: ${detail}`);
  }

  let report;

  try {
    // npm writes notices and warnings to stderr; stdout is the JSON array alone.
    [report] = JSON.parse(output);
  } catch {
    throw new Error(`npm pack --dry-run --json printed no JSON in ${path.relative(workspaceRoot, distDir) || distDir}: ${output.slice(0, 200)}`);
  }

  return new Set(report.files.map((file) => file.path.replace(/\\/g, '/').replace(/^\.\//, '')));
}

const CODE_FILE = /\.(c|m)?js$/;
const DECLARATION_FILE = /\.d\.(c|m)?ts$/;

/**
 * Relative specifiers a file really imports: `import`/`export … from`, bare `import`,
 * `import()`, `require()` and, in declarations, `import("./x").T`. Parsed with TypeScript
 * (a root devDependency) rather than matched with a regex, because bundled dependencies keep
 * their comments: highlight.js ships `@typedef { import("./html_renderer").Renderer }` inside
 * the editor bundle, which is not an import.
 */
function relativeSpecifiersIn(file, text) {
  const ts = require('typescript');
  const scriptKind = DECLARATION_FILE.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind);
  const specifiers = new Set();

  const add = (node) => {
    if (node && ts.isStringLiteralLike(node) && /^\.{1,2}\//.test(node.text)) specifiers.add(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return specifiers;
}

/** Every string target in an `exports` map (all conditions), e.g. './index.mjs' or './lib/*.es.js'. */
function collectExportTargets(entry, targets = new Set()) {
  if (typeof entry === 'string') {
    targets.add(entry);
  } else if (entry && typeof entry === 'object') {
    for (const nested of Object.values(entry)) collectExportTargets(nested, targets);
  }

  return targets;
}

/**
 * Relative imports in the files `npm pack` would publish that point at a file it would not,
 * plus `exports` targets it would not publish. Exported so the check can be exercised on a
 * scratch copy of a dist directory.
 */
function findUnpackedFiles(library, distDir) {
  const packed = listPackedFiles(distDir);
  const problems = [];

  // Extension-less specifiers resolve the way the consumer's bundler does, with the
  // extensions this package's JavaScript actually uses.
  const codeExtensions = [
    ...new Set([...packed].filter((file) => CODE_FILE.test(file)).map((file) => path.posix.extname(file))),
  ];
  const codeCandidates = (base) => [
    base,
    ...codeExtensions.map((extension) => `${base}${extension}`),
    ...codeExtensions.map((extension) => `${base}/index${extension}`),
  ];
  const declarationCandidates = (base) => {
    const withoutJsExtension = base.replace(/\.(c|m)?js$/i, '');

    return [
      base,
      `${withoutJsExtension}.d.ts`,
      `${withoutJsExtension}.d.mts`,
      `${withoutJsExtension}.d.cts`,
      `${withoutJsExtension}/index.d.ts`,
    ];
  };

  for (const file of [...packed].sort()) {
    const isDeclaration = DECLARATION_FILE.test(file);

    if (!isDeclaration && !CODE_FILE.test(file)) continue;

    const text = fs.readFileSync(path.join(distDir, ...file.split('/')), 'utf8');

    for (const specifier of relativeSpecifiersIn(file, text)) {
      // A declaration's stylesheet/asset import is a type-level no-op (same rule as check 4).
      if (isDeclaration && NON_CODE_SPECIFIER.test(specifier)) continue;

      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/[?#].*$/, '')));
      const outside = base === '..' || base.startsWith('../');

      if (!outside && (isDeclaration ? declarationCandidates(base) : codeCandidates(base)).some((c) => packed.has(c))) {
        continue;
      }

      problems.push(
        outside
          ? `${file} imports "${specifier}", which points outside the package`
          : `${file} imports "${specifier}" but the tarball has no ${base} — widen "files" in the package.json the build writes`
      );
    }
  }

  // The entry points themselves: a whitelist that drops `index.mjs` leaves nothing importing
  // it, so the loop above would pass. Same manifest fallback as check 2.
  const manifestPath = path.join(distDir, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const exportsMap = manifest.exports ?? publishExportsFor(library) ?? {};

  for (const target of collectExportTargets(exportsMap)) {
    const normalized = path.posix.normalize(target).replace(/^\.\//, '');

    if (normalized.includes('*')) {
      const [prefix, suffix] = normalized.split('*');
      const matches = [...packed].some(
        (file) => file.startsWith(prefix) && file.endsWith(suffix) && file.length > prefix.length + suffix.length
      );

      if (!matches) problems.push(`"exports" maps to ${target} but the tarball has no file matching it`);
    } else if (!packed.has(normalized)) {
      problems.push(`"exports" maps to ${target} but the tarball does not contain it`);
    }
  }

  return problems;
}

/* --------------------------- 6. require() shim in ESM --------------------------- */

// Rolldown (Vite 8) keeps a CommonJS `require()` of an EXTERNAL module as a `__require()` shim
// in ESM output (Vite 7's commonjs plugin rewrote it into an import). The shim throws "Calling
// `require` for "x" in an environment that doesn't expose the `require` function" in the
// browser and in any ESM consumer, and a bundler cannot analyse it. It shipped in the Vite 8
// builds of editor and ui (bundled use-sync-external-store / react-color's reactcss requiring
// react) and cortex (lazy require('next/cache')). Nothing inside the monorepo runs dist/, so
// only this check sees it.
const REQUIRE_SHIM_MESSAGE = "doesn't expose the `require` function";

function isEsmOutput(file, text) {
  if (file.endsWith('.cjs') || file.endsWith('.cjs.js')) return false;
  if (file.endsWith('.mjs') || file.endsWith('.es.js')) return true;
  return file.endsWith('.js') && /^(import|export)\s/m.test(text);
}

function findRequireShims(distDir) {
  const problems = [];

  walk(distDir, (file) => {
    if (!/\.(m?js)$/.test(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    if (!isEsmOutput(file, text) || !text.includes(REQUIRE_SHIM_MESSAGE)) return;
    problems.push(
      `${path.relative(distDir, file).split(path.sep).join('/')} contains Rolldown's require() shim: a bundled ` +
        'CommonJS module requires an external. Make that CommonJS package external too (and declare it ' +
        'in the lib\'s dependencies), or import the external statically.'
    );
  });

  return problems;
}

/* ------------------------------ 7. module formats ------------------------------ */

const RSC_DIRECTIVES = new Set(['use client', 'use server']);

/** The 'use client' / 'use server' directives in a file's directive prologue. */
function rscDirectivesOf(text) {
  const found = [];
  let rest = text.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    const match = rest.match(/^(['"])([^'"\n]*)\1\s*;?/);
    if (!match) break;
    if (RSC_DIRECTIVES.has(match[2])) found.push(match[2]);
    rest = rest.slice(match[0].length);
  }
  return found.sort().join(', ') || 'none';
}

/** CommonJS output as Rolldown writes it (minified or not). */
const COMMONJS_MARKER = /\bObject\.definePropert(?:y|ies)\(exports\b|\bmodule\.exports\s*=|(?:^|[;,{}\s])exports\.[\w$]+\s*=/;

/** The file a condition's value resolves to: a string, or an object's `default` / `node`. */
function conditionTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return conditionTarget(value.default ?? value.node);
  return undefined;
}

/**
 * Every ESM/CommonJS pair of targets in an exports map, keyed by subpath. The CommonJS side is
 * `require`; the ESM side is `import`, else `module`, else `default` (utils and db publish
 * `{ types, require, default }`).
 */
function collectFormatPairs(exportsMap) {
  const pairs = [];
  const visit = (key, entry) => {
    if (!entry || typeof entry !== 'object') return;
    const cjs = conditionTarget(entry.require);
    const esm = conditionTarget(entry.import ?? entry.module ?? entry.default);
    if (cjs && esm) {
      if (cjs !== esm) pairs.push({ key, esm, cjs });
      return;
    }
    for (const value of Object.values(entry)) visit(key, value);
  };
  for (const [key, entry] of Object.entries(exportsMap)) visit(key, entry);
  return pairs;
}

/** Every `require` target in an exports map, with the subpath it belongs to. */
function collectRequireTargets(exportsMap) {
  const targets = [];
  const visit = (key, entry) => {
    if (!entry || typeof entry !== 'object') return;
    for (const [condition, value] of Object.entries(entry)) {
      if (condition === 'require' && conditionTarget(value)) targets.push({ key, target: conditionTarget(value) });
      else visit(key, value);
    }
  };
  for (const [key, entry] of Object.entries(exportsMap)) visit(key, entry);
  return targets;
}

/** A wildcard pair (`./lib/*.es.js` / `./lib/*.cjs`) as one concrete pair per built ESM file. */
function expandFormatPair(distDir, pair) {
  if (!pair.esm.includes('*') || !pair.cjs.includes('*')) return [pair];
  const [prefix, suffix] = pair.esm.replace(/^\.\//, '').split('*');
  const expanded = [];
  walk(distDir, (file) => {
    const relative = path.relative(distDir, file).split(path.sep).join('/');
    if (!relative.startsWith(prefix) || !relative.endsWith(suffix)) return;
    if (relative.length <= prefix.length + suffix.length) return;
    const star = relative.slice(prefix.length, relative.length - suffix.length);
    expanded.push({ key: pair.key.replace('*', star), esm: `./${relative}`, cjs: pair.cjs.replace('*', star) });
  });
  return expanded;
}

function findModuleFormatProblems(library, distDir) {
  const manifestPath = path.join(distDir, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const exportsMap = manifest.exports ?? publishExportsFor(library) ?? {};
  const isModulePackage = manifest.type === 'module';
  const problems = [];
  const rel = (file) => path.relative(distDir, file).split(path.sep).join('/');

  for (const field of ['main', 'module', 'types']) {
    const target = manifest[field];
    if (typeof target === 'string' && !fs.existsSync(path.join(distDir, target))) {
      problems.push(`"${field}" is ${target}, which the build did not write`);
    }
  }

  if (isModulePackage) {
    const requireTargets = [
      ...(typeof manifest.main === 'string' ? [['"main"', manifest.main]] : []),
      ...collectRequireTargets(exportsMap).map(({ key, target }) => [`"exports" ${key} require`, target]),
    ];
    for (const [where, target] of requireTargets) {
      if (!target.endsWith('.cjs')) {
        problems.push(`${where} is ${target}: this package is "type": "module", so a CommonJS file needs the .cjs extension`);
      }
    }
    walk(distDir, (file) => {
      // `.es.js` is the ESM output by name; only an unmarked `.js` can be CommonJS in disguise.
      if (!file.endsWith('.js') || file.endsWith('.es.js')) return;
      if (COMMONJS_MARKER.test(fs.readFileSync(file, 'utf8'))) {
        problems.push(`${rel(file)} is CommonJS in a "type": "module" package, so Node loads it as ESM; emit it as .cjs`);
      }
    });
  }

  const pairs = collectFormatPairs(exportsMap).flatMap((pair) => expandFormatPair(distDir, pair));
  for (const { key, esm, cjs } of pairs) {
    const esmFile = path.join(distDir, esm);
    const cjsFile = path.join(distDir, cjs);
    if (!fs.existsSync(esmFile) || !fs.existsSync(cjsFile)) continue; // check 5 reports it
    const esmDirectives = rscDirectivesOf(fs.readFileSync(esmFile, 'utf8'));
    const cjsDirectives = rscDirectivesOf(fs.readFileSync(cjsFile, 'utf8'));
    if (esmDirectives !== cjsDirectives) {
      problems.push(
        `"exports" ${key}: ${esm} starts with ${esmDirectives} but ${cjs} starts with ${cjsDirectives}; ` +
          'a require() consumer would get a different kind of module'
      );
    }
  }

  return problems;
}

/* ------------------------------ 8. package page ------------------------------ */

const NX_README_STUB = /This library was generated with \[Nx\]/;
/** A Markdown link or image whose target is not absolute: it resolves only inside the monorepo. */
const RELATIVE_MARKDOWN_LINK = /\]\((?!https?:\/\/|#|mailto:)([^)\s]+)\)/g;

function findPackagePageProblems(library, distDir, packed = listPackedFiles(distDir)) {
  const problems = [];
  const readme = [...packed].find((file) => /^readme(\.md)?$/i.test(file));

  if (!readme) {
    problems.push('the tarball has no README.md: copy the lib\'s README into the dist folder');
  } else {
    const text = fs.readFileSync(path.join(distDir, readme), 'utf8');
    if (NX_README_STUB.test(text)) {
      problems.push(`${readme} is Nx's generated stub ("This library was generated with Nx"); write a real one`);
    }
    for (const [, target] of text.matchAll(RELATIVE_MARKDOWN_LINK)) {
      problems.push(`${readme} links to "${target}", which only resolves inside the monorepo; use an absolute URL`);
    }
  }

  const manifestPath = path.join(distDir, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  if (typeof manifest.license !== 'string' || manifest.license.length === 0) {
    problems.push('package.json has no "license"');
  }
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (typeof repositoryUrl !== 'string' || repositoryUrl.length === 0) {
    problems.push('package.json has no "repository"');
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
    ...findDanglingDeclarationImports(distDir).map((entry) => `missing declaration: ${entry}`),
    ...findUnpackedFiles(library, distDir).map((entry) => `not in the npm tarball: ${entry}`),
    ...findRequireShims(distDir).map((entry) => `require() shim in ESM: ${entry}`),
    ...findModuleFormatProblems(library, distDir).map((entry) => `module format: ${entry}`),
    ...findPackagePageProblems(library, distDir).map((entry) => `package page: ${entry}`),
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

module.exports = {
  verifyLibDist,
  findUnpackedFiles,
  findRequireShims,
  findModuleFormatProblems,
  findPackagePageProblems,
};

if (require.main === module) {
  const requested = process.argv[2];
  const libraries = requested
    ? [requested]
    : ['utils', 'ui', 'sdk', 'db', 'editor', 'ecommerce', 'cortex'].filter((library) => fs.existsSync(distDirFor(library)));

  if (libraries.length === 0) {
    console.error('Usage: node tools/scripts/verify-lib-dist.js [utils|ui|sdk|db|editor|ecommerce|cortex] (no dist/libs/* build found)');
    process.exit(1);
  }

  let failed = false;

  for (const library of libraries) {
    try {
      verifyLibDist(library);
      console.log(`✓ dist/libs/${library === 'ecom' ? 'ecommerce' : library} is publishable`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      failed = true;
    }
  }

  if (failed) process.exit(1);
}
