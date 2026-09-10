# 10 Custom Blocks (Data-Driven CRUD)

NextBlock lets editors create their own block types at runtime, directly from
the CMS, with no code deploy. A custom block is defined as data — typed fields
plus a recursive layout schema — stored in Supabase and rendered on the public
site by a dynamic layout engine instead of a compiled React component.

This is a separate, complementary system to the code-defined built-in blocks in
`apps/nextblock/lib/blocks/blockRegistry.ts`. See
[03-CMS-AND-EDITOR.md](./03-CMS-AND-EDITOR.md) for the built-in block system and
[07-BLOCK-SDK-AND-EXTENSIBILITY.md](./07-BLOCK-SDK-AND-EXTENSIBILITY.md) for how
the three extensibility layers relate.

## The Core Idea

- A **custom block definition** is a row in `custom_block_definitions`.
- A **custom block instance** is just an ordinary `blocks` row whose
  `block_type` equals a definition's `slug`.

Because an instance is a normal block, custom blocks drop into the page builder
exactly like built-ins: they can sit at the top level of a page/post or nest
inside `section` columns, and they participate in ordering, drag-and-drop, and
revisions without special-casing.

## Data Model

The table is created in
`libs/db/src/supabase/migrations/02001_baseline_schema.sql` (originally `00000000000023_setup_custom_block_definitions`, folded in by the generation-2 squash).

`public.custom_block_definitions`:

| Column | Notes |
| :-- | :-- |
| `id` | `uuid` primary key |
| `slug` | unique, `^[a-z][a-z0-9-]*$`; this is the block instance's `block_type` |
| `name` | display name (non-empty) |
| `description` | optional, defaults to `''` |
| `fields` | `jsonb` field declarations; DB `CHECK` via `is_valid_custom_block_fields()` |
| `layout_schema` | `jsonb` layout tree; DB `CHECK` via `is_valid_custom_block_layout_schema()` |
| `is_original` | `false` when the row was produced by duplicating another definition |

The migration also defines:

- `is_valid_custom_block_fields(jsonb)` and
  `is_valid_custom_block_layout_schema(jsonb)` — immutable validation functions
  used as table `CHECK` constraints, so malformed definitions are rejected at
  the database layer even if application validation is bypassed.
- `duplicate_block_definition(target_id uuid)` — `SECURITY DEFINER` RPC that
  copies a definition, auto-suffixing the slug (`-copy`, `-copy-2`, …), naming
  it `"<name> Copy"`, and setting `is_original = false`. Restricted to
  `ADMIN`/`WRITER` (or `service_role`).

### Row Level Security

- Public `SELECT` (definitions must be readable to render on the public site).
- `INSERT` / `UPDATE` / `DELETE` for authenticated users whose role is `ADMIN`
  or `WRITER`.
- Full access for `service_role`.

## Field Types

Application-side schemas live in `libs/utils/src/lib/custom-blocks.ts` and are
exported from `@nextblock-cms/utils`. Every field shares a base of `key`
(`^[a-z][a-z0-9_]*$`, unique within a block), `label`, optional `description`,
and `required`. The `type` discriminates four variants:

| Type | Purpose | Notable options |
| :-- | :-- | :-- |
| `text` | single-line / plain text | `default_value`, `placeholder`, `min_length`, `max_length` |
| `rich-text` | HTML rich text | `default_value`, `placeholder` |
| `image_r2` | image stored in R2 | `accept[]`, `max_bytes`, `default_value` = `{ object_key, url, alt, width, height, … }` |
| `db_relation` | reference rows in a table | `table`, `value_column` (default `id`), `display_column` (default `title`), `multiple`, `filters` |

The CMS authoring components map onto these types: `ImageR2Picker` for
`image_r2`, `DBRelationSelect` for `db_relation`, and the rich-text editor for
`rich-text`.

## Layout Schema

`layout_schema` is a recursive discriminated union (`customBlockLayoutNodeSchema`)
with two node types:

- **`container`** — `{ type: 'container', as?, className?, children: [] }`.
  Groups other nodes.
- **`field_render`** — `{ type: 'field_render', field_key, as?, className?,
  column?, emptyFallback? }`. Renders a single field's value.

Rules and helpers:

- `as` is restricted to a safe HTML element set (`article`, `aside`,
  `blockquote`, `div`, `figure`, `figcaption`, `h2`, `h3`, `img`, `p`,
  `section`, `span`).
- `className` accepts Tailwind utility classes.
- `column` lets a `field_render` bound to a `db_relation` field surface a
  specific column of the resolved record, so one relation field can render
  several columns (e.g. a product's title and price). `emptyFallback` renders
  when the value is empty.
- Every `field_key` referenced in the layout must exist in `fields`
  (`assertLayoutFieldKeysExist` enforces this in `customBlockDefinitionCreateSchema`).
- `orderCustomBlockFieldsByLayout()` orders fields to match the layout's
  depth-first `field_render` order for the editor form; `buildCustomBlockCopySlug()`
  mirrors the SQL duplicate-slug logic on the client.

Exported Zod surfaces: `customBlockDefinitionCreateSchema`,
`customBlockDefinitionUpdateSchema`, and `customBlockDefinitionRowSchema`, with
inferred types `CustomBlockDefinition`, `CustomBlockDefinitionCreateInput`, and
`CustomBlockDefinitionUpdateInput`.

## CMS CRUD Surface

Everything lives under `apps/nextblock/app/cms/custom-blocks`:

- `page.tsx` — searchable grid/list of definitions with duplicate and delete.
- `new/page.tsx` and `[id]/edit/page.tsx` — authoring screens.
- `components/BlockComposer.tsx` — the field + layout composer.
- `components/DBRelationSelect.tsx`, `components/ImageR2Picker.tsx` — field-type
  editors.
- `components/BlocksLibraryTransferControls.tsx` — import/export UI.

Server actions in `app/cms/custom-blocks/actions.ts` all gate on
`requireCmsWriter` (`ADMIN`/`WRITER`) and revalidate the
`custom-block-definitions` cache tag plus `/cms/blocks` and `/cms/custom-blocks`:

- `listCustomBlockDefinitions`, `getCustomBlockDefinition`
- `createCustomBlockDefinition`, `updateCustomBlockDefinition`,
  `deleteCustomBlockDefinition`
- `duplicateCustomBlockDefinition` (calls the `duplicate_block_definition` RPC)
- `exportBlocksLibraryAction`, `dryRunBlocksLibraryImportAction`,
  `applyBlocksLibraryImportAction`

## Rendering

The loader is `apps/nextblock/lib/custom-block-definitions.ts`:

- `getCachedCustomBlockDefinitions()` and
  `getCachedCustomBlockDefinitionBySlug()` read through `getSsgSupabaseClient`
  and `unstable_cache` (tag `custom-block-definitions`, 60s revalidate).
- The by-slug path falls back to a live (uncached) read when the cache misses,
  so a freshly saved block renders immediately instead of showing
  "Unsupported block type" during the revalidation window.

`apps/nextblock/components/BlockRenderer.tsx` dispatches blocks: if a
`block_type` has no built-in renderer, it looks the slug up via
`getCachedCustomBlockDefinitionBySlug()` and renders through
`CachedDynamicLayoutEngine` (which wraps
`components/renderers/DynamicLayoutEngine.tsx`). The dynamic engine walks the
`layout_schema`, renders `container` nodes as their `as` element with the given
classes, and resolves each `field_render` against the instance content
(including `db_relation` lookups). If neither a built-in renderer nor a custom
definition matches, the renderer shows an "Unsupported block type" notice with
the offending slug.

CMS-side editing of an instance uses
`app/cms/blocks/editors/DynamicCustomBlockEditor.tsx` and
`app/cms/blocks/components/CustomBlockEditorPreview.tsx`.

## Import / Export / Backup / Restore

Custom blocks are portable as a JSON "Blocks Library" bundle. The backend is
`apps/nextblock/lib/cms-transfer/server.ts`:

- `exportBlocksLibraryBundle()` serializes all definitions.
- `dryRunBlocksLibraryImport()` previews an import without writing.
- `applyBlocksLibraryImport()` applies it.

A bundle entry (`BackupCustomBlockRecord` in
`apps/nextblock/lib/cms-transfer/types.ts`) carries `slug`, `name`,
`description`, `fields`, `layout_schema`, and `is_original`. Imports run under a
conflict mode of `create_new` or `overwrite_existing`, and return a summary of
`created` / `updated` / `skipped` rows plus warnings and errors. Exports are
named `nextblock-blocks-library-<YYYY-MM-DD>.json`.

Custom blocks also ride along inside the broader content backup bundle
(`CmsBackupBundleV1.custom_blocks`, optional for backward compatibility),
surfaced at `/cms/import-export` via `ContentTransferControls.tsx`.

## Cortex AI "Build Widget"

Cortex AI can generate a custom block definition from a prompt:

- Route: `apps/nextblock/app/api/ai/cortex/build-widget/route.ts`.
- Helpers: `libs/cortex/src/lib/cortex-widget-registry.ts` and the custom-block
  agent tools in `libs/cortex/src/lib/ai-global-agent-custom-block-tools.ts`.
- After a Cortex-driven change, the front end dispatches a
  `nextblock:cortex-data-changed` event; the custom-blocks list listens for it
  (and for window focus) and refetches so the library stays in sync without a
  reload.

See [08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md](./08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md)
for the surrounding AI architecture and credential model.

## Verification

```bash
# Validate the custom block definition schemas / fixtures
npx tsx apps/nextblock/scripts/verify-custom-block-definitions.ts

# Exercise the dynamic layout engine
npx tsx apps/nextblock/scripts/verify-dynamic-layout-engine.tsx

# Cortex AI widget builder (needs OPENROUTER_API_KEY or stored BYOK)
npm run verify:cortex-ai-build-widget
```

Relevant Vitest files:

- `apps/nextblock/components/renderers/DynamicLayoutEngine.test.tsx`
- `libs/cortex/src/lib/cortex-widget-registry.test.ts`
- `libs/cortex/src/lib/cortex-widget-schema.test.tsx`

## Notes for Contributors

- `custom_block_definitions` was added after the squashed migration baseline
  (migration `00000000000023`). Per the production rule in
  [05-DEVELOPER-GUIDE.md](./05-DEVELOPER-GUIDE.md) and the root `AGENTS.md`,
  schema changes here must be new, forward-only migrations.
- After changing the table or seed data, regenerate the sandbox reset payload
  with `npm run generate:sandbox` (the generated SQL already includes the
  custom blocks migration).
- The slug is the public contract: renaming a definition's slug orphans every
  existing instance that references the old slug (they fall back to
  "Unsupported block type" until re-pointed).
