/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';

const packageJsonPath = path.resolve(__dirname, 'package.json');
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, license, repository } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const OUT_DIR = path.resolve(__dirname, '../../dist/libs/sdk');

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
