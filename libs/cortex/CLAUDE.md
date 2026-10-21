# libs/cortex — @nextblock-cms/cortex (Cortex AI, package id `cortex-ai`)

Premium AI package. Model calls go through the Vercel AI SDK and `@ai-sdk/openai-compatible` to
OpenRouter (`ai-client.ts`); there is no direct Anthropic SDK. The operator picks the model
(stored BYOK selection in `site_settings`, else `OPENROUTER_API_KEY` + the free-model chain in
`ai-model-registry.ts`).

Modules: `ai-global-agent-tools.ts` (`createCortexGlobalAgentTools(context)`) plus the
`ai-global-agent-*-tools.ts` sub-registries; pipelines `ai-block-generation`, `ai-seo-metadata`,
`ai-vision`, `ai-cortex-widget-builder`; MCP `mcp-server.ts`, `mcp-tool-registry.ts`,
`mcp-tokens.ts`. Routes: `apps/nextblock/app/api/ai/*`; MCP endpoint `app/api/mcp/route.ts`.

## Rules
- `src/client.ts` is the only browser-safe entry. Server guards are per-function
  `assertServerOnly()` calls: importing is safe, calling in a browser throws. The exception
  is a module that reaches the service role (`ai-client.ts`): it imports `'server-only'`, so
  Next fails the build when a client graph imports it. `tools/scripts/service-role-boundary.test.ts`
  (`security:check`, CI) fails when such a module lacks that import or a client graph reaches it;
  it is a test, not part of the build (docs/04).
- Every tool from `createCortexGlobalAgentTools` MUST be classified read|write in
  `CORTEX_MCP_TOOL_KINDS` (`mcp-server.test.ts` enforces it). Tools set `strict: true`; their
  descriptions and schemas are literals, so the tool list is byte-identical across requests.
- Mutating tools use the confirmation-phrase protocol; over MCP `pageContext` is null and
  confirmation is skipped, so tools accept `cmsTarget` and a pre-authorized actor. In the
  dashboard an approved `start_site_build` session skips it too (route-side, bounded by
  `ALWAYS_CONFIRM_TOOL_NAMES`); never make a lib executor skip confirmation on its own.
- Block schemas live in `block-content-schemas.ts` (mirror of the app registry; keep in
  sync). A `block_type` may be a custom block slug: resolve it through
  `withCustomBlockDefinitions` + `resolveExistingBlockType`, never by widening the enum.
- Site-level tools (`ai-global-agent-site-tools.ts`) hold the seed signatures
  (`NEXTBLOCK_SEED_*`); update them when `02004_baseline_seed.sql` changes. Role checks
  go through `requireActorRole` — RLS is not a boundary under the service-role client.
  `createCortexGlobalAgentTools` wraps every tool not classified `read` in an ADMIN check
  (kinds live in `mcp-tool-kinds.ts` so the factory can read them without a cycle).
- Any server-side fetch of a caller-supplied URL uses `guardedFetch` (`fetch-host-guard.ts`):
  pinned DNS, every redirect hop host-checked, streamed byte cap. Never `fetch()` with
  `redirect: 'follow'`, and never report a status for a refused hop.

## Gotchas
- No call site reads `result.usage`; cached-token counts are not logged anywhere.

Commands: `npx vitest run libs/cortex`, `npx nx build cortex`; `npm run verify:cortex-ai-routing`
and `-generate-blocks` are live (need an OpenRouter key).
