import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../dist/libs/cortex');
const SRC_DIR = path.resolve(__dirname, 'src');

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
      // monorepo and nowhere else. Consumers compile with skipLibCheck, so nothing failed;
      // every type that mentioned a sibling library was silently `any`.
      aliasesExclude: [new RegExp('^@nextblock-cms/')],
      outDir: '../../dist/libs/cortex',
      afterBuild: reapplyDirectives,
    }),
    react(),
  ],
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        client: './src/client.ts',
        index: './src/index.ts',
      },
      name: 'cortex',
      fileName: (format, entryName) => `${entryName}.${format}.js`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
      external: (id) => {
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
