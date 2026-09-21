/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

const packageJsonPath = path.resolve(__dirname, 'package.json');
const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/sdk',
  plugins: [
    nxCopyAssetsPlugin(['*.md']),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      pathsToAliases: false,
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/sdk',
          version,
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
          path.resolve(__dirname, '../../dist/libs/sdk', 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );
      },
    }),
    nxViteTsPaths(),
  ],
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },
  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
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
