# Web Interface Guidelines audit — public site

- **Rules:** Vercel Web Interface Guidelines, fetched 2026-09-17 from
  `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
  (the source the `web-design-guidelines` agent skill reviews against).
- **Scope:** the public surface — root layout and public routes, auth pages, profile,
  thread, `apps/nextblock/components/**`, the block renderers, and the design system
  (`libs/ui/src/lib/*.tsx`, `libs/ui/src/styles/*.css`). About 130 files, each read in
  full. Cart, checkout and product UI inside `libs/ecommerce` were **not** audited.
- **Line numbers** refer to commit `d33bc3f` (before the fixes listed under "Status").
- **Tags:** `[MUST]` = an explicit rule or a listed anti-pattern is clearly violated.
  `[NICE]` = judgment call or polish. "BUG" = a verified defect no rule names.
- **Live check** of `https://cms.nextblock.dev/` (home, `/articles`, `/sign-in`): `lang`
  set, zoom not blocked, every `<img>` has `alt` + `width`/`height`, lazy loading plus one
  high-priority image, exactly one `h1` per page, no heading-level jumps. Missing: skip
  link, `<meta name="theme-color">`, `preconnect`.

## Status

**Read this first.** Sections 1 to 4 are the audit *as found*: every line there describes the
code before any fix, so they still read like open problems. They are kept as the record of
what was wrong. What is actually open is section 10, and only section 10.

| Group from the first open list | Status |
| :-- | :-- |
| Mobile navigation: `aria-expanded` on desktop parent links, English-only submenu label | Done (section 6) |
| Slider: arrow keys, photo credit on slide backgrounds | Done (section 6), swipe added (section 8) |
| Form block: `fieldset`/`legend`, label gaps, values kept after a server error, silent reCAPTCHA failure, autofillable honeypot, Turnstile theme | Done (section 6) |
| Form block: `tel` / `url` / `number` field types | Done (section 8) |
| Form block: per-field `aria-invalid` | Not applicable: the server only returns form-level errors, and the browser's own validation covers required and email fields |
| Search: links for results, combobox semantics, `aria-pressed` chips, guarded `localStorage`, focus while the chunk loads | Done (section 6) |
| Reviews and comments: star radio group, focus ring, rating text, `h3`, textarea `name`, `aria-pressed` | Done (section 6) |
| Remaining S12 sites (`ContactSellerSection`, `view-live-button`) | Done (sections 6 and 7) |
| Orders page date | Done (section 7, fixed time zone in `formatInvoiceDate`) |
| `DynamicLayoutEngine`: currency, developer warnings, image dimensions | Done (section 6); plain string image values still have no dimensions to use |
| Images and LCP: text block first image, image block `fetchPriority`, article preload | Done (section 6) |
| Pagination state in the URL | Done (section 6); pages 2+ without JavaScript done (section 9) |
| Logo alt text, button hover contrast (S14), dark focus ring (S15), `short_description` | Done (section 9) |
| Design system: unlabeled controls | Done (section 6) |
| Manifest, `backdrop-blur`, hardcoded English | Done (section 6) |
| Shop UI (`libs/ecommerce`) not audited | Audited and fixed (section 7) |

Sections 5 and 6 list what was fixed in the first two passes, section 7 covers the shop audit,
sections 8 and 9 the third and fourth passes, and section 10 is what is still open.

## 1. Systemic (fix once, fixes every page)

| # | Finding | Where |
| :-- | :-- | :-- |
| S1 | `[MUST]` No `prefers-reduced-motion` handling anywhere in `apps/nextblock` or `libs/ui` (0 `motion-reduce:` utilities). Runs unchanged: enter/exit animations on dialog/sheet/popover/dropdown/select/tooltip, `animate-spin`, `animate-pulse`, `.shimmer` (infinite), every `transition-*`, slider autoplay and cross-fade, hover zooms, JS `scrollIntoView({behavior:'smooth'})`. Utilities are unlayered in the compiled sheet, so a global override needs `!important`. | `libs/ui/src/styles/globals.css:23`, `animations.css:24`, `spinner.tsx:19`, `Skeleton.tsx:10` |
| S2 | `[MUST]` No skip link; `<main>` has no `id` to target. | `apps/nextblock/app/layout.tsx:614`, `components/AppShell.tsx:117` |
| S3 | `[MUST]` No `<meta name="theme-color">` and no `viewport` export (only `site.webmanifest` `theme_color: #ffffff`). | `app/layout.tsx:609` |
| S4 | `[MUST]` No `touch-action: manipulation` on interactive elements (0 occurrences). | `libs/ui/src/styles/base.css:204` |
| S5 | `[MUST]` Native `<select>` gets `color: inherit` and no `background-color` (~37 native selects, incl. public checkout). | `base.css:108` |
| S6 | `[MUST]` No `text-wrap: balance` on headings (one heading app-wide opts in). | `typography.css:4`, `components.css:45`, `:53` |
| S7 | `[MUST]` `:focus` ring instead of `:focus-visible`. | `select.tsx:22`, `dialog.tsx:49`, `sheet.tsx:69` |
| S8 | `[MUST]` `transition-all`. | `progress.tsx:21`, `ColorPicker.tsx:45`, `ColorField.tsx:347`, `header-auth.tsx:35`, `ResponsiveNav.tsx:299`, `SectionSlider.tsx:100,107,124`, `PostCommentsSection.tsx:218,300,332`, `ProductReviewsSection.tsx:220,335,380` |
| S9 | `[MUST]` No `overscroll-behavior: contain` in any modal, sheet or drawer. | `dialog.tsx:38`, `sheet.tsx:34`, `ResponsiveNav.tsx:426` |
| S10 | `[MUST]` Tailwind 4 broke the v3 `[--var]` shorthand: invalid CSS is emitted, so the select zoom origin and max-height, and the searchable-select popover width, silently do nothing. Use `(--var)`. | `select.tsx:78`, `SearchableSelect.tsx:82` |
| S11 | `[MUST]` Literal `...` instead of `…` in loading and placeholder copy. Twelve seeded EN values in `02004_baseline_seed.sql` (`Search...`, `Submitting...`, `Sending...`, `Signing In...`) override the component fallbacks, so the complete fix needs a forward migration with EN + FR. | `submit-button.tsx:13`, `PageClientContent.tsx:163,173`, `PostClientContent.tsx:369,378`, `checkout/success/page.tsx:181`, `FormBlockRenderer.tsx:36`, `GlobalSearch.tsx:49,67`, `SearchableSelect.tsx:32,33`, `spinner.tsx:23`, `TestimonialBlock.tsx:70` |
| S12 | `[MUST]` Async status and errors rendered without `role="alert"` / `role="status"` / `aria-live`. | `form-message.tsx:18,23,28`, `ThreadView.tsx:131,155`, `FormBlockRenderer.tsx:256,325,329`, `PostsGridClient.tsx:104`, `GlobalSearch.tsx:497`, `PostCommentsSection.tsx:258,259,363`, `ProductReviewsSection.tsx:293,294,411`, `ContactSellerSection.tsx:99,177`, `view-live-button.tsx:119` |
| S13 | `[NICE]` Tailwind 4 `outline-none` is `outline-style: none` and rings are box-shadows, so every design-system control has **no** focus indicator in forced-colors / Windows High Contrast. Swap to `outline-hidden` (19 occurrences in 13 files + `components.css:362`). | design system |
| S14 | `[NICE]` Hover lowers contrast where it should raise it (`hover:bg-primary/90`: 6.40→5.06 light, 4.93→4.12 dark). No `active:` state while the tap highlight is removed, so touch gets no press feedback. | `button.tsx:13,15,19` |
| S15 | `[NICE]` Dark focus ring contrast: `--ring` is 2.69:1 against cards/popovers; `--accent` (the only focus indicator on menu and select items) is 1.09:1 against the popover. | `theme.css:77`, `:24`, `:66` |

## 2. Highest-impact component findings

### Mobile navigation — `apps/nextblock/components/ResponsiveNav.tsx`
- `:232` `[MUST]` focus is stolen on every mobile page load (effect runs on mount with the menu closed and focuses the hamburger; no "was open" guard, no `preventScroll`).
- `:195` `[MUST]` keyboard trap: Tab only, no Escape; the toggle sits outside the trap and the drawer has no close button.
- `:418` `[MUST]` closed drawer is only translated off-screen: links stay tabbable, and `role="dialog"` + `aria-modal="true"` are always exposed. Add `invisible` / `inert`.
- `:426` `[MUST]` drawer scroller lacks `overscroll-behavior: contain`; body is not scroll-locked.
- `:260` `[MUST]` `outline-none` with no replacement on the submenu toggle. `:249`, `:388` `[MUST]` `focus:` should be `focus-visible:`.
- `:299` `[MUST]` desktop submenu is hover-only: `invisible` children never become focusable (no `group-focus-within:visible`), parent link has no `aria-haspopup` / `aria-expanded`. Child pages are unreachable by keyboard.
- `:393`, `:397`, `:26` `[MUST]` hand-rolled decorative SVGs lack `aria-hidden`. `:417` `[MUST]` 300 ms slide with no reduced-motion variant.
- `[NICE]` `:389` label stays "Open main menu" while the button closes it; `:425` `100vh` should be `dvh`; `:263` English-only aria-label; `:406` scrim `<div onClick>` (acceptable once Escape exists); `:323` `media.alt_text` does not exist, so the operator's alt is never used.

### Section slider — `components/blocks/renderers/SectionSlider.tsx`
- `:39` `[MUST]` autoplay ignores `prefers-reduced-motion` and loops forever. `:72` `[MUST]` hover is the only way to pause: no control, no pause on focus or touch.
- `:86` `[MUST]` inactive slides stay in the tab order and the accessibility tree. `:100`, `:107` `[MUST]` prev/next are `opacity-0 group-hover:opacity-100` with no focus variant: invisible when focused, never shown on touch.
- `:100`, `:107`, `:124` `[MUST]` `transition-all` (`:124` animates `width`).
- `[NICE]` `:83` 700 ms cross-fade; `:129` dots lack `aria-current`, are 10×10 px, English-only labels; `:70` no carousel semantics or arrow keys.

### Form block — `components/blocks/renderers/FormBlockRenderer.tsx`
- `:36` `[MUST]` `'Verifying...'` / `'Submitting...'`. `:256` `[MUST]` success panel replaces the form with no `role="status"`; focus is lost. `:325`, `:329` `[MUST]` errors not announced; form-level only, no `aria-invalid`/`aria-describedby`, no focus move.
- `:378` `[MUST]` email input: no `autoComplete="email"`, no `spellCheck={false}`; `name` is opaque to autofill. `:306` `[MUST]` radio group `<Label htmlFor>` points at nothing; no `<fieldset>/<legend>`. `:363`, `:372` `[MUST]` radio/checkbox and label are siblings with a gap (dead zone).
- `[NICE]` `:287` React 19 resets uncontrolled fields when the action resolves, so any server error wipes the visitor's message; `:236` reCAPTCHA path swallows the submit silently when `grecaptcha` is absent; `:298` email-like honeypot can be autofilled and is answered with a fake success; `:347` no `tel`/`url`/`number` field types; `:97` Turnstile theme hardcoded to `light`; English-only copy.

### Search — `components/GlobalSearch.tsx`
- `:457` `[MUST]` input has no `<label>`/`aria-label`, no `name`, no `type="search"`. `:458` `[MUST]` focus indicator removed with no `focus-within` replacement. `:497` `[MUST]` results / loading / empty / error swap with no live region; spinner and skeletons have no text alternative. `:259` `[MUST]` result rows are `<button>` + `router.push`: use `<Link>` (Cmd/Ctrl/middle-click).
- `[NICE]` no combobox/listbox roles or `aria-activedescendant`, active row not scrolled into view; filter chips lack `aria-pressed`; FR fallbacks missing diacritics; `:201` unguarded `localStorage` write before navigation (click throws when storage is blocked). `DeferredGlobalSearch.tsx:18` trigger unmounts while the chunk loads, so focus drops to `<body>`.

### Comments and reviews
- `PostCommentsSection.tsx:268`, `:274` `[MUST]` **raw translation keys shown publicly**: `comments.cancel` and `comments.submitting` are seeded by no migration and `t()` returns the key.
- `PostCommentsSection.tsx:248`, `ProductReviewsSection.tsx:283` `[MUST]` textarea has no `name` / `autoComplete="off"`. `:312` / `:347` `[MUST]` heading skip h2→h4. `:323` / `:371` `[MUST]` user body text without `break-words`. `:235` / `:237` `[MUST]` entrance animation without `motion-reduce`.
- `ProductReviewsSection.tsx:243` `[MUST]` orphan `<label>`, star group has no `radiogroup` semantics or selected state. `:257` `[MUST]` `focus:outline-none` with no replacement on the stars. `:357` `[MUST]` displayed rating is five `aria-hidden` icons with no text alternative.
- `[NICE]` `dark:text-slate-350` is not a Tailwind shade, so comment, review and staff-reply body text is ~2.7:1 in dark mode (`PostCommentsSection.tsx:323`, `ProductReviewsSection.tsx:371`, `StaffReplies.tsx:95`); like buttons lack `aria-pressed`; disclosure buttons lack `aria-expanded`; `header-auth.tsx:56` key `profile` is seeded nowhere, so the menu item renders "profile".

### Auth pages
- `sign-in/page.tsx:50`, `sign-up/SignUpForm.tsx:104`, `forgot-password/page.tsx:48` `[MUST]` email `<Input>` has no `id` (the `<Label htmlFor="email">` points at nothing), no `type="email"`, `autoComplete="email"`, `spellCheck={false}`.
- `sign-in/page.tsx:60`, `SignUpForm.tsx:106` `[MUST]` password `<Input>` has no `id` and no `autoComplete` (`current-password` / `new-password`).
- `sign-in/page.tsx:41`, `:54`, `SignUpForm.tsx:96`, `forgot-password/page.tsx:41` `[MUST]` links have no `hover:` state.
- `two-factor/components/TwoFactorForm.tsx:126` `[MUST]` submit disabled until 6 digits are typed (rule: stays enabled until the request starts). `:96` `[MUST]` input has no `name`.
- `profile/password/PasswordSettingsPageClient.tsx:117` `[MUST]` submit has no pending state (double submit possible). `:57` and `profile/orders/CustomerOrdersPageClient.tsx:50` `[MUST]` page title sits in `<CardTitle>` (a `<div>`), so the page has no `<h1>`.
- `profile/ProfileAccountSidebar.tsx:62` `[MUST]` unbreakable email overflows the narrow card.

### Hydration and dates
- `article/[slug]/PostClientContent.tsx:269` `[MUST]` date rendered during SSR of a client component with no fixed `timeZone`: server (UTC) and browser can land on different days.
- `profile/orders/CustomerOrdersPageClient.tsx:86` `[MUST]` same, through `formatInvoiceDate` (`libs/ecommerce/src/lib/invoice.ts:189`).

### Custom blocks — `components/renderers/DynamicLayoutEngine.tsx`
- `:132` `[MUST]` `` `$${(cents / 100).toFixed(2)}` `` hardcoded currency format (wrong on FR pages). `:146` `[MUST]` a multi-currency map discards the currency code. `:276` `[MUST]` red developer `WarningTag`s are shown to public visitors (8 sites, no visual-edit gate). `:282`, `:285` `[MUST]` images without dimensions for string and relation values.
- `[NICE]` `:280` alt falls back to the field label; `:283` unconditional `loading: 'lazy'`; `:119` raw JSON can reach the page; `:331` empty values still emit the element.

### Images and LCP
- `blocks/renderers/ClientTextBlockRenderer.tsx:217` `[MUST]` `normalizeImageAttributes` runs before `forcePriority` is read, so `loading="lazy"` lands on the first image of an above-the-fold block; only the 16 hardcoded images can get priority. `:41` `[MUST]` pass-through `<img>` gets no `alt` fallback and no dimensions.
- `blocks/renderers/ImageBlockRenderer.tsx:64` `[MUST]` external `<img>` renders without `width`/`height` when missing. `:67` `[MUST]` the priority path sets no `fetchPriority="high"`.
- `[NICE]` `article/[slug]/page.tsx:196` manual `<link rel="preload" as="image">` of the raw media URL never matches the `/_next/image` URL the hero actually requests, so it downloads the original in competition with the LCP image; `BlockRenderer.tsx:208` posts grid, non-hero sections and custom blocks can never be prioritised; `SectionBlockRenderer.tsx:566` every image in a hero gets `priority`.

### Other `[MUST]`
- `blocks/TestimonialBlock.tsx:25`, `renderers/TestimonialBlockRenderer.tsx:26` `container m-8`: `m-8` overrides the container's auto margins at 100% width, so the block overflows its parent by at least 2rem below 1400px (derived from the CSS, not browser-tested). `:31` / `:32` straight quotes around the quote.
- `blocks/PostsGridClient.tsx:37`, `blocks/ProductGridClient.tsx:28` pagination lives only in state: not deep-linkable, pages 2+ unreachable without JS. `ProductGridClient.tsx:56` JS smooth scroll ignores reduced motion.
- `privacy/ConsentBanner.tsx:161` "Manage options" has no dark rest colour: slate-800 on slate-900 is ~1.2:1, effectively invisible. `:52` entrance animation without `motion-reduce`.
- `header-auth.tsx:34` icon-only avatar menu trigger without `aria-label`.
- `SandboxCredentialsAlert.tsx:23`, `:24` literal credentials lack `translate="no"` (auto-translate rewrites "password"). `AppShell.tsx:164` brand name lacks `translate="no"`.
- `thread/ThreadView.tsx:124` user message body lacks `break-words`.
- `[slug]/PageClientContent.tsx:156`, `PostClientContent.tsx:358`, `:373` straight quotes in copy.
- `components.css:75` `.prose a` has no `:hover` / `:focus-visible` rule and never sets an underline while `base.css:61` resets `a` to `text-decoration: inherit`: prose links are colour-only with no hover feedback.
- Design system: `SearchableSelect.tsx:85` search input unlabeled, `:86` all focus indication removed, `:104` focused and selected options look identical; `CustomSelectWithInput.tsx:60`, `:66`, `:93` unlabeled controls and an icon-only button without `aria-label`; `ColorPicker.tsx:37`, `:43` same.

## 3. Verified bugs no rule names
- `libs/ui/src/lib/dialog.tsx:45`, `sheet.tsx:65` `aria-describedby={props["aria-describedby"] || undefined}`: Radix sets its own `descriptionId` before spreading content props, so the explicit `undefined` always wins and **every `DialogDescription` is orphaned**, including the "what gets deleted" text in `ConfirmationDialog.tsx:36`.
- `dialog.tsx:38` the scroll wrapper is not an effective scroller: Radix's RemoveScroll only allows wheel/touch scrolling inside `Content`, the wrapper is `pointer-events-none`, and `items-center` clips the top of tall content (11 of 33 call sites hand-roll `max-h-[..vh] overflow-y-auto`). Fix once on `DialogPrimitive.Content`.
- `progress.tsx:11` `value` is destructured and never forwarded to the Radix root: no `aria-valuenow`, state is always "indeterminate".
- `blocks/renderers/inline/CtaWidgetRenderer.tsx:31` missing `data-url` reaches `formatUrl(undefined)` and throws, taking down the page render; missing `data-style` yields the literal class `undefined`.
- `blocks/renderers/ButtonBlockRenderer.tsx:42` size whitelist accepts `'icon'` but not `'full'`; `:76` `mailto:` / `tel:` links get `target="_blank"`.
- `thread/page.tsx:15` `fetchCache = 'force-no-store'` disables every `unstable_cache` under the segment (project rule).
- `public/favicon/site.webmanifest`: empty `name`/`short_name`; icon paths point at the public root, the files live in `/favicon/`.
- Project rule (not WIG): `backdrop-blur-*` in hero content at `SectionBlockRenderer.tsx:600`, `SectionSlider.tsx:100,107`, `PostClientContent.tsx:407`. Slider slide backgrounds never render `StockPhotoCredit` (Unsplash attribution missing on slides).
- Bilingual public surfaces with hardcoded English: unauthorized page, `TwoFactorForm`, `PostsGridClient` labels, `ProductGridClient` labels, slider and YouTube facade aria-labels, `StockPhotoCredit`, FormBlock Turnstile messages, `dialog`/`sheet` "Close".

## 4. Confirmed OK
- `<html lang>` is per request and kept in sync client-side; viewport does not block zoom; locale detection uses cookie → header → `Accept-Language`, never IP.
- Images: `next/image` with `width`/`height` or `fill` + `sizes` and blur placeholders; logo and hero pass `priority`; YouTube poster toggles priority/lazy correctly; search thumbnails use `alt=""`.
- Semantics: no `<div onClick>` (one acceptable scrim), navigation uses `<Link>`/`<a rel="noopener noreferrer">`, no `onPaste` blocking, one justified `autoFocus` (2FA code), no GIFs, no layout reads in render.
- Focus: Button, Input, Textarea, Checkbox and RadioGroupItem carry `focus-visible:ring-2`; there is no global outline reset, so plain links keep the browser ring.
- lucide-react 0.577 adds `aria-hidden` to icons without a11y props, so bare lucide icons pass; only hand-rolled SVGs are flagged.
- Intl: currency via `Intl.NumberFormat`, dates via `Intl.DateTimeFormat` / `toLocaleDateString(locale, opts)` (exception: `DynamicLayoutEngine`).
- `-webkit-tap-highlight-color` set intentionally; `color-scheme` emitted per theme by `buildThemeCss.ts:55`; fonts are a system stack, so no preload / `font-display` requirement applies.
- ProductGridClient: `aria-busy`, `role="alert"`, `aria-live="polite"` page status, labelled `<nav>`, `scroll-mt-24`. SEO panel: live score region, `role="meter"`, `tabular-nums`, `…` in loading copy. 2FA form: `inputMode="numeric"`, `autoComplete="one-time-code"`, paste allowed.
- Toasts (sonner + react-hot-toast) render polite live regions.

## 5. Fixed in this pass

Verified with the app and `libs/ui` typechecks, lint (no message in any touched file), the
`libs/ui` production build plus `verify-lib-dist.js`, and a dev-server check of `/`,
`/articles`, an article, `/sign-in`, `/sign-up`, `/forgot-password` and `/thread` in
English and French.

### Systemic
- **S1** One global `prefers-reduced-motion` rule (`libs/ui/src/styles/animations.css`).
  Motion driven from JavaScript checks the same media query: slider autoplay
  (`SectionSlider.tsx`) and the product grid's smooth scroll (`ProductGridClient.tsx`).
- **S2** Skip link and `id="main-content"` on `<main>` (`AppShell.tsx`), English and French.
- **S3** `generateViewport` in `app/layout.tsx` emits `theme-color` from the default theme's
  `--background` (`themeColorFor` in `lib/themes/buildThemeCss.ts`, tested).
  `components/ThemeColorSync.tsx` follows the visitor's own theme choice. The hand-written
  viewport tag is gone: **the live site was shipping the viewport tag twice.**
- **S4** `touch-action: manipulation` on interactive elements (`base.css`).
- **S5** Native `<select>` popup colours via `select option, select optgroup` (`base.css`).
  The closed control keeps whatever background its component sets.
- **S6** `text-wrap: balance` on `h1`–`h6` (`typography.css`).
- **S7** `focus-visible:` on the select trigger and the dialog and sheet close buttons.
- **S8** `transition-all` replaced everywhere on the public surface and in the design
  system. One staff-only use remains in `NextblockVisualEditing.tsx`.
- **S9** `overscroll-contain` on dialog content, sheet content, the mobile drawer and the
  search results list.
- **S10** `(--var)` shorthand in `select.tsx` (max-height and transform origin) and
  `SearchableSelect.tsx`, plus two more sites the grep found:
  `libs/ecommerce/.../ProductCategorySelector.tsx` and `app/cms/blocks/components/MultiEntityPicker.tsx`.
- **S11 (code half)** `…` in every component fallback. Seeded values: see "Still open".
- **S12 (most)** `role="alert"` / `role="status"` on form messages, thread view, form block,
  posts grid, comments, reviews and the password page. Search got a polite live region.
- **S13** `outline-none` → `outline-hidden` across the design system (19 uses, 13 files) and
  a transparent outline on the colour picker, so forced-colors mode shows focus again.

### Components
- **Mobile navigation** No focus steal on page load; Escape closes; the closed drawer is
  `invisible` + `inert`; the page behind it no longer scrolls; `dvh` height; visible
  focus rings; the desktop submenu opens on keyboard focus; decorative SVGs are hidden;
  the toggle's label switches to "Close main menu".
- **Section slider** No autoplay under reduced motion; a pause/play button; pause on keyboard
  focus; inactive slides are `inert`; arrows show on focus and on touch screens; carousel
  semantics; 24 px dot targets with `aria-current`; English and French labels;
  `backdrop-blur` removed (project rule for hero content).
- **Form block** `…`, announced success and errors, `autoComplete="email"` on email fields.
- **Search** `type="search"`, `name`, `aria-label`, a `focus-within` ring, French diacritics
  in the fallback copy.
- **Comments and reviews** The two raw translation keys are gone; body text is readable in
  dark mode (`dark:text-slate-350` was not a Tailwind shade) and wraps long words.
- **Auth pages** `id`, `type="email"`, `autoComplete`, `spellCheck={false}`, link hover
  states; the 2FA input has a `name`.
- **Profile** A level-one heading on the password and orders pages; a pending state on the
  password form; a long email no longer overflows the sidebar card.
- **Header** The avatar menu button has an accessible name; "profile" no longer renders as
  a raw key.
- **Other** Consent banner "Manage options" is visible in dark mode; testimonial block no
  longer overflows and uses curly quotes; `translate="no"` on demo credentials and the brand
  name; article date rendered in a fixed zone; `.prose` wraps long strings and its plain
  links get an underline, hover and focus style.

### Verified bugs (section 3)
- `progress.tsx` forwards `value`, so bars expose `aria-valuenow` again.
- `CtaWidgetRenderer.tsx` renders nothing when `data-url` is missing instead of throwing
  inside `next/link`; an unknown style falls back to primary.
- `ButtonBlockRenderer.tsx` no longer opens `mailto:` and `tel:` links in a blank tab.
- `thread/page.tsx` drops `fetchCache = 'force-no-store'` (project rule).

## 6. Second pass: what was closed from the open list

Verified with the typechecks of the app, `libs/ui`, `libs/ecommerce` and `libs/utils`; lint on
the same four projects (zero errors, including the older ones); the full test suites (all
green); a production build plus `verify-lib-dist.js` for all seven libraries; the new
migration run twice against a seeded throwaway Postgres; and a headless-Chrome run of the
interactive behaviour (results at the end of this section).

### Migration `02015_public_copy_typography_and_a11y_keys.sql`
- The twelve seeded values ending in three dots now end in `…`, in every language.
- **43 French strings were seeded without their accents** ("Selectionnez", "Parametres de
  facture", "Retour a l'accueil", most checkout errors). Corrected, each guarded by the exact
  seeded text so edited copy is left alone.
- 122 new keys in English and French: everything the first pass used through code fallbacks,
  plus the keys the shop audit found unseeded (the whole coupon form, the license panel,
  cart and stepper labels, pagination, the two-factor page, the unauthorized page).
- Applied to the linked project; `migrations-bundle.ts` and `sandboxResetSql.ts` regenerated.

### Navigation, slider, forms, search, reviews
- **Navigation:** desktop parent links expose `aria-haspopup` / `aria-expanded`, Escape
  dismisses an open flyout, the mobile submenu toggle is labelled in both languages, header
  and footer `<nav>` landmarks are named, the language switcher is labelled.
- **Slider:** arrow keys from its own controls; the stock-photo credit now renders on slide
  backgrounds (it was missing, against the Unsplash terms) and is translated.
- **Form block:** radio groups are a `fieldset` + `legend`; labels wrap their radio or
  checkbox (no dead zone); typed values survive a server error; a blocked reCAPTCHA script
  says so instead of swallowing the submit; Turnstile follows the site theme; every message
  is translated; focus moves to the confirmation.
- **Honeypot renamed.** `verification_secondary_email` matched browser email autofill, so a
  real visitor's sign-up or message could be discarded with a fake success. The name now
  lives in `lib/botProtection/fields.ts`; the old one is still honoured for cached pages.
- **Search:** results are real links inside a `listbox` driven from a `combobox` input,
  the active row scrolls into view, filter chips expose `aria-pressed`, a blocked
  `localStorage` no longer cancels the navigation, the trigger stays on screen while the
  dialog chunk loads, and focus returns to it on close.
- **Reviews and comments:** the stars are a radio group with arrow keys and a focus ring,
  displayed ratings have a text alternative, reviewer names are `h3`, like buttons expose
  `aria-pressed`, textareas have a `name`, loading is announced.
- **Two-factor page:** translated; the submit button stays enabled and explains an
  incomplete code instead of sitting disabled.
- **Unauthorized page:** translated, theme colours instead of hardcoded greys.

### Rendering and performance
- **Custom blocks (`DynamicLayoutEngine`):** developer warnings render only while visual
  editing is on; relation prices use `Intl.NumberFormat` with the page locale, in the
  currency they are stored in, without dividing zero-decimal currencies; relation images
  get `decoding`, real dimensions when the row has them, and a human alt.
- **Images:** a text block's first image in an above-the-fold block is no longer lazy-loaded
  (and only one image per block is promoted); pass-through images always get an `alt`; the
  external image block sets `fetchPriority`; its two editor-only notes no longer show to
  visitors.
- **Article pages:** removed the manual `<link rel="preload">` of the raw hero image. It
  never matched the optimized URL next/image requests, so the browser downloaded the
  full-size original in competition with the LCP image.
- **Pagination** keeps its page in the URL (`?page=3`) through `hooks/usePageParam.ts`:
  linkable, reloadable, and Back works. Pages stay statically rendered.
- **Manifest:** `app/manifest.ts` serves the site's own name and default-theme colours; the
  static file had an empty name and icon paths that do not exist.
- `backdrop-blur` removed from the section photo credit, the article header and the
  product purchase card (project rule for above-the-fold content).

### Design system
- **Dialogs:** `DialogDescription` / `SheetDescription` are wired again. An unconditional
  `aria-describedby={undefined}` had orphaned every description in the app, including the
  "this will delete…" text of the confirmation dialog. The content is now the scroller, so
  a dialog taller than the viewport scrolls instead of being clipped at the top. All 16
  call sites without their own scrolling were checked for overflowing children: none.
- "Close" is translated when a provider is mounted (`useOptionalTranslations` in utils).
- `SearchableSelect`, `CustomSelectWithInput` and `ColorPicker` controls are labelled and
  show keyboard focus.

### Headless-Chrome run
Chrome was driven over the DevTools protocol from a Node script against the dev server
(no Playwright in the repo). 28 of 28 interface checks passed: the first Tab lands on the
skip link and Enter moves focus to `<main>`; a mobile load leaves focus alone; the closed
drawer is `inert`, opens, locks page scroll, closes on Escape and returns focus; the search
dialog is described by its description, its results are links in a listbox, the count is
announced and focus returns to the trigger; labels are French on a French visit; reduced
motion collapses animation time; `theme-color` follows the theme class. A second run with a
seeded cart covered the shop: labelled steppers and remove buttons, an announced quantity,
the cart icon count, the drawer (described, links, focus returned, not reopened on reload),
checkout headings and `autocomplete` tokens, French country names and `1 998,00 $` prices.
Products on the linked database cannot be bought (no payment provider), so add-to-cart
and a real payment were not exercised.

## 7. Shop audit (`libs/ecommerce`), requested after the first pass

Two reviewers read every public shop component in full (about 5,700 lines). Beyond the
guideline findings they proved these defects from the code, all fixed:

- **Cart price ignored the sale window.** A line never carried `sale_start_at`,
  `sale_end_at` or the scheduled price, and a missing window means "always on": an expired
  or future sale showed the regular price on the product page and the sale price in the
  cart, the drawer and the subtotal. Variants also sent the parent's window.
- **Unreachable variants.** With a sparse matrix (only Red/S and Blue/M) the picker disabled
  Blue and M forever and reverted the shopper's own pick. `applyVariantSelection` (tested).
- **Untracked stock read as "Out of stock"** (`stock ?? 0`), and the quantity did not clamp
  when switching to a variant with less stock.
- **Gallery crash** when a variant change shortened the image list.
- **Cart drawer reopened on every page load** (`isOpen` was persisted) and dropped focus on
  `<body>` when it closed.
- **Saved currency choice was overwritten** by the cookie guess on hydration.
- **French product pages listed English products** (`languageId = 1` fallback).
- **Checkout:** choosing a shipping rate re-ran the rates effect (spinner flash, double
  fetch); a rejected estimate left the spinner and the disabled pay button forever; stale
  tax responses could overwrite newer ones; unguarded `localStorage` writes could unmount
  the page; Back from Stripe restored a permanently spinning checkout; `alert()` for
  validation; the shipping picker was `<div onClick>` (no keyboard access).
- **Not a bug, checked:** the reviewers flagged the hardcoded `/shop` links because the French
  shop is `/boutique`. The page already redirects a French visitor from `/shop` to its
  translation when one exists, and `/boutique` is a 404 on any install without that page
  (it is on the database used for the live check), so `/shop` stays.
- **Checkout block** rendered the guest flow for signed-in customers.
- **Success page** showed "Payment received" with a green check for a missing session, a
  pending or cancelled payment and any failure, and a rejected sync had no error and no retry.
- **Coupon form:** caret jumped on every mid-string edit; Enter skipped the in-flight guard;
  a failed validation left the coupon applied server-side while the UI showed no discount.
- **Shipping estimator** stayed disabled forever after a rejected request.
- **Contact seller** lost the visitor's message on any server-side failure.
- **Prices were always formatted `en-US`** (`$1,234.50` on French pages). All shop
  components now use `usePriceFormatter()`.
- Dates in the orders list, invoice and license panel are formatted in a fixed zone
  (hydration mismatch).

Guideline fixes across the same files: labelled icon buttons and quantity steppers with
announced values, a labelled cart icon that includes the count, real links instead of
`router.push` buttons, `autocomplete` tokens and input types on every checkout, profile and
estimator field, section headings, announced errors, image dimensions and lazy loading,
translated trial and cart error copy, localized country names.

## 8. Third pass (after the 0.19.2 release)

- **Declaration files.** The cortex build logged `TS4058 ... 'NavigationNode' ... cannot be
  named` on every build. It was not a cosmetic warning: no `ai-global-agent-tools.d.ts` was
  written at all, and `index.d.ts` still re-exported it. The same family of defect was in
  `ecom` and `editor`: types imported from a sibling library were emitted as
  `../../../db/src/index.ts`, a path that exists only in this monorepo (58 imports in
  `ecom`). Scaffolds compile with `skipLibCheck`, so nothing failed; the types were `any`.
  Fixed (exported type, `aliasesExclude` in every lib config, a types-only `./types` export
  on `db`) and `verify-lib-dist.js` gained a fourth check that would have caught both.
- **Form block** gained `tel`, `url` and `number` field types (schema, CMS editor, renderer,
  Cortex schema and its field-type normalizer).
- **Slider** swipes on touch screens (`touch-pan-y`, horizontal gestures only).
- **Cart and checkout** render a skeleton with `role="status"` while the cart store
  hydrates, instead of nothing followed by a jump.
- **French province and state names** on the checkout and the shipping estimator, and
  localized country names in the estimator.
- **Stock photos:** the Cortex tool now tells agents to copy `width` and `height` into the
  image content, so new AI-built pages reserve the space.
- **CMS:** the media library search is debounced and labelled; the uploader finally shows
  its "original uploaded, but variants failed" warning (it was set and never rendered).

## 9. Fourth pass: the four decision items

- **Pagination without JavaScript.** Previous / Next are now links to `?page=N`
  (`components/blocks/GridPagination.tsx`), so page 2 can be opened in a new tab, bookmarked,
  crawled and reached with scripts off. The page routes read the parameter into a
  request-scoped store (`lib/blocks/requested-page.ts`) and the posts and product grid server
  components render that page. The earlier objection (reading `searchParams` makes a page
  dynamic) turned out to be moot: both routes already render per request for the locale
  cookie. With JavaScript the link is cancelled and the grid swaps in place as before.
- **Button hover contrast (S14).** Measured on the seeded themes, `hover:bg-primary/90` took
  the dark theme's primary button from 4.93:1 to 4.12:1 (below AA). Hover and pressed states
  now mix the surface toward the button's own text colour with its lightness inverted
  (`color-mix` + relative `oklch`), so the surface always moves away from the text: measured
  in Chrome, dark 4.9 → 5.4 and vibrant 4.9 → 6.5; light computes to 6.4 → 7.6. A first attempt
  that mixed toward the page `--foreground` was rejected by the same measurement: it lifted the
  vibrant theme's magenta toward its light cyan text and dropped that button to 4.0. The rule
  covers `destructive` and `secondary` too.
- **Seeded palette (S15 and rest-state failures).** Four seeded tokens failed AA before any
  hover: the dark focus ring (2.7:1 on a card), the vibrant primary (3.5:1 under white text),
  the vibrant destructive (4.0:1) and the light destructive (3.6:1). `02016` deepens them
  (7.1, 4.9, 5.4 and 4.6), guarded by the seeded values so an operator's recoloured theme is
  untouched. nextblock.dev serves these exact seeded tokens, so the fix applies there once the
  migration runs. `libs/ui/src/styles/theme.css` mirrors the values.
- **Logo alt text.** Every header typed a `media.alt_text` column that does not exist, so the
  code always fell through to the site title. That fallback is the right alt for a logo that
  is the home link, so it is now explicit and the phantom column is gone (site header, CMS
  shell, CMS logo settings).
- **Product `short_description`.** One renderer (`ShortDescription`) for the product page and
  the featured-product block: HTML when the text contains markup (older rows carry embeds,
  which are still rewritten to the no-cookie host), otherwise escaped text with line breaks.
  The field is plain text in every authoring surface, so this is what the seed and the visual
  editor already produce.

## 10. Still open

- **Images with no stored size.** An external image block or a custom-block string value
  that carries no `width`/`height` still shifts layout: there is nothing to reserve. New
  stock photos now carry their size (section 8); existing content does not.
- Not applicable, listed for completeness: per-field `aria-invalid` on the form block (the
  server returns form-level errors only).
