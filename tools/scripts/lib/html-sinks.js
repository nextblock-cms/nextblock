// Authored HTML reaches the page only through a sanitizer, or from a source that cannot carry
// markup a visitor chose.
//
// Text blocks, product descriptions and custom-block rich text are written by content roles (on
// the public sandbox, by every visitor) and render for everyone. Until 2026-11-03 a product's short
// description, a string `description_json`, a custom block's rich-text field, the section editor's
// drag preview, the editor's SVG node and its Preview button all wrote authored HTML raw. A stored
// `<script src>` from a host the CSP allows (Google Tag Manager serves any container), or a meta
// refresh, then ran for every later visitor or for the admin who clicked.
//
// HTML_SINKS lists every module that writes HTML into a page (`dangerouslySetInnerHTML`, `srcDoc`,
// html-react-parser, `innerHTML` / `outerHTML` / `srcdoc` assignments, `insertAdjacentHTML`,
// `setHTMLUnsafe`, `createContextualFragment`, `DOMParser`, `document.write`, `execCommand('insertHTML')`,
// a `text/html` Blob) with why that is safe. An entry naming its sanitizer must still call it
// (`sanitizedBy`); when the modules that hand it the HTML sanitize instead, every module that
// imports it must be one of them (`sanitizedInCallers`). An entry marked `noCallers` (a component
// that runs the scripts it is given) must stay unused: no module may import its file or name it as
// a value, and an allowed importer (the published barrel) may pass it on only under its own name.

const fs = require('node:fs');
const ts = require('typescript');

const { createResolver, importSpecifiers, scanRepository } = require('./service-role-boundary.js');
const { headIdentifier, isReference, resolveDeclaration } = require('./sandbox-guards.js');

const SANITIZED = 'sanitizeAuthoredBlockHtml';

/**
 * Every module that writes HTML into a page. `sanitizedBy`: functions the module must call on the
 * authored HTML it renders. `sanitizedInCallers`: the only modules that may import it, each of
 * which must call sanitizeAuthoredBlockHtml before handing HTML over. `noCallers`: names nothing
 * may import or use, `allowedImporters` the modules exempt from that (a published barrel).
 */
const HTML_SINKS = new Map([
  // Authored HTML, sanitized where it renders.
  ['libs/ecommerce/src/lib/components/ShortDescription.tsx', { why: 'products.short_description (ADMIN, Cortex, PostgREST).', sanitizedBy: [SANITIZED] }],
  ['libs/ecommerce/src/lib/components/SimpleTiptapRenderer.tsx', { why: 'a string description_json, or text HTML that is not valid JSON.', sanitizedBy: [SANITIZED] }],
  ['apps/nextblock/components/renderers/DynamicLayoutEngine.tsx', { why: 'custom block rich-text values and emptyFallback (ADMIN/WRITER); the CMS previews share it.', sanitizedBy: [SANITIZED] }],
  ['apps/nextblock/app/cms/blocks/editors/SectionBlockEditor.tsx', { why: "the drag preview of a text block's HTML (WRITER).", sanitizedBy: [SANITIZED] }],
  ['apps/nextblock/app/cms/blocks/components/EditableBlock.tsx', { why: 'text block HTML in the CMS editor (WRITER).', sanitizedBy: [SANITIZED] }],
  ['apps/nextblock/app/cms/blocks/components/ColumnEditor.tsx', { why: 'section column text block HTML in the CMS editor (WRITER).', sanitizedBy: [SANITIZED] }],
  [
    'apps/nextblock/components/blocks/renderers/ClientTextBlockRenderer.tsx',
    {
      why: 'text block HTML: both callers sanitize it first, and its parser replace drops on* attributes.',
      sanitizedInCallers: ['apps/nextblock/components/BlockRenderer.tsx', 'apps/nextblock/components/blocks/renderers/TextBlockRenderer.tsx'],
    },
  ],
  ['libs/editor/src/lib/extensions/SvgNode.ts', { why: 'authored <svg> inner markup in the editor and its export (safeSvgInnerHtml).', sanitizedBy: [SANITIZED] }],
  ['libs/editor/src/lib/components/menus/Toolbar.tsx', { why: 'the Preview document (a same-origin blob:) gets the sanitized editor HTML; Export only downloads files.', sanitizedBy: [SANITIZED] }],
  // Safe by construction.
  ['apps/nextblock/components/SiteScripts.tsx', { why: 'ADMIN site_scripts through escapeInlineScript, with the nonce; renders nothing on the sandbox (sandbox-guards).' }],
  [
    'apps/nextblock/components/privacy/ConsentGatedAnalytics.tsx',
    { why: 'ADMIN custom analytics scripts, consent-gated, with the nonce; blocked on the sandbox (sandbox-guards).' },
  ],
  ['apps/nextblock/app/layout.tsx', { why: 'theme CSS (validated slugs and tokens, sanitizeExtraCss), global CSS through escapeStyleElementText, and a code constant.' }],
  ['apps/nextblock/app/page.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/[slug]/page.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/article/[slug]/page.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/product/[slug]/page.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/(public)/partners/_components/partners-route.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/(public)/partners/[handle]/page.tsx', { why: 'JSON-LD through stringifyJsonLd, which escapes every <.' }],
  ['apps/nextblock/app/cms/promotions/PromotionsWorkspace.tsx', { why: 'tab descriptions from the TABS code constant.' }],
  ['apps/nextblock/app/article/[slug]/PostClientContent.tsx', { why: 'a constant (&nbsp;).' }],
  ['apps/nextblock/components/blocks/renderers/FormBlockRenderer.tsx', { why: 'a constant (&nbsp;).' }],
  ['apps/nextblock/components/auth/AuthBotProtection.tsx', { why: 'clears the captcha container (an empty string).' }],
  // A component that runs the scripts it is given goes here with `noCallers`. None today:
  // HtmlContent (editor) and HtmlScriptExecutor (app), both unused, were deleted on 2026-11-04.
]);

const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const HTML_KEYS = new Set(['dangerouslySetInnerHTML', 'srcDoc', 'srcdoc']);
const HTML_METHODS = new Set(['insertAdjacentHTML', 'createContextualFragment', 'setHTMLUnsafe', 'parseHTMLUnsafe']);
const DOCUMENT_RECEIVER = /(?:^|\.)(?:document|contentDocument|ownerDocument)$/;

/** Script kind by extension, as the boundary scan does: `.js` may hold JSX. */
function parseSource(fileName, source) {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(fileName)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  return ts.createSourceFile(fileName, source.replace(/^\uFEFF/, ''), ts.ScriptTarget.Latest, true, kind);
}

const literalKey = (node) => (node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null);

/** Local names bound to html-react-parser's functions, and its namespace imports. */
function htmlParserBindings(sourceFile) {
  const names = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'html-react-parser') continue;
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (['domToReact', 'htmlToDOM', 'default'].includes((element.propertyName ?? element.name).text)) names.add(element.name.text);
      }
    }
  }
  return { names, namespaces };
}

/** True when a write's receiver is a document: `document`, `x.contentDocument`, or a local bound to one. */
function isDocumentReceiver(expression, sourceFile) {
  const text = expression.getText(sourceFile).replace(/\s+/g, '');
  if (DOCUMENT_RECEIVER.test(text)) return true;
  const head = headIdentifier(expression);
  const declaration = head && head.getText(sourceFile) === text ? resolveDeclaration(head) : null;
  const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : null;
  return Boolean(initializer && DOCUMENT_RECEIVER.test(initializer.getText(sourceFile).replace(/\s+/g, '')));
}

/** Every place a module writes HTML into a page, as labels with lines. */
function htmlSinksInSource(fileName, source) {
  const sourceFile = parseSource(fileName, source);
  const parser = htmlParserBindings(sourceFile);
  const found = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && HTML_KEYS.has(node.name.getText(sourceFile))) found.push(`${node.name.getText(sourceFile)} (line ${lineOf(node)})`);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && HTML_KEYS.has(literalKey(node.name))) {
      found.push(`${literalKey(node.name)} (line ${lineOf(node)})`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first, second] = node.arguments;
      if (ts.isIdentifier(callee) && parser.names.has(callee.text)) found.push(`html-react-parser ${callee.text}() (line ${lineOf(node)})`);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && parser.namespaces.has(callee.expression.text)) {
        found.push(`html-react-parser ${callee.getText(sourceFile)}() (line ${lineOf(node)})`);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (HTML_METHODS.has(method)) found.push(`${method}() (line ${lineOf(node)})`);
        if ((method === 'write' || method === 'writeln') && isDocumentReceiver(callee.expression, sourceFile)) found.push(`${method}() (line ${lineOf(node)})`);
        if (method === 'setAttribute' && literalKey(first)?.toLowerCase() === 'srcdoc') found.push(`setAttribute('srcdoc') (line ${lineOf(node)})`);
        if (method === 'setAttributeNS' && literalKey(second)?.toLowerCase() === 'srcdoc') found.push(`setAttributeNS('srcdoc') (line ${lineOf(node)})`);
        if (method === 'execCommand' && literalKey(first)?.toLowerCase() === 'inserthtml') found.push(`execCommand('insertHTML') (line ${lineOf(node)})`);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = node.left;
      const property = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target)
          ? literalKey(target.argumentExpression)
          : null;
      if (property && HTML_PROPERTIES.has(property)) found.push(`${property} ${node.operatorToken.getText(sourceFile)} (line ${lineOf(node)})`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'DOMParser') {
      found.push(`new DOMParser (line ${lineOf(node)})`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Blob') {
      const options = node.arguments?.[1];
      if (options && /text\/html/.test(options.getText(sourceFile))) found.push(`text/html Blob (line ${lineOf(node)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** True when the module calls `name(...)` (directly or as a member). */
function callsFunction(sourceFile, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && callee.name.text === name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** An import or export specifier, or a default import, that brings in only a type. */
function isTypeOnlySpecifier(node) {
  const parent = node.parent;
  if (ts.isImportClause(parent)) return parent.isTypeOnly;
  if (!ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent)) return false;
  if (parent.isTypeOnly) return true;
  const declaration = parent.parent.parent;
  return ts.isImportClause(declaration) || ts.isExportDeclaration(declaration) ? declaration.isTypeOnly : false;
}

/**
 * The key a destructuring reads, written as an identifier, a string or a computed string:
 * `{ HtmlContent: Runner }`, `{ 'HtmlContent': R }`, `{ ['HtmlContent']: R }`, `{ HtmlContent }`.
 */
function isDestructuredKey(node) {
  let key = node;
  if (ts.isComputedPropertyName(key.parent)) key = key.parent;
  const parent = key.parent;
  if (ts.isBindingElement(parent)) return parent.propertyName === key || (!parent.propertyName && parent.name === node);
  // `({ HtmlContent: R } = m)`: an object literal on the left of an assignment destructures too.
  if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === key) {
    let target = parent.parent;
    while (target.parent && (ts.isParenthesizedExpression(target.parent) || ts.isArrayLiteralExpression(target.parent) || ts.isPropertyAssignment(target.parent) || ts.isObjectLiteralExpression(target.parent))) {
      target = target.parent;
    }
    const assignment = target.parent;
    return Boolean(assignment && ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken && assignment.left === target);
  }
  return false;
}

/**
 * Where a module names one of `names` as a value: an identifier, a member (`Editor.HtmlContent`), a
 * string index (`m['HtmlContent']`), a destructured key, or an import or re-export of it. Types do
 * not count (a type position, `import type`, `export type`). The match is by name, so a module's
 * own binding of the same name counts too: rename it.
 */
function namesUsed(sourceFile, names) {
  const used = new Set();
  const visit = (node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text) && !isTypeOnlySpecifier(node)) {
      const parent = node.parent;
      const declares =
        (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node;
      if (
        !declares &&
        (isReference(node) || ts.isPropertyAccessExpression(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || isDestructuredKey(node))
      ) {
        used.add(node.text);
      }
    }
    if (ts.isStringLiteralLike(node) && names.has(node.text) && (ts.isElementAccessExpression(node.parent) || isDestructuredKey(node))) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return used;
}

/**
 * How an allowed importer could pass a `noCallers` component on under another name, which the
 * name check would then miss: a renamed or default import or re-export of the owner's file, a
 * renamed local re-export, `export default` of it, or any other value use (`export const X = HtmlContent`).
 */
function aliasesInAllowedImporter(sourceFile, names, fromOwner) {
  const aliases = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && fromOwner(node.moduleSpecifier.text)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : null;
      if (clause && !clause.isTypeOnly && clause.name && !names.has(clause.name.text)) aliases.push(`a default import as ${clause.name.text}`);
      if (clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) aliases.push(`a namespace import as ${clause.namedBindings.name.text}`);
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
      const typeOnly = clause ? clause.isTypeOnly : ts.isExportDeclaration(node) && node.isTypeOnly;
      for (const element of named) {
        if (typeOnly || element.isTypeOnly) continue;
        const original = (element.propertyName ?? element.name).text;
        if (original === 'default' || (names.has(original) && element.name.text !== original)) aliases.push(`${original} as ${element.name.text}`);
      }
      return;
    }
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier && node.propertyName && names.has(node.propertyName.text) && node.name.text !== node.propertyName.text) {
      aliases.push(`${node.propertyName.text} as ${node.name.text}`);
    }
    if (ts.isIdentifier(node) && names.has(node.text) && isReference(node) && !ts.isImportSpecifier(node.parent) && !ts.isExportSpecifier(node.parent)) {
      aliases.push(`${node.text} as a value (line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

const HINT =
  /dangerouslySetInnerHTML|srcdoc|html-react-parser|innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|insertHTML|DOMParser|\bdocument\b|contentDocument|ownerDocument|text\/html/i;

/**
 * Modules that write HTML into a page without an HTML_SINKS entry or cannot be parsed, entries with
 * no sink left, an entry whose sanitizer the module no longer calls, a module that imports a
 * `sanitizedInCallers` sink without being one of its callers, and any use of a `noCallers` export.
 */
function findHtmlSinkProblems(
  modules = scanRepository(),
  sinks = HTML_SINKS,
  readFile = (absolute) => fs.readFileSync(absolute, 'utf8'),
  resolveImport = createResolver()
) {
  const problems = [];
  const seen = new Set();
  const byRepoPath = new Map([...modules.values()].map((mod) => [mod.repoPath, mod]));
  const forbidden = new Map();
  const ownersByAbsolute = new Map();
  for (const [repoPath, entry] of sinks) {
    for (const name of entry.noCallers ?? []) forbidden.set(name, repoPath);
    const owner = byRepoPath.get(repoPath);
    if (owner && (entry.noCallers || entry.sanitizedInCallers)) ownersByAbsolute.set(owner.absolute, { repoPath, entry });
  }
  const forbiddenNames = new Set(forbidden.keys());
  for (const mod of modules.values()) {
    const source = readFile(mod.absolute);
    const exempt = (entry) => (entry.allowedImporters ?? []).includes(mod.repoPath);

    // Who imports a sink that must not be imported, or only by its sanitizing callers.
    const specifiers = mod.imports ? [...mod.imports] : importSpecifiers(source, mod.absolute);
    for (const specifier of specifiers) {
      const target = resolveImport(mod.absolute, specifier);
      const owner = target ? ownersByAbsolute.get(target) : null;
      if (!owner || owner.repoPath === mod.repoPath || exempt(owner.entry)) continue;
      if (owner.entry.noCallers) {
        problems.push(`${mod.repoPath} imports ${owner.repoPath}, which runs every script in the HTML it gets: sanitize the HTML with ${SANITIZED} and render it some other way.`);
      } else if (!owner.entry.sanitizedInCallers.includes(mod.repoPath)) {
        problems.push(
          `${mod.repoPath} imports ${owner.repoPath}, which renders the HTML it is handed without sanitizing it: call ${SANITIZED} on that HTML first and add the module to the entry's sanitizedInCallers (tools/scripts/lib/html-sinks.js).`
        );
      }
    }
    if (forbiddenNames.size > 0 && [...forbiddenNames].some((name) => source.includes(name))) {
      for (const name of namesUsed(parseSource(mod.absolute, source), forbiddenNames)) {
        const owner = forbidden.get(name);
        if (mod.repoPath === owner || exempt(sinks.get(owner))) continue;
        problems.push(`${mod.repoPath} uses ${name} (${owner}), which runs every script in the HTML it gets: sanitize the HTML with ${SANITIZED} and render it some other way.`);
      }
    }
    // An allowed importer (a published barrel) may pass the component on only under its own name.
    for (const [ownerPath, entry] of sinks) {
      if (!entry.noCallers || !exempt(entry)) continue;
      const ownerModule = byRepoPath.get(ownerPath);
      const fromOwner = (specifier) => Boolean(ownerModule && resolveImport(mod.absolute, specifier) === ownerModule.absolute);
      for (const alias of aliasesInAllowedImporter(parseSource(mod.absolute, source), new Set(entry.noCallers), fromOwner)) {
        problems.push(
          `${mod.repoPath} passes ${ownerPath} on under another name (${alias}): an allowed importer may re-export ${entry.noCallers.join(', ')} only under that name, which is the name the check follows.`
        );
      }
    }

    if (!HINT.test(source)) continue;
    const sourceFile = parseSource(mod.absolute, source);
    if (sourceFile.parseDiagnostics?.length > 0) {
      problems.push(`${mod.repoPath} cannot be parsed, so the HTML sink scan cannot prove it safe: fix the syntax error.`);
      continue;
    }
    const found = htmlSinksInSource(mod.absolute, source);
    if (found.length === 0) continue;
    seen.add(mod.repoPath);
    const entry = sinks.get(mod.repoPath);
    if (!entry) {
      problems.push(
        `${mod.repoPath} writes HTML into a page (${found.join(', ')}): render authored HTML through ${SANITIZED} (@nextblock-cms/utils) and list the module in HTML_SINKS (tools/scripts/lib/html-sinks.js) with why it is safe.`
      );
      continue;
    }
    for (const name of entry.sanitizedBy ?? []) {
      if (!callsFunction(sourceFile, name)) {
        problems.push(`${mod.repoPath} no longer calls ${name} on the HTML it renders (${found.join(', ')}). HTML_SINKS says: ${entry.why}`);
      }
    }
    for (const caller of entry.sanitizedInCallers ?? []) {
      const callerModule = byRepoPath.get(caller);
      if (!callerModule || !callsFunction(parseSource(callerModule.absolute, readFile(callerModule.absolute)), SANITIZED)) {
        problems.push(`${caller} no longer calls ${SANITIZED} before handing HTML to ${mod.repoPath}. HTML_SINKS says: ${entry.why}`);
      }
    }
  }
  for (const repoPath of sinks.keys()) {
    if (!seen.has(repoPath)) problems.push(`HTML_SINKS lists ${repoPath}, which no longer writes HTML into a page: remove the entry.`);
  }
  return problems;
}

module.exports = { HTML_SINKS, findHtmlSinkProblems, htmlSinksInSource };
