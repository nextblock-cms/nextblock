import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Keeps commerce client code on the routes that render it.
//
// Turbopack makes every client module reachable from a route's server graph part of that
// route's entry chunks, and Next loads all of them up front (`entryJSFiles`). Two things
// put the whole commerce library on routes that never render it:
//
// 1. The barrels. `@nextblock-cms/ecommerce` re-exports every storefront component (and
//    the CMS ProductForm); `@nextblock-cms/ecommerce/server` re-exports every CMS commerce
//    screen. One value import of either, anywhere in a route's graph, adds all of those
//    client components to the route. On 2026-11-04 the home page loaded 397 KB gzipped of
//    JavaScript this way (the CMS product, shipping, coupon and payment forms included);
//    with deep subpaths it loads 213 KB. `experimental.optimizePackageImports` does not
//    help: the monorepo resolves the libs from source, and the build came out identical.
// 2. A server-side `import()` does not split. BlockRenderer reaches the commerce renderers
//    through one, and Next documents that a Server Component dynamically importing a Client
//    Component is not code-split. The renderers draw their client components through
//    `components/commerce/LazyCommerceClients.tsx` (next/dynamic in a Client Component).
//    Its `import()`s name app modules (`components/commerce/lazy/*` re-export the library's
//    components): an `import()` of a library makes Nx treat the whole library as lazy-loaded
//    in the project, and `@nx/enforce-module-boundaries` then refuses every static import of
//    it. ESLint reads Nx's cached project graph, so a stale graph can hide that error locally.
//
// The `@nextblock-cms/utils` barrel has the same problem (it carries the authored-HTML
// sanitizer and Zod): tools/scripts/root-layout-chunking.test.ts keeps it, and Zod, off public
// routes and the lazy chunks they load.
//
// Measure with a production build: `node node_modules/next/dist/bin/next analyze -o` in
// apps/nextblock, then `next analyze export --route /` (docs/05 "Public Page Performance
// Budget").

const {
  createResolver,
  scanRepository,
}: {
  createResolver: () => (fromFile: string, spec: string) => string | null;
  scanRepository: () => Map<string, { directive: string | null; imports: string[] }>;
} = require('./lib/service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const BARRELS = new Set(['@nextblock-cms/ecommerce', '@nextblock-cms/ecommerce/server']);
const LAZY_CLIENTS = 'apps/nextblock/components/commerce/LazyCommerceClients.tsx';

const modules = scanRepository();
const resolveImport = createResolver();
const repoPath = (absolute: string) => path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
const byRepoPath = new Map([...modules.keys()].map((absolute) => [repoPath(absolute), absolute]));

/**
 * Route files a visitor or an editor loads without opening a commerce CMS screen: every
 * route outside /cms and /api, the CMS layout (shared by every /cms route), and the two
 * block editors. The commerce CMS screens themselves may still use the barrels.
 */
const ROUTE_FILE_RE = /(?:^|\/)(?:page|layout|template|loading|error|not-found|global-error|default)\.[jt]sx?$/;
const CMS_ENTRIES = new Set([
  'apps/nextblock/app/cms/layout.tsx',
  'apps/nextblock/app/cms/pages/[id]/edit/page.tsx',
  'apps/nextblock/app/cms/posts/[id]/edit/page.tsx',
]);
const entryFiles = [...byRepoPath.keys()].filter(
  (file) =>
    CMS_ENTRIES.has(file) ||
    (file.startsWith('apps/nextblock/app/') &&
      !/^apps\/nextblock\/app\/(?:cms|api)\//.test(file) &&
      ROUTE_FILE_RE.test(file))
);

/** Breadth-first walk over runtime imports (static and dynamic; type-only imports are dropped). */
function walk(
  starts: string[],
  { stopAt = () => false }: { stopAt?: (file: string) => boolean } = {}
) {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const start of starts) {
    const absolute = byRepoPath.get(start);
    if (!absolute) throw new Error(`commerce-chunking: entry ${start} was not scanned`);
    parent.set(absolute, null);
    queue.push(absolute);
  }
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (stopAt(current)) continue;
    for (const spec of modules.get(current)?.imports ?? []) {
      const target = resolveImport(current, spec);
      if (target && modules.has(target) && !parent.has(target)) {
        parent.set(target, current);
        queue.push(target);
      }
    }
  }
  const chainTo = (absolute: string) => {
    const chain: string[] = [];
    for (let node: string | null | undefined = absolute; node; node = parent.get(node)) chain.push(repoPath(node));
    return chain.reverse().join(' -> ');
  };
  return { visited: [...parent.keys()], chainTo };
}

describe('commerce client code stays off routes that do not render it', () => {
  it('finds the public routes and the CMS entries', () => {
    expect(entryFiles).toEqual(expect.arrayContaining(['apps/nextblock/app/layout.tsx', 'apps/nextblock/app/page.tsx']));
    expect(entryFiles).toEqual(expect.arrayContaining([...CMS_ENTRIES]));
    expect(entryFiles.some((file) => file.startsWith('apps/nextblock/app/api/'))).toBe(false);
  });

  it('reaches no ecommerce barrel from a public route, the CMS layout or a block editor', () => {
    const { visited, chainTo } = walk(entryFiles);
    const offenders = visited.flatMap((absolute) =>
      (modules.get(absolute)?.imports ?? [])
        .filter((spec) => BARRELS.has(spec))
        .map((spec) => `${spec} in ${chainTo(absolute)}`)
    );
    // Import the module that defines the name instead, e.g.
    // '@nextblock-cms/ecommerce/product-actions' or '@nextblock-cms/ecommerce/components/Cart'
    // (`import type` from a barrel is fine: it is erased before bundling).
    expect(offenders).toEqual([]);
  });

  it('draws the commerce block renderers\' client components through LazyCommerceClients', () => {
    // Server modules only: a 'use client' module is where the route's client graph starts.
    // BlockRenderer is the generic renderer the product description recurses into; its own
    // renderers are not commerce code.
    const blockRenderer = byRepoPath.get('apps/nextblock/components/BlockRenderer.tsx');
    const { visited, chainTo } = walk(['apps/nextblock/components/blocks/ecommerceRendererLoaders.ts'], {
      stopAt: (absolute) => absolute === blockRenderer || modules.get(absolute)?.directive === 'use client',
    });
    const allowed = new Set([
      LAZY_CLIENTS,
      // A context provider of a few hundred bytes; every commerce renderer mounts it.
      'libs/ecommerce/src/lib/PaymentReadinessProvider.tsx',
    ]);
    // Commerce and app client modules only. The ui/utils client modules a renderer reaches
    // (the translations context, primitives) already ship with the root layout on every page.
    const isCommerceOrAppClient = (file: string) => /^(?:libs\/ecommerce|apps\/nextblock)\//.test(file);
    const direct = visited
      .filter((absolute) => modules.get(absolute)?.directive === 'use client')
      .filter((absolute) => isCommerceOrAppClient(repoPath(absolute)) && !allowed.has(repoPath(absolute)))
      .map(chainTo);
    expect(direct).toEqual([]);
  });

  it('keeps LazyCommerceClients to next/dynamic and import()s of app modules', () => {
    const source = readFileSync(path.join(REPO_ROOT, LAZY_CLIENTS), 'utf8');
    const file = ts.createSourceFile(LAZY_CLIENTS, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const staticImports = file.statements
      .filter(ts.isImportDeclaration)
      .filter((statement) => !statement.importClause?.isTypeOnly)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    // A static import here would put that component back into every route's entry chunks.
    expect(staticImports).toEqual(['next/dynamic']);
    expect(modules.get(byRepoPath.get(LAZY_CLIENTS) ?? '')?.directive).toBe('use client');

    const dynamicImports: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments;
        dynamicImports.push(specifier && ts.isStringLiteralLike(specifier) ? specifier.text : '<not a string literal>');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(dynamicImports.length).toBeGreaterThan(0);
    // `import('@nextblock-cms/…')` makes Nx flag every static import of that library in the
    // app; re-export the component from a module in components/commerce/lazy and import that.
    expect(dynamicImports.filter((specifier) => !specifier.startsWith('.'))).toEqual([]);
  });
});
