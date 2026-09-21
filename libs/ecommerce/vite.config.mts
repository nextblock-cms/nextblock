import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../dist/libs/ecommerce');
const SRC_DIR = path.resolve(__dirname, 'src');

// The bundler strips React Server Component directives ('use client' / 'use server'). With
// preserveModules each source module emits its own file, so re-apply the directive from the
// matching source file. Without this, the consuming app's RSC bundler can't keep the
// client/server boundary (server-only code leaks into client graphs and vice versa).
function reapplyDirectives() {
  const directiveForModule = (relNoExt: string): string | null => {
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      const srcFile = path.join(SRC_DIR, relNoExt + ext);
      if (fs.existsSync(srcFile)) {
        const head = fs.readFileSync(srcFile, 'utf8').replace(/^\uFEFF/, '').trimStart();
        if (/^['"]use client['"]/.test(head)) return "'use client';";
        if (/^['"]use server['"]/.test(head)) return "'use server';";
        return null;
      }
    }
    return null;
  };

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const match = entry.name.match(/^(.*)\.(es|cjs)\.js$/);
      if (!match) continue;
      const relNoExt = path
        .relative(OUT_DIR, path.join(dir, match[1]))
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

  if (fs.existsSync(OUT_DIR)) {
    walk(OUT_DIR);
  }
}

export default defineConfig({
  root: __dirname,
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: './tsconfig.lib.json',
      // Keep `@nextblock-cms/*` imports as package names in the emitted declarations. By
      // default the plugin rewrites tsconfig path aliases into relative paths, which for a
      // sibling library means `../../../db/src/index.ts`: a file that exists in this
      // monorepo and nowhere else (58 such imports shipped in 0.19.2). Consumers compile
      // with skipLibCheck, so nothing failed; every `Database`-typed signature was `any`.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDirs: '../../dist/libs/ecommerce',
      afterBuild: reapplyDirectives,
    }),
    react(),
  ],
  build: {
    lib: {
      // Entry per public surface. With preserveModules, each emits at its source path under
      // dist/lib/* (the entry list just guarantees emission — some subpaths, e.g.
      // server-actions/product-actions, aren't reachable from the index/server barrels and
      // would otherwise be skipped). Keep in sync with the app's @nextblock-cms/ecommerce/*
      // subpath imports.
      entry: {
        index: './src/index.ts',
        server: './src/server.ts',
        // Keys are prefixed with `lib/` so each entry emits at dist/lib/<path> — matching the
        // source tree (so the directive re-application can find the source) and the .d.ts tree,
        // which lets the published `./*` -> `./lib/*` export resolve both JS and types.
        'lib/CurrencyProvider': './src/lib/CurrencyProvider.tsx',
        'lib/cart-store': './src/lib/cart-store.ts',
        'lib/currency': './src/lib/currency.ts',
        'lib/currency-constants': './src/lib/currency-constants.ts',
        'lib/types': './src/lib/types.ts',
        'lib/use-cart': './src/lib/use-cart.ts',
        'lib/variation-utils': './src/lib/variation-utils.ts',
        'lib/server-actions/product-actions':
          './src/lib/server-actions/product-actions.ts',
        'lib/components/Cart': './src/lib/components/Cart.tsx',
        'lib/components/CartDrawer': './src/lib/components/CartDrawer.tsx',
        'lib/components/CartIcon': './src/lib/components/CartIcon.tsx',
        'lib/components/CurrencySwitcher':
          './src/lib/components/CurrencySwitcher.tsx',
        'lib/components/Checkout': './src/lib/components/Checkout.tsx',
        'lib/components/FeaturedProduct':
          './src/lib/components/FeaturedProduct.tsx',
        'lib/components/ProductGrid': './src/lib/components/ProductGrid.tsx',
        'lib/components/ProductDetailsLayout':
          './src/lib/components/ProductDetailsLayout.tsx',
        'lib/components/SimpleTiptapRenderer':
          './src/lib/components/SimpleTiptapRenderer.tsx',
      },
      name: 'ecommerce',
      fileName: (format, entryName) => `${entryName}.${format}.js`,
      formats: ['es', 'cjs'],
    },
    rolldownOptions: {
      output: {
        // One file per source module (mirroring src/) so 'use client'/'use server' modules
        // stay separate and the consuming RSC bundler can split them — no cross-boundary
        // shared chunks. dist/index.es.js + dist/server.es.js at root; the rest under
        // dist/lib/* (and .d.ts mirrors it via entryRoot 'src').
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
      external: (id) => {
        // Bundle only our own source; externalize every bare specifier (react, next/*,
        // @nextblock-cms/*, @supabase/*, stripe, zod, zustand, react-hook-form, @freemius/*,
        // ...) so preserveModules keeps them as bare imports and the consuming app resolves
        // each in the correct (client vs server) condition. The published package.json
        // declares these as dependencies.
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
