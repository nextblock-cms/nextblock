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
- `posts_grid` (renders `id` = its optional `anchor`, default `latest`, the target of the seeded `/articles#latest` button; give a second grid on the same page its own anchor)
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

#### Section layout flags

Two checkboxes in the section editor's layout panel
(`app/cms/blocks/components/SectionConfigPanel.tsx`) change how a section renders,
and both are plain booleans on its `content`:

- **Hero Section (Prioritized image loading)** — `is_hero: true`. The section's
  background image (and the first slide of a hero carousel) renders with
  `priority`, so it is not lazy-loaded below the fold, and Cortex's section
  normalizer defaults a hero's `vertical_alignment` to `center`. Set it on the
  section that opens a page; it is a loading hint, not a style switch.
- **Enable Slider (Carousel layout)** — `slider: true`, with a `slides` array of
  `{ background, column_blocks }` entries. `SectionBlockRenderer` then renders
  `SectionSlider` over those slides and IGNORES the section's own top-level
  `column_blocks` and `background`; `autoplay` plus `timeframe` (seconds,
  default 5) rotate it. A `slider: true` with no slides falls back to the normal
  single layout (the normalizer clears the flag rather than rendering an empty
  carousel).

  One trap worth knowing, because it bites anything that writes a slider
  programmatically: the grid track count stays a SECTION-level setting. The
  renderer computes one `gridClass` from `content.responsive_columns.desktop` and
  applies it inside every slide, and the editor resizes each slide's
  `column_blocks` to that same number (`SectionBlockEditor`). Cortex's normalizer
  derives `desktop` from the top-level `column_blocks`, which a slider usually
  leaves empty — so a section whose columns live only in `slides` renders every
  slide as a single column. The agent prompts therefore tell the model to send one
  top-level column per column it wants inside each slide, even though only the
  slides are drawn.

Both flags are in `SectionBlockSchema` (`lib/blocks/blockRegistry.ts`) and
mirrored in Cortex's `sectionBlockFallbackSchema`, so the agent can set them
too — see docs/08 "Section Design Intelligence".

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

## Feature images and the social preview image

Two different images decide what a page shows at the top and what a shared link
shows, and confusing them produces a duplicated title banner on a home page.

**`pages.feature_image_id` / `posts.feature_image_id`** is a media row, picked
with `FeatureImageField` in the page/post form. It is not a hidden thumbnail:

- On a **page**, `app/[slug]/PageClientContent.tsx` renders it as a full-width
  banner ABOVE the page's blocks — the image dimmed as a cover background, about
  200–300px tall, with the page title centred over it in white. Pick a very wide
  landscape image, because the banner crops it to a short band. A page that
  already opens with its own hero section should have NO feature image, or the
  banner stacks above the hero and repeats the title. The home page in
  particular should not have one.
- On a **post**, `PostClientContent.tsx` renders it as the article's hero image
  above the header, and the post listing uses it as the card thumbnail. Posts
  should have one.
- Either way it is also that page's Open Graph / Twitter preview image, served as
  the original upload rather than the AVIF the page renders. See below.

**`site_settings.site_social_image`** is the site-wide share preview, edited on
`/cms/settings/logos` (Branding → Site identity & SEO → "Social preview image",
a media picker with a 1200×630 preview frame) and by Cortex's
`update_site_identity` `social_image` argument. It is used for any page, post or
product that has NO feature image of its own, and for the root layout's default
metadata. Without it, link previews fall back to NextBlock's bundled banner
(`DEFAULT_OG_IMAGE`), which is never what a client site wants.

The value is JSONB in the shape `parseSiteSocialImageSetting`
(`libs/utils/src/lib/seo/social-image.ts`) validates: a media pick stores
`media_id` + `object_key` + size (resolved to a URL at read time, so the media
host can change; the key is the ORIGINAL upload, see below), while Cortex may
store a hotlinked `url` instead. It is read
by `getSiteSettings` (`app/lib/site-settings.ts`, cached, tag
`public-site-settings`) and handed to `buildSocialMetadata` as `fallbackImage`.
So the resolution order for every public page is: the page's own feature image →
the site social preview image → the bundled NextBlock banner.

### Link previews use the original upload, not the AVIF

`app/api/process-image/route.ts` converts every upload to AVIF
(`TARGET_FORMAT = 'avif'`) and `app/api/media/record/route.ts` makes that derivative
the row's `object_key`. That is what the site renders, and it should be: AVIF is far
smaller and every browser NextBlock targets decodes it. The untouched file is kept
alongside it in `media.variants` under the label `original_uploaded`.

Social link-preview crawlers are not browsers. Facebook, LinkedIn, X and most chat
apps fetch `og:image` without AVIF support, so an AVIF preview shows nothing at all.
So every image that exists to be crawled resolves through
`pickOriginalUploadObjectKey` (`@nextblock-cms/utils/media-variants`, re-exported
app-side as `lib/media/original-upload.ts`) instead of `object_key`:

- pages and posts expose `feature_image_social_url` beside `feature_image_url`, and
  only `generateMetadata` reads it; the rendered banner and hero keep the AVIF,
- the product page resolves its `og:image` the same way, while the storefront
  gallery keeps the AVIF,
- the Branding picker and Cortex's `social_image` both STORE the original's key and
  its own width and height, since that value has no other consumer.

Post listing cards are deliberately left alone: they render in a browser, where AVIF
is the right choice. Rows that kept no original variant, such as the seeded demo
media, fall back to `object_key`, so a caller never ends up with no image. The same
selection has always backed transactional email, where Outlook cannot decode AVIF
either; `lib/email/branding-format.ts` now delegates to the shared helper rather
than keeping its own copy.

### App icon and web app manifest

A site installs (Android and desktop PWA install, iOS "Add to Home Screen") with an
icon rendered from its **active logo**, not the NextBlock "NB" art. There is no
separate setting: the Branding page shows a read-only "App icon" preview under the
logos list, and the icon changes when the active logo does. Square logos work best.
A wide wordmark is letterboxed, so a 5:1 mark ends up about 35 px tall on a 192 px
icon.

- **Source order.** The active logo (`site_settings.active_logo_id`, else the newest
  `logos` row) resolves through `pickOriginalUploadObjectKey`, the same selection as
  link previews above: the untouched upload first (an SVG stays vector until it is
  rasterised at icon size), then the AVIF `object_key`. `resolveAppIconSource`
  (`lib/branding/app-icon.ts`) returns the default when there is no logo or the URL is
  not absolute http(s). That covers the seeded bundled `images/…` logo on every fresh
  install and the sandbox, and an install with no media host.
- **Defaults.** In that case the manifest and the apple-touch-icon link point straight
  at the static files in `public/favicon/`: `android-chrome-192x192.png` and
  `-512x512.png` (`any`), `maskable-512x512.png`, and `apple-touch-icon.png`. The last two
  are opaque on white and are generated by
  `npx tsx --tsconfig=tsconfig.base.json --conditions=react-server tools/scripts/generate-default-app-icons.mts`
  with the same renderer a custom logo goes through. Keep the android-chrome PNGs: external
  listings hot-link the 192.
- **Rendering.** `app/api/brand/app-icon/[variant]` (variants `192`, `512`,
  `maskable-512`, `apple-180`) fetches the logo (5 s timeout, 10 MB cap) and renders it
  with sharp (`lib/branding/render-app-icon.ts`). The pixel limit is 40 MP, transparent
  margins are trimmed, and an opaque badge is never trimmed. The `any` icons are
  transparent with a 4% margin. The apple icon has a 12% margin. The maskable and apple
  icons are painted on the default theme's `--background` (`themeColorFor`, the colour the
  header logo already sits on), because iOS draws a transparent icon on black. Any
  failure 307s to the static icon with `no-store`, so a transient error is retried
  rather than pinned.
- **Maskable safe zone.** Launchers crop a maskable icon to their own shape, and only
  the centred circle of radius 40% is guaranteed to survive. The renderer scales the logo
  so its diagonal fits that circle, with about 2% of slack.
- **Caching.** `loadAppIconContext` (`lib/branding/app-icon-context.ts`) reads the logo
  through `getCachedActiveLogo` (`lib/logos/cached-active-logo.ts`, tag
  `public-layout-logo`, shared with the header) and the themes (tag
  `public-layout-site-themes`). It hashes logo id, media id, file key, media `updated_at`,
  background and `APP_ICON_RENDER_VERSION` into a 12-character version. Icon URLs carry it
  as `?v=`. A matching `?v=` is served `immutable`, and a stale or missing one gets
  `max-age=300`. Rendered PNGs sit in `unstable_cache` keyed by that version (tag
  `public-app-icon`, one week). Every Branding logo action evicts `public-layout-logo`.
  That refreshes the manifest (an ISR route that also carries `public-site-settings`),
  the layout link and the version, and Chrome picks up the new `?v=` as an icon update.
  Bump `APP_ICON_RENDER_VERSION` whenever the renderer's output changes.
- **Manifest.** `app/manifest.ts` is a thin wrapper around `buildWebManifest`. It sets
  `id`, `scope` and `start_url` to `/`, and `name` and `short_name` to the brand part of
  the site title. `brandNameFromTitle` splits only on a space-padded `|`, `–`, `—` or
  `-`, or on a colon followed by whitespace. So "Acme Bakery | Fresh bread" installs as
  "Acme Bakery", while "Rock-n-Roll Café" and "Café 10:30" stay whole. The name is never
  truncated. The root layout sets `appleWebApp.title` to the same brand, so iOS stops
  suggesting "Page | Brand" as the label. The theme colours come from the default theme.
  `public/favicon/site.webmanifest` was an unlinked leftover and has been removed.
- **The favicon stays static.** The browser-tab icons (`/favicon/favicon.ico`, the
  16/32 PNGs and `app/favicon.ico`) remain the NextBlock art: a wordmark is illegible at
  16 px. A dedicated square "site icon" field would be the way to brand them.
- **Setup gate.** `proxy.ts` allowlists `/manifest.webmanifest` and `/api/brand/`, since
  browsers fetch both without cookies and an unprovisioned install would otherwise
  answer them with the `/setup` page.

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
