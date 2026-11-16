import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every import() and require() in code a bundler compiles names one module, as a plain string.
//
// A bundler cannot tell which file `import(`../editors/${name}`)` loads, so Turbopack (like
// webpack and Vite) turns it into a context: every file under ../editors/ that could match goes
// into the build, tests and fixtures included. The CMS loaded block editors that way
// (EditableBlock.tsx, ColumnEditor.tsx) until 0.23.4, and 0.23.0 added
// app/cms/blocks/editors/SectionBlockEditor.test.tsx, which imports vitest. From 0.23.0 to 0.23.3
// every standalone project (vitest is not among its dependencies) failed `next build` with
// "Can't resolve 'vitest'": new CLI projects, their Docker images, and projects that ran
// `npm run update`. The monorepo built only because vitest is a root devDependency, and shipped
// vitest and chai as CMS chunks nothing loads.
//
// So a module chosen at runtime goes in a loader map, one string-literal import() per file
// (app/cms/blocks/components/blockEditorLoaders.ts, components/blocks/publicRendererLoaders.ts).
// require.context and import.meta.glob sweep a folder by design and are refused too.
//
// Casts hide nothing: SWC (Next) and Oxc (the Vite lib builds) erase `as`, `satisfies`, `!`, `<T>`
// and type arguments (`f<T>`), and parentheses change nothing, so `(require as any).context(...)`
// sweeps the folder like `require.context(...)`. That cast is the likely spelling of
// require.context: the app has no webpack-env types, so a bare require.context fails to
// type-check. import.meta.glob is typed by Next and supported by Turbopack, so its bare call
// (refused) is the likely spelling there. A sweep read but not called is refused where it is
// read: stored (`const ctx = require.context`, `const glob = import.meta.glob`), destructured
// (`const { glob } = import.meta`) or called indirectly (`require.context.call(...)`);
// `typeof require.context` stays fine. import.meta used as a whole value is refused too (`const
// meta = import.meta`, `f(import.meta)`, `{ ...import.meta }`, `import.meta[key]`, a rest element
// that collects it): it hides any sweep read through it. Its other members stay fine, read or
// destructured (`import.meta.url`, `const { env } = import.meta`). require under another name
// (`const r = require`, `register(require)`, `require.bind(null)`) is refused because nothing then
// says which module loads; `typeof require`, `require.resolve('x')` and `require.cache` stay fine.
// A local binding named require (a parameter, a variable, a function, a class, an import) is not
// Node's require and may be passed on, except in a parameter's decorator, which runs outside the
// parameters' scope (`constructor(@Inject(require) require: Loader)` passes Node's); an ambient
// `declare const require` or a type-only import still names Node's, and a call through either
// takes a plain string. module.require() and `new URL(..., import.meta.url)` (the asset and worker
// form) take a plain string too. The check reads no magic comments:
// `import(/* webpackIgnore: true */ name)` is refused like any other.
//
// Scope: apps/nextblock minus what no bundler compiles (tools/, scripts/, public/, tests,
// __tests__, __fixtures__, __mocks__) and libs/*/src minus tests. Each module is parsed with the
// TypeScript compiler, so comments, strings and type positions (`typeof import('x')`) are not
// calls.

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = 'apps/nextblock';
/** Directories under apps/nextblock that no bundler compiles: Node scripts, the build hook, static files. */
const APP_EXCLUDED_DIRS = new Set(['apps/nextblock/tools', 'apps/nextblock/scripts', 'apps/nextblock/public']);
const TEST_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__']);
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The scan parses over a thousand modules (two generated ones are 2.7 MB each): seconds under a full parallel run. */
const SCAN_TIMEOUT_MS = 60_000;

/**
 * Modules allowed a computed specifier, with why. Only a module that no bundler compiles but the
 * scan cannot tell apart (Node-only code) belongs here. Empty since 0.23.4.
 */
const ALLOWED_COMPUTED_SPECIFIERS = new Map<string, string>();

/** `import.meta.*` calls that sweep a folder: Vite's globs and webpack's context. */
const IMPORT_META_SWEEPS = new Set(['glob', 'globEager', 'webpackContext']);

/** Function members that call or copy require under another name: `require.call(null, name)`, `require.bind(null)`. */
const REQUIRE_INDIRECTIONS = new Set(['apply', 'bind', 'call']);

const REQUIRE_AS_VALUE =
  'require used as a value (stored, passed on, returned or called indirectly), so the bundler cannot tell which modules it loads: it bundles every file it could reach, tests and fixtures included, or the load fails at runtime';

/** Why a folder sweep read but not called is refused: `const ctx = require.context`, `const { glob } = import.meta`. */
const sweepAsValue = (sweep: string) =>
  `${sweep} read but not called (stored, destructured, passed on or called indirectly), so the bundler cannot tell which folder it sweeps: it bundles every file it could reach, tests and fixtures included, or the call fails at runtime`;

const IMPORT_META_AS_VALUE =
  'import.meta used as a whole value (stored, passed on, spread into another object or read by a computed key), so the bundler cannot tell which members are read: a folder sweep (import.meta.glob, import.meta.webpackContext) read through it bundles every file it could reach, tests and fixtures included, or fails at runtime; read the member itself (import.meta.url, import.meta.env)';

const FIX_HINT = [
  'A computed import()/require() specifier makes the bundler bundle every file it could name.',
  'From 0.23.0 to 0.23.3 import(`../editors/${filename}`) put app/cms/blocks/editors/SectionBlockEditor.test.tsx',
  "(which imports vitest) into the CMS, and every standalone `next build` failed with \"Can't resolve 'vitest'\".",
  'Give each module its own string-literal import() in a loader map (app/cms/blocks/components/blockEditorLoaders.ts);',
  'a cast, another name for require or import.meta, or a stored or destructured require.context or import.meta.glob',
  'hides nothing from the bundler; a module no bundler compiles goes in ALLOWED_COMPUTED_SPECIFIERS with why.',
].join(' ');

type Finding = { line: number; code: string; why: string };

function scriptKindFor(fileName: string) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  return fileName.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS; // .js / .mjs / .cjs may hold JSX too
}

const snippet = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
};

const isImportMeta = (node: ts.Node): node is ts.MetaProperty =>
  ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';

const isIdentifierNamed = (node: ts.Node, name: string) => ts.isIdentifier(node) && node.text === name;

/**
 * Wrappers that change nothing at runtime: parentheses, the `as`, `satisfies`, `!` and `<T>` that
 * SWC and Oxc erase, and type arguments (`(import.meta.glob<Mod>)(...)`, erased the same way).
 */
type TransparentWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion
  | ts.ExpressionWithTypeArguments;

const isTransparentWrapper = (node: ts.Node): node is TransparentWrapper =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node) ||
  ts.isExpressionWithTypeArguments(node);

/** What the bundler reads: `((require satisfies object) as any)!` is `require`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
}

/** The outermost wrapper around a node, or the node: its parent is where the bundler sees the value used. */
function outermostWrapper(node: ts.Expression): ts.Expression {
  let current = node;
  while (isTransparentWrapper(current.parent) && current.parent.expression === current) current = current.parent;
  return current;
}

/** The member a `.name` or `['name']` access reads; null for a computed key or any other node. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

const isMemberAccess = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** `import.meta.url`, wrapped or not. */
function isImportMetaUrl(node: ts.Expression) {
  const access = unwrap(node);
  return isMemberAccess(access) && memberName(access) === 'url' && isImportMeta(unwrap(access.expression));
}

/** Whether an identifier reads a variable, rather than naming a declaration, a property, a label or a type. */
function readsVariable(id: ts.Identifier) {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return true; // `{ require }` reads require too
  if (ts.isQualifiedName(parent)) return false; // `typeof require.resolve` in a type
  // `const require = createRequire(...)`, `{ require: fn }`, `loader.require`, `<X require />`, `{ require: r } = x`, labels
  if (
    ('name' in parent && parent.name === id) ||
    ('propertyName' in parent && parent.propertyName === id) ||
    ('label' in parent && parent.label === id)
  ) {
    return false;
  }
  for (let node: ts.Node = parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return false; // `let r: typeof require`
  }
  return true;
}

/** Whether a value is called (through the wrappers the compiler erases) or only tested with typeof. */
function isCalledOrTested(node: ts.Expression) {
  const outer = outermostWrapper(node);
  return (ts.isCallExpression(outer.parent) && outer.parent.expression === outer) || ts.isTypeOfExpression(outer.parent);
}

/** Whether a declared name binds `require`, destructuring included: `({ require }) => ...`. */
const bindsRequire = (name: ts.BindingName): boolean =>
  ts.isIdentifier(name)
    ? name.text === 'require'
    : name.elements.some((element) => !ts.isOmittedExpression(element) && bindsRequire(element.name));

/** `declare const require: NodeRequire` describes the global; it binds nothing. */
const isAmbient = (statement: ts.Statement) =>
  ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);

/** Whether one of these statements declares a value named require: var/let/const, function, class or an import (type-only ones bind no value). */
function statementsBindRequire(statements: readonly ts.Statement[]) {
  return statements.some((statement) => {
    if (isAmbient(statement)) return false;
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) => bindsRequire(declaration.name));
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text === 'require';
    if (ts.isImportEqualsDeclaration(statement)) return !statement.isTypeOnly && statement.name.text === 'require';
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) return false;
    const { name, namedBindings } = statement.importClause;
    if (name?.text === 'require') return true;
    if (!namedBindings) return false;
    if (ts.isNamespaceImport(namedBindings)) return namedBindings.name.text === 'require';
    return namedBindings.elements.some((element) => !element.isTypeOnly && element.name.text === 'require');
  });
}

/**
 * Whether this `require` reads a binding the module declares (a parameter, a catch or loop
 * variable, a local variable, function, class or import), which bundlers resolve as that
 * binding, not as Node's require.
 */
function isLocalRequire(id: ts.Identifier) {
  for (let prev: ts.Node | undefined, child: ts.Node = id, node = id.parent; !ts.isSourceFile(node); prev = child, child = node, node = node.parent) {
    // Parameters are in scope in the parameter list and the body, not in a computed name or a
    // decorator, a parameter's own included: `m(@dec(require) require: Loader)` passes Node's
    // require to dec, which runs in the class's scope. `prev` tells a parameter's decorator from
    // its name, type and default.
    const inScopeOfParameters = ('body' in node && node.body === child) || (ts.isParameter(child) && !(prev && ts.isDecorator(prev)));
    if (ts.isFunctionLike(node) && inScopeOfParameters && node.parameters.some((parameter) => bindsRequire(parameter.name))) return true;
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name?.text === 'require') return true; // `function require() { ... }`
    if ((ts.isBlock(node) || ts.isModuleBlock(node)) && statementsBindRequire(node.statements)) return true;
    if (ts.isCatchClause(node) && node.variableDeclaration && bindsRequire(node.variableDeclaration.name)) return true;
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.some((declaration) => bindsRequire(declaration.name))
    ) {
      return true;
    }
  }
  return statementsBindRequire(id.getSourceFile().statements);
}

/**
 * Where code passes `require` on instead of calling it, reading a member by name or testing it with
 * typeof, or reads require.context without calling it: the node to report and why, or null.
 */
function requireAsValue(id: ts.Identifier): { node: ts.Node; why: string } | null {
  const outer = outermostWrapper(id);
  const use = outer.parent;
  if (ts.isCallExpression(use) && use.expression === outer) return null; // require(...), checked as a call
  if (ts.isTypeOfExpression(use)) return null;
  if (isMemberAccess(use) && use.expression === outer) {
    // require.resolve() and require.context() are checked as calls; require.cache and require.main load nothing.
    const member = memberName(use);
    if (member === null || REQUIRE_INDIRECTIONS.has(member)) return { node: use, why: REQUIRE_AS_VALUE };
    // `const ctx = require.context`, `(0, require.context)(...)`, `require.context.call(...)`.
    return member === 'context' && !isCalledOrTested(use) ? { node: use, why: sweepAsValue('require.context') } : null;
  }
  return { node: ts.isShorthandPropertyAssignment(use) ? use.parent : use, why: REQUIRE_AS_VALUE };
}

/** The member a destructuring key names (`glob` in `{ glob }`, `{ glob: g }`, `{ 'glob': g }`, `{ ['glob']: g }`); null for any other computed key. */
function keyName(key: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isComputedPropertyName(key)) {
    const expression = unwrap(key.expression);
    return ts.isStringLiteralLike(expression) ? expression.text : null;
  }
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null;
}

/** The members an object pattern reads, or null when it reads some it does not name (a computed key, a rest element). */
function destructuredMembers(pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression): string[] | null {
  const members: string[] = [];
  for (const element of ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties) {
    let key: ts.PropertyName | ts.BindingName | undefined;
    if (ts.isBindingElement(element)) key = element.dotDotDotToken ? undefined : (element.propertyName ?? element.name);
    else if (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) key = element.name;
    const member = key === undefined ? null : keyName(key);
    if (member === null) return null;
    members.push(member);
  }
  return members;
}

/** The object pattern a value is destructured into (`const { a } = value`, a parameter's or binding element's default, `({ a } = value)`), or null. */
function destructuringOf(value: ts.Expression): ts.ObjectBindingPattern | ts.ObjectLiteralExpression | null {
  const use = value.parent;
  if ((ts.isVariableDeclaration(use) || ts.isParameter(use) || ts.isBindingElement(use)) && use.initializer === value) {
    return ts.isObjectBindingPattern(use.name) ? use.name : null;
  }
  if (ts.isBinaryExpression(use) && use.operatorToken.kind === ts.SyntaxKind.EqualsToken && use.right === value) {
    return ts.isObjectLiteralExpression(use.left) ? use.left : null;
  }
  return null;
}

/**
 * Where code reads a folder sweep from import.meta without calling it (stored, destructured,
 * passed on) or uses import.meta as a whole value, which hides any sweep read through it: the node
 * to report and why, or null. Its other members, read or destructured, load nothing.
 */
function importMetaAsValue(meta: ts.MetaProperty): { node: ts.Node; why: string } | null {
  const outer = outermostWrapper(meta);
  const use = outer.parent;
  if (ts.isTypeOfExpression(use)) return null; // `typeof import.meta` loads nothing
  if (isMemberAccess(use) && use.expression === outer) {
    const member = memberName(use);
    if (member === null) return { node: use, why: IMPORT_META_AS_VALUE }; // import.meta[key]
    // import.meta.glob(...) is checked as a call, and `typeof import.meta.glob` loads nothing.
    return IMPORT_META_SWEEPS.has(member) && !isCalledOrTested(use) ? { node: use, why: sweepAsValue(`import.meta.${member}`) } : null;
  }
  // `const { glob } = import.meta`, `({ glob: g } = import.meta)`: a sweep destructured is a sweep stored.
  const pattern = destructuringOf(outer);
  const members = pattern && destructuredMembers(pattern);
  if (!members) return { node: use, why: IMPORT_META_AS_VALUE }; // stored, passed on, spread, or destructured by a computed key or a rest element
  const sweep = members.find((member) => IMPORT_META_SWEEPS.has(member));
  return sweep === undefined ? null : { node: use, why: sweepAsValue(`import.meta.${sweep}`) };
}

/** Why a specifier is not a plain string, or null when it is one; `('./w.ts')` and `'./w.ts' as string` are one. */
function specifierProblem(wrapped: ts.Expression | undefined): string | null {
  if (!wrapped) return 'no specifier';
  const specifier = unwrap(wrapped);
  if (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) return null;
  if (ts.isTemplateExpression(specifier)) {
    const head = specifier.head.text;
    const folder = head.includes('/') ? head.slice(0, head.lastIndexOf('/') + 1) : './';
    return `a template literal with a substitution, so the bundler bundles every file under ${folder} it could match, tests and fixtures included`;
  }
  const kind =
    ts.isBinaryExpression(specifier) && specifier.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? 'a string concatenation'
      : ts.isIdentifier(specifier)
        ? `a variable (${specifier.text})`
        : 'a computed expression';
  return `${kind}, so the bundler cannot tell which module it names: it bundles every file the expression could match, tests and fixtures included, or the load fails at runtime`;
}

/** The import(), require(), module.require() and new URL(..., import.meta.url) calls with a computed specifier, the folder sweeps (called or not), and require or import.meta used as a value, in one module. */
function computedSpecifiers(fileName: string, source: string): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const findings: Finding[] = [];
  const report = (node: ts.Node, why: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ line: line + 1, code: snippet(node.getText(file)), why });
  };
  const checkSpecifier = (call: ts.CallExpression) => {
    const problem = specifierProblem(call.arguments[0]);
    if (problem) report(call, problem);
  };
  // A function made by createRequire(...) (`const r = createRequire(import.meta.url)`, assigned later,
  // or called at once): webpack parses a call through it as require, and Turbopack may, so its specifier
  // is checked the same way (review 2026-11-15). createRequire is found under any local name it is
  // imported or destructured as, and bindings are traced by name within the module, which errs toward
  // checking more calls.
  const createRequireNames = new Set(['createRequire']);
  const collectCreateRequireNames = (node: ts.Node) => {
    // import { createRequire as makeRequire } from 'node:module' (or 'module')
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?module$/.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'createRequire') createRequireNames.add(element.name.text);
        }
      }
    }
    // const { createRequire: makeRequire } = require('node:module'), or from await import(...)
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const imported = node.propertyName ? (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName) ? node.propertyName.text : null) : node.name.text;
      if (imported === 'createRequire') createRequireNames.add(node.name.text);
    }
    ts.forEachChild(node, collectCreateRequireNames);
  };
  collectCreateRequireNames(file);
  const isCreateRequireCall = (expression: ts.Expression): boolean => {
    const call = unwrap(expression);
    if (!ts.isCallExpression(call)) return false;
    const callee = unwrap(call.expression);
    return (
      (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) ||
      (isMemberAccess(callee) && memberName(callee) === 'createRequire')
    );
  };
  const createdRequires = new Set<string>();
  const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  /** createRequire itself: a name it is bound to, or `<x>.createRequire`. */
  const isCreateRequireValue = (expression: ts.Expression) => {
    const value = unwrap(expression);
    return (ts.isIdentifier(value) && createRequireNames.has(value.text)) || (isMemberAccess(value) && memberName(value) === 'createRequire');
  };
  /**
   * A function createRequire made: a call to createRequire, a name one is bound to, or an expression
   * that can evaluate to one (`req || createRequire(...)`, `req ?? ...`, `cond ? req : other`).
   */
  const isCreatedRequireValue = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    if (
      ts.isBinaryExpression(value) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(value.operatorToken.kind)
    ) {
      return isCreatedRequireValue(value.left) || isCreatedRequireValue(value.right);
    }
    if (ts.isConditionalExpression(value)) return isCreatedRequireValue(value.whenTrue) || isCreatedRequireValue(value.whenFalse);
    return isCreateRequireCall(value) || (ts.isIdentifier(value) && createdRequires.has(value.text));
  };
  // Bindings and assignments (`=`, `??=`, `||=`, `&&=`, as a lazy loader writes them), followed to a
  // fixed point so an alias of an alias counts: `const load = r`, `const make = createRequire`,
  // `nodeRequire ??= createRequire(import.meta.url)` (the second review of 2026-11-15).
  const collectAliases = (node: ts.Node) => {
    let name: string | null = null;
    let value: ts.Expression | undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      name = node.name.text;
      value = node.initializer;
    } else if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
      name = node.left.text;
      value = node.right;
    }
    if (name && value) {
      if (isCreatedRequireValue(value)) createdRequires.add(name);
      if (isCreateRequireValue(value)) createRequireNames.add(name);
    }
    ts.forEachChild(node, collectAliases);
  };
  // The sets only grow, so this ends: at most one pass per binding name.
  for (;;) {
    const before = createdRequires.size + createRequireNames.size;
    collectAliases(file);
    if (createdRequires.size + createRequireNames.size === before) break;
  }
  const isCreatedRequire = (node: ts.Expression) =>
    isCreateRequireCall(node) || (ts.isIdentifier(node) && createdRequires.has(node.text));
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isIdentifierNamed(callee, 'require') || isCreatedRequire(callee)) {
        checkSpecifier(node);
      } else if (isMemberAccess(callee)) {
        const member = memberName(callee);
        const base = unwrap(callee.expression);
        if (isIdentifierNamed(base, 'require')) {
          if (member === 'context') report(node, 'require.context bundles every matching file in the folder, tests and fixtures included');
          // require.resolveWeak (webpack) takes a specifier like require.resolve.
          else if (member === 'resolve' || member === 'resolveWeak') checkSpecifier(node);
        } else if (isCreatedRequire(base) && member === 'resolve') {
          checkSpecifier(node);
        } else if (isCreatedRequire(base) && member === 'call') {
          // r.call(thisArg, specifier)
          const problem = specifierProblem(node.arguments[1]);
          if (problem) report(node, problem);
        } else if (isCreatedRequire(base) && member === 'apply') {
          // r.apply(thisArg, [specifier])
          const list = node.arguments[1] && unwrap(node.arguments[1]);
          const problem =
            list && ts.isArrayLiteralExpression(list)
              ? specifierProblem(list.elements[0] as ts.Expression | undefined)
              : 'an argument list the bundler cannot read, so it cannot tell which module it names';
          if (problem) report(node, problem);
        } else if (isIdentifierNamed(base, 'module') && member === 'require') {
          checkSpecifier(node);
        } else if (isImportMeta(base) && member !== null && IMPORT_META_SWEEPS.has(member)) {
          report(node, `import.meta.${member} bundles every matching file, tests and fixtures included`);
        }
      }
    } else if (ts.isNewExpression(node)) {
      // new URL('./worker.ts', import.meta.url), alone or inside new Worker(...): webpack and Turbopack bundle the file it names.
      const [href, base] = node.arguments ?? [];
      if (isIdentifierNamed(unwrap(node.expression), 'URL') && base && isImportMetaUrl(base)) {
        const problem = specifierProblem(href);
        if (problem) report(node, `new URL(..., import.meta.url) bundles the file its first argument names, and that argument is ${problem}`);
      }
    } else if (isImportMeta(node)) {
      // `const glob = import.meta.glob<Mod>`, `const { glob } = import.meta`, `const meta = import.meta`.
      const use = importMetaAsValue(node);
      if (use) report(use.node, use.why);
    } else if (ts.isIdentifier(node) && node.text === 'require' && readsVariable(node) && !isLocalRequire(node)) {
      const use = requireAsValue(node);
      if (use) report(use.node, use.why);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** A .js beside a .ts/.tsx of the same stem is a stale compiled twin (libs/db, libs/utils): resolution is TypeScript-first, so no bundler loads it. */
function isStaleTwin(absolute: string) {
  if (!absolute.endsWith('.js')) return false;
  const stem = absolute.slice(0, -'.js'.length);
  return existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`);
}

function collectSources(dir: string, files: string[]) {
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const repoPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // `.well-known` holds real routes; the other dot directories (.next, caches) are tool output.
      if (entry.name === 'node_modules' || TEST_DIRS.has(entry.name) || APP_EXCLUDED_DIRS.has(repoPath)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
      collectSources(repoPath, files);
    } else if (
      entry.isFile() &&
      SOURCE_FILE_RE.test(entry.name) &&
      !DECLARATION_FILE_RE.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name) &&
      !isStaleTwin(path.join(REPO_ROOT, repoPath))
    ) {
      files.push(repoPath);
    }
  }
}

/** Every module a bundler compiles: the app and each lib's src, repo-relative. */
function bundledSources(): string[] {
  const files: string[] = [];
  collectSources(APP_DIR, files);
  for (const lib of readdirSync(path.join(REPO_ROOT, 'libs'), { withFileTypes: true })) {
    if (lib.isDirectory() && existsSync(path.join(REPO_ROOT, 'libs', lib.name, 'src'))) collectSources(`libs/${lib.name}/src`, files);
  }
  return files.sort();
}

const readSource = (repoPath: string) => readFileSync(path.join(REPO_ROOT, repoPath), 'utf8');

describe('the computed-specifier check', () => {
  it('refuses computed import()/require() specifiers and folder sweeps', () => {
    const source = [
      'const a = lazy(() => import(`../editors/${filename}`));',
      'const b = import(modulePath);',
      "const c = import('../editors/' + name);",
      'const d = require(`./locales/${lang}.json`);',
      'const e = require(name);',
      "const f = require('./locales/' + lang);",
      "const g = import(isEditor ? './a' : './b');",
      'const h = require.resolve(`./plugins/${name}`);',
      "const i = require.context('./editors', true, /\\.tsx$/);",
      "const j = import.meta.glob('./editors/*.tsx');",
      'const k = import(',
      '  `../editors/${filename.replace(/\\.tsx$/, "")}`',
      ');',
      // Casts and parentheses, nested in any order: SWC erases them, so the bundler still sees the call.
      "const l = (require as any).context('../components', true, /\\.tsx$/);",
      "const m = (import.meta as any).glob('../components/*.tsx');",
      "const n = (require as unknown as Ctx).context('../components', true, /\\.tsx$/);",
      "const o = ((require satisfies object) as any)!['context']('./editors', true, /\\.tsx$/);",
      "const p = (import.meta.glob as any)('../components/*.tsx');",
      'const q = (require as NodeRequire)(`./locales/${lang}.json`);',
      // require under another name is refused where the alias is made: the call through it is not traced.
      'const req2 = require;',
      'const r = req2(`../components/${name}`);',
      'register(require);',
      "const s = typeof require === 'function' ? require : null;",
      'const t = { require };',
      "const u = (0, require)('./a');",
      'const v = require.bind(null);',
      'const w = require[key](name);',
      // module.require, and the asset and worker form of new URL.
      'const x = module.require(`../components/${name}`);',
      'const y = new Worker(new URL(`./workers/${name}.ts`, import.meta.url));',
      'const z = new URL(file, (import.meta as any).url);',
      // Type arguments are erased like a cast.
      "const p1 = (import.meta.glob<Mod>)('../components/*.tsx');",
      // A sweep read but not called is refused where it is read.
      'const ctx = (require as any).context;',
      "(0, require.context)('../components', true, /\\.tsx$/);",
      "require.context.call(null, '../components', true, /\\.tsx$/);",
      'const bound = (require as any).context.bind(null);',
      'const glob = import.meta.glob<Mod>;',
      // require passed to a call in a heritage clause, and the new URL callee and base spelled another way.
      'class A extends wrap(require) {}',
      'const w1 = new (URL as any)(`./w/${n}.ts`, import.meta.url);',
      "const w2 = new URL(`./w/${n}.ts`, import.meta['url']);",
      // The check reads no magic comments.
      'const ig = import(/* webpackIgnore: true */ name);',
      // A sweep read through a string key, or destructured, is a sweep stored.
      "const g2 = import.meta['glob'];",
      'const { glob } = import.meta;',
      '({ glob: g3 } = import.meta);',
      "const { ['glob']: g4 } = import.meta;",
      'const { webpackContext } = import.meta as any;',
      'function g5({ globEager } = import.meta) {}',
      // import.meta as a whole value hides any sweep read through it.
      'const meta = import.meta;',
      'register(import.meta);',
      'const all = { ...import.meta };',
      'const { ...rest } = import.meta;',
      // A rest element in an assignment pattern collects every member too.
      '({ ...rest2 } = import.meta);',
      'const k2 = import.meta[key];',
      'const { [key]: g6 } = import.meta;',
      // A comma expression's value is import.meta itself, whatever stands on its left.
      'const m3 = ({}, import.meta);',
    ].join('\n');
    const findings = computedSpecifiers('fixture.tsx', source);
    expect(findings.map(({ line, code }) => `${line} ${code}`)).toEqual([
      '1 import(`../editors/${filename}`)',
      '2 import(modulePath)',
      "3 import('../editors/' + name)",
      '4 require(`./locales/${lang}.json`)',
      '5 require(name)',
      "6 require('./locales/' + lang)",
      "7 import(isEditor ? './a' : './b')",
      '8 require.resolve(`./plugins/${name}`)',
      "9 require.context('./editors', true, /\\.tsx$/)",
      "10 import.meta.glob('./editors/*.tsx')",
      '11 import( `../editors/${filename.replace(/\\.tsx$/, "")}` )',
      "14 (require as any).context('../components', true, /\\.tsx$/)",
      "15 (import.meta as any).glob('../components/*.tsx')",
      "16 (require as unknown as Ctx).context('../components', true, /\\.tsx$/)",
      "17 ((require satisfies object) as any)!['context']('./editors', true, /\\.tsx$/)",
      "18 (import.meta.glob as any)('../components/*.tsx')",
      '19 (require as NodeRequire)(`./locales/${lang}.json`)',
      '20 req2 = require',
      '22 register(require)',
      "23 typeof require === 'function' ? require : null",
      '24 { require }',
      '25 0, require',
      '26 require.bind',
      '27 require[key]',
      '28 module.require(`../components/${name}`)',
      '29 new URL(`./workers/${name}.ts`, import.meta.url)',
      '30 new URL(file, (import.meta as any).url)',
      "31 (import.meta.glob<Mod>)('../components/*.tsx')",
      '32 (require as any).context',
      '33 require.context',
      '34 require.context',
      '35 (require as any).context',
      '36 import.meta.glob',
      '37 wrap(require)',
      '38 new (URL as any)(`./w/${n}.ts`, import.meta.url)',
      "39 new URL(`./w/${n}.ts`, import.meta['url'])",
      '40 import(/* webpackIgnore: true */ name)',
      "41 import.meta['glob']",
      '42 { glob } = import.meta',
      '43 { glob: g3 } = import.meta',
      "44 { ['glob']: g4 } = import.meta",
      '45 { webpackContext } = import.meta as any',
      '46 { globEager } = import.meta',
      '47 meta = import.meta',
      '48 register(import.meta)',
      '49 ...import.meta',
      '50 { ...rest } = import.meta',
      '51 { ...rest2 } = import.meta',
      '52 import.meta[key]',
      '53 { [key]: g6 } = import.meta',
      '54 {}, import.meta',
    ]);
    const [templateLiteral, variable, concatenation] = findings;
    expect(templateLiteral.why).toBe('a template literal with a substitution, so the bundler bundles every file under ../editors/ it could match, tests and fixtures included');
    expect(variable.why).toMatch(/^a variable \(modulePath\), so the bundler cannot tell which module it names/);
    expect(concatenation.why).toMatch(/^a string concatenation, /);
    expect(findings.find((f) => f.line === 20)?.why).toMatch(/^require used as a value \(stored, passed on, returned or called indirectly\), /);
    expect(findings.find((f) => f.line === 29)?.why).toBe(
      'new URL(..., import.meta.url) bundles the file its first argument names, and that argument is a template literal with a substitution, so the bundler bundles every file under ./workers/ it could match, tests and fixtures included'
    );
    expect(findings.find((f) => f.line === 32)?.why).toMatch(/^require\.context read but not called \(stored, destructured, passed on or called indirectly\), /);
    expect(findings.find((f) => f.line === 36)?.why).toMatch(/^import\.meta\.glob read but not called /);
    for (const line of [41, 42, 43, 44, 45, 46]) {
      expect(findings.find((f) => f.line === line)?.why, `line ${line}`).toMatch(
        /^import\.meta\.(?:glob|globEager|webpackContext) read but not called \(stored, destructured, passed on or called indirectly\), /
      );
    }
    for (const line of [47, 48, 49, 50, 51, 52, 53, 54]) {
      expect(findings.find((f) => f.line === line)?.why, `line ${line}`).toMatch(/^import\.meta used as a whole value \(stored, passed on, spread /);
    }
    // Plain JavaScript is read the same way.
    expect(computedSpecifiers('legacy.cjs', 'module.exports = (name) => require(`./handlers/${name}`);').map((f) => f.line)).toEqual([1]);
    // Angle-bracket casts parse outside JSX only; the call is reported, not the cast.
    const angleBrackets = computedSpecifiers(
      'legacy.ts',
      ["const ctx = (<any>require).context('./editors', true, /\\.tsx$/);", "const editors = (<any>import.meta).glob('./editors/*.tsx');"].join('\n')
    );
    expect(angleBrackets.map(({ line, code }) => `${line} ${code}`)).toEqual([
      "1 (<any>require).context('./editors', true, /\\.tsx$/)",
      "2 (<any>import.meta).glob('./editors/*.tsx')",
    ]);
    expect(angleBrackets[0].why).toMatch(/^require\.context bundles every matching file/);
  });

  // Review 2026-11-15: a call through a createRequire(import.meta.url) function, and
  // require.resolveWeak, passed with a computed specifier.
  it('refuses a computed specifier through a createRequire function or require.resolveWeak', () => {
    const source = [
      "import { createRequire } from 'node:module';",
      'const r = createRequire(import.meta.url);',
      'const a = r(`./editors/${name}`);',
      'const b = createRequire(import.meta.url)(`./editors/${name}`);',
      'const c = require.resolveWeak(`./editors/${name}`);',
      'const d = r.resolve(`./editors/${name}`);',
      'const m = nodeModule.createRequire(import.meta.url);',
      'const e = (m as NodeRequire)(name);',
      // Plain strings stay fine, as for require.
      "const f = r('node:fs');",
      "const g = createRequire(import.meta.url)('undici');",
      "const h = require.resolveWeak('react');",
      "const i = r.resolve('react');",
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', source).map(({ line, code }) => `${line} ${code}`)).toEqual([
      '3 r(`./editors/${name}`)',
      '4 createRequire(import.meta.url)(`./editors/${name}`)',
      '5 require.resolveWeak(`./editors/${name}`)',
      '6 r.resolve(`./editors/${name}`)',
      '8 (m as NodeRequire)(name)',
    ]);
  });

  // The second review of 2026-11-15: an aliased import, a later assignment, .call and .apply, and a
  // cast around createRequire itself.
  it('follows createRequire under another name, through a later assignment, a cast, .call and .apply', () => {
    const source = [
      "import { createRequire as makeRequire } from 'node:module';",
      'const a = makeRequire(import.meta.url);',
      'a(`./editors/${name}`);',
      'let b;',
      'b = makeRequire(import.meta.url);',
      'b(name);',
      'const c = (makeRequire as any)(import.meta.url);',
      'c.call(null, `./editors/${name}`);',
      'c.apply(null, [name]);',
      'c.apply(null, args);',
      "const { createRequire: viaRequire } = require('module');",
      'viaRequire(import.meta.url)(`./x/${name}`);',
      "a('node:fs');",
      "c.call(null, 'react');",
      "c.apply(null, ['react']);",
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', source).map(({ line, code }) => `${line} ${code}`)).toEqual([
      '3 a(`./editors/${name}`)',
      '6 b(name)',
      '8 c.call(null, `./editors/${name}`)',
      '9 c.apply(null, [name])',
      '10 c.apply(null, args)',
      '12 viaRequire(import.meta.url)(`./x/${name}`)',
    ]);
  });

  it('follows a lazy loader (??=, ||=, &&=, x = x || ...) and aliases of a created require or of createRequire', () => {
    const source = [
      "import { createRequire } from 'node:module';",
      'let nodeRequire;',
      'nodeRequire ??= createRequire(import.meta.url);',
      'nodeRequire(`./plugins/${name}`);',
      'let req;',
      'req ||= createRequire(import.meta.url);',
      'req(name);',
      'const load = nodeRequire;',
      'load(`./editors/${name}`);',
      'const make = createRequire;',
      'make(import.meta.url)(name);',
      'const fromModule = nodeModule.createRequire;',
      'const viaMember = fromModule(import.meta.url);',
      'viaMember(name);',
      "load('node:fs');",
      'let spelled;',
      'spelled = spelled || createRequire(import.meta.url);',
      'spelled(name);',
      'const picked = flag ? nodeRequire : null;',
      'picked(`./x/${name}`);',
      // An alias written before its source needs a second pass.
      'const late = earlier;',
      'const earlier = createRequire(import.meta.url);',
      'late(name);',
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', source).map(({ line, code }) => `${line} ${code}`)).toEqual([
      '4 nodeRequire(`./plugins/${name}`)',
      '7 req(name)',
      '9 load(`./editors/${name}`)',
      '11 make(import.meta.url)(name)',
      '14 viaMember(name)',
      '18 spelled(name)',
      '20 picked(`./x/${name}`)',
      '23 late(name)',
    ]);
  });

  it('allows plain string literals and template literals without a substitution', () => {
    const source = [
      "import TextBlockEditor from '../editors/TextBlockEditor';",
      "const a = import('../editors/TextBlockEditor');",
      'const b = import(`../editors/HeadingBlockEditor`);',
      "const c = require('node:fs');",
      'const d = require(`node:path`);',
      "const e = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs');",
      "const f = require.resolve('react');",
      "const g = import('./data.json', { with: { type: 'json' } });",
      // A cast changes nothing for a literal either.
      "const h = (require as NodeRequire)('node:fs');",
      "const i = (require as any).resolve('react');",
      "const j = module.require('node:fs');",
      "const k = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
      // Nor do parentheses and casts around a literal specifier.
      "const l = new URL(('./worker.ts'), import.meta.url);",
      "const m = new URL('./worker.ts' as string, import.meta.url);",
      "const n = import(('../editors/TextBlockEditor'));",
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', source)).toEqual([]);
  });

  it("allows require read by name, import.meta's other members, and new URL against anything but import.meta.url", () => {
    const source = [
      "const a = typeof require === 'function' && typeof require.resolve === 'function';",
      'const b = require.cache;',
      'const c = require.main === module;',
      'const d = new URL(path, request.url);',
      'const e = new URL(href, window.location.origin);',
      'const f = new URL(import.meta.url);',
      // A sweep tested with typeof loads nothing.
      "const g = typeof require.context === 'function' && typeof import.meta.glob === 'function';",
      // import.meta's other members load nothing, read or destructured, and neither does typeof.
      'const h = import.meta.env.MODE;',
      'const { env } = import.meta;',
      "const { url, env: { DEV }, ['hot']: hot, [('dirname' as const)]: dirname } = import.meta as any;",
      "const i = typeof import.meta === 'object';",
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', source)).toEqual([]);
  });

  it("tells a local binding named require from Node's require", () => {
    // Bundlers resolve a read of a declared binding to that binding: these are not Node's require.
    const local = [
      'function n({ require }: { require: boolean }) { return require ? 1 : 0; }',
      'const o = (require: Loader) => register(require);',
      'try { load(); } catch (require) { report(require); }',
      'for (const require of loaders) register(require);',
      '{ const require = makeLoader(); register(require); }',
      'const p = function require() { return register(require); };',
      'const C2 = class require { m() { return register(require); } };',
      'namespace N { const require = makeLoader(); register(require); }',
    ].join('\n');
    expect(computedSpecifiers('fixture.ts', local)).toEqual([]);
    // A binding at the top of the module covers all of it.
    for (const binding of [
      'const require = createRequire(import.meta.url);',
      'function require(id: string) { return id; }',
      'class require {}',
      "import require from './loader';",
      "import * as require from './loader';",
      "import { require } from './loader';",
      'import require = Loaders.node;',
    ]) {
      expect(computedSpecifiers('fixture.ts', `${binding}\nregister(require);`), binding).toEqual([]);
    }
    // An ambient declaration or a type-only import still names Node's require, and a binding ends with its scope.
    for (const binding of [
      'declare const require: NodeRequire;',
      'declare global { var require: NodeRequire }',
      "import type { require } from './loader';",
      "import { type require } from './loader';",
      '{ const require = makeLoader(); }',
      'function f(require: Loader) { return require; }',
    ]) {
      expect(computedSpecifiers('fixture.ts', `${binding}\nregister(require);`).map(({ line, code }) => `${line} ${code}`), binding).toEqual(['2 register(require)']);
    }
    // A computed method name and a parameter's decorator (it runs in the class's scope) are read outside the method's parameters,
    // a constructor's parameter property (the usual dependency-injection spelling) included.
    const outsideParameters: Array<[string, string]> = [
      ['class C { [register(require)](require: Loader) { return require; } }', 'register(require)'],
      ['class C { m(@dec(require) require: Loader) { return require; } }', 'dec(require)'],
      ['class D { constructor(@Inject(require) private readonly require: Loader) {} }', 'Inject(require)'],
    ];
    for (const [source, code] of outsideParameters) {
      expect(computedSpecifiers('fixture.ts', source).map((finding) => finding.code), source).toEqual([code]);
    }
    // A call through a local binding still takes a plain string.
    expect(computedSpecifiers('fixture.ts', 'function f(require: Loader, name: string) { return require(name); }').map(({ code }) => code)).toEqual([
      'require(name)',
    ]);
  });

  it('reads code, not comments, strings, JSX text, type positions or names', () => {
    const source = [
      '// import(`../editors/${name}`) in a comment is prose',
      '/* require(name) */',
      "const a = 'import(`../editors/${name}`)';",
      'const b = `require(${name})`;',
      "type T = import('./types').Block;",
      "let c: typeof import('./module');",
      'const d = loader.require(name);',
      'const e = <p>require(name) is prose here</p>;',
      // A declaration, key or attribute called require reads nothing.
      'const f = { require: true };',
      'class G { require(id: string) { return id; } }',
      'let h: typeof require;',
      'const i = <Field require="always" />;',
      'function j(require: unknown) {}',
      'const { require: k } = loader;',
      'require: for (;;) { break require; }',
      // A local binding named require is read like any other variable.
      'function n({ require }: { require: boolean }) { return require ? 1 : 0; }',
    ].join('\n');
    expect(computedSpecifiers('fixture.tsx', source)).toEqual([]);
  });
});

describe('dynamic import specifiers in bundled code', () => {
  const files = bundledSources();

  it('scans the app and each lib src, and nothing a bundler never compiles', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/nextblock/proxy.ts',
        'apps/nextblock/app/cms/blocks/components/EditableBlock.tsx',
        'apps/nextblock/app/cms/blocks/components/ColumnEditor.tsx',
        'apps/nextblock/app/cms/blocks/components/blockEditorLoaders.ts',
        'libs/utils/src/index.ts',
        'libs/ecommerce/src/index.ts',
      ])
    );
    const outOfScope = files.filter(
      (file) =>
        TEST_FILE_RE.test(file) ||
        /(?:^|\/)(?:node_modules|\.next|__tests__|__fixtures__|__mocks__)\//.test(file) ||
        /^apps\/nextblock\/(?:tools|scripts|public)\//.test(file) ||
        !/^(?:apps\/nextblock|libs\/[^/]+\/src)\//.test(file)
    );
    expect(outOfScope).toEqual([]);
  });

  it('names every import() and require() target with a plain string', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED_COMPUTED_SPECIFIERS.has(file)) continue;
      for (const { line, code, why } of computedSpecifiers(file, readSource(file))) offenders.push(`${file}:${line} ${code}: ${why}`);
    }
    expect(offenders, FIX_HINT).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it('keeps each allow-list entry justified and still needed', () => {
    for (const [file, why] of ALLOWED_COMPUTED_SPECIFIERS) {
      expect(why.trim(), `${file}: say why no bundler compiles it`).not.toBe('');
      expect(files, `${file} is allow-listed but not scanned: remove the entry`).toContain(file);
      expect(computedSpecifiers(file, readSource(file)).length, `${file} no longer has a computed specifier: remove the entry`).toBeGreaterThan(0);
    }
  });
});
