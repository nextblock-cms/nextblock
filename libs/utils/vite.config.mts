import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { copyIntoDist } from '../../tools/vite/lib-build-plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, 'package.json');
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, license, repository } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const OUT_DIR = path.resolve(__dirname, '../../dist/libs/utils');

export default defineConfig({
  root: __dirname,
  // TypeScript first: src/ tracks stale compiled twins (`server.js`, `lib/server-utils.js`)
  // beside their `.ts` sources, and Vite's default order would resolve an extension-less
  // import to the `.js` and publish the old code. Same trap as libs/db.
  resolve: {
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  plugins: [
    dts({
      entryRoot: 'src',
      // Use tsconfig.lib.json (include: src/**) so vite-plugin-dts reliably emits every
      // declaration to outDirs below and the published package ships index.d.ts. (tsconfig.json
      // has an empty include + only a composite project reference, which made the plugin emit
      // to ../../dist/out-tsc instead, shipping a package with no index.d.ts — the original bug.)
      // Trade-off: this stops producing the dist/out-tsc reference output, so downstream libs'
      // dts builds (ui/editor/ecom) log non-fatal TS6305 — they still emit correct types and
      // publish fine. Restoring out-tsc reliably needs a non-incremental composite build, which
      // isn't worth the complexity for cosmetic build-log noise.
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations instead
      // of monorepo-relative source paths that do not exist in the published package.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDirs: '../../dist/libs/utils',
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/utils',
          version,
          license,
          repository,
          main: 'index.cjs.js',
          module: 'index.es.js',
          types: 'index.d.ts',
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
            './package.json': './package.json',
            // Declared explicitly rather than left to the './*' wildcard below,
            // because the wildcard would resolve './seo' to './lib/seo.es.js' — a
            // FILE — while the SEO engine is a DIRECTORY (`lib/seo/index.es.js`).
            // The wildcard still serves the leaf modules (`./seo/redirects` ->
            // `./lib/seo/redirects.es.js`), which is why only the barrel needs a
            // key of its own. Paired with the 'lib/seo/index' build entry above,
            // without which these files would not exist.
            './seo': {
              types: './lib/seo/index.d.ts',
              require: './lib/seo/index.cjs.js',
              default: './lib/seo/index.es.js',
            },
            // preserveModules emits one file per source module under dist/lib/* (JS) with the
            // .d.ts tree mirroring it (entryRoot 'src'), so every declared deep subpath —
            // ./utils (normalizeCurrencyCode, consumed by @nextblock-cms/ecommerce) and
            // ./custom-blocks (consumed by @nextblock-cms/cortex), plus client-utils /
            // translations-context / etc. — resolves through this wildcard. Exact keys above
            // win for "." and "./server". Without this, published consumers hit
            // "Can't resolve '@nextblock-cms/utils/utils'".
            './*': {
              types: './lib/*.d.ts',
              require: './lib/*.cjs.js',
              default: './lib/*.es.js',
            },
          },
          dependencies: {
            'clsx': '^2.1.1',
            'tailwind-merge': '^3.7.0',
            // Externalized bare deps the published output imports by name — declare them
            // so a consumer that installs @nextblock-cms/utils gets them resolved.
            'zod': '^4.6.5',
            'zod-to-json-schema': '^3.25.2',
            '@aws-sdk/client-s3': '^3.1136.0',
            '@aws-sdk/s3-request-presigner': '^3.1136.0',
          },
        };

        const outputDir = path.resolve(__dirname, '../../dist/libs/utils');
        fs.writeFileSync(
          path.join(outputDir, 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        // Re-apply 'use client'/'use server' directives the bundler strips, by mapping each
        // emitted module back to its source file (path-agnostic, so it survives output-layout
        // changes — a hardcoded path list silently broke when preserveModules collapsed the
        // output dir). Without 'use client' on translations-context, importing the barrel from
        // a Server Component throws "createContext only works in Client Components".
        const srcDir = path.resolve(__dirname, 'src');
        const directiveForModule = (relNoExt: string): string | null => {
          for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
            const srcFile = path.join(srcDir, relNoExt + ext);
            if (fs.existsSync(srcFile)) {
              const head = fs
                .readFileSync(srcFile, 'utf8')
                .replace(/^\uFEFF/, '')
                .trimStart();
              if (/^['"]use client['"]/.test(head)) return "'use client';";
              if (/^['"]use server['"]/.test(head)) return "'use server';";
              return null;
            }
          }
          return null;
        };
        const reapplyDirectives = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              reapplyDirectives(full);
              continue;
            }
            const match = entry.name.match(/^(.*)\.(es|cjs)\.js$/);
            if (!match) continue;
            const relNoExt = path
              .relative(outputDir, path.join(dir, match[1]))
              .split(path.sep)
              .join('/');
            const directive = directiveForModule(relNoExt);
            if (!directive) continue;
            const contents = fs.readFileSync(full, 'utf8');
            const trimmed = contents.replace(/^\uFEFF/, '').trimStart();
            if (
              trimmed.startsWith("'use client'") ||
              trimmed.startsWith('"use client"') ||
              trimmed.startsWith("'use server'") ||
              trimmed.startsWith('"use server"')
            ) {
              continue;
            }
            fs.writeFileSync(full, `${directive}\n${contents}`);
          }
        };
        reapplyDirectives(outputDir);

        // server.es.js / server.cjs.js / server.d.ts are the compiled src/server.ts, like every
        // other module. Through 0.20 this hook overwrote server.es.js and server.d.ts with a
        // hand-written copy from 2025-10 (it ran after the ESM output and before the CommonJS
        // one, so only the CommonJS file was real). The copy had drifted: its hasEnvVars()
        // ignored the SUPABASE_URL / publishable-key aliases the Vercel integration injects,
        // and it carried a top-level 'use server' the source does not have, which turns every
        // export (deleteMediaFiles, getS3Client) into a Server Action once a client module
        // imports it, instead of the source's loud client-import error.
      },
    }),
    react(),
    copyIntoDist(__dirname, OUT_DIR, ['README.md']),
  ],
  build: {
    // Relative, '/'-separated: @nx/vite/plugin derives the build target's cache outputs from
    // this, and an absolute path came out with Windows backslashes.
    outDir: '../../dist/libs/utils',
    emptyOutDir: true,
    lib: {
      entry: {
        index: './src/index.ts',
        server: './src/server.ts',
        // The SEO engine's barrel has to be a declared ENTRY, not just a module the
        // root barrel happens to re-export. `src/lib/seo/index.ts` contains nothing
        // but `export *` lines, so Rollup treats it as having no side effects and
        // elides it — the root bundle imports `lib/seo/audit.es.js` and friends
        // directly, and no `lib/seo/index.es.js` is ever written. That is invisible
        // in this monorepo, where `@nextblock-cms/utils/seo` resolves through the
        // tsconfig path alias straight to the TypeScript source, and it only breaks
        // once the package is PUBLISHED: the `./*` export wildcard below maps `./seo`
        // to `./lib/seo.es.js`, a file that does not exist, so every standalone
        // install fails to resolve the import. Naming it here forces the chunk to be
        // emitted so the wildcard has something to point at.
        'lib/seo/index': './src/lib/seo/index.ts',
        // Imported ONLY through its subpath (`@nextblock-cms/utils/script-safety`, by
        // @nextblock-cms/cortex and the CMS site-scripts screen), never by the root barrel,
        // so without an entry of its own preserveModules emits no JavaScript for it — only
        // the `.d.ts`. Published cortex then failed to resolve it in every scaffold.
        // `tools/scripts/verify-lib-dist.js` now catches the next module like this.
        'lib/script-safety': './src/lib/script-safety.ts',
      },
      name: 'utils',
      fileName: (format, entryName) => `${entryName}.${format}.js`,
      formats: ['es', 'cjs'],
    },
    rolldownOptions: {
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
      external: (id) => {
        // Bundle only our own source. Relative imports are ours -> bundle. Resolved
        // absolute paths are ours unless they point into node_modules -> bundle/external
        // accordingly. Everything else is a bare specifier (zod, clsx, tailwind-merge,
        // react, next/*, @aws-sdk/*, ...) -> externalize so the published package imports
        // it by name and the consumer resolves it. (Previously zod was NOT externalized,
        // so preserveModules emitted a dangling ../../../../node_modules/zod/... path.)
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
