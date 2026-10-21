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
const ts = require('typescript');

const { createResolver, scanRepository } = require('./service-role-boundary.js');

/** Parameter names (lowercased, underscores dropped) that make the caller the principal. */
const IDENTITY_NAMES = new Set([
  'actorid',
  'actoruserid',
  'authorid',
  'createdby',
  'creatorid',
  'ownerid',
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

module.exports = {
  classifyName,
  findCallerSuppliedActors,
  findCallerSuppliedActorsInSource,
  listServerActions,
};
