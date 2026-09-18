import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveFrom = (...segments: string[]) => path.resolve(__dirname, ...segments);
const packageJsonPath = resolveFrom('package.json');
const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

export default defineConfig({
  root: __dirname,
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations instead
      // of monorepo-relative source paths that do not exist in the published package.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDir: '../../dist/libs/ui',
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/ui',
          version,
          main: 'index.cjs.js',
          module: 'index.es.js',
          types: 'index.d.ts',
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
          // `index-*.mjs`/`index-*.js` ship the content-hashed code-split chunks (e.g. the
          // lazily-imported SketchPicker). Without these globs the chunks are emitted but
          // excluded from the tarball, so the consumer hits "Can't resolve ./index-*.mjs".
          files: [
            'index.mjs',
            'index.js',
            'index.d.ts',
            'index-*.mjs',
            'index-*.js',
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

        const ensureClientDirective = (fileName: string) => {
          const filePath = resolveFrom('../../dist/libs/ui', fileName);
          if (!fs.existsSync(filePath)) {
            return;
          }

          const contents = fs.readFileSync(filePath, 'utf8');
          if (contents.startsWith("'use client'") || contents.startsWith('"use client"')) {
            return;
          }

          const directive = "'use client';\n";
          const strictPatterns = [
            "'use strict';\r\n",
            "'use strict';\n",
            "'use strict';",
            '"use strict";\r\n',
            '"use strict";\n',
            '"use strict";',
          ];

          for (const pattern of strictPatterns) {
            if (contents.startsWith(pattern)) {
              const suffix = contents.slice(pattern.length);
              const lineBreak = pattern.endsWith('\n') || pattern.endsWith('\r\n') ? '' : '\n';
              fs.writeFileSync(filePath, `${pattern}${lineBreak}${directive}${suffix}`);
              return;
            }
          }

          fs.writeFileSync(filePath, `${directive}${contents}`);
        };

        ensureClientDirective('index.mjs');
        ensureClientDirective('index.js');
      }
    }),
    react()
  ],
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'ui',
      fileName: 'index',
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: ['react', 'react-dom', /^@nextblock-cms\/.*/]
    }
  }
});
