// Derives the scaffolded project's next.config.js from the app's real one.
//
// The template ships apps/nextblock/next.config.js verbatim. A standalone project needs a
// handful of differences (tracing root, the published libs to transpile, no build-time
// type-check of pre-built packages), and for years the CLI produced those by rewriting the
// whole file from a hand-maintained string template. That copy drifted: the app moved to
// Turbopack, added security headers and env bridging, and dropped webpack-only options,
// while the template still emitted `experimental.cssChunking` and a `webpack()` function —
// which Next 16 rejects at build time. Patching the real file instead means every future
// change to the app config reaches scaffolds automatically, and a patch whose anchor
// disappears fails loudly here rather than silently shipping a stale config.

export const STANDALONE_TRANSPILE_PACKAGES = [
  '@nextblock-cms/utils',
  '@nextblock-cms/ui',
  '@nextblock-cms/editor',
  '@nextblock-cms/db',
  '@nextblock-cms/sdk',
  '@nextblock-cms/ecommerce',
  '@nextblock-cms/cortex',
];

const TYPESCRIPT_BLOCK = [
  '  // The published @nextblock-cms/* libs are pre-built and fully type-checked in the upstream',
  '  // monorepo, but their consumer-side type declarations can be incomplete — so making',
  '  // `next build` re-type-check them would fail on imports the app uses correctly at runtime.',
  '  // Skip build-time type-checking of the pre-built deps; your own code is still checked in',
  '  // your editor (and you can run `tsc` directly if you want a gate).',
  '  typescript: { ignoreBuildErrors: true },',
].join('\n');

/**
 * Each patch names the anchor it needs. `required` patches throw when the anchor is gone,
 * because that means the app config changed shape and this list needs a look; cosmetic
 * ones are skipped silently.
 */
export const STANDALONE_NEXT_CONFIG_PATCHES = [
  {
    name: 'standalone output + tracing root',
    // The monorepo pins the tracing root two levels up so the standalone server nests under
    // apps/nextblock; a standalone project IS the root, and pinning it unconditionally stops
    // Next from inferring a parent lockfile as the workspace root.
    from: [
      '  ...(isDockerStandalone',
      "    ? { output: 'standalone', outputFileTracingRoot: path.join(__dirname, '../../') }",
      '    : {}),',
    ].join('\n'),
    to: [
      "  ...(isDockerStandalone ? { output: 'standalone' } : {}),",
      '  outputFileTracingRoot: path.join(__dirname),',
    ].join('\n'),
    required: true,
  },
  {
    name: 'transpilePackages',
    // Transpile ALL @nextblock-cms packages so Next applies React Server Component layer
    // semantics to them ('server-only', 'use client' / 'use server'). Without db/sdk/
    // ecommerce/cortex here, db/server's `import 'server-only'` throws even from a Server
    // Component, because Next treats the prebuilt package as an external and skips the
    // server-layer processing the monorepo gets for free from source.
    regex: /transpilePackages:\s*\[[^\]]*\],/,
    to: `transpilePackages: [\n${STANDALONE_TRANSPILE_PACKAGES.map((name) => `    '${name}',`).join('\n')}\n  ],`,
    required: true,
  },
  {
    name: 'skip type-checking pre-built packages',
    from: '  async headers() {',
    to: `${TYPESCRIPT_BLOCK}\n  async headers() {`,
    required: true,
  },
  {
    name: 'standalone server comment',
    from: 'a standalone server (`node apps/nextblock/server.js`)',
    to: 'a standalone server (`node server.js`)',
    required: false,
  },
];

/**
 * Apply the standalone patches to the app's next.config.js source. Line endings are
 * normalized for matching and restored on output, so a CRLF checkout patches cleanly.
 */
export function patchNextConfigForStandalone(source) {
  const usesCrlf = source.includes('\r\n');
  let content = source.replace(/\r\n/g, '\n');

  for (const patch of STANDALONE_NEXT_CONFIG_PATCHES) {
    const matched = patch.regex ? patch.regex.test(content) : content.includes(patch.from);

    if (!matched) {
      if (patch.required) {
        throw new Error(
          `next.config.js patch "${patch.name}" found no anchor — apps/nextblock/next.config.js changed shape; update STANDALONE_NEXT_CONFIG_PATCHES in create-nextblock/bin/lib/next-config.js.`,
        );
      }

      continue;
    }

    content = patch.regex ? content.replace(patch.regex, patch.to) : content.replace(patch.from, patch.to);
  }

  return usesCrlf ? content.replace(/\n/g, '\r\n') : content;
}
