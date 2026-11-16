// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { blockHasEditableContent, blockRegistry } from '../../../../lib/blocks/blockRegistry';
import { describeMissingBlockEditor, getLazyBlockEditor, getLazyCustomBlockEditor } from './blockEditorLoaders';
import ColumnEditor from './ColumnEditor';
import EditableBlock from './EditableBlock';

/**
 * EditableBlock and ColumnEditor open block editors through blockEditorLoaders.ts: one
 * string-literal import() per editor file, because a template-literal import of the editors
 * folder bundled SectionBlockEditor.test.tsx (vitest) into every standalone build from 0.23.0 to
 * 0.23.3. These checks keep the map in step with the registry and the folder, and pin what the two
 * components open. The map is read as source and no editor is rendered, so no editor module
 * (Tiptap, dnd-kit forms, the media library) is loaded.
 */

const opened = vi.hoisted(() => ({ editors: [] as unknown[] }));

vi.mock('./BlockEditorModal', () => ({
  // Records the editor each open hands over; rendering it would load the editor module.
  BlockEditorModal: ({ EditorComponent }: { EditorComponent: unknown }) => {
    opened.editors.push(EditorComponent);
    return null;
  },
}));
vi.mock('./CustomBlockEditorPreview', () => ({
  CustomBlockEditorPreview: ({ fallback }: { fallback: React.ReactNode }) => fallback,
}));
vi.mock('./BlockTypeSelector', () => ({ default: () => null }));
vi.mock('../../../../lib/blocks/blockRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/blocks/blockRegistry')>();
  return {
    ...actual,
    // A built-in whose editor file has no loader (no registry entry is like that today).
    getBlockDefinition: (type: string) =>
      type === 'ghost_block' ? { ...actual.blockRegistry.text, editorComponentFilename: 'GhostBlockEditor.tsx' } : actual.getBlockDefinition(type),
  };
});

const LOADERS_FILE = path.join(__dirname, 'blockEditorLoaders.ts');
const EDITORS_DIR = path.resolve(__dirname, '../editors');
const REACT_LAZY = Symbol.for('react.lazy');

type LoaderEntry = { name: string; specifiers: string[] };

/** Every `import()` under `node`, by specifier (`<computed: …>` for anything but a literal). */
function importSpecifiers(node: ts.Node, file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = child.arguments;
      found.push(specifier && ts.isStringLiteralLike(specifier) ? specifier.text : `<computed: ${specifier?.getText(file)}>`);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** The BLOCK_EDITOR_LOADERS entries as written, and the module's import() count overall. */
function readLoaderMap(source = readFileSync(LOADERS_FILE, 'utf8')): { entries: LoaderEntry[]; importCalls: number } {
  const file = ts.createSourceFile(LOADERS_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let map: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'BLOCK_EDITOR_LOADERS' && node.initializer) {
      let value: ts.Expression = node.initializer;
      while (ts.isSatisfiesExpression(value) || ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isObjectLiteralExpression(value)) map = value;
    }
    ts.forEachChild(node, find);
  };
  find(file);
  if (!map) throw new Error('blockEditorLoaders.ts: BLOCK_EDITOR_LOADERS is not an object literal');
  const entries = map.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      throw new Error(`blockEditorLoaders.ts: unexpected BLOCK_EDITOR_LOADERS member ${property.getText(file)}`);
    }
    return { name: property.name.text, specifiers: importSpecifiers(property.initializer, file) };
  });
  return { entries, importCalls: importSpecifiers(file, file).length };
}

/** `export default …` in any of its forms (React.lazy renders the default export). */
function hasDefaultExport(absolute: string): boolean {
  const file = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return file.statements.some(
    (statement) =>
      (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
      (ts.canHaveModifiers(statement) && Boolean(ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))) ||
      (ts.isExportDeclaration(statement) &&
        Boolean(statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((e) => e.name.text === 'default')))
  );
}

describe('block editor loaders', () => {
  it('opens a mapped editor for every built-in block that is edited through an editor file', () => {
    const checked: string[] = [];
    const missing: string[] = [];
    for (const [type, definition] of Object.entries(blockRegistry)) {
      // An EditorComponent (testimonial) wins over the filename; a block with nothing to
      // configure (cart, checkout, product_details) never opens an editor.
      if (definition.EditorComponent || !blockHasEditableContent(type)) continue;
      checked.push(type);
      const filename = definition.editorComponentFilename;
      if (!filename || !getLazyBlockEditor(filename)) missing.push(`${type}: ${filename ?? 'no editorComponentFilename'}`);
    }
    expect(missing).toEqual([]);
    expect(checked).toEqual(
      expect.arrayContaining(['text', 'heading', 'image', 'button', 'posts_grid', 'video_embed', 'section', 'form', 'product_grid', 'featured_product'])
    );
  });

  it('accepts the registry file name with or without ".tsx", and loads custom blocks in DynamicCustomBlockEditor', () => {
    expect(getLazyBlockEditor('SectionBlockEditor.tsx')?.$$typeof).toBe(REACT_LAZY);
    expect(getLazyBlockEditor('SectionBlockEditor')?.$$typeof).toBe(REACT_LAZY);
    expect(getLazyCustomBlockEditor().$$typeof).toBe(REACT_LAZY);
  });

  it('returns null, so the caller opens nothing, for a file name with no editor', () => {
    // cart, checkout and product_details name editor files that do not exist; the testimonial
    // entry names a placeholder its EditorComponent replaces.
    const unmapped = Object.values(blockRegistry)
      .map((definition) => definition.editorComponentFilename)
      .filter((filename): filename is string => Boolean(filename) && !existsSync(path.join(EDITORS_DIR, `${filename?.replace(/\.tsx$/, '')}.tsx`)));
    expect(unmapped).toEqual(expect.arrayContaining(['CartBlockEditor.tsx', 'CheckoutBlockEditor.tsx', 'ProductDetailsBlockEditor.tsx']));
    for (const filename of [...unmapped, 'NoSuchBlockEditor.tsx', '', 'constructor', 'toString', '__proto__', 'SectionBlockEditor.test.tsx']) {
      expect(getLazyBlockEditor(filename), filename).toBeNull();
    }
  });

  it('maps only editor files that exist, each loader importing exactly the file its key names', () => {
    const { entries, importCalls } = readLoaderMap();
    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['DynamicCustomBlockEditor', 'SectionBlockEditor']));
    const problems: string[] = [];
    for (const { name, specifiers } of entries) {
      const expected = `../editors/${name}`;
      if (specifiers.length !== 1 || specifiers[0] !== expected) {
        problems.push(`${name}: imports ${JSON.stringify(specifiers)}, expected ["${expected}"]`);
      }
      // A test file in the map is the 0.23.0 build failure again (it imports vitest).
      if (/\.(?:test|spec)$/.test(name)) problems.push(`${name}: a test file, never bundle it`);
      const absolute = path.join(EDITORS_DIR, `${name}.tsx`);
      if (!existsSync(absolute)) problems.push(`${name}: ${expected}.tsx does not exist`);
      else if (!hasDefaultExport(absolute)) problems.push(`${name}: ${expected}.tsx has no default export for React.lazy`);
      if (!getLazyBlockEditor(name)) problems.push(`${name}: written in the map, but getLazyBlockEditor returns null`);
    }
    expect(problems).toEqual([]);
    // Every import() of the module is one of the map's loaders.
    expect(importCalls).toBe(entries.length);
  });

  it('leaves every editor module to the map: EditableBlock and ColumnEditor import none themselves', () => {
    // A static import ships that editor in the CMS edit routes' entry chunk (EditableBlock imported
    // PostsGridBlockEditor that way through 0.23.3), and an import() of their own bypasses the map.
    const offenders: string[] = [];
    for (const component of ['EditableBlock.tsx', 'ColumnEditor.tsx']) {
      const absolute = path.join(__dirname, component);
      const file = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const staticImports = file.statements
        .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly)
        .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
      for (const specifier of [...staticImports, ...importSpecifiers(file, file)]) {
        if (/(?:^|\/)editors\//.test(specifier)) offenders.push(`${component}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tells the console which editor file has no loader, and the line that maps it', () => {
    const message = describeMissingBlockEditor('faq', 'FaqBlockEditor.tsx');
    expect(message).toBe(
      'No editor component found for block type: faq (FaqBlockEditor.tsx). ' +
        "Add it to BLOCK_EDITOR_LOADERS in app/cms/blocks/components/blockEditorLoaders.ts: FaqBlockEditor: () => import('../editors/FaqBlockEditor'),"
    );
    // The suggested line is an entry this map accepts, written the way its own entries are.
    const line = message.split('blockEditorLoaders.ts: ')[1];
    expect(readLoaderMap(`const BLOCK_EDITOR_LOADERS = {\n  ${line}\n};\n`).entries).toEqual([
      { name: 'FaqBlockEditor', specifiers: ['../editors/FaqBlockEditor'] },
    ]);
    expect(describeMissingBlockEditor('faq', 'FaqBlockEditor')).toContain("FaqBlockEditor: () => import('../editors/FaqBlockEditor'),");
    expect(describeMissingBlockEditor('faq', undefined)).toBe('No editor component found for block type: faq (no editorComponentFilename)');
  });

  it('quotes a suggested key that is not an identifier, so the line parses as the entry getLazyBlockEditor looks up', () => {
    // 0.23.3 opened these names too (its import() took the registry name as a path).
    for (const [filename, name] of [
      ['faq-block-editor.tsx', 'faq-block-editor'],
      ['faq/FaqBlockEditor.tsx', 'faq/FaqBlockEditor'],
    ]) {
      const line = describeMissingBlockEditor('faq', filename).split('blockEditorLoaders.ts: ')[1];
      expect(line).toBe(`'${name}': () => import('../editors/${name}'),`);
      const source = `const BLOCK_EDITOR_LOADERS = {\n  ${line}\n};\n`;
      const { diagnostics = [] } = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
      expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')), line).toEqual([]);
      expect(readLoaderMap(source).entries).toEqual([{ name, specifiers: [`../editors/${name}`] }]);
    }
  });
});

describe('what EditableBlock and ColumnEditor open', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    opened.editors.length = 0;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    consoleError.mockRestore();
  });

  async function click(element: Element | null) {
    if (!(element instanceof HTMLElement)) throw new Error('nothing to click');
    await act(async () => {
      element.click();
    });
  }

  const missingEditorLogs = () =>
    consoleError.mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith('No editor component found'));

  // [block type, what opens]: a lazy editor, the testimonial's EditorComponent, or nothing.
  const CASES: Array<[string, 'lazy' | 'component' | 'nothing']> = [
    ['text', 'lazy'],
    ['posts_grid', 'lazy'],
    ['my-custom-block', 'lazy'], // a custom block slug: DynamicCustomBlockEditor
    ['testimonial', 'component'],
    ['cart', 'nothing'], // context-driven: nothing to configure, no editor file
    ['ghost_block', 'nothing'], // an editor file with no loader: logged, never thrown in Suspense
  ];

  const expectOpened = (blockType: string, what: 'lazy' | 'component' | 'nothing') => {
    if (what === 'nothing') {
      expect(opened.editors).toEqual([]);
    } else if (what === 'component') {
      expect(opened.editors.at(-1)).toBe(blockRegistry.testimonial.EditorComponent);
    } else {
      expect((opened.editors.at(-1) as { $$typeof?: symbol } | undefined)?.$$typeof, blockType).toBe(REACT_LAZY);
    }
    // Only the editor file with no loader is an error, and it names the fix; cart has nothing to open.
    expect(missingEditorLogs()).toEqual(
      blockType === 'ghost_block'
        ? [
            'No editor component found for block type: ghost_block (GhostBlockEditor.tsx). ' +
              "Add it to BLOCK_EDITOR_LOADERS in app/cms/blocks/components/blockEditorLoaders.ts: GhostBlockEditor: () => import('../editors/GhostBlockEditor'),",
          ]
        : []
    );
  };

  it.each(CASES)('ColumnEditor: editing a %s block opens %s', async (blockType, what) => {
    await act(async () => {
      root.render(
        React.createElement(ColumnEditor, {
          columnIndex: 0,
          blocks: [{ block_type: blockType, content: {} }],
          onBlocksChange: () => undefined,
          blockType: 'section',
        })
      );
    });
    // As in EditableBlock, a block with nothing to configure has no Edit button: click its card.
    await click(container.querySelector('button[title="Edit block"]') ?? container.querySelector('[aria-roledescription="sortable"]'));
    expectOpened(blockType, what);
  });

  it.each(CASES)('EditableBlock: editing a %s block opens %s', async (blockType, what) => {
    const block = { id: 1, block_type: blockType, content: {}, order: 0, language_id: 1, page_id: 1, post_id: null, product_id: null, created_at: '', updated_at: '' };
    await act(async () => {
      root.render(React.createElement(EditableBlock, { block, onDelete: () => undefined, onContentChange: () => undefined }));
    });
    // The card itself opens the editor; blocks with nothing to configure show no Edit button.
    await click(container.querySelector('button[aria-label="Edit block"]') ?? container.firstElementChild);
    expectOpened(blockType, what);
  });
});
