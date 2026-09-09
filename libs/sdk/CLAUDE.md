# libs/sdk — @nextblock-cms/sdk

Types-only contract for reusable block authors: `BlockContentSchema`, `BlockData`, `BlockProps`,
`BlockEditorProps`, `BlockConfig` (`type`, `label`, `icon`, `schema`, `initialContent`,
`RendererComponent`, `EditorComponent`) in `src/lib/sdk.ts`. The built `index.js` is empty. The
CMS registry and the only consumer live in `apps/nextblock` (`lib/blocks/blockRegistry.ts`,
`components/blocks/TestimonialBlock.tsx`).

## Rules
- Leaf lib (no `@nextblock-cms/*` deps), `scope:public`, published third (utils → ui → sdk → …).
  Keep it types-only.
- `noPropertyAccessFromIndexSignature` is on: bracket-access undeclared keys.
- `tsconfig.lib.json` includes `src/**/*.ts` only; a `.tsx` under `src` is silently dropped.
- New runtime imports must be listed in `package.json` (`@nx/dependency-checks`).

## Gotchas
- The published `package.json` is written by `vite.config.ts` afterBuild; `dependencies` and
  `license` in the source manifest never ship.
- `sdk.ts` uses `React.ComponentType` without importing React; consumers need `@types/react`.
- `BlockConfig` field names are load-bearing for `blockRegistry.ts`.
- `npm run build:sdk` publishes to npm; use `npx nx build sdk` for a local build.

Commands: `npx nx build sdk`, `npx nx lint sdk`, `npx nx typecheck sdk`. No tests exist.
