/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
// eslint-disable-next-line @nx/enforce-module-boundaries -- a build-time helper every lib config shares, not a library dependency
import { rootPackageRanges } from '../../tools/vite/lib-build-plugins.mjs';

// An ES module (.mts), as every other lib config: a .ts config is read as CommonJS here (the root
// package.json sets no "type"), which Vite's native config loader refuses.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, 'package.json');
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, license, repository } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const OUT_DIR = path.resolve(__dirname, '../../dist/libs/sdk');
// The contract's declarations name zod (field schemas) and lucide-react (block icons), and the
// manifest this hook writes declared neither through 0.23.5 (package.json's `dependencies` never
// reach it). Peers: a block's schema and icon must be the project's own zod and lucide-react, or
// their types do not line up. tools/scripts/verify-lib-dist.js check 15 refuses a declaration
// import nothing declares.
const peerDependencies = rootPackageRanges(['lucide-react', 'zod']);

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/sdk',
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      pathsToAliases: false,
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/sdk',
          version,
          license,
          repository,
          main: 'index.js',
          module: 'index.js',
          types: 'index.d.ts',
          peerDependencies,
          exports: {
            '.': {
              types: './index.d.ts',
              import: './index.js',
              require: './index.js'
            }
          },
        };

        fs.writeFileSync(
          path.join(OUT_DIR, 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        // Only the README ships: the old nxCopyAssetsPlugin(['*.md']) also published CLAUDE.md.
        fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(OUT_DIR, 'README.md'));
      },
    }),
  ],
  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    // Relative, '/'-separated: @nx/vite/plugin derives the build target's cache outputs from
    // this, and an absolute path came out with Windows backslashes.
    outDir: '../../dist/libs/sdk',
    emptyOutDir: true,
    reportCompressedSize: true,
    lib: {
      entry: 'src/index.ts',
      name: 'sdk',
      fileName: 'index',
      // Change this to the formats you want to support.
      // Don't forget to update your package.json as well.
      formats: ['es' as const],
    },
    rolldownOptions: {
      // External packages that should not be bundled into your library.
      external: [],
    },
  },
}));
