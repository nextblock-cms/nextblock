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

## Package Activation

The package id is `cortex-ai`. Do not use the old id `ai`.

The package registry entry lives in `libs/utils/src/lib/nextblock-packages.ts`:

```ts
'cortex-ai': {
  id: 'cortex-ai',
  name: 'NextBlock Cortex AI',
  description: 'Native JSONB block generation and OpenRouter integration.',
  fm_product_id: '28609',
  fm_plan_id: '47122',
  purchase_url: 'https://nextblock.dev',
}
```

Activation checks use:

```ts
verifyPackageOnline('cortex-ai')
```

Current usage:

- CMS layout gates the chat with `verifyPackageOnline('cortex-ai')`.
- Settings page reports package active/inactive.
- Global agent route rejects requests if Cortex AI is inactive.
- Dashboard premium CTA checks `stats.isAiActive`, now derived from active package id `cortex-ai`.

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

from `@ai-sdk/openai-compatible`, with:

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
qwen/qwen3-next-80b-a3b-instruct:free
nvidia/nemotron-3-super-120b-a12b:free
nvidia/nemotron-nano-9b-v2:free
```

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
  system,
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

Tools are passed to Vercel AI SDK `streamText`.

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
    role: 'system' | 'user' | 'assistant';
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

Model orchestration:

- Uses `streamText`.
- Uses `buildCortexAiRoutingPolicy`.
- Uses `stepCountIs(8)` (raised from 6 to allow read -> plan -> build/confirm multi-tool sequences such as rewriting a full page).
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

   Net effect: a model can emit a section with just `column_blocks` plus intent (`is_hero`, an optional `background`) and the server produces a valid, well-styled section.

2. **Design recipe in the global-agent system prompt** (`route.ts`, the `PAGE DESIGN` bullets). Tells the model to compose pages from `section` blocks, supply one column per desired grid track, make the first section a hero, alternate `none`/`theme:'muted'`/`theme:'primary'` backgrounds for rhythm, use discrete heading blocks (not `<h2>` inside text HTML), and prefer gradient/theme backgrounds unless a real `media_id` exists. A single `text` block's `html_content` still accepts fully custom HTML/CSS for bespoke sections.

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
| `libs/cortex/src/lib/mcp-server.test.ts` | 33 tests across tokens, registry, and protocol. |
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
- **GET returns `405`.** The server never initiates requests or pushes unsolicited
  notifications, so there is no stream to open. The spec explicitly allows 405 here.
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

Three accepted paths, in priority order, all gated behind
`verifyPackageOnline('cortex-ai')` and the `enabled` setting:

1. **Bearer token** from `public.mcp_access_tokens` — what every external client uses.
2. **Authenticated ADMIN cookie session** — lets the dashboard reach the endpoint
   without minting a token.
3. **Loopback in development** — only when `allowLocalhostWithoutToken` is on *and*
   `NODE_ENV !== 'production'`. Behind a proxy the `Host` header is attacker-
   controllable, so localhost trust is a development affordance only.

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

`CORTEX_MCP_TOOL_KINDS` classifies all 29 registry tools as `read` or `write`. A
read-only token does not merely get refused on a write — the mutating tools are absent
from its `tools/list` entirely, aliases included.

The table is **exhaustive by construction**: `assertCortexMcpToolCoverage` compares its
keys against the live factory output, and a unit test fails if they diverge. An
unclassified tool is *withheld*, never defaulted to `read`, so adding a tool to the
agent without classifying it is a loud failure rather than a silent hole.

### Confirmation is skipped over MCP

The in-app two-phase confirm matches a phrase in the user's *next chat message*, which
has no analogue in MCP — there is no channel to carry a human phrase back between a
tool call and its result. Every MCP host already gates tool calls behind its own
approval UI, so leaving it on would just make every mutating tool return a preview
forever. The real control is the token scope. `ToolExecutionContext.skipConfirmation`
is therefore `true` for all MCP calls.

### MCP-contract tool names

Five names are exposed as aliases forwarding to existing executors, so external clients
get the documented contract without forking tested code. The canonical names remain
listed too, and each alias description begins with "Alias of `<canonical>`" so a model
does not call both.

| MCP name | Forwards to |
| --- | --- |
| `get_database_schema` | `describe_database_schema` |
| `generate_jsonb_layout` | `rewrite_page_draft` (stages a Live Draft; nothing goes live unpublished) |
| `query_site_analytics` | `fetch_ecommerce_stats` |
| `update_site_navigation` | `update_navigation_bar` |
| `search_stock_media` | `search_stock_photos` |

### Resources and prompts

Resources: `cortex://schema/database`, `cortex://schema/blocks`,
`cortex://schema/custom-blocks`. Prompts: `build-page`, `clone-from-url`,
`translate-content`.

### Settings and client configuration

`/cms/settings/cortex-ai` gains an "MCP server access" card: enable/disable, localhost
trust, token mint/revoke, and copy-paste config for all four clients. **The server is
disabled by default** — it is a remote write surface onto live content, so it must be
an explicit opt-in.

Client config differs in ways that silently no-op if copied wrong, which is why the UI
generates each one rather than documenting a single snippet:

- **Claude Code** — `mcpServers`, and `"type": "http"` is *required* (a `url` with no
  `type` is a hard error that skips the server).
- **Cursor** — `mcpServers`, infers transport from `url`, no `type` needed.
- **VS Code** — top-level `servers`, **not** `mcpServers`, and prompts for the token
  via `inputs` rather than storing it.
- **Claude Desktop** — `claude_desktop_config.json` is stdio-only, so a remote server
  needs either the Connectors UI (which dials out from Anthropic's cloud, so localhost
  and firewalled sites will not connect) or the `mcp-remote` stdio bridge.

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
- `maxSteps` — `stepCountIs(n)` tool-call rounds. Default 8.
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
| Ground yourself | `get_database_schema`, `list_media`, `list_site_themes`, `list_product_categories` |
| Brand it | `manage_site_theme`, `update_global_css` |
| Assets | `search_stock_media`, `upload_media` |
| Catalogue | `manage_product_category`, `create_cms_product`, `manage_product_variants` |
| Pages | `generate_jsonb_layout` then `publish_content_draft` |
| Navigation | `update_site_navigation`, `update_footer` |
| Locales | `manage_language` then `translate_content_bulk` |
| Motion | `update_global_css` plus `manage_site_script` |

`manage_language` must run before any translation: `translate_page` and
`translate_content_bulk` can only target a language that already exists and is
active.
