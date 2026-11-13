import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Structure guards for @nextblock-cms/affiliates (SPEC §3, ADDENDUM C4 + C8). Static: every
 * source file is parsed with the TypeScript compiler, so comments and strings never count as code.
 *
 * - C8: `'use client'` (and `'use server'`) is the literal first line of its file. The build's
 *   `reapplyDirectives` only sees a directive at the very start, so one below a comment is
 *   silently stripped from dist and the module becomes a Server Component in every scaffold.
 * - C4: the barrels use `export *`, so two declarations of one exported name anywhere in the
 *   lib are a TS2308 ambiguity; and nothing re-declares a `core/constants.ts` name.
 * - SPEC §3: the client-safe root entry never reaches `server-only`, `ai`, Tiptap, service-role
 *   or Node code; the editor entry never reaches server code; no module imports `next/*`.
 */

const LIB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS_FILE = path.join(LIB_SRC, 'lib', 'core', 'constants.ts');
const TEST_FILE = /\.(test|spec)\.tsx?$/;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

const ALL_FILES = walk(LIB_SRC).sort();
const SOURCE_FILES = ALL_FILES.filter((file) => !TEST_FILE.test(file));
const rel = (file: string) => path.relative(LIB_SRC, file).split(path.sep).join('/');

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    const text = readFileSync(file, 'utf8');
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(file, source);
  }
  return source;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Names a top-level statement declares, and whether it exports them. */
function declaredNames(statement: ts.Statement): { names: string[]; exported: boolean } {
  const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
    return { names, exported };
  }

  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return { names: [statement.name.text], exported };
  }

  return { names: [], exported: false };
}

/** Value (non-type) module specifiers a file imports or re-exports, including `import()`. */
function valueSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every bare specifier reachable from `entry` through value imports, with the first importer. */
function reachableBareImports(entry: string): Map<string, string> {
  const bare = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of valueSpecifiers(parse(file))) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target) queue.push(target);
      } else if (!bare.has(specifier)) {
        bare.set(specifier, rel(file));
      }
    }
  }

  return bare;
}

/**
 * Top-level statements a bundler must run even when nothing uses the module's exports: a bare
 * import (`import 'server-only'`), an expression that is not a directive (`z.config(...)`), or
 * control flow. Declarations, imports with bindings and re-exports are not side effects. A call
 * hidden in a `const` initializer is not detected (keep registrations out of initializers).
 */
function topLevelSideEffects(source: ts.SourceFile): string[] {
  const effects: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause) effects.push(statement.getText(source));
    } else if (ts.isExpressionStatement(statement)) {
      // A string-literal statement is a directive ('use client') or a no-op.
      if (!ts.isStringLiteral(statement.expression)) effects.push(statement.getText(source).slice(0, 80));
    } else if (
      ts.isIfStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isTryStatement(statement) ||
      ts.isSwitchStatement(statement) ||
      ts.isThrowStatement(statement) ||
      ts.isLabeledStatement(statement) ||
      ts.isBlock(statement)
    ) {
      effects.push(ts.SyntaxKind[statement.kind]);
    }
  }
  return effects;
}

const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'net', 'tls', 'http', 'https', 'zlib', 'stream', 'worker_threads']);

/** Server or Node code no client graph (root or editor entry) may reach. */
function isServerSpecifier(specifier: string): boolean {
  return (
    specifier === 'server-only' ||
    specifier === 'ai' ||
    specifier.startsWith('@ai-sdk/') ||
    specifier === 'stripe' ||
    specifier.startsWith('node:') ||
    NODE_BUILTINS.has(specifier) ||
    /^@nextblock-cms\/[^/]+\/(server|secrets)$/.test(specifier) ||
    // The cortex root entry is its server runtime (SERVER_ENTRIES in service-role-boundary.js).
    specifier === '@nextblock-cms/cortex'
  );
}

describe("client directives (C8: 'use client' on line 1)", () => {
  it('puts every directive on the first line of its file', () => {
    const misplaced: string[] = [];

    for (const file of ALL_FILES) {
      const source = parse(file);
      for (const statement of source.statements) {
        if (
          ts.isExpressionStatement(statement) &&
          ts.isStringLiteral(statement.expression) &&
          (statement.expression.text === 'use client' || statement.expression.text === 'use server')
        ) {
          const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
          if (line !== 0 || source.text.charCodeAt(0) === 0xfeff) {
            misplaced.push(`${rel(file)}:${line + 1} '${statement.expression.text}'`);
          }
        }
      }
    }

    expect(misplaced, "move the directive to line 1 (no comment, blank line or BOM above it)").toEqual([]);
  });

  it('is exactly what the build re-applies (the first non-whitespace text of the file)', () => {
    const unseen: string[] = [];
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, 'utf8');
      const hasDirective = parse(file).statements.some(
        (statement) =>
          ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client'
      );
      if (hasDirective && !/^['"]use client['"]/.test(text.replace(/^\uFEFF/, '').trimStart())) unseen.push(rel(file));
    }
    expect(unseen).toEqual([]);
  });
});

describe('exported names (C4: no TS2308 through export *)', () => {
  it('declares every exported name in exactly one module', () => {
    const owners = new Map<string, string[]>();

    for (const file of SOURCE_FILES) {
      for (const statement of parse(file).statements) {
        const { names, exported } = declaredNames(statement);
        if (!exported) continue;
        for (const name of names) owners.set(name, [...(owners.get(name) ?? []), rel(file)]);
      }
    }

    const duplicates = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`);

    expect(duplicates, 'prefix the name (Affiliate…, Storefront…, RetailerCopilot…) or import the existing one').toEqual([]);
  });

  it('never re-declares a core/constants.ts name, exported or not', () => {
    const constants = new Set<string>();
    for (const statement of parse(CONSTANTS_FILE).statements) {
      const { names, exported } = declaredNames(statement);
      if (exported) names.forEach((name) => constants.add(name));
    }
    expect(constants.has('AFFILIATE_ALERT_TYPES')).toBe(true);
    expect(constants.has('RETAILER_COPILOT_TOOL_NAMES')).toBe(true);

    const redeclared: string[] = [];
    for (const file of ALL_FILES) {
      if (file === CONSTANTS_FILE) continue;
      for (const statement of parse(file).statements) {
        for (const name of declaredNames(statement).names) {
          if (constants.has(name)) redeclared.push(`${rel(file)}: ${name}`);
        }
      }
    }

    expect(redeclared, "import it from '../core/constants' instead").toEqual([]);
  });

  it('never hard-codes the cookie, cache-tag or settings-key strings outside core/constants.ts', async () => {
    const constants = await import('./core/constants');
    const values = new Set<string>([
      constants.AFFILIATE_REF_COOKIE,
      constants.AFFILIATE_STOREFRONT_CACHE_TAG,
      constants.AFFILIATE_TIERS_CACHE_TAG,
      constants.AFFILIATE_SETTINGS_KEY,
    ]);
    const copies: string[] = [];

    for (const file of SOURCE_FILES) {
      if (file === CONSTANTS_FILE) continue;
      const source = parse(file);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) && values.has(node.text)) copies.push(`${rel(file)}: '${node.text}'`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(copies).toEqual([]);
  });
});

describe('entry graphs (SPEC §3)', () => {
  it('keeps the client-safe root entry free of server-only, ai, Tiptap, service-role and Node code', () => {
    const offenders = [...reachableBareImports(path.join(LIB_SRC, 'index.ts'))]
      .filter(([specifier]) => isServerSpecifier(specifier) || specifier.startsWith('@tiptap/'))
      .map(([specifier, importer]) => `${specifier} (imported by ${importer})`);

    expect(offenders).toEqual([]);
  });

  it('keeps the editor entry free of server code', () => {
    const offenders = [...reachableBareImports(path.join(LIB_SRC, 'editor.ts'))]
      .filter(([specifier]) => isServerSpecifier(specifier))
      .map(([specifier, importer]) => `${specifier} (imported by ${importer})`);

    expect(offenders).toEqual([]);
  });

  it("starts the server entry with import 'server-only'", () => {
    const [first] = parse(path.join(LIB_SRC, 'server.ts')).statements;
    expect(first && ts.isImportDeclaration(first) && ts.isStringLiteral(first.moduleSpecifier) ? first.moduleSpecifier.text : null).toBe(
      'server-only'
    );
  });

  it('never imports next or next/* (the lib stays framework-agnostic)', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const specifier of valueSpecifiers(parse(file))) {
        if (specifier === 'next' || specifier.startsWith('next/')) offenders.push(`${rel(file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes every area through its own index.ts, reachable from an entry', () => {
    const areaDir = path.join(LIB_SRC, 'lib');
    const areas = readdirSync(areaDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const reachable = new Set<string>();
    for (const entry of ['index.ts', 'editor.ts', 'server.ts']) {
      const queue = [path.join(LIB_SRC, entry)];
      while (queue.length > 0) {
        const file = queue.shift() as string;
        if (reachable.has(file)) continue;
        reachable.add(file);
        for (const statement of parse(file).statements) {
          if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = resolveRelative(file, statement.moduleSpecifier.text);
            if (target && path.basename(target).startsWith('index.')) queue.push(target);
          }
        }
      }
    }

    for (const area of areas) {
      const index = path.join(areaDir, area, 'index.ts');
      expect(existsSync(index), `src/lib/${area}/index.ts`).toBe(true);
      expect(reachable.has(index), `src/lib/${area} is not exported from src/index.ts, src/editor.ts or src/server.ts`).toBe(true);
    }
  });
});

describe('module side effects (bundle weight)', () => {
  // package.json "sideEffects" lets a bundler drop every module a client island does not use:
  // without it, /partners shipped StorefrontRenderer and the sanitizer because its islands
  // import one helper from the root entry. Only the modules below must always run: the server
  // entry (its `import 'server-only'` guard) and zod-config (`z.config({ jitless: true })`).
  // Each is listed as source (the monorepo compiles src/ through tsconfig paths) and as both
  // dist builds (`<module>.es.js`, `<module>.cjs`, see vite.config.mts) for npm consumers.
  const manifest = JSON.parse(readFileSync(path.resolve(LIB_SRC, '..', 'package.json'), 'utf8')) as { sideEffects?: unknown };
  const sideEffectModules = SOURCE_FILES.filter((file) => topLevelSideEffects(parse(file)).length > 0).map(rel);

  it('finds the server-only guard and the jitless zod config', () => {
    expect(sideEffectModules).toContain('server.ts');
    expect(sideEffectModules).toContain('lib/zod-config.ts');
  });

  it('lists exactly the side-effect modules in package.json "sideEffects", in source and dist form', () => {
    expect(Array.isArray(manifest.sideEffects), 'package.json needs a "sideEffects" array').toBe(true);

    const expected = sideEffectModules.flatMap((module) => {
      const base = module.replace(/\.tsx?$/, '');
      return [`./src/${module}`, `./${base}.es.js`, `./${base}.cjs`];
    });

    expect(
      [...(manifest.sideEffects as string[])].sort(),
      'add (or remove) the module in src and dist form; a module missing here loses its side effect in client bundles'
    ).toEqual(expected.sort());
  });
});

describe('both barrels at runtime (C4)', () => {
  const SHARED = [
    'AFFILIATES_PACKAGE_ID',
    'AFFILIATE_RETAILER_ROLE',
    'AFFILIATE_REF_COOKIE',
    'AFFILIATE_ALERT_TYPES',
    'RETAILER_COPILOT_TOOL_NAMES',
    'AFFILIATE_HANDLE_PATTERN',
    'normalizeAffiliateHandle',
    'computeAffiliateCommissionMinor',
    'createAffiliatesCopy',
    'AFFILIATES_COMMON_COPY',
    'AffiliatesCopyProvider',
    'useAffiliatesCopy',
    'STOREFRONT_BLOCK_NODE_TYPES',
  ];

  // Importing the server entry loads the whole server graph: under a full parallel run that can
  // outlast the default 5 s, as the heavy tests in i18n/translations-migration.test.ts do.
  it('exports the same bindings from the root entry and the server entry', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    const server = (await import('../server')) as Record<string, unknown>;

    for (const name of SHARED) {
      expect(root[name], `root entry: ${name}`).toBeDefined();
      expect(server[name], `server entry: ${name}`).toBe(root[name]);
    }
  }, 30_000);

  it('keeps server-only functions out of the root entry', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    const server = (await import('../server')) as Record<string, unknown>;

    for (const name of ['getAffiliateProfileByUserId', 'createAffiliateAccountViaRpc', 'getAffiliateBalances', 'mapAffiliateRpcError']) {
      expect(server[name], `server entry: ${name}`).toBeTypeOf('function');
      expect(root[name], `root entry must not export ${name}`).toBeUndefined();
    }
  }, 30_000);
});
