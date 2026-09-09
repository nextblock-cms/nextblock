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
  `assertServerOnly()` calls: importing is safe, calling in a browser throws.
- Every tool from `createCortexGlobalAgentTools` MUST be classified read|write in
  `CORTEX_MCP_TOOL_KINDS` (`mcp-server.test.ts` enforces it). Tools set `strict: true`; their
  descriptions and schemas are literals, so the tool list is byte-identical across requests.
- Mutating tools use the confirmation-phrase protocol; over MCP `pageContext` is null and
  confirmation is skipped, so tools accept `cmsTarget` and a pre-authorized actor.

## Gotchas
- No call site reads `result.usage`; cached-token counts are not logged anywhere.

Commands: `npx vitest run libs/cortex`, `npx nx build cortex`; `npm run verify:cortex-ai-routing`
and `-generate-blocks` are live (need an OpenRouter key).
