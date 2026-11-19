import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { clientDirectiveOnEntries, copyIntoDist, rootPackageRanges } from '../../tools/vite/lib-build-plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveFrom = (...segments: string[]) => path.resolve(__dirname, ...segments);
const OUT_DIR = resolveFrom('../../dist/libs/editor');
const packageJsonPath = resolveFrom('package.json');
// dependencies: the runtime packages the bundle leaves external and consumers must install
// (see rolldownOptions.external below). Copied into the published manifest by afterBuild.
// license and repository go into the published manifest too: npm shows them on the package page,
// and through 0.20 every package this hook writes shipped without either.
const { version, dependencies: externalDependencies, license, repository } = JSON.parse(
  fs.readFileSync(packageJsonPath, 'utf8')
);
// The bundle inlines Tiptap, but the declarations import it by name (NotionEditor's `Editor`,
// `Extension`, the node types). Through 0.23.5 the manifest declared none of it, so those types
// resolved only where the app or another package happened to install the same Tiptap package, and
// were `any` elsewhere. @tiptap/extension-list and @tiptap/extension-paragraph come in with
// @tiptap/starter-kit, not from the root package.json; they release in lockstep with @tiptap/core.
// The JavaScript still uses its inlined copies. tools/scripts/verify-lib-dist.js check 15 refuses a
// declaration import nothing declares.
const dependencies = {
  ...externalDependencies,
  ...rootPackageRanges(
    [
      '@tiptap/core',
      '@tiptap/extension-blockquote',
      '@tiptap/extension-code-block-lowlight',
      '@tiptap/extension-heading',
      '@tiptap/extension-image',
      '@tiptap/extension-list',
      '@tiptap/extension-paragraph',
      '@tiptap/extension-placeholder',
      '@tiptap/pm',
      '@tiptap/react',
      '@tiptap/suggestion',
    ],
    { sameRangeAs: { '@tiptap/extension-list': '@tiptap/core', '@tiptap/extension-paragraph': '@tiptap/core' } }
  ),
};
// peerDependencies: the sibling libs the bundle imports by name (`@nextblock-cms/*` stays
// external below), at the versions libs/ui and libs/utils carry when this build runs. release:all
// bumps both before it builds the editor (LIBS in tools/scripts/release-all.js), so the ranges
// name the releases that go out with this one. Peers, so the app and the editor share one copy.
// Through 0.22.5 the manifest declared neither, and the editor now imports
// sanitizeAuthoredBlockHtml, which utils 0.22.5 lacks: upgrading only the editor would have
// failed on a missing export. tools/scripts/verify-lib-dist.js check 11 refuses an undeclared
// sibling import.
const siblingVersion = (lib: string): string => {
  const sibling = JSON.parse(fs.readFileSync(resolveFrom('..', lib, 'package.json'), 'utf8')).version;
  if (typeof sibling !== 'string' || !/^\d+\.\d+\.\d+/.test(sibling)) {
    throw new Error(`libs/${lib}/package.json has no version for the editor's peerDependencies`);
  }
  return sibling;
};
// react and react-dom (external below) are peers too, the app's single copy; through 0.23.5 the
// manifest named neither.
const peerDependencies = {
  '@nextblock-cms/ui': `^${siblingVersion('ui')}`,
  '@nextblock-cms/utils': `^${siblingVersion('utils')}`,
  ...rootPackageRanges(['react', 'react-dom']),
};

export default defineConfig({
  root: __dirname,
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations instead
      // of monorepo-relative source paths that do not exist in the published package.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDirs: '../../dist/libs/editor',
      afterBuild: () => {
        const packageJson = {
          name: '@nextblock-cms/editor',
          version,
          license,
          repository,
          main: 'index.js',
          module: 'index.mjs',
          types: 'index.d.ts',
          dependencies,
          peerDependencies,
          exports: {
            '.': {
              types: './index.d.ts',
              import: './index.mjs',
              require: './index.js'
            },
            './styles/*': './styles/*'
          },
        };

        fs.writeFileSync(
          resolveFrom('../../dist/libs/editor', 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        const stylesSource = resolveFrom('src/styles');
        const stylesDestination = resolveFrom('../../dist/libs/editor', 'styles');

        if (fs.existsSync(stylesSource)) {
          fs.mkdirSync(stylesDestination, { recursive: true });
          const entries = fs.readdirSync(stylesSource, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.css')) {
              const sourcePath = resolveFrom('src/styles', entry.name);
              const destinationPath = resolveFrom('../../dist/libs/editor/styles', entry.name);
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
  resolve: {
    alias: [
      { find: '@nextblock-cms/ui/', replacement: resolveFrom('../ui/src/lib') + '/' },
      { find: '@nextblock-cms/ui', replacement: resolveFrom('../ui/src/index.ts') },
      { find: '@nextblock-cms/utils/', replacement: resolveFrom('../utils/src') + '/' },
      { find: '@nextblock-cms/utils', replacement: resolveFrom('../utils/src/index.ts') }
    ]
  },
  build: {
    emptyOutDir: true,
    // Relative, '/'-separated: @nx/vite/plugin derives the build target's cache outputs from
    // this, and an absolute path came out with Windows backslashes.
    outDir: '../../dist/libs/editor',
    lib: {
      entry: './src/index.ts',
      name: 'editor',
      fileName: 'index',
      formats: ['es', 'cjs']
    },
    rolldownOptions: {
      // Every react subpath (incl. react/jsx-runtime) and use-sync-external-store stay external.
      // Rolldown (Vite 8) keeps a bundled CommonJS module's require("react") as a __require("react")
      // shim when react is external, and that shim throws "Calling require for react in an
      // environment that doesn't expose the require function" in the browser and in any ESM
      // consumer: every scaffold. Vite 7's commonjs plugin rewrote it into an import. The only
      // CommonJS module here that requires react is use-sync-external-store (via @tiptap/react), so
      // it ships as a dependency and the consumer's bundler handles it. esmExternalRequirePlugin was
      // tried and does not help: in Vite library mode it left react bundled instead of external.
      // tools/scripts/verify-lib-dist.js fails if the shim reappears in a published ESM file.
      external: [/^react(\/|$)/, /^react-dom(\/|$)/, /^use-sync-external-store(\/|$)/, /^@nextblock-cms\/.*/],
      output: {
        exports: 'named'
      }
    }
  }
});
