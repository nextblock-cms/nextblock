import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type BlockEditorLoader = () => Promise<{ default: ComponentType<any> }>;
export type LazyBlockEditor = LazyExoticComponent<ComponentType<any>>;

// Every editor the CMS opens, keyed by its file name in ../editors (a registry
// editorComponentFilename without its extension), each behind a plain string-literal import().
// A template literal such as import(`../editors/${filename}`) makes the bundler bundle every
// file in that folder: from 0.23.0 to 0.23.3 it put SectionBlockEditor.test.tsx (which imports
// vitest) into the CMS, and every standalone `next build` failed.
// tools/scripts/dynamic-import-specifiers.test.ts refuses such an import;
// blockEditorLoaders.test.ts keeps this map in step with the registry and the folder.
// A name that is not an identifier is a quoted key ('faq/FaqBlockEditor'). Keep each entry
// `key: () => import('…')`: `npm run update` reads the keys to name the registry editors missing
// here, and skips that check when an entry has another shape (a spread, a shorthand, a method).
const BLOCK_EDITOR_LOADERS = {
  ButtonBlockEditor: () => import('../editors/ButtonBlockEditor'),
  DynamicCustomBlockEditor: () => import('../editors/DynamicCustomBlockEditor'),
  FeaturedProductBlockEditor: () => import('../editors/FeaturedProductBlockEditor'),
  FormBlockEditor: () => import('../editors/FormBlockEditor'),
  HeadingBlockEditor: () => import('../editors/HeadingBlockEditor'),
  ImageBlockEditor: () => import('../editors/ImageBlockEditor'),
  PostsGridBlockEditor: () => import('../editors/PostsGridBlockEditor'),
  ProductGridBlockEditor: () => import('../editors/ProductGridBlockEditor'),
  SectionBlockEditor: () => import('../editors/SectionBlockEditor'),
  TextBlockEditor: () => import('../editors/TextBlockEditor'),
  VideoEmbedBlockEditor: () => import('../editors/VideoEmbedBlockEditor'),
} satisfies Record<string, BlockEditorLoader>;

type BlockEditorName = keyof typeof BLOCK_EDITOR_LOADERS;

// Own keys only: 'constructor' or 'toString' must not resolve through the prototype.
const isBlockEditorName = (name: string): name is BlockEditorName =>
  Object.prototype.hasOwnProperty.call(BLOCK_EDITOR_LOADERS, name);

/** The BLOCK_EDITOR_LOADERS key for a registry file name: "TextBlockEditor.tsx" → "TextBlockEditor". */
const editorNameOf = (filename: string) => filename.trim().replace(/\.[jt]sx?$/, '');

const ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r' };
/** `text` as a string literal in this file's quotes. */
const quoted = (text: string) => {
  const escaped = text.replace(/[\\'\n\r]/g, (c) => ESCAPES[c] ?? c);
  return `'${escaped}'`;
};

/**
 * The React.lazy editor for a registry `editorComponentFilename` ("TextBlockEditor.tsx" or
 * "TextBlockEditor"), or null when no editor file is mapped: cart, checkout and
 * product_details name files that do not exist. The caller logs describeMissingBlockEditor()
 * and opens nothing, where a lazy import of a missing module would throw inside Suspense.
 */
export function getLazyBlockEditor(filename: string): LazyBlockEditor | null {
  const name = editorNameOf(filename);
  if (!isBlockEditorName(name)) return null;
  const load: BlockEditorLoader = BLOCK_EDITOR_LOADERS[name];
  return lazy(load);
}

/**
 * What EditableBlock and ColumnEditor log when a block's editor file has no loader: the file the
 * registry names, and the line that opens it. Through 0.23.3 the CMS opened any file in
 * ../editors by that name alone, so a project that added its own editor there (docs/07) has to
 * list it in BLOCK_EDITOR_LOADERS since 0.23.4; `npm run update` names the ones it finds.
 */
export function describeMissingBlockEditor(blockType: string, filename: string | null | undefined): string {
  const name = filename ? editorNameOf(filename) : '';
  if (!name) return `No editor component found for block type: ${blockType} (no editorComponentFilename)`;
  // A name that is not an identifier ('faq-block-editor', 'faq/FaqBlockEditor') is a quoted key.
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : quoted(name);
  return (
    `No editor component found for block type: ${blockType} (${filename}). ` +
    `Add it to BLOCK_EDITOR_LOADERS in app/cms/blocks/components/blockEditorLoaders.ts: ` +
    `${key}: () => import(${quoted(`../editors/${name}`)}),`
  );
}

/** The field editor a custom block (a definition slug, no registry entry) opens in. */
export function getLazyCustomBlockEditor(): LazyBlockEditor {
  return lazy(BLOCK_EDITOR_LOADERS.DynamicCustomBlockEditor);
}
