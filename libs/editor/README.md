# @nextblock-cms/editor

The Tiptap-based rich-text editor of [NextBlock](https://github.com/nextblock-cms/nextblock), the
open-core CMS for Next.js and Supabase. The CMS uses it for text blocks and product
descriptions.

Projects created with `npm create nextblock@latest` already depend on it. It is built for
NextBlock projects (Next.js 16, React 19) and uses `@nextblock-cms/ui` and
`@nextblock-cms/utils`.

```bash
npm install @nextblock-cms/editor
```

## Public surface

Primary exports:

- `NotionEditor`, the full editor the CMS uses, and `Editor`, the plain one (also the default
  export)
- `EditorToolbar`, `EditorBubbleMenu`, `EditorFloatingMenu`, `EnhancedFloatingMenu`,
  `SlashCommandList`, `MobileToolbar` and `UndoRedoButtons`
- `DragHandle` and `HtmlContent`, which renders saved HTML
- `editorExtensions`, the Tiptap extension kit, plus individual extensions such as
  `SlashCommand`, `TrailingNode` and `DraggableNodes`

Styles are exported as `@nextblock-cms/editor/styles/*.css`: `editor.css`, `placeholder.css`,
`drag-handle.css` and `advanced-features.css`.

Every export is client-side: the entry files start with `'use client'` in both the ESM and the
CommonJS build.

## Documentation

- [CMS and editor](https://github.com/nextblock-cms/nextblock/blob/master/docs/03-CMS-AND-EDITOR.md)
- [Project overview](https://github.com/nextblock-cms/nextblock/blob/master/docs/01-PROJECT-OVERVIEW.md)

The docs describe the editor architecture, widget behaviour, and how this package relates to
the app-level block system.

## License

AGPL-3.0-or-later.
