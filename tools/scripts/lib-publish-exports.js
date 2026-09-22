// The `exports` maps that release-lib.js writes into the premium libraries' dist
// package.json right before `npm publish`.
//
// They live here, not inline in release-lib.js, because verify-lib-dist.js needs them too.
// The ecommerce Vite build copies the raw source manifest, which has no `exports` at all, so
// a check that runs on a plain `nx build ecommerce` output (or before the finalize step, as
// the first version of the release gate did) sees every consumed subpath as unresolvable.

const ECOM_EXPORTS = {
  '.': {
    types: './index.d.ts',
    import: './index.es.js',
    require: './index.cjs',
  },
  './server': {
    types: './server.d.ts',
    import: './server.es.js',
    require: './server.cjs',
  },
  './package.json': './package.json',
  // preserveModules emits one file per source module under dist/lib/* (JS) with the .d.ts
  // tree mirroring it (entryRoot 'src'), so every deep subpath the app imports —
  // ./cart-store, ./currency, ./currency-constants, ./types, ./use-cart, ./variation-utils,
  // ./CurrencyProvider, ./server-actions/*, ./components/* — resolves through this wildcard.
  // Exact keys above win for "." and "server".
  './*': {
    types: './lib/*.d.ts',
    import: './lib/*.es.js',
    require: './lib/*.cjs',
  },
};

const CORTEX_EXPORTS = {
  '.': {
    types: './index.d.ts',
    import: './index.es.js',
    require: './index.cjs',
  },
  './client': {
    types: './client.d.ts',
    import: './client.es.js',
    require: './client.cjs',
  },
  './package.json': './package.json',
};

/** The map release-lib.js will publish for `library`, or null when the build writes its own. */
function publishExportsFor(library) {
  if (library === 'ecommerce' || library === 'ecom') return ECOM_EXPORTS;
  if (library === 'cortex') return CORTEX_EXPORTS;
  return null;
}

module.exports = { CORTEX_EXPORTS, ECOM_EXPORTS, publishExportsFor };
