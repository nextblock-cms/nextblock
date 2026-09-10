# 03 CMS and Editor

## Two Related Systems

NextBlock's content authoring experience is split across two real subsystems:

- `libs/editor`: a reusable Tiptap-based rich text package
- `apps/nextblock/lib/blocks`: the block registry and page-builder layer used
  by pages, posts, and some commerce surfaces

They work together, but they are not the same thing.

## Block Registry and Page Builder

The block registry lives in `apps/nextblock/lib/blocks/blockRegistry.ts`. It is
the current source of truth for:

- available block types
- Zod schemas
- default content
- editor component filenames
- renderer component filenames
- human-facing labels and block metadata

### Current registered block types

The registry currently includes:

- `text`
- `heading`
- `image`
- `button`
- `posts_grid`
- `video_embed`
- `section`
- `form`
- `testimonial`
- `product_grid`
- `featured_product`
- `cart`
- `checkout`
- `product_details`

The authoritative type list is `apps/nextblock/lib/blocks/blockTypes.ts`
(`availableBlockTypes`).

A `section` block can contain nested column block arrays, so the page builder
supports multi-column compositions instead of only flat block lists. Legacy
`hero` blocks were folded into `section` (carrying an `is_hero` flag) by
migration `libs/db/src/supabase/migrations/02004_baseline_seed.sql` (originally `00000000000021_migrate_hero_blocks_to_sections`, folded in by the generation-2 squash), so `hero` is no
longer a standalone registered block type.

### How the CMS uses the registry

The CMS block editor components under `app/cms/blocks` use the registry to:

- validate block types
- build new block payloads from default content
- dynamically load editor components
- dynamically load renderer components
- render block labels and picker entries

The registry also exposes helper functions such as:

- `getBlockDefinition()`
- `getInitialContent()`
- `getBlockSchema()`
- `validateBlockContent()`
- `generateDefaultContent()`

## Tiptap Editor Package

The reusable editor surface lives in `libs/editor`.

The main exports today are:

- `Editor`
- `NotionEditor`
- `EditorToolbar`
- `EditorBubbleMenu`
- `EditorFloatingMenu`
- `EnhancedFloatingMenu`
- `SlashCommandList`
- `DragHandle`
- `HtmlContent`
- `editorExtensions`

### Core editing capabilities

`libs/editor/src/lib/kit.ts` composes the editor from Tiptap extensions and
custom nodes. The shipped editing surface includes:

- StarterKit-based rich text
- syntax-highlighted code blocks via `CodeBlockLowlight`
- tables
- task lists
- link handling
- text styling through `TextStyleKit`
- highlight, subscript, superscript, and typography helpers
- character counting
- slash commands
- drag handles and draggable node movement
- image handling

### Custom HTML-preserving extensions

The editor intentionally preserves more HTML than a minimal rich text field.
Current custom nodes/extensions include support for:

- `div`
- `style`
- `script`
- `svg`
- `span`
- a catch-all attribute preservation layer

This matters because some CMS-authored content and seeded content store richer
HTML fragments than plain paragraph markup.

## Inline Widgets

The editor currently ships two inline widget node types:

- alert widget
- call-to-action widget

These appear in multiple places:

- Tiptap commands and slash-command actions
- editor node views in `libs/editor`
- runtime React renderers in `apps/nextblock/components/blocks/renderers/inline`

So the widgets are not just editor-only decorations; they have both editing and
front-end rendering paths.

## NotionEditor Integration Pattern

`NotionEditor` is the higher-level client component used by the app. It wraps:

- the extension kit
- toolbars and menus
- content synchronization through `onChange` and `onUpdate`
- media picker bridging through editor storage
- hydration-safe initialization with `immediatelyRender: false`
- a scrollable editing shell and character counts

The app currently mounts it in multiple places, including:

- text block editing
- product description editing

## Media Picker Integration

The editor integrates with a pluggable image picker bridge:

- `setOpenImagePicker()` stores a picker callback on the editor instance
- menus and extensions can open the media picker without knowing app details
- the CMS supplies the actual picker UI

This keeps the editor package reusable while still supporting CMS media
selection.

## Commerce-Aware Blocks

The block layer is not content-only. The app also ships block types that render
commerce primitives backed by `@nextblock-cms/ecommerce`, including:

- product grid
- featured product
- cart
- checkout
- product details

These bridge the CMS page builder to the premium commerce library without
copying storefront logic into the app.

## Custom Blocks (Data-Driven CRUD)

Beyond the code-defined built-ins above, editors can create their own block
types at runtime from the CMS, with no code deploy. These **custom block
definitions** are stored as rows in `custom_block_definitions` (typed fields
plus a recursive layout schema) and rendered on the public site by a dynamic
layout engine instead of a compiled React renderer.

The wiring is intentionally simple: a page/post block whose `block_type` equals
a custom definition's `slug` is resolved through
`getCachedCustomBlockDefinitionBySlug()` and rendered by
`CachedDynamicLayoutEngine`. Authoring, CRUD, duplicate, and JSON
import/export/backup all live under `app/cms/custom-blocks`.

Full details, including the field types, the layout schema, caching, and the
Cortex AI "build widget" path, are in
[10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md).

## Relationship to the SDK

The registry is the current in-app block system. The formal external authoring
contract lives in `libs/sdk` and is documented in
[07-BLOCK-SDK-AND-EXTENSIBILITY.md](./07-BLOCK-SDK-AND-EXTENSIBILITY.md).

If you are changing how blocks work inside the CMS, start here. If you are
designing a reusable third-party block contract, start with the SDK doc.

## Themes and Colour

### Editable site themes

Themes are rows in `site_themes`, edited at **/cms/settings/global-css**. An
ADMIN can recolour any theme, create new ones, duplicate, reorder, hide, set the
site default, and delete non-system themes.

The pipeline is:

1. `app/layout.tsx` reads the table through a cached `getCachedSiteThemes()`
   (tag `public-layout-site-themes`).
2. `lib/themes/buildThemeCss.ts` renders each row to a `:root.<slug> { ... }`
   rule, injected as a `<style id="nb-theme-tokens">` in `<head>` — before the
   Global CSS box, so custom CSS can still override a theme.
3. `app/providers.tsx` feeds the slug list and default to `next-themes`, and
   `context/ThemeCatalogContext.tsx` carries names + icons to the switcher.

`libs/ui/src/styles/theme.css` remains as the fallback palette for standalone
consumers of the published `@nextblock-cms/ui` package. Generated rules use
`:root.<slug>` (specificity 0,2,0) so they always beat that file's `.dark` /
`.vibrant` rules (0,1,0) regardless of stylesheet order.

### Token storage

Colour tokens are stored as **bare HSL triplets** (`"222 47% 11%"`), not hex,
because `libs/ui/tailwind.config.js` composes them as `hsl(var(--primary))` and
appends alpha as `hsl(var(--primary) / 0.5)` — only a bare triplet supports
that. `lib/themes/tokenColor.ts` converts to and from the hex the colour picker
speaks. The allowed token list lives in `lib/themes/tokens.ts`; anything not on
it is dropped on save, and values are shape-checked, because the result is
interpolated into a `<style>` tag.

Per-theme `extra_css` is emitted **nested inside** the theme rule, so authors
write `& h1 { ... }` and scoping is automatic. `sanitizeExtraCss()` strips `<`
and unbalanced `}` so it cannot escape the rule or close the style element.

### Known limitation: `dark:` utilities under custom themes

Tailwind's dark variant compiles to `.dark`, and `darkMode: ['class']` is fixed
at build time. A custom theme with `color_scheme: 'dark'` recolours every token
and sets CSS `color-scheme`, but does **not** activate `dark:` utilities — the
same behaviour the shipped `.vibrant` theme has always had.

It cannot be fixed by mapping the theme to two classes: `next-themes` applies
its value with a single `classList.add(value)`, and `DOMTokenList.add` throws
`InvalidCharacterError` on a string containing a space. Wiring `dark:` to a data
attribute would require a pre-hydration script mirroring next-themes' own.

Verify the database → CSS path without booting the app:

```bash
npm run verify:site-themes
```

### Block text colour

`apps/nextblock/lib/blocks/blockColors.ts` is the single source of truth for
block text colour, shared by `HeadingBlockRenderer`, `EditableBlock` and
`ColumnEditor` so the CMS preview cannot drift from the live page.

A stored value is either a **theme token** keyword (`"primary"` — follows the
theme) or a **literal CSS colour** (`"#FF8800"` — fixed). Tokens render as a
static Tailwind class; literals render as an inline `style`. `resolveTextColor()`
returns `{ className?, style? }` and falls back to `{}` for anything it does not
recognise, so a hand-edited value degrades to the inherited colour instead of
emitting a bogus class.

Class names here are written as **complete literals**. Tailwind v4 ignores the
`safelist` key in the legacy JS config — `libs/ui/tailwind.config.js` still
carries one, but v4 never reads it, so a class exists only if the scanner finds
the whole string in a source file.

The editor control is `ColorField` from `libs/ui`, which offers the theme tokens
and a custom picker (hex, alpha, screen eyedropper, recent colours) with a live
WCAG contrast badge measured against the section background.
