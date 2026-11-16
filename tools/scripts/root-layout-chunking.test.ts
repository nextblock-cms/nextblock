import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Keeps the authored-HTML sanitizer and Zod off public pages that never run them in the browser.
//
// `@nextblock-cms/utils` (libs/utils/src/index.ts) re-exports `./lib/authored-html`, which
// imports sanitize-html: CommonJS, so no bundler trims it, and it brings htmlparser2, about
// 39 KB gzipped together. It also re-exports `./lib/custom-blocks`: Zod and the custom-block
// schemas, built at load (`z.config()`; an 89 KB gzipped chunk in the 0.23.4 verification build).
// libs/utils declares no `sideEffects`, so one value import of the barrel from client code keeps
// both in that chunk (pure modules such as the SEO engine were tree-shaken even so). In that
// build the root layout's chunk (133 KB gzipped, on every page) carried all of it through
// `TranslationsProvider`, `useTranslations` and `cn` imports, and one `cn` import put it in the
// product grid's lazy chunk. Public pages sanitize authored HTML on the server; in the browser
// only the CMS editors and the product components that render authored HTML
// (SANITIZING_LAZY_CHUNKS) do, and they load on /cms or as lazy chunks. No public client code
// runs a Zod schema.
//
// So client code on public routes imports utils through deep subpaths, which the package
// publishes (`./*` -> `lib/*.es.js`, preserveModules): `@nextblock-cms/utils/utils` (cn, the
// currency helpers), `/translations-context` (TranslationsProvider, useTranslations,
// useOptionalTranslations), `/authored-html` (only where the browser sanitizes), `/color`,
// `/media-url`, …, and never imports `zod`, a zod-config module or the custom-block schemas.
// The barrel keeps its exports for published libraries and user code (a patch release cannot
// drop them). Test mocks follow the import: `vi.mock('@nextblock-cms/utils/translations-context',
// …)`, not the barrel.
//
// The walk: a route's server graph follows static and dynamic imports (a Server Component's
// `import()` does not split client code); a 'use client' module starts the client graph,
// which follows static imports and stops at 'use server' modules (the client gets action
// references). An `import()` in client code (next/dynamic, React.lazy) is a lazy chunk, and so
// is the file a Web Worker or a service worker names: webpack and Turbopack build the file in
// `new Worker(new URL('./x.worker.ts', import.meta.url))` (SharedWorker too) and in
// `navigator.serviceWorker.register(new URL('./sw.ts', import.meta.url))` as an entry of its own.
// The walk also reads those through `window.`, `globalThis.` or `self.`, which a bundler may
// resolve too. A path written without './' (`new URL('sw.ts', import.meta.url)`) names the same
// sibling: webpack resolves it relative first, then as written, and the walk follows both. The walk
// reports a `new URL(...)` whose path it cannot read; a URL held in a variable (`new Worker(url)`)
// is not followed. Every public route's lazy chunks, and the chunks they load, are checked too,
// except the editors'.
// An `import()` of `zod` or `sanitize-html` itself names no repo module to walk, so it counts in
// the graph that makes it, as a static import would: Zod is refused there, and the sanitizer
// outside SANITIZING_LAZY_CHUNKS. A `?query` or `#hash` changes nothing (`zod?client` is Zod), nor
// does a path into node_modules. An import that resolves to a file the scan skips (a script, a
// test) is reported as unfollowable, the generated files aside.
// Without tree shaking: a client module that only an unused re-export reaches still counts.
// Measure with a production build (docs/05 "Public Page Performance Budget").

const {
  createResolver,
  directiveOf,
  scanRepository,
}: {
  createResolver: () => (fromFile: string, spec: string) => string | null;
  directiveOf: (source: string, fileName?: string) => string | null;
  scanRepository: () => Map<string, { directive: string | null; imports: string[] }>;
} = require('./lib/service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROOT_LAYOUT = 'apps/nextblock/app/layout.tsx';
const UTILS_BARREL = 'libs/utils/src/index.ts';
const AUTHORED_HTML = 'libs/utils/src/lib/authored-html.ts';
const CUSTOM_BLOCKS = 'libs/utils/src/lib/custom-blocks.ts';
/** Each package's `z` with its config (apps/nextblock/lib/zod-config.ts, libs/<lib>/src/lib/zod-config.ts). */
const ZOD_CONFIG_RE = /(?:^|\/)zod-config\.[cm]?[jt]sx?$/;
const UTILS_VITE_CONFIG = 'libs/utils/vite.config.mts';
const UTILS_DEEP_IMPORT = '@nextblock-cms/utils/';
/** The walks parse a few hundred modules: seconds when the whole suite runs in parallel. */
const WALK_TIMEOUT_MS = 60_000;

/** Lazy chunks of the root layout's client graph that only editors load, with why. */
const EDITOR_ONLY_LAZY_CHUNKS = new Map([
  [
    'apps/nextblock/components/visual-editing/NextblockVisualEditing.tsx',
    'loads only in draft mode or with NEXTBLOCK_VISUAL_EDITING_ENABLED: the in-page block editors, which sanitize in the browser',
  ],
]);

/**
 * Lazy chunks of public routes that sanitize authored HTML in the browser, with why: the
 * sanitizer is allowed in them (and only in them); the barrel and Zod are not. One of them may
 * load the sanitizer's module lazily (`import('@nextblock-cms/utils/authored-html')`, sanitize-html
 * with the allowlist) as it may `import('sanitize-html')`: that chunk inherits the allowance. Any
 * other chunk that sanitizes is listed itself.
 */
const SANITIZING_LAZY_CHUNKS = new Map([
  [
    'apps/nextblock/components/commerce/lazy/FeaturedProduct.ts',
    "the featured_product block: ShortDescription sanitizes a product's HTML short description while it renders, hydration included",
  ],
  [
    'apps/nextblock/components/commerce/lazy/ProductDetailsLayout.ts',
    'the product page: ShortDescription and SimpleTiptapRenderer sanitize an HTML short description or a string description_json while they render',
  ],
]);

/**
 * Generated files the scan skips (service-role-boundary.js EXCLUDED_FILES; CLAUDE.md "Do not
 * modify"). They import nothing, so a walk that stops at one hides nothing.
 */
const GENERATED_UNSCANNED = new Set([
  'apps/nextblock/lib/setup/migrations-bundle.ts',
  'apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts',
  'apps/nextblock/lib/custom-block-safelist.ts',
  'libs/db/src/lib/supabase/types.ts',
]);

/** Constructors whose `new URL(<file>, import.meta.url)` argument webpack and Turbopack build as a chunk of its own. */
const WORKER_CONSTRUCTORS = new Set(['Worker', 'SharedWorker']);
/** The global object a browser API may be read from instead: `new window.Worker(...)`, `self.navigator.serviceWorker`. */
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

const modules = scanRepository();
const resolveUncached = createResolver();
const resolvedImports = new Map<string, string | null>();
/** The resolver, memoized: the route walks ask about the same imports many times. */
const resolveImport = (fromFile: string, spec: string) => {
  const cacheKey = `${fromFile}\0${spec}`;
  let target = resolvedImports.get(cacheKey);
  if (target === undefined) {
    target = resolveUncached(fromFile, spec);
    resolvedImports.set(cacheKey, target);
  }
  return target;
};
const repoPath = (absolute: string) => path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
const byRepoPath = new Map([...modules.keys()].map((absolute) => [repoPath(absolute), absolute]));
const absoluteOf = (file: string) => {
  const absolute = byRepoPath.get(file);
  if (!absolute) throw new Error(`root-layout-chunking: ${file} was not scanned`);
  return absolute;
};
const BARREL = absoluteOf(UTILS_BARREL);
const SANITIZER_MODULE = absoluteOf(AUTHORED_HTML);
/** Modules that load Zod for whoever imports them: every zod-config and the custom-block schemas. */
const ZOD_MODULES = new Set(
  [...byRepoPath.keys()].filter((file) => ZOD_CONFIG_RE.test(file) || file === CUSTOM_BLOCKS).map(absoluteOf)
);

const ROUTE_FILE_RE = /(?:^|\/)(?:page|layout|template|loading|error|not-found|global-error|default)\.[jt]sx?$/;
/** Every route file a visitor can load: everything under app/ outside /cms and /api. */
const PUBLIC_ROUTE_FILES = [...byRepoPath.keys()]
  .filter(
    (file) =>
      file.startsWith('apps/nextblock/app/') &&
      !/^apps\/nextblock\/app\/(?:cms|api)\//.test(file) &&
      ROUTE_FILE_RE.test(file)
  )
  .sort();

type ModuleImports = {
  static: string[];
  dynamic: string[];
  /** `require(x)` / `import(x)`, or a worker's or service worker's `new URL(x, import.meta.url)`, with a specifier the walk cannot read. */
  unresolvedRequire: string[];
  unresolvedImport: string[];
};
const importCache = new Map<string, ModuleImports>();

function scriptKindFor(file: string) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  return file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

/** What the bundler reads through parentheses and the `as`, `satisfies`, `!` and `<T>` the compiler erases. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const isMemberAccess = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** The member a `.name` or `['name']` access reads; null for a computed key or any other node. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

/** `import.meta.url` (or `import.meta['url']`), wrapped or not. */
function isImportMetaUrl(node: ts.Expression) {
  const access = unwrapExpression(node);
  if (!isMemberAccess(access) || memberName(access) !== 'url') return false;
  const base = unwrapExpression(access.expression);
  return ts.isMetaProperty(base) && base.keywordToken === ts.SyntaxKind.ImportKeyword && base.name.text === 'meta';
}

/** The global an expression names, bare or read from the global object (`Worker`, `window.Worker`, `(self as any)['navigator']`); null otherwise. */
function globalName(node: ts.Expression): string | null {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (!isMemberAccess(expression)) return null;
  const base = unwrapExpression(expression.expression);
  return ts.isIdentifier(base) && GLOBAL_OBJECTS.has(base.text) ? memberName(expression) : null;
}

/** `navigator.serviceWorker.register`, navigator bare or read from the global object, wrapped or not. */
function isServiceWorkerRegister(node: ts.Expression) {
  const register = unwrapExpression(node);
  if (!isMemberAccess(register) || memberName(register) !== 'register') return false;
  const container = unwrapExpression(register.expression);
  return isMemberAccess(container) && memberName(container) === 'serviceWorker' && globalName(container.expression) === 'navigator';
}

/**
 * A module's runtime imports, static and dynamic apart (type-only imports are erased). A worker's
 * or a service worker's file counts as an `import()`: the bundler builds it as an entry of its own,
 * loaded when the worker starts or the service worker registers.
 */
function parseImports(fileName: string, source: string): ModuleImports {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const result: ModuleImports = { static: [], dynamic: [], unresolvedRequire: [], unresolvedImport: [] };
  /**
   * `new URL('./search.worker.ts', import.meta.url)` passed to a worker or a service worker: its
   * file is walked like an `import()`, and a `new URL(...)` whose path the walk cannot read is an
   * unfollowable `import()`. A path without './' (`'sw.ts'`) names the module's sibling as a URL
   * does: webpack resolves a worker's URL relative first and then as written (an alias or a
   * package), and the walk follows both. Any other argument is not followed: a string (`'/sw.js'`,
   * a file served from public/) or a URL against another base, which no bundler builds, and a URL
   * held in a variable (`new Worker(url)`).
   */
  const entryUrl = (call: ts.CallExpression | ts.NewExpression, argument: ts.Expression | undefined) => {
    const url = argument && unwrapExpression(argument);
    if (!url || !ts.isNewExpression(url)) return;
    const urlCallee = unwrapExpression(url.expression);
    const [href, base] = url.arguments ?? [];
    if (!ts.isIdentifier(urlCallee) || urlCallee.text !== 'URL' || !base || !isImportMetaUrl(base)) return;
    const specifier = href && unwrapExpression(href);
    if (specifier && ts.isStringLiteralLike(specifier)) {
      // Not relative ('./', '../'), absolute ('/'), a subpath import ('#') or a scheme ('data:').
      if (!/^(?:\.|\/|#|[a-z][a-z\d+.-]*:)/i.test(specifier.text)) result.dynamic.push(`./${specifier.text}`);
      result.dynamic.push(specifier.text);
    } else result.unresolvedImport.push(call.getText(file));
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) result.static.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) result.static.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !node.isTypeOnly) {
      const reference = node.moduleReference.expression;
      if (ts.isStringLiteralLike(reference)) result.static.push(reference.text);
    } else if (ts.isCallExpression(node)) {
      // A cast, a `!` or parentheses hide nothing: `(require as any)('zod')` is a require, and
      // `import(('./x'))` a literal (dynamic-import-specifiers.test.ts allows both spellings).
      const callee = unwrapExpression(node.expression);
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImport || isRequire) {
        const specifier = node.arguments[0] && unwrapExpression(node.arguments[0]);
        if (specifier && ts.isStringLiteralLike(specifier)) (isImport ? result.dynamic : result.static).push(specifier.text);
        else (isImport ? result.unresolvedImport : result.unresolvedRequire).push(node.getText(file));
      } else if (isServiceWorkerRegister(node.expression)) {
        // navigator.serviceWorker.register(new URL('./sw.ts', import.meta.url)): a service-worker entry.
        entryUrl(node, node.arguments[0]);
      }
    } else if (ts.isNewExpression(node)) {
      // new Worker(new URL('./search.worker.ts', import.meta.url)), window.Worker and SharedWorker too.
      const callee = globalName(node.expression);
      if (callee !== null && WORKER_CONSTRUCTORS.has(callee)) entryUrl(node, node.arguments?.[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

/** parseImports of a scanned module, read and parsed once. */
function importsOf(absolute: string): ModuleImports {
  const cached = importCache.get(absolute);
  if (cached) return cached;
  const result = parseImports(absolute, readFileSync(absolute, 'utf8'));
  importCache.set(absolute, result);
  return result;
}

/** A specifier without its `?query` or `#hash`, which load the same file (`zod?client` is Zod); a leading `#` names a subpath import and stays. */
function bareSpecifier(spec: string) {
  const cut = spec.slice(1).search(/[?#]/);
  return cut === -1 ? spec : spec.slice(0, cut + 1);
}
const isSanitizerSpecifier = (spec: string) => {
  const bare = bareSpecifier(spec);
  return bare === 'sanitize-html' || bare.startsWith('sanitize-html/');
};
const isZodSpecifier = (spec: string) => {
  const bare = bareSpecifier(spec);
  return bare === 'zod' || bare.startsWith('zod/');
};

type Context = 'server' | 'client';

/** What a walk reads: the scanned repository (REPO_GRAPH), or a graph built from source text in the self-tests. */
type Graph = {
  modules: Map<string, { directive: string | null }>;
  /** A module's absolute path from its repo path; throws for a file the graph does not hold. */
  absoluteOf: (file: string) => string;
  importsOf: (absolute: string) => ModuleImports;
  resolve: (fromFile: string, spec: string) => string | null;
};
const REPO_GRAPH: Graph = { modules, absoluteOf, importsOf, resolve: resolveImport };

/** The file a specifier loads, its `?query` or `#hash` aside; null for a package. */
const resolveIn = (graph: Graph, fromFile: string, spec: string) => graph.resolve(fromFile, bareSpecifier(spec));

/** A resolved file the walk cannot enter: outside the scan (a script, a test, node_modules), and not a generated file. */
const isUnscanned = (graph: Graph, target: string | null): target is string =>
  target !== null && !graph.modules.has(target) && !GENERATED_UNSCANNED.has(repoPath(target));

/**
 * The client modules reachable from `starts` (route files walk in server context, a lazy chunk
 * in client context), the lazy chunks their client code imports, and how each was reached.
 * `unresolved` lists imports the walk cannot follow that would hide part of the graph (an
 * unreadable specifier, or a file outside the scan); `unresolvedLazy`, the `import()`s, workers
 * and service workers in client code it cannot follow (lazy chunks left unchecked).
 */
function walkGraph(starts: string[], context: Context, graph: Graph = REPO_GRAPH) {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  const key = (absolute: string, ctx: Context) => `${ctx}|${absolute}`;
  for (const start of starts) {
    const startKey = key(graph.absoluteOf(start), context);
    parent.set(startKey, null);
    queue.push(startKey);
  }
  const client = new Map<string, string>();
  const lazy = new Map<string, string>();
  const unresolved: string[] = [];
  const unresolvedLazy: string[] = [];
  const chainTo = (startKey: string) => {
    const chain: string[] = [];
    for (let node: string | null | undefined = startKey; node; node = parent.get(node)) chain.push(repoPath(node.slice(node.indexOf('|') + 1)));
    return chain.reverse().join(' -> ');
  };
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const absolute = current.slice(current.indexOf('|') + 1);
    const directive = graph.modules.get(absolute)?.directive ?? null;
    const here: Context = directive === 'use client' ? 'client' : (current.slice(0, current.indexOf('|')) as Context);
    if (here === 'client' && directive === 'use server') continue;
    if (here === 'client' && !client.has(absolute)) client.set(absolute, chainTo(current));
    const imports = graph.importsOf(absolute);
    const where = (call: string) => `${repoPath(absolute)}: ${call}`;
    unresolved.push(...imports.unresolvedRequire.map(where));
    (here === 'client' ? unresolvedLazy : unresolved).push(...imports.unresolvedImport.map(where));
    const skipped = (call: string, target: string) => where(`${call} resolves to ${repoPath(target)}, a file the scan skips`);
    if (here === 'client') {
      for (const spec of imports.dynamic) {
        const target = resolveIn(graph, absolute, spec);
        if (isUnscanned(graph, target)) unresolvedLazy.push(skipped(`import('${spec}')`, target));
        else if (target && graph.modules.has(target) && !lazy.has(target)) lazy.set(target, repoPath(absolute));
      }
    }
    for (const spec of here === 'client' ? imports.static : [...imports.static, ...imports.dynamic]) {
      const target = resolveIn(graph, absolute, spec);
      if (isUnscanned(graph, target)) unresolved.push(skipped(`'${spec}'`, target));
      if (!target || !graph.modules.has(target)) continue;
      const targetKey = key(target, here);
      if (parent.has(targetKey)) continue;
      parent.set(targetKey, current);
      queue.push(targetKey);
    }
  }
  return { client, lazy, unresolved, unresolvedLazy };
}

type Payload = 'barrel' | 'sanitizer' | 'zod';
const PAYLOAD_NAMES: Record<Payload, string> = { barrel: 'the utils barrel', sanitizer: 'the sanitizer', zod: 'Zod' };

/** A file of the sanitizer's or Zod's package, named by a path into node_modules instead of the package name. */
function packagePayload(target: string | null): Payload | null {
  const file = target === null ? '' : target.split(path.sep).join('/');
  if (file.includes('/node_modules/sanitize-html/')) return 'sanitizer';
  return file.includes('/node_modules/zod/') ? 'zod' : null;
}

/** What an import puts in a client chunk that the rules here refuse: the barrel (both), the sanitizer or Zod. */
function payloadOf(fromFile: string, spec: string, graph: Graph): Payload | null {
  const target = resolveIn(graph, fromFile, spec);
  if (target === BARREL) return 'barrel';
  if (isSanitizerSpecifier(spec) || target === SANITIZER_MODULE || packagePayload(target) === 'sanitizer') return 'sanitizer';
  if (isZodSpecifier(spec) || (target !== null && ZOD_MODULES.has(target)) || packagePayload(target) === 'zod') return 'zod';
  return null;
}

/**
 * Every import, in client code, of the utils barrel, the sanitizer (its module or sanitize-html) or
 * Zod. An `import()` of a repo module is a lazy chunk, checked on its own (checkLazyChunks); any
 * other `import()` (sanitize-html or Zod by name, or by a path into node_modules) loads a file the
 * walk never enters, so it counts here.
 */
function payloadImports(client: Map<string, string>, graph: Graph = REPO_GRAPH) {
  const found: Array<{ payload: Payload; offender: string }> = [];
  for (const [absolute, chain] of client) {
    const imports = graph.importsOf(absolute);
    for (const spec of imports.static) {
      const payload = payloadOf(absolute, spec, graph);
      if (payload) found.push({ payload, offender: `'${spec}' (${PAYLOAD_NAMES[payload]}) in ${chain}` });
    }
    for (const spec of imports.dynamic) {
      const target = resolveIn(graph, absolute, spec);
      if (target !== null && graph.modules.has(target)) continue; // a lazy chunk
      const payload = payloadOf(absolute, spec, graph);
      if (payload) found.push({ payload, offender: `import('${spec}') (${PAYLOAD_NAMES[payload]}) in ${chain}` });
    }
  }
  return found.sort((a, b) => a.offender.localeCompare(b.offender));
}

/** The imports a client graph may not make: the barrel and Zod, and the sanitizer unless the graph renders authored HTML. */
const offendersIn = (client: Map<string, string>, { sanitizes = false, graph = REPO_GRAPH } = {}) =>
  payloadImports(client, graph)
    .filter(({ payload }) => !(sanitizes && payload === 'sanitizer'))
    .map(({ offender }) => offender);

/** Whether a chunk reaches the sanitizer: through its own imports, or by loading the sanitizer's module lazily (that chunk inherits its allowance). */
const reachesSanitizer = (chunk: ReturnType<typeof walkGraph>, graph: Graph = REPO_GRAPH) =>
  [...chunk.lazy.keys()].some((nested) => repoPath(nested) === AUTHORED_HTML) ||
  payloadImports(chunk.client, graph).some(({ payload }) => payload === 'sanitizer');

/**
 * Walks the lazy chunks in `roots` (chunk -> what loads it) and the chunks they load in turn,
 * except the editors': the barrel and Zod are refused in every one, the sanitizer outside
 * SANITIZING_LAZY_CHUNKS and the sanitizer module's own chunk when one of them loads it. Returns
 * each chunk's walk, the offenders and the unfollowable imports.
 */
function checkLazyChunks(roots: Map<string, string>, graph: Graph = REPO_GRAPH) {
  const walked = new Map<string, ReturnType<typeof walkGraph>>();
  const offenders: string[] = [];
  const unresolved: string[] = [];
  /** Each chunk to check, what loads it, and whether the sanitizer is allowed in it. */
  const pending = [...roots].map(([root, loader]) => ({ root, loader, sanitizes: SANITIZING_LAZY_CHUNKS.has(repoPath(root)) }));
  /** A chunk is checked once per allowance: the sanitizer's module loaded by a sanitizing chunk and by another is refused for the other. */
  const checked = new Set<string>();
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const { root, loader, sanitizes } = next;
    const checkKey = `${sanitizes}|${root}`;
    if (checked.has(checkKey) || EDITOR_ONLY_LAZY_CHUNKS.has(repoPath(root))) continue;
    checked.add(checkKey);
    const chunk = walked.get(root) ?? walkGraph([repoPath(root)], 'client', graph);
    walked.set(root, chunk);
    offenders.push(...offendersIn(chunk.client, { sanitizes, graph }).map((offender) => `${offender} (lazy chunk loaded by ${loader})`));
    unresolved.push(...chunk.unresolved, ...chunk.unresolvedLazy);
    for (const [nested, importer] of chunk.lazy) {
      // import('@nextblock-cms/utils/authored-html') from a sanitizing chunk is that chunk's sanitizer, as import('sanitize-html') would be.
      const inherits = sanitizes && repoPath(nested) === AUTHORED_HTML;
      pending.push({ root: nested, loader: importer, sanitizes: inherits || SANITIZING_LAZY_CHUNKS.has(repoPath(nested)) });
    }
  }
  return { walked, offenders: [...new Set(offenders)], unresolved: [...new Set(unresolved)] };
}

type PublicRouteWalks = { offenders: string[]; unresolved: string[]; unresolvedLazy: string[]; lazy: Map<string, string> };
let publicRouteWalks: PublicRouteWalks | null = null;
/** Every public route's client graph, walked once for the two tests that read it. */
function walkPublicRoutes(): PublicRouteWalks {
  if (publicRouteWalks) return publicRouteWalks;
  const offenders = new Set<string>();
  const unresolved = new Set<string>();
  const unresolvedLazy = new Set<string>();
  const lazy = new Map<string, string>();
  for (const route of PUBLIC_ROUTE_FILES) {
    const walk = walkGraph([route], 'server');
    for (const offender of offendersIn(walk.client)) offenders.add(offender);
    for (const call of walk.unresolved) unresolved.add(call);
    for (const call of walk.unresolvedLazy) unresolvedLazy.add(call);
    for (const [chunk, importer] of walk.lazy) if (!lazy.has(chunk)) lazy.set(chunk, `${importer} (route ${route})`);
  }
  publicRouteWalks = { offenders: [...offenders].sort(), unresolved: [...unresolved], unresolvedLazy: [...unresolvedLazy], lazy };
  return publicRouteWalks;
}

describe('the authored-HTML sanitizer and Zod stay off public pages', () => {
  const rootLayout = walkGraph([ROOT_LAYOUT], 'server');

  it("walks from the root layout into its client components and the libraries they import", () => {
    const clientFiles = [...rootLayout.client.keys()].map(repoPath);
    expect(clientFiles).toEqual(
      expect.arrayContaining([
        'apps/nextblock/app/providers.tsx',
        'apps/nextblock/components/AppShell.tsx',
        'apps/nextblock/components/privacy/ConsentBanner.tsx',
        'libs/utils/src/lib/translations-context.tsx',
        'libs/ui/src/lib/button.tsx',
      ])
    );
    // An import the walk cannot follow would hide a branch of the graph.
    expect([...rootLayout.unresolved, ...rootLayout.unresolvedLazy]).toEqual([]);
    expect(PUBLIC_ROUTE_FILES).toEqual(expect.arrayContaining([ROOT_LAYOUT, 'apps/nextblock/app/page.tsx']));
    expect([...ZOD_MODULES].map(repoPath)).toEqual(
      expect.arrayContaining([CUSTOM_BLOCKS, 'libs/utils/src/lib/zod-config.ts', 'apps/nextblock/lib/zod-config.ts'])
    );
  });

  it('still finds the sanitizer and Zod where they do ship: the in-page editors', () => {
    const [editors] = EDITOR_ONLY_LAZY_CHUNKS.keys();
    const payloads = payloadImports(walkGraph([editors], 'client').client).map(({ payload }) => payload);
    expect(payloads).toEqual(expect.arrayContaining(['sanitizer', 'zod']));
  });

  it("reaches neither the utils barrel, the sanitizer nor Zod from the root layout's client graph", () => {
    // Import the module that defines the name instead: '@nextblock-cms/utils/utils' (cn,
    // formatPrice, normalizeCurrencyCode, …), '@nextblock-cms/utils/translations-context'
    // (useTranslations, TranslationsProvider), '@nextblock-cms/utils/color', … (`import type`
    // from the barrel is fine: it is erased before bundling). Keep Zod (`zod`, a zod-config
    // module, the custom-block schemas) in server code.
    expect(offendersIn(rootLayout.client)).toEqual([]);
  });

  it('reaches none of them from the lazy chunks the root layout loads for visitors', () => {
    for (const file of EDITOR_ONLY_LAZY_CHUNKS.keys()) {
      // A stale exemption would hide nothing today and anything tomorrow.
      expect([...rootLayout.lazy.keys()].map(repoPath), `${file} is no longer a lazy chunk of the root layout`).toContain(file);
    }
    const { walked, offenders, unresolved } = checkLazyChunks(rootLayout.lazy);
    expect(walked.size).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
    expect(offenders).toEqual([]);
  }, WALK_TIMEOUT_MS);

  it("reaches none of them from any public route's client graph", () => {
    // Pages that do render authored HTML in the browser draw those components lazily
    // (LazyCommerceClients); a static import here ships the sanitizer on first load, and an
    // import('sanitize-html') belongs in a module under components/commerce/lazy that
    // SANITIZING_LAZY_CHUNKS lists.
    const { offenders, unresolved } = walkPublicRoutes();
    expect(unresolved).toEqual([]);
    expect(offenders).toEqual([]);
  }, WALK_TIMEOUT_MS);

  it('reaches neither the barrel nor Zod from the lazy chunks public routes load, and the sanitizer only where it renders', () => {
    // LazyCommerceClients' chunks load only on a page with that block, but they still ship
    // whatever they import: a product grid's chunk has no use for the sanitizer or Zod.
    const { lazy, unresolvedLazy } = walkPublicRoutes();
    const { walked, offenders, unresolved } = checkLazyChunks(lazy);
    for (const file of SANITIZING_LAZY_CHUNKS.keys()) {
      // A stale exemption would hide nothing today and anything tomorrow.
      const chunk = walked.get(byRepoPath.get(file) ?? file);
      expect(chunk, `${file} is no longer a lazy chunk of a public route`).toBeDefined();
      const sanitizes = chunk !== undefined && reachesSanitizer(chunk);
      expect(sanitizes, `${file} no longer reaches the sanitizer: remove it from SANITIZING_LAZY_CHUNKS`).toBe(true);
    }
    expect(walked.size).toBeGreaterThan(SANITIZING_LAZY_CHUNKS.size);
    // An `import()` the walk cannot follow is a chunk nobody checks.
    expect([...unresolvedLazy, ...unresolved]).toEqual([]);
    expect(offenders).toEqual([]);
  }, WALK_TIMEOUT_MS);
});

/**
 * A graph built from source text (repo path -> source), nothing read from disk: the self-tests'
 * code. `unscanned` names files that resolve but that the scan skips (node_modules, a script, a
 * generated file).
 */
function syntheticGraph(files: Record<string, string>, unscanned: string[] = []): Graph {
  const sources = new Map(Object.entries(files).map(([file, source]) => [path.join(REPO_ROOT, file), source]));
  const skipped = new Set(unscanned.map((file) => path.join(REPO_ROOT, file)));
  return {
    modules: new Map([...sources].map(([absolute, source]) => [absolute, { directive: directiveOf(source, absolute) }])),
    absoluteOf: (file) => {
      const absolute = path.join(REPO_ROOT, file);
      if (!sources.has(absolute)) throw new Error(`root-layout-chunking: the synthetic graph has no ${file}`);
      return absolute;
    },
    importsOf: (absolute) => parseImports(absolute, sources.get(absolute) ?? ''),
    // Relative specifiers only: any other names a package, as `zod` and `sanitize-html` do in the repository.
    resolve: (fromFile, spec) => {
      if (!spec.startsWith('.')) return null;
      const base = path.resolve(path.dirname(fromFile), spec);
      return [base, `${base}.ts`, `${base}.tsx`].find((candidate) => sources.has(candidate) || skipped.has(candidate)) ?? null;
    },
  };
}

describe('the walk and the checks on synthetic graphs: package import()s, workers and service workers, spellings, unscanned files', () => {
  // A public route, the client component it renders, and the lazy chunk that component loads.
  const ROUTE = 'synthetic/app/page.tsx';
  const COMPONENT = 'synthetic/components/Grid.tsx';
  const CHUNK = 'synthetic/components/GridChunk.tsx';
  const ZOD_CONFIG = 'synthetic/lib/zod-config.ts';
  const graphWith = ({
    route = '',
    component = '',
    chunk = '',
    extra = {},
    unscanned = [],
  }: {
    route?: string;
    component?: string;
    chunk?: string;
    /** More modules, repo path -> source. */
    extra?: Record<string, string>;
    unscanned?: string[];
  }) =>
    syntheticGraph(
      {
        [ROUTE]: `import Grid from '../components/Grid';\n${route}\nexport default Grid;\n`,
        [COMPONENT]: `'use client';\n${component}\nexport const loadChunk = () => import('./GridChunk');\nexport default function Grid() { return null; }\n`,
        [CHUNK]: `'use client';\n${chunk}\nexport default function GridChunk() { return null; }\n`,
        [ZOD_CONFIG]: "import { z } from 'zod';\nz.config({ jitless: true });\nexport { z };\n",
        ...extra,
      },
      unscanned
    );
  /** What the public-route tests above report for a route: its client graph's offenders and its lazy chunks'. */
  const offendersOf = (graph: Graph) => {
    const walk = walkGraph([ROUTE], 'server', graph);
    return { entry: offendersIn(walk.client, { graph }), lazy: checkLazyChunks(walk.lazy, graph).offenders };
  };
  const PACKAGE_IMPORTS: Array<[string, string]> = [
    ['zod', 'Zod'],
    ['zod/v4', 'Zod'],
    ['sanitize-html', 'the sanitizer'],
  ];

  it.each(PACKAGE_IMPORTS)("refuses import('%s') in a public route's client graph", (spec, name) => {
    expect(offendersOf(graphWith({ component: `export const load = () => import('${spec}');` }))).toEqual({
      entry: [`import('${spec}') (${name}) in ${ROUTE} -> ${COMPONENT}`],
      lazy: [],
    });
  });

  it.each(PACKAGE_IMPORTS)("refuses import('%s') in a lazy chunk that renders no authored HTML", (spec, name) => {
    expect(offendersOf(graphWith({ chunk: `export const load = () => import('${spec}');` }))).toEqual({
      entry: [],
      lazy: [`import('${spec}') (${name}) in ${CHUNK} (lazy chunk loaded by ${COMPONENT})`],
    });
  });

  // Review 2026-11-15: the walk missed a cast or parenthesized require, the usual spelling in TS code
  // without Node's require types, and reported a parenthesized import() literal as unfollowable.
  it.each(["(require as any)('zod')", "(require)('zod')", "require!('zod')", "require(('zod'))", "(require satisfies unknown as any)('zod')"])(
    "refuses %s in a public route's client graph, like require('zod')",
    (call) => {
      expect(offendersOf(graphWith({ component: `export const zod = ${call};` }))).toEqual(
        offendersOf(graphWith({ component: "export const zod = require('zod');" }))
      );
      expect(offendersOf(graphWith({ component: `export const zod = ${call};` })).entry).toHaveLength(1);
    }
  );

  it("follows a parenthesized import() literal like import('zod')", () => {
    expect(offendersOf(graphWith({ component: "export const load = () => import(('zod'));" }))).toEqual({
      entry: [`import('zod') (Zod) in ${ROUTE} -> ${COMPONENT}`],
      lazy: [],
    });
  });

  it('allows an import() of the sanitizer, never of Zod, in a lazy chunk that renders authored HTML', () => {
    const graph = graphWith({ chunk: "export const sanitizer = () => import('sanitize-html');\nexport const zod = () => import('zod/v4');" });
    // checkLazyChunks passes `sanitizes` for each chunk SANITIZING_LAZY_CHUNKS lists.
    expect(offendersIn(walkGraph([CHUNK], 'client', graph).client, { sanitizes: true, graph })).toEqual([`import('zod/v4') (Zod) in ${CHUNK}`]);
  });

  it('lets server-only and type-only Zod through, and still refuses the static and lazy-module forms', () => {
    const serverAndTypes = graphWith({
      route: "import { z } from 'zod';\nexport const schema = z.string();\nexport const loadZod = () => import('zod');",
      component: "import type { z } from 'zod';\nexport type Schema = z.ZodType;\nexport type ZodModule = typeof import('zod');",
    });
    expect(offendersOf(serverAndTypes)).toEqual({ entry: [], lazy: [] });
    const staticAndLazyModule = graphWith({
      component: "import { z } from 'zod';\nexport const schema = z.string();",
      chunk: "export const loadZod = () => import('../lib/zod-config');",
    });
    expect(offendersOf(staticAndLazyModule)).toEqual({
      entry: [`'zod' (Zod) in ${ROUTE} -> ${COMPONENT}`],
      lazy: [`'zod' (Zod) in ${ZOD_CONFIG} (lazy chunk loaded by ${CHUNK})`],
    });
  });

  it('walks a Web Worker as a lazy chunk of the code that starts it', () => {
    const WORKER = 'synthetic/components/search.worker.ts';
    const worker = { [WORKER]: "import { z } from 'zod';\nexport const query = z.string();\n" };
    const spawn = "export const spawn = () => new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });";
    expect(offendersOf(graphWith({ component: spawn, extra: worker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${WORKER} (lazy chunk loaded by ${COMPONENT})`],
    });
    // A SharedWorker started from a lazy chunk, through the casts the compiler erases.
    const share = "export const share = () => new (SharedWorker as any)((new URL('./search.worker.ts' as string, import.meta['url'])) as URL);";
    expect(offendersOf(graphWith({ chunk: share, extra: worker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${WORKER} (lazy chunk loaded by ${CHUNK})`],
    });
    // A worker read from the global object.
    for (const constructor of ['window.Worker', 'globalThis.Worker', "(self as any)['SharedWorker']"]) {
      const spawnFrom = `export const spawn = () => new ${constructor}(new URL('./search.worker.ts', import.meta.url));`;
      expect(offendersOf(graphWith({ component: spawnFrom, extra: worker })).lazy, constructor).toEqual([
        `'zod' (Zod) in ${WORKER} (lazy chunk loaded by ${COMPONENT})`,
      ]);
    }
    // A path without './' names the same sibling: webpack resolves a worker's URL relative first.
    const bare = "export const spawn = () => new Worker(new URL('search.worker.ts', import.meta.url));";
    expect(offendersOf(graphWith({ component: bare, extra: worker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${WORKER} (lazy chunk loaded by ${COMPONENT})`],
    });
    // A worker URL the walk cannot read is a chunk nobody checks.
    const computed = 'export const spawn = (name: string) => new Worker(new URL(`./workers/${name}.ts`, import.meta.url));';
    expect(walkGraph([ROUTE], 'server', graphWith({ component: computed })).unresolvedLazy).toEqual([
      `${COMPONENT}: new Worker(new URL(\`./workers/\${name}.ts\`, import.meta.url))`,
    ]);
    // A URL against another base is no bundler entry: it adds no lazy chunk.
    const page = "export const spawn = () => new Worker(new URL('./search.worker.ts', document.baseURI));";
    const pageWalk = walkGraph([ROUTE], 'server', graphWith({ component: page, extra: worker }));
    expect([...pageWalk.lazy.keys()].map(repoPath)).toEqual([CHUNK]);
    expect(pageWalk.unresolvedLazy).toEqual([]);
  });

  it('walks a service worker as a lazy chunk of the code that registers it', () => {
    const SERVICE_WORKER = 'synthetic/components/sw.ts';
    const serviceWorker = { [SERVICE_WORKER]: "import { z } from 'zod';\nexport const message = z.object({ type: z.string() });\n" };
    const register = "export const register = () => navigator.serviceWorker.register(new URL('./sw.ts', import.meta.url), { type: 'module' });";
    expect(offendersOf(graphWith({ component: register, extra: serviceWorker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${SERVICE_WORKER} (lazy chunk loaded by ${COMPONENT})`],
    });
    // Registered from a lazy chunk, navigator read from the global object, through casts and an optional call.
    const fromChunk = "export const register = () => (window.navigator as any).serviceWorker?.register(new URL('./sw.ts' as string, import.meta['url']));";
    expect(offendersOf(graphWith({ chunk: fromChunk, extra: serviceWorker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${SERVICE_WORKER} (lazy chunk loaded by ${CHUNK})`],
    });
    // A path without './' names the same sibling, and is also read as written (an alias or a package);
    // a relative, absolute, subpath-import or scheme URL is read only as written.
    const bare = "export const register = () => navigator.serviceWorker.register(new URL('sw.ts', import.meta.url));";
    expect(offendersOf(graphWith({ component: bare, extra: serviceWorker }))).toEqual({
      entry: [],
      lazy: [`'zod' (Zod) in ${SERVICE_WORKER} (lazy chunk loaded by ${COMPONENT})`],
    });
    for (const [spec, read] of [
      ['sw.ts', ['./sw.ts', 'sw.ts']],
      ['@/components/sw', ['./@/components/sw', '@/components/sw']],
      ['./sw.ts', ['./sw.ts']],
      ['../sw.ts', ['../sw.ts']],
      ['/sw.ts', ['/sw.ts']],
      ['#sw', ['#sw']],
      ['data:text/javascript,0', ['data:text/javascript,0']],
    ] as const) {
      expect(parseImports('register.ts', `navigator.serviceWorker.register(new URL('${spec}', import.meta.url));`).dynamic, spec).toEqual(read);
    }
    // A service-worker URL the walk cannot read is a chunk nobody checks.
    const computed = 'export const register = (name: string) => navigator.serviceWorker.register(new URL(`./sw/${name}.ts`, import.meta.url));';
    expect(walkGraph([ROUTE], 'server', graphWith({ component: computed })).unresolvedLazy).toEqual([
      `${COMPONENT}: navigator.serviceWorker.register(new URL(\`./sw/\${name}.ts\`, import.meta.url))`,
    ]);
    // A service worker served from public/ is built by no bundler, and only navigator.serviceWorker.register
    // builds one: none of these adds a lazy chunk.
    for (const call of [
      "navigator.serviceWorker.register('/sw.js')",
      "navigator.serviceWorker.getRegistration(new URL('./sw.ts', import.meta.url))",
      "navigator.plugins.register(new URL('./sw.ts', import.meta.url))",
    ]) {
      const walk = walkGraph([ROUTE], 'server', graphWith({ component: `export const register = () => ${call};`, extra: serviceWorker }));
      expect([...walk.lazy.keys()].map(repoPath), call).toEqual([CHUNK]);
      expect(walk.unresolvedLazy, call).toEqual([]);
    }
  });

  it('reads the file a specifier loads, whatever its ?query or #hash', () => {
    expect(offendersOf(graphWith({ component: "export const load = () => import('zod?client');" })).entry).toEqual([
      `import('zod?client') (Zod) in ${ROUTE} -> ${COMPONENT}`,
    ]);
    expect(offendersOf(graphWith({ component: "import sanitizeHtml from 'sanitize-html#browser';\nexport const clean = sanitizeHtml;" })).entry).toEqual([
      `'sanitize-html#browser' (the sanitizer) in ${ROUTE} -> ${COMPONENT}`,
    ]);
    // A relative specifier resolves without its query, so the module behind it is walked.
    expect(offendersOf(graphWith({ chunk: "export const loadZod = () => import('../lib/zod-config?client');" })).lazy).toEqual([
      `'zod' (Zod) in ${ZOD_CONFIG} (lazy chunk loaded by ${CHUNK})`,
    ]);
  });

  it('counts a path into node_modules as the package it names', () => {
    const graph = graphWith({
      component: "import * as z from '../../node_modules/zod/index.js';\nexport const schema = z.string();",
      chunk: "export const load = () => import('../../node_modules/sanitize-html/index.js');",
      unscanned: ['node_modules/zod/index.js', 'node_modules/sanitize-html/index.js'],
    });
    expect(offendersOf(graph)).toEqual({
      entry: [`'../../node_modules/zod/index.js' (Zod) in ${ROUTE} -> ${COMPONENT}`],
      lazy: [`import('../../node_modules/sanitize-html/index.js') (the sanitizer) in ${CHUNK} (lazy chunk loaded by ${COMPONENT})`],
    });
  });

  it('reports an import that resolves to a file the scan skips, a generated file aside', () => {
    const graph = graphWith({
      route: [
        "import { checkSchemas } from '../../scripts/check-schemas';",
        'export const check = checkSchemas;',
        // A server-side import() is followed like a static import, so it is reported the same way.
        "export const loadSeed = () => import('../../scripts/seed');",
      ].join('\n'),
      component: [
        "import { Constants } from '../../libs/db/src/lib/supabase/types';",
        "import * as z from '../../node_modules/zod/index.js';",
        "export const loadChecks = () => import('../../scripts/check-schemas');",
        'export const loaded = [Constants, z];',
      ].join('\n'),
      unscanned: ['scripts/check-schemas.ts', 'scripts/seed.ts', 'node_modules/zod/index.js', 'libs/db/src/lib/supabase/types.ts'],
    });
    const walk = walkGraph([ROUTE], 'server', graph);
    expect(walk.unresolved).toEqual([
      `${ROUTE}: '../../scripts/check-schemas' resolves to scripts/check-schemas.ts, a file the scan skips`,
      `${ROUTE}: '../../scripts/seed' resolves to scripts/seed.ts, a file the scan skips`,
      `${COMPONENT}: '../../node_modules/zod/index.js' resolves to node_modules/zod/index.js, a file the scan skips`,
    ]);
    expect(walk.unresolvedLazy).toEqual([
      `${COMPONENT}: import('../../scripts/check-schemas') resolves to scripts/check-schemas.ts, a file the scan skips`,
    ]);
  });

  it("lets a sanitizing chunk load the sanitizer's module lazily, as it may load sanitize-html, and no other chunk", () => {
    const FEATURED = 'apps/nextblock/components/commerce/lazy/FeaturedProduct.ts';
    expect(SANITIZING_LAZY_CHUNKS.has(FEATURED)).toBe(true);
    const sanitizerModule = "import sanitizeHtml from 'sanitize-html';\nexport const sanitize = (html: string) => sanitizeHtml(html);\n";
    const withFeatured = (featured: string, chunk = '') =>
      graphWith({
        component: "export const loadFeatured = () => import('../../apps/nextblock/components/commerce/lazy/FeaturedProduct');",
        chunk,
        extra: { [FEATURED]: `'use client';\n${featured}\n`, [AUTHORED_HTML]: sanitizerModule },
      });
    const viaPackage = "export const sanitizer = () => import('sanitize-html');";
    const viaModule = "export const sanitizer = () => import('../../../../../libs/utils/src/lib/authored-html');";
    for (const featured of [viaPackage, viaModule]) {
      const graph = withFeatured(featured);
      expect(offendersOf(graph)).toEqual({ entry: [], lazy: [] });
      // Either spelling also counts for the check that the chunk's SANITIZING_LAZY_CHUNKS entry is still needed.
      expect(reachesSanitizer(walkGraph([FEATURED], 'client', graph), graph), featured).toBe(true);
    }
    const neither = withFeatured('export const sanitizer = null;');
    expect(reachesSanitizer(walkGraph([FEATURED], 'client', neither), neither)).toBe(false);
    // A chunk the list leaves out may not load it, even when a sanitizing chunk loaded it first.
    const fromUnlisted = "export const sanitizer = () => import('../../libs/utils/src/lib/authored-html');";
    expect(offendersOf(withFeatured(viaModule, fromUnlisted))).toEqual({
      entry: [],
      lazy: [`'sanitize-html' (the sanitizer) in ${AUTHORED_HTML} (lazy chunk loaded by ${CHUNK})`],
    });
  });
});

/** The source files `build.lib.entry` names in libs/utils/vite.config.mts. */
function utilsBuildEntries() {
  const configPath = path.join(REPO_ROOT, UTILS_VITE_CONFIG);
  const file = ts.createSourceFile(configPath, readFileSync(configPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'entry' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
          entries.push(path.resolve(path.dirname(configPath), property.initializer.text));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return entries;
}

describe('the deep @nextblock-cms/utils subpaths resolve in the published package', () => {
  it('names a module the build emits, and only exports that survive preserveModules', () => {
    // The package maps './*' to 'lib/*.es.js'. preserveModules emits only modules a build entry
    // reaches, and keeps only the exports an entry uses: a deep import of anything else works in
    // the monorepo (tsconfig paths read the source) and fails in every standalone install.
    // tools/scripts/verify-lib-dist.js checks the emitted files at release; this checks the
    // names, before any build.
    const entries = utilsBuildEntries();
    expect(entries.map(repoPath)).toEqual(expect.arrayContaining([UTILS_BARREL]));
    // Every utils source module as a root, and nothing outside it: the exports between them are
    // all this needs, and loading the packages they import (the AWS SDK's types) took seconds.
    const utilsSources = [...modules.keys()].filter((absolute) => repoPath(absolute).startsWith('libs/utils/src/'));
    const program = ts.createProgram(utilsSources, {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noLib: true,
      noResolve: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    const checker = program.getTypeChecker();
    const entrySet = new Set(entries.map((entry) => path.normalize(entry)));
    const exposed = new Map<string, Set<string>>();
    for (const entry of entries) {
      const source = program.getSourceFile(entry);
      const symbol = source && checker.getSymbolAtLocation(source);
      if (!symbol) throw new Error(`root-layout-chunking: cannot read the exports of ${repoPath(entry)}`);
      for (const exported of checker.getExportsOfModule(symbol)) {
        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = target.declarations?.[0];
        if (!declaration) continue;
        const file = path.normalize(declaration.getSourceFile().fileName);
        if (!exposed.has(file)) exposed.set(file, new Set());
        exposed.get(file)?.add(target.name);
      }
    }

    const problems: string[] = [];
    let checked = 0;
    for (const [absolute, record] of modules) {
      if (!record.imports.some((spec) => spec.startsWith(UTILS_DEEP_IMPORT))) continue;
      const file = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, scriptKindFor(absolute));
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const spec = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
        if (!spec.startsWith(UTILS_DEEP_IMPORT)) continue;
        const target = resolveImport(absolute, spec);
        const where = `${repoPath(absolute)}: '${spec}'`;
        if (!target) {
          problems.push(`${where} resolves to no file under libs/utils/src/lib`);
          continue;
        }
        checked += 1;
        if (entrySet.has(path.normalize(target))) continue; // an entry keeps every export
        const names = exposed.get(path.normalize(target));
        if (!names) {
          problems.push(`${where}: no build entry reaches ${repoPath(target)}, so the package ships no JavaScript for it (re-export it from src/index.ts or add a build.lib.entry)`);
          continue;
        }
        const wanted: string[] = [];
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) continue;
          if (clause?.name) wanted.push('default');
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) wanted.push((element.propertyName ?? element.name).text);
          }
        } else if (!statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) if (!element.isTypeOnly) wanted.push((element.propertyName ?? element.name).text);
        }
        const missing = wanted.filter((name) => !names.has(name));
        if (missing.length > 0) {
          problems.push(`${where} imports ${missing.join(', ')}, which no build entry exports, so the published lib/*.es.js drops it`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  }, WALK_TIMEOUT_MS);
});
