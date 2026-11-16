import path from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// apps/nextblock/app/providers.tsx imports TranslationsProvider from the deep subpath
// `@nextblock-cms/utils/translations-context`: the utils barrel would put the authored-HTML
// sanitizer in the root layout's chunk on every page (tools/scripts/root-layout-chunking.test.ts).
// Two scripts rewrite that file: the template sync (`ensureClientTranslations`) and the CLI at
// scaffold time (`ensureClientProviders`). Each used to insert
// `import { TranslationsProvider } from '@nextblock-cms/utils';` whenever it did not find that
// exact line, which beside the deep import is a second binding of the same name: every new
// project would fail to compile. This replays both functions, from their source, on the real file.

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROVIDERS = 'apps/nextblock/app/providers.tsx';
const SYNC = { file: 'apps/create-nextblock/scripts/sync-template.js', name: 'ensureClientTranslations' };
const CLI = { file: 'apps/create-nextblock/bin/create-nextblock.js', name: 'ensureClientProviders' };
const PROJECT_DIR = '/project';

/** A function declaration's source text, as written in `file`. */
function functionSource(file: string, name: string) {
  const sourcePath = path.join(REPO_ROOT, file);
  const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) throw new Error(`template-providers-import: ${file} has no function ${name} (renamed? update this test)`);
  return declaration.getText(source);
}

/** Runs one rewriter on `content` as the project's app/providers.tsx, with an in-memory fs. */
async function rewrite({ file, name }: { file: string; name: string }, content: string) {
  const files = new Map<string, string>([[path.posix.join(PROJECT_DIR, 'app/providers.tsx'), content]]);
  const fs = {
    pathExists: async (target: string) => files.has(target),
    readFile: async (target: string) => {
      const value = files.get(target);
      if (value === undefined) throw new Error(`ENOENT: ${target}`);
      return value;
    },
    writeFile: async (target: string, value: string) => {
      files.set(target, String(value));
    },
    remove: async (target: string) => {
      files.delete(target);
    },
  };
  // The sync reads the template directory from TARGET_DIR; the CLI takes the project directory.
  const run = vm.runInNewContext(`(${functionSource(file, name)})`, {
    fs,
    resolve: (...segments: string[]) => path.posix.join(...segments),
    TARGET_DIR: PROJECT_DIR,
  }) as (projectDir?: string) => Promise<void>;
  await run(PROJECT_DIR);
  return files.get(path.posix.join(PROJECT_DIR, 'app/providers.tsx')) ?? '';
}

const translationsProviderImports = (content: string) =>
  [...content.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .filter(([, names]) => /\bTranslationsProvider\b/.test(names))
    .map(([, , from]) => from);

describe('the template and the CLI keep the TranslationsProvider import of app/providers.tsx', () => {
  const providers = readFileSync(path.join(REPO_ROOT, PROVIDERS), 'utf8');

  it('starts from one deep import in the app', () => {
    expect(translationsProviderImports(providers)).toEqual(['@nextblock-cms/utils/translations-context']);
  });

  it.each([
    ['the template sync', [SYNC]],
    ['the CLI on its own', [CLI]],
    ['the sync, then the CLI at scaffold time', [SYNC, CLI]],
  ])('%s leaves exactly one import, never the utils barrel', async (_label, steps) => {
    let content = providers;
    for (const step of steps) content = await rewrite(step, content);
    expect(translationsProviderImports(content)).toEqual(['@nextblock-cms/utils/translations-context']);
  });
});
