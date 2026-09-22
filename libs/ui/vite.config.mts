import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { clientDirectiveOnEntries, copyIntoDist } from '../../tools/vite/lib-build-plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveFrom = (...segments: string[]) => path.resolve(__dirname, ...segments);
const OUT_DIR = resolveFrom('../../dist/libs/ui');
const packageJsonPath = resolveFrom('package.json');
// dependencies: the runtime packages the bundle leaves external and consumers must install
// (see rolldownOptions.external below). Copied into the published manifest by afterBuild.
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, dependencies, license, repository } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

export default defineConfig({
  root: __dirname,
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations instead
      // of monorepo-relative source paths that do not exist in the published package.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDirs: '../../dist/libs/ui',
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/ui',
          version,
          license,
          repository,
          // The files this build actually writes (Vite's `fileName: 'index'` gives index.mjs
          // and index.js). Through 0.20 these named index.cjs.js / index.es.js, which never
          // existed; resolvers that honour `exports` never noticed.
          main: 'index.js',
          module: 'index.mjs',
          types: 'index.d.ts',
          ...(dependencies ? { dependencies } : {}),
          exports: {
            '.': {
              types: './index.d.ts',
              import: './index.mjs',
              require: './index.js',
            },
            './styles/*': './styles/*',
            './package.json': './package.json',
            // Map every component subpath (@nextblock-cms/ui/button, /card, /sheet, ...) to the
            // barrel. Consumers like @nextblock-cms/ecommerce import these subpaths, but this is
            // a single bundled lib with no per-component files — the barrel re-exports them all.
            // (`.`/`./styles/*`/`./package.json` are more specific and win over this wildcard.)
            './*': {
              types: './index.d.ts',
              import: './index.mjs',
              require: './index.js',
            },
          },
          // `*.mjs`/`*.js` ship the entry files AND every content-hashed chunk beside them:
          // the lazily-imported SketchPicker and the shared runtime helpers `index.mjs`
          // imports statically. The bundler picks the chunk names (Vite 7 wrote `index-*`,
          // Vite 8 / Rolldown writes `dist-*`, `es-*` and `rolldown-runtime-*`), so a
          // name-based glob drops them from the tarball and every consumer hits "Can't
          // resolve ./<chunk>.mjs". `tools/scripts/verify-lib-dist.js` packs the dist and
          // fails on any relative import the tarball does not contain.
          files: [
            '*.mjs',
            '*.js',
            'index.d.ts',
            'styles',
            'lib',
          ],
        };

        fs.writeFileSync(
          resolveFrom('../../dist/libs/ui', 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        const stylesSource = resolveFrom('src/styles');
        const stylesDestination = resolveFrom('../../dist/libs/ui', 'styles');

        if (fs.existsSync(stylesSource)) {
          fs.mkdirSync(stylesDestination, { recursive: true });
          const entries = fs.readdirSync(stylesSource, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.css')) {
              const sourcePath = resolveFrom('src/styles', entry.name);
              const destinationPath = resolveFrom('../../dist/libs/ui/styles', entry.name);
              fs.copyFileSync(sourcePath, destinationPath);
            }
          }
        }
      }
    }),
    react(),
    // 'use client' on index.mjs AND index.js (see the plugin for why afterBuild could not).
    clientDirectiveOnEntries(),
    copyIntoDist(__dirname, OUT_DIR, ['README.md']),
  ],
  build: {
    // Relative, '/'-separated: @nx/vite/plugin derives the build target's cache outputs from
    // this, and an absolute path came out with Windows backslashes.
    outDir: '../../dist/libs/ui',
    emptyOutDir: true,
    lib: {
      entry: './src/index.ts',
      name: 'ui',
      fileName: 'index',
      formats: ['es', 'cjs']
    },
    rolldownOptions: {
      // Every react subpath (incl. react/jsx-runtime) and react-color stay external. Rolldown (Vite 8)
      // keeps a bundled CommonJS module's require("react") as a __require("react") shim that throws
      // "Calling require for react in an environment that doesn't expose the require function" in
      // the browser; Vite 7's commonjs plugin rewrote it into an import. Here that module was
      // react-color's CommonJS dependency reactcss, in the lazy SketchPicker chunk: opening a colour
      // picker in a scaffold would have thrown. react-color now ships as a dependency and the
      // consumer's bundler handles reactcss. tools/scripts/verify-lib-dist.js fails on the shim.
      external: [/^react(\/|$)/, /^react-dom(\/|$)/, /^react-color(\/|$)/, /^@nextblock-cms\/.*/]
    }
  }
});
