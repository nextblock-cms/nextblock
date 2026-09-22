import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';

const packageJsonPath = path.resolve(__dirname, 'package.json');
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, license, repository } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

export default defineConfig({
  root: __dirname,
  // TypeScript first. src/ tracks stale compiled twins (`package-validation.js` beside
  // `package-validation.ts`, and nine more), and Vite's default order resolves an
  // extension-less import to the `.js`. Through 0.19.0 that assembled the published package
  // from code dated 2026-05-13: `PACKAGE_ACTIVATION_CACHE_TAG`, the trial-expiry check and
  // the Supabase env alias chain were all missing, which broke `next build` in scaffolds.
  resolve: {
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  plugins: [
    dts({
      entryRoot: 'src',
      // Use tsconfig.lib.json (include: src/**, no project references), not tsconfig.json
      // (empty include + a reference to lib.json) — otherwise vite-plugin-dts builds the
      // referenced composite project and emits to ../../dist/out-tsc instead of outDirs below,
      // shipping a package with no index.d.ts. (Matches libs/ui, libs/utils, etc.)
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations instead
      // of monorepo-relative source paths that do not exist in the published package.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDirs: '../../dist/libs/db',
      exclude: ['vite.config.ts'],
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/db',
          version,
          license,
          repository,
          main: 'index.cjs.js',
          module: 'index.es.js',
          types: 'index.d.ts',
          // Enables tree-shaking so a client importing the browser `createClient` from
          // '@nextblock-cms/db' does NOT drag in the server module (next/headers + the
          // typeof-window guard). db uses a runtime guard, not a 'use client'/'use server'
          // directive, so without this the unused server module is kept and throws in the
          // client bundle ("cannot be imported from a Client Component module").
          sideEffects: false,
          exports: {
            '.': {
              types: './index.d.ts',
              require: './index.cjs.js',
              default: './index.es.js',
            },
            './server': {
              types: './server.d.ts',
              require: './server.cjs.js',
              default: './server.es.js',
            },
            // Published consumers import this at runtime: @nextblock-cms/cortex's ai-config
            // pulls encrypt/decrypt/resolveSecretEncryptionKey from '@nextblock-cms/db/secrets'.
            // Without this export a Cortex AI route throws "Can't resolve
            // '@nextblock-cms/db/secrets'" in a generated project (it only resolves in-monorepo
            // via the tsconfig path). Emitted as its own build entry below.
            './secrets': {
              types: './secrets.d.ts',
              require: './secrets.cjs.js',
              default: './secrets.es.js',
            },
            // Types only. ecommerce and cortex type their signatures with `Database` imported
            // from this package's `types` subpath; without this key that specifier resolves in
            // the monorepo (through a tsconfig path) and nowhere else.
            './types': {
              types: './lib/supabase/types.d.ts',
            },
            './package.json': './package.json',
          },
          files: [
            'dist',
            'supabase',
            'supabase/**',
            'lib',
            '*.js',
            '*.cjs.js',
            '*.es.js',
            '*.mjs',
            '*.d.ts'
          ],
        };

        fs.writeFileSync(
          path.resolve(__dirname, '../../dist/libs/db', 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        // The README ships with the package (tools/scripts/verify-lib-dist.js check 8 requires one).
        fs.copyFileSync(path.join(__dirname, 'README.md'), path.resolve(__dirname, '../../dist/libs/db', 'README.md'));
      },
    }),
  ],
  build: {
    // Must match the `outputs` of `build` / `vite-build` and the supabase copy destination in
    // project.json: db's explicit targets replace the one @nx/vite/plugin would infer from it.
    outDir: '../../dist/libs/db',
    emptyOutDir: true,
    lib: {
      // Relative, like every other lib: vite-plugin-dts 5 resolves them against the same root
      // as the tsconfig file list. As `path.resolve(__dirname, ...)` they kept the drive-letter
      // case of the cwd, which is `d:` under `nx run db:build` (run-commands), while the
      // plugin resolved its root and the tsconfig file list as `D:`. Its path filter is
      // case-sensitive, so every module reachable from these entries (index, server, secrets
      // and all of lib/) was silently left without a .d.ts.
      entry: {
        index: './src/index.ts',
        server: './src/server.ts',
        // Dedicated entry so secrets.{es,cjs}.js + secrets.d.ts are emitted at the dist root
        // and the './secrets' export above resolves for published consumers (see @nextblock-cms/cortex).
        secrets: './src/secrets.ts',
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        const extension = format === 'es' ? 'es' : 'cjs';
        return `${entryName}.${extension}.js`;
      },
    },
    rolldownOptions: {
      output: {
        // Emit one file per source module (no merged shared chunks). db mixes a client
        // browser-createClient with server modules that use next/headers + a server guard;
        // bundling merged them so importing db dragged server-only code (next/headers) into
        // the client graph. preserveModules keeps them separate and tree-shakeable, so a
        // client import of `createClient` no longer pulls next/headers.
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
      external: (id) => {
        // Externalize every bare specifier (@supabase/*, next/*, @nextblock-cms/*, ...) so
        // preserveModules keeps them as bare imports and the consumer resolves them.
        if (id.startsWith('.')) {
          return false;
        }
        if (path.isAbsolute(id)) {
          return id.includes('node_modules');
        }
        return true;
      },
    },
  },
});
