// Server actions take no caller-supplied principal.
//
// Every exported function of a 'use server' module, and every function with its own
// 'use server' directive, is a public POST endpoint: its arguments are whatever the request
// says. An argument that names who is acting (an actor, author or uploader id) or hands the
// action its database client lets any caller choose the principal. Until 2026-10-21
// `recordMediaUpload` and `importExternalImageToMedia` took `actorUserId`, switched to the
// service role and checked the session only when there was one, so a cookieless POST naming
// an admin's id (public via approved comments) wrote media as that admin.
//
// The actor of a server action is the cookie session's user (`requireCmsStaff()`,
// `requireEcomStaff()` ...). A server route that authenticates another way (the MCP bearer
// token) calls a helper that is not a server action and takes the actor from the route.
//
// The check parses each such function with the TypeScript parser and fails on a parameter, a
// destructured property, or a member of a parameter's type (inline, declared in the module,
// or imported from a relative or aliased module) whose name is an identity or a client.
// A target id (the user an admin edits) passes under a name that says so: `userIdToUpdate`.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { createResolver, scanRepository } = require('./service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Parameter names (lowercased, underscores dropped) that make the caller the principal.
 * `affiliateid` / `retailerid`: a partner-portal action acts for the partner the session names
 * (`requireRetailer()`); an admin target says so (`affiliateIdToUpdate`).
 */
const IDENTITY_NAMES = new Set([
  'actorid',
  'actoruserid',
  'affiliateid',
  'authorid',
  'createdby',
  'creatorid',
  'ownerid',
  'retailerid',
  'uploaderid',
  'userid',
]);

/** Parameter names that hand the action the database client it runs with. */
const CLIENT_NAMES = new Set(['adminclient', 'client', 'db', 'serviceclient', 'serviceroleclient', 'supabase', 'supabaseclient']);

/** How deep a parameter's type is followed (member types, aliases, imports). */
const MAX_TYPE_DEPTH = 4;

/** Wrappers whose first type argument carries the members. */
const TRANSPARENT_GENERICS = new Set(['Array', 'NonNullable', 'Partial', 'Promise', 'Readonly', 'ReadonlyArray', 'Required']);

const USE_SERVER_RE = /['"]use server['"]/;

function classifyName(name) {
  const normalized = name.replace(/_/g, '').toLowerCase();
  if (IDENTITY_NAMES.has(normalized)) return 'an identity';
  if (CLIENT_NAMES.has(normalized)) return 'a database client';
  return null;
}

function parseSource(fileName, source) {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** True when a directive prologue (leading string statements) contains 'use server'. */
function hasUseServerDirective(statements) {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === 'use server') return true;
  }
  return false;
}

function isExported(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function propertyNameText(name) {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return null;
}

/** The function a binding holds: `async () => {}`, or one wrapped as `cache(async () => {})`. */
function functionOf(expression) {
  if (!expression) return null;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return functionOf(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    for (const argument of expression.arguments) {
      const fn = functionOf(argument);
      if (fn) return fn;
    }
  }
  return null;
}

/** A parsed module with its top-level functions, types and imported names. */
function indexModule(sourceFile) {
  const functions = new Map();
  const types = new Map();
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = functionOf(declaration.initializer);
        if (fn && ts.isIdentifier(declaration.name)) functions.set(declaration.name.text, fn);
      }
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      types.set(statement.name.text, statement);
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const spec = statement.moduleSpecifier.text;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          imports.set(element.name.text, { spec, imported: (element.propertyName ?? element.name).text });
        }
      }
    }
    // `export type { X } from './y'` lets an importer of this module name X.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        imports.set(element.name.text, { spec: statement.moduleSpecifier.text, imported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return { sourceFile, functions, imports, types };
}

function literalKeys(typeNode) {
  if (!typeNode) return null;
  const nodes = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
  const keys = new Set();
  for (const node of nodes) {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) return null;
    keys.add(node.literal.text);
  }
  return keys;
}

/**
 * Follows parameter types across modules. `resolveImport(fromFile, spec)` returns an absolute
 * path, or null for a package outside the repository (not followed).
 */
function createTypeWalker(resolveImport) {
  const loaded = new Map();

  function load(absolute) {
    if (!loaded.has(absolute)) {
      let module = null;
      try {
        module = indexModule(parseSource(absolute, fs.readFileSync(absolute, 'utf8')));
      } catch {
        module = null;
      }
      loaded.set(absolute, module);
    }
    return loaded.get(absolute);
  }

  /** The declaration of type `name` as seen from `module`, and the module that declares it. */
  function findType(module, name, seen = new Set()) {
    if (module.types.has(name)) return { module, declaration: module.types.get(name) };
    const imported = module.imports.get(name);
    if (!imported || !resolveImport) return null;
    const target = resolveImport(module.sourceFile.fileName, imported.spec);
    const key = `${target}#${imported.imported}`;
    if (!target || seen.has(key)) return null;
    seen.add(key);
    const targetModule = load(target);
    return targetModule ? findType(targetModule, imported.imported, seen) : null;
  }

  /** Member names reachable from a type node, each with its dotted path under `prefix`. */
  function memberPaths(module, typeNode, depth, prefix, visited) {
    if (!typeNode || depth > MAX_TYPE_DEPTH) return [];
    if (ts.isParenthesizedTypeNode(typeNode)) return memberPaths(module, typeNode.type, depth, prefix, visited);
    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
      return typeNode.types.flatMap((t) => memberPaths(module, t, depth, prefix, visited));
    }
    if (ts.isArrayTypeNode(typeNode)) return memberPaths(module, typeNode.elementType, depth, prefix, visited);
    if (ts.isTypeLiteralNode(typeNode)) return membersOf(module, typeNode.members, depth, prefix, visited);
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return [];

    const name = typeNode.typeName.text;
    const args = typeNode.typeArguments ?? [];
    if (TRANSPARENT_GENERICS.has(name)) return memberPaths(module, args[0], depth, prefix, visited);
    if (name === 'Omit' || name === 'Pick') {
      const inner = memberPaths(module, args[0], depth, prefix, visited);
      const keys = literalKeys(args[1]);
      if (!keys) return inner;
      return inner.filter((member) => {
        const top = member.path.slice(prefix.length).split('.')[0];
        return name === 'Omit' ? !keys.has(top) : keys.has(top);
      });
    }

    const found = findType(module, name);
    if (!found) return [];
    const key = `${found.module.sourceFile.fileName}#${name}`;
    if (visited.has(key)) return [];
    const nextVisited = new Set(visited).add(key);
    const { declaration } = found;
    if (ts.isTypeAliasDeclaration(declaration)) {
      return memberPaths(found.module, declaration.type, depth + 1, prefix, nextVisited);
    }
    const inherited = (declaration.heritageClauses ?? []).flatMap((clause) =>
      clause.types.flatMap((t) =>
        ts.isIdentifier(t.expression)
          ? memberPaths(found.module, ts.factory.createTypeReferenceNode(t.expression.text, t.typeArguments), depth + 1, prefix, nextVisited)
          : []
      )
    );
    return [...inherited, ...membersOf(found.module, declaration.members, depth + 1, prefix, nextVisited)];
  }

  function membersOf(module, members, depth, prefix, visited) {
    const out = [];
    for (const member of members) {
      const name = propertyNameText(member.name);
      if (!name) continue;
      out.push({ name, path: `${prefix}${name}` });
      if (ts.isPropertySignature(member) && member.type) {
        out.push(...memberPaths(module, member.type, depth + 1, `${prefix}${name}.`, visited));
      }
    }
    return out;
  }

  return { memberPaths };
}

/** Names a parameter exposes to the caller: its own, its destructured keys, its type's members. */
function parameterNames(module, parameter, walker) {
  const names = [];
  const collect = (binding, prefix) => {
    if (ts.isIdentifier(binding)) {
      names.push({ name: binding.text, path: `${prefix}${binding.text}` });
      return;
    }
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const key = propertyNameText(element.propertyName) ?? (ts.isIdentifier(element.name) ? element.name.text : null);
      if (key) names.push({ name: key, path: `${prefix}${key}` });
      if (!ts.isIdentifier(element.name)) collect(element.name, key ? `${prefix}${key}.` : prefix);
    }
  };
  collect(parameter.name, '');
  const prefix = ts.isIdentifier(parameter.name) ? `${parameter.name.text}.` : '';
  names.push(...walker.memberPaths(module, parameter.type, 0, prefix, new Set()));
  return names;
}

/** Every server action a module defines, as [name, function node]. */
function serverActionFunctions(module) {
  const { sourceFile, functions } = module;
  const found = [];

  if (hasUseServerDirective(sourceFile.statements)) {
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
        found.push([statement.name?.text ?? 'default', statement]);
      } else if (ts.isVariableStatement(statement) && isExported(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const fn = functionOf(declaration.initializer);
          if (fn) found.push([declaration.name.getText(sourceFile), fn]);
        }
      } else if (ts.isExportAssignment(statement)) {
        const expression = statement.expression;
        const fn = functionOf(expression) ?? (ts.isIdentifier(expression) ? functions.get(expression.text) : null);
        if (fn) found.push(['default', fn]);
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        !statement.isTypeOnly &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const fn = functions.get((element.propertyName ?? element.name).text);
          if (fn) found.push([element.name.text, fn]);
        }
      }
    }
  }

  // Inline actions: a function whose own body opens with 'use server' (forms in server components).
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body) &&
      hasUseServerDirective(node.body.statements) &&
      !found.some(([, fn]) => fn === node)
    ) {
      const name = node.name
        ? node.name.getText(sourceFile)
        : ts.isVariableDeclaration(node.parent)
          ? node.parent.name.getText(sourceFile)
          : '(inline action)';
      found.push([name, node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Problems in one module. `resolveImport` follows imported parameter types; without it only the
 * module's own declarations are read.
 */
function findCallerSuppliedActorsInSource(repoPath, source, resolveImport = null, absolute = repoPath) {
  if (!USE_SERVER_RE.test(source)) return [];
  const module = indexModule(parseSource(absolute, source));
  const walker = createTypeWalker(resolveImport);
  const problems = [];
  const seen = new Set();
  for (const [action, fn] of serverActionFunctions(module)) {
    for (const parameter of fn.parameters) {
      const line = module.sourceFile.getLineAndCharacterOfPosition(parameter.getStart(module.sourceFile)).line + 1;
      for (const member of parameterNames(module, parameter, walker)) {
        const kind = classifyName(member.name);
        const key = `${line}:${action}:${member.path}`;
        if (!kind || seen.has(key)) continue;
        seen.add(key);
        problems.push({
          file: repoPath,
          line,
          action,
          param: member.path,
          problem:
            `${repoPath}:${line} server action ${action}() takes \`${member.path}\` (${kind}) from the caller; ` +
            'take the actor from the session (requireCmsStaff()) or move the actor variant into a module that is not a server action',
        });
      }
    }
  }
  return problems;
}

/**
 * [record, source] for every scanned module that mentions 'use server'. Only `absolute` and
 * `repoPath` are read from the service-role-boundary records.
 */
function serverActionSources(modules) {
  const out = [];
  for (const mod of modules.values()) {
    const source = fs.readFileSync(mod.absolute, 'utf8');
    if (USE_SERVER_RE.test(source)) out.push([mod, source]);
  }
  return out;
}

/** Repository-wide check over the service-role-boundary scan set (apps/nextblock, libs). */
function findCallerSuppliedActors(modules = scanRepository(), resolveImport = createResolver()) {
  return serverActionSources(modules)
    .flatMap(([mod, source]) => findCallerSuppliedActorsInSource(mod.repoPath, source, resolveImport, mod.absolute))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `file#action` for every server action the scan sees, for the coverage assertion. */
function listServerActions(modules = scanRepository()) {
  return serverActionSources(modules)
    .flatMap(([mod, source]) =>
      serverActionFunctions(indexModule(parseSource(mod.absolute, source))).map(([action]) => `${mod.repoPath}#${action}`)
    )
    .sort();
}

/* ------------------------------------------ Freemius coupon pushes need a verified admin --- */

// Since 2026-11-12 a coupon push is signed with the Freemius developer key pair, which reaches
// every product of the account (a coupon with no product scope applies to all of them). On
// 2026-11-13 four server-action paths reached one with an ADMIN password and no second factor:
// the coupon actions (a role-only getAdminClient()), the promotions CSV import (a role-only
// assertAdmin()), createProductAction (no check; its RPC's is_admin() passes at aal1) and the
// visual-editing product publish (requireVisualEditingEditableUser(), role only).
//
// This check follows calls out of every server action across modules: relative and aliased
// imports, barrels and `export *`, `import * as`, destructured or namespace dynamic imports, and
// functions passed as arguments (method calls on objects are not followed). An action that can
// reach a push fails unless every call toward it either runs after a counted call to
// requireEcomAdmin() or requireCmsAdmin() (the real helpers, which throw for a session whose
// enrolled second factor is still pending) or goes to a function that passes this check itself.
//
// "Runs after" is read from the structure of the code, not from source positions: on 2026-11-13
// the re-review passed `requireEcomAdmin().catch(() => null)`, `try { await requireEcomAdmin(); }
// catch {}`, a check inside `if (strict) { ... }` only and `void requireEcomAdmin()`, because each
// appeared earlier in the source than the push. An authorizer call counts only when:
// - it is awaited, and that await is a whole expression statement, a variable initializer
//   (destructuring included) or the right side of a plain `=` assignment statement, so the next
//   statement runs only if the helper resolved;
// - the await is applied to the call itself: a `.catch()` or `.then()` could turn the refusal into
//   a value (parentheses and type assertions are fine; they are erased);
// - its statement stands directly in a block, and the call toward the push sits in a later
//   statement of that block. The function body's top level covers everything after it; an
//   if-branch, loop body or try block covers only what follows inside it;
// - inside a try it counts only when the catch ends in `return` or `throw` (a refusal cannot fall
//   through), and that try then lifts it to the enclosing block; a check inside a catch, a
//   finally, or a try whose catch can fall through never counts.
// Every call toward a push is checked, not only the first. A wrapper counts when every way it
// returns normally passes such a call, or returns the helper's own promise. A call through a name
// the function rebinds (a local `const requireEcomAdmin = ...`, a parameter of that name) never
// counts. A function declaration nested in the action is hoisted to the start of its scope, so a
// call inside one is placed there.

/** The module that sends coupons to Freemius, and the module-internal request every push makes. */
const FREEMIUS_COUPONS_MODULE = 'libs/ecommerce/src/lib/freemius-coupons.ts';
const FREEMIUS_COUPON_REQUEST = 'freemiusCouponRequest';

/** Its exports that send a coupon (the test fails when an export reaching the request is missing). */
const FREEMIUS_COUPON_PUSHES = ['deleteCouponFromFreemius', 'syncCouponToFreemius', 'syncProductSaleCouponToFreemius'];

/** The helpers that hand out the service role only to an ADMIN whose second factor has passed. */
const ADMIN_AUTHORIZERS = [
  ['libs/ecommerce/src/lib/server-actions/require-ecom-role.ts', 'requireEcomAdmin'],
  ['apps/nextblock/lib/auth/cms-actor.ts', 'requireCmsAdmin'],
];

const fromRepo = (repoPath) => path.join(REPO_ROOT, repoPath);

/** Value bindings of a module: its functions, imports and exports (types are skipped). */
function indexValues(sourceFile) {
  const functions = new Map();
  const imports = new Map();
  const namespaces = new Map();
  const exports = new Map();
  const stars = [];
  for (const statement of sourceFile.statements) {
    const exported = isExported(statement);
    const isDefault = Boolean(statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? (isDefault ? 'default' : null);
      if (!name) continue;
      functions.set(name, statement);
      if (exported) exports.set(isDefault ? 'default' : name, { local: name });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const fn = functionOf(declaration.initializer);
        if (fn) functions.set(declaration.name.text, fn);
        if (exported) exports.set(declaration.name.text, { local: declaration.name.text });
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const spec = statement.moduleSpecifier.text;
      if (clause.name) imports.set(clause.name.text, { spec, imported: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, spec);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) imports.set(element.name.text, { spec, imported: (element.propertyName ?? element.name).text });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const spec = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (!statement.exportClause) {
        if (spec) stars.push(spec);
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const source = (element.propertyName ?? element.name).text;
          exports.set(element.name.text, spec ? { spec, imported: source } : { local: source });
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const fn = functionOf(statement.expression);
      if (fn) {
        functions.set('default', fn);
        exports.set('default', { local: 'default' });
      } else if (ts.isIdentifier(statement.expression)) {
        exports.set('default', { local: statement.expression.text });
      }
    }
  }
  return { functions, imports, namespaces, exports, stars };
}

/** The specifier of `import('x')`, also awaited or parenthesized; null for anything else. */
function importCallSpec(expression) {
  let current = expression;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current))) {
    current = current.expression;
  }
  if (!current || !ts.isCallExpression(current) || current.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const argument = current.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

const dynamicBindingMemo = new WeakMap();

/** Names a function binds to a dynamic import: `const { a: b } = await import('x')`, `const m = await import('x')`. */
function dynamicImportBindings(fn) {
  if (!dynamicBindingMemo.has(fn)) dynamicBindingMemo.set(fn, readDynamicImportBindings(fn));
  return dynamicBindingMemo.get(fn);
}

function readDynamicImportBindings(fn) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const spec = importCallSpec(node.initializer);
      if (spec && ts.isIdentifier(node.name)) bindings.set(node.name.text, { spec, namespace: true });
      if (spec && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName ? propertyNameText(element.propertyName) : element.name.text;
          if (imported) bindings.set(element.name.text, { spec, imported });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return bindings;
}

/**
 * Who calls whom, function by function, across modules. Keys are `<absolute path>#<top-level
 * function>` (or `<absolute path>@<position>` for an inline action). Pushes and authorizers are
 * leaves: their bodies are not followed.
 */
function createCallGraph({ resolveImport, leaves }) {
  const modules = new Map();
  const nodes = new Map();
  const edgeCache = new Map();
  const exportMemo = new Map();

  function moduleAt(absolute) {
    if (!modules.has(absolute)) {
      let mod = null;
      try {
        const sourceFile = parseSource(absolute, fs.readFileSync(absolute, 'utf8'));
        mod = { absolute, sourceFile, ...indexValues(sourceFile) };
        for (const [name, fn] of mod.functions) nodes.set(`${absolute}#${name}`, { mod, fn });
      } catch {
        mod = null;
      }
      modules.set(absolute, mod);
    }
    return modules.get(absolute);
  }

  function follow(fromFile, spec, name, seen) {
    const target = resolveImport ? resolveImport(fromFile, spec) : null;
    return target ? resolveExport(target, name, seen) : null;
  }

  function resolveLocal(mod, local, seen) {
    if (mod.functions.has(local)) return `${mod.absolute}#${local}`;
    const imported = mod.imports.get(local);
    return imported ? follow(mod.absolute, imported.spec, imported.imported, seen) : null;
  }

  /** The function an export names, through re-exports and `export *`; null when it is not a function. */
  function resolveExport(absolute, name, seen) {
    const key = `${absolute}#${name}`;
    const outer = !seen;
    if (outer && exportMemo.has(key)) return exportMemo.get(key);
    const visited = seen ?? new Set();
    let result = null;
    if (!visited.has(key)) {
      visited.add(key);
      const mod = moduleAt(absolute);
      const entry = mod?.exports.get(name);
      if (entry) {
        result = entry.spec !== undefined ? follow(absolute, entry.spec, entry.imported, visited) : resolveLocal(mod, entry.local, visited);
      } else if (mod && name !== 'default') {
        for (const spec of mod.stars) {
          result = follow(absolute, spec, name, visited);
          if (result) break;
        }
      }
    }
    if (outer) exportMemo.set(key, result);
    return result;
  }

  /** The function a callee or argument refers to: a local function, an import, a namespace member. */
  function referenceTarget(mod, dynamic, expression) {
    let target = expression;
    while (target && (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isNonNullExpression(target))) {
      target = target.expression;
    }
    if (!target) return null;
    if (ts.isIdentifier(target)) {
      const binding = dynamic.get(target.text);
      if (binding) return binding.namespace ? null : follow(mod.absolute, binding.spec, binding.imported);
      return resolveLocal(mod, target.text);
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
      let object = target.expression;
      while (ts.isParenthesizedExpression(object)) object = object.expression;
      let spec = importCallSpec(object);
      if (!spec && ts.isIdentifier(object)) {
        const binding = dynamic.get(object.text);
        spec = binding ? (binding.namespace ? binding.spec : null) : (mod.namespaces.get(object.text) ?? null);
      }
      return spec ? follow(mod.absolute, spec, target.name.text) : null;
    }
    return null;
  }

  /**
   * The calls (and function references passed as arguments) in a function. Each edge keeps the
   * referring expression (`node`, where it runs) and, for the callee of a call, the call itself
   * (`call`, null for an argument or `new`): only a call can count as an authorizer.
   */
  function edgesOf(key) {
    if (edgeCache.has(key)) return edgeCache.get(key);
    const edges = [];
    edgeCache.set(key, edges);
    const entry = nodes.get(key);
    if (!entry || leaves.has(key) || !entry.fn.body) return edges;
    const { mod, fn } = entry;
    const dynamic = dynamicImportBindings(fn);
    const add = (expression, call) => {
      const target = referenceTarget(mod, dynamic, expression);
      if (target && target !== key) edges.push({ key: target, pos: expression.getStart(mod.sourceFile), node: expression, call });
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        add(node.expression, ts.isCallExpression(node) ? node : null);
        for (const argument of node.arguments ?? []) add(argument, null);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return edges;
  }

  /** The function node behind a key (after moduleAt or keyOf registered it). */
  function functionAt(key) {
    return nodes.get(key)?.fn ?? null;
  }

  /** The key of a server action's function node, registering an inline action under its position. */
  function keyOf(mod, fn) {
    for (const [name, candidate] of mod.functions) if (candidate === fn) return `${mod.absolute}#${name}`;
    const key = `${mod.absolute}@${fn.pos}`;
    nodes.set(key, { mod, fn });
    return key;
  }

  /** Every function reachable from `entries`, in discovery order. */
  function closure(entries) {
    const order = [];
    const seen = new Set();
    const stack = [...entries].reverse();
    while (stack.length > 0) {
      const key = stack.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(key);
      for (const edge of [...edgesOf(key)].reverse()) if (!seen.has(edge.key)) stack.push(edge.key);
    }
    return order;
  }

  return { closure, edgesOf, functionAt, keyOf, moduleAt, resolveExport };
}

/* -------------------------------------------- which authorizer calls protect what follows --- */

/** Parentheses and type assertions are erased at run time, so they never change what runs. */
function isErasedWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function unwrapErased(expression) {
  let current = expression;
  while (current && isErasedWrapper(current)) current = current.expression;
  return current;
}

function outermostErased(node) {
  let current = node;
  while (current.parent && isErasedWrapper(current.parent)) current = current.parent;
  return current;
}

/** Code inside a function (or a class static block) runs when that runs, not where it sits. */
function isFunctionBoundary(node) {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

/** `requireX?.()` or a call inside `a?.b()`: may skip the call and resolve to undefined. */
function isOptionalCall(call) {
  return Boolean(call.questionDotToken) || (call.flags & ts.NodeFlags.OptionalChain) !== 0;
}

const declaredNameMemo = new WeakMap();

/**
 * How many times each name is bound inside `fn`: its parameters and those of nested functions,
 * variables, function and class names, catch bindings. A function declaration's own name belongs
 * to the scope outside it.
 */
function declaredNames(fn) {
  if (declaredNameMemo.has(fn)) return declaredNameMemo.get(fn);
  const counts = new Map();
  const add = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  const bind = (name) => {
    if (ts.isIdentifier(name)) add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  const visit = (node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      bind(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.name &&
      (node !== fn || !ts.isFunctionDeclaration(node))
    ) {
      add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  declaredNameMemo.set(fn, counts);
  return counts;
}

/**
 * True when the name a call goes through (`x()`, or `ns` in `ns.x()`) is also bound inside `fn`:
 * the call graph resolves names at module level, so `const requireEcomAdmin = async () => null`
 * in the action, or a parameter of that name, would otherwise pass for the imported helper. A
 * name bound once, by a dynamic import, is the import itself.
 */
function isShadowedCall(call, fn) {
  let callee = unwrapErased(call.expression);
  if (callee && ts.isPropertyAccessExpression(callee)) callee = unwrapErased(callee.expression);
  if (!callee || !ts.isIdentifier(callee)) return false;
  const bound = declaredNames(fn).get(callee.text) ?? 0;
  return bound > (dynamicImportBindings(fn).has(callee.text) ? 1 : 0);
}

/**
 * The statement an authorizer call stands in, when the call counts: awaited, the await applied to
 * the call itself, and that await a whole expression statement, a variable initializer
 * (destructuring included) or the right side of a plain `=` assignment statement. Then the next
 * statement runs only if the helper resolved. Null for anything else: `.catch()` / `.then()` on the
 * call, `void`, no await, a condition, an argument, a logical assignment (`??=` may skip the call).
 */
function authorizerStatement(call) {
  if (isOptionalCall(call)) return null;
  const awaited = outermostErased(call).parent;
  if (!awaited || !ts.isAwaitExpression(awaited)) return null;
  const value = outermostErased(awaited);
  const parent = value.parent;
  if (!parent) return null;
  if (ts.isExpressionStatement(parent)) return parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
    const statement = parent.parent?.parent;
    return statement && ts.isVariableStatement(statement) ? statement : null;
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value) {
    const statement = outermostErased(parent).parent;
    return statement && ts.isExpressionStatement(statement) ? statement : null;
  }
  return null;
}

/** A try whose catch ends in `return` or `throw` (or that has none): a refusal cannot fall through it. */
function isTransparentTry(tryStatement) {
  const handler = tryStatement.catchClause;
  if (!handler) return true;
  const last = handler.block.statements[handler.block.statements.length - 1];
  return Boolean(last) && (ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

/**
 * Where a counted authorizer statement protects what follows it: `[{ block, statement }]`,
 * innermost first, meaning "every later statement of `block` runs after `statement` completed".
 * A try statement that is itself a direct statement of a block, and whose catch ends in `return`
 * or `throw`, lifts the protection to that block. An if-branch, a loop body, a labeled statement
 * or a bare block keeps it inside. Inside a catch, a finally, or a try whose catch can fall
 * through (at any depth within the function) it protects nothing: a refusal there can be turned
 * into ordinary control flow.
 */
function dominanceLevels(statement) {
  for (let current = statement.parent; current && !isFunctionBoundary(current); current = current.parent) {
    if (ts.isCatchClause(current)) return [];
    const owner = current.parent;
    if (owner && ts.isTryStatement(owner)) {
      if (owner.finallyBlock === current) return [];
      if (owner.tryBlock === current && !isTransparentTry(owner)) return [];
    }
  }
  const levels = [];
  let standing = statement;
  for (;;) {
    const block = standing.parent;
    if (!block || !(ts.isBlock(block) || ts.isCaseClause(block) || ts.isDefaultClause(block))) break;
    levels.push({ block, statement: standing });
    const owner = block.parent;
    if (!owner || !ts.isTryStatement(owner) || owner.tryBlock !== block || !isTransparentTry(owner)) break;
    standing = owner;
  }
  return levels;
}

/** The scope a nested function declaration is hoisted to: its block (a switch's whole case block). */
function hoistScope(declaration) {
  const parent = declaration.parent;
  return ts.isCaseClause(parent) || ts.isDefaultClause(parent) ? parent.parent : parent;
}

/**
 * True when `node` runs only after `level.statement` completed: it sits inside `level.block`, in a
 * later statement. A function declaration between them is hoisted (callable from the start of its
 * scope), so a call inside one is placed at that scope's start.
 */
function dominates({ block, statement }, node) {
  let point = node;
  for (let current = node.parent; current !== block; current = current.parent) {
    if (!current) return false;
    if (ts.isFunctionDeclaration(current)) point = hoistScope(current);
  }
  return point.getStart() >= statement.end;
}

/** False only when control can never fall off the end of `statement` (it returns or throws). */
function canCompleteNormally(statement) {
  if (!statement) return true;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
  if (ts.isBlock(statement)) {
    return statement.statements.length === 0 || canCompleteNormally(statement.statements[statement.statements.length - 1]);
  }
  if (ts.isIfStatement(statement)) {
    return !statement.elseStatement || canCompleteNormally(statement.thenStatement) || canCompleteNormally(statement.elseStatement);
  }
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && !canCompleteNormally(statement.finallyBlock)) return false;
    return canCompleteNormally(statement.tryBlock) || Boolean(statement.catchClause && canCompleteNormally(statement.catchClause.block));
  }
  return true;
}

/** A call, in function `fn`, that really reaches a function that authorizes. */
function isAuthorizerCall(edge, fn, authorizes) {
  return Boolean(edge.call) && Boolean(authorizes.get(edge.key)) && !isShadowedCall(edge.call, fn);
}

/** The protection levels of every counted call, in function `key`, to a function that authorizes. */
function authorizerLevels(callGraph, key, authorizes) {
  const fn = callGraph.functionAt(key);
  const levels = [];
  for (const edge of callGraph.edgesOf(key)) {
    if (!isAuthorizerCall(edge, fn, authorizes)) continue;
    const statement = authorizerStatement(edge.call);
    if (statement) levels.push(...dominanceLevels(statement));
  }
  return levels;
}

/**
 * A wrapper authorizes when every way it returns normally comes after a counted authorizer call,
 * or returns the authorizer's own promise (`return requireCmsAdmin()`, `() => requireEcomAdmin()`),
 * which the caller's await then rejects with. A `return null` in a catch, or an end of the body
 * that a refusal can reach, makes it a check its caller cannot rely on.
 */
function authorizesOnEveryExit(callGraph, key, authorizes) {
  const fn = callGraph.functionAt(key);
  if (!fn?.body) return false;
  const edges = callGraph.edgesOf(key);
  if (!edges.some((edge) => isAuthorizerCall(edge, fn, authorizes))) return false;
  const returnsAuthorizer = (expression) => {
    let inner = unwrapErased(expression);
    if (inner && ts.isAwaitExpression(inner)) inner = unwrapErased(inner.expression);
    if (!inner || !ts.isCallExpression(inner) || isOptionalCall(inner)) return false;
    return edges.some((edge) => edge.call === inner && isAuthorizerCall(edge, fn, authorizes));
  };
  if (!ts.isBlock(fn.body)) return returnsAuthorizer(fn.body);

  const levels = authorizerLevels(callGraph, key, authorizes);
  const returns = [];
  const visit = (node) => {
    if (isFunctionBoundary(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  const covered = (node) => levels.some((level) => dominates(level, node));
  if (!returns.every((statement) => (statement.expression && returnsAuthorizer(statement.expression)) || covered(statement))) {
    return false;
  }
  return !canCompleteNormally(fn.body) || levels.some((level) => level.block === fn.body);
}

/** Least fixpoint: a key holds when `base(key)` or one of its callees holds. */
function propagate(graph, order, base) {
  const holds = new Map(order.map((key) => [key, base(key)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of order) {
      if (holds.get(key)) continue;
      if (graph.edgesOf(key).some((edge) => holds.get(edge.key))) {
        holds.set(key, true);
        changed = true;
      }
    }
  }
  return holds;
}

/**
 * Server actions that can reach a Freemius coupon push, and those that can do so without passing
 * requireEcomAdmin() / requireCmsAdmin() first. `files` are absolute paths of modules that may
 * define server actions; `pushes` and `authorizers` are [absolute path, export name] pairs.
 */
function analyzeCouponPushActions(files, { resolveImport = null, pushes, authorizers, root = REPO_ROOT }) {
  const pushKeys = new Map();
  const authorizerKeys = new Set();
  const problems = [];
  const toRepo = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  // Leaves are read only when edges are computed, after both lists are resolved below.
  const leaves = new Set();
  const callGraph = createCallGraph({ resolveImport, leaves });
  for (const [absolute, name] of pushes) {
    const key = callGraph.resolveExport(absolute, name);
    if (key) pushKeys.set(key, name);
    else problems.push({ file: toRepo(absolute), problem: `${toRepo(absolute)} no longer exports the coupon push ${name}(); update FREEMIUS_COUPON_PUSHES` });
  }
  for (const [absolute, name] of authorizers) {
    const key = callGraph.resolveExport(absolute, name);
    if (key) authorizerKeys.add(key);
    else problems.push({ file: toRepo(absolute), problem: `${toRepo(absolute)} no longer exports ${name}(); update ADMIN_AUTHORIZERS` });
  }
  for (const key of [...pushKeys.keys(), ...authorizerKeys]) leaves.add(key);

  const actions = [];
  for (const absolute of files) {
    const mod = callGraph.moduleAt(absolute);
    if (!mod || !USE_SERVER_RE.test(mod.sourceFile.text)) continue;
    for (const [action, fn] of serverActionFunctions(indexModule(mod.sourceFile))) {
      const line = mod.sourceFile.getLineAndCharacterOfPosition(fn.getStart(mod.sourceFile)).line + 1;
      actions.push({ file: toRepo(absolute), absolute, action, line, key: callGraph.keyOf(mod, fn) });
    }
  }

  const order = callGraph.closure(actions.map((a) => a.key));
  const reaches = propagate(callGraph, order, (key) => pushKeys.has(key));

  // Least fixpoint: the helpers, then wrappers that authorize on every way they return normally. A
  // function on the way to a push is judged by `safe` below instead.
  const authorizes = new Map(order.map((key) => [key, authorizerKeys.has(key)]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const key of order) {
      if (authorizes.get(key) || reaches.get(key)) continue;
      if (authorizesOnEveryExit(callGraph, key, authorizes)) {
        authorizes.set(key, true);
        grew = true;
      }
    }
  }

  const levelMemo = new Map();
  const levelsOf = (key) => {
    if (!levelMemo.has(key)) levelMemo.set(key, authorizerLevels(callGraph, key, authorizes));
    return levelMemo.get(key);
  };
  // A call toward a push, in function `key`, that no counted authorizer call protects and that goes
  // to the push itself or to a function that is not safe. Each such call is checked on its own.
  const exposed = (key, edge, safeMap) =>
    Boolean(reaches.get(edge.key)) &&
    !levelsOf(key).some((level) => dominates(level, edge.node)) &&
    (pushKeys.has(edge.key) || !safeMap.get(edge.key));

  // Greatest fixpoint: safe unless some call toward a push is exposed.
  const safe = new Map(order.filter((key) => reaches.get(key) && !pushKeys.has(key)).map((key) => [key, true]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of safe.keys()) {
      if (!safe.get(key)) continue;
      if (callGraph.edgesOf(key).some((edge) => exposed(key, edge, safe))) {
        safe.set(key, false);
        changed = true;
      }
    }
  }

  const label = (key, entryFile) => {
    if (pushKeys.has(key)) return pushKeys.get(key);
    const [file, name] = key.includes('#') ? key.split('#') : [key.slice(0, key.lastIndexOf('@')), '(inline action)'];
    return file === entryFile ? name : `${name} (${toRepo(file)})`;
  };

  const reaching = [];
  for (const action of actions) {
    if (!reaches.get(action.key)) continue;
    reaching.push(`${action.file}#${action.action}`);
    if (safe.get(action.key)) continue;
    const chain = [action.action];
    const visited = new Set([action.key]);
    let current = action.key;
    // The deepest unprotected call on the chain: the one that reaches the push itself.
    let callSite = null;
    while (!pushKeys.has(current)) {
      const next = callGraph.edgesOf(current).find((edge) => !visited.has(edge.key) && exposed(current, edge, safe));
      if (!next) break;
      const sourceFile = next.node.getSourceFile();
      callSite = `${toRepo(sourceFile.fileName)}:${sourceFile.getLineAndCharacterOfPosition(next.pos).line + 1}`;
      visited.add(next.key);
      chain.push(label(next.key, action.absolute));
      current = next.key;
    }
    const shown = action.action.startsWith('(') ? action.action : `${action.action}()`;
    problems.push({
      file: action.file,
      line: action.line,
      action: action.action,
      push: pushKeys.get(current) ?? null,
      callSite,
      problem:
        `${action.file}:${action.line} server action ${shown} reaches a Freemius coupon push (${chain.join(' -> ')})` +
        (callSite === null ? '' : ` through the call at ${callSite}`) +
        ' with no requireEcomAdmin() or requireCmsAdmin() before it on every path. The push is signed with the developer key pair ' +
        '(every product of the account), so authorize an ADMIN whose second factor has passed first: await the helper itself ' +
        '(no .catch() or .then()) as a statement, an initializer or an assignment, in the block that holds the call or an enclosing ' +
        'one (inside a try only when its catch ends in return or throw; never in a catch, a finally or one branch only)',
    });
  }

  return {
    reaching: reaching.sort(),
    problems: problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)),
  };
}

/** The exports of a coupons module that reach its request helper, sorted. */
function findCouponPushExports(absolute = fromRepo(FREEMIUS_COUPONS_MODULE), request = FREEMIUS_COUPON_REQUEST) {
  const requestKey = `${absolute}#${request}`;
  const graph = createCallGraph({ resolveImport: null, leaves: new Set([requestKey]) });
  const mod = graph.moduleAt(absolute);
  if (!mod) return [];
  const exported = [...mod.exports.entries()].filter(([, entry]) => entry.local && mod.functions.has(entry.local));
  const keys = exported.map(([, entry]) => `${absolute}#${entry.local}`);
  const order = graph.closure(keys);
  const reaches = propagate(graph, order, (key) => key === requestKey);
  return exported.filter(([, entry]) => reaches.get(`${absolute}#${entry.local}`)).map(([name]) => name).sort();
}

/** Repository-wide: `{ reaching, problems }` over every module with a server action. */
function findUnauthorizedCouponPushes(modules = scanRepository(), resolveImport = createResolver()) {
  return analyzeCouponPushActions(
    serverActionSources(modules).map(([mod]) => mod.absolute),
    {
      resolveImport,
      pushes: FREEMIUS_COUPON_PUSHES.map((name) => [fromRepo(FREEMIUS_COUPONS_MODULE), name]),
      authorizers: ADMIN_AUTHORIZERS.map(([file, name]) => [fromRepo(file), name]),
    }
  );
}

/* --------------------------- a role read on the way to the service role needs the second factor --- */

// 2026-11-13: server actions under app/cms and app/actions read the caller's role (a profiles read
// through the cookie client, or getProfileWithRoleServerSide) and then reached the service role,
// which no aal2 policy can stop, with no second-factor check: the interaction reply and moderation
// actions, the language detection settings, the contact-form endpoint read of the block editor,
// "Send test email" (sendEmail reads the SMTP credentials with the service role) and the GitHub
// connect poll (markSyncWorkflowInstalled writes system_configuration). A server action never
// passes the CMS layout's 2FA redirect, so an ADMIN password alone reached each of them.
//
// This check follows calls out of every server action defined in a module under app/cms or
// app/actions (the call graph above: relative and aliased imports, barrels, dynamic imports,
// functions passed as arguments; method calls on objects and module-level bindings are not
// followed), and fails an action that can reach both
// - a role read: a `.from('profiles')` query whose select names `role` (or `*`, unless the select
//   is a head-only count), on any client, or getProfileWithRoleServerSide() (ROLE_READERS); and
// - the service role: getServiceRoleSupabaseClient() (SERVICE_ROLE_SOURCES), or a function that
//   builds a supabase-js client and reads the secret key itself (resolveSupabaseServiceKey(), or
//   process.env). A key read alone is not the service role: the key also derives HMAC secrets
//   (lib/app-secrets.ts, the storefront token) and picks the storage backend;
// and none of the helpers that resolve the actor with the enrolled second factor
// (SECOND_FACTOR_HELPERS). The helpers are leaves, so their own role read and service client never
// count. It is a presence check, narrower than the coupon-push rule: it does not prove that the
// helper runs first or that its answer is honored (the per-action tests do). It is scoped to the
// CMS trees and app/actions because the public flows elsewhere reach the service role by design.
// Exceptions live in the test's reviewed list, each with why; a stale one fails.

/** Repo-relative path prefixes whose server actions the check reads. */
const SECOND_FACTOR_SCOPES = ['apps/nextblock/app/cms/', 'apps/nextblock/app/actions/'];

/** The helpers that resolve the actor with the enrolled second factor (each reads the role itself). */
const SECOND_FACTOR_HELPERS = [
  ['apps/nextblock/lib/auth/cms-actor.ts', 'requireCmsAdmin'],
  ['apps/nextblock/lib/auth/cms-actor.ts', 'requireCmsStaff'],
  ['apps/nextblock/lib/auth/cms-actor.ts', 'getCmsActor'],
  ['libs/ecommerce/src/lib/server-actions/require-ecom-role.ts', 'requireEcomAdmin'],
  ['libs/ecommerce/src/lib/server-actions/require-ecom-role.ts', 'requireEcomStaff'],
  ['apps/nextblock/lib/affiliates/retailer-actor.ts', 'requireRetailer'],
  ['apps/nextblock/lib/affiliates/retailer-actor.ts', 'requireRetailerPage'],
  ['libs/cortex/src/lib/ai-global-agent-theming-tools.ts', 'requireActorRole'],
];

/** Functions that hand out the service-role client. */
const SERVICE_ROLE_SOURCES = [['libs/db/src/lib/supabase/server.ts', 'getServiceRoleSupabaseClient']];

/** Functions that hand out the secret key: the service role where the same function builds a client with it. */
const SECRET_KEY_READERS = [['apps/nextblock/lib/setup/service-key.ts', 'resolveSupabaseServiceKey']];

/** Functions that read the caller's role through the cookie client and return it. */
const ROLE_READERS = [['libs/db/src/lib/supabase/server.ts', 'getProfileWithRoleServerSide']];

const SECRET_KEY_ENV_NAMES = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);

/** `process.env.SUPABASE_SERVICE_ROLE_KEY`, `process.env['SUPABASE_SECRET_KEY']` and the like. */
function isSecretKeyEnvRead(node) {
  let name = null;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) name = node.name.text;
  else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) name = node.argumentExpression.text;
  if (!name || !SECRET_KEY_ENV_NAMES.has(name)) return false;
  const object = unwrapErased(node.expression);
  return (
    Boolean(object) &&
    ts.isPropertyAccessExpression(object) &&
    object.name.text === 'env' &&
    ts.isIdentifier(object.expression) &&
    object.expression.text === 'process'
  );
}

/** The top-level column names of a PostgREST select string (embedded resources and aliases dropped). */
function selectedColumns(text) {
  const columns = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      columns.push(current);
      current = '';
    } else if (depth === 0) current += ch;
  }
  columns.push(current);
  return columns.map((column) => column.trim().replace(/^[\w-]+:/, '').replace(/::[\w\s]+$/, '').trim()).filter(Boolean);
}

/** True for `x.select('id, role')` or a `select('*')` that is not a head-only count. */
function selectNamesRole(call) {
  const [columnsArg, optionsArg] = call.arguments;
  const columnsNode = columnsArg ? unwrapErased(columnsArg) : null;
  if (!columnsNode || !ts.isStringLiteralLike(columnsNode)) return false;
  const columns = selectedColumns(columnsNode.text);
  if (columns.includes('role')) return true;
  if (!columns.includes('*')) return false;
  const options = optionsArg ? unwrapErased(optionsArg) : null;
  const headOnly =
    Boolean(options) &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === 'head' &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword
    );
  return !headOnly;
}

/** True when `call` is `<client>.from('profiles')` and a later `.select()` in its chain names the role. */
function isProfilesRoleRead(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'from') return false;
  const table = call.arguments[0] ? unwrapErased(call.arguments[0]) : null;
  if (!table || !ts.isStringLiteralLike(table) || table.text !== 'profiles') return false;
  let node = call;
  while (
    node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.parent &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent
  ) {
    const next = node.parent.parent;
    if (node.parent.name.text === 'select' && selectNamesRole(next)) return true;
    node = next;
  }
  return false;
}

/** 1-based line of a node, as `file:line` relative to `root`. */
function siteOf(node, root) {
  const sourceFile = node.getSourceFile();
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${path.relative(root, sourceFile.fileName).split(path.sep).join('/')}:${line}`;
}

/**
 * The call graph both role-read checks walk, and `reach(key)`: whether calling that function can
 * reach a second-factor helper, a role read and the service role. `helpers`, `sources`,
 * `keyReaders` and `roleReaders` are [absolute path, export name] pairs; `problems` starts with
 * the listed ones that no longer resolve.
 */
function createRoleReadReach({ resolveImport, root, helpers, sources, keyReaders, roleReaders }) {
  const toRepo = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  const leaves = new Set();
  const callGraph = createCallGraph({ resolveImport, leaves });
  const problems = [];
  const keysOf = (pairs, list) => {
    const keys = new Set();
    for (const [absolute, name] of pairs) {
      const key = callGraph.resolveExport(absolute, name);
      if (key) keys.add(key);
      else problems.push({ file: toRepo(absolute), problem: `${toRepo(absolute)} no longer exports ${name}(); update ${list}` });
    }
    return keys;
  };
  const helperKeys = keysOf(helpers, 'SECOND_FACTOR_HELPERS');
  const sourceKeys = keysOf(sources, 'SERVICE_ROLE_SOURCES');
  const keyReaderKeys = keysOf(keyReaders, 'SECRET_KEY_READERS');
  const readerKeys = keysOf(roleReaders, 'ROLE_READERS');
  for (const key of [...helperKeys, ...sourceKeys, ...keyReaderKeys, ...readerKeys]) leaves.add(key);

  const moduleOfKey = (key) => {
    const hash = key.indexOf('#');
    return callGraph.moduleAt(hash >= 0 ? key.slice(0, hash) : key.slice(0, key.lastIndexOf('@')));
  };

  /** `createClient(...)` imported from @supabase/supabase-js (named, renamed, or through `import * as`). */
  const buildsSupabaseJsClient = (mod, call) => {
    const callee = unwrapErased(call.expression);
    if (!mod || !callee) return false;
    if (ts.isIdentifier(callee)) {
      const imported = mod.imports.get(callee.text);
      return Boolean(imported) && imported.spec === '@supabase/supabase-js' && imported.imported === 'createClient';
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createClient' && ts.isIdentifier(callee.expression)) {
      return mod.namespaces.get(callee.expression.text) === '@supabase/supabase-js';
    }
    return false;
  };

  // What a function does itself (its whole body, nested functions included, as edgesOf reads it).
  const directMemo = new Map();
  const direct = (key) => {
    if (directMemo.has(key)) return directMemo.get(key);
    const found = { roleRead: null, serviceRole: null };
    const fn = callGraph.functionAt(key);
    let keyRead = null;
    let buildsClient = false;
    if (fn?.body && !leaves.has(key)) {
      const mod = moduleOfKey(key);
      const visit = (node) => {
        if (!found.roleRead && ts.isCallExpression(node) && isProfilesRoleRead(node)) found.roleRead = node;
        if (!keyRead && isSecretKeyEnvRead(node)) keyRead = node;
        if (!buildsClient && ts.isCallExpression(node) && buildsSupabaseJsClient(mod, node)) buildsClient = true;
        ts.forEachChild(node, visit);
      };
      visit(fn.body);
    }
    for (const edge of callGraph.edgesOf(key)) {
      if (!found.roleRead && readerKeys.has(edge.key)) found.roleRead = edge.node;
      if (!found.serviceRole && sourceKeys.has(edge.key)) found.serviceRole = edge.node;
      if (!keyRead && keyReaderKeys.has(edge.key)) keyRead = edge.node;
    }
    if (!found.serviceRole && keyRead && buildsClient) found.serviceRole = keyRead;
    directMemo.set(key, found);
    return found;
  };

  /** What calling `key` can reach: a second-factor helper, a role read (node), the service role (node). */
  const reach = (key) => {
    let roleRead = null;
    let serviceRole = null;
    let helper = false;
    for (const reached of callGraph.closure([key])) {
      if (helperKeys.has(reached)) helper = true;
      const found = direct(reached);
      roleRead = roleRead ?? found.roleRead;
      serviceRole = serviceRole ?? found.serviceRole;
    }
    return { helper, roleRead, serviceRole };
  };

  return { callGraph, problems, reach, toRepo };
}

/**
 * Server actions in `files` that can reach a role read and the service role but no second-factor
 * helper. `helpers`, `sources`, `keyReaders` and `roleReaders` are [absolute path, export name]
 * pairs. Returns `{ actions, problems }`: every action checked (`file#action`) and the failures.
 */
function analyzeRoleReadsBeforeServiceRole(
  files,
  { resolveImport = null, root = REPO_ROOT, helpers, sources, keyReaders = [], roleReaders }
) {
  const { callGraph, problems, reach, toRepo } = createRoleReadReach({ resolveImport, root, helpers, sources, keyReaders, roleReaders });

  const actions = [];
  for (const absolute of files) {
    const mod = callGraph.moduleAt(absolute);
    if (!mod || !USE_SERVER_RE.test(mod.sourceFile.text)) continue;
    for (const [action, fn] of serverActionFunctions(indexModule(mod.sourceFile))) {
      const line = mod.sourceFile.getLineAndCharacterOfPosition(fn.getStart(mod.sourceFile)).line + 1;
      const key = callGraph.keyOf(mod, fn);
      actions.push(`${toRepo(absolute)}#${action}`);

      const { helper, roleRead, serviceRole } = reach(key);
      if (helper || !roleRead || !serviceRole) continue;
      const shown = action.startsWith('(') ? action : `${action}()`;
      problems.push({
        file: toRepo(absolute),
        line,
        action,
        roleRead: siteOf(roleRead, root),
        serviceRole: siteOf(serviceRole, root),
        problem:
          `${toRepo(absolute)}:${line} server action ${shown} reads the role (${siteOf(roleRead, root)}) and reaches the ` +
          `service role (${siteOf(serviceRole, root)}) with no second-factor helper. A role read alone checks the first ` +
          'factor only, and server actions never pass the CMS layout\'s 2FA redirect: resolve the actor with ' +
          'requireCmsAdmin() / requireCmsStaff() / getCmsActor() (or requireEcomAdmin() / requireEcomStaff(), ' +
          'requireRetailer(), requireActorRole()) and take the service-role client after it',
      });
    }
  }

  return {
    actions: actions.sort(),
    problems: problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)),
  };
}

/** Repository-wide: the check over every server action module under SECOND_FACTOR_SCOPES. */
function findRoleReadsBeforeServiceRole(modules = scanRepository(), resolveImport = createResolver()) {
  return analyzeRoleReadsBeforeServiceRole(
    serverActionSources(modules)
      .filter(([mod]) => SECOND_FACTOR_SCOPES.some((scope) => mod.repoPath.startsWith(scope)))
      .map(([mod]) => mod.absolute),
    {
      resolveImport,
      helpers: SECOND_FACTOR_HELPERS.map(([file, name]) => [fromRepo(file), name]),
      sources: SERVICE_ROLE_SOURCES.map(([file, name]) => [fromRepo(file), name]),
      keyReaders: SECRET_KEY_READERS.map(([file, name]) => [fromRepo(file), name]),
      roleReaders: ROLE_READERS.map(([file, name]) => [fromRepo(file), name]),
    }
  );
}

/* ------------------------ staff upload routes resolve the actor, second factor included, first --- */

// The staff upload route handlers sign upload URLs for the deployment's bucket, read and write its
// objects with the storage credentials, and record media rows. A route handler never passes the
// CMS layout's 2FA redirect, and until 2026-11-14 all five read the role through the cookie client,
// so a staff password alone (the first factor) drove them. Each exported handler of
// STAFF_UPLOAD_ROUTES must now open with the second-factor gate, read from the structure of the
// code the way the coupon-push check reads an authorizer:
// - `const <actor> = await getCmsActor()`: the real helper (lib/auth/cms-actor.ts; a local or a
//   parameter of that name never counts), awaited as a whole `const` statement binding one plain
//   name, standing in the handler body, or in a try block whose catch ends in `return` / `throw`
//   and that stands there itself;
// - after it, in the same block, an `if` that refuses a missing actor (`!<actor>`, `<actor> ==
//   null`) and an `if` that refuses by its role (`<actor>.role`), each with a then-branch that
//   cannot complete normally (one `if` may do both);
// - every privileged operation of the handler placed after both refusals: a call that reaches the
//   service role, a storage client or the URL signer (STAFF_ROUTE_SINKS, followed through calls
//   across modules), a database query (`.from('<table>')`, `.rpc()`, `.storage`) or an S3
//   `.send()` written in the handler or in a function it calls, and a read of the request body
//   (`request.json()` and the other body readers, `request.body`, or the request handed to a call).
// So a session whose factor is pending is refused before any body read, storage call or database
// query. A route file under STAFF_UPLOAD_ROUTE_SCOPES that the list leaves out is reported too, so
// a new upload route is either gated the same way or reviewed (the test's exceptions, each with why).

/** Directories whose route handlers are staff upload routes, or are reviewed in the test. */
const STAFF_UPLOAD_ROUTE_SCOPES = [
  'apps/nextblock/app/api/media/',
  'apps/nextblock/app/api/process-image/',
  'apps/nextblock/app/api/upload/',
];

/** The staff upload routes: every exported handler opens with the second-factor gate. */
const STAFF_UPLOAD_ROUTES = [
  'apps/nextblock/app/api/media/r2-presigned/route.ts',
  'apps/nextblock/app/api/media/record/route.ts',
  'apps/nextblock/app/api/process-image/route.ts',
  'apps/nextblock/app/api/upload/presigned-url/route.ts',
  'apps/nextblock/app/api/upload/proxy/route.ts',
];

/** The gate: the caller, once any enrolled second factor has passed; null without a session or while one is pending. */
const STAFF_ROUTE_GATE = ['apps/nextblock/lib/auth/cms-actor.ts', 'getCmsActor'];

/** Functions a staff upload route may reach only after the gate: the service role, the storage clients, the signer. */
const STAFF_ROUTE_SINKS = [
  ...SERVICE_ROLE_SOURCES,
  ['libs/utils/src/server.ts', 'getS3Client'],
  ['libs/utils/src/server.ts', 'getS3PresignClient'],
  ['apps/nextblock/lib/storage/presigned-put.ts', 'presignBoundPut'],
];

const HTTP_METHOD_HANDLERS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);

/** Methods that read (or copy) the request body. */
const REQUEST_BODY_READERS = new Set(['arrayBuffer', 'blob', 'bytes', 'clone', 'formData', 'json', 'text']);

const ROUTE_FILE_RE = /(^|\/)route\.[cm]?[jt]sx?$/;

/** True when `expression` is the identifier `name` (parentheses and type assertions erased). */
function isNamed(expression, name) {
  const inner = expression ? unwrapErased(expression) : null;
  return Boolean(inner) && ts.isIdentifier(inner) && inner.text === name;
}

/** True when `condition` reads `test(node)` somewhere outside nested functions. */
function conditionHas(condition, test) {
  let found = false;
  const visit = (node) => {
    if (found || isFunctionBoundary(node)) return;
    if (test(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(condition);
  return found;
}

/** `!actor`, or `actor == null` / `=== null` / `=== undefined`, anywhere in the condition. */
function testsMissingActor(condition, name) {
  const isNullish = (side) => {
    const inner = unwrapErased(side);
    return inner.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(inner) && inner.text === 'undefined');
  };
  return conditionHas(condition, (node) => {
    if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken && isNamed(node.operand, name);
    if (!ts.isBinaryExpression(node)) return false;
    const kind = node.operatorToken.kind;
    if (kind !== ts.SyntaxKind.EqualsEqualsToken && kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    return (isNamed(node.left, name) && isNullish(node.right)) || (isNamed(node.right, name) && isNullish(node.left));
  });
}

/** `actor.role` (or `actor?.role`) anywhere in the condition. */
function testsActorRole(condition, name) {
  return conditionHas(condition, (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'role' && isNamed(node.expression, name));
}

/**
 * The database, storage and request-body operations written in a function's body (nested functions
 * included), as `[node, label]`. Request-body reads are looked for only when `requestName` names the
 * handler's request parameter.
 */
function writtenPrivilegedOperations(fn, requestName) {
  const found = [];
  const handsRequest = (args) => Boolean(requestName) && (args ?? []).some((argument) => isNamed(argument, requestName));
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapErased(node.expression);
      if (callee && ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const object = unwrapErased(callee.expression);
        const first = node.arguments[0] ? unwrapErased(node.arguments[0]) : null;
        if (method === 'from' && first && ts.isStringLiteralLike(first)) found.push([node, `.from('${first.text}')`]);
        else if (method === 'rpc') found.push([node, '.rpc()']);
        else if (method === 'send') found.push([node, '.send()']);
        else if (object && ts.isPropertyAccessExpression(object) && object.name.text === 'storage') found.push([node, '.storage']);
        else if (requestName && REQUEST_BODY_READERS.has(method) && isNamed(object, requestName)) {
          found.push([node, `${requestName}.${method}()`]);
        }
      }
      if (handsRequest(node.arguments)) found.push([node, `a call handed ${requestName}`]);
    } else if (ts.isNewExpression(node)) {
      if (handsRequest(node.arguments)) found.push([node, `a constructor handed ${requestName}`]);
    } else if (requestName && ts.isPropertyAccessExpression(node) && node.name.text === 'body' && isNamed(node.expression, requestName)) {
      found.push([node, `${requestName}.body`]);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/** `[exported name, function | null]` for every HTTP method a route module exports (null: defined elsewhere). */
function routeHandlerFunctions(mod) {
  const handlers = [];
  for (const [exported, entry] of mod.exports) {
    if (!HTTP_METHOD_HANDLERS.has(exported)) continue;
    handlers.push([exported, entry.spec === undefined ? (mod.functions.get(entry.local) ?? null) : null]);
  }
  return handlers.sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The staff route handlers in `files` that do not open with the second-factor gate. `gate` is an
 * [absolute path, export name] pair and `sinks` a list of them; `listName` names the list `files`
 * came from in the problems. Returns `{ handlers, problems }`: every handler checked
 * (`file#METHOD`) and the failures, each with a `kind`.
 */
function analyzeStaffRouteGates(files, { resolveImport = null, root = REPO_ROOT, gate, sinks, listName = 'STAFF_UPLOAD_ROUTES' }) {
  const toRepo = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  const leaves = new Set();
  const callGraph = createCallGraph({ resolveImport, leaves });
  const problems = [];
  const handlers = [];
  const report = (file, kind, problem, extra = {}) => problems.push({ file, kind, problem, ...extra });

  const gateKey = callGraph.resolveExport(gate[0], gate[1]);
  if (!gateKey) report(toRepo(gate[0]), 'gate-missing', `${toRepo(gate[0])} no longer exports ${gate[1]}(); update STAFF_ROUTE_GATE`);
  else leaves.add(gateKey);
  const sinkKeys = new Set();
  for (const [absolute, name] of sinks) {
    const key = callGraph.resolveExport(absolute, name);
    if (key) sinkKeys.add(key);
    else report(toRepo(absolute), 'sink-missing', `${toRepo(absolute)} no longer exports ${name}(); update STAFF_ROUTE_SINKS`);
  }
  for (const key of sinkKeys) leaves.add(key);

  // Whether calling `key` can reach a sink, or a function that queries the database or storage itself.
  const ownOperationMemo = new Map();
  const hasOwnOperation = (key) => {
    if (!ownOperationMemo.has(key)) {
      const fn = callGraph.functionAt(key);
      ownOperationMemo.set(key, Boolean(fn) && !leaves.has(key) && writtenPrivilegedOperations(fn, null).length > 0);
    }
    return ownOperationMemo.get(key);
  };
  const reachMemo = new Map();
  const reachesPrivileged = (key) => {
    if (!reachMemo.has(key)) {
      reachMemo.set(key, key !== gateKey && callGraph.closure([key]).some((reached) => sinkKeys.has(reached) || hasOwnOperation(reached)));
    }
    return reachMemo.get(key);
  };

  for (const absolute of files) {
    const file = toRepo(absolute);
    const mod = callGraph.moduleAt(absolute);
    if (!mod) {
      report(file, 'route-missing', `${file} is listed in ${listName} but cannot be read; update the list`);
      continue;
    }
    const found = routeHandlerFunctions(mod);
    if (found.length === 0) report(file, 'no-handler', `${file} exports no HTTP method handler; update ${listName}`);
    for (const [handler, fn] of found) {
      handlers.push(`${file}#${handler}`);
      const line = fn ? mod.sourceFile.getLineAndCharacterOfPosition(fn.getStart(mod.sourceFile)).line + 1 : 1;
      const where = `${file}:${line} ${handler}()`;
      const fail = (kind, detail, extra = {}) => report(file, kind, `${where} ${detail}`, { handler, line, ...extra });
      if (!fn || !fn.body || !ts.isBlock(fn.body)) {
        fail('no-gate', 'is not a function with a body in this module, so the gate cannot be checked: define the handler here');
        continue;
      }
      const key = callGraph.keyOf(mod, fn);

      let gateStatement = null;
      let actorName = null;
      for (const edge of callGraph.edgesOf(key)) {
        if (edge.key !== gateKey || !edge.call || isShadowedCall(edge.call, fn)) continue;
        const statement = authorizerStatement(edge.call);
        if (!statement || !ts.isVariableStatement(statement)) continue;
        const list = statement.declarationList;
        if ((list.flags & ts.NodeFlags.Const) === 0 || list.declarations.length !== 1) continue;
        const declaration = list.declarations[0];
        if (!ts.isIdentifier(declaration.name)) continue;
        const levels = dominanceLevels(statement);
        if (levels.length === 0 || levels[levels.length - 1].block !== fn.body) continue;
        gateStatement = statement;
        actorName = declaration.name.text;
        break;
      }
      if (!gateStatement) {
        fail(
          'no-gate',
          'does not open with `const actor = await getCmsActor()` (lib/auth/cms-actor.ts) in its body or in a try block whose ' +
            'catch returns. A route handler never passes the CMS layout\'s 2FA redirect, and a role read checks the first factor ' +
            'only: resolve the caller with getCmsActor() and refuse a missing actor and a role outside the route\'s rule first'
        );
        continue;
      }

      const siblings = gateStatement.parent.statements;
      const after = siblings.slice(siblings.indexOf(gateStatement) + 1);
      const refuses = (statement) => ts.isIfStatement(statement) && !canCompleteNormally(statement.thenStatement);
      const missingGuard = after.find((statement) => refuses(statement) && testsMissingActor(statement.expression, actorName));
      const roleGuard = after.find((statement) => refuses(statement) && testsActorRole(statement.expression, actorName));
      if (!missingGuard) {
        fail('no-missing-check', `does not refuse a missing actor after the gate: \`if (!${actorName}) return …\` (no session, or a second factor pending)`);
      }
      if (!roleGuard) fail('no-role-check', `does not refuse by role after the gate: \`if (!isCmsStaffRole(${actorName}.role)) return …\``);
      if (!missingGuard || !roleGuard) continue;

      const requestParameter = fn.parameters[0];
      const requestName = requestParameter && ts.isIdentifier(requestParameter.name) ? requestParameter.name.text : null;
      const operations = writtenPrivilegedOperations(fn, requestName);
      for (const edge of callGraph.edgesOf(key)) {
        if (edge.key === gateKey) continue;
        if (reachesPrivileged(edge.key)) operations.push([edge.node, `${edge.node.getText(mod.sourceFile)}()`]);
      }
      const runsAfter = (guard, node) => dominanceLevels(guard).some((level) => dominates(level, node));
      for (const [node, label] of operations) {
        if (runsAfter(missingGuard, node) && runsAfter(roleGuard, node)) continue;
        const site = siteOf(node, root);
        fail('ungated-operation', `runs ${label} (${site}) where the gate's refusals do not cover it: move it after them`, { operation: label, site });
      }
    }
  }

  return {
    handlers: handlers.sort(),
    problems: problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)),
  };
}

/**
 * Repository-wide: the gate check over STAFF_UPLOAD_ROUTES, plus `unlisted`, the route modules under
 * STAFF_UPLOAD_ROUTE_SCOPES that the list leaves out (the test compares them with its reviewed list).
 */
function findStaffUploadRouteGates(modules = scanRepository(), resolveImport = createResolver()) {
  const result = analyzeStaffRouteGates(STAFF_UPLOAD_ROUTES.map(fromRepo), {
    resolveImport,
    gate: [fromRepo(STAFF_ROUTE_GATE[0]), STAFF_ROUTE_GATE[1]],
    sinks: STAFF_ROUTE_SINKS.map(([file, name]) => [fromRepo(file), name]),
  });
  const unlisted = [...modules.values()]
    .map((mod) => mod.repoPath)
    .filter(
      (repoPath) =>
        STAFF_UPLOAD_ROUTE_SCOPES.some((scope) => repoPath.startsWith(scope)) &&
        ROUTE_FILE_RE.test(repoPath) &&
        !STAFF_UPLOAD_ROUTES.includes(repoPath)
    )
    .sort();
  return { ...result, unlisted };
}

/* ----------------- the other staff routes, and every route handler that reads the role, too --- */

// The upload pass left six staff route handlers outside those folders on a cookie-client role read
// (fixed the same day, 2026-11-14): /api/cms/ecommerce/product-picker (the product catalog, drafts
// included, through the service role), /api/cms/check-updates (refreshUpstreamStatus writes
// system_configuration with the service role), and /api/ai/generate-blocks, /api/ai/seo/metadata,
// /api/ai/seo/alt-text and /api/ai/cortex/build-widget (the Cortex AI request quota, recorded with
// the service role, then the operator's model key). A staff password alone drove them. Two checks
// keep the class closed:
// - STAFF_ROUTES: every exported handler opens with the second-factor gate and refuses before any
//   privileged operation, read exactly as the upload routes are (analyzeStaffRouteGates, with the
//   Cortex AI client as one more sink), and a route module under STAFF_ROUTE_SCOPES that the list
//   leaves out is reported, so a new CMS or AI route is either gated or reviewed (the test's
//   exceptions, each with why);
// - every route handler of the app (ROUTE_HANDLER_SCOPES), wherever it lives: one that can reach a
//   role read and the service role but none of SECOND_FACTOR_HELPERS fails. It is the presence check
//   the server actions have had since 2026-11-13 (findRoleReadsBeforeServiceRole), and like it, it
//   does not prove the helper runs first; the gate list and the route tests do. Exceptions live in
//   the test's reviewed list, each with why; a stale one fails.

/** Directories whose route handlers are staff routes (STAFF_ROUTES), or are reviewed in the test. */
const STAFF_ROUTE_SCOPES = ['apps/nextblock/app/api/ai/', 'apps/nextblock/app/api/cms/'];

/** Staff routes outside the upload folders: every exported handler opens with the second-factor gate. */
const STAFF_ROUTES = [
  'apps/nextblock/app/api/ai/cortex/build-widget/route.ts',
  'apps/nextblock/app/api/ai/generate-blocks/route.ts',
  'apps/nextblock/app/api/ai/seo/alt-text/route.ts',
  'apps/nextblock/app/api/ai/seo/metadata/route.ts',
  'apps/nextblock/app/api/cms/check-updates/route.ts',
  'apps/nextblock/app/api/cms/ecommerce/product-picker/route.ts',
];

/** What those routes may reach only after the gate: the upload sinks, plus the operator's model key. */
const STAFF_ROUTE_AI_SINKS = [...STAFF_ROUTE_SINKS, ['libs/cortex/src/lib/ai-client.ts', 'createCortexAiOpenRouterClient']];

/** Repo-relative path prefixes whose route handlers the role-read check reads: every route module of the app. */
const ROUTE_HANDLER_SCOPES = ['apps/nextblock/app/'];

/** The route modules (repo-relative) of the scan that sit under one of `scopes`, sorted. */
function routeModulesUnder(modules, scopes) {
  return [...modules.values()]
    .map((mod) => mod.repoPath)
    .filter((repoPath) => scopes.some((scope) => repoPath.startsWith(scope)) && ROUTE_FILE_RE.test(repoPath))
    .sort();
}

/**
 * Repository-wide: the gate check over STAFF_ROUTES, plus `unlisted`, the route modules under
 * STAFF_ROUTE_SCOPES that the list leaves out (the test compares them with its reviewed list).
 */
function findStaffRouteGates(modules = scanRepository(), resolveImport = createResolver()) {
  const result = analyzeStaffRouteGates(STAFF_ROUTES.map(fromRepo), {
    resolveImport,
    gate: [fromRepo(STAFF_ROUTE_GATE[0]), STAFF_ROUTE_GATE[1]],
    sinks: STAFF_ROUTE_AI_SINKS.map(([file, name]) => [fromRepo(file), name]),
    listName: 'STAFF_ROUTES',
  });
  const unlisted = routeModulesUnder(modules, STAFF_ROUTE_SCOPES).filter((repoPath) => !STAFF_ROUTES.includes(repoPath));
  return { ...result, unlisted };
}

/** `export const PATCH = PUT`: the name a top-level const binds to another binding, or null. */
function constAliasOf(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      const value = unwrapErased(declaration.initializer);
      return value && ts.isIdentifier(value) ? value.text : null;
    }
  }
  return null;
}

/**
 * The function a route module's HTTP export runs: through re-exports, and through a const alias
 * of a function of the module or of an import (`export const PATCH = PUT`). Null for anything else.
 */
function routeHandlerKey(callGraph, mod, handler, resolveImport) {
  const key = callGraph.resolveExport(mod.absolute, handler);
  if (key) return key;
  const entry = mod.exports.get(handler);
  if (!entry || entry.spec !== undefined) return null;
  const seen = new Set([entry.local]);
  let alias = constAliasOf(mod.sourceFile, entry.local);
  while (alias && !seen.has(alias)) {
    seen.add(alias);
    if (mod.functions.has(alias)) return `${mod.absolute}#${alias}`;
    const imported = mod.imports.get(alias);
    if (imported) {
      const target = resolveImport ? resolveImport(mod.absolute, imported.spec) : null;
      return target ? callGraph.resolveExport(target, imported.imported) : null;
    }
    alias = constAliasOf(mod.sourceFile, alias);
  }
  return null;
}

/**
 * Route handlers in `files` (route modules) that can reach a role read and the service role but no
 * second-factor helper; the options are analyzeRoleReadsBeforeServiceRole's. A handler this check
 * cannot read as a function fails too. Returns `{ handlers, problems }`: every handler checked
 * (`file#METHOD`) and the failures.
 */
function analyzeRouteRoleReadsBeforeServiceRole(
  files,
  { resolveImport = null, root = REPO_ROOT, helpers, sources, keyReaders = [], roleReaders }
) {
  const { callGraph, problems, reach, toRepo } = createRoleReadReach({ resolveImport, root, helpers, sources, keyReaders, roleReaders });

  const handlers = [];
  for (const absolute of files) {
    const file = toRepo(absolute);
    const mod = callGraph.moduleAt(absolute);
    if (!mod) {
      problems.push({ file, problem: `${file} cannot be read, so its route handlers cannot be checked` });
      continue;
    }
    for (const [handler] of routeHandlerFunctions(mod)) {
      handlers.push(`${file}#${handler}`);
      const key = routeHandlerKey(callGraph, mod, handler, resolveImport);
      const fn = key ? callGraph.functionAt(key) : null;
      if (!fn) {
        problems.push({
          file,
          handler,
          problem: `${file} ${handler}() is not a function this check can read (define it in the module, or re-export one), so it cannot be checked`,
        });
        continue;
      }
      const own = fn.getSourceFile() === mod.sourceFile;
      const line = own ? mod.sourceFile.getLineAndCharacterOfPosition(fn.getStart(mod.sourceFile)).line + 1 : 1;

      const { helper, roleRead, serviceRole } = reach(key);
      if (helper || !roleRead || !serviceRole) continue;
      problems.push({
        file,
        line,
        handler,
        roleRead: siteOf(roleRead, root),
        serviceRole: siteOf(serviceRole, root),
        problem:
          `${file}:${line} route handler ${handler}() reads the role (${siteOf(roleRead, root)}) and reaches the service role ` +
          `(${siteOf(serviceRole, root)}) with no second-factor helper. A role read alone checks the first factor only, and a ` +
          'route handler never passes the CMS layout\'s 2FA redirect: open it with `const actor = await getCmsActor()`, refuse ' +
          'a missing actor and a role outside the route\'s rule before anything else (requireRetailer() for a partner route), ' +
          'and list a staff route in STAFF_ROUTES',
      });
    }
  }

  return {
    handlers: handlers.sort(),
    problems: problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)),
  };
}

/** Repository-wide: the role-read check over every route module under ROUTE_HANDLER_SCOPES. */
function findRouteRoleReadsBeforeServiceRole(modules = scanRepository(), resolveImport = createResolver()) {
  return analyzeRouteRoleReadsBeforeServiceRole(routeModulesUnder(modules, ROUTE_HANDLER_SCOPES).map(fromRepo), {
    resolveImport,
    helpers: SECOND_FACTOR_HELPERS.map(([file, name]) => [fromRepo(file), name]),
    sources: SERVICE_ROLE_SOURCES.map(([file, name]) => [fromRepo(file), name]),
    keyReaders: SECRET_KEY_READERS.map(([file, name]) => [fromRepo(file), name]),
    roleReaders: ROLE_READERS.map(([file, name]) => [fromRepo(file), name]),
  });
}

module.exports = {
  FREEMIUS_COUPON_PUSHES,
  ROUTE_HANDLER_SCOPES,
  SECOND_FACTOR_HELPERS,
  SECOND_FACTOR_SCOPES,
  STAFF_ROUTES,
  STAFF_ROUTE_SCOPES,
  STAFF_UPLOAD_ROUTES,
  STAFF_UPLOAD_ROUTE_SCOPES,
  analyzeCouponPushActions,
  analyzeRoleReadsBeforeServiceRole,
  analyzeRouteRoleReadsBeforeServiceRole,
  analyzeStaffRouteGates,
  classifyName,
  findCallerSuppliedActors,
  findCallerSuppliedActorsInSource,
  findCouponPushExports,
  findRoleReadsBeforeServiceRole,
  findRouteRoleReadsBeforeServiceRole,
  findStaffRouteGates,
  findStaffUploadRouteGates,
  findUnauthorizedCouponPushes,
  listServerActions,
  selectedColumns,
};
