# @nextblock-cms/cortex

Cortex AI, the premium AI module of [NextBlock](https://github.com/nextblock-cms/nextblock), the
open-core CMS for Next.js and Supabase. It powers the CMS assistant that builds and edits pages,
posts and products through tools, inline block and HTML generation, SEO metadata, image alt
text, and the MCP server that lets external agents work on a NextBlock site.

Models are called through [OpenRouter](https://openrouter.ai) with the Vercel AI SDK, and the
site operator chooses the model.

Projects created with `npm create nextblock@latest` already depend on it. It needs Next.js 16
(peer dependency), Node.js 22.12 or later, and the project's own `ai` at ^7 and
`@ai-sdk/openai-compatible` at ^3, the versions this package builds its models with.

## Licensing

The source is public under AGPL-3.0-or-later, and the features are license-gated under the
package id `cortex-ai`. A NextBlock project enables Cortex AI only after its license is active:
start the free trial or buy one in the CMS under **Settings → Packages**. The app checks it with
`verifyPackageOnline('cortex-ai')` from `@nextblock-cms/db/server`.

## Entry points

| Import | Use it from | What it holds |
| :-- | :-- | :-- |
| `@nextblock-cms/cortex` | server only | The OpenRouter client and model registry, the global agent and its tools, block and widget generation, SEO metadata, alt text, and the MCP server, tokens and tool registry. It imports `next/headers` and `server-only` modules. |
| `@nextblock-cms/cortex/client` | client or server | The browser-safe values a Client Component may need: `createCortexAiStoredModelSelection`, `formatCortexSiteBriefForPrompt` and `isCortexSiteBriefComplete` |

Types from the main entry are safe to import anywhere; runtime values used by a Client
Component must come from `/client`.

## Environment

- `OPENROUTER_API_KEY`: the server-side key, used when no key is stored in the CMS. A key saved
  in the CMS takes precedence.
- `CORTEX_AI_ENCRYPTION_KEY`: required to save and read the key stored in the CMS. Changing it
  makes stored keys unreadable.

## Documentation

- [Cortex AI architecture](https://github.com/nextblock-cms/nextblock/blob/master/docs/08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md)
- [Project overview](https://github.com/nextblock-cms/nextblock/blob/master/docs/01-PROJECT-OVERVIEW.md)

## License

AGPL-3.0-or-later.
