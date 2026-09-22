// The npm `overrides` every scaffolded project gets.
//
// The CLI reads the monorepo root's live `overrides` when it runs from a checkout (local dev,
// `npm run test-create`) and falls back to this set in the published CLI, where the monorepo
// root is not on disk. Keep each value equal to the root package.json override of the same
// name.
//
// Raising a value here also means updating MANAGED_OVERRIDES in
// apps/nextblock/tools/lib/managed-overrides.mjs: set its `current` to the new value and add
// the old one to `previous`, so `npm run update` moves existing projects off it. Also add the
// new value to SHIPPED in fallback-overrides.test.js, which checks all of this.
export const FALLBACK_OVERRIDES = {
  postcss: '^8.5.28',
  qs: '^6.16.0',
  uuid: '^14.0.2',
  glob: '^13.0.6',
  'whatwg-encoding': 'npm:@exodus/bytes@latest',
  'node-domexception': 'npm:domexception@latest',
  keygrip: 'npm:keygrip@latest',
};
