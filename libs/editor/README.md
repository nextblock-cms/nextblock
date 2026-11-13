# @nextblock-cms/editor

The Tiptap-based rich-text editor of [NextBlock](https://github.com/nextblock-cms/nextblock), the
open-core CMS for Next.js and Supabase. The CMS uses it for text blocks and product
descriptions.

Projects created with `npm create nextblock@latest` already depend on it. It is built for
NextBlock projects (Next.js 16, React 19) and needs `@nextblock-cms/ui` and
`@nextblock-cms/utils` from the same release (see [Versions](#versions)).

```bash
npm install @nextblock-cms/editor @nextblock-cms/ui @nextblock-cms/utils
```

## Versions

`@nextblock-cms/editor`, `@nextblock-cms/ui` and `@nextblock-cms/utils` are released together,
at one version, and move together. The editor imports the other two by name and declares the
releases it was built with as peer dependencies (`^` that version), so the app and the editor
share one copy of each, and npm installs a matching set or refuses a mismatched one instead of
letting the editor load an older `utils` that lacks something it imports. Upgrade the three as a
set. In a NextBlock project, `npm run update` installs every `@nextblock-cms/*` package at its
latest release in one step, which keeps them in step (see
[Staying up to date](https://github.com/nextblock-cms/nextblock/blob/master/docs/13-STAYING-UP-TO-DATE.md)).

## Public surface

Primary exports:

- `NotionEditor`, the full editor the CMS uses, and `Editor`, the plain one (also the default
  export)
- `EditorToolbar`, `EditorBubbleMenu`, `EditorFloatingMenu`, `EnhancedFloatingMenu`,
  `SlashCommandList`, `MobileToolbar` and `UndoRedoButtons`
- `DragHandle`
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
