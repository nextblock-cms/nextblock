# NextBlock Cortex AI Architecture

This document is a handoff and maintenance guide for the current NextBlock Cortex AI implementation. It is intended for future developers and for AI coding agents that need high-fidelity context in a new thread.

Do not copy real API keys, Freemius license keys, encryption secrets, Supabase service keys, or other secret values into this document or into prompts. Only environment variable names are documented here.

## Executive Summary

NextBlock Cortex AI is the premium AI package for NextBlock. Its internal package id is:

```txt
cortex-ai
```

The package currently implements three major capabilities:

1. Premium package activation and BYOK key management.
2. OpenRouter-backed model routing with free-model fallback behavior.
3. AI features inside the CMS:
   - Inline Tiptap rich-text assistance that generates clean HTML fragments and lets the editor parse them normally.
   - A page-aware global dashboard agent that can update navigation/footer state, search CMS documentation-like content, and mutate current page/post/product fields or blocks through typed tools.

The implementation now splits editing responsibilities:

- The inline editor path is HTML-first and intentionally lightweight. It is for rich-text fragments inside the active Tiptap document, not full CMS block generation.
- Full page, product, post, section, and block editing goes through the global agent and strict Zod tool arguments.
- Existing editor JSON schemas remain important for stored product `description_json`, schema diagnostics, and global-agent field validation.
- Server-side key handling is isolated in server-only modules.
- Database writes happen through authenticated server actions or service-role Supabase calls, not client-side mutation.

## Current Status

Implemented:

- Package registry entry for `cortex-ai`.
- Freemius product/plan metadata:
  - `fm_product_id`: `28609`
  - `fm_plan_id`: `47122`
- Sandbox reset auto-activates Cortex AI when `FREEMIUS_AI_SANDBOX_KEY` is present.
- Encrypted OpenRouter BYOK storage in `site_settings`.
- RLS hardening so `site_settings.key = 'cortex_ai_openrouter_api_key'` is not publicly readable.
- Cortex AI settings page under `/cms/settings/cortex-ai`.
- OpenRouter client, free-model fallback registry, and stored-BYOK paid model selection.
- Tiptap editor JSON schemas and schema-to-JSON-schema helper.
- `/api/ai/generate-blocks` endpoint for inline HTML fragment generation.
- Editor prompt UI in `NotionEditor`.
- `/api/ai/global-agent` endpoint with page context, tool calling, and SSE streaming.
- Persistent dashboard chat UI with local browser chat threads.
- Tools for:
  - `update_navigation_bar`
  - `update_footer`
  - `search_documentation`
  - `read_current_cms_item`
  - `update_current_cms_fields`
  - `update_content_block`
  - `update_section_column_block`
  - `fetch_ecommerce_stats`
- Multilingual navigation/footer tool arguments using either language codes or language names.
- Guardrails against OpenRouter free-model rate limits, raw tool-call leakage, and stuck loading streams.
- Custom-block "build widget" generation: `/api/ai/cortex/build-widget` and the custom-block agent tools (`libs/cortex/src/lib/ai-global-agent-custom-block-tools.ts`) produce data-driven `custom_block_definitions` from a prompt. See [10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md) for the block model.

Known incomplete or future work:

- Footer link updates currently replace footer links for the selected locale. Footer append mode is not yet implemented.
- Documentation search is keyword/scored search over `posts` and `pages`, not a vector embedding RAG system yet.
- The sandbox should eventually seed a visible product/package item for Cortex AI, similar to ecommerce. The preferred image asset is `apps/nextblock/public/images/cortex-ai-square.webp`.
- Block insertion, creation (`create_cms_page/post/product`), deletion (`delete_cms_item`), multi-step plans (`execute_cms_action_plan`), direct typed DB CRUD, external URL ingestion (`fetch_url_content`), and whole-page rewrites staged into Live Draft Mode (`rewrite_page_draft`) are all implemented (this "future work" note is stale — see the tool inventory in `createCortexGlobalAgentTools` and the "External URL Ingestion and Live-Draft Page Rewrites" section below). Per-block mutations still write directly to live `blocks` via service role (no draft/snapshot); only `rewrite_page_draft` goes through `content_drafts`.

## Important Files

### Package and Environment

| File | Purpose |
| --- | --- |
| `libs/utils/src/lib/nextblock-packages.ts` | Package registry. Contains `cortex-ai` metadata and Freemius product/plan ids. |
| `libs/cortex/src/lib/ai-config.ts` | Server-only Cortex AI constants and environment accessors. |
| `libs/cortex/src/lib/ai-key-crypto.ts` | AES-256-GCM encryption/decryption helpers for stored OpenRouter BYOK keys. |
| `.env.example` | Documents `FREEMIUS_AI_SANDBOX_KEY`, `OPENROUTER_API_KEY`, and `CORTEX_AI_ENCRYPTION_KEY`. |
| `libs/environment.d.ts` | Type declarations for Cortex AI environment variables. |

### Database and Sandbox

| File | Purpose |
| --- | --- |
| `libs/db/src/supabase/migrations/02003_baseline_security_and_grants.sql` (originally `00000000000011_setup_cortex_ai_settings`, folded in by the generation-2 squash) | RLS hardening for the sensitive `site_settings` Cortex AI key row. |
| `apps/nextblock/app/api/cron/reset-sandbox/route.ts` | Sandbox reset route. Upserts active package activation for `cortex-ai` when `FREEMIUS_AI_SANDBOX_KEY` exists. |
| `apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts` | Generated SQL bundle that includes the Cortex AI migration. |

### Routing and OpenRouter

| File | Purpose |
| --- | --- |
| `libs/cortex/src/lib/ai-client.ts` | Creates OpenRouter provider/client with credential resolution and text-generation helper. |
| `libs/cortex/src/lib/ai-model-catalog.ts` | Server-only OpenRouter model catalog fetcher. |
| `libs/cortex/src/lib/ai-model-registry.ts` | Free model registry, routing policy builder, model filtering/parsing helpers, rate-limit detection, fallback runner. |
| `apps/nextblock/scripts/verify-cortex-ai-routing.ts` | Manual verification script for OpenRouter routing. |

### Inline Editor Assistance

| File | Purpose |
| --- | --- |
| `libs/utils/src/lib/editor-blocks.ts` | Main Tiptap JSON Zod schemas, allowed node/mark types, JSON Schema extraction. Still used for product descriptions and agent validation. |
| `schemas/editor-blocks.ts` | Re-export shim for schema imports from app scripts/lib code. |
| `libs/cortex/src/lib/ai-block-generation.ts` | Inline editor HTML-fragment generation using `generateText`, routing fallback, and lightweight output validation. |
| `apps/nextblock/app/api/ai/generate-blocks/route.ts` | Compatibility route for inline editor generation. Returns `{ html, credentialSource, modelId }`. |
| `libs/editor/src/lib/NotionEditor.tsx` | Editor prompt UI and HTML insertion behavior via normal Tiptap parsing. |
| `apps/nextblock/scripts/validate-editor-block-schema.ts` | Validates editor schema against sample content and emits diagnostics. |
| `apps/nextblock/scripts/verify-cortex-ai-generate-blocks.ts` | Manual live generation verification script. |

### Global Agent

| File | Purpose |
| --- | --- |
| `libs/cortex/src/lib/ai-global-agent-tools.ts` | Tool schemas and execution functions. |
| `apps/nextblock/app/api/ai/global-agent/route.ts` | Global agent route and SSE streaming orchestration. |
| `apps/nextblock/app/cms/components/CortexGlobalAgentChat.tsx` | Persistent dashboard chat UI with thread history. |
| `apps/nextblock/app/cms/components/CortexAiPageContext.tsx` | Client page-context provider/registrar used by CMS edit screens and the global chat. |
| `libs/cortex/src/lib/ai-global-agent-tools.test.ts` | Unit tests for tool executors. |
| `apps/nextblock/scripts/verify-cortex-ai-global-tools.ts` | Focused verifier for global tools. |

### CMS Integration

| File | Purpose |
| --- | --- |
| `apps/nextblock/app/cms/layout.tsx` | Server layout checks package activation for ecommerce and Cortex AI. |
| `apps/nextblock/app/cms/CmsClientLayout.tsx` | Adds Cortex AI settings nav item, wraps CMS in the page-context provider, and conditionally renders global chat. |
| `apps/nextblock/app/cms/settings/cortex-ai/page.tsx` | Settings page for activation/key status, BYOK forms, and compatible model selection. |
| `apps/nextblock/app/cms/settings/cortex-ai/CortexAiSettingsClient.tsx` | The single settings UI. One component for production **and** sandbox — see below. |
| `apps/nextblock/app/cms/settings/cortex-ai/actions.ts` | Server actions for reading, saving, and clearing BYOK keys and model selections. |
| `apps/nextblock/app/cms/settings/cortex-ai/setup/` | The first-run wizard (`page.tsx`, `CortexSetupWizard.tsx`, `actions.ts`, `SiteBriefForm.tsx` + `brief-actions.ts` for the Brief step) — see "First-run setup wizard" below. |
| `apps/nextblock/lib/cortex-ai/setup-state.ts` + `setup-status.ts` | Pure `deriveCortexSetupState` (when the wizard is owed) and the server loader the settings page, the wizard, and the CMS layout share. |
| `apps/nextblock/app/cms/settings/cortex-ai/mcp-client-snippets.ts` | The one builder for the Claude Code / Claude Desktop / Cursor / VS Code MCP configs, used by the MCP card and the wizard. |
| `libs/cortex/src/lib/ai-key-verification.ts` | Live checks of an OpenRouter, Pexels, or Unsplash key against its provider before it is stored. |
| `apps/nextblock/app/cms/dashboard/actions.ts` | Dashboard package state; checks `cortex-ai` to hide/show AI premium CTA. |
| `apps/nextblock/components/Header.tsx` and `apps/nextblock/components/ResponsiveNav.tsx` | Hydration-safe public header controls after Radix ID mismatch fixes. |
| `apps/nextblock/app/cms/components/FeedbackModal.tsx` | Hydration-safe feedback dialog trigger. |

### One settings UI, sandbox included

`page.tsx` has **one** render path. There is no sandbox variant component, and adding
one back would re-create a bug this repo hit twice: the page used to fork into
`StoredCortexAiSettingsClient` / `SandboxCortexAiSettingsClient`, which shared a layout
only by copy-paste, so every redesign landed on production and silently skipped the
sandbox — and the MCP card, mounted only on the production branch, never appeared in the
sandbox at all.

`CortexAiSettingsClient` takes `isSandbox` and follows one rule for anything the shared
sandbox cannot do: **disable it, never hide it.** A visitor evaluating NextBlock has to be
able to see that stock-photo keys, agent tuning, and MCP access exist and what they look
like; a hidden control teaches them the feature does not exist. Locked cards carry a
`Read-only` badge and say what changes on a real install.

Two settings stay writable in the sandbox because they have a per-visitor channel: the
OpenRouter key and the model selection, which live in this browser's `localStorage` and
travel to the AI routes as `x-sandbox-openrouter-*` headers. Everything else is
server-backed and refused by the `NEXT_PUBLIC_IS_SANDBOX` guards in `actions.ts` and
`mcp-actions.ts` — the disabled control is the hint, those guards are the boundary.

The MCP card renders in the sandbox with `readOnly`: toggles, minting, and revoking are
disabled, and the token list is passed in empty (those rows belong to the host, and every
sandbox visitor shares one admin login). The endpoint URL, the client picker, and the
copy-paste snippets stay fully live, since that is the part worth showing.

### First-run setup wizard

`/cms/settings/cortex-ai/setup` exists because a freshly activated trial cannot talk to a
model: the dashboard chat needs an OpenRouter key, and an external client needs the MCP
server on with a token. Before the wizard, "Build my site with Cortex AI now" landed in the
chat, which fired the kickoff prompt and showed "Cortex AI requires OPENROUTER_API_KEY…" as a
red banner; the only way out was the full settings page.

The wizard is four screens, one decision each, every one skippable:

1. **Connect** — two option cards. *Chat here in NextBlock* takes an OpenRouter key (link to
   openrouter.ai/keys, note that free models need no credit); the moment the key verifies a
   model picker appears under it (the compatible catalog, "Free models (automatic)" as the
   default, with a hint driven by the key's `is_free_tier` flag) and Continue saves the
   choice through `selectModelForSetupAction`. *Use my own AI app (MCP)* switches the MCP
   server on and mints one read+write token for the operator's machine (localhost trust is
   left as it was) — or, when active tokens already exist (a re-run of the guide, or a token
   minted on the settings page before it), lists them first (`existingMcpTokens`, loaded by
   `loadCortexSetupWizardProps` through `getMcpSettingsStatus`, newest preselected) next to
   "Create a new connection": picking one calls `reuseExistingMcpTokenForSetupAction`, which
   only switches the server on, and the Build step then names the connection and asks for
   the token value saved at creation (a secret is shown once; only its hash is stored).
   "I'll decide later" moves on with neither — and then step 3 offers no
   "Start building" button, only the two cards back to this step, so the chat can never be
   launched without a key.
2. **Photos** (optional) — a Pexels and/or Unsplash key so the builder can fill image slots
   itself; "Skip for now" is a first-class button.
3. **Brief** (optional) — `SiteBriefForm.tsx`, a one-page questionnaire (business, visitors,
   site shape and pages, languages, look and feel, contact details, existing content, notes)
   whose values `siteBriefFormToBrief` (`lib/cortex-ai/site-brief-form.ts`) turns into the
   same `CortexSiteBrief` the chat interview saves; `saveSiteBriefFromFormAction`
   (`brief-actions.ts`) stores it through `executeSaveSiteBrief` in `replace` mode. A saved
   brief (this session or `existingBrief` from the loader) shows as a summary card with
   "Edit brief"; "Skip, let Cortex interview me in chat" leaves the questions to phase 1.
4. **Build** — on the chat path, the screen *is* the "Start building my site" button (a full
   navigation to `/cms/dashboard?cortex=site-builder`, because the model-key and brief bits
   are layout props). On the MCP path it shows the token once (or, for a reused connection,
   its name and prefix with `YOUR_TOKEN` kept in the snippets), the client config for the
   chosen client — the client tabs and the Live site / Localhost toggle mark the active choice
   with the `default` (primary) button variant, because `secondary` is Slate 100 in the CMS
   theme and invisible on the white card — and the exact kickoff prompt to paste
   (`SITE_BUILDER_KICKOFF_PROMPT`, or
   `SITE_BUILDER_KICKOFF_PROMPT_WITH_BRIEF` once a brief is saved, both in
   `lib/cortex-ai/site-builder-prompt.ts`, the same constants the chat sends). With no path
   chosen it offers both again and a "Finish" button.

Every key is verified against its provider before it is stored (`verifyOpenRouterApiKey`
via `/auth/key`, which costs no credits; Pexels and Unsplash via a one-item read), so a typo
is refused on the spot with the provider's reason. A provider that is *unreachable* is
reported separately and gets a "Save anyway" button; a *rejected* key never does.

Routing rules (`deriveCortexSetupState`, `lib/cortex-ai/setup-state.ts`):

- `needsSetup` is true while no OpenRouter key (stored or env) exists, the MCP server is
  off, and `onboarding_state.cortex_setup.completed` is not true. Finishing or skipping the
  wizard writes that record (`completeCortexSetupAction`, read-merge into the same
  `onboarding_state` bag the dashboard checklist uses).
- `/cms/settings/cortex-ai` redirects to the wizard while `needsSetup`; otherwise it shows
  a "Setup guide" button that re-opens the wizard on demand.
- `?intent=site-builder` is what every "Build my site" entry links to
  (`CORTEX_SETUP_SITE_BUILDER_HREF`): the wizard redirects straight to
  `/cms/dashboard?cortex=site-builder` when `readyForSiteBuilder` holds — an env key, or a
  stored key with the wizard completed or skipped — so a self-host with `OPENROUTER_API_KEY`
  never sees it. It deliberately does not key on `hasModelKey`: the key is stored on step 1
  and the route re-renders whenever the client router re-fetches it, so that would throw the
  operator into the chat mid-wizard. For the same reason NO wizard action revalidates
  anything (`connectOpenRouterKeyAction`, `selectModelForSetupAction`, the photo-key action,
  `enableMcpForSetupAction` — which calls the MCP actions with `{ revalidate: false }` so the
  one-time token is not lost to a `/cms/welcome` re-render — `saveSiteBriefFromFormAction`,
  and `completeCortexSetupAction`): any revalidation inside a server action re-renders the
  current route in the action response, and on completion that raced the page's redirect
  against the wizard's own `window.location.assign` (which may be the plain dashboard for
  "Not now"). Every reader of these settings is dynamic, and the wizard always leaves with a
  full navigation, so nothing needs revalidating.
- The re-render hazard is wider than revalidation: any server action that writes a cookie
  (the Supabase session refresh does, from whichever action happens to run once the access
  token has aged) also makes the router re-fetch the current route. So the pages hosting the
  wizard must map every mid-wizard state to the wizard. `/cms/welcome` decides through
  `resolveCortexWelcomeDestination` (`setup-state.ts`): site builder when
  `readyForSiteBuilder`, dashboard only once `cortex_setup.completed` is true, the wizard
  otherwise; the setup route only redirects on `?intent=site-builder` + ready. The earlier
  rule sent "MCP on, wizard unfinished" — the state right after step 1 on the MCP path — to
  the dashboard, which is how saving the brief could land an operator on the dashboard
  instead of the Build step on a first run.
- The CMS layout computes `hasCortexModelKey` and `hasCortexSiteBrief` for admins in one
  query (`getCortexChatStatus`, `lib/cortex-ai/site-brief-status.ts`) and passes them to
  `CortexGlobalAgentChat` as `hasModelKey` / `hasSiteBrief`; with a brief the chat's
  `startSiteBuilder()` sends `SITE_BUILDER_KICKOFF_PROMPT_WITH_BRIEF`. "Has a brief" means
  `isCortexSiteBriefComplete` (`libs/cortex/src/lib/site-brief.ts`: name AND description),
  the same predicate the chat route uses to skip the interview phase and the wizard uses to
  show "Brief saved", so the kickoff prompt never contradicts the system prompt (a name-only
  brief from an interrupted chat interview prefills the form instead). Without a model key the
  drawer replaces its composer with
  a "Finish setup" panel, `startSiteBuilder()` (the checklist "Start" button, the
  `?cortex=site-builder` deep link, the empty-chat button) navigates to the wizard instead of
  sending, and a stream error that mentions the key gets a "Finish Cortex setup" link. The
  sandbox is exempt: the wizard redirects to the settings page there, and the chat also
  honours the per-browser localStorage key.

Two performance rules the wizard follows: the brief form reports every keystroke to the
wizard so a half-filled questionnaire survives Back, but into a **ref**, never state (a
state update there re-rendered the whole wizard, model catalog and snippets included, on
each keystroke: a long-input-handler INP regression); and the model option list and the
MCP snippets are `useMemo`d. On the MCP path the pasted kickoff prompt carries the brief
itself (`formatCortexSiteBriefForPrompt`, exported through `@nextblock-cms/cortex/client`),
because an external client only sees what the operator pastes; the dashboard chat gets the
brief from the route's system prompt instead.

### Post-install welcome flow

`/cms/welcome` (`app/cms/welcome/page.tsx`) is where /setup's sign-in redirect lands, so
the first thing a new administrator sees is a continuation of the setup stepper, not the
dashboard with its sample content. /setup itself runs before any session exists, and
buying or activating a package is an admin-only server action, so the trial offer cannot
be a step inside that wizard; this is the next page.

- **Step 1, Cortex AI** — `CortexOfferStep.tsx`: the trial offer as a full page (what
  Cortex does in three items, the price after the trial stated up front, Freemius note).
  "Start my free 30-day trial" and "Not now, take me to my CMS" are equal-weight buttons;
  buy-now, monthly, "already have a key" and the nextblock.dev link are tertiary. Every
  checkout outcome (overlay cancelled, activation failed, key by email) stays on the page.
  On activation, "Continue to Cortex setup" does a full reload of `/cms/welcome`.
- **Steps 2–5** — the page renders `CortexSetupWizard` with `precedingSteps={['Cortex AI']}`
  and `intent="site-builder"` once the package is active and the wizard is still owed, so
  the chips read Cortex AI ✓ → Connect → Photos → Brief → Build. Its skip link goes to the
  dashboard.
- **Redirects, so nobody is trapped** (`resolveCortexWelcomeDestination`): sandbox and
  non-admins → dashboard; package active and `readyForSiteBuilder` (env key, or stored key
  with the wizard finished) → `/cms/dashboard?cortex=site-builder`; wizard finished or
  skipped without a model key → dashboard; everything else (nothing configured, or a stored
  key or an enabled MCP server with the wizard unfinished) → the wizard, with the key or the
  connection already marked done. Nothing in the proxy or layout forces the route; it
  is reached only from the post-setup redirect, the dashboard checklist's "Start free
  trial" link (`lib/onboarding/status.ts`, `href: '/cms/welcome'`), and the legacy
  `/cms/dashboard?cortex=site-builder` deep link when Cortex is inactive (the dashboard
  `router.replace`s to it instead of opening a dialog).
- `SetupStepIndicator` (`app/cms/components/`) is the shared chip strip, and
  `loadCortexSetupWizardProps` (`settings/cortex-ai/setup/`) the shared server loader, so
  the standalone `/setup` route and the welcome flow render the identical wizard.

## Package Activation

The package id is `cortex-ai`. Do not use the old id `ai`.

The package registry entry lives in `libs/utils/src/lib/nextblock-packages.ts`:

```ts
'cortex-ai': {
  id: 'cortex-ai',
  name: 'NextBlock Cortex AI',
  tagline: '…',
  description: 'Native JSONB block generation and OpenRouter integration.',
  fm_product_id: '28609',
  fm_plan_id: '47122',
  purchase_url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
  pricing: { currency: 'USD', annual: 250 },
  trial: { days: 30, requiresPaymentMethod: false },
}
```

`pricing` and `trial` are what every dashboard surface quotes (`describePackageOffer`
renders them as one consistent sentence: "Free 30-day trial, no credit card required,
then $250/year."). They must match the Freemius plan, which is what the checkout
actually enforces. Both packages carry the same 30-day no-card trial; a package with
`trial: null` is quoted as a paid license and gets no trial button.

Activation checks use:

```ts
verifyPackageOnline('cortex-ai')
```

The read is `unstable_cache`d for 60 s under the `package-activation` tag
(`PACKAGE_ACTIVATION_CACHE_TAG`); `activatePackage` / `deactivatePackage` call
`updateTag` on it and revalidate the `/cms` layout, so the chat mounts on the next
request after a purchase rather than a minute later.

Current usage:

- CMS layout gates the chat with `verifyPackageOnline('cortex-ai')`.
- Settings page reports package active/inactive.
- Global agent route rejects requests if Cortex AI is inactive.
- Dashboard premium CTA checks `stats.isAiActive`, now derived from active package id `cortex-ai`.

### Buying from the dashboard (trial and purchase, auto-activation)

`/cms/settings/packages` opens `PackageCheckoutDialog`
(`apps/nextblock/app/cms/settings/packages/PackageCheckoutDialog.tsx`); the post-install
welcome flow renders the same stages as a page (`app/cms/welcome/CortexOfferStep.tsx`).
Both are chrome around one hook, `usePackageCheckout`, which owns the state machine.
The dialog states the offer (free 30-day trial, no credit card, then $250/year, plus the
nextblock.dev product link) and opens the Freemius overlay with `@freemius/checkout`
(`product_id` + `plan_id`, `trial: 'free'` for the trial button, `billing_cycle` for
purchases; the CSP already allows `https://checkout.freemius.com` in `frame-src`).

The overlay's `purchaseCompleted` / `success` callbacks return only ids
(`purchase.license_id` or `trial.license_id`, `user.id`, `user.email`,
`user.resend_email_endpoint`), never the key. Auto-activation therefore goes through
the vendor:

1. `activatePurchasedPackage` (server action) posts those ids to
   `${NEXTBLOCK_LICENSE_SERVICE_URL ?? 'https://nextblock.dev'}/api/packages/claim-license`.
2. That route exists in this codebase (`app/api/packages/claim-license/route.ts`) but
   answers 404 unless `NEXTBLOCK_LICENSE_CLAIM_ENABLED=true`, which only the vendor
   deployment sets. With the vendor Freemius credentials it loads the license and its
   user, and `evaluateFreemiusLicenseClaim` (`libs/ecommerce/src/lib/freemius-license-claim.ts`)
   accepts the claim only when the license was created within the last 20 minutes
   (checked first, so nothing about older licenses is revealed), belongs to the
   product and to the claimed user id, whose email matches, is not cancelled, and has
   **no activation yet** (the buyer activates right after the claim, so a second claim
   for the same license is refused). Every refusal is the same 403 with the same
   message; the reason is only logged on the vendor. Rate-limited per address and
   per license, best-effort (per process).
3. The buyer's CMS activates the returned key with `activatePackage` (same Freemius
   `licenses/activate.json` call as a pasted key), recording `meta.nextblock`
   `{ source: 'checkout', is_trial, trial_ends_at, plan_id, expiration }`, which the
   packages page shows as "Trial active · ends <date>".

If the claim cannot be honoured (vendor unreachable, claim refused, sandbox) the dialog
shows the paste-your-key field and a "Resend the license email" button
(`resendPurchasedLicenseEmail`, which only ever calls Freemius hosts). After a
Cortex AI activation the dialog offers "Build my site with Cortex AI now", which loads
`/cms/settings/cortex-ai/setup?intent=site-builder` (the first-run wizard, which hands
straight off to `/cms/dashboard?cortex=site-builder` once a model key exists); the welcome
page's "Continue to Cortex setup" reloads `/cms/welcome`, which then renders the wizard.

One row per package: `activatePackage` upserts the new row and then deletes the other
rows for the same package, and `verifyPackageOnline` no longer uses `single()`, so a
trial-to-paid conversion or a re-purchase never leaves the package reading as inactive.

### Trial expiry is enforced on the buyer's CMS

`verifyPackageOnline` used to trust `status = 'active'` forever. Two things now end a
trial (or a cancelled paid license) locally:

- `isPackageActivationRowValid` (`libs/db/src/lib/package-validation.ts`) rejects a row
  whose known expiry (`meta.nextblock.expiration`, `meta.nextblock.trial_ends_at`, or
  the Freemius `expiration` spread into `meta`) is in the past.
- `maybeRevalidatePackageActivations` (`apps/nextblock/lib/packages/revalidate-activations.ts`)
  runs from the CMS layout via `after()`, at most once a day per row, and re-issues the
  same idempotent `licenses/activate.json` call with the stored uid and key. A valid
  license gets its expiration refreshed; one Freemius reports as expired, cancelled,
  revoked or invalid is set to `status = 'expired'` (the packages page then shows
  "Trial ended" / "License expired" with the buy button). Network trouble leaves the
  row alone.

Package purchase and activation are ADMIN actions: the server actions re-check the
caller's role, the onboarding step only shows its "Start free trial" / "Start" control
to admins, and migration `02014_package_activations_staff_read.sql` narrows the table's
SELECT policy to ADMIN and WRITER (it was readable by every authenticated user,
customers included, with the plaintext keys).

## Environment Variables

Environment variables are documented in `.env.example` and typed in `libs/environment.d.ts`.

```txt
FREEMIUS_AI_SANDBOX_KEY=
OPENROUTER_API_KEY=
CORTEX_AI_ENCRYPTION_KEY=
```

### FREEMIUS_AI_SANDBOX_KEY

Used only for sandbox activation.

If present during sandbox reset, `apps/nextblock/app/api/cron/reset-sandbox/route.ts` upserts an active `package_activations` row:

```txt
package_id = cortex-ai
license_key = FREEMIUS_AI_SANDBOX_KEY
status = active
```

The upsert uses `onConflict: 'license_key, package_id'` to avoid duplicate reset failures.

### OPENROUTER_API_KEY

Server-side OpenRouter key used for sandbox-safe free-model routing when no stored BYOK exists.

Credential priority is:

1. Manual API key passed to helper functions, used mainly in tests/scripts.
2. Encrypted key stored in `site_settings`.
3. `OPENROUTER_API_KEY`.
4. No credential, which throws an error.

Stored BYOK intentionally takes precedence over `OPENROUTER_API_KEY`. This lets admins keep a sandbox/free environment key in `.env.local` while enabling paid compatible model selection only after they save a stored BYOK in the CMS.

Important: `openrouter/free` is a free model-router id, not a replacement for authentication. The app still needs an OpenRouter API key from either the environment or stored BYOK.

When the active credential source is `env`, Cortex AI always routes through exactly the configured `CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY` list. Non-free explicit model requests are ignored for env-only routing.

**Sandbox Behavior:** When `NEXT_PUBLIC_IS_SANDBOX=true`, the server environments won't save any OpenRouter key or model selection to the database. The user will be requested to input a key that is stored purely in their browser's `localStorage` (`cortex_ai_sandbox_openrouter_api_key`) with browser-local model selection (`cortex_ai_sandbox_openrouter_model_selection`). The inline editor and global chat pass those values as request headers (`x-sandbox-openrouter-key` and `x-sandbox-openrouter-model`) for the user's own request only.

OpenRouter free models can still hit free-model rate limits. A user with no credits or no credit card can see errors like `free-models-per-day`. Cortex AI catches these where possible and falls back to configured alternate models, but OpenRouter account-level limits may still block all free requests.

### CORTEX_AI_ENCRYPTION_KEY

Required only for saving/decrypting DB-stored BYOK keys.

Implementation detail:

- `libs/cortex/src/lib/ai-key-crypto.ts` hashes this secret with SHA-256 to derive a 32-byte AES key.
- Stored keys use AES-256-GCM with a 12-byte random IV and auth tag.
- Changing this value invalidates previously encrypted stored keys.

Recommended value shape:

- Long random string.
- At least 32 characters.
- Do not commit it.
- Keep the same value for an environment as long as stored keys need to remain decryptable.

## BYOK Storage and RLS

Stored OpenRouter keys are saved in:

```txt
public.site_settings.key = cortex_ai_openrouter_api_key
```

The value is a JSON envelope:

```ts
{
  algorithm: 'aes-256-gcm',
  authTag: string,
  ciphertext: string,
  iv: string,
  last4: string,
  updatedAt: string,
  version: 1
}
```

The migration `libs/db/src/supabase/migrations/02003_baseline_security_and_grants.sql` (originally `00000000000011_setup_cortex_ai_settings`, folded in by the generation-2 squash) hardens RLS:

- Public users can read non-sensitive site settings.
- The sensitive Cortex AI key row is readable only by authenticated admins.
- The sensitive row is writable/deletable only by authenticated admins.
- Existing non-sensitive site settings remain writable by current `ADMIN`/`WRITER` policy.

Stored model selection is saved separately in:

```txt
public.site_settings.key = cortex_ai_openrouter_model_selection
```

The value is not secret and uses this shape:

```ts
{
  modelId: string,
  name: string,
  supportedParameters: string[],
  pricing: Record<string, string>,
  contextLength: number | null,
  updatedAt: string
}
```

The selection is only honored when a stored BYOK exists. Clearing the stored BYOK also clears the selected model. Model selection does not require a database migration because `site_settings` is already the platform key/value store and this row is non-sensitive.

Settings UI behavior:

- Page: `/cms/settings/cortex-ai`.
- Server actions re-check authenticated user role as `ADMIN`.
- Stored BYOK is never displayed in plaintext.
- The UI only shows masked `**** last4` status.
- If only `OPENROUTER_API_KEY` exists, UI states that env routing is locked to the three free models.
- If stored BYOK exists, UI fetches compatible OpenRouter text models that support `tools` and `structured_outputs`, then allows an admin to save one selected model.
- If `NEXT_PUBLIC_IS_SANDBOX=true`, the UI uses a client component to save keys and model selection purely to `localStorage`, and bypasses the database to prevent accidental key leaks across a shared sandbox environment.

## OpenRouter Client Architecture

The OpenRouter client is implemented in `libs/cortex/src/lib/ai-client.ts`.

It uses:

```ts
createOpenAICompatible
```

from `@ai-sdk/openai-compatible` (v3, paired with `ai` v7 — the Vercel AI SDK 7 line, which is
ESM-only and needs Node.js >= 22). Cortex never lets SDK 7 download a URL itself. The SDK
fetches URL file parts through a DNS-pinned `undici` Agent that `@ai-sdk/provider-utils` loads
at runtime with `createRequire(...)("undici")`, with no `fetch` fallback. The output file tracer
cannot see that require, so the package is missing from Vercel functions and standalone
builds, and tracing it from `next.config.js` breaks a scaffold's Turbopack build and never
reaches an existing project through `npm run update`. Alt text is the only place a URL reaches
the model, so `generateCortexAiAltText` downloads the image itself with
`downloadCortexVisionImage` (`libs/cortex/src/lib/vision-image-download.ts`): Node http(s)
with a pinned DNS lookup that refuses private addresses, redirects re-checked per hop, a
20 MiB cap, and the media type from Content-Type or the file signature. It downloads once
instead of once per model in the fallback chain. The client is created with:

```txt
baseURL = https://openrouter.ai/api/v1
name = openrouter
supportsStructuredOutputs = true
includeUsage = true
```

Custom OpenRouter headers:

```txt
HTTP-Referer = NEXT_PUBLIC_URL or https://nextblock.dev
X-Title = NextBlock Cortex AI
```

Credential resolution is:

```txt
manual -> stored BYOK -> OPENROUTER_API_KEY -> none
```

When the resolved source is `stored`, the client also reads `cortex_ai_openrouter_model_selection` and exposes it to the routing policy. When the source is `env`, model selection is ignored and the policy locks requests to the free registry.

All AI client/config modules intentionally throw if imported into browser code:

```ts
if (typeof window !== 'undefined') {
  throw new Error(...)
}
```

This prevents accidental client-side exposure of secrets.

## Model Registry and Fallback

The model registry lives in `libs/cortex/src/lib/ai-model-registry.ts`.

Default free router constant:

```txt
openrouter/free
```

This constant is retained for compatibility, but Cortex AI's preferred generation and agent model chains use explicit free models that advertise both `structured_outputs` and tool-calling support.

Configured all-purpose free fallbacks:

```txt
nvidia/nemotron-3-super-120b-a12b:free
nvidia/nemotron-3-ultra-550b-a55b:free
thinkingmachines/inkling:free
nex-agi/nex-n2.5-pro:free
poolside/laguna-s-2.1:free
thinkingmachines/inkling-small:free
inclusionai/ling-3.0-flash-vl:free
```

(`CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY`, checked against the live OpenRouter catalog on
2026-09-15: every entry advertises `tools` and has no expiration date; entry 0 is the
highest-ranked one that also advertises `structured_outputs`, which
`defaultStructuredOutputModel` needs, so it stays first even though nemotron-3-ultra is
the stronger model.)
When a chain entry fails, `isOpenRouterRecoverableRoutingError` decides whether the global
agent falls through to the next model (429, any 404, "No endpoints found", "no longer
available", "unavailable for free", "paid version is available", "not a valid model ID", …)
and `getOpenRouterErrorStatus` extracts the HTTP status from the transport error or the
OpenRouter JSON body (`error.code`) for the fallback log line.

Registries:

- `structuredJsonPreferred`: retained for compatibility with older structured-generation code paths and schema diagnostics.
- `toolCallingPreferred`: retained as the global-agent free default list.

Both registries intentionally use the same model list. The inline editor no longer depends on model-native structured JSON output, but current paid model selection still requires `tools` and `structured_outputs` because the global agent needs tool calling and existing schema utilities still validate structured editor documents.

Paid model selection:

- `CORTEX_AI_REQUIRED_MODEL_PARAMETERS = ['tools', 'structured_outputs']`.
- `libs/cortex/src/lib/ai-model-catalog.ts` fetches `https://openrouter.ai/api/v1/models?supported_parameters=tools,structured_outputs&output_modalities=text`.
- Catalog filtering keeps only non-expired text-output models that advertise all required parameters.
- `buildCortexAiRoutingPolicy` is the single policy entrypoint for inline editor generation, global agent routing, and shared text generation.
- Env-key routing always returns exactly the free fallback registry.
- Stored-BYOK routing returns `[selectedModel, ...freeFallbacks]` when a selected compatible model exists, otherwise it returns the free fallback registry.
- Manual-key routing can use a requested model id, mainly for tests and scripts.
- Optional request parameters such as `temperature` are stripped for the selected stored model if its saved `supportedParameters` metadata does not include that parameter.

Fallback behavior:

- `runWithCortexAiModelFallback` deduplicates model ids.
- Default retry condition is OpenRouter HTTP 429.
- Inline HTML generation overrides the retry predicate to also retry recoverable empty/invalid fragment, provider, timeout, and 5xx errors.
- 401/402/403 are treated as non-recoverable for inline generation.
- Routing errors are summarized for the UI from first/last real model attempt messages while full per-model attempts stay in server logs.

Rate-limit detection:

- Uses AI SDK `APICallError` where available.
- Also checks common `statusCode`, `status`, `response.status`, and nested `cause` shapes.

## Editor Block Schema Architecture

The main schema file is `libs/utils/src/lib/editor-blocks.ts`.

It exports:

- `editorBlockDocumentSchema`
- `editorGeneratedBlockDocumentSchema`
- `createEditorGeneratedTableDocumentSchema`
- `getEditorBlocksJsonSchema`
- `getEditorBlocksSchemaAwarenessString`
- `validateEditorBlockDocument`
- `safeValidateEditorBlockDocument`

The root schema is:

```ts
{
  type: 'doc',
  content?: EditorBlockNode[]
}
```

Allowed full editor node types:

```txt
doc
text
paragraph
heading
blockquote
codeBlock
bulletList
orderedList
listItem
taskList
taskItem
table
tableRow
tableCell
tableHeader
horizontalRule
hardBreak
image
divBlock
spanComponent
svg
styleTag
scriptTag
alertWidget
ctaWidget
```

Allowed mark types:

```txt
bold
italic
strike
code
link
highlight
textStyle
subscript
superscript
```

There are two related schema surfaces:

1. Full validation schema.
   - Allows the existing editor/database content surface.
   - Includes richer node types such as `image`, `divBlock`, `svg`, `styleTag`, and `scriptTag`.
2. Generated-content schema.
   - Smaller and safer subset from the previous strict generated-output flow.
   - Prevents the model from generating unsafe or overly complex structures.
   - Includes paragraphs, headings, blockquotes, code blocks, lists, task lists, tables, horizontal rules, alert widgets, and CTA widgets.

The inline editor no longer asks the model to emit this JSON directly. These schemas remain useful for:

- Stored product `description_json`.
- Schema verification scripts.
- Global-agent tools that update product descriptions or other stored editor JSON.

The legacy strict JSON generator kept a special strict table schema:

- Exactly one top-level `table`.
- Minimum rows based on prompt.
- Minimum columns based on prompt.
- Every row must contain cells/headers.
- Every cell/header must contain at least one paragraph with text.

This was added for the old strict JSON path because generic structured generation often produced weak or invalid pricing tables. The replacement inline assistant asks for valid HTML table markup and relies on Tiptap's HTML parser.

## Inline HTML Editor Assistance

High-level flow:

```txt
NotionEditor prompt
  -> POST /api/ai/generate-blocks
  -> require ADMIN or WRITER
  -> generateEditorHtmlFragment()
  -> Vercel AI SDK generateText()
  -> lightweight HTML fragment validation
  -> return { html, credentialSource, modelId }
  -> editor setContent(html) or insertContent(html)
```

Route:

```txt
apps/nextblock/app/api/ai/generate-blocks/route.ts
```

Request schema:

```ts
{
  prompt: string;  // 3..4000 chars
  context?: string; // max 2000 chars
}
```

Access:

- Requires authenticated user.
- Requires profile role `ADMIN` or `WRITER`.

Response:

- Returns:

```ts
{
  html: string;
  credentialSource: 'env' | 'stored' | 'manual';
  modelId: string;
}
```

- Adds diagnostic headers:
  - `x-cortex-ai-credential-source`
  - `x-cortex-ai-model`

Generator:

```txt
libs/cortex/src/lib/ai-block-generation.ts
```

Prompt persona:

```txt
NextBlock Cortex AI inline rich-text assistant
```

Important prompt rules:

- Return only an HTML fragment.
- No markdown code fences.
- No explanations.
- Do not include `<!doctype>`, `<html>`, `<head>`, or `<body>`.
- Use semantic headings, paragraphs, lists, tables, blockquotes, code blocks, and horizontal rules.
- For tables, use valid `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, and `<td>`.
- Use `<style>` or `<script>` only when explicitly requested. The editor already has `StyleTagNode`, `ScriptTagNode`, and source-mode parsing for those tags.

Vercel AI SDK usage:

```ts
generateText({
  prompt,
  instructions, // AI SDK 7 name for the former `system` option
  maxRetries: 0,
})
```

Editor insertion:

```txt
libs/editor/src/lib/NotionEditor.tsx
```

Behavior:

- If the editor is empty, Cortex AI uses `editor.commands.setContent(payload.html)`.
- If the editor already has content and there is no active text selection, it appends `payload.html` at the end of the document.
- If there is an active text selection, it replaces that selection with `payload.html`.
- Existing content is preserved for non-empty editors.
- The client sends insertion context (`append-to-end`, `replace-selection`, or empty document), selected text when present, and a trailing slice of existing editor text so the model can continue without duplicating content.
- The server rejects empty fragments, markdown fences, full HTML documents, obvious conversational wrappers, plain text with no HTML tags, uneven table rows, and tables with empty cells.
- The server also strips empty top-level paragraphs/headings and normalizes generated tables to remove blank spacer rows/columns before insertion.

The old strict `generateObject()` Tiptap JSON path is replaced for inline prompts. The route name remains `/api/ai/generate-blocks` for compatibility, but the successful payload is now HTML-first.

## Global Agent Architecture

The global dashboard agent has two main pieces:

1. Tool registry and execution functions.
2. Streaming route and chat UI.

### Tool Registry

File:

```txt
libs/cortex/src/lib/ai-global-agent-tools.ts
```

Exported tool schemas:

- `updateNavigationBarInputSchema`
- `updateFooterInputSchema`
- `searchDocumentationInputSchema`
- `cortexAiPageContextSchema`
- `readCurrentCmsItemInputSchema`
- `updateCurrentCmsFieldsInputSchema`
- `updateContentBlockInputSchema`
- `updateSectionColumnBlockInputSchema`
- `fetchEcommerceStatsInputSchema`

Exported executors:

- `executeUpdateNavigationBar`
- `executeUpdateFooter`
- `executeSearchDocumentation`
- `executeReadCurrentCmsItem`
- `executeUpdateCurrentCmsFields`
- `executeUpdateContentBlock`
- `executeUpdateSectionColumnBlock`
- `executeFetchEcommerceStats`

Tool factory:

```ts
createCortexGlobalAgentTools(context)
```

Tools are passed to Vercel AI SDK `streamText`. The factory is annotated `: ToolSet`: under
`ai` v7 its inferred literal return type exceeds what TypeScript will serialize (TS7056), which
left the published package with no `ai-global-agent-tools.d.ts`.

The new CMS editing tools require a current `pageContext` supplied by the chat request. They are admin-only for this rollout because the global-agent route requires `ADMIN`.

### update_navigation_bar

Purpose:

- Update public header navigation for a locale.

Input:

```ts
{
  items: Array<{
    label: string;
    url: string;
    target?: '_self' | '_blank';
    children?: Array<{ label: string; url: string; target?: '_self' | '_blank' }>;
  }>;
  languageCode?: string; // locale code or language name
  mode?: 'append' | 'replace' | 'update';
  match?: { label?: string; url?: string };
}
```

URL validation allows:

```txt
/
#
http://
https://
mailto:
tel:
```

Database table:

```txt
navigation_items
```

Important behavior:

- `append` preserves existing links.
- `replace` deletes all existing items for `menu_key = HEADER` and the selected language.
- `update` changes one existing item found by `match.label`, `match.url`, or the replacement URL.
- Append is idempotent by normalized URL.
- If the same URL already exists for that menu/language, it increments `skippedCount` instead of inserting a duplicate.
- Children are inserted with `parent_id`.
- Root `order` is based on existing top-level max order.

Language behavior:

- `languageCode` can be a code (`fr`) or a name (`French`).
- Active languages are loaded from `languages`.
- Matching normalizes accents/case.
- Supported aliases currently include common names such as `english`, `french`, `francais`, `spanish`, etc.

This fixed the case where a prompt like `can you also add it in French?` could stall or fail if a model supplied `French` instead of `fr`.

### update_footer

Purpose:

- Update public footer links and/or footer copyright.

Input:

```ts
{
  languageCode?: string;
  links?: NavigationItemInput[];
  copyright?: Record<string, string>;
}
```

Behavior:

- `links` currently replace `menu_key = FOOTER` for the selected language.
- `copyright` upserts `site_settings.key = footer_copyright`.
- The same language-name resolver is used for footer links.

Important limitation:

- No append mode for footer links yet. If a user asks to add one footer link, current behavior may replace the footer link set if the model calls `update_footer` with only that link.

### search_documentation

Purpose:

- Provide project/documentation context to the agent.

Input:

```ts
{
  query: string;
  limit?: number; // 1..8, default 4
}
```

Behavior:

- Searches published `posts` and `pages`.
- Uses simple lowercase term matching/scoring, not vector embeddings.
- Returns snippets with:
  - `title`
  - `url`
  - `source`
  - `excerpt`

Future RAG work should replace or augment this with an embeddings table and vector similarity search.

### read_current_cms_item

Purpose:

- Read the page, post, or product currently being edited.
- Return page/post/product metadata and, for pages/posts, ordered block summaries or full block content.

Input:

```ts
{
  includeBlocks?: boolean; // default true
  includeBlockContent?: boolean; // default false
}
```

Behavior:

- Requires `pageContext` from the chat request.
- Fetches from `pages`, `posts`, or `products` by current entity id.
- For pages/posts, fetches `blocks` by `page_id` or `post_id` and sorts by `order`.
- Omits block `content` unless `includeBlockContent` is true, keeping normal reads compact.

### update_current_cms_fields

Purpose:

- Update metadata fields on the current page, post, or product.

Supported fields:

- Pages: `title`, `slug`, `status`, `meta_title`, `meta_description`.
- Posts: `title`, `slug`, `status`, `label`, `subtitle`, `excerpt`, `published_at`, `feature_image_id`, `meta_title`, `meta_description`.
- Products: `title`, `slug`, `status`, `short_description`, `description_json`, `meta_title`, `meta_description`.

Behavior:

- Requires `pageContext`.
- Validates page/post status as `draft`, `published`, or `archived`.
- Validates product status as `draft`, `active`, or `archived`.
- Validates product `description_json` against `editorBlockDocumentSchema`.
- Revalidates the CMS edit path and public page/post/product path.

### update_content_block

Purpose:

- Update an existing top-level block on the current page or post.

Input:

```ts
{
  blockId: number;
  blockType?: BlockType; // assertion only
  content: Record<string, unknown>;
}
```

Behavior:

- Requires current page/post `pageContext`.
- Refuses to update blocks outside the current page/post.
- Treats `blockType` as an assertion, not a type-changing request.
- Validates `content` with `validateBlockContent(existingBlockType, content)`.
- Updates only `blocks.content` and `updated_at`.

### update_section_column_block

Purpose:

- Update an existing nested block inside a current page/post `section` block.

Input:

```ts
{
  parentBlockId: number;
  columnIndex: number;
  blockIndex: number;
  blockType?: BlockType; // assertion only
  content: Record<string, unknown>;
}
```

Behavior:

- Requires current page/post `pageContext`.
- Refuses to update parent blocks outside the current page/post.
- Parent must be a `section` block (the only nested-column parent type; legacy
  `hero` blocks are now sections with an `is_hero` flag).
- Validates nested content against the nested block type.
- Validates final parent section content before saving.

### fetch_ecommerce_stats

Purpose:

- Fetch quantitative ecommerce statistics and reports from the database.
- Answer questions about revenue, order counts, and top-selling products over a time range.

Input:

```ts
{
  currency?: string; // ISO code, default "USD"
  query: string; // The analytical question
  reportType?: 'revenue' | 'orders' | 'products' | 'general';
  timeRange?: 'last_7_days' | 'last_30_days' | 'last_month' | 'last_90_days' | 'all_time';
}
```

Behavior:

- Read-only: does not require confirmation.
- Queries `order_items` joined with `orders` and `products`.
- Filters by `orders.status = 'paid'`.
- Supports aggregation by product and currency.
- Provides a summary of total orders, total revenue, and a list of top products.
- Restricted to authenticated admins in the `global-agent` route.

### Revalidation

Tool mutations call:

```txt
revalidatePath('/', 'layout')
revalidatePath('/cms/navigation')
```

Navigation/footer mutations keep public layout/nav and CMS navigation screens in sync. Current CMS item/block mutations revalidate the active edit screen and the public page, article, or product URL when a slug is available.

## Global Agent Route

File:

```txt
apps/nextblock/app/api/ai/global-agent/route.ts
```

Access:

- Requires authenticated `ADMIN`.
- Requires active `cortex-ai` package.

Request schema:

```ts
{
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  pageContext?: {
    contentType: 'page' | 'post' | 'product';
    entityId: number | string;
    slug?: string | null;
    title?: string | null;
    languageId?: number | null;
    currentEditor?: {
      blockId?: number | string | null;
      blockType?: string | null;
      field?: string | null;
    };
  } | null;
}
```

Old `{ messages }` requests remain valid. If no `pageContext` is supplied, the agent can still use navigation/footer/search tools but should not perform current-item mutations.

Limits:

- Max 40 messages.
- Max 8000 chars per message.
- No `system` role: the system prompt is built server-side and passed as `instructions`, and
  AI SDK 7 rejects system messages inside `messages` (`InvalidPromptError`), so a request that
  carries one fails validation with a 400.

Model orchestration:

- Uses `streamText` and iterates `result.stream` (AI SDK 7's name for `fullStream`).
- Uses `buildCortexAiRoutingPolicy`.
- Uses `isStepCount(8)` (AI SDK 7's name for `stepCountIs`; raised from 6 to allow read -> plan -> build/confirm multi-tool sequences such as rewriting a full page).
- Temperature is `0.1`.
- Max output tokens is `4000` (raised from 2000; this is a per-step cap that also counts reasoning/tool-argument tokens, so a low value could starve the post-tool summary step and produce empty text).
- Per-attempt timeout is **idle-based** (`GLOBAL_AGENT_MODEL_IDLE_TIMEOUT_MS = 60000`): the attempt aborts only after 60s with no stream activity, and the timer resets on every stream part. A slow-but-progressing generation is not killed mid-answer.

Read-only tool summaries:

- After a successful `read_current_cms_item` or `search_documentation`, if the model emits no follow-up text, the route now returns a **deterministic, truthful summary built from the tool output** (`summarizeReadCurrentCmsItemOutput` / `summarizeSearchDocumentationOutput`) instead of the old canned "the model was interrupted before it could finish a summary" line. Read tools have no side effects, so the answer never depends on the model narrating them.
- `looksLikeRawToolCallLeak` only flags **structural** markers (`<toolcall>`/`<tool_call>`/`<function_call>` wrappers, or a JSON object carrying both `"name"`/`"tool"` and `"arguments"`). It no longer discards legitimate prose that merely quotes a tool name or the bare word "arguments".

System prompt:

- Agent identity: `NextBlock Cortex AI`.
- Explicit Planner -> Executor -> Evaluator behavior.
- Use typed tools for mutations.
- Append header links unless replacement is clearly requested.
- Use current page/post/product context for phrases like "this page", "this product", or "this block".
- Do not update content outside the supplied current CMS context.
- Map language names to codes, e.g. French -> fr.
- Follow-up language requests should reuse prior requested item.

### SSE Protocol

The route returns `text/event-stream`.

Events:

```ts
type CortexAgentStreamEvent =
  | { type: 'meta'; credentialSource: string; modelId: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; toolCallId?: string; input?: unknown }
  | { type: 'tool-result'; toolName: string; toolCallId?: string; output?: unknown }
  | { type: 'tool-error'; message: string; toolName?: string; toolCallId?: string }
  | { type: 'error'; message: string }
  | { type: 'finish' };
```

### Defensive Streaming Choices

The global agent route intentionally buffers assistant text instead of streaming every token immediately.

Reason:

- Some OpenRouter free models can emit raw tool-call payload text such as `</TOOLCALL>` or JSON fragments instead of using the SDK tool-call channel.
- Buffering allows the route to detect and suppress raw tool-call leakage before the user sees it.

Raw tool-call leak detection checks for:

- `<toolcall`
- `</toolcall`
- `"arguments"`
- tool names such as `"update_navigation_bar"`, `"update_current_cms_fields"`, and `"update_section_column_block"`

Rate-limit text detection checks for:

- `rate limit exceeded`
- `free-models-per-day`
- `too many requests`

Fallback strategy:

- If no tool has run and the attempt hits 429/raw-tool/rate-limit text, the route can try the next model.
- If a tool has already succeeded, the route does not retry another model because retrying can duplicate side effects.
- If a tool succeeded but final natural-language response fails, the route sends a deterministic confirmation such as:
  - `Done. I updated the navigation bar.`
  - `That navigation link already exists, so I left the header unchanged.`
  - `Done. I updated the footer.`
  - `Done. I updated the current CMS fields.`
  - `Done. I updated the current content block.`

This was added after a real issue where:

1. The navigation mutation succeeded.
2. The final model response hit a free-model rate limit.
3. The UI showed an error or raw tool-call text.

The current implementation treats the DB tool result as the source of truth once a mutation succeeds.

## Section Design Intelligence

Section blocks are the layout primitive for multi-section pages (heroes, landing/marketing pages). The strict `section` schema requires every layout field, so cheap models used to either fail validation or emit bland sections. Two mechanisms now make section authoring reliable:

1. **Server-side section normalizer** (`normalizeSectionContent` in `libs/cortex/src/lib/ai-global-agent-tools.ts`). Runs on every create/insert of a `section` block (via `normalizeBlockContentForType`). It:
   - Fills all required layout fields with sensible defaults: `container_type` `container`, `column_gap` `lg`, `padding` `{top:'xl',bottom:'xl'}`, `vertical_alignment` `center` for heroes / `start` otherwise.
   - Keeps the grid in sync: `responsive_columns.desktop` is derived from the number of columns actually provided in `column_blocks` (clamped 1-4), so the grid never has empty trailing tracks or overflowing cells.
   - Completes background intent: a bare `{type:'gradient'}` gets real color stops; a `theme` background without a theme defaults to `muted`; an `image` background without a real `media_id` is downgraded to `none` (the AI cannot invent media).
   - Deep-normalizes and validates each nested column block (also fixes a prior bug where nested blocks were only shallow-validated on CREATE).
   - Tolerates a model that flattens columns into a single list (`[blockA, blockB]`) by treating them as one column.
   - Normalizes carousel slides the same way: with `slider: true`, each `slides[]` entry (`{ background, column_blocks }`) gets the background defaults and the nested-block normalization and validation, and `slider` is switched off when no slide exists. The Cortex-side mirror schema (`sectionBlockFallbackSchema` in `block-content-schemas.ts`) carries `is_hero`, `slider`, `slides`, `autoplay` and `timeframe` like the app's `SectionBlockSchema`.

   Net effect: a model can emit a section with just `column_blocks` plus intent (`is_hero`, an optional `background`) and the server produces a valid, well-styled section.

2. **Design recipe in the global-agent system prompt** (`route.ts`, the `PAGE DESIGN`, `SLIDERS` and `FEATURE IMAGES` bullets). Tells the model to compose pages from `section` blocks, supply one column per desired grid track, make the first section a hero — `is_hero: true`, the editor's "Hero Section (Prioritized image loading)" checkbox: the background image (and a hero slider's first slide) loads with priority and the content is vertically centred — alternate `none`/`theme:'muted'`/`theme:'primary'` backgrounds for rhythm, use discrete heading blocks (not `<h2>` inside text HTML), and prefer gradient/theme backgrounds unless a real `media_id` exists. `SLIDERS` explains the "Enable Slider (Carousel layout)" checkbox: `slider: true` plus a `slides` array renders a carousel of full sections (each slide its own background and block content), `autoplay: true` and `timeframe` in seconds (default 5) rotate it. It also carries the non-obvious part: only the slides are DRAWN, but the grid track count still comes from the top-level `column_blocks`, because the renderer computes one `gridClass` from `responsive_columns.desktop` and reuses it inside every slide. A model that puts its columns only in `slides` would otherwise get `desktop = 1` from the normalizer and see every slide collapse to a single column, so the prompt tells it to send one top-level column per column it wants per slide (empty ones are fine). Verified by execution during review; the collapse predates this change, but the instruction to build sliders is what made it reachable. The same two sentences sit in `createCmsBlockInputSchema`'s `content` description and in the MCP `build-site` / `build-page` prompts, so an external client learns them too. A single `text` block's `html_content` still accepts fully custom HTML/CSS for bespoke sections.

3. **Feature-image rule** (`FEATURE_IMAGE_DESCRIPTION` in `ai-global-agent-tools.ts` for the three `feature_image_id` fields and `set_content_images`, the `FEATURE IMAGES` bullet in `route.ts`, the MCP prompts and the server's initialize `instructions`). `feature_image_id` is not a thumbnail: on a page it renders as a full-width title banner above the blocks (`app/[slug]/PageClientContent.tsx`: dimmed cover image, page title centred in white), on a post the article hero, and it is the Open Graph image. The model is told to give posts one (very wide, landscape), never the home page or a page that opens with its own hero section, and to set the site-wide share preview with `update_site_identity` `social_image` instead (`site_settings.site_social_image`; the Branding screen edits the same setting, see docs/03 "Feature images and the social preview image"). The site builder's phase 3 says so explicitly for the home page, and `get_site_overview` reports whether a social preview image is set. Before this text existed the builder put a feature image on a client's home page, which stacked a title banner above the hero.

## External URL Ingestion and Live-Draft Page Rewrites

Two tools power the "rewrite my home page based on `<url>`" use case. Both live in `libs/cortex/src/lib/ai-global-agent-tools.ts` and are registered in `createCortexGlobalAgentTools`.

### fetch_url_content (read-only)

- Input: `{ url: string (http/https), maxChars?: number (500-20000, default 8000) }`.
- Fetches an external page and returns `{ title, description, headings[], text, finalUrl, truncated }` (scripts/styles/svg stripped, HTML reduced to readable text).
- Safety: rejects non-http(s) URLs and blocks local/loopback/private/link-local hosts and cloud metadata endpoints (`isBlockedFetchHost`), re-checks the host after redirects, enforces a 12s timeout and a ~2MB read cap, and only processes `text/html`/`text/plain` responses.
- No confirmation, no DB access. The agent calls it FIRST when a prompt references an external site, then writes new sections from the returned material.

### rewrite_page_draft (mutating, staged into Live Draft Mode)

- Input: `cmsTarget (contentType/entityId/slug/title)` + `blocks: CreateCmsBlock[] (1-20)` + optional `meta` overrides (title/slug/status/meta_title/meta_description).
- Replaces ALL blocks of a page/post with the supplied set, but writes them into a `content_drafts` row (via `context.supabase` service role) instead of the live `blocks` table. It seeds `meta` from the current published item (so metadata is preserved) and carries `base_version` from the item version.
- Nothing goes live: the user previews the draft (`/api/draft/start?path=/<slug>`), then Publishes from the edit screen. Publishing runs the existing draft-publish path, which applies the blocks live AND calls `createPageRevision`/`createPostRevision` — so the rewrite is previewable and reversible.
- Blocks are normalized through the same `normalizeCreateBlocks` pipeline as `create_cms_page` (section defaults, column-count sync, nested validation).
- Two-step confirmation like other mutating tools; the confirmation payload hash excludes non-deterministic nested `temp_id`s so the confirm phrase is stable.
- Result: `{ mutationExecuted, contentType, entityId, slug, blockCount, editPath, draftPreviewPath, isDraft: true }`. The chat treats it as mutating (`MUTATING_TOOL_NAMES`) and navigates to `editPath`, where the "Unpublished Draft → Publish/Discard" toolbar (`DraftStatusActions`) appears.

Typical flow for "rewrite my home page with 5 sections based on `<url>`": `fetch_url_content(url)` → design a hero + 4 sections following the PAGE DESIGN recipe → `rewrite_page_draft(home, blocks)` → user previews and publishes.

## Stock Photos and External Images

Cortex can insert real photos into pages at zero inference cost, and external image URLs are supported natively across the block system.

### search_stock_photos (read-only)

- In `libs/cortex/src/lib/ai-global-agent-tools.ts`; registered in `createCortexGlobalAgentTools`.
- Input: `{ query: string, count?: 1-15 (default 6), orientation?: 'landscape'|'portrait'|'square' }`.
- Key resolution: `resolveCortexAiStockPhotoProvider(supabase)` prefers an admin-stored, encrypted key in `site_settings` (`cortex_ai_pexels_api_key` / `cortex_ai_unsplash_access_key`, read via the service-role client), then falls back to the `PEXELS_API_KEY` / `UNSPLASH_ACCESS_KEY` env vars. Pexels wins when both exist. Returns a clear "not configured" message if neither is set. Both are free API keys.
- The stored keys are protected by migration `libs/db/src/supabase/migrations/02003_baseline_security_and_grants.sql` (originally `00000000000012_cortex_ai_stock_photo_settings`, folded in by the generation-2 squash), which adds them to the `site_settings` sensitive-keys RLS group (admin-only read/write, never anon-readable), and encrypted with the same envelope as the OpenRouter BYOK key.
- **The model is told up front whether stock photos are available.** The global-agent route resolves the provider and injects it into the system prompt: available → "use search_stock_photos"; not configured → "do NOT call search_stock_photos; use gradient/theme backgrounds." So a missing key never wastes a tool call, and the keys are never mandatory — Cortex builds pages either way.
- Admin UI: `/cms/settings/cortex-ai` has a Stock Photos card (save/clear Pexels + Unsplash keys, step-by-step, and why) via `saveStockPhotoKeysAction` / `clearStockPhotoKeysAction`.
- Rate-limit fallback: `resolveCortexAiStockPhotoProviders` returns ALL configured providers ordered Pexels→Unsplash; `executeSearchStockPhotos` tries them in order, falling through to the next on error/HTTP 429/empty results, and returns `attemptedProviders`.
- Returns `{ photos: [{ url, thumbnailUrl, alt, width, height, photographer, photographerUrl, sourceUrl, downloadLocation, credit, provider }], provider, usageGuidance, attemptedProviders, success }`. The agent drops a photo `url` into an image block's `external_url` or a section background's `image.external_url`, and copies the photo's attribution fields into the image content's `attribution`.

### Provider compliance (Unsplash API Guidelines)

Unsplash has strict usage rules; Pexels' license is permissive (attribution optional, re-hosting allowed, no download trigger). Handled:

- **Hotlink**: external stock URLs render via a plain `<img>` from the provider host (never proxied). `importExternalImageToMedia` **refuses to re-host `*.unsplash.com` images** (Pexels re-host is allowed).
- **Trigger downloads**: `maybeTriggerStockPhotoDownloads(blocks, supabase)` fires each Unsplash `download_location` (with the resolved Unsplash key) when a photo is committed to a page. Wired into the create (`insertContentBlocks`), `rewrite_page_draft`, `insert_content_block`, and `update_content_block` persist paths. Best-effort/fire-and-forget; depends on the agent copying `attribution.downloadLocation` from the search result.
- **Attribution**: `ImageAttributionSchema` on the image block + section background image carries `{ provider, photographer, photographerUrl, sourceUrl, downloadLocation }`. The shared `StockPhotoCredit` component renders "Photo by {photographer} on {Provider}" with the photographer + provider linked and `utm_source`/`utm_medium` params on Unsplash links. The system prompt requires the agent to set `attribution` (and the image caption) from the search result.
- **App name/branding**: dashboard-side (the operator's Unsplash app registration); NextBlock uses no Unsplash branding. The `utm_source` in `StockPhotoCredit.tsx` defaults to `nextblock` — change it to the registered app name if needed.

### External image URLs in blocks

- `ImageBlockSchema` (`external_url`) and the section `BackgroundSchema.image` (`external_url`, with `media_id`/`object_key` now optional) accept a direct https URL. The cortex fallback schemas mirror this.
- Renderers: `ImageBlockRenderer` and `SectionBlockRenderer` render an external URL with a plain `<img>` (so any allowlisted host works without Next `remotePatterns`), and keep the optimized `next/image` path for stored R2 media. `normalizeSectionContent` accepts image backgrounds with an `external_url` (filling `size`/`position`) instead of downgrading them.
- Security: the CSP `img-src` allows `https:` (images only — see `apps/nextblock/proxy.ts`), so trusted ADMIN/WRITER authors can embed any https image. script/style/connect stay strict.

### Persist to media library

- `importExternalImageToMedia` (`apps/nextblock/app/cms/media/import-external-image.ts`, ADMIN/WRITER) downloads an external image (SSRF-guarded, 15MB/15s caps), measures it with `sharp`, generates a blur placeholder, uploads to R2/Supabase Storage via the shared storage provider, and records it with `recordMediaUpload`. Returns `{ media_id, object_key, width, height, url, blur_data_url }`.
- Editor UX: `ImageBlockEditor` and `BackgroundSelector` accept a pasted image URL and show a **Save to media library** action that swaps the external URL for a permanent optimized media reference (or the author can replace it with their own uploaded asset).

## MCP Server (external client access)

Cortex AI is dual-access. Alongside the in-app BYOK path (dashboard chat + inline
editor), the same tool registry is exposed over the **Model Context Protocol** at
`/api/mcp`, so Claude Code, Claude Desktop, Cursor, and VS Code can operate the CMS
from inside the editor.

### Files

| File | Purpose |
| --- | --- |
| `libs/cortex/src/lib/mcp-server.ts` | Transport-agnostic JSON-RPC 2.0 engine. No `next` imports, so it is unit-testable. |
| `libs/cortex/src/lib/mcp-tool-registry.ts` | Zod→JSON Schema conversion, read/write scope table, MCP-contract aliases, tool dispatch, resources, prompts. |
| `libs/cortex/src/lib/mcp-tokens.ts` | Token mint/hash/verify, MCP settings resolver, localhost-trust rules. |
| `libs/cortex/src/lib/mcp-server.test.ts` | 43 tests across tokens, registry, annotations, discovery, and protocol; `ai-global-agent-tools.test.ts` adds three MCP-path block-edit tests (sibling isolation, update idempotency, insert non-idempotency). |
| `apps/nextblock/app/api/mcp/route.ts` | Streamable HTTP shim + hybrid auth + tool-context construction. |
| `apps/nextblock/app/cms/settings/cortex-ai/mcp-actions.ts` | Admin server actions: settings, mint, revoke. |
| `apps/nextblock/app/cms/settings/cortex-ai/McpServerSettingsCard.tsx` | Settings UI + copy-paste client config. |
| `apps/nextblock/app/cms/settings/cortex-ai/require-admin.ts` | Shared admin gate (also used by `actions.ts`). |
| `libs/db/src/supabase/migrations/02003_baseline_security_and_grants.sql` (originally `00000000000017_cortex_ai_mcp_server`, folded in by the generation-2 squash) | `mcp_access_tokens` table + `cortex_ai_mcp_settings` RLS. |

### Protocol decisions

**Hand-rolled, not `@modelcontextprotocol/sdk`.** The needed surface (initialize,
tools/list, tools/call, resources/*, prompts/*, ping) is small and declarative. The v1
SDK pulls in `express`, `cors`, `hono`, and `@hono/node-server` — heavy transitive
weight for a publishable lib whose only peer dependency is `next` — and its default
`StreamableHTTPServerTransport` is built on Node `IncomingMessage`/`ServerResponse`
rather than the Web `Request`/`Response` an App Router handler receives.

**Dual-era.** The spec forked: `2026-07-28` is stateless (no `initialize`, no session
id, protocol metadata in a per-request `_meta` envelope), while everything through
`2025-11-25` is handshake-based. As of 2026-08 every shipping client is legacy-era, so
that path must work; the modern path is detected and served too. Because the server is
stateless either way, supporting both costs nothing.

Deliberate behaviours, each of which breaks a real client if changed:

- **Notifications get `202 Accepted` with an empty body.** Returning a JSON-RPC
  envelope for a message with no `id` desyncs strict clients.
- **GET is content-negotiated.** An MCP client opening the server→client SSE stream
  sends `Accept: text/event-stream` (a spec MUST) and still gets `405`: the server never
  initiates requests or pushes notifications, so there is no stream to open, and the spec
  explicitly allows 405 there. Any other GET or HEAD — a directory's health probe, an
  uptime monitor, a browser — gets a `200` static discovery document
  (`buildCortexMcpDiscoveryDocument`: identity, protocol versions, capabilities, how to
  authenticate, the server-card URL). It reads nothing and checks nothing, so it cannot
  fail, and it carries no tool inventory (that stays on the server card, which is gated
  on the operator switching MCP on). Several crawlers scored the old blanket 405 as down.
- **Never 500 to an unauthenticated caller.** The readiness gate checks
  `isFullyConfigured()` (service role, not just URL + anon key) because every path below
  it — token lookup, the tool context — goes through `getServiceRoleSupabaseClient()`,
  which throws without the secret key; and `authenticateMcpRequest` is wrapped so a
  database outage answers `503` + `Retry-After` rather than a 500 (dropped as broken) or a
  401 (dropped as misconfigured).
- **401 carries a bare `WWW-Authenticate: Bearer`.** Adding a `resource_metadata`
  parameter (or serving `/.well-known/oauth-protected-resource`) advertises RFC 9728
  OAuth discovery, and Claude Code responds by starting an OAuth flow that dead-ends
  against a static-token server.
- **Tool failures are `isError: true` on a *successful* result**, not JSON-RPC errors.
  Only unknown-tool and scope denial use the error channel, because those are the
  faults a model cannot fix by retrying with different arguments.
- **`inputSchema` is always a JSON Schema object** with `$schema` stripped (MCP defines
  the dialect; some clients reject the extra key). Converted with `io: 'input'` so
  `.default()` fields stay optional.
- **Array bodies are rejected.** JSON-RPC batching was removed in `2025-06-18`.
- **`Origin` is validated when present** (DNS-rebinding defence, a spec MUST) and
  answered with 403. Native clients send no Origin, so absence is allowed.

### Authentication

Four accepted paths, in priority order, all gated behind
`verifyPackageOnline('cortex-ai')`; the last three also require the `enabled` setting:

0. **Environment bootstrap token** — `MCP_BEARER_TOKEN` (≥ 32 chars), compared in
   constant time (`matchesCortexAiMcpEnvToken`, `mcp-tokens.ts`). Written by
   `create-nextblock --non-interactive` so a coding agent can operate the site before
   any admin has opened the dashboard. Setting the variable *is* the opt-in, so this
   path ignores the database `enabled` flag; it grants `read` + `write`, and writes are
   attributed to the first ADMIN profile — an instance with no admin yet refuses it
   (401) and `GET /api/setup/status` says to bootstrap first. See "Headless bootstrap".
1. **Bearer token** from `public.mcp_access_tokens` — what every external client uses.
2. **Authenticated ADMIN cookie session** — lets the dashboard reach the endpoint
   without minting a token.
3. **Loopback in development** — only when `allowLocalhostWithoutToken` is on *and*
   `NODE_ENV !== 'production'`. Behind a proxy the `Host` header is attacker-
   controllable, so localhost trust is a development affordance only.

The proxy allowlists `/api/mcp` alongside `/api/setup/*`, so an unprovisioned instance
answers MCP calls with its own JSON (503 + `Retry-After` while the service role is
unconfigured or the auth backend is unreachable, 401 otherwise) instead of a 307 to the
HTML wizard. A plain GET or HEAD is answered with the discovery document on every
instance, configured or not.

Tokens are stored as **SHA-256 hashes**; the plaintext (`nbmcp_` + 256 bits base64url)
is shown once at mint time and is unrecoverable. This differs from the OpenRouter BYOK
key on purpose: that key must be handed back to OpenRouter, so it needs a reversible
envelope, whereas an MCP token only ever needs to be *compared*. `token_prefix` is a
non-secret display fragment. Revocation is a tombstone (`revoked_at`), which keeps the
hash in the unique index so the same value can never be re-minted.

The minted token is returned through a **server action return value**, never a redirect
query string — a `?success=<token>` would land in browser history, the referrer header,
and the server access log.

### Scopes

`CORTEX_MCP_TOOL_KINDS` classifies every registry tool (50 canonical names as of this
writing, plus the six aliases below) as `read` or `write`. A read-only token does not
merely get refused on a write — the mutating tools are absent from its `tools/list`
entirely, aliases included.

The table is **exhaustive by construction**: `assertCortexMcpToolCoverage` compares its
keys against the live factory output, and a unit test fails if they diverge. An
unclassified tool is *withheld*, never defaulted to `read`, so adding a tool to the
agent without classifying it is a loud failure rather than a silent hole.

### Tool annotations

Every `tools/list` entry carries the spec's `annotations` object (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`), typed in `CortexMcpToolAnnotations`
to mirror `ToolAnnotations` in `@modelcontextprotocol/sdk` without depending on it. The
defaults are why this matters: a client that receives no annotations assumes
`destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`, so before this
table an unannotated `get_database_schema` looked, to Claude Code or Cursor, exactly like
a raw DELETE and prompted accordingly.

`readOnlyHint` is derived from `CORTEX_MCP_TOOL_KINDS`, never declared twice. Read tools
are `destructive: false, idempotent: true` by definition and only pick `openWorld`
(`fetch_url_content`, `search_stock_photos`). Write tools get a row in
`CORTEX_MCP_WRITE_TOOL_BEHAVIOURS`, typed as `Record<CortexMcpWriteToolName, …>` so a tool
classified `write` without a row fails to compile, and a unit test keeps the two tables
on exactly the same names. An alias inherits its canonical tool's annotations.

The rules are read off the executor code, not the tool description (the comment above
the table carries them in full):

- `destructiveHint` — can delete rows or discard content wholesale (a delete action or
  operation, a reset, a "replace" mode) with no revision snapshot or Live Draft to
  restore from. Field-level overwrites and revision-recorded page/post/product edits are
  not destructive; `rewrite_page_draft` only stages a draft. Mode-dependent tools take
  their worst mode, because the spec defines the hint as "MAY perform destructive
  updates" — which is why `update_navigation_bar` and `update_global_css` are `true`.
- `idempotentHint` — a retry with identical arguments converges: creates are refused on
  a duplicate slug (`assertUniqueSlug`) or an existing translation before anything is
  written, drafts are delete-then-insert per parent, navigation "append" skips URLs
  already present, settings and languages are upserts, deletes of something already gone
  are no-ops. False where a retry adds a second copy: `insert_content_block`, CSS
  "append", variant "append", raw DB inserts, URL imports (`upload_media`,
  `set_content_images`) that re-download into the media library, and model-generated
  custom block definitions. This is the honest answer to "make every mutation
  idempotent": the tools that already are, say so; the handful that are not tell the
  host not to blind-retry them, rather than growing an idempotency-key table.
- `openWorldHint` — an argument may name an arbitrary external host.

Adding a write tool means a row here as well as in the scope table; the compiler and
`mcp-server.test.ts` both refuse a missing one.

### Confirmation is skipped over MCP

The in-app two-phase confirm matches a phrase in the user's *next chat message*, which
has no analogue in MCP — there is no channel to carry a human phrase back between a
tool call and its result. Every MCP host already gates tool calls behind its own
approval UI, so leaving it on would just make every mutating tool return a preview
forever. The real control is the token scope. `ToolExecutionContext.skipConfirmation`
is therefore `true` for all MCP calls.

### MCP-contract tool names

Six names are exposed as aliases forwarding to existing executors, so external clients
get the documented contract without forking tested code. The canonical names remain
listed too, and each alias description begins with "Alias of `<canonical>`" so a model
does not call both.

| MCP name | Forwards to |
| --- | --- |
| `get_database_schema` | `describe_database_schema` |
| `create_page_layout` | `create_cms_page` (new page from slug + title + validated blocks; `status: "published"` to go live) |
| `generate_jsonb_layout` | `rewrite_page_draft` (stages a Live Draft; nothing goes live unpublished) |
| `query_site_analytics` | `fetch_ecommerce_stats` |
| `update_site_navigation` | `update_navigation_bar` |
| `search_stock_media` | `search_stock_photos` |

Every block that reaches `create_page_layout` / `generate_jsonb_layout` is normalized
and validated against the app's own Zod registry (`validateBlockContent`, injected into
the tool context by the route) before anything is written — see "Validation" below.
Rich-text blocks carry HTML by design (`text.content.html_content`); the schema, not a
blanket HTML ban, is what keeps the payload well-formed.

### Headless bootstrap (agent-driven installs)

`create-nextblock --non-interactive` (docs/06) needs the instance to answer three
questions without a browser. All three live under prefixes the proxy allowlists:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/setup/status` | none | Readiness report: `initialized` (Supabase + schema + first admin), `dbReady`, `mcpReady` (initialized + Cortex active + at least one MCP auth method), `channel`, `license`, `mcp.authMethods`, `handoff` (`agentInitiated`, `setupUrl`, `welcomeUrl`) and `nextSteps`. When `MCP_BEARER_TOKEN` is set the steps are written for an agent relaying them to a human ("Ask the user to open … and create their administrator account"; "… start the free trial at /cms/welcome"; "Keep polling"). 200 once initialized, 503 (with `Retry-After`) before. Reveals booleans and guidance only. Pure assembly in `lib/setup/readiness.ts` (unit-tested), I/O in `readiness-service.ts`. |
| `POST /api/setup/bootstrap` | `MCP_BEARER_TOKEN` bearer | Creates the first administrator through `provisionFirstAdmin` (`lib/setup/provision-admin.ts`, the same core the `/setup` wizard's `completeSetup` now calls) and activates the environment license. 404 when no env token is configured, idempotent on a provisioned instance. |
| `POST /api/packages/provision-trial` | none (vendor only) | On nextblock.dev (`NEXTBLOCK_LICENSE_CLAIM_ENABLED=true`): mints a 30-day Cortex AI key for a name + email. |

**Agent-aware first run.** The same `MCP_BEARER_TOKEN` signal (`readCortexAiMcpEnvToken`)
drives three UI touches so the attended headless flow needs no explanation from the agent:
the `/setup` admin step says a coding agent is waiting, `CortexOfferStep` on `/cms/welcome`
explains that the trial unlocks the agent's MCP access, and once Cortex AI is active
`/cms/welcome` renders `AgentHandoffDone` ("return to your terminal", with the in-dashboard
AI setup offered as optional) instead of the model-key wizard. The trial started there is a
real Freemius trial (overlay → `claim-license` → activation with `is_trial`), so Freemius's
own trial emails and webhooks apply. Self-hosted Docker no longer sets
`NEXT_PUBLIC_IS_SANDBOX` since this change (docker-setup also drops a stale `true` on
re-run); the flag would otherwise redirect `/cms/welcome` to the dashboard and refuse
activation.

**Environment-seeded license.** `NEXTBLOCK_LICENSE_KEY` (+ optional
`NEXTBLOCK_LICENSE_KIND=trial|paid`, `NEXTBLOCK_LICENSE_PACKAGE`) is activated on first
use by `ensureEnvLicenseActivation` (`lib/packages/env-license.ts`), called from the
status route, the MCP route and the bootstrap route. It goes through the same Freemius
`licenses/activate.json` call and the same `package_activations` row as a pasted key
(the core moved to `lib/packages/activate-license.ts`, shared with the `activatePackage`
server action), with provenance `source: 'env'`, so expiry, daily revalidation and the
packages page behave exactly as for a checkout-issued license. Failures are memoized for
10 minutes per process so a polling agent cannot hammer Freemius. It is deliberately not
gated on `NEXT_PUBLIC_IS_SANDBOX` — the Docker sandbox sets that flag, and an operator
who put a key in the environment wants it used; the shared demo sandbox never sets the
variable.

**Vendor trial provisioning.** Freemius cannot create a real *trial* (a trialing
subscription) from a name and an email — its trial endpoint is install-scoped, and an
install only exists after the buyer's site activates something. What the vendor can do
(`libs/ecommerce/src/lib/freemius-trial-provision.ts`) is mint a time-boxed license on
the plan's single-site pricing (`POST .../plans/{plan}/pricing/{pricing}/licenses.json`,
`expires_at` = now + 30 days, `is_block_features: true`) and then assign it to the email
(`PUT /products/{product}/licenses.json`), which creates the Freemius user if needed and
sends the welcome email carrying the key. One trial per email per product: any existing
license for the product, whatever its state, refuses a new one (409 `TRIAL_ALREADY_USED`).
The route rate-limits per address (5/hour) and per email (3/day), best-effort per
process, like `claim-license`. The result is functionally the overlay's no-card trial;
what it is not is a subscription, so it never auto-converts — which a no-card trial
cannot do anyway.

### Resources and prompts

Resources: `cortex://schema/database`, `cortex://schema/blocks`,
`cortex://schema/custom-blocks`. Prompts: `build-site` (the whole-site interview →
plan → build flow, see "Site builder"), `build-page`, `clone-from-url`,
`translate-content`.

### Settings and client configuration

`/cms/settings/cortex-ai` gains an "MCP server access" card: enable/disable, localhost
trust, token mint/revoke, and copy-paste config for all four clients. **The server is
disabled by default** — it is a remote write surface onto live content, so it must be
an explicit opt-in.

Client config differs in ways that silently no-op if copied wrong, which is why the UI
generates each one rather than documenting a single snippet (one builder,
`mcp-client-snippets.ts`, and one renderer, `McpClientConfigPanel.tsx`, shared by the card
and the first-run wizard):

- **Claude Code in VS Code** — the extension has no config file; its "Add MCP server"
  dialog asks for Name / Transport / URL / Headers / Scope, so the panel shows those as
  separate copyable values (`claudeCodeExtension`: name `nextblock`, transport
  `HTTP (remote)`, the endpoint URL, and `Authorization: Bearer <token>` for the headers
  box — empty under localhost trust).

- **Claude Code** — `mcpServers`, and `"type": "http"` is *required* (a `url` with no
  `type` is a hard error that skips the server).
- **Cursor** — `mcpServers`, infers transport from `url`, no `type` needed.
- **VS Code** — top-level `servers`, **not** `mcpServers`, and prompts for the token
  via `inputs` rather than storing it.
- **Claude Desktop** — `claude_desktop_config.json` is stdio-only, so a remote server
  needs either the Connectors UI (which dials out from Anthropic's cloud, so localhost
  and firewalled sites will not connect) or the `mcp-remote` stdio bridge.

### Directory listings (official MCP Registry, Glama, Smithery, Docker, one-URL directories)

NextBlock's MCP server is per site (`https://<their-site>/api/mcp`), which only the official
registry models natively; every other directory takes one fixed URL, so they list the vendor
instance `https://cms.nextblock.dev/api/mcp`. Repo-side assets: `server.json`, `glama.json`
and `lhm.plugin.json` at the root, `.claude-plugin/marketplace.json` +
`.cursor-plugin/marketplace.json` (the repo is its own plugin marketplace), `plugins/nextblock/`
(the plugin, see below) and `tools/directories/` (Smithery config schema, Docker catalog entry).
Two prerequisites gate everything that lists the vendor instance: **MCP must be switched on at
cms.nextblock.dev** (Settings → Cortex AI → MCP server access, or `MCP_BEARER_TOKEN` in its env)
so `/.well-known/mcp/server-card.json` answers 200, and a dedicated MCP access token must exist
there to hand to crawlers that health-check behind the bearer wall (Glama, Docker reviewers).

- **Official MCP Registry** — `server.json` at the repo root is the manifest (validated against
  the live registry with `mcp-publisher validate server.json`; no `packages` entry, it is a
  remote-only server): a `remotes[]` entry with the templated URL `https://{site_host}/api/mcp`
  and an `Authorization: Bearer {mcp_token}` header, both declared as variables the client
  prompts for. The `dev.nextblock/*` namespace is proven with a DNS TXT record at the apex of
  nextblock.dev: generate an Ed25519 key (`openssl genpkey -algorithm Ed25519`), publish the
  raw public key as `v=MCPv1; k=ed25519; p=<44-char base64>` (Host `@`, alongside the SPF
  record, exactly one MCPv1 record; delete the old one first when rotating), and store the
  64-hex private seed as the `MCP_PRIVATE_KEY` GitHub secret used by
  `.github/workflows/publish-mcp-registry.yml` (manual dispatch with a new version every time,
  because registry versions are immutable; `login dns` mints a 5-minute JWT). Verify with
  `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=dev.nextblock`. Downstream:
  Glama and PulseMCP state they ingest the registry (PulseMCP paused new listings in 2026-09
  and will pick it up automatically); the GitHub MCP Registry, which VS Code's Extensions-view
  gallery reads, still onboards new servers by hand (email partnerships@github.com and post in
  github/github-mcp-server discussion #1257; plan for months).
- **Glama** — two listings. The repo listing is added from the "Add Server" modal on
  glama.ai/mcp/servers while signed in with GitHub as a maintainer; because `nextblock-cms` is
  an organisation, the claim (`…/mcp/servers/nextblock-cms/nextblock/admin`) reads the root
  `glama.json` (`maintainers`: GitHub logins; re-run the claim after any change to the file).
  Glama withholds repo listings from search until its Dockerfile build succeeds, which this
  monorepo will not pass, so the discoverable surface is the **connector**: "Add Server" on
  glama.ai/mcp/connectors (name + URL), a test credential under Admin → Test Profile (an
  unhealthy connector is never indexed), then the HTTP-challenge claim: the panel's
  `glama_claim_…` token goes into `GLAMA_CLAIM_TOKEN` on the vendor Vercel project, the site is
  redeployed (`app/.well-known/glama.json/route.ts` is `force-static`, so it reads the env at
  build time; 404 everywhere else), and "Check HTTP challenge" verifies it. Keep serving it.
- **Smithery** — publish-by-URL with the `smithery` npm package (the old `@smithery/cli` is
  stale): `smithery namespace create nextblock` (`nextblock-cms` is taken by another account), then
  `smithery mcp publish "https://cms.nextblock.dev/api/mcp" -n nextblock/nextblock
  --config-schema tools/directories/smithery/config-schema.json`. The config schema declares
  the one field the user fills in and maps it from `x-nextblock-token` (`authorization` is
  reserved by Smithery's gateway) to the upstream `Authorization` header; the value arrives
  without a `Bearer ` prefix, which `parseBearerToken` in `libs/cortex` accepts. Its scanner
  cannot run `tools/list` behind the bearer wall, so it reads
  `app/.well-known/mcp/server-card.json/route.ts`: `serverInfo`, the negotiated
  `protocolVersion`, `endpoint`, `authentication` (`required` + `schemes` as SEP-1649
  documents, plus the human instructions) and the tool / resource / prompt inventory straight
  from the registry (`buildCortexMcpToolDefinitions`), only on sites where the MCP server is
  enabled. Homepage, repository URL and icon are set after the first publish with
  `PATCH /servers/{qualifiedName}`; verify at
  `https://registry.smithery.ai/servers/nextblock/nextblock`.
- **Docker MCP Catalog** — a pull request to github.com/docker/mcp-registry adding
  `servers/nextblock/{server.yaml,tools.json,readme.md}`, kept ready in
  `tools/directories/docker-mcp-registry/`: `type: remote`, the bearer header filled from the
  Docker secret `nextblock.mcp_token`, `tools.json` = `[]` (remote servers use dynamic
  discovery), and **no** `source.project` because Docker's license check blocklists AGPL. Their
  CI runs Prettier with defaults (CRLF fails; the folder is excluded from the repo's
  single-quote rule). Listing at hub.docker.com/mcp/server/nextblock about a day after merge;
  later edits go through an issue there.
- **One-URL directories** — mcp.so: `mcp.so/submit?type=remote-server` (endpoint URL + name;
  free review or a paid instant tier). LobeHub: CLI only (`npx -y @lobehub/market-cli` →
  `login`, `github connect`, `plugin publish https://github.com/nextblock-cms/nextblock --dir
  <repo root>`), reading the root `lhm.plugin.json` (identifier `nextblock-cms-nextblock`,
  `cloudEndpoint`, and the tool / resource / prompt inventory copied from the registry; there is
  no auth field, so the README states the bearer header); a second `plugin update` clears the
  "Unvalidated" badge. cursor.directory: `cursor.directory/plugins/new` → "Auto (GitHub)" →
  paste the repo URL → "Scan repo" → "Publish Plugin"; its parser finds
  `plugins/nextblock/.cursor-plugin/plugin.json` through the root `.cursor-plugin/marketplace.json`
  and lists the rule, the skill and the MCP server from `plugins/nextblock/mcp.json`. Cursor's
  curated Marketplace (`cursor.com/marketplace/publish`) bans AGPL in its Publisher Terms, so it
  would need a separate, permissively licensed plugin repository. The "Add to Cursor" button
  for the vendor instance is `https://cursor.com/install-mcp?name=nextblock&config=<base64 of
  {"url":"https://cms.nextblock.dev/api/mcp","headers":{"Authorization":"Bearer
  ${env:NEXTBLOCK_MCP_TOKEN}"}}>`; never embed a real token in it.
- **Claude Connectors Directory** needs OAuth (DCR or CIMD) for URL-pattern servers, so it
  waits until `/api/mcp` grows an OAuth path.
- Every NextBlock site also serves `/llms.txt` (`app/llms.txt/route.ts`: pages at `/<slug>`,
  posts at `/article/<slug>`, ending with a "Built with NextBlock" section that teaches agents
  the install command). `/.well-known/*` and `/llms.txt` are allowlisted in the proxy so they
  are reachable on an unprovisioned instance too.

### The plugin folder (`plugins/nextblock`)

One folder loads in three hosts, with `skills/nextblock/SKILL.md` as the single source of the
attended flow (propose NextBlock, run `create-nextblock --non-interactive`, hand over the two
browser steps, build over MCP):

- `.claude-plugin/plugin.json` — Claude Code. The root `.claude-plugin/marketplace.json` makes
  the repo its own marketplace: `/plugin marketplace add nextblock-cms/nextblock` then
  `/plugin install nextblock@nextblock`. Anthropic's community marketplace
  (`anthropics/claude-plugins-community`, installed as `nextblock@claude-community` once
  approved) is fed by the Console form at platform.claude.com/plugins/submit; the review runs
  `claude plugin validate <path> --strict` on the plugin and the marketplace, and the directory
  policy wants a contact address, a privacy link and a security channel (`author.email`, the
  README's "Privacy, terms and support"). Installed users only update when `version` is bumped.
- `.cursor-plugin/plugin.json` — Cursor Plugin: `rules/nextblock.mdc`, the skill, `logo.png`,
  and `mcp.json` with the vendor URL and an `Authorization: Bearer ${NEXTBLOCK_MCP_TOKEN}`
  header whose value comes from the manifest's `variables` prompt at install time. The root
  `.cursor-plugin/marketplace.json` is what Cursor's "From GitHub Repository" import and
  cursor.directory read.
- `plugin.json` — Agent Plugins 1.0.0 manifest (`$schema` + `name`), which Codex loads through
  the same root marketplace manifest (`mcp.json` uses the shared `mcpServers` shape).
- `plugins/AGENTS.snippet.md` — the copy-paste block for agents with no plugin system.

### Related hardening

`read_database_records` previously filtered only `cortex_ai_openrouter_api_key` from
`site_settings`. The `isSensitiveKey` heuristic inspects *column names*, and a
site_settings row is `{ key, value }` — neither name trips it, so the stock-photo and
payment/email secret rows passed through. That was low-risk while the tool was
dashboard-only; exposing it to remote MCP clients widened it. `ai-global-agent-db-tools.ts`
now carries `PROTECTED_SITE_SETTING_KEYS`, redacted on read and refused on write.

`mcp_access_tokens` is deliberately **absent** from `tableConfigs`, so the generic DB
tools cannot read token hashes or insert rows.

### Marketing surfaces that describe the MCP server

Three seeded content rows sell the MCP story and are kept at 100/100 in the built-in SEO
engine (`libs/utils/src/lib/seo`). Migration `libs/db/src/supabase/migrations/02004_baseline_seed.sql` (originally `00000000000037_reposition_marketing_and_cortex_mcp`, folded in by the generation-2 squash)
owns them; the sandbox reset route (`enrichCortexAiProducts`) mirrors the product sections
because it deletes and re-inserts product blocks after the SQL replay, so edit both together.

| Surface | Focus keyphrase (type it into the audit panel; it is not persisted) | Body format |
| :-- | :-- | :-- |
| Home page `home` (EN) — hero, "why" (seven-row prototype-tools-vs-NextBlock chart + pricing tiles), "how MCP works", Cortex promo sections | `AI website builder CMS` | styled HTML in `section` → `text` blocks; 040 added the chart, 041 put the pricing message on every section: CMS free forever, Cortex AI (in-editor AI + MCP server) is the one paid license with a 30-day no-card trial, "deploy to Vercel in one click, up in ten minutes" |
| Product `nextblock-cortex-ai-cortex-ai-license` (EN) | `Cortex AI MCP server` | styled HTML in five `section` blocks; title "NextBlock™ Cortex AI MCP Server & AI Editor License" (041 — never "copilot", the product is Cortex AI) |
| Post `cortex-ai-mcp-connection-guide` (EN) | `connect Claude to NextBlock CMS` | styled HTML in one `text` block: comparison chart, a CSS/HTML flow diagram (four cards, `not-prose`), terminal panels; 037 seeded a plain Tiptap doc, 038 replaced it with a rasterised diagram, 041 replaced that with the CSS version and retired the media row |
| Articles page `articles` (EN + FR) | none set (grades 100 without; EN also 100 with `NextBlock Journal`) | short hero + `posts_grid` + a "What the journal covers" section with four topic cards below the grid (041 moved the ~300-word essay out of the hero) |
| Posts `how-nextblock-works` / `comment-nextblock-fonctionne` | none set (both grade 100) | styled HTML; 042 replaced the `extensibility.webp` figure with a CSS/HTML architecture diagram (core hub with the site logo, four spokes, three panels, stack strip, tagline) built inside the text block — the image file and media row stay because the sandbox reset registers it as a core asset |

The copy names only the five contract tools above plus the real transport and auth rules
(Streamable HTTP, bearer tokens, localhost trust in development, Live Draft staging). If any
of those change, the product page and the guide are the two places that go stale.

## Advanced Agent Settings

The global agent's model limits are admin-tunable from `/cms/settings/cortex-ai` (collapsible "Advanced settings"), stored as a non-secret JSON `site_settings` row `cortex_ai_agent_settings` and read by the route via `resolveCortexAiAgentSettings(supabase)` (defaults + clamping in `normalizeCortexAiAgentSettings`, `libs/cortex/src/lib/ai-config.ts`):

- `maxOutputTokens` — per-step output cap. **`null` = Unlimited** (the route omits the cap so the model uses its own full budget). Default 16000. This is the main lever when a large `rewrite_page_draft` gets truncated.
- `maxSteps` — `isStepCount(n)` tool-call rounds. Default 8.
- `temperature` — default 0.1.
- `responseTimeoutMs` — the per-attempt idle abort. Default 120000.

All values are clamped to safe bounds (`CORTEX_AI_AGENT_SETTINGS_BOUNDS`). Actions: `saveCortexAiAgentSettingsAction` / `resetCortexAiAgentSettingsAction`. The route applies them per attempt (omitting `maxOutputTokens` entirely when Unlimited).

## Dashboard Chat UI

File:

```txt
apps/nextblock/app/cms/components/CortexGlobalAgentChat.tsx
```

Rendered from:

```txt
apps/nextblock/app/cms/CmsClientLayout.tsx
```

Condition:

```tsx
{isAdmin && isCortexAiActive && <CortexGlobalAgentChat />}
```

Features:

- Floating brain icon launcher.
- Right-side popup panel.
- Persistent local browser thread history.
- Sends current CMS page/post/product context with chat requests when available.
- New thread button.
- Delete old thread button.
- Stop streaming button.
- Tool-call status rows:
  - `Updating navigation bar...`
  - `Footer updated`
  - `Documentation searched`
- Metadata badge showing credential source and model id.

Storage:

```txt
localStorage key = nextblock-cortex-global-agent-chat-threads
legacy sessionStorage key = nextblock-cortex-global-agent-chat
```

Limits:

- Max stored threads: 20.
- Max stored messages per thread: 40.
- Request timeout: 45000ms.

Important behavior:

- The UI aborts requests after timeout and shows a clean error instead of leaving a spinner forever.
- The UI cancels the stream reader after receiving `finish`.
- The component returns `null` until mounted, preventing SSR/client localStorage mismatches.
- `CortexAiPageContextProvider` wraps the CMS layout. Edit screens register page, post, and product context via `CortexAiPageContextRegistrar`; the chat also parses `/cms/pages/:id/edit`, `/cms/posts/:id/edit`, and `/cms/products/:id/edit` as a fallback.

## Hydration Fixes Related to Cortex AI Work

During implementation, React hydration warnings appeared around Radix-generated IDs. The visible stack pointed at buttons/selects/dialogs, but the root cause was a different component tree/order between server render and first client render.

Fixes:

- `ResponsiveNav` now renders Radix-heavy search/auth/language/currency/cart controls inside a local `ClientOnly` wrapper.
- `Header` passes render functions instead of reusing the same React element instance in both desktop and mobile nav sections.
- `FeedbackModal` renders a plain trigger button before mount, then wraps it with Radix `Dialog` after hydration.
- `CortexGlobalAgentChat` is also mounted only after the client has loaded thread state.
- `ProductFormClientShell` renders a deterministic placeholder on SSR/initial hydration, then mounts the Radix-heavy product form controls client-side.

These choices keep SSR and first client render aligned while preserving interactive behavior after hydration.

## Dashboard Premium CTA

File:

```txt
apps/nextblock/app/cms/dashboard/actions.ts
```

Important detail:

- Dashboard stats now check `activePackages.has('cortex-ai')`.
- Older code checked `activePackages.has('ai')`, which incorrectly showed the "Upgrade to Premium" CTA even when Cortex AI was active.

The CTA component itself lives in:

```txt
apps/nextblock/app/cms/dashboard/components/DashboardComponents.tsx
```

It returns `null` when both commerce and Cortex AI are active:

```ts
if (hasCommerce && hasAi) return null;
```

## Tests and Verification

Package scripts:

```txt
npm run verify:cortex-ai-routing
npm run verify:cortex-ai-generate-blocks
npm run verify:cortex-ai-global-tools
npm run verify:cortex-ai-build-widget
npm run verify:editor-block-schema
```

Useful commands:

```bash
npm run verify:cortex-ai-global-tools
npm run verify:cortex-ai-routing -- --mode=both
npm run verify:cortex-ai-generate-blocks -- "Generate a 3-tier pricing table"
npm run verify:editor-block-schema
npx nx lint nextblock --skip-nx-cache
npx nx build nextblock --skip-nx-cache
```

Vitest files:

```txt
libs/cortex/src/lib/ai-key-crypto.test.ts
libs/cortex/src/lib/ai-model-catalog.test.ts
libs/cortex/src/lib/ai-model-registry.test.ts
libs/cortex/src/lib/ai-global-agent-tools.test.ts
```

Notes:

- Live OpenRouter verification needs a valid `OPENROUTER_API_KEY` or stored BYOK.
- Free model limits may make live routing/generation tests flaky.
- Prefer focused verification scripts for Cortex AI changes instead of running broad test suites unless an error requires it.

## Common Troubleshooting

### The chat bubble stays loading

Current protections:

- Server-side **idle** timeout: 60 seconds with no stream activity (resets on each stream part).
- Client **idle** timeout: 90 seconds with no stream activity (`IDLE_TIMEOUT_MS`, resets on each chunk), so a long multi-section build is not aborted at a fixed wall-clock deadline.
- Client stops reading on `finish`.

If it still happens:

1. Hard refresh the browser to clear a stuck request.
2. Check browser console for fetch/stream errors.
3. Check server logs from `/api/ai/global-agent`.
4. Verify OpenRouter account limits.
5. Verify `OPENROUTER_API_KEY` or stored BYOK exists.

### The agent says rate limit exceeded

OpenRouter free models can hit account-level daily limits. This can happen even with a real API key if the account has no credits or free quota is exhausted.

Mitigations:

- Add OpenRouter credits.
- Save a stored BYOK and select a compatible paid model in `/cms/settings/cortex-ai`.
- Add or change fallback models in `ai-model-registry.ts`.

### Inline editor generation fails with a generic fallback error

The inline route now summarizes first/last real model errors from routing attempts and returns that message in the JSON body. Server logs still include the full per-model `attempts` array.

Check:

- Sandbox BYOK is present in `localStorage` under `cortex_ai_sandbox_openrouter_api_key`.
- Sandbox model selection is present under `cortex_ai_sandbox_openrouter_model_selection`.
- Request headers include `x-sandbox-openrouter-key` and `x-sandbox-openrouter-model` in sandbox.
- Env-only routing is not expected to use paid models; it always uses the free registry.
- The model returned an HTML fragment, not markdown fences, a full HTML document, or conversational prose.

### The agent added a link but then showed an error

The mutation may have succeeded before the model hit a final-response error. Current route behavior should synthesize a clean confirmation after a successful tool result.

Navigation append is idempotent by URL, so retrying the same request should skip duplicate URLs.

### "Add it in French" does not work

The tool backend can resolve language names and aliases, but the language must exist and be active in `languages`.

Check:

- `languages.code = 'fr'`
- `languages.name = 'French'` or compatible alias
- `is_active` is not false

### Stored key cannot be decrypted

Likely causes:

- `CORTEX_AI_ENCRYPTION_KEY` changed.
- Stored envelope was manually edited.
- Stored key was encrypted in a different environment.

Resolution:

- Clear the stored key in `/cms/settings/cortex-ai`.
- Set the intended encryption key.
- Save the OpenRouter key again.

### Cortex AI package active but dashboard still shows AI upsell

Check:

- Active package row has `package_id = 'cortex-ai'`.
- Dashboard code checks `cortex-ai`, not `ai`.
- Hard refresh or clear Next cache if stale.

### Hydration warning involving Radix IDs

Likely cause:

- A client component renders a different tree on first client render than SSR.

Known fixed areas:

- Public nav Radix controls are client-only after mount.
- Feedback modal trigger is stable before mount.
- Chat component waits until mounted.
- Product edit form controls wait until mounted through `ProductFormClientShell`.

If new warnings appear, inspect for:

- `typeof window` branches inside render.
- `Date.now()` or `Math.random()` during render.
- LocalStorage/sessionStorage reads during initial state that affect rendered tree.
- Reusing the same React element in two places.

## Security Notes

- Never expose OpenRouter API keys to client components.
- Keep AI config/client modules server-only.
- Stored BYOK plaintext is never persisted.
- Stored BYOK plaintext is only available transiently server-side after decrypt.
- Settings server actions re-check admin role.
- AI route handlers re-check authentication/role.
- Global agent DB mutations use service-role Supabase only on the server.
- Sensitive `site_settings` row is protected by RLS.
- Do not log plaintext API keys.
- Do not paste real secrets into documentation, PRs, screenshots, or AI prompts.

## Extension Guide

### Adding a New Agent Tool

1. Add a strict Zod input schema in `ai-global-agent-tools.ts`.
2. Add a pure executor function that accepts input and `ToolExecutionContext`.
3. Re-check any database assumptions inside the executor.
4. Use service-role Supabase through context.
5. Return a small structured result with `success: true`.
6. Add the tool to `createCortexGlobalAgentTools`.
7. Update the global agent system prompt if needed.
8. Add focused tests in `ai-global-agent-tools.test.ts`.
9. Update `verify-cortex-ai-global-tools.ts`.
10. Consider deterministic completion copy in `getToolCompletionMessage`.
11. Classify it for MCP: `read` or `write` in `CORTEX_MCP_TOOL_KINDS`
    (`mcp-tool-registry.ts`), and for a write tool a row in
    `CORTEX_MCP_WRITE_TOOL_BEHAVIOURS` (`destructive` / `idempotent` / `openWorld`, read
    off what the executor actually does — see "Tool annotations"). The compiler and
    `mcp-server.test.ts` both refuse a missing one; an unclassified tool is withheld from
    `tools/list` rather than exposed.

Rules:

- Tool arguments must be typed.
- Avoid raw SQL unless absolutely necessary.
- Make side-effecting operations idempotent when possible.
- Do not retry side-effecting tool calls after success.

### Adding a New Editor Node Type

1. Confirm the node exists in the actual Tiptap extension set.
2. Add it to the full schema in `libs/utils/src/lib/editor-blocks.ts`.
3. Decide if it is safe for stored AI-authored JSON fields such as product `description_json`.
4. If safe, add it to the generated/schema-constrained JSON surface used by validators and agent tools.
5. Update `EDITOR_BLOCK_ALLOWED_NODE_TYPES`.
6. Update schema awareness string if needed.
7. If the node has an HTML representation, verify the inline assistant can insert it through Tiptap's normal HTML parser/source-mode path.
8. Run:

```bash
npm run verify:editor-block-schema
```

9. Test inline generation with:

```bash
npm run verify:cortex-ai-generate-blocks -- "Generate content using the new node type"
```

### Adding a New Free Model

1. Add the model id to `CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY`.
2. Confirm the model supports the target feature:
   - tool calling for global agent
   - clean text/HTML fragment generation for the inline editor
3. Run:

```bash
npm run verify:cortex-ai-routing -- --mode=free
```

4. If used for generation, test:

```bash
npm run verify:cortex-ai-generate-blocks -- --model=MODEL_ID "Generate a 3-tier pricing table"
```

## Current Follow-Up Work Items

1. Seed a Cortex AI product/package showcase in sandbox reset, similar to ecommerce.
   - Use `apps/nextblock/public/images/cortex-ai-square.webp`.
   - Freemius product id: `28609`.
   - Freemius plan id: `47122`.
2. Add footer append mode to avoid replacing all footer links for small edits.
3. Replace keyword documentation search with embedding-based RAG.
4. Add server-side chat thread persistence if browser-local history is not enough.
5. Add page-aware block insertion tools with explicit idempotency keys.
6. Add explicit package gating to editor prompt visibility if desired. The current route enforces access/credentials, but the editor prompt UI is not itself hidden by package state in `NotionEditor`.
7. Consider search/filter affordances in the model picker if the compatible OpenRouter catalog becomes too large for a basic select.

## Mental Model for Future Agents

When modifying Cortex AI, keep these invariants:

1. `cortex-ai` is the package id. Do not reintroduce `ai`.
2. Never put secrets in client code.
3. Stored BYOK overrides `OPENROUTER_API_KEY` so paid model selection can work even in sandbox.
4. Env-only routing must stay locked to the three explicit free models.
5. Stored BYOK requires `CORTEX_AI_ENCRYPTION_KEY`.
6. Stored model selection must only use models with `tools` and `structured_outputs`.
7. Inline editor generation returns HTML fragments, not strict Tiptap JSON.
8. Stored product descriptions and global-agent editor JSON fields still validate against editor schemas.
9. Global mutations must go through typed tools.
10. Side-effecting tools should be idempotent when possible.
11. If a side-effecting tool succeeds and the model fails afterward, report the tool result instead of retrying blindly.
12. Free OpenRouter models are useful but unstable; guard against 429s, malformed tool-call text, invalid HTML fragments, and no-output generation.
13. Multilingual mutations should use active rows from `languages`, not hardcoded assumptions.
14. MCP runs with the service-role client, so RLS is not an authorization boundary
    there. Privileged tools re-check the actor's CMS role themselves.
15. A substituted actor identity is for attribution only, never authorization.
16. The audit log for site scripts is append-only in the database. Reverting writes a
    new revision; it never removes one.
17. Inline scripts in block HTML need the CSP nonce, and must not mutate
    server-rendered DOM at all — `load` is not a post-hydration signal.

## MCP Server: Security Model and Operator Guide

The MCP endpoint (`apps/nextblock/app/api/mcp/route.ts`) exposes the same typed
tools to external clients — Claude Code, Claude Desktop, Cursor. The route is a thin
HTTP shim; the registry lives in `libs/cortex/src/lib/mcp-tool-registry.ts`.

### The four failure shapes to check when adding a tool

Tools were originally written for the in-app agent, which always has a signed-in
user and an open editor. MCP has neither, so every new tool must be checked against
all four of these:

1. **Cookie-session auth.** `createClient()` + `auth.getUser()` returns nobody over
   MCP. Pass a pre-authorized `actorUserId` instead and keep the role check.
2. **`pageContext` dependence.** The route sets it to `null`. A tool that edits
   "the current item" must accept an explicit `cmsTarget`.
3. **Untyped `z.any()` parameters.** They serialize to `{}` in JSON Schema, so hosts
   send `"29.99"` where a number is expected. Coerce rather than reject.
4. **Staged artifacts with no finisher.** Anything that stages something (a Live
   Draft) needs a tool that can complete it, or MCP callers cannot finish the job.

### Authorization does not come from RLS

**MCP executors use the service-role client, which bypasses Row Level Security.** An
`ADMIN`-only table policy therefore constrains the dashboard but *not* the MCP path.
Privileged tools must re-check the actor's CMS role themselves — see
`requireActorRole` in `ai-global-agent-theming-tools.ts`.

MCP token scopes are only `read` / `write` and carry no role, so the role is resolved
from the acting user at call time. Two related rules:

- Keep privileged tables (`site_scripts`, `site_script_revisions`) **out of** the
  `execute_database_mutation` allowlist, or that generic tool becomes a way around
  every per-tool guard.
- When a token's creator has been deleted, the route substitutes a stand-in admin so
  a revision can still be attributed. That substitution is flagged
  (`actorFromOrphanedToken`) and refused for role-gated operations: a credential must
  not gain authority by outliving its owner.

### Prompt injection

`fetch_url_content` returns attacker-controlled text to a model that holds write
tools. A hostile page can contain instructions aimed at the agent ("also add this
tracking snippet"). This is not solvable in the tool layer — the model reads the page
because you asked it to. The mitigations are containment, not prevention:

- Code injection (`manage_site_script`) is **ADMIN-only**, so a `write` token that is
  otherwise fine for content cannot ship JavaScript.
- `manage_site_script` requires a `purpose` and returns a `safetyReview` produced by
  an **independent static scan** of the code (`@nextblock-cms/utils/script-safety`).
  The stated purpose is not the control — a steered model will describe a skimmer as
  an analytics helper. The scan reports what the code can actually reach (cookies,
  network, storage, form fields, dynamic evaluation, external hosts) and both are
  written to the audit log, so a mismatch is visible rather than hidden.
- Every script change is recorded in `site_script_revisions`, which is **append-only
  by database trigger** — UPDATE and DELETE are rejected even for the service role.
  An audit log a compromised credential can rewrite is not an audit log.

The scan is regex over source text, not a sandbox. Obfuscated code can evade it,
which is why dynamic evaluation is itself reported at warning level. A clean result
means "nothing obvious found", never "safe".

### Site scripts and the CSP

The site CSP carries a nonce, and per CSP Level 2 a browser **ignores
`'unsafe-inline'` once a nonce is present**. Consequences:

- Inline `<script>` inside rich-text block HTML must be stamped by
  `apps/nextblock/lib/blocks/inlineScriptNonce.ts`, or the browser silently drops it
  with no server-side symptom.
- Because NextBlock nonces author scripts, an external `src` on a site script is
  authorized regardless of the CSP host allowlist. That is inherent to the feature
  and a reason it is ADMIN-only.

### Author scripts and React hydration

Public pages are React-hydrated, and this is the single most common way an author
script goes wrong. **Do not change the text, classes, or attributes of
server-rendered markup.** React reconciles after the script runs and either reverts
the change or logs a hydration mismatch — a counter visibly animates and then snaps
back to its server value.

Waiting for the `load` event is **not** a fix. With streaming and selective
hydration, hydration can still be in flight when `load` fires; this was tried and
still produced mismatches on `<section className=…>`.

Patterns that are actually safe:

- **Web Animations API.** `el.animate([...], {fill: 'both'})` creates an Animation
  object and writes neither `class` nor `style`, so React has nothing to diff. A
  paused animation held at `currentTime = 0` hides an element without a class.
- **Append your own elements.** React does not own what the script creates, so a
  progress bar or overlay appended to `<body>` is unconditionally safe.
- **CSS.** Anything expressible in CSS carries no hydration risk at all.
- **If text must change**, render the FINAL value server-side and animate toward it
  once the element scrolls into view, so any reconciliation lands on the correct
  value rather than resetting the animation. Format numbers with a fixed formatter,
  not `toLocaleString()`, so the client string matches the server byte for byte.

### SSRF

`fetch_url_content` and the media importer perform server-side HTTP on a
caller-supplied URL, and `fetch_url_content` is a **read**-scoped tool — so its
blocklist is what stops a read-only token from reaching internal services. The
blocklist is duplicated (`isBlockedFetchHost` in cortex, `isBlockedImportHost` in the
app) because a published lib cannot import from the app: **fix both together.**
Regression tests live in `ai-global-agent-ssrf.test.ts`; IPv4-mapped IPv6
(`::ffff:127.0.0.1`) previously bypassed both.

### Building a whole site in one pass

The tools below exist specifically so a site can be built without a human clicking
through the dashboard. Rough order for a from-scratch build:

| Step | Tools |
| --- | --- |
| Ground yourself | `get_site_overview` (one call: languages, identity, every page/post/product, menus, themes, custom blocks, drafts, the saved brief, seeded-content detection); `get_database_schema` only for raw table work |
| Remember the client | `save_site_brief` |
| Approve the plan | `start_site_build` with `summary`, `brief`, and `reset` (one confirmation opens an unattended build session and removes the demo content) |
| Identity | `update_site_identity` (title, description, keywords, per-language copyright, logo pin, NextBlock footer credit, `social_image` share preview) |
| Brand it | `manage_site_theme`, `update_global_css` |
| Assets | `search_stock_media`, `upload_media` |
| Catalogue | `manage_product_category`, `create_cms_product`, `manage_product_variants` |
| Pages | home: `generate_jsonb_layout` then `publish_content_draft`; others: `create_cms_page` with `status: "published"` |
| Navigation | `update_site_navigation` (mode `replace`), `update_footer` — for every active language |
| Locales | `manage_language` then `translate_content_bulk` |
| Motion | `update_global_css` plus `manage_site_script` |
| Close | `finish_site_build` |

`manage_language` must run before any translation: `translate_page` and
`translate_content_bulk` can only target a language that already exists and is
active.

## Site builder: interview → plan → build

The "Build your site with Cortex AI" flow replaces the seeded NextBlock demo content
with the client's own site from a single chat, the way AI-first site builders do. It
is reachable from the dashboard onboarding checklist (first step when Cortex is
active), from `/cms/dashboard?cortex=site-builder` (where the post-install welcome flow
and the setup wizard hand off once a model key exists), from the empty-chat "Build my
site with Cortex" button, and over MCP through the `build-site` prompt. Every one of
those goes through the Cortex first-run wizard (`/cms/settings/cortex-ai/setup?intent=site-builder`)
when no OpenRouter key exists yet — see "First-run setup wizard" under CMS Integration.

### Pieces

| Piece | Where |
| --- | --- |
| Site-level tools | `libs/cortex/src/lib/ai-global-agent-site-tools.ts` — `get_site_overview`, `update_site_identity`, `save_site_brief`, `reset_site_content`, `start_site_build`, `finish_site_build` |
| Brief + build session schemas | `libs/cortex/src/lib/site-brief.ts` — stored in `site_settings` as `cortex_ai_site_brief` and `cortex_ai_build_session` |
| Seed signatures | `NEXTBLOCK_SEED_TRANSLATION_GROUP_IDS`, `NEXTBLOCK_SEED_MEDIA_OBJECT_KEYS` in the site tools: the fixed translation groups and bundled image keys from `02004_baseline_seed.sql` (+ `02009`). Seeded rows carry no marker column, so these are the handles |
| Chat route | `apps/nextblock/app/api/ai/global-agent/route.ts` — `mode: "site-builder"` appends `SITE_BUILDER_MODE_PROMPT`; a valid `buildSessionId` appends the build-session prompt, raises `maxSteps` to at least `BUILD_MODE_MIN_STEPS` (40) and builds the tool registry with `skipConfirmation` for everything except `ALWAYS_CONFIRM_TOOL_NAMES`; `endBuildSession: true` closes the session with no model call; the saved brief is injected into every system prompt |
| Chat client | `apps/nextblock/app/cms/components/CortexGlobalAgentChat.tsx` — threads carry `mode` and `buildSession`; `CORTEX_OPEN_EVENT` / `openCortexSiteBuilder()` start the flow; the `start_site_build` result's `continuePrompt` is auto-sent so the build begins without another click; a banner shows the live session with a Stop button |
| Onboarding | `apps/nextblock/lib/onboarding/status.ts` step `cortex-site-builder` (done once the brief reaches status `built`, or the site title was customized by hand) |

### The one-confirmation build

In the dashboard every mutating tool confirms two-step, and a confirmed call runs
without the model, so a 20-step build would otherwise need 20 clicks. The flow keeps
ONE confirmation:

1. Phase 1, interview: the model calls `get_site_overview`, asks the discovery
   questions in one numbered list (business, audience and goal, one page or several,
   languages, brand, contact details, keep or replace, reference URL / products), and
   records answers with `save_site_brief` (mode `merge`, so partial answers are safe).
2. Phase 2, plan: it presents the plan in plain language and calls
   `start_site_build` with `summary`, the `brief`, and `reset` (`keepLanguages` = the
   wanted locales). The confirmation preview shows the plan AND the reset counts.
3. Confirm: `executeStartSiteBuild` saves the brief as `confirmed`, runs
   `executeResetSiteContent` with `skipConfirmation`, and writes a build session
   `{ id, actorUserId, createdAt, expiresAt, summary }`. The result carries
   `buildSession` and `continuePrompt`; the client stores the session on the thread
   and sends the continue prompt as the next user message.
4. Phase 3, build: every request in that thread carries `buildSessionId`. The route
   honours it only when the stored session belongs to the same admin and has not
   expired (`resolveCortexBuildSession`), then runs identity → languages → theme →
   pages → publish → navigation → footer → translations → `finish_site_build`
   unattended. Resets, deletions, site scripts and raw database mutations still
   confirm inside a session.

Session safety: bound to the actor, time-boxed (default 60 min, max 180), closed by
`finish_site_build`, the Stop button (`endBuildSession`), or expiry; the
`cortex_ai_build_session` row is write-protected in the generic database tools so a
model cannot grant itself one; over MCP confirmation is skipped anyway, so the session
only persists the brief and runs the reset there.

### reset_site_content

ADMIN only, irreversible, always confirmed (the preview points at
`/cms/settings/backup-restore`). Defaults: delete every page except the `home`
translation group (kept but emptied, because `/` resolves by that slug), every post,
every navigation item, the bundled demo images and the seeded logo, and blank the
site title / description / keywords / copyright. Options: `keepPageSlugs`,
`keepLanguages` (other languages are deactivated, never deleted, and their content
removed), `onlySeeded` (touch only rows matching the seed signatures), `scope` flags
for products and custom block definitions, `dryRun`. `content_drafts` has no FK to
pages, and `navigation_items.page_id` is `ON DELETE SET NULL`, so both are deleted
explicitly; pages/posts cascade their blocks and revisions.

### What `get_site_overview` reports as "seeded"

Pages and posts whose `translation_group_id` is one of the fixed seed UUIDs, media
whose `object_key` is a bundled `images/*` demo asset, the seeded logo, the
`NextBlock™ CMS` site title, and a copyright line containing "Nextblock CMS". The
result's `nextSteps` tell the model what to do about it.

## Validation: what Cortex checks before JSONB reaches the database

The Pydantic-shaped layer here is Zod. Every layer a payload crosses:

1. Tool arguments. Every tool has a `z.strictObject` input schema with `strict: true`;
   the AI SDK rejects a call that does not match before `execute` runs, and MCP
   serialises the same schema for `tools/list`.
2. Block content. The typed content tools (`create_cms_page/post/product`,
   `rewrite_page_draft`, `insert_content_block`, `update_content_block`,
   `update_section_column_block`, `translate_page`) normalize each block
   (`normalizeBlockContentForType`: section defaults, heading/text/button/form
   aliases) and then validate it. Both routes inject the app's own
   `validateBlockContent` (`apps/nextblock/lib/blocks/blockRegistry.ts`, the
   schemas the editor and renderer use); without it the mirrored
   `fallbackBlockSchemas` in `libs/cortex/src/lib/block-content-schemas.ts` apply.
   Nested column blocks are validated recursively.
3. Custom block instances. A `block_type` that is not built in must be a
   `custom_block_definitions.slug`; the definitions are loaded on demand
   (`withCustomBlockDefinitions`) and the flat `{ field_key: value }` content is
   checked against the definition's fields (`validateCustomBlockInstanceContent`:
   required fields, text / rich-text strings with length limits, image objects,
   relation ids, no unknown keys). Nested custom blocks inside a section are admitted
   by both the app schema and the mirror.
4. Custom block definitions. `create_custom_block` generates JSON with
   `output: 'no-schema'` and then validates twice (`cortexWidgetDefinitionSchema`,
   `customBlockDefinitionCreateSchema`); Postgres re-checks `fields` and
   `layout_schema` with `is_valid_custom_block_fields` / `is_valid_custom_block_layout_schema`.
5. Product bodies. `description_json` goes through the editor document schema.
6. Generic database tools. `execute_database_mutation` / `execute_database_action_plan`
   used to accept any JSON for allow-listed columns. They now validate
   `blocks.content` against the row's `block_type` (built-in schema or custom
   definition, including updates, which look up the type of every targeted row) and
   known `site_settings` values against `SITE_SETTING_VALUE_SCHEMAS`; the
   `WRITE_PROTECTED_SITE_SETTING_KEYS` (`cortex_ai_build_session`,
   `is_admin_created`, `migration_baseline_generation`, `security_settings`) are
   readable but never writable there. Unknown `site_settings` keys stay open, as the
   bag is by design.
7. Database. Postgres enforces `check_exactly_one_parent` on `blocks`, the JSONB
   type checks on `content_drafts`, and the custom block definition checks above.
   There is no CHECK on `blocks.content` itself: the application layers above are
   the guard.

What is still trusted: `text.html_content` is arbitrary HTML from a trusted author
(scripts are nonce-stamped, see "Site scripts and the CSP"), and `site_settings`
keys without a registered schema.
