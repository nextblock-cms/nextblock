#!/usr/bin/env node
// Refuses to let a broken library build reach npm.
//
//   node tools/scripts/verify-lib-dist.js <lib>        (utils | ui | sdk | db | editor | ecommerce | cortex | affiliates)
//   node tools/scripts/verify-lib-dist.js              (every lib that has a dist/libs/<lib> build)
//
// The release build (lib/release-steps.js, phase 1 of release-all.js and release-lib.js) calls
// `verifyLibDist` after the Nx build, on the file list of the packed tarball, before anything is
// published. Every check here exists because the failure it catches shipped once and was invisible
// inside the monorepo, where `@nextblock-cms/*` resolves through tsconfig paths straight to
// TypeScript source; it only broke `next build` in scaffolded projects, which install the
// published packages:
//
//   1. Development JSX. Unless NODE_ENV is `production`, a release build can inherit
//      NODE_ENV=development from Nx's project-graph step (see lib/release-steps.js), so plugin-react
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
//   9. `workspace:` dependency specs in the manifest. The premium libs' builds copy the raw
//      source package.json (`"@nextblock-cms/utils": "workspace:*"`); the release build resolves
//      them to the sibling versions, but only for a lib it finalizes. A new lib without that
//      step would publish a manifest every `npm install` refuses (EUNSUPPORTEDPROTOCOL), and
//      the monorepo, which never installs from dist, would not notice.
//  10. A `sideEffects` list that lost its way to npm. Bundlers drop every module the list does
//      not name once nothing uses its exports, which keeps /partners free of the storefront
//      renderer (affiliates). An entry naming a file the tarball lacks (a renamed entry, a new
//      output extension) would silently drop a real side effect in every scaffold: the server
//      entry's `import 'server-only'` guard or the jitless zod config.
//  11. Sibling packages the shipped JavaScript imports but the manifest does not declare. Every
//      lib leaves `@nextblock-cms/*` external, yet editor, ui and db published none of theirs
//      through 0.22.5: the editor then began importing sanitizeAuthoredBlockHtml, which utils
//      0.22.5 lacks, and npm had no way to know, so upgrading only the editor would have failed
//      on a missing export. Scaffolds never noticed because the app depends on every sibling
//      itself. Every `@nextblock-cms/<pkg>` a packed JS file imports must be in `dependencies`
//      or `peerDependencies`; `@nextblock-cms/ecommerce` is the alias of the published
//      `@nextblock-cms/ecom`, so it is declared under that name with an `npm:` spec.
//  12. Dot paths in the tarball. The db build copied libs/db/src/supabase into dist whole, and
//      through the 0.23.4 rehearsal builds that brought the Supabase CLI's local state along:
//      .temp/ (the linked project ref, the pooler URL, the local start secrets) and .branches/.
//      Only the copied supabase/.gitignore kept them out of the tarball (npm honours a nested
//      ignore file inside a `files` whitelist), so renaming it, or adding an .npmignore beside it
//      (even an empty one replaces it), would have published them. copy-db-supabase.cjs now copies
//      no dot entry at any depth; this check refuses any packed path with a segment that starts
//      with '.', a dot folder or a dotfile (.env files included). npm never packs .npmrc,
//      .gitignore or .npmignore, and no lib ships a dot path on purpose, so the check has no
//      exceptions.
//  13. The db package's supabase/ folder. The Supabase CLI also keeps local state there that is
//      not a dot path, which check 12 cannot see: local Studio saves SQL snippets to snippets/
//      (read-write; a snippet can hold customer rows or a pasted key), and `gen signing-key`
//      writes signing_keys.json. Both passed the old copy denylist and check 12. Consumers read
//      only config.toml, migrations/ and templates/ from the package, so supabase/ must hold
//      exactly SUPABASE_PACKAGE_ENTRIES (copy-db-supabase.cjs): no other top-level entry, and none
//      of them missing, since a scaffold refuses a package without config.toml or migrations/.
//      Each counts only in the shape consumers read: config.toml as exactly supabase/config.toml,
//      migrations/ and templates/ as folders with a packed path below them (a file named
//      supabase/migrations is refused, and holds no migration for check 14 to compare).
//      The copy empties dist/libs/db/supabase before it copies: the db build's dts step declared
//      the Deno edge function there (supabase/functions/nextblock-migration-ingest/index.d.ts,
//      until libs/db/vite.config.mts excluded src/supabase), and a merge kept it, so this check
//      refused every fresh db build.
//  14. The files inside db's supabase/migrations and supabase/templates, which check 13 passes
//      once the folder is allowed. Every install applies what ships in migrations/ (the build
//      hook's migrate-core and `npm run update` take any `<digits>_*.sql`), and nothing in the
//      release runs `npm run db:migrate:check`: a file the Supabase CLI writes with a timestamped
//      name (`migration new`, `db diff -f`, `db pull`) would sort after every GGNNN version and run
//      on every downstream database. So the packed migrations must pass validateMigrationNames
//      (tools/scripts/lib/migration-naming.js: GGNNN_<snake_name>.sql, one generation, contiguous),
//      flat, with no other file beside them (a .sql name without a <digits>_ prefix included: no
//      applier runs it, and db:migrate:check never lists it), and templates/ may hold only the
//      Auth email templates (*.html). A well-named migration can still be one that was never
//      meant to ship (a work-in-progress 02043 left in the folder), so the packed names must also
//      equal the names the /setup bundle embeds (apps/nextblock/lib/setup/migrations-bundle.ts,
//      written by npm run generate:migrations-bundle): /setup on a serverless host applies the
//      bundle, and the two lists drifting apart would also give /setup and npm run update
//      different sets of migrations. A migrations/ folder that holds no top-level <digits>_*.sql
//      file (only stray files, a subfolder or dot paths) is refused too. Only the names are compared, not the SQL: a migration edited after
//      the bundle was generated still passes, and a file that was bundled as well still ships.
//  15. Third-party packages the tarball imports but the manifest does not declare. ui's button.d.ts
//      and badge.d.ts import class-variance-authority, which nothing in a scaffold installs, so
//      TypeScript read `variant` and `size` as missing: 457 errors in every scaffold through 0.23.5,
//      hidden by `typescript.ignoreBuildErrors`. The radix packages behind ui's dialogs and menus
//      and the tiptap packages behind the editor's types resolved nowhere either, so their props
//      were silently `any`. And utils, ui, editor and db imported react, react-dom, next,
//      server-only or @supabase/* at runtime without declaring them, which worked only because the
//      app installs them itself. In the shipped JavaScript every package must be declared
//      (`dependencies`, `peerDependencies` or `optionalDependencies`). In a declaration file a
//      package npm installs along with a declared one also resolves (TypeScript writes
//      `import("@supabase/postgrest-js")` for a type inferred through @supabase/supabase-js), and a
//      package that ships no types of its own needs its @types package declared too, unless it is a
//      peer (the project that provides react provides @types/react). Node's own modules need nothing,
//      and `@nextblock-cms/*` imports in JavaScript are check 11's.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const { builtinModules } = require('node:module');
const path = require('node:path');
const { SUPABASE_PACKAGE_ENTRIES } = require('./copy-db-supabase.cjs');
const { MIGRATION_FILE_RE, validateMigrationNames } = require('./lib/migration-naming');
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
  // the release build writes the map before it packs. Judge the map that will ship.
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
 * The module specifiers `accept` keeps, out of every one a file really imports:
 * `import`/`export … from`, bare `import`, `import()`, `require()` and, in declarations,
 * `import("./x").T`. Parsed with TypeScript (a root devDependency) rather than matched with a
 * regex, because bundled dependencies keep their comments and strings: highlight.js ships
 * `@typedef { import("./html_renderer").Renderer }` inside the editor bundle, and utils throws
 * "@nextblock-cms/utils server helpers cannot be imported …", and neither is an import.
 *
 * With `declarationReferences`, a declaration file's other ways of naming a package count too:
 * `/// <reference types="x" />` and, in a module, the augmentation `declare module 'x' { … }`
 * (both need the package to resolve, or the types they add are lost).
 */
function moduleSpecifiersIn(file, text, accept, { declarationReferences = false } = {}) {
  const ts = require('typescript');
  const scriptKind = DECLARATION_FILE.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind);
  const specifiers = new Set();

  const add = (node) => {
    if (node && ts.isStringLiteralLike(node) && accept(node.text)) specifiers.add(node.text);
  };

  if (declarationReferences) {
    for (const reference of source.typeReferenceDirectives) {
      if (accept(reference.fileName)) specifiers.add(reference.fileName);
    }
    if (ts.isExternalModule(source)) {
      for (const statement of source.statements) {
        if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) add(statement.name);
      }
    }
  }

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

/** The relative specifiers a file really imports (see moduleSpecifiersIn). */
function relativeSpecifiersIn(file, text) {
  return moduleSpecifiersIn(file, text, (specifier) => /^\.{1,2}\//.test(specifier));
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
function findUnpackedFiles(library, distDir, packed = listPackedFiles(distDir)) {
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

/* ---------------------------- 9. workspace: dependencies ---------------------------- */

const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

/**
 * `workspace:` specs left in the dist manifest. Judges the manifest that will ship, like checks
 * 2, 5 and 7: when `manifestFinalized` is false (a plain `nx build`, before the release build has
 * run) the `dependencies` of a lib the release build finalizes (it has a `publishExportsFor`
 * map) are still to be resolved, so only the sections that step does not rewrite count.
 * The release build (lib/release-steps.js) passes `manifestFinalized: true`, and then every
 * `workspace:` spec is a problem.
 */
function findWorkspaceProtocolDependencies(library, distDir, { manifestFinalized = false } = {}) {
  const manifestPath = path.join(distDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return [];

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const finalizedLater = !manifestFinalized && publishExportsFor(library) !== null;
  const problems = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    if (finalizedLater && (section === 'dependencies' || section === 'optionalDependencies' || section === 'peerDependencies')) {
      continue;
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.trim().startsWith('workspace:')) {
        problems.push(
          `${section}["${name}"] is "${spec}": npm cannot install the workspace protocol; resolve it to a published version (release-lib.js finalizes premium manifests through publishExportsFor)`
        );
      }
    }
  }

  return problems;
}

/* ------------------------------ 10. sideEffects ------------------------------ */

/** The lib's own manifest (`libs/<lib>/package.json`, the one the build copies), or null. */
function readSourceManifest(library) {
  const manifestPath = path.join(workspaceRoot, 'libs', library === 'ecom' ? 'ecommerce' : library, 'package.json');
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
}

/** A `sideEffects` wildcard as a RegExp over packed paths (`*` within a segment, `**` across). */
function sideEffectsWildcard(pattern) {
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  // Without a slash, bundlers match the pattern against the file name in any directory.
  return new RegExp(`^${pattern.includes('/') ? '' : '(?:.*/)?'}${source}$`);
}

/**
 * Problems with the dist manifest's `sideEffects`: it must equal the source manifest's list
 * (release-lib.js copies the field through), and every entry outside `./src/` (the source form
 * the monorepo reads) must name a file the tarball contains, or a wildcard matching one.
 * `packed` and `sourceManifest` are parameters so tests never run `npm pack`.
 */
function findSideEffectsProblems(library, distDir, packed = listPackedFiles(distDir), sourceManifest = readSourceManifest(library)) {
  const manifestPath = path.join(distDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return [];

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];

  if (
    sourceManifest &&
    sourceManifest.sideEffects !== undefined &&
    JSON.stringify(manifest.sideEffects) !== JSON.stringify(sourceManifest.sideEffects)
  ) {
    problems.push('"sideEffects" differs from the source package.json; the dist manifest must carry the same list');
  }

  const list = manifest.sideEffects;
  if (list === undefined || typeof list === 'boolean') return problems;
  if (!Array.isArray(list)) return [...problems, '"sideEffects" must be a boolean or an array of paths'];

  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      problems.push(`"sideEffects" has an entry that is not a path: ${JSON.stringify(entry)}`);
      continue;
    }

    const normalized = path.posix.normalize(entry).replace(/^\.\//, '');
    if (normalized.startsWith('src/')) continue;
    if (/[?[\]{}!]/.test(normalized)) continue; // glob syntax this check does not model

    if (normalized.includes('*')) {
      const pattern = sideEffectsWildcard(normalized);
      if (![...packed].some((file) => pattern.test(file))) {
        problems.push(`"sideEffects" pattern ${entry} matches no file in the tarball`);
      }
    } else if (!packed.has(normalized)) {
      problems.push(
        `"sideEffects" lists ${entry} but the tarball does not contain it, so bundlers may drop the side effect of the module it meant`
      );
    }
  }

  return problems;
}

/* ---------------------------- 11. undeclared siblings ---------------------------- */

/** The package part of a sibling specifier: `@nextblock-cms/ui` out of `@nextblock-cms/ui/button`. */
const SIBLING_PACKAGE = /^@nextblock-cms\/[^/]+/;
/** The import name the app and the libs use for the package npm knows as @nextblock-cms/ecom. */
const ECOM_IMPORT_NAME = '@nextblock-cms/ecommerce';
const ECOM_PUBLISHED_NAME = '@nextblock-cms/ecom';
const ECOM_ALIAS_SPEC = /^npm:@nextblock-cms\/ecom(?:@|$)/;
/** The sections npm installs a declared sibling from (an optional one may silently be absent). */
const SIBLING_SECTIONS = ['dependencies', 'peerDependencies'];

/**
 * Sibling packages (`@nextblock-cms/*`) that a JavaScript file in the tarball imports but the
 * dist manifest declares in neither `dependencies` nor `peerDependencies`. Judges the manifest
 * that will ship, like check 9: a `workspace:` spec counts as declared (release-lib.js resolves
 * it for a lib it finalizes, and check 9 refuses one it leaves behind). A package importing
 * itself needs no declaration; ecom is imported as @nextblock-cms/ecommerce everywhere, itself
 * included. `packed` is a parameter so tests never run `npm pack`.
 */
function findUndeclaredSiblingImports(library, distDir, packed = listPackedFiles(distDir)) {
  const manifestPath = path.join(distDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return []; // checks 2 and 5 report a missing manifest

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const self = new Set([manifest.name, importNameFor(library)]);
  /** package name -> the first file (sorted) importing it, and the specifier it used */
  const imported = new Map();

  for (const file of [...packed].sort()) {
    if (!CODE_FILE.test(file)) continue;

    const text = fs.readFileSync(path.join(distDir, ...file.split('/')), 'utf8');
    if (!text.includes('@nextblock-cms/')) continue; // nothing to find; spare the parse

    for (const specifier of moduleSpecifiersIn(file, text, (candidate) => SIBLING_PACKAGE.test(candidate))) {
      const name = specifier.match(SIBLING_PACKAGE)[0];
      if (!self.has(name) && !imported.has(name)) imported.set(name, { file, specifier });
    }
  }

  const problems = [];

  for (const [name, { file, specifier }] of imported) {
    const declared = SIBLING_SECTIONS.flatMap((section) =>
      manifest[section] && typeof manifest[section] === 'object' && manifest[section][name] !== undefined
        ? [{ section, spec: manifest[section][name] }]
        : []
    );

    if (declared.length === 0) {
      const aliasHint =
        name === ECOM_IMPORT_NAME && SIBLING_SECTIONS.some((section) => manifest[section]?.[ECOM_PUBLISHED_NAME] !== undefined)
          ? `; declaring ${ECOM_PUBLISHED_NAME} installs it under that name, so declare "${ECOM_IMPORT_NAME}": "npm:${ECOM_PUBLISHED_NAME}@<range>" instead`
          : '';
      problems.push(
        `${file} imports "${specifier}" but neither "dependencies" nor "peerDependencies" declares ${name}, so npm cannot ` +
          `tell which release this build needs; declare it in the package.json the build writes${aliasHint}`
      );
      continue;
    }

    if (name !== ECOM_IMPORT_NAME) continue;

    for (const { section, spec } of declared) {
      if (typeof spec === 'string' && (spec.trim().startsWith('workspace:') || ECOM_ALIAS_SPEC.test(spec.trim()))) continue;
      problems.push(
        `${section}["${name}"] is ${JSON.stringify(spec)}, which installs a package named ${name}; NextBlock publishes it as ` +
          `${ECOM_PUBLISHED_NAME}, so the spec must be "npm:${ECOM_PUBLISHED_NAME}@<range>"`
      );
    }
  }

  return problems;
}

/* ------------------------------ 12. dot paths ------------------------------ */

/**
 * Packed paths with a segment that starts with '.'. A dot path that must ship one day gets its own
 * commented exception here, never a looser rule. `packed` is a parameter so tests never run
 * `npm pack`.
 */
function findPackedDotPaths(library, distDir, packed = listPackedFiles(distDir)) {
  const problems = [];

  for (const file of [...packed].sort()) {
    if (!file.split('/').some((segment) => segment.startsWith('.'))) continue;

    const fix =
      library === 'db' && file.startsWith('supabase/')
        ? 'tools/scripts/copy-db-supabase.cjs empties dist/libs/db/supabase and copies no dot entry into it, so a stale build or a step after the copy wrote it; rebuild with nx build db, and find that step if it comes back'
        : 'stop the build from writing it to the dist folder; an ignore file only hides it until that file is renamed or shadowed';
    problems.push(
      `${file} would be published. Dot folders and dotfiles are local state, tool config or secrets (the Supabase CLI's .temp/, .env files), not package content: ${fix}`
    );
  }

  return problems;
}

/* ------------------------- 13. the db package's supabase/ ------------------------- */

/** The SUPABASE_PACKAGE_ENTRIES consumers read as a file; the others (migrations/, templates/) are folders. */
const SUPABASE_FILE_ENTRIES = new Set(['config.toml']);

const SUPABASE_ENTRY_READERS =
  'new projects copy it from the package (create-nextblock refuses a package without config.toml or migrations/, and templates/ holds the Auth emails)';

/**
 * The db tarball's supabase/ folder by top-level entry (dot entries aside, check 12's): entry ->
 * whether `supabase/<entry>` itself is a packed file (`file`) and the packed paths below it
 * (`below`, sorted).
 *
 * @param {Iterable<string>} packed
 * @returns {Map<string, { file: boolean, below: string[] }>}
 */
function readPackedSupabaseEntries(packed) {
  const entries = new Map();

  for (const file of [...packed].sort()) {
    const [root, entry, ...rest] = file.split('/');
    if (root !== 'supabase' || !entry || entry.startsWith('.')) continue;
    if (!entries.has(entry)) entries.set(entry, { file: false, below: [] });
    if (rest.length === 0) entries.get(entry).file = true;
    else entries.get(entry).below.push(file);
  }

  return entries;
}

/**
 * Whether one of SUPABASE_PACKAGE_ENTRIES ships in the shape consumers read: config.toml as exactly
 * supabase/config.toml, migrations/ and templates/ as folders with a packed path below them.
 */
function hasPackedSupabaseEntry(entries, entry) {
  const packedEntry = entries.get(entry);
  if (!packedEntry) return false;
  return SUPABASE_FILE_ENTRIES.has(entry) ? packedEntry.file : packedEntry.below.length > 0;
}

/**
 * The db tarball's supabase/ folder must hold exactly SUPABASE_PACKAGE_ENTRIES (from
 * copy-db-supabase.cjs), each in the shape consumers read (SUPABASE_FILE_ENTRIES are files, the
 * rest folders): any other top-level entry is refused, and so is a missing one or one packed in
 * the other shape (a file named supabase/migrations holds no migration). Dot entries are check
 * 12's, and libs other than db ship no supabase/ folder. `packed` is a parameter so tests never
 * run `npm pack`.
 */
function findSupabaseFolderProblems(library, distDir, packed = listPackedFiles(distDir)) {
  if (library !== 'db') return [];

  const entries = readPackedSupabaseEntries(packed);
  const shipped = SUPABASE_PACKAGE_ENTRIES.join(', ');
  const problems = [];

  for (const [entry, { file, below }] of entries) {
    if (SUPABASE_PACKAGE_ENTRIES.includes(entry)) continue;
    // Named by its first packed path: the entry itself when it is a file.
    problems.push(
      `${file ? `supabase/${entry}` : below[0]} would be published. supabase/ ships only what consumers read from the package (${shipped}); the rest is the Supabase CLI's local state (local Studio's snippets/, signing_keys.json) or monorepo-only (functions/): rebuild with nx build db if dist/libs/db is stale, or add the entry to SUPABASE_PACKAGE_ENTRIES (tools/scripts/copy-db-supabase.cjs) once a consumer reads it`
    );
  }

  for (const entry of SUPABASE_PACKAGE_ENTRIES) {
    const packedEntry = entries.get(entry);
    const shape = SUPABASE_FILE_ENTRIES.has(entry) ? 'file' : 'folder';
    // A folder entry packed as a file, or a file entry with paths below it.
    const misshapen = packedEntry && (shape === 'folder' ? packedEntry.file : packedEntry.below.length > 0);
    if (misshapen) {
      const inside = shape === 'file' ? ` (${packedEntry.below[0]})` : '';
      problems.push(
        `supabase/${entry} would be published as a ${shape === 'file' ? 'folder' : 'file'}${inside}, but consumers read it as a ${shape}: ${SUPABASE_ENTRY_READERS}; check that libs/db/src/supabase/${entry} is a ${shape} and that the db build ran tools/scripts/copy-db-supabase.cjs`
      );
    } else if (!hasPackedSupabaseEntry(entries, entry)) {
      problems.push(
        `the tarball has no supabase/${entry}: ${SUPABASE_ENTRY_READERS}; check that libs/db/src/supabase/${entry} exists and that the db build ran tools/scripts/copy-db-supabase.cjs`
      );
    }
  }

  return problems;
}

/* --------------------- 14. files inside db's supabase/migrations and templates --------------------- */

const SHIPPED_MIGRATIONS_RULE =
  'every install applies the migrations this package ships (migrate-core and npm run update take any <digits>_*.sql), so only the ' +
  "current generation's GGNNN_<snake_name>.sql files may ship: rename or remove it in libs/db/src/supabase/migrations (the " +
  "Supabase CLI's migration new, db diff -f and db pull write timestamped names), run npm run db:migrate:check and rebuild";

/** The /setup wizard's embedded migrations, generated by tools/scripts/generate-migrations-bundle.ts. */
const MIGRATIONS_BUNDLE_PATH = 'apps/nextblock/lib/setup/migrations-bundle.ts';
const MIGRATIONS_BUNDLE_RULE =
  `migrate-core and npm run update apply the migrations this package ships, while /setup on a serverless host applies the ones ` +
  `${MIGRATIONS_BUNDLE_PATH} embeds, so the two lists must match`;

/**
 * The file names the /setup bundle embeds: the `name` of each MIGRATIONS_BUNDLE entry, read with the
 * TypeScript parser, so an entry's SQL (one JSON-escaped string, which may well say "name") is never
 * taken for one. Throws, naming npm run generate:migrations-bundle, when the file cannot be read or
 * holds no such array of entries with string names.
 */
function readBundledMigrationNames(bundleFile = path.join(workspaceRoot, ...MIGRATIONS_BUNDLE_PATH.split('/'))) {
  const ts = require('typescript');
  const relative = path.relative(workspaceRoot, bundleFile);
  const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : bundleFile;
  const fail = (reason) => new Error(`${shown} ${reason}; regenerate it with npm run generate:migrations-bundle`);

  let text;
  try {
    text = fs.readFileSync(bundleFile, 'utf8');
  } catch (error) {
    throw fail(`cannot be read (${error.code || error.message})`);
  }

  const source = ts.createSourceFile(bundleFile, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const declaration = source.statements
    .filter((statement) => ts.isVariableStatement(statement))
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'MIGRATIONS_BUNDLE');
  let list = declaration && declaration.initializer;
  while (list && (ts.isAsExpression(list) || ts.isSatisfiesExpression(list) || ts.isParenthesizedExpression(list))) {
    list = list.expression;
  }
  if (!list || !ts.isArrayLiteralExpression(list)) throw fail('declares no MIGRATIONS_BUNDLE array');

  return list.elements.map((element, index) => {
    const property = ts.isObjectLiteralExpression(element)
      ? element.properties.find(
          (candidate) =>
            ts.isPropertyAssignment(candidate) && !ts.isComputedPropertyName(candidate.name) && candidate.name.text === 'name'
        )
      : undefined;
    if (!property || !ts.isStringLiteralLike(property.initializer)) {
      throw fail(`has a MIGRATIONS_BUNDLE entry (index ${index}) without a string "name"`);
    }
    return property.initializer.text;
  });
}

/**
 * Problems with the files in the db tarball's supabase/migrations and supabase/templates:
 * - in migrations/, anything but a top-level `<digits>_*.sql` file (what the appliers and
 *   `npm run db:migrate:check` read; a seed.sql there is no migration, and no applier runs it), and the
 *   names validateMigrationNames refuses (GGNNN_<snake_name>.sql, one generation, contiguous from
 *   000), with db:migrate:check's hint;
 * - a packed migration the /setup bundle does not embed, and a bundled one the tarball lacks
 *   (`bundledMigrationNames`, default readBundledMigrationNames()), compared by name, not SQL; a
 *   packed name that already fails validateMigrationNames on its own is reported for that alone,
 *   since the generator refuses to bundle it until it is fixed; a migrations/ folder with no
 *   migration at all gets one problem for the whole bundle;
 * - in templates/, anything but *.html.
 * Dot paths are check 12's, a missing folder (or one packed as a file) is check 13's, and libs
 * other than db ship no supabase/ folder. `packed` is a parameter so tests never run `npm pack`.
 *
 * @param {string} library
 * @param {string} distDir
 * @param {Set<string>} [packed]
 * @param {{ bundledMigrationNames?: Iterable<string> }} [options]
 */
function findSupabaseFileProblems(library, distDir, packed = listPackedFiles(distDir), { bundledMigrationNames } = {}) {
  if (library !== 'db') return [];

  const migrations = [];
  const problems = [];

  for (const file of [...packed].sort()) {
    const segments = file.split('/');
    if (segments[0] !== 'supabase' || segments.length < 3 || segments.some((segment) => segment.startsWith('.'))) continue;

    if (segments[1] === 'migrations') {
      if (segments.length === 3 && MIGRATION_FILE_RE.test(segments[2])) {
        migrations.push(segments[2]);
      } else {
        problems.push(
          `${file} would be published. supabase/migrations holds only migrations, as top-level GGNNN_<snake_name>.sql files: remove it from libs/db/src/supabase/migrations`
        );
      }
    } else if (segments[1] === 'templates' && !file.endsWith('.html')) {
      problems.push(
        `${file} would be published. supabase/templates holds only the Auth email templates (*.html) that new projects upload: remove it from libs/db/src/supabase/templates`
      );
    }
  }

  if (migrations.length === 0) {
    // A missing supabase/migrations, or one packed as a file, is check 13's. A folder that holds only
    // stray files (reported above) or dot paths (check 12's) ships no migration either: one problem
    // for the whole bundle, rather than one per bundled name.
    if (hasPackedSupabaseEntry(readPackedSupabaseEntries(packed), 'migrations')) {
      const bundled = new Set(bundledMigrationNames ?? readBundledMigrationNames());
      if (bundled.size > 0) {
        problems.push(
          `the tarball ships none of the ${bundled.size} migration${bundled.size === 1 ? '' : 's'} the /setup bundle embeds (${MIGRATIONS_BUNDLE_RULE}): restore them in libs/db/src/supabase/migrations as top-level files (migrations are append-only) and rebuild`
        );
      }
    }
    return problems;
  }

  const misnamed = new Set();
  for (const error of validateMigrationNames(migrations).errors) {
    const named = migrations.find((name) => error.startsWith(`${name}: `));
    if (named) misnamed.add(named);
    problems.push(`${named ? `supabase/migrations/${error}` : `supabase/migrations: ${error}`}; ${SHIPPED_MIGRATIONS_RULE}`);
  }

  const bundled = new Set(bundledMigrationNames ?? readBundledMigrationNames());
  for (const name of migrations) {
    if (bundled.has(name) || misnamed.has(name)) continue;
    problems.push(
      `supabase/migrations/${name} would be published, but the /setup bundle does not embed it (${MIGRATIONS_BUNDLE_RULE}): if it is not meant for this release, take it out of libs/db/src/supabase/migrations and rebuild; if it is, run npm run generate:migrations-bundle`
    );
  }
  for (const name of [...bundled].sort()) {
    if (migrations.includes(name)) continue;
    problems.push(
      `supabase/migrations/${name} is embedded in the /setup bundle, but the tarball does not ship it (${MIGRATIONS_BUNDLE_RULE}): run npm run generate:migrations-bundle if the bundle is stale, or restore the file in libs/db/src/supabase/migrations (migrations are append-only) and rebuild`
    );
  }

  return problems;
}

/* ----------------------- 15. undeclared third-party packages ----------------------- */

/** Node's own modules: no manifest declares them, and their types come with @types/node. */
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
/** The sections npm installs a package from when it installs this one (an optional one may be absent on purpose). */
const DECLARING_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ROOT_NODE_MODULES = path.join(workspaceRoot, 'node_modules');

/** The npm package a bare specifier names: `@tiptap/core` out of `@tiptap/core/dist/x`, `next` out of `next/headers`. */
function packageNameOf(specifier) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

/**
 * A specifier that names an installed package: not relative or absolute, not a URL, a `node:` module
 * or a `#` subpath import, and not one of Node's own modules (`/// <reference types="node" />` included).
 */
function isPackageSpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier === '' || specifier === 'node' || /^[./\\#]/.test(specifier)) return false;
  if (/^[A-Za-z][\w+.-]*:/.test(specifier)) return false;
  return !NODE_BUILTINS.has(specifier) && !NODE_BUILTINS.has(packageNameOf(specifier));
}

/** `@types/scope__name` for `@scope/name`, `@types/name` for `name`: where DefinitelyTyped publishes a package's types. */
function typesPackageFor(name) {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

/** The manifest of a package as the monorepo installed it (hoisted under the root node_modules), or null. */
function readInstalledManifest(name, nodeModulesDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nodeModulesDir, ...name.split('/'), 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Whether an installed package carries its own declarations (`types`, a `types` export condition, an index.d.ts). */
function shipsOwnTypes(name, nodeModulesDir) {
  const manifest = readInstalledManifest(name, nodeModulesDir);
  if (!manifest) return true; // not installed here, so nothing to judge by: leave it to the scaffold rehearsal
  if (manifest.types || manifest.typings || manifest.typesVersions) return true;
  const hasTypesCondition = (entry) =>
    Boolean(entry) && typeof entry === 'object' && ('types' in entry || Object.values(entry).some(hasTypesCondition));
  if (hasTypesCondition(manifest.exports)) return true;
  return fs.existsSync(path.join(nodeModulesDir, ...name.split('/'), 'index.d.ts'));
}

/**
 * Every package npm installs along with `roots`, the roots included: their dependencies, optional
 * dependencies and required peers, recursively, read from the installed manifests.
 */
function installedAlongWith(roots, nodeModulesDir) {
  const installed = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (installed.has(name)) continue;
    installed.add(name);
    const manifest = readInstalledManifest(name, nodeModulesDir);
    if (!manifest) continue;
    for (const section of DECLARING_SECTIONS) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (section === 'peerDependencies' && manifest.peerDependenciesMeta?.[dependency]?.optional) continue;
        if (!installed.has(dependency)) queue.push(dependency);
      }
    }
  }
  return installed;
}

/**
 * Third-party packages (and, in declarations, `@nextblock-cms/*` siblings) that a packed file imports
 * but the dist manifest does not declare (see check 15 at the top of this file). One problem per
 * package, named by the first file (sorted) that imports it. `packed` and `nodeModulesDir` (the
 * installed packages the reachability and types rules read; default the root node_modules) are
 * parameters so tests never run `npm pack` or depend on what the monorepo installed.
 */
function findUndeclaredPackageImports(library, distDir, packed = listPackedFiles(distDir), { nodeModulesDir = ROOT_NODE_MODULES } = {}) {
  const manifestPath = path.join(distDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return []; // checks 2 and 5 report a missing manifest

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const self = new Set([manifest.name, importNameFor(library)]);
  const sectionOf = (name) =>
    DECLARING_SECTIONS.find((section) => manifest[section] && typeof manifest[section] === 'object' && manifest[section][name] !== undefined);
  /** package name -> the first file (sorted) importing it, and the specifier it used */
  const fromCode = new Map();
  const fromDeclarations = new Map();

  for (const file of [...packed].sort()) {
    const isDeclaration = DECLARATION_FILE.test(file);
    if (!isDeclaration && !CODE_FILE.test(file)) continue;

    const text = fs.readFileSync(path.join(distDir, ...file.split('/')), 'utf8');
    const specifiers = moduleSpecifiersIn(file, text, isPackageSpecifier, { declarationReferences: isDeclaration });
    for (const specifier of specifiers) {
      const name = packageNameOf(specifier);
      if (self.has(name)) continue;
      // Siblings in JavaScript are check 11's, with its ecom alias rule.
      if (!isDeclaration && SIBLING_PACKAGE.test(specifier)) continue;
      const found = isDeclaration ? fromDeclarations : fromCode;
      if (!found.has(name)) found.set(name, { file, specifier });
    }
  }

  const problems = [];

  for (const [name, { file, specifier }] of fromCode) {
    if (sectionOf(name)) continue;
    problems.push(
      `${file} imports "${specifier}" but the package.json the build writes declares ${name} in none of dependencies, ` +
        'peerDependencies or optionalDependencies, so a project that installs this package can lack it: declare it ' +
        '(react, react-dom and next as peers, anything the package needs to run as a dependency)'
    );
  }

  const declaredThirdParty = DECLARING_SECTIONS.flatMap((section) =>
    Object.keys(manifest[section] && typeof manifest[section] === 'object' ? manifest[section] : {})
  ).filter((name) => !SIBLING_PACKAGE.test(name));
  let installed = null; // computed once, and only when a declaration needs it
  const installedWithThisPackage = () => (installed ??= installedAlongWith(declaredThirdParty, nodeModulesDir));

  for (const [name, { file, specifier }] of fromDeclarations) {
    const section = sectionOf(name);
    if (SIBLING_PACKAGE.test(name)) {
      if (!section) {
        problems.push(
          `${file} imports types from "${specifier}" but the package.json the build writes does not declare ${name}, so ` +
            'npm cannot tell which release those types come from: declare it as a dependency or peer'
        );
      }
      continue;
    }
    if (!section && !installedWithThisPackage().has(name)) {
      problems.push(
        `${file} imports types from "${specifier}", but the package.json the build writes does not declare ${name} and nothing ` +
          'it declares installs it, so TypeScript reads those types as any in every project that installs this package ' +
          "(ui's class-variance-authority cost every scaffold 457 errors): declare it as a dependency"
      );
      continue;
    }
    // A peer is the project's to provide, types included (react comes with the project's @types/react).
    if (section === 'peerDependencies' || shipsOwnTypes(name, nodeModulesDir)) continue;
    const typesPackage = typesPackageFor(name);
    if (sectionOf(typesPackage) || installedWithThisPackage().has(typesPackage)) continue;
    problems.push(
      `${file} imports types from "${specifier}", but ${name} ships no declarations of its own and the package.json the ` +
        `build writes does not declare ${typesPackage}, so TypeScript reads those types as any: ` +
        (section
          ? `declare ${typesPackage} as a dependency`
          : `declare ${name} as a peer (the project then provides its types, as it does @types/react), or ${typesPackage} as a dependency`)
    );
  }

  return problems;
}

/* ------------------------------------ driver ------------------------------------ */

/**
 * Every problem the checks find in a built lib, `packed` being the tarball's file list (from
 * listPackedFiles). verifyLibDist runs `npm pack --dry-run` once and hands it here; tests hand in
 * their own list, so each check's place in the release gate is tested without `npm pack`.
 *
 * @param {string} library
 * @param {string} distDir
 * @param {Set<string>} packed
 * @param {{ manifestFinalized?: boolean, bundledMigrationNames?: Iterable<string>, nodeModulesDir?: string }} [options] as for verifyLibDist
 */
function collectDistProblems(library, distDir, packed, options = {}) {
  return [
    ...findDevelopmentArtifacts(distDir).map((entry) => `development build artifact: ${entry}`),
    ...findUnresolvableSubpaths(library, distDir).map((entry) => `unresolvable subpath: ${entry}`),
    ...findLostExports(library, distDir).map((entry) => `lost export: ${entry}`),
    ...findDanglingDeclarationImports(distDir).map((entry) => `missing declaration: ${entry}`),
    ...findUnpackedFiles(library, distDir, packed).map((entry) => `not in the npm tarball: ${entry}`),
    ...findRequireShims(distDir).map((entry) => `require() shim in ESM: ${entry}`),
    ...findModuleFormatProblems(library, distDir).map((entry) => `module format: ${entry}`),
    ...findPackagePageProblems(library, distDir, packed).map((entry) => `package page: ${entry}`),
    ...findWorkspaceProtocolDependencies(library, distDir, options).map((entry) => `workspace dependency: ${entry}`),
    ...findSideEffectsProblems(library, distDir, packed).map((entry) => `side effects: ${entry}`),
    ...findUndeclaredSiblingImports(library, distDir, packed).map((entry) => `undeclared sibling: ${entry}`),
    ...findPackedDotPaths(library, distDir, packed).map((entry) => `dot path: ${entry}`),
    ...findSupabaseFolderProblems(library, distDir, packed).map((entry) => `supabase folder: ${entry}`),
    ...findSupabaseFileProblems(library, distDir, packed, options).map((entry) => `supabase file: ${entry}`),
    ...findUndeclaredPackageImports(library, distDir, packed, options).map((entry) => `undeclared package: ${entry}`),
  ];
}

/**
 * @param {string} library
 * @param {{
 *   manifestFinalized?: boolean,
 *   distDir?: string,
 *   listPackedFiles?: (distDir: string) => Iterable<string>,
 *   bundledMigrationNames?: Iterable<string>,
 *   nodeModulesDir?: string,
 * }} [options] `manifestFinalized`: the dist package.json is the one that will be published
 *   (release-lib.js has normalized it). `distDir` (default dist/libs/<lib>) and `listPackedFiles`
 *   (default `npm pack --dry-run` there) let a test run the gate itself on a fixture and a file list,
 *   `bundledMigrationNames` (default: the names the /setup bundle embeds, readBundledMigrationNames)
 *   stands in for the bundle check 14 compares db's packed migrations with, and `nodeModulesDir`
 *   (default: the root node_modules) holds the installed packages check 15 reads.
 */
function verifyLibDist(library, options = {}) {
  const { distDir = distDirFor(library), listPackedFiles: packFiles = listPackedFiles, ...checkOptions } = options;

  if (!fs.existsSync(distDir)) {
    throw new Error(`Build output not found at ${distDir}`);
  }

  // One `npm pack --dry-run` for every check that reads the tarball's file list.
  const problems = collectDistProblems(library, distDir, new Set(packFiles(distDir)), checkOptions);

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
  collectDistProblems,
  findUnpackedFiles,
  findRequireShims,
  findModuleFormatProblems,
  findPackagePageProblems,
  findWorkspaceProtocolDependencies,
  findSideEffectsProblems,
  findUndeclaredSiblingImports,
  findPackedDotPaths,
  findSupabaseFolderProblems,
  findSupabaseFileProblems,
  findUndeclaredPackageImports,
  readBundledMigrationNames,
};

if (require.main === module) {
  const requested = process.argv[2];
  const libraries = requested
    ? [requested]
    : ['utils', 'ui', 'sdk', 'db', 'editor', 'ecommerce', 'cortex', 'affiliates'].filter((library) =>
        fs.existsSync(distDirFor(library))
      );

  if (libraries.length === 0) {
    console.error(
      'Usage: node tools/scripts/verify-lib-dist.js [utils|ui|sdk|db|editor|ecommerce|cortex|affiliates] (no dist/libs/* build found)'
    );
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
