@AGENTS.md

# apps/nextblock — the NextBlock app

Next.js 16 App Router app: public site, CMS under `app/cms`, API routes under `app/api`,
first-boot wizard under `app/setup`. Standalone projects are a copy of this directory with
`@nextblock-cms/*` installed from npm.

## Map
- `proxy.ts` (Next 16 middleware): `/setup` gate, DB redirects, CSP nonce, `/cms` session + role
  checks (`/cms/admin|users|settings|affiliates` ADMIN-only); `app/cms/layout.tsx` adds 2FA. It
  also sets the partner referral cookie `nb_affiliate_ref` (GET document navigations to
  `/partners/<handle>` or `?ref=`; `private, no-store` on those responses), pins `X-User-Locale`
  to French on `/partenaires` and every path below it (`isFrenchPartnersPath`), and forwards
  `x-nextblock-path` / `x-nextblock-search`; the rules live in the import-free
  `lib/affiliates/referral-cookie.ts` and `partners-paths.ts`.
- Affiliates (docs/15): `app/(public)/partners` (signup, storefronts, `/partners/terms`),
  `app/(public)/partenaires` (the French landing and `/partenaires/conditions`),
  `app/(portal)/portal/retailer` (partner portal, `requireRetailerPage()` / `requireRetailer()`),
  `app/cms/affiliates`, `app/api/affiliates/*` (upload, copilot, payout cron); server modules in
  `lib/affiliates/` (`lib/affiliates/paypal/`: PayPal Payouts, 02037: the REST client, the
  CMS-or-env credentials, the payout run's PayPal step and `/cms/affiliates/paypal`'s work; PayPal
  is never called on the public sandbox). Every surface gates on
  `isAffiliatesProgramActive()` (`lib/affiliates/package-state.ts`: the package AND Commerce Pro,
  which it is an add-on to). Partner JSON is untrusted: sanitize at read time, render with
  `StorefrontRenderer`.
- `lib/cron/cron-secret.ts`: `isCronRequestAuthorized()` for any route that checks `CRON_SECRET`
  (constant-time; never compare the header with `===`).
- `lib/i18n/translation-pages.ts`: `readAllTranslationRows()` for any read of many
  `translations` rows (PostgREST stops at 1000); `lib/media/media-pages.ts`: `readAllMediaRows()`
  for `media` (the library, the CMS transfer's media map).
- `lib/commerce/addon-base-products.ts`: the store products an add-on license requires (Commerce Pro
  for Affiliates), loaded by the product details, cart and checkout blocks and the `/cart` and
  `/checkout` routes for the add-on notices (libs/ecommerce `product-addons.ts`; docs/15 → "On the store").
- Media usage (docs/03 → "Deleting media"): `lib/media/media-usage.ts` (`findMediaUsage`, server-only,
  the service-role call of `public.media_usage`, 02045; call it only after `getCmsActor()` found
  staff, and show anyone but an ADMIN its answer through `withoutAdminOnlyLabels`) and the
  import-free `lib/media/media-usage-format.ts` (answer parsing, labels, links, `isMediaUnused`:
  revisions are history, drafts are uses). A failed lookup is an error, never "unused"; nothing
  automatic deletes on its answer (`deleteUnusedMediaItems` checks again). 02045 ignores a key
  longer than `MAX_OBJECT_KEY_LENGTH` (512), so raising that constant needs a forward migration of
  the function, and it reads each document as JSON text: a column it reads is a listed jsonb column
  or goes through `to_json` (`media-usage.test.ts` checks each docs branch).
- `lib/blocks/blockRegistry.ts` + `blockTypes.ts`: built-in block schemas and defaults.
  `components/BlockRenderer.tsx` resolves `block_type` via `components/blocks/publicRendererLoaders.ts`,
  then the ecommerce loaders, then custom blocks; unknown types render null unless editing. The
  CMS opens a block's editor by its `editorComponentFilename` through
  `app/cms/blocks/components/blockEditorLoaders.ts`, unless the definition sets `EditorComponent`
  (opened instead; a `section` opens its config panel): an editor file without an entry there opens
  nothing (`blockEditorLoaders.test.ts`), and `npm run update` names each such file (standalone
  and monorepo installs, from the run after the update that brings 0.23.4).
- Block row writes: delete+insert in `app/actions/visualEditingActions.ts`,
  `app/cms/revisions/service.ts` and `lib/cms-transfer/server.ts` (separate requests). A product
  draft publish is one call, `public.publish_product_draft` (migration 02043;
  `lib/visual-editing/product-drafts.ts` writes nothing itself): it locks the products row, then
  the draft row, refuses with nothing written when the draft is gone (NBP01 →
  `NO_PRODUCT_DRAFT_ERROR`: a second publish waits on the lock and lands here), changed since the
  action read it (NBP02: a save landed in between) or the products row did (NBP03), then writes the
  product values or overlay fields, the blocks, History and the draft delete in one transaction.
  A product draft UPDATE that matches no row found the draft published or discarded: the in-page
  save and the form autosave put the edit into a new draft, the block actions answer
  `PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR`. A new draft writer selects its rows back
  (`.select("id")`): supabase-js reports a bare UPDATE that matched nothing as a success.
- Product drafts (docs/09 → "Product Drafts"):
  - `lib/visual-editing/product-draft-meta.ts` (import-free): `classifyProductDraftMeta`, the
    `form_version` marker, what an overlay or a legacy snapshot publishes (the `updated_at` rule),
    which the edit page, the storefront preview and the in-page editor show too, the rewrite of a
    legacy snapshot as an overlay (recording the snapshot fields it keeps) and the shared messages.
  - `lib/visual-editing/product-drafts.ts`: publish (`requireCmsAdmin()` first, any draft; only
    product values reach the function's `p_values`, completed from live by
    `completeProductDraftValues` and built by `buildProductDraftPublishValues`, never a draft's
    `status`, `media_id` or `explicitly_removed_media_ids`; the function keeps each variant row
    whose term set matches, with its id, order item links and scheduled prices, and never deletes
    media, it only unlinks a dropped gallery image; since 02044 it writes a SKU's stock only where
    the draft's quantity differs from both the `stock_baseline` the edit page loaded
    (`buildProductStockBaseline`) and the current stock, as a change to the current stock, so a sale
    made while the page was open stays sold, and its `stock_adjusted` answer (`already_live`,
    `moved`, since 02047 `already_published`) becomes a publish warning naming the draft's figures;
    since 02047 the edit page reads the product's `product_stock_publishes` row BEFORE the product
    (`readStockPublishForEdit`; never after it, or a count would vouch for a stock read before a
    publish) and records its count beside the baseline (`stock_baseline_publish_count`), and a
    baseline whose count is below the product's counts a SKU whose entry the last publish used from
    the figure that publish entered (publish sends a null baseline entry for a SKU the live product
    stocks that the baseline lacks); publish refuses a draft holding a
    stock or a SKU it cannot read (`findUnreadableProductDraftValues`), and with a draft open
    `reconcileProductDraftStock` shows what that publish would write, from the same row, over the
    live stock as the baseline, and `getProductDraftEditNotices` names each kind above the form
    (docs/09 → "Stock: only what the editor changed"); the Freemius coupon push runs after the commit;
    every error the database answers rolled it all back, only a call with no answer may have
    committed) and the in-page save (a legacy snapshot becomes an overlay; it refuses a draft
    publish refuses, `findPoisonedProductDraftFields`, and an edit that would make publish refuse
    one).
  - Product History content is `public.product_revision_content` (02043: meta, blocks and
    `commerce`), which the publish records in its transaction and `getFullProductContent`
    (`app/cms/revisions/utils.ts`) reads; a restore never replays `commerce` and records the
    product as it then is.
    `currentUserCanPublishProductDrafts()` is publish's check for the UI, which disables Publish
    (and every product visibility action) for anyone else: the edit page hands it to the draft bar
    and the visibility control, the root layout (only while the visual editor is on, through
    `import()`) to the storefront toolbar.
  - `app/cms/products/productFormData.ts`: the live fill-in (`completeProductDraftValues`), the
    old-draft check (`findPoisonedProductDraftFields`) and the edit page's merge and notes. A
    draft's gallery is shown as publish writes it (`resolveProductDraftGalleryForEdit`, through the
    ecommerce `product-gallery` reading: media rows only, publish's order, a note for what publish
    drops): `products/[id]/edit/gallery-parity.test.tsx` runs the real page and publish on crafted
    drafts. A list field that is not a list shows live, as publish keeps it
    (`PRODUCT_VALUE_LIST_KEYS`), and a draft's variation attributes and variant options show only as
    the form can read them (`isReadableVariantOption`).
    `ProductDraftFlagProvider.tsx`: the edit page's one draft flag, latched on after an autosave
    (which revalidates nothing) until the page loads again; the draft bar and the visibility
    control read it.
- `lib/setup/env-status.ts` resolves Supabase env; keep it free of Node/Supabase imports.

## Commands
Monorepo: `npx nx serve nextblock`, `npx nx build nextblock`, `npx vitest run apps/nextblock/<file>`.
Standalone: `npm run dev`, `npm run build`.

## Rules
- Import `z` from `lib/zod-config.ts` (jitless; the prod CSP bans eval).
- A client component the server also renders prints a timestamp with `components/LocalDateTime.tsx`
  (`format` for a date alone), never `toLocaleString()`: the server's time zone and locale are not the
  browser's, and React throws #418 and re-renders the page (`/cms/media/[id]/edit` did;
  `MediaEditForm.hydration.test.tsx`). `suppressHydrationWarning` is no fix: React keeps the server's
  text (Messages, Interactions and `/thread` showed UTC). Guard: `tools/scripts/client-locale-format.test.ts`
  (an allow-list says why each remaining `toLocale*String()` call never reaches the first render).
- Server modules `import 'server-only'`; set `export const runtime = 'nodejs'` on Node-only route handlers.
- Browser bundles resolve `postcss` to the empty `lib/browser-stubs/postcss.cjs` (`next.config.js` →
  `turbopack.resolveAlias`): sanitize-html requires it but never calls it. No client code may use
  postcss; `lib/browser-stubs/postcss.test.ts` fails if sanitize-html starts to. `npm run update`
  adds the same entry to standalone projects scaffolded earlier
  (`tools/lib/postcss-browser-alias.mjs` keeps its own copy of the entry and its comment;
  `postcss-browser-alias.test.mjs` fails when its value drifts from `next.config.js`'s).
- On public routes, the CMS layout and the block editors, import `@nextblock-cms/ecommerce`
  through deep subpaths (`/product-actions`, `/components/Cart`, …), never `.` or `/server`
  (`import type` is fine): a route ships every client component its server graph reaches, and the
  barrels reach all of them. Commerce block renderers draw client components through
  `components/commerce/LazyCommerceClients.tsx`; a server-side `import()` does not split client
  code. Its `import()`s name app modules (`components/commerce/lazy/*` re-export the library's
  components): an `import()` of a lib makes Nx refuse every static import of that lib.
  Guard: `tools/scripts/commerce-chunking.test.ts`; docs/05 "Public Page Performance Budget".
- Client code on public routes, lazy chunks included (`LazyCommerceClients`, `next/dynamic`,
  `React.lazy`, the file a Web Worker or a service worker names; the in-page editors aside),
  imports `@nextblock-cms/utils` through deep subpaths (`/utils` for `cn` and the currency
  helpers, `/translations-context`, `/color`, …), never `.`, and no Zod (`zod` or `import('zod')`,
  `lib/zod-config.ts`, `/custom-blocks`): the barrel carries sanitize-html (CommonJS) and Zod, and
  the package declares no `sideEffects`, so one import puts both in that chunk. `/authored-html`
  or sanitize-html (static or `import()`) only in a lazy chunk that sanitizes in the browser
  (`SANITIZING_LAZY_CHUNKS`, with why). Mock the deep module in tests. Guard:
  `tools/scripts/root-layout-chunking.test.ts`.
- `import()` / `require()` take one string literal: a template literal with a substitution, a
  variable, `require.context` or `import.meta.glob` (called, stored or destructured) bundles the
  whole folder, tests included (0.23.0–0.23.3 standalone builds failed on `vitest`). Never use
  `import.meta` whole (read or destructure its members: `import.meta.url`) or Node's `require` as
  a value (a local binding named `require` may be); a cast hides nothing, and `module.require()`
  and `new URL(..., import.meta.url)` take a literal too, as do a `createRequire()` function and
  `require.resolveWeak()`. Choose a module at runtime through a loader map
  (`app/cms/blocks/components/blockEditorLoaders.ts`). Guard:
  `tools/scripts/dynamic-import-specifiers.test.ts`.
- A draft publish's warning, and an error that starts "Published, but" (the edits are live), stay
  on screen until the editor dismisses them, with no automatic reload: the draft bar (which hides
  at once, unless the draft row survived a failed delete, and comes back for the next draft: a
  product's on the next autosave or server-reported draft, `draftSaveCount`) shows them in a toast
  with "Reload page" and "Dismiss" buttons, the visibility dialog until it is
  closed (the control's dialogs ignore a dismissal while a write runs). A gone draft answers
  `NO_PRODUCT_DRAFT_ERROR` / `NO_CONTENT_DRAFT_ERROR` (`lib/visual-editing/product-draft-meta.ts`):
  the dialog then changes only the visibility, and the draft bar hides and reloads; a product
  revision restore reloads the page (the draft flag only latches on). Guards:
  `DraftStatusActions.test.tsx`, `VisibilityControl.test.tsx`, `RevisionHistoryButton.test.tsx`.
- Generated, never edit: `lib/setup/migrations-bundle.ts`, `app/api/cron/reset-sandbox/sandboxResetSql.ts`,
  `lib/custom-block-safelist.ts`, `next-env.d.ts`, the Next block in `AGENTS.md`.
