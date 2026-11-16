# 07 Block SDK and Extensibility

## What the SDK Is

`libs/sdk` is the typed contract for block-style extensibility. It is much
smaller than the in-app block registry because it defines an external authoring
interface, not the full CMS implementation.

The main export is:

- `@nextblock-cms/sdk`

## Current SDK Surface

`libs/sdk/src/lib/sdk.ts` currently exports the following core types:

- `BlockContentSchema`
- `BlockData<TSchema>`
- `BlockProps<TSchema>`
- `BlockEditorProps<TSchema>`
- `BlockConfig<TSchema>`
- `LucideIcon`

## Contract Shape

### Schema

Every block is defined around a Zod object schema:

```ts
type BlockContentSchema = z.ZodObject<any>;
```

The runtime content type is inferred from that schema through `BlockData`.

### Renderer contract

The public rendering contract is:

- `content`
- optional `className`
- `isInEditor`
- `languageKey`

### Editor contract

The editing contract is:

- `content`
- `block`
- `onChange`

### Registration contract

A block registration object currently requires:

- `type`
- `label`
- optional `icon`
- `schema`
- `initialContent`
- `RendererComponent`
- `EditorComponent`

## Relationship to the App Block Registry

The app already has an internal registry in
`apps/nextblock/lib/blocks/blockRegistry.ts`.

That registry is richer than the SDK because it also includes:

- the editor's file name (`editorComponentFilename`), which the CMS resolves through
  `apps/nextblock/app/cms/blocks/components/blockEditorLoaders.ts`, one string-literal `import()`
  per editor (a computed `import()` bundles the whole folder, tests included)
- a renderer file name (`rendererComponentFilename`); the public site loads renderers by block
  type through `apps/nextblock/components/blocks/publicRendererLoaders.ts` and
  `ecommerceRendererLoaders.ts`
- CMS-specific helper metadata
- in-repo block defaults for built-in block types

The important distinction is:

- `libs/sdk` defines the reusable contract
- `apps/nextblock/lib/blocks/blockRegistry.ts` defines the current built-in
  implementation

They are related, but they are not the same file or the same level of
abstraction.

## Current Built-In Extensibility Pattern

Today, adding a built-in block to the app usually means updating:

- the app block registry
- a CMS editor component in `apps/nextblock/app/cms/blocks/editors/` (a default export), plus its
  entry in `apps/nextblock/app/cms/blocks/components/blockEditorLoaders.ts` (below)
- a front-end renderer component, plus its loader in
  `apps/nextblock/components/blocks/publicRendererLoaders.ts` (or `ecommerceRendererLoaders.ts`)
- any supporting schemas or helpers

The editor's entry in `BLOCK_EDITOR_LOADERS` is keyed by the registry's `editorComponentFilename`
without its extension, as in `FaqBlockEditor: () => import('../editors/FaqBlockEditor'),`, with the
key quoted when it is not an identifier
(`'faq/FaqBlockEditor': () => import('../editors/faq/FaqBlockEditor'),`). Without the entry the CMS
opens nothing for the block, and the browser console logs "No editor component found" with the
line to add; through 0.23.3 the file alone was enough. A block whose definition sets
`EditorComponent` opens that component instead and needs neither (except `section`, whose editor
`EditableBlock` always opens by its file name). In the monorepo `blockEditorLoaders.test.ts` fails
while a block with fields and no `EditorComponent` has no entry. A standalone project has no vitest
to run it, so `npm run update` names each editor the registry names whose file is in that folder
but has no entry (in the monorepo too; docs/13 → "Block editors the CMS cannot open"). That check
relies on three rules:

- write `editorComponentFilename` in the registry as a string literal, with a name of ASCII
  letters, digits, `_`, `$`, `-` and single dots (`/` between folders; test, spec, story and
  declaration names are skipped)
- set `EditorComponent` in the same object literal as `editorComponentFilename` (neither through a
  spread), or the check may name that block's file
- keep each map entry `key: value`, as in `key: () => import('…')` (a spread, a shorthand, a method
  or a computed key turns the check off)

The existing registry already exposes enough information to support:

- runtime validation
- default content generation
- block label lookup
- block picker rendering

## Commerce-Aware Extensibility

The built-in block registry already contains ecommerce-aware blocks:

- `product_grid`
- `featured_product`
- `cart`
- `checkout`
- `product_details`

That means the current extensibility surface is not limited to editorial
content. It already supports block types that render premium commerce
components.

## Data-Driven Custom Blocks

There is now a third extensibility path that needs no code deploy at all.
Editors can define block types at runtime from the CMS; each definition is a
`custom_block_definitions` row (typed fields plus a recursive layout schema)
rendered on the public site by a dynamic layout engine rather than a compiled
React component.

So the extensibility surface has three layers:

- **Code-defined built-ins** — the app block registry plus React
  editor/renderer files. Most flexible, requires a deploy.
- **The typed SDK contract** (`libs/sdk`) — a small, typed authoring interface
  for reusable or external blocks.
- **Data-defined custom blocks** (`custom_block_definitions`) — full CRUD from
  the CMS, no deploy, rendered from stored JSONB.

Custom blocks are documented in detail in
[10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md).

## Practical Guidance

- If you are building or refactoring built-in CMS blocks, start with the app
  registry and editor/renderer files.
- If you are shaping an external or reusable authoring contract, start with
  `libs/sdk`.
- If you need both, keep the SDK contract small and typed, and let the app
  registry stay responsible for CMS-specific loading behavior.
- If you want editors to create block types without a deploy, reach for
  data-driven custom blocks (`custom_block_definitions`) instead of either of
  the above.
