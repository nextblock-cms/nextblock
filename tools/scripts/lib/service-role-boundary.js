// The service-role boundary: the RLS-bypassing Supabase key and every client built from it
// stay on the server.
//
// Static checks over apps/nextblock and libs/*/src (scripts, tests, the Deno edge function and
// generated files are out of scope), each module parsed with the TypeScript compiler, so
// comments, strings, regex literals, JSX and template literals are read the way the bundler
// reads them:
//
//   1. Every module that builds or hands out a service-role client, or reads the secret key,
//      imports 'server-only'. Next.js then fails the build the moment such a module lands in a
//      client graph, instead of shipping it to the browser. A module counts when it references
//      a service-role factory (called or not, aliased, read by key, re-exported under another
//      name) or reads the secret key from process.env / import.meta.env however it gets there
//      (destructuring, optional chaining, an alias of process.env, a dynamic key next to the
//      key's name).
//   2. No client graph reaches such a module. A client graph starts at every 'use client' file
//      (the directive anywhere in the prologue) and at every client-safe library entry, derived
//      from each lib's package.json `exports` minus SERVER_ENTRIES, and follows static,
//      dynamic (template literals included) and require() imports. It stops at a 'use server'
//      module: the client receives action references, never the module body. Library entries
//      matter here because Vite builds them without Next's server-only check, so a leak there
//      only surfaces in a downstream install.
//   3. No secret is exposed through a NEXT_PUBLIC_ name or the next.config `env` /
//      `compiler.define` (Next inlines all of them into the browser bundle). The config is
//      evaluated with sentinel secrets and its source parsed, so spreads, helpers and
//      conditionals count; a missing config fails the check.
//   4. Resolution stays TypeScript-first. libs/db and libs/utils keep stale compiled .js twins
//      beside their .ts sources (CLAUDE.md: do not modify), and those twins read the service
//      key without 'server-only'. next.config.js pins turbopack.resolveExtensions with .ts
//      before .js, no build or dev command switches to webpack (whose default prefers .js),
//      and no module imports a twin by its explicit .js path.
//
// Rationale and the rules for new code: docs/04 → "Service-role boundary".

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const { publishExportsFor } = require('../lib-publish-exports');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_DIR = path.join(REPO_ROOT, 'apps/nextblock');

/** Directories scanned, relative to the repo root. */
const SCAN_ROOTS = ['apps/nextblock', 'libs'];

/** Path fragments (repo-relative, forward slashes) never scanned. */
const EXCLUDED_PATHS = [
  'node_modules/',
  '.next/',
  '/dist/',
  '/coverage/',
  '/out/',
  'apps/nextblock/scripts/', // Node CLI scripts, never bundled
  'apps/nextblock/tools/', // build hook + its tests
  'apps/nextblock/public/',
  'libs/db/src/supabase/functions/', // Deno edge function
];

/** Generated files (CLAUDE.md "Do not modify"): their SQL text mentions roles, not code. */
const EXCLUDED_FILES = new Set([
  'apps/nextblock/lib/setup/migrations-bundle.ts',
  'apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts',
  'apps/nextblock/lib/custom-block-safelist.ts',
  'libs/db/src/lib/supabase/types.ts',
]);

/**
 * Modules allowed to read the secret key without importing 'server-only', with the reason.
 * Keep this list short: each entry is a module that never reaches a bundle.
 */
const SERVER_ONLY_EXEMPT = new Map([
  ['apps/nextblock/next.config.js', 'build-time Next config, evaluated by Node and never bundled'],
]);

/**
 * Library `exports` subpaths that are server entry points, per lib directory, with the
 * reason. Every other JavaScript export is client-safe: a downstream app may import it from a
 * client component, so its graph must stay free of server-only code.
 */
const SERVER_ENTRIES = {
  db: { './server': 'server barrel: cookie and service-role clients, secrets', './secrets': 'secret crypto' },
  utils: { './server': 'server utilities' },
  ecommerce: { './server': 'server barrel: checkout, orders, providers' },
  cortex: { '.': 'the Cortex runtime (tools, OpenRouter, MCP); ./client is the browser entry' },
};

/** Exports that carry no runtime code. */
const TYPE_ONLY_ENTRIES = {
  db: { './types': 'generated Supabase types' },
};

/** Exports that are not JavaScript modules (styles, the Tailwind preset, the manifest). */
const NON_MODULE_EXPORT_RE = /^\.\/package\.json$|^\.\/styles\/|^\.\/tailwind\.config(?:\.js)?$/;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.jsx', '.cjs'];

/**
 * Extensionless imports resolve in this order: TypeScript first, the order next.config.js pins
 * for Turbopack (the service-role-boundary test compares the two), then the module kinds
 * Turbopack does not try, so a module is never missed.
 */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts', '.cts', '.cjs'];

/** TypeScript-style explicit extensions: `./x.js` is ./x.ts when that exists. */
const EXPLICIT_EXTENSION_CANDIDATES = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

const SECRET_ENV_NAMES = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);

const VERIFIED_HELPER = 'verified-role-then-service-role helper';

/** Identifiers whose (value) use marks a module as service-role code. */
const SERVICE_ROLE_IDENTIFIERS = new Map([
  ['getServiceRoleSupabaseClient', 'service-role client factory'],
  ['resolveSupabaseServiceKey', 'service-role key resolver'],
  ['requireCmsAdmin', VERIFIED_HELPER],
  ['requireCmsStaff', VERIFIED_HELPER],
  ['requireEcomAdmin', VERIFIED_HELPER],
  ['requireEcomStaff', VERIFIED_HELPER],
  ['requireAdminSupabaseClient', VERIFIED_HELPER],
]);

const SECRET_READ = 'secret key read from process.env';
const MARKER_ORDER = ['service-role client factory', 'service-role key resolver', SECRET_READ, VERIFIED_HELPER];

/** What makes an env name a secret, and the public key kinds that only look like one. */
const SECRET_NAME_RE = /SECRET|SERVICE_ROLE|SERVICE_KEY|ADMIN_KEY|PRIVATE|PASSWORD|PASSWD|TOKEN|API_KEY|ACCESS_KEY|ENCRYPTION_KEY|LICENSE_KEY|BEARER|CREDENTIAL|(?:^|_)(?:DB|DATABASE|POSTGRES)_URL$/;
const PUBLIC_KEY_KINDS = [
  [/_ANON_KEY$/, 'the Supabase anon key is public by design; RLS applies to it'],
  [/_PUBLISHABLE_KEY$/, 'publishable keys (Supabase, Stripe) are meant for browsers'],
  [/_SITE_KEY$/, 'captcha site keys (Turnstile, reCAPTCHA) are public'],
];

function isSecretEnvName(name) {
  if (PUBLIC_KEY_KINDS.some(([re]) => re.test(name))) return false;
  return SECRET_NAME_RE.test(name.replace(/^NEXT_PUBLIC_/, ''));
}

function toRepoPath(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/* ------------------------------------------------------------- module analysis --- */

function scriptKindFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS; // .js / .mjs / .cjs: JSX allowed, like the bundler
}

function parse(source, fileName) {
  return ts.createSourceFile(fileName, source.replace(/^﻿/, ''), ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
}

const isWrapper = (node) =>
  Boolean(node) &&
  (ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)));

function unwrap(node) {
  let current = node;
  while (isWrapper(current)) current = current.expression;
  return current;
}

const stringValue = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

function isProcess(node) {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text === 'process';
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'process' &&
    ts.isIdentifier(unwrap(target.expression)) &&
    ['globalThis', 'global', 'window', 'self'].includes(unwrap(target.expression).text)
  );
}

/** process.env, process?.env, process['env'], import.meta.env, or an alias of one of them. */
function isEnvObject(node, aliases) {
  const target = unwrap(node);
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'env') {
    return isProcess(target.expression) || ts.isMetaProperty(unwrap(target.expression));
  }
  if (ts.isElementAccessExpression(target) && stringValue(target.argumentExpression) === 'env') return isProcess(target.expression);
  return ts.isIdentifier(target) && aliases.has(target.text);
}

/** Names bound to the env object: `const env = process.env`, `const { env } = process`. */
function envAliases(file) {
  const aliases = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && !aliases.has(node.name.text) && isEnvObject(node.initializer, aliases)) {
          aliases.add(node.name.text);
          grew = true;
        } else if (ts.isObjectBindingPattern(node.name) && isProcess(node.initializer)) {
          for (const element of node.name.elements) {
            const key = element.propertyName ? element.propertyName.getText(file) : element.name.getText(file);
            if (key === 'env' && ts.isIdentifier(element.name) && !aliases.has(element.name.text)) {
              aliases.add(element.name.text);
              grew = true;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return aliases;
}

function isTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isImportSpecifier(current) || ts.isExportSpecifier(current)) return current.isTypeOnly || isTypeOnlyDeclaration(current);
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isTypeOnlyDeclaration(specifier) {
  for (let current = specifier.parent; current; current = current.parent) {
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isExportDeclaration(current)) return current.isTypeOnly;
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** `export { X } from '...'` without a rename passes X through; the graph check follows it. */
const isPassThroughReExport = (node) =>
  ts.isExportSpecifier(node.parent) && !node.parent.propertyName && Boolean(node.parent.parent?.parent?.moduleSpecifier);

/** A specifier for import(...) / require(...): a string, or a pattern for a template with substitutions. */
function specifierOf(argument) {
  const literal = stringValue(argument);
  if (literal !== null) return { spec: literal };
  if (argument && ts.isTemplateExpression(argument)) {
    return { pattern: [argument.head.text, ...argument.templateSpans.map((s) => s.literal.text)] };
  }
  return { unresolved: true };
}

/**
 * The facts the checks need about one module: its directive, whether it imports
 * 'server-only', its service-role markers, its runtime imports (type-only ones dropped), the
 * patterns of dynamic imports built from template literals, and the NEXT_PUBLIC_ names it
 * mentions in code.
 */
function analyzeModule(source, fileName = 'module.tsx') {
  const file = parse(source, fileName);
  let directive = null;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    const text = statement.expression.text;
    if (!directive && (text === 'use client' || text === 'use server')) directive = text;
  }

  let serverOnly = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause && stringValue(statement.moduleSpecifier) === 'server-only') serverOnly = true;
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === 'require' &&
      stringValue(statement.expression.arguments[0]) === 'server-only'
    ) {
      serverOnly = true;
    }
  }

  const markers = new Set();
  const imports = new Set();
  const dynamicImports = [];
  const publicNames = new Set();
  const aliases = envAliases(file);
  let dynamicEnvRead = false;
  let secretNameLiteral = false;

  const notePublicNames = (text) => {
    for (const m of text.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+\b/g)) publicNames.add(m[0]);
  };

  const onEnvObject = (node) => {
    let user = node;
    while (isWrapper(user.parent)) user = user.parent;
    const parent = user.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === user) {
      if (SECRET_ENV_NAMES.has(parent.name.text)) markers.add(SECRET_READ);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === user) {
      const key = stringValue(parent.argumentExpression);
      if (key === null) dynamicEnvRead = true;
      else if (SECRET_ENV_NAMES.has(key)) markers.add(SECRET_READ);
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === user) {
      if (ts.isIdentifier(parent.name)) return; // an alias, followed through envAliases
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          if (element.dotDotDotToken) dynamicEnvRead = true;
          const key = element.propertyName ? element.propertyName.getText(file) : element.name.getText(file);
          if (SECRET_ENV_NAMES.has(key.replace(/^['"`]|['"`]$/g, ''))) markers.add(SECRET_READ);
          if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) dynamicEnvRead = true;
        }
      }
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.name === user) return;
    if (ts.isBindingElement(parent)) return;
    dynamicEnvRead = true; // passed around whole: spread, Object.entries(process.env), f(process.env)
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = stringValue(node.moduleSpecifier);
      const clause = node.importClause;
      const typeOnly =
        clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (spec !== null && !typeOnly) imports.add(spec);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = stringValue(node.moduleSpecifier);
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly));
      if (spec !== null && !typeOnly) imports.add(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !node.isTypeOnly) {
      const spec = stringValue(node.moduleReference.expression);
      if (spec !== null) imports.add(spec);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImport || isRequire) {
        const target = specifierOf(node.arguments[0]);
        if (target.spec !== undefined) imports.add(target.spec);
        else dynamicImports.push(target);
      }
    }

    if (ts.isIdentifier(node)) {
      const marker = SERVICE_ROLE_IDENTIFIERS.get(node.text);
      if (marker && !isTypePosition(node) && !isPassThroughReExport(node)) markers.add(marker);
      notePublicNames(node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralLikeNode?.(node) || ts.isJsxText(node)) {
      const text = node.text;
      notePublicNames(text);
      if (SECRET_ENV_NAMES.has(text)) secretNameLiteral = true;
      const marker = SERVICE_ROLE_IDENTIFIERS.get(text);
      if (marker && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) markers.add(marker);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      notePublicNames(node.text);
    }

    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) && isEnvObject(node, aliases)) {
      // `process.env` itself, not the `process` inside it; an alias identifier, not its declaration
      if (!(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) onEnvObject(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (dynamicEnvRead && secretNameLiteral) markers.add(SECRET_READ);

  return {
    directive,
    serverOnly,
    markers: MARKER_ORDER.filter((m) => markers.has(m)),
    imports: [...imports],
    dynamicImports,
    publicNames: [...publicNames],
  };
}

/** The leaf tokens of a parsed file, in source order. */
function leafTokens(file) {
  const leaves = [];
  const visit = (node) => {
    const children = node.getChildren(file);
    if (children.length === 0) leaves.push(node);
    else children.forEach(visit);
  };
  visit(file);
  return leaves;
}

/**
 * The source with comments removed, located by the TypeScript parser (so `/*` inside a regex
 * literal, a string, a template or JSX text is not a comment). Kept for callers that want
 * comment-free text; the checks read the AST directly.
 */
function stripComments(source, fileName = 'module.tsx') {
  const file = parse(source, fileName);
  const text = file.text;
  const ranges = new Map();
  for (const token of leafTokens(file)) {
    if (token.kind === ts.SyntaxKind.JsxText) continue; // JSX text owns everything up to `<` or `{`
    for (const r of [...(ts.getTrailingCommentRanges(text, token.pos) || []), ...(ts.getLeadingCommentRanges(text, token.pos) || [])]) {
      if (r.end <= token.getStart(file)) ranges.set(r.pos, r);
    }
  }
  let out = '';
  let at = 0;
  for (const r of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    if (r.pos < at) continue;
    out += text.slice(at, r.pos) + (r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? ' ' : '');
    at = r.end;
  }
  return out + text.slice(at);
}

/** The module-level directive ('use client' / 'use server') anywhere in the prologue, or null. */
function directiveOf(source, fileName) {
  return analyzeModule(source, fileName).directive;
}

function serviceRoleMarkers(source, fileName) {
  return analyzeModule(source, fileName).markers;
}

/** Runtime import specifiers of a module (type-only imports and re-exports are dropped). */
function importSpecifiers(source, fileName) {
  return analyzeModule(source, fileName).imports;
}

/* ---------------------------------------------------------------------- scanning --- */

function isExcluded(repoPath) {
  if (EXCLUDED_FILES.has(repoPath)) return true;
  if (/\.d\.[cm]?ts$/.test(repoPath)) return true;
  if (/(?:^|\/)__(?:tests|mocks)__\//.test(repoPath)) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(repoPath)) return true;
  if (/\.stories\.[jt]sx?$/.test(repoPath)) return true;
  return EXCLUDED_PATHS.some((fragment) => `/${repoPath}`.includes(fragment.startsWith('/') ? fragment : `/${fragment}`));
}

/** A `.js` beside a `.ts`/`.tsx` of the same stem is a stale compiled twin (libs/db, libs/utils). */
function isStaleTwin(absolute) {
  if (!/\.js$/.test(absolute)) return false;
  const stem = absolute.slice(0, -3);
  return fs.existsSync(`${stem}.ts`) || fs.existsSync(`${stem}.tsx`);
}

function walk(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const repoPath = toRepoPath(absolute);
    if (entry.isDirectory()) {
      // `.well-known` holds real routes; the other dot directories are tool caches.
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.well-known')) continue;
      if (isExcluded(`${repoPath}/`)) continue;
      walk(absolute, files);
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      if (isExcluded(repoPath) || isStaleTwin(absolute)) continue;
      files.push(absolute);
    }
  }
}

function loadPathAliases() {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.base.json'), 'utf8'));
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const exact = new Map();
  const wildcard = [];
  for (const [key, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (key.endsWith('/*')) wildcard.push({ prefix: key.slice(0, -1), target: target.slice(0, -1) });
    else exact.set(key, target);
  }
  wildcard.sort((a, b) => b.prefix.length - a.prefix.length);
  return { exact, wildcard };
}

const isFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

function resolveFile(base) {
  const candidates = [];
  const ext = path.extname(base);
  if (EXPLICIT_EXTENSION_CANDIDATES[ext]) {
    const stem = base.slice(0, -ext.length);
    candidates.push(...EXPLICIT_EXTENSION_CANDIDATES[ext].map((e) => stem + e));
  } else if (SOURCE_EXTENSIONS.includes(ext)) candidates.push(base);
  candidates.push(...RESOLVE_EXTENSIONS.map((e) => base + e));
  candidates.push(...RESOLVE_EXTENSIONS.map((e) => path.join(base, `index${e}`)));
  return candidates.find(isFile) || null;
}

/** The absolute path a specifier names before extension resolution, or null for a package. */
function specifierBase(aliases, fromFile, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  if (aliases.exact.has(spec)) return path.join(REPO_ROOT, aliases.exact.get(spec));
  for (const { prefix, target } of aliases.wildcard) {
    if (spec.startsWith(prefix)) return path.join(REPO_ROOT, target + spec.slice(prefix.length));
  }
  return null; // a package from node_modules: outside the boundary this check owns
}

function createResolver() {
  const aliases = loadPathAliases();
  const resolveImport = (fromFile, spec) => {
    const base = specifierBase(aliases, fromFile, spec);
    return base === null ? null : resolveFile(base);
  };
  resolveImport.base = (fromFile, spec) => specifierBase(aliases, fromFile, spec);
  return resolveImport;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Scanned modules a template-literal import (`./locales/${lang}`) can load. */
function resolvePattern(resolveImport, fromFile, pattern, modules) {
  const [head, ...rest] = pattern.pattern;
  const slash = head.lastIndexOf('/');
  if (slash === -1 || !resolveImport.base) return [];
  const dirBase = resolveImport.base(fromFile, head.slice(0, slash + 1) || './');
  if (dirBase === null) return [];
  const dir = dirBase.split(path.sep).join('/').replace(/\/?$/, '/');
  const tail = [head.slice(slash + 1), ...rest].map(escapeRegExp).join('.*');
  const re = new RegExp(`^${escapeRegExp(dir)}${tail}(?:\\.[cm]?[jt]sx?|/index\\.[cm]?[jt]sx?)?$`);
  return [...modules.keys()].filter((absolute) => re.test(absolute.split(path.sep).join('/')));
}

/** The record the checks use for one module. */
function moduleRecord(absolute, source) {
  return { absolute, repoPath: toRepoPath(absolute), ...analyzeModule(source, absolute) };
}

/** Parse every in-scope module once. */
function scanRepository() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);
  const modules = new Map();
  for (const absolute of files) modules.set(absolute, moduleRecord(absolute, fs.readFileSync(absolute, 'utf8')));
  return modules;
}

/* ---------------------------------------------------------------- client entries --- */

/** Source file behind an `exports` target (`./src/x.ts`, or a dist name such as `./client.es.js`). */
function exportSource(libDir, target) {
  if (target.startsWith('./src/')) return resolveFile(path.join(libDir, target)) || (isFile(path.join(libDir, target)) ? path.join(libDir, target) : null);
  const stem = target.replace(/^\.\/(?:dist\/)?/, '').replace(/(?:\.es)?\.(?:[cm]?js|d\.ts)$/, '');
  return resolveFile(path.join(libDir, 'src', stem));
}

const exportTarget = (value) => (typeof value === 'string' ? value : value && (value.default || value.import || value.require || value.types));

/**
 * The source files a lib's Vite build lists in `build.lib.entry` (its documented public
 * surface), or null when there is no vite config to read.
 */
function libBuildEntries(libDir) {
  const configPath = ['vite.config.mts', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs'].map((n) => path.join(libDir, n)).find((p) => fs.existsSync(p));
  if (!configPath) return null;
  const file = parse(fs.readFileSync(configPath, 'utf8'), configPath);
  const found = [];
  const add = (node) => {
    const value = stringValue(node);
    if (value !== null) found.push(path.resolve(libDir, value));
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'entry') {
      const value = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(value)) for (const p of value.properties) if (ts.isPropertyAssignment(p)) add(p.initializer);
      if (ts.isArrayLiteralExpression(value)) value.elements.forEach(add);
      add(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The client-safe library entries: every JavaScript `exports` subpath of every lib (the
 * publish-time map from lib-publish-exports.js for the libs whose raw manifest has none),
 * minus SERVER_ENTRIES and TYPE_ONLY_ENTRIES, mapped to its source file. A wildcard export
 * (`./*`) makes every source module under its directory an entry. Returns { entries:
 * [{ absolute, repoPath, lib, subpath, wildcard }], problems: [string] }; an export with no
 * source file, a declaration naming a subpath the lib does not export, and a lib without a
 * manifest are problems.
 */
function clientSafeEntries({ libsDir = path.join(REPO_ROOT, 'libs'), serverEntries = SERVER_ENTRIES, typeOnlyEntries = TYPE_ONLY_ENTRIES } = {}) {
  const entries = [];
  const problems = [];
  let libs = [];
  try {
    libs = fs.readdirSync(libsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    problems.push(`cannot read ${libsDir}`);
  }
  for (const lib of libs) {
    const libDir = path.join(libsDir, lib);
    const manifestPath = path.join(libDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      problems.push(`libs/${lib} has no package.json: its client-safe entries cannot be derived`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exportsMap = manifest.exports || publishExportsFor(lib) || { '.': manifest.module || manifest.main || './src/index.ts' };
    const server = serverEntries[lib] || {};
    const typeOnly = typeOnlyEntries[lib] || {};
    for (const declared of [...Object.keys(server), ...Object.keys(typeOnly)]) {
      if (!(declared in exportsMap)) problems.push(`libs/${lib}: SERVER_ENTRIES / TYPE_ONLY_ENTRIES name exports["${declared}"], which is not exported`);
    }
    for (const [subpath, value] of Object.entries(exportsMap)) {
      if (NON_MODULE_EXPORT_RE.test(subpath) || subpath in server || subpath in typeOnly) continue;
      const target = exportTarget(value);
      if (typeof target !== 'string') continue;
      if (subpath.includes('*')) {
        // preserveModules emits every module under the directory; the public surface is the
        // set the build lists as entries there (vite.config `build.lib.entry`).
        const dirPart = target.replace(/^\.\/(?:dist\/)?/, '').split('*')[0];
        const dir = path.join(libDir, dirPart.startsWith('src/') ? dirPart : path.join('src', dirPart));
        const inDir = (absolute) => absolute.startsWith(dir + path.sep) || absolute.startsWith(dir);
        const files = (libBuildEntries(libDir) || []).filter(inDir);
        if (files.length === 0) {
          problems.push(`libs/${lib}/package.json exports["${subpath}"] -> ${target}: no build entry (vite.config build.lib.entry) under ${toRepoPath(dir)}`);
        }
        for (const absolute of files) {
          if (!isFile(absolute)) problems.push(`libs/${lib}: build entry ${toRepoPath(absolute)} (exported through "${subpath}") does not exist`);
          else entries.push({ absolute, repoPath: toRepoPath(absolute), lib, subpath, wildcard: true });
        }
        continue;
      }
      const absolute = exportSource(libDir, target);
      if (!absolute) {
        problems.push(`libs/${lib}/package.json exports["${subpath}"] -> ${target}: no source file for it under libs/${lib}/src`);
        continue;
      }
      entries.push({ absolute, repoPath: toRepoPath(absolute), lib, subpath, wildcard: false });
    }
  }
  return { entries, problems };
}

/** The exact (non-wildcard) client-safe entries, repo-relative. */
const CLIENT_SAFE_ENTRIES = clientSafeEntries()
  .entries.filter((e) => !e.wildcard)
  .map((e) => e.repoPath);

/* ------------------------------------------------------------------------ checks --- */

/** Check 1: service-role modules that do not import 'server-only'. */
function findUnguardedServiceRoleModules(modules) {
  const problems = [];
  for (const mod of modules.values()) {
    if (mod.markers.length === 0 || mod.serverOnly || SERVER_ONLY_EXEMPT.has(mod.repoPath)) continue;
    problems.push({
      file: mod.repoPath,
      problem: `${mod.repoPath} uses the service role (${mod.markers.join(', ')}) without import 'server-only'`,
    });
  }
  return problems.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Check 2: client graphs that reach server-only or service-role code. Returns one problem per
 * offending module, with the import chain from the first root that reached it. `entries`
 * defaults to the derived client-safe library entries.
 */
function findClientGraphLeaks(modules, resolveImport = createResolver(), entries = clientSafeEntries().entries) {
  const roots = [];
  for (const mod of modules.values()) if (mod.directive === 'use client') roots.push(mod.absolute);
  for (const entry of entries) {
    const mod = modules.get(entry.absolute);
    // A wildcard export also exposes the lib's server modules; those guard themselves.
    if (mod && !(entry.wildcard && mod.serverOnly)) roots.push(entry.absolute);
  }

  const reported = new Map();
  const visited = new Set();
  for (const root of roots) {
    const stack = [[root, [root]]];
    while (stack.length > 0) {
      const [file, chain] = stack.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const mod = modules.get(file);
      if (!mod) continue;
      // The client gets action references for a 'use server' module, never its body.
      if (mod.directive === 'use server') continue;
      if (mod.serverOnly || mod.markers.length > 0) {
        if (!reported.has(mod.repoPath)) {
          const why = mod.serverOnly ? "imports 'server-only'" : `uses the service role (${mod.markers.join(', ')})`;
          reported.set(mod.repoPath, {
            file: mod.repoPath,
            problem: `client graph reaches ${mod.repoPath}, which ${why}: ${chain.map((f) => toRepoPath(f)).join(' -> ')}`,
          });
        }
        continue;
      }
      const targets = mod.imports.map((spec) => resolveImport(file, spec));
      for (const pattern of mod.dynamicImports || []) {
        if (pattern.pattern) targets.push(...resolvePattern(resolveImport, file, pattern, modules));
      }
      for (const target of targets) {
        if (target && modules.has(target) && !visited.has(target)) stack.push([target, [...chain, target]]);
      }
    }
  }
  return [...reported.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Check 4b: an import that names a stale compiled twin by its explicit path (`./server.js`
 * beside server.ts). The bundler loads the .js file as written, and the twins read the service
 * key without 'server-only'.
 */
function findStaleTwinImports(modules, resolveImport = createResolver()) {
  const problems = [];
  for (const mod of modules.values()) {
    for (const spec of mod.imports) {
      if (!/\.js$/.test(spec)) continue;
      const base = resolveImport.base ? resolveImport.base(mod.absolute, spec) : null;
      if (base && isFile(base) && isStaleTwin(base)) {
        problems.push({
          file: mod.repoPath,
          problem: `${mod.repoPath} imports the stale compiled twin ${toRepoPath(base)} by its .js path: the bundler loads that file, which has no 'server-only' guard; import the extensionless path`,
        });
      }
    }
  }
  return problems;
}

/** Files outside the module scan that still define public env names. */
const ENV_DEFINITION_FILES = [
  '.env.example',
  '.env.docker.example',
  'docker-compose.yml',
  'apps/create-nextblock/docker-template/.env.docker.example',
  'apps/create-nextblock/docker-template/docker-compose.yml',
  'vercel.json',
  'apps/nextblock/vercel.json',
];

/** Check 3a: a secret behind a NEXT_PUBLIC_ name, in code or in an env definition file. */
function findPublicSecretExposure(modules) {
  const problems = [];
  const sources = [...modules.values()].map((m) => ({ repoPath: m.repoPath, names: m.publicNames || [] }));
  for (const file of ENV_DEFINITION_FILES) {
    const absolute = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    sources.push({ repoPath: file, names: [...fs.readFileSync(absolute, 'utf8').matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+\b/g)].map((m) => m[0]) });
  }
  for (const { repoPath, names } of sources) {
    for (const name of new Set(names)) {
      if (!isSecretEnvName(name)) continue;
      problems.push({ file: repoPath, problem: `${repoPath} names ${name}: a NEXT_PUBLIC_ variable is inlined into the browser bundle` });
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- next.config --- */

const NEXT_CONFIG_NAMES = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts'];
const SENTINEL_PREFIX = '__NB_SECRET_SENTINEL__';

/** Secret-looking env names to plant sentinels under while the config is evaluated. */
function sentinelNames(configSource) {
  const names = new Set(SECRET_ENV_NAMES);
  const texts = [configSource];
  for (const file of ENV_DEFINITION_FILES) {
    const absolute = path.join(REPO_ROOT, file);
    if (fs.existsSync(absolute)) texts.push(fs.readFileSync(absolute, 'utf8'));
  }
  for (const text of texts) for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) if (isSecretEnvName(m[0])) names.add(m[0]);
  return [...names];
}

/** Require a config file of any flavour (CJS, ESM, TypeScript) through TypeScript's transpiler. */
function loadConfigModule(configPath, source) {
  const output = ts.transpileModule(source, {
    fileName: configPath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, allowJs: true },
  }).outputText;
  const loaded = new Module(configPath, module);
  loaded.filename = configPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(configPath));
  loaded._compile(output, configPath);
  const exported = loaded.exports;
  return exported && exported.__esModule && 'default' in exported ? exported.default : exported;
}

/** The config Next would read, evaluated with a sentinel in place of every secret env var. */
async function evaluateNextConfig(configPath, source) {
  const saved = new Map();
  for (const name of sentinelNames(source)) {
    saved.set(name, process.env[name]);
    process.env[name] = `${SENTINEL_PREFIX}${name}`;
  }
  try {
    let config = loadConfigModule(configPath, source);
    if (typeof config === 'function') config = await config('phase-production-build', { defaultConfig: {} });
    return await config;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function sentinelIn(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const m = text && new RegExp(`${SENTINEL_PREFIX}([A-Z0-9_]+)`).exec(text);
  return m ? m[1] : null;
}

/**
 * What the config source puts under `env` or `compiler.define`, followed through identifiers
 * and spreads to their initializers: secret env names read there (a conditional the
 * evaluation did not take included) and secret-looking keys.
 */
function configSourceProblems(source, rel) {
  const file = parse(source, rel);
  const declarations = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);

  const problems = [];
  const inspect = (node, where, seen = new Set()) => {
    const target = unwrap(node);
    if (ts.isIdentifier(target)) {
      if (seen.has(target.text) || !declarations.has(target.text)) return;
      seen.add(target.text);
      inspect(declarations.get(target.text), where, seen);
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) inspect(property.expression, where, seen);
        else if (ts.isShorthandPropertyAssignment(property)) inspect(property.name, where, seen);
        if (property.name) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
          if (key && isSecretEnvName(key.replace(/^process\.env\./, ''))) problems.push(`${rel} ${where} defines ${key}: every entry there is inlined into the browser bundle`);
        }
      }
    }
    const visit = (child) => {
      if (ts.isIdentifier(child) || ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
        const text = child.text;
        if (SECRET_ENV_NAMES.has(text) || text === 'resolveSupabaseServiceKey') problems.push(`${rel} ${where} references ${text}: every entry there is inlined into the browser bundle`);
      }
      if (ts.isIdentifier(child) && declarations.has(child.text) && !seen.has(child.text)) inspect(child, where, seen);
      ts.forEachChild(child, visit);
    };
    visit(target);
  };

  const walkConfig = (node) => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : null;
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const owner = node.parent && ts.isObjectLiteralExpression(node.parent) && node.parent.parent;
      const ownerKey = owner && ts.isPropertyAssignment(owner) && owner.name && ts.isIdentifier(owner.name) ? owner.name.text : null;
      if (key === 'env') inspect(value, '`env`');
      if (key === 'define' && ownerKey === 'compiler') inspect(value, '`compiler.define`');
    }
    ts.forEachChild(node, walkConfig);
  };
  walkConfig(file);
  return [...new Set(problems)];
}

const TS_EXTENSIONS = ['.tsx', '.ts'];
const JS_EXTENSIONS = ['.jsx', '.js', '.mjs', '.cjs'];

/** Problems in the evaluated config: secrets in env / compiler.define, and the resolution order. */
function resolvedConfigProblems(config, rel) {
  const problems = [];
  for (const [where, map] of [
    ['`env`', config && config.env],
    ['`compiler.define`', config && config.compiler && config.compiler.define],
  ]) {
    for (const [key, value] of Object.entries(map || {})) {
      if (isSecretEnvName(key.replace(/^process\.env\./, ''))) problems.push(`${rel} ${where} defines ${key}: every entry there is inlined into the browser bundle`);
      const leaked = sentinelIn(value);
      if (leaked) problems.push(`${rel} ${where} ${key} resolves to the value of ${leaked}: every entry there is inlined into the browser bundle`);
    }
  }
  const extensions = config && config.turbopack && config.turbopack.resolveExtensions;
  const lastTs = Array.isArray(extensions) ? Math.max(...TS_EXTENSIONS.map((e) => extensions.indexOf(e))) : -1;
  const js = Array.isArray(extensions) ? JS_EXTENSIONS.map((e) => extensions.indexOf(e)).filter((i) => i !== -1) : [];
  if (!Array.isArray(extensions) || lastTs === -1 || (js.length > 0 && Math.min(...js) < lastTs)) {
    problems.push(
      `${rel} must pin turbopack.resolveExtensions with '.tsx' and '.ts' before every JavaScript extension: ` +
        'libs/db and libs/utils keep stale compiled .js twins (no server-only guard) beside their .ts sources',
    );
  }
  return problems;
}

/**
 * Check 3b + 4a: the app's next.config (js, mjs, cjs, ts or mts), parsed and evaluated.
 * Returns { problems, config }.
 */
async function inspectNextConfig({ appDir = APP_DIR } = {}) {
  const configPath = NEXT_CONFIG_NAMES.map((name) => path.join(appDir, name)).find((p) => fs.existsSync(p));
  const relDir = toRepoPath(appDir) || '.';
  if (!configPath) {
    return { problems: [`no next.config.{js,mjs,cjs,ts,mts} in ${relDir}: the env / compiler.define check has nothing to read`], config: null };
  }
  const rel = toRepoPath(configPath);
  const source = fs.readFileSync(configPath, 'utf8');
  const problems = configSourceProblems(source, rel);
  let config;
  try {
    config = await evaluateNextConfig(configPath, source);
  } catch (error) {
    problems.push(`${rel} could not be evaluated (${error.message}); the env / compiler.define check cannot read it`);
    return { problems, config: null };
  }
  problems.push(...resolvedConfigProblems(config, rel));
  return { problems: [...new Set(problems)], config };
}

/** Check 4c: no build or dev command switches Next to webpack (whose resolver prefers .js). */
function findBundlerProblems() {
  const problems = [];
  const commands = [];
  const project = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'project.json'), 'utf8'));
  for (const [target, definition] of Object.entries(project.targets || {})) {
    const options = definition.options || {};
    for (const command of [options.command, ...(options.commands || []), ...Object.values(definition.configurations || {}).map((c) => c.command)]) {
      if (typeof command === 'string') commands.push({ where: `apps/nextblock/project.json targets.${target}`, command });
    }
  }
  for (const manifest of ['apps/nextblock/package.json', 'package.json']) {
    const scripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest), 'utf8')).scripts || {};
    for (const [name, command] of Object.entries(scripts)) commands.push({ where: `${manifest} scripts.${name}`, command });
  }
  for (const { where, command } of commands) {
    if (/\bnext\s+(?:build|dev|start)\b[^&|;]*--webpack\b/.test(command)) {
      problems.push(`${where} runs \`${command}\`: webpack resolves .js before .ts and would load the stale compiled twins; pin its resolve.extensions TypeScript-first before switching`);
    }
  }
  return problems;
}

module.exports = {
  CLIENT_SAFE_ENTRIES,
  RESOLVE_EXTENSIONS,
  SERVER_ENTRIES,
  SERVER_ONLY_EXEMPT,
  analyzeModule,
  clientSafeEntries,
  createResolver,
  directiveOf,
  findBundlerProblems,
  findClientGraphLeaks,
  findPublicSecretExposure,
  findStaleTwinImports,
  findUnguardedServiceRoleModules,
  importSpecifiers,
  inspectNextConfig,
  isSecretEnvName,
  moduleRecord,
  scanRepository,
  serviceRoleMarkers,
  stripComments,
};
