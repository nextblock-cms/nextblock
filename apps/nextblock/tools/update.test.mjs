import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { addPostcssBrowserAlias } from './lib/postcss-browser-alias.mjs';

// `npm run update` on a standalone project that is already on the latest release. That is the run
// that has to add the postcss browser alias: an update runs the updater already on disk, so the one
// that brings a 0.23.3 project to 0.23.4 (and lib/browser-stubs/postcss.cjs) is the 0.23.3 updater,
// which never edits next.config.js. These run the real update.mjs in a temp project, with an `npm`
// on PATH that only answers `npm view` and an environment holding no database settings; --skip-db
// keeps the schema step out of it.

const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = path.join(here, 'update.mjs');
// Newer than anything on npm, so even a real `npm view` would take the "already up to date" path.
const VERSION = '99.0.0';
const SCAFFOLD_0_23_3 = readFileSync(path.join(here, 'lib/__fixtures__/scaffold-0.23.3.next.config.txt'), 'utf8').replace(/\r\n/g, '\n');
const KEEP_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
// Each run starts Node and git; the default 5 s is too tight for two of them on a busy machine.
const SPAWNS = { timeout: 60_000 };
// `npm view` answers VERSION. `npm install create-nextblock@<v>` stages that package's template for a
// test that sets one: FAKE_TEMPLATE_DIRS[<v>] (a JSON map from version to folder, for a 3-way merge,
// which stages the release the project is on as its base) or else FAKE_TEMPLATE_DIR. Any other
// `npm install` succeeds only for a test that sets FAKE_NPM_INSTALL; anything else fails, so a run
// that reached a command it should not would show up as an error.
const FAKE_NPM = `import { cpSync } from 'node:fs';
import path from 'node:path';
const [command, spec = ''] = process.argv.slice(2);
const template = spec.startsWith('create-nextblock@')
  ? (JSON.parse(process.env.FAKE_TEMPLATE_DIRS || '{}')[spec.slice('create-nextblock@'.length)] ?? process.env.FAKE_TEMPLATE_DIR)
  : undefined;
if (command === 'view') console.log('${VERSION}');
else if (command === 'install' && template) {
  cpSync(template, path.join('node_modules', 'create-nextblock', 'templates', 'nextblock-template'), { recursive: true });
} else if (!(command === 'install' && process.env.FAKE_NPM_INSTALL === '1')) process.exitCode = 1;
`;
// Preloaded with --require: answers the git commands updateCodeViaGit runs inside the updater, so no
// git starts, no repository or commit is needed and nothing reaches the network. FAKE_GIT_BEHIND is
// the upstream commit count; `git merge` copies FAKE_GIT_MERGE over the checkout; `git grep` finds
// FAKE_GIT_CONFLICTS, the files that still hold an update's conflict markers. Any other git command
// fails, so a run that reached one would show up as an error.
const FAKE_GIT = `const childProcess = require('node:child_process');
const { cpSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args = [], options = {}) => {
  if (command !== 'git') return realSpawnSync(command, args, options);
  const reply = (stdout, status = 0) => ({ pid: 0, status, signal: null, output: [null, stdout, ''], stdout: options.encoding ? stdout : Buffer.from(stdout), stderr: options.encoding ? '' : Buffer.alloc(0) });
  const line = args.join(' ');
  if (line === 'rev-parse --show-toplevel') return reply(options.cwd);
  if (line === 'remote get-url origin') return reply(process.env.FAKE_GIT_ORIGIN);
  if (line === 'remote get-url upstream') return reply('https://github.com/nextblock-cms/nextblock.git');
  if (line === 'status --porcelain') return reply('');
  if (line === 'rev-parse --abbrev-ref HEAD') return reply('master');
  if (args[0] === 'fetch') return reply('');
  if (args[0] === 'rev-list') return reply(process.env.FAKE_GIT_BEHIND);
  if (args[0] === 'merge' && process.env.FAKE_GIT_MERGE) {
    cpSync(process.env.FAKE_GIT_MERGE, options.cwd, { recursive: true });
    return reply('');
  }
  if (args[0] === 'grep' && process.env.FAKE_GIT_CONFLICTS) return reply(process.env.FAKE_GIT_CONFLICTS);
  return reply('', 1);
};
// update.mjs imports spawnSync by name, so its ESM binding has to see the replacement.
syncBuiltinESMExports();
`;

const roots = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bin folder with an `npm` that runs FAKE_NPM on this Node, and the FAKE_GIT preload. */
function makeBin(root) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'fake-npm.mjs'), FAKE_NPM);
  writeFileSync(path.join(bin, 'fake-git.cjs'), FAKE_GIT);
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.mjs" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.mjs" "$@"\n`);
    chmodSync(path.join(bin, 'npm'), 0o755);
  }
  return bin;
}

/** A standalone project on VERSION, with the stub and the given next.config.js, plus a fake npm. */
function makeProject(nextConfig, packageJson = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nb-update-alias-'));
  roots.push(root);
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'lib', 'browser-stubs'), { recursive: true });
  writeFileSync(path.join(project, 'lib', 'browser-stubs', 'postcss.cjs'), 'module.exports = {};\n');
  const pkg = { name: 'site', private: true, nextblock: { version: VERSION }, ...packageJson };
  writeFileSync(path.join(project, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(path.join(project, 'next.config.js'), nextConfig);
  return { project, bin: makeBin(root) };
}

/**
 * Runs update.mjs in `project` (its cwd); `nodeArgs` go to Node before the script (the git preload).
 * `script` is the updater to run: the repository's, unless the site carries a copy of its own. The
 * run gets --skip-db unless the site runs the schema step on a fake engine (`schema: true`).
 */
function runUpdate({ project, bin, script = UPDATE_SCRIPT, schema = false }, flags = [], extraEnv = {}, nodeArgs = []) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (KEEP_ENV.has(key.toUpperCase())) env[key] = value;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  const res = spawnSync(process.execPath, [...nodeArgs, script, ...(schema ? [] : ['--skip-db']), ...flags], {
    cwd: project,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

const nextConfigOf = ({ project }) => readFileSync(path.join(project, 'next.config.js'), 'utf8');
const backupsOf = ({ project }) => {
  const dir = path.join(project, '.nextblock-backup');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name !== '.gitignore') : [];
};

describe('npm run update on a project already on the latest release', () => {
  it('adds the postcss browser alias to a 0.23.3 next.config.js once, and a second run changes nothing', SPAWNS, () => {
    const site = makeProject(SCAFFOLD_0_23_3);

    const first = runUpdate(site);
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain('next.config.js: added the postcss browser alias to turbopack.resolveAlias');
    expect(first.output).toContain('Code is already up to date.');
    expect(nextConfigOf(site)).toBe(addPostcssBrowserAlias(SCAFFOLD_0_23_3).text);
    const backups = backupsOf(site);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(site.project, '.nextblock-backup', backups[0], 'next.config.js'), 'utf8')).toBe(SCAFFOLD_0_23_3);

    const patched = nextConfigOf(site);
    const second = runUpdate(site);
    expect(second.status, second.output).toBe(0);
    expect(second.output).not.toContain('postcss browser alias');
    expect(nextConfigOf(site)).toBe(patched);
    expect(backupsOf(site)).toEqual(backups);
  });

  it('reports the edit under --check and writes nothing', SPAWNS, () => {
    const site = makeProject(SCAFFOLD_0_23_3);

    const check = runUpdate(site, ['--check']);
    expect(check.status, check.output).toBe(0);
    expect(check.output).toContain('would add the postcss browser alias to next.config.js (turbopack.resolveAlias)');
    expect(nextConfigOf(site)).toBe(SCAFFOLD_0_23_3);
    expect(existsSync(path.join(site.project, '.nextblock-backup'))).toBe(false);
  });

  it('prints the entry to add, and leaves the file alone, when next.config.js has no safe anchor', SPAWNS, () => {
    const config = 'module.exports = {\n  reactStrictMode: true,\n};\n';
    const site = makeProject(config);

    const run = runUpdate(site);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('next.config.js has no postcss browser alias, and this update cannot add one safely');
    expect(run.output).toContain("postcss: { browser: './lib/browser-stubs/postcss.cjs' },");
    expect(nextConfigOf(site)).toBe(config);
    expect(existsSync(path.join(site.project, '.nextblock-backup'))).toBe(false);
  });

  it('adds it after the install, next to the transpilePackages check, when the run also moves an override', SPAWNS, () => {
    // An override still on an earlier NextBlock default moves, so the run installs; the alias then
    // comes from main()'s post-install step, once (not also from the "already up to date" branch).
    const site = makeProject(SCAFFOLD_0_23_3, { overrides: { postcss: '^8.5.12' }, devDependencies: { postcss: '^8.5.12' } });

    const run = runUpdate(site, [], { FAKE_NPM_INSTALL: '1' });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('overrides.postcss ^8.5.12');
    expect(run.output).toContain('Dependencies installed.');
    expect(run.output.split('added the postcss browser alias')).toHaveLength(2);
    expect(run.output.indexOf('added the postcss browser alias')).toBeGreaterThan(run.output.indexOf('Dependencies installed.'));
    expect(nextConfigOf(site)).toBe(addPostcssBrowserAlias(SCAFFOLD_0_23_3).text);
    expect(backupsOf(site)).toHaveLength(1);
  });

  it('prints the "add it by hand" warning once on a run that moves an override and installs', SPAWNS, () => {
    const config = 'module.exports = {\n  reactStrictMode: true,\n};\n';
    const site = makeProject(config, { overrides: { postcss: '^8.5.12' }, devDependencies: { postcss: '^8.5.12' } });

    const run = runUpdate(site, [], { FAKE_NPM_INSTALL: '1' });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Dependencies installed.');
    expect(run.output.split('this update cannot add one safely')).toHaveLength(2);
    expect(nextConfigOf(site)).toBe(config);
  });
});

describe('npm run update on a project a release behind', () => {
  it("refreshes proxy.ts and leaves the project's proxy.test.ts alone", SPAWNS, () => {
    // No updater has refreshed proxy.test.ts, so a project keeps the copy it was scaffolded with.
    // Listed, it would make the first 3-way merge read that copy as an edit, conflict and hold the
    // migrations, over a file nothing in a standalone project builds or runs.
    const site = makeProject(addPostcssBrowserAlias(SCAFFOLD_0_23_3).text, { nextblock: { version: '98.0.0' } });
    writeFileSync(path.join(site.project, 'proxy.ts'), '// proxy 98\n');
    writeFileSync(path.join(site.project, 'proxy.test.ts'), '// proxy test 98\n');
    const template = path.join(path.dirname(site.project), 'template');
    mkdirSync(template);
    writeFileSync(path.join(template, 'package.json'), '{}\n');
    writeFileSync(path.join(template, 'proxy.ts'), '// proxy 99\n');
    writeFileSync(path.join(template, 'proxy.test.ts'), '// proxy test 99\n');

    const run = runUpdate(site, ['--yes'], { FAKE_NPM_INSTALL: '1', FAKE_TEMPLATE_DIR: template });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('0 new file(s), 1 file(s) to update.');
    expect(readFileSync(path.join(site.project, 'proxy.ts'), 'utf8')).toBe('// proxy 99\n');
    expect(readFileSync(path.join(site.project, 'proxy.test.ts'), 'utf8')).toBe('// proxy test 98\n');
  });

  it('brings instrumentation.ts and .browserslistrc to a project scaffolded before the updater listed them', SPAWNS, () => {
    // Off FRAMEWORK_PATHS through 0.23.5: a project updated into 0.23.4 never got the
    // instrumentation hook that registers the CMS second-factor gate on a cold server.
    const site = makeProject(addPostcssBrowserAlias(SCAFFOLD_0_23_3).text, { nextblock: { version: '98.0.0' } });
    const template = path.join(path.dirname(site.project), 'template');
    mkdirSync(template);
    writeFileSync(path.join(template, 'package.json'), '{}\n');
    writeFileSync(path.join(template, 'instrumentation.ts'), 'export async function register() {}\n');
    writeFileSync(path.join(template, '.browserslistrc'), 'chrome >= 109\n');

    const run = runUpdate(site, ['--yes'], { FAKE_NPM_INSTALL: '1', FAKE_TEMPLATE_DIR: template });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('2 new file(s), 0 file(s) to update.');
    expect(readFileSync(path.join(site.project, 'instrumentation.ts'), 'utf8')).toBe('export async function register() {}\n');
    expect(readFileSync(path.join(site.project, '.browserslistrc'), 'utf8')).toBe('chrome >= 109\n');
  });
});

// Since 0.23.4 the CMS opens only the editors app/cms/blocks/components/blockEditorLoaders.ts maps
// (or a definition's own EditorComponent); through 0.23.3 it opened any module in
// app/cms/blocks/editors by its registry editorComponentFilename. A project that added its own
// editor there (docs/07) gets no conflict from the update, only a CMS that opens nothing for that
// block, and it has no vitest to run blockEditorLoaders.test.ts, so the update names each editor
// the registry names and the map lacks.
// A project already on the latest release runs the check too: the update that brought it 0.23.4
// ran the 0.23.3 updater, which has none (docs/13 asks for one more run after it).
const REGISTRY_FILE = path.join('lib', 'blocks', 'blockRegistry.ts');
const EDITORS_DIR = path.join('app', 'cms', 'blocks', 'editors');
const LOADERS_FILE = path.join('app', 'cms', 'blocks', 'components', 'blockEditorLoaders.ts');
const WARNING = 'missing from BLOCK_EDITOR_LOADERS';

/** Each line the warning says to add, as printed. */
const suggestionsIn = (output) => [...output.matchAll(/^ *(.+: \(\) => import\('\.\.\/editors\/.+'\),)$/gm)].map((match) => match[1]);
const loaderKeyOf = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);
/** A registry with one block per editorComponentFilename. */
const registrySource = (filenames) =>
  `export const blockRegistry = {\n${filenames.map((filename, i) => `  block_${i}: { label: 'Block ${i}', editorComponentFilename: '${filename}' },`).join('\n')}\n};\n`;
/** A blockEditorLoaders.ts mapping `names`, written the way the shipped one is. */
const loadersSource = (names) =>
  `const BLOCK_EDITOR_LOADERS = {\n${names.map((name) => `  ${loaderKeyOf(name)}: () => import('../editors/${name}'),`).join('\n')}\n} satisfies Record<string, () => Promise<unknown>>;\n`;
const editorFiles = (names, extension = '.tsx') =>
  Object.fromEntries(
    names.map((name) => [path.join(EDITORS_DIR, ...`${name}${extension}`.split('/')), `export default function ${name.replace(/\W/g, '_')}() {\n  return null;\n}\n`]),
  );
/** What TypeScript reports when `line` is written into BLOCK_EDITOR_LOADERS: [] when it parses. */
const parseErrorsOf = (line) =>
  (ts.transpileModule(`const BLOCK_EDITOR_LOADERS = {\n  ${line}\n};\n`, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } }).diagnostics ?? []).map(
    (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );

describe('npm run update and block editors BLOCK_EDITOR_LOADERS does not list', () => {
  const APP_DIR = path.resolve(here, '..');
  // Already has the alias, so that step stays quiet.
  const NEXT_CONFIG = addPostcssBrowserAlias(SCAFFOLD_0_23_3).text;
  const REGISTRY_ANCHOR = 'export const blockRegistry: Record<BlockType, BlockDefinition> = {';

  /** The registry, the editors and the map NextBlock ships, copied into `project`. */
  function shipNextBlockFiles(project) {
    cpSync(path.join(APP_DIR, EDITORS_DIR), path.join(project, EDITORS_DIR), { recursive: true });
    for (const file of [REGISTRY_FILE, LOADERS_FILE]) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      copyFileSync(path.join(APP_DIR, file), path.join(project, file));
    }
  }
  /** Adds block definitions of the project's own at the top of the shipped registry. */
  function registerBlocks(project, entries) {
    const file = path.join(project, REGISTRY_FILE);
    const registry = readFileSync(file, 'utf8');
    expect(registry).toContain(REGISTRY_ANCHOR);
    writeFileSync(file, registry.replace(REGISTRY_ANCHOR, [REGISTRY_ANCHOR, ...entries.map((entry) => `  ${entry}`)].join('\r\n')));
  }

  it('names each editor the registry names and the map lacks, once, with a line that parses and maps it', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    writeFiles(site.project, {
      [REGISTRY_FILE]: [
        registrySource([
          'TextBlockEditor.tsx',
          'FaqBlockEditor.tsx',
          'FaqBlockEditor', // a second block on the same editor
          'faq-block-editor.tsx',
          'faq/FaqBlockEditor.tsx',
          'LegacyBanner.tsx', // the module is LegacyBanner.jsx, which import('../editors/LegacyBanner') finds
          'CartBlockEditor.tsx', // no such file, as in the shipped registry: nothing to open
          // Test, spec, story and declaration files: mapping one would bundle it into the CMS, as
          // the test file that pulled vitest into 0.23.0's did.
          'RetiredBlockEditor.test.tsx',
          'FaqBlockEditor.spec.tsx',
          'FaqBlockEditor.stories.tsx',
          'FaqBlockEditor.story.tsx',
          'Legacy.d.ts',
          '../outside/Stray.tsx', // not a path under app/cms/blocks/editors
        ]),
        // A template literal without a substitution is a string too.
        'export const templated = { tpl: { label: `Tpl`, editorComponentFilename: `TplBlockEditor.tsx` } };',
        // Neither registers an editor: a commented-out entry, and a read of the field.
        "// export const legacy = { editorComponentFilename: 'OldBlockEditor.tsx' };",
        "export const editorOf = (definition) => (definition ? definition.editorComponentFilename : 'StrayBlockEditor.tsx');",
        '',
      ].join('\n'),
      [LOADERS_FILE]: loadersSource(['TextBlockEditor']),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor', 'faq-block-editor', 'faq/FaqBlockEditor', 'TplBlockEditor', 'OldBlockEditor', 'StrayBlockEditor']),
      ...editorFiles(['RetiredBlockEditor.test', 'FaqBlockEditor.spec', 'FaqBlockEditor.stories', 'FaqBlockEditor.story']),
      ...editorFiles(['Legacy.d'], '.ts'),
      [path.join('app', 'cms', 'blocks', 'outside', 'Stray.tsx')]: 'export default function Stray() {\n  return null;\n}\n',
      ...editorFiles(['LegacyBanner'], '.jsx'),
      ...editorFiles(['ColorFieldEditor']), // a helper no registry entry names
    });

    const run = runUpdate(site);
    expect(run.status, run.output).toBe(0);
    expect(run.output.split(WARNING)).toHaveLength(2);
    expect(run.output).toContain('5 block editors in app/cms/blocks/editors are named in lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS');
    expect(run.output).toContain('Add these lines to BLOCK_EDITOR_LOADERS in app/cms/blocks/components/blockEditorLoaders.ts:');
    const suggested = suggestionsIn(run.output);
    expect([...suggested].sort()).toEqual([
      "'faq-block-editor': () => import('../editors/faq-block-editor'),",
      "'faq/FaqBlockEditor': () => import('../editors/faq/FaqBlockEditor'),",
      "FaqBlockEditor: () => import('../editors/FaqBlockEditor'),",
      "LegacyBanner: () => import('../editors/LegacyBanner'),",
      "TplBlockEditor: () => import('../editors/TplBlockEditor'),",
    ]);
    for (const line of suggested) expect(parseErrorsOf(line), line).toEqual([]);
    expect(run.output).toContain('Code is already up to date.');

    // Pasted into the map, the lines map their editors: with all but the last, only it is left.
    const mapWith = (lines) =>
      `const BLOCK_EDITOR_LOADERS = {\n  TextBlockEditor: () => import('../editors/TextBlockEditor'),\n${lines.map((line) => `  ${line}\n`).join('')}};\n`;
    expect(suggested.at(-1)).toBe("'faq/FaqBlockEditor': () => import('../editors/faq/FaqBlockEditor'),");
    writeFiles(site.project, { [LOADERS_FILE]: mapWith(suggested.slice(0, -1)) });
    const partly = runUpdate(site);
    expect(partly.status, partly.output).toBe(0);
    expect(suggestionsIn(partly.output)).toEqual(suggested.slice(-1));
    writeFiles(site.project, { [LOADERS_FILE]: mapWith(suggested) });
    const done = runUpdate(site);
    expect(done.status, done.output).toBe(0);
    expect(done.output).not.toContain('BLOCK_EDITOR_LOADERS');
  });

  it('reads the map as written: quoted and multi-line entries count, commented-out ones and other objects do not', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    const names = ['TextBlockEditor', 'FaqBlockEditor', 'HeadingBlockEditor', 'HeroBlockEditor', 'OldBlockEditor', 'GalleryBlockEditor'];
    writeFiles(site.project, {
      [REGISTRY_FILE]: registrySource(names.map((name) => `${name}.tsx`)),
      [LOADERS_FILE]: [
        '// BLOCK_EDITOR_LOADERS = { OldBlockEditor } in an older shape.',
        'const BLOCK_EDITOR_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {',
        "  TextBlockEditor: () => import('../editors/TextBlockEditor'), 'FaqBlockEditor': () =>",
        "    import('../editors/FaqBlockEditor').then((m) => ({ default: m.default }), () => { throw new Error('no }, here'); }),",
        "  \"HeadingBlockEditor\": () => import('../editors/HeadingBlockEditor'), // the old map closed here: }",
        // Commented out, each behind the comma and before the colon a key regex would look for.
        "  // retired, OldBlockEditor: () => import('../editors/OldBlockEditor'),",
        "  /* a, HeroBlockEditor: () => import('../editors/HeroBlockEditor') */",
        // A string continued over a CRLF line break, as an editor on Windows saves it.
        "  GalleryBlockEditor: () => import('../editors/GalleryBlockEditor').catch(() => { throw new Error('split by a \\",
        "line continuation'); }),",
        '};',
        "export const RETIRED = { OldBlockEditor: 'a key outside the map lists nothing' };",
        // A regular expression with a quote, inside a template substitution, is not a string.
        "export const quoted = (text) => `'${text.replace(/['\\\\]/g, (c) => `\\\\${c}`)}'`;",
        '',
      ].join('\r\n'),
      ...editorFiles(names),
    });

    const run = runUpdate(site);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('2 block editors in app/cms/blocks/editors are named in lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS');
    expect(suggestionsIn(run.output)).toEqual([
      "HeroBlockEditor: () => import('../editors/HeroBlockEditor'),",
      "OldBlockEditor: () => import('../editors/OldBlockEditor'),",
    ]);
  });

  it('says nothing when every editor is listed, or when it cannot tell: a map entry it cannot read, no map, no registry, no editors folder', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    const loaders = path.join(site.project, LOADERS_FILE);
    const registry = path.join(site.project, REGISTRY_FILE);
    writeFiles(site.project, {
      [REGISTRY_FILE]: registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']),
      [LOADERS_FILE]: loadersSource(['TextBlockEditor', 'FaqBlockEditor']),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor']),
    });
    const quiet = (label) => {
      const run = runUpdate(site);
      expect(run.status, `${label}\n${run.output}`).toBe(0);
      expect(run.output, label).toContain('Code is already up to date.');
      expect(run.output, label).not.toContain('BLOCK_EDITOR_LOADERS');
    };

    quiet('every editor listed');
    // An entry that is not `key: value` can add the editor in a way the update cannot read.
    for (const [label, entry] of [
      ['a spread', '  ...PROJECT_EDITOR_LOADERS,'],
      ['a shorthand', '  FaqBlockEditor,'],
      ['a method', "  FaqBlockEditor() { return import('../editors/FaqBlockEditor'); },"],
    ]) {
      writeFileSync(loaders, `const BLOCK_EDITOR_LOADERS = {\n${entry}\n  TextBlockEditor: () => import('../editors/TextBlockEditor'),\n};\n`);
      quiet(label);
    }
    writeFileSync(loaders, "export { default } from './somewhere-else';\n");
    quiet('no map in the file');
    writeFileSync(loaders, loadersSource(['TextBlockEditor']));
    writeFileSync(registry, "export const blockRegistry = {\n  faq: { editorComponentFilename: 'FaqBlockEditor.tsx', label: 'unterminated },\n};\n");
    quiet('a registry it cannot read');
    rmSync(registry);
    quiet('no registry');
    writeFileSync(registry, registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']));
    rmSync(loaders);
    quiet('no map: a project before 0.23.4 opens its editors by name');
    writeFileSync(loaders, loadersSource(['TextBlockEditor']));
    rmSync(path.join(site.project, EDITORS_DIR), { recursive: true });
    quiet('no editors folder');
  });

  it('says nothing for the registry, editors and map NextBlock ships, and reads all three', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    shipNextBlockFiles(site.project);
    expect(readdirSync(path.join(site.project, EDITORS_DIR))).toEqual(
      expect.arrayContaining(['DynamicCustomBlockEditor.tsx', 'SectionBlockEditor.tsx', 'SectionBlockEditor.test.tsx', 'TextBlockEditor.tsx']),
    );

    // Quiet, although the registry names editor files that do not exist (cart, checkout, …).
    const shipped = runUpdate(site);
    expect(shipped.status, shipped.output).toBe(0);
    expect(shipped.output).not.toContain('BLOCK_EDITOR_LOADERS');

    // A block of the project's own: only its editor is named, so every shipped one was read as listed.
    registerBlocks(site.project, ["faq: { editorComponentFilename: 'FaqBlockEditor.tsx' } as BlockDefinition,"]);
    writeFiles(site.project, editorFiles(['FaqBlockEditor']));
    const added = runUpdate(site);
    expect(added.status, added.output).toBe(0);
    expect(added.output).toContain('1 block editor in app/cms/blocks/editors is named in lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS');
    expect(added.output).toContain('Add this line to BLOCK_EDITOR_LOADERS');
    expect(suggestionsIn(added.output)).toEqual(["FaqBlockEditor: () => import('../editors/FaqBlockEditor'),"]);

    // And the shipped registry is read: a shipped editor the map loses is named too.
    const loaders = path.join(site.project, LOADERS_FILE);
    const map = readFileSync(loaders, 'utf8');
    const textEntry = /^ {2}TextBlockEditor: \(\) => import\('\.\.\/editors\/TextBlockEditor'\),\r?\n/m;
    expect(map).toMatch(textEntry);
    writeFileSync(loaders, map.replace(textEntry, ''));
    const lost = runUpdate(site);
    expect(lost.status, lost.output).toBe(0);
    expect(suggestionsIn(lost.output)).toEqual([
      "FaqBlockEditor: () => import('../editors/FaqBlockEditor'),",
      "TextBlockEditor: () => import('../editors/TextBlockEditor'),",
    ]);
  });

  it('says nothing for a block whose definition sets EditorComponent, which the CMS opens instead of the file', SPAWNS, () => {
    // EditableBlock and ColumnEditor open a definition's EditorComponent before they look up its
    // editorComponentFilename (the shipped testimonial works that way), so that file needs no entry.
    const site = makeProject(NEXT_CONFIG);
    shipNextBlockFiles(site.project);
    registerBlocks(site.project, [
      "faq: { ...FaqBlockConfig, editorComponentFilename: 'FaqBlockEditor.tsx', EditorComponent: FaqBlockEditor } as BlockDefinition,",
    ]);
    writeFiles(site.project, editorFiles(['FaqBlockEditor']));
    const own = runUpdate(site);
    expect(own.status, own.output).toBe(0);
    expect(own.output).not.toContain('BLOCK_EDITOR_LOADERS');
    expect(own.output).toContain('Code is already up to date.');

    // Only a member of the definition's own object literal counts, in any order, as a shorthand, a
    // quoted key or a method, generic ones included (a comma in the type parameters splits them across
    // two members). One nested deeper, set to undefined or null, possibly inside a spread, or only named
    // in a type (split at the comma of `Map<string, EditorComponent>` or of
    // `Map<string, EditorComponent<Props>>`, whose `>` is followed by no `(`) leaves the file to open.
    registerBlocks(site.project, [
      "quote: { EditorComponent: QuoteBlockEditor, label: 'Quote', editorComponentFilename: 'QuoteBlockEditor.tsx' } as BlockDefinition,",
      "gallery: { editorComponentFilename: 'GalleryBlockEditor.tsx', EditorComponent } as BlockDefinition,",
      "quoted: { editorComponentFilename: 'QuotedBlockEditor.tsx', 'EditorComponent': QuotedBlockEditor } as BlockDefinition,",
      "method: { editorComponentFilename: 'MethodBlockEditor.tsx', EditorComponent() { return null; } } as BlockDefinition,",
      "typed: { editorComponentFilename: 'TypedBlockEditor.tsx', EditorComponent<T>() { return null; } } as BlockDefinition,",
      "constrained: { editorComponentFilename: 'ConstrainedBlockEditor.tsx', EditorComponent<T extends Record<string, unknown>>(props: T) { return null; } } as BlockDefinition,",
      "map: { editorComponentFilename: 'MapBlockEditor.tsx', documentation: { EditorComponent: 'a field of another object' } } as BlockDefinition,",
      "poll: { editorComponentFilename: 'PollBlockEditor.tsx', EditorComponent: undefined } as BlockDefinition,",
      "nil: { editorComponentFilename: 'NilBlockEditor.tsx', EditorComponent: null } as BlockDefinition,",
      "promo: { ...PromoBlockConfig, editorComponentFilename: 'PromoBlockEditor.tsx' } as BlockDefinition,",
      "generic: { initialContent: {} as Map<string, EditorComponent>, editorComponentFilename: 'GenericBlockEditor.tsx' } as BlockDefinition,",
      "nested: { initialContent: {} as Map<string, EditorComponent<Props>>, editorComponentFilename: 'NestedBlockEditor.tsx' } as BlockDefinition,",
    ]);
    writeFiles(
      site.project,
      editorFiles([
        'QuoteBlockEditor',
        'GalleryBlockEditor',
        'QuotedBlockEditor',
        'MethodBlockEditor',
        'TypedBlockEditor',
        'ConstrainedBlockEditor',
        'MapBlockEditor',
        'PollBlockEditor',
        'NilBlockEditor',
        'PromoBlockEditor',
        'GenericBlockEditor',
        'NestedBlockEditor',
      ]),
    );
    const mixed = runUpdate(site);
    expect(mixed.status, mixed.output).toBe(0);
    expect(mixed.output).toContain('6 block editors in app/cms/blocks/editors are named in lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS');
    expect(suggestionsIn(mixed.output)).toEqual([
      "GenericBlockEditor: () => import('../editors/GenericBlockEditor'),",
      "MapBlockEditor: () => import('../editors/MapBlockEditor'),",
      "NestedBlockEditor: () => import('../editors/NestedBlockEditor'),",
      "NilBlockEditor: () => import('../editors/NilBlockEditor'),",
      "PollBlockEditor: () => import('../editors/PollBlockEditor'),",
      "PromoBlockEditor: () => import('../editors/PromoBlockEditor'),",
    ]);
  });

  it('warns once on a run that updates the code, after the files land and before package.json', SPAWNS, () => {
    // A release behind; the staged release brings the loader map, which lacks the project's editor.
    // It ships no registry, so the project's stays with its entry, as a 3-way merge keeps that entry.
    const site = makeProject(NEXT_CONFIG, { nextblock: { version: '98.0.0' } });
    writeFiles(site.project, { [REGISTRY_FILE]: registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']), ...editorFiles(['FaqBlockEditor']) });
    const template = path.join(path.dirname(site.project), 'template');
    writeFiles(template, { 'package.json': '{}\n', [LOADERS_FILE]: loadersSource(['TextBlockEditor']), ...editorFiles(['TextBlockEditor']) });

    const run = runUpdate(site, ['--yes'], { FAKE_NPM_INSTALL: '1', FAKE_TEMPLATE_DIR: template });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/Applied\.|Merged 99\.0\.0 into/);
    expect(readFileSync(path.join(site.project, LOADERS_FILE), 'utf8')).toBe(loadersSource(['TextBlockEditor']));
    expect(run.output.split(WARNING)).toHaveLength(2);
    expect(run.output).toContain("FaqBlockEditor: () => import('../editors/FaqBlockEditor'),");
    const warned = run.output.indexOf(WARNING);
    expect(warned).toBeGreaterThan(run.output.indexOf('Reviewing changes'));
    expect(warned).toBeLessThan(run.output.indexOf('Updating package.json'));
    expect(run.output).toContain('Dependencies installed.');
    expect(JSON.parse(readFileSync(path.join(site.project, 'package.json'), 'utf8')).nextblock.version).toBe(VERSION);
  });

  it('costs one line, never the update, when reading a file fails', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    writeFiles(site.project, { [REGISTRY_FILE]: registrySource(['FaqBlockEditor.tsx']), ...editorFiles(['FaqBlockEditor']) });
    mkdirSync(path.join(site.project, LOADERS_FILE), { recursive: true }); // a folder where the file goes: reading it throws

    const run = runUpdate(site);
    expect(run.status, run.output).toBe(0);
    expect(run.output.split('Could not check the block editors against BLOCK_EDITOR_LOADERS')).toHaveLength(2);
    expect(run.output).not.toContain(WARNING);
    expect(run.output).toContain('Code is already up to date.');
  });

  it('asks, in one line, for a merge conflict in the map or the registry to be resolved first', SPAWNS, () => {
    // The project appended its line where the next release appended one, or both inserted a line at
    // the same place mid-map: git merge-file leaves one hunk, and the keys around it are no map.
    const hunk = (ours, theirs, newline = '\n') =>
      ['<<<<<<< your version', `  ${ours}`, '=======', `  ${theirs}`, '>>>>>>> NextBlock 0.23.5', ''].join(newline);
    const faqLoader = "FaqBlockEditor: () => import('../editors/FaqBlockEditor'),";
    const widgetLoader = "WidgetBlockEditor: () => import('../editors/WidgetBlockEditor'),";
    const loadersConflict =
      'app/cms/blocks/components/blockEditorLoaders.ts has a merge conflict, so the block editors were not checked: ' +
      'resolve the conflict in that file, then run npm run update again.';
    const site = makeProject(NEXT_CONFIG);
    shipNextBlockFiles(site.project);
    registerBlocks(site.project, [
      "faq: { editorComponentFilename: 'FaqBlockEditor.tsx' } as BlockDefinition,",
      "widget: { editorComponentFilename: 'WidgetBlockEditor.tsx' } as BlockDefinition,",
    ]);
    writeFiles(site.project, editorFiles(['FaqBlockEditor', 'WidgetBlockEditor']));
    const loaders = path.join(site.project, LOADERS_FILE);
    const registry = path.join(site.project, REGISTRY_FILE);
    const shippedMap = readFileSync(loaders, 'utf8');
    const cleanRegistry = readFileSync(registry, 'utf8');
    const conflicted = (file, text) => {
      writeFileSync(file, text);
      const run = runUpdate(site);
      expect(run.status, run.output).toBe(0);
      expect(run.output).not.toContain(WARNING);
      expect(suggestionsIn(run.output)).toEqual([]);
      expect(run.output).toContain('Code is already up to date.');
      return run.output;
    };

    const atEnd = shippedMap.replace(/^\} satisfies/m, `${hunk(faqLoader, widgetLoader)}} satisfies`);
    expect(atEnd).not.toBe(shippedMap);
    expect(conflicted(loaders, atEnd).split(loadersConflict)).toHaveLength(2);

    const inMiddle = shippedMap.replace(/^ {2}FeaturedProductBlockEditor:/m, `${hunk(faqLoader, widgetLoader)}  FeaturedProductBlockEditor:`);
    expect(inMiddle).not.toBe(shippedMap);
    expect(conflicted(loaders, inMiddle).split(loadersConflict)).toHaveLength(2);

    // Half resolved: the one marker line left behind is enough, whichever it is.
    const openerLeft = shippedMap.replace(/^\} satisfies/m, `<<<<<<< your version\n  ${faqLoader}\n} satisfies`);
    expect(openerLeft).not.toBe(shippedMap);
    expect(conflicted(loaders, openerLeft).split(loadersConflict)).toHaveLength(2);
    const closerLeft = shippedMap.replace(/^\} satisfies/m, `  ${faqLoader}\n>>>>>>> NextBlock 0.23.5\n} satisfies`);
    expect(closerLeft).not.toBe(shippedMap);
    expect(conflicted(loaders, closerLeft).split(loadersConflict)).toHaveLength(2);
    // Only those two deleted: the ======= line left between the two entries is code, not text. Read as a
    // map, it hid the entry after it (a comma before it) or merged the two (no comma).
    for (const ours of [faqLoader, faqLoader.replace(/,$/, '')]) {
      const separatorLeft = shippedMap.replace(/^\} satisfies/m, `  ${ours}\n=======\n  ${widgetLoader}\n} satisfies`);
      expect(separatorLeft).not.toBe(shippedMap);
      expect(conflicted(loaders, separatorLeft).split(loadersConflict), ours).toHaveLength(2);
    }

    // In the registry (CRLF, as shipped), and in both files.
    writeFileSync(loaders, shippedMap);
    const registryConflictLine =
      'lib/blocks/blockRegistry.ts has a merge conflict, so the block editors were not checked: resolve the conflict in that file, then run npm run update again.';
    const registryConflict = cleanRegistry.replace(
      /^ {2}faq: .*\r\n/m,
      hunk("faq: { editorComponentFilename: 'FaqBlockEditor.tsx' } as BlockDefinition,", "faqs: { editorComponentFilename: 'FaqsBlockEditor.tsx' } as BlockDefinition,", '\r\n'),
    );
    expect(registryConflict).not.toBe(cleanRegistry);
    expect(conflicted(registry, registryConflict)).toContain(registryConflictLine);
    // The registry with only the hunk's outer two lines deleted, every line ending in CRLF: the =======
    // line left between the two definitions is code there too.
    const crlfRegistry = cleanRegistry.replace(/\r?\n/g, '\r\n');
    const registrySeparatorLeft = crlfRegistry.replace(
      /^ {2}faq: .*\r\n/m,
      "  faq: { editorComponentFilename: 'FaqBlockEditor.tsx' } as BlockDefinition,\r\n=======\r\n  faqs: { editorComponentFilename: 'FaqsBlockEditor.tsx' } as BlockDefinition,\r\n",
    );
    expect(registrySeparatorLeft).toContain('BlockDefinition,\r\n=======\r\n  faqs: {');
    expect(registrySeparatorLeft).not.toMatch(/^(?:<{7}|>{7})/m);
    expect(conflicted(registry, registrySeparatorLeft)).toContain(registryConflictLine);
    expect(conflicted(loaders, atEnd)).toContain(
      'app/cms/blocks/components/blockEditorLoaders.ts and lib/blocks/blockRegistry.ts have merge conflicts, so the block editors were not checked: ' +
        'resolve the conflicts in those files, then run npm run update again.',
    );
  });

  it('reads a registry and a map whose template literal or comment holds a markdown ======= underline: text, not a conflict', SPAWNS, () => {
    const site = makeProject(NEXT_CONFIG);
    writeFiles(site.project, {
      [REGISTRY_FILE]: [
        'export const blockRegistry = {',
        '  faq: {',
        "    editorComponentFilename: 'FaqBlockEditor.tsx',",
        '    documentation: { description: `FAQ',
        '=======',
        'One question and its answer per row.` },',
        '  },',
        '};',
        '',
      ].join('\r\n'),
      [LOADERS_FILE]: ['/*', 'Block editors', '=======', 'One loader per editor file.', '*/', loadersSource(['TextBlockEditor'])].join('\n'),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor']),
    });

    const run = runUpdate(site);
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('merge conflict');
    expect(run.output).toContain('1 block editor in app/cms/blocks/editors is named in lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS');
    expect(suggestionsIn(run.output)).toEqual(["FaqBlockEditor: () => import('../editors/FaqBlockEditor'),"]);
  });
});

// Forks and Vercel 1-click deploys update through git (updateCodeViaGit), and the nightly
// nextblock-sync workflow merges without running the updater at all, so the owner's next
// `npm run update` finds nothing to merge. Both runs check the editors under apps/nextblock. These run
// the real update.mjs in a temp monorepo checkout with FAKE_GIT preloaded.
describe('npm run update on a monorepo fork (the git channel)', () => {
  const APP = path.join('apps', 'nextblock');
  const FORK = { FAKE_GIT_ORIGIN: 'https://github.com/someone/my-site.git' };

  /** A checkout the updater takes for the monorepo (nx.json, the migrations folder), with `appFiles` under apps/nextblock. */
  function makeMonorepo(appFiles) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-update-git-'));
    roots.push(root);
    const checkout = path.join(root, 'checkout');
    mkdirSync(path.join(checkout, 'libs', 'db', 'src', 'supabase', 'migrations'), { recursive: true });
    writeFileSync(path.join(checkout, 'nx.json'), '{}\n');
    writeFiles(path.join(checkout, APP), appFiles);
    const bin = makeBin(root);
    return { root, site: { project: checkout, bin }, preload: ['--require', path.join(bin, 'fake-git.cjs')] };
  }

  it('names the editors the map lacks on a run with nothing to merge', SPAWNS, () => {
    const { site, preload } = makeMonorepo({
      [REGISTRY_FILE]: registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']),
      [LOADERS_FILE]: loadersSource(['TextBlockEditor']),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor']),
    });

    const run = runUpdate(site, [], { ...FORK, FAKE_GIT_BEHIND: '0' }, preload);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Nx monorepo fork');
    expect(run.output.split(WARNING)).toHaveLength(2);
    expect(run.output).toContain(
      '1 block editor in apps/nextblock/app/cms/blocks/editors is named in apps/nextblock/lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS',
    );
    expect(run.output).toContain('Add this line to BLOCK_EDITOR_LOADERS in apps/nextblock/app/cms/blocks/components/blockEditorLoaders.ts:');
    expect(suggestionsIn(run.output)).toEqual(["FaqBlockEditor: () => import('../editors/FaqBlockEditor'),"]);
    expect(run.output).toContain('Code is already up to date.');
    expect(run.output).not.toContain('Installing dependencies');
  });

  it('names them after merging the release that brings the map', SPAWNS, () => {
    // Before the merge the fork has no map (0.23.3), and its CMS opens the editor by name.
    const { root, site, preload } = makeMonorepo({
      [REGISTRY_FILE]: registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor']),
    });
    const upstream = path.join(root, 'upstream');
    writeFiles(path.join(upstream, APP), { [LOADERS_FILE]: loadersSource(['TextBlockEditor']) });

    const run = runUpdate(site, [], { ...FORK, FAKE_GIT_BEHIND: '2', FAKE_GIT_MERGE: upstream, FAKE_NPM_INSTALL: '1' }, preload);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(path.join(site.project, APP, LOADERS_FILE), 'utf8')).toBe(loadersSource(['TextBlockEditor']));
    expect(run.output.split(WARNING)).toHaveLength(2);
    expect(run.output).toContain(
      '1 block editor in apps/nextblock/app/cms/blocks/editors is named in apps/nextblock/lib/blocks/blockRegistry.ts but missing from BLOCK_EDITOR_LOADERS',
    );
    expect(suggestionsIn(run.output)).toEqual(["FaqBlockEditor: () => import('../editors/FaqBlockEditor'),"]);
    expect(run.output).toContain('Upstream merged.');
    expect(run.output).toContain('Dependencies installed.');
    const warned = run.output.indexOf(WARNING);
    expect(warned).toBeGreaterThan(run.output.indexOf('Upstream merged.'));
    expect(warned).toBeLessThan(run.output.indexOf('Dependencies installed.'));
  });

  it('names a conflicted map by its path in the repository', SPAWNS, () => {
    const { site, preload } = makeMonorepo({
      [REGISTRY_FILE]: registrySource(['TextBlockEditor.tsx', 'FaqBlockEditor.tsx']),
      [LOADERS_FILE]: loadersSource(['TextBlockEditor']).replace(
        /^\} satisfies/m,
        [
          '<<<<<<< HEAD',
          "  FaqBlockEditor: () => import('../editors/FaqBlockEditor'),",
          '=======',
          "  WidgetBlockEditor: () => import('../editors/WidgetBlockEditor'),",
          '>>>>>>> upstream/master',
          '} satisfies',
        ].join('\n'),
      ),
      ...editorFiles(['TextBlockEditor', 'FaqBlockEditor']),
    });

    const run = runUpdate(site, [], { ...FORK, FAKE_GIT_BEHIND: '0' }, preload);
    expect(run.status, run.output).toBe(0);
    const warnings = run.output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('  ! '))
      .map((line) => line.slice('  ! '.length));
    expect(warnings.filter((line) => line.startsWith('apps/nextblock/app/cms/blocks/components/blockEditorLoaders.ts has a merge conflict'))).toHaveLength(1);
    expect(run.output).not.toContain(WARNING);
    expect(suggestionsIn(run.output)).toEqual([]);
    expect(run.output).toContain('Code is already up to date.');
  });
});

// The schema step. main() imports tools/lib/migrate-core.mjs before the code update, which replaces that
// file (the template sync in a standalone project, the git merge in the monorepo). Through 0.23.5 the
// update that brought a release applied its migrations with the previous release's engine, and so with
// that release's post-apply grant pass, which lacks the revokes the new release adds to
// API_ROLE_REVOKE_SQL: after the update to 0.23.6, anon could call publish_product_draft until the next
// build hook run. Running the update again changed nothing, as a run with nothing pending ran no pass.
// These run a copy of update.mjs inside the project, beside a fake engine that prints each call, so the
// code update replaces the very file the updater loaded first.
const ENGINE_FILE = path.join('tools', 'lib', 'migrate-core.mjs');
/**
 * A stand-in for tools/lib/migrate-core.mjs that prints `[engine <name>] <call>` for each call. The
 * migrations are FAKE_MIGRATIONS, the versions the database records FAKE_APPLIED. loadEnvFiles sets
 * FAKE_ENV_LOADED_BY unless it is set, as dotenv (override: false) keeps a variable already loaded.
 */
const fakeEngine = (name) => `const say = (line) => console.log('[engine ${name}] ' + line);
const versions = (key) => (process.env[key] ?? '').split(',').filter(Boolean);
export async function loadEnvFiles() {
  say('loadEnvFiles');
  process.env.FAKE_ENV_LOADED_BY ??= '${name}';
}
export function describeBackend() {
  say('describeBackend');
  return { kind: 'postgres', detail: 'env loaded by ' + process.env.FAKE_ENV_LOADED_BY };
}
export function collectMigrations() {
  say('collectMigrations');
  return { files: versions('FAKE_MIGRATIONS').map((version) => ({ version, name: version + '_fake.sql', dir: '.' })), sources: [] };
}
export async function readAppliedVersions() {
  say('readAppliedVersions');
  return { ok: true, versions: new Set(versions('FAKE_APPLIED')) };
}
export async function applyMigrations(files, options = {}) {
  say('applyMigrations ' + (files.map((file) => file.version).join(',') || '(none)'));
  const recorded = new Set(versions('FAKE_APPLIED'));
  const pending = files.filter((file) => !recorded.has(file.version));
  for (const file of pending) options.onApplied?.(file);
  return { ok: true, applied: pending.length, backend: 'postgres' };
}
export async function runSql() {
  say('runSql');
  return { ok: true };
}
`;
/** The calls engine `name` printed, in order. */
const engineCalls = (output, name) => [...output.matchAll(new RegExp(`^\\[engine ${name}\\] (.+?)\\r?$`, 'gm'))].map((match) => match[1]);
/** Each warning the updater printed, without its marker. */
const warningsIn = (output) =>
  output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  ! '))
    .map((line) => line.slice('  ! '.length));
/** What the schema step asks the engine before it applies anything. */
const SCHEMA_READS = ['describeBackend', 'collectMigrations', 'readAppliedVersions'];

/**
 * The line git merge-file writes to open a hunk under the updater's first label. Built, not written
 * out: this file ships in every project's tools/, where a line holding only the marker would hold
 * every update's schema step.
 */
const OPENER = `${'<'.repeat(7)} your version`;
/** The lines of `text` that open a hunk, each as it ends: with its CR when the file is CRLF. */
const openerLines = (text) => text.split('\n').filter((line) => line.startsWith(OPENER));
/** The files the conflict hold listed, in the order it printed them. */
function heldFiles(output) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.endsWith(' file(s) still contain unresolved merge conflicts:'));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.trim() === '');
  return lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim());
}
/** UNRESOLVED_CONFLICT_PATTERN, the pattern update.mjs hands git grep for its hold, as Node reads the literal. */
function holdPattern() {
  const file = ts.createSourceFile('update.mjs', readFileSync(UPDATE_SCRIPT, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && name.text === 'UNRESOLVED_CONFLICT_PATTERN' && initializer && ts.isStringLiteral(initializer)) return initializer.text;
    }
  }
  throw new Error('update.mjs declares no UNRESOLVED_CONFLICT_PATTERN string');
}

/**
 * The environment for a real git that reads none of this machine's configuration (hooks, signing,
 * autocrlf, a merge style), only `config` under `root`: no CRLF conversion and a committer. The
 * GIT_* variables of the caller (a hook's GIT_DIR, say) are left out too.
 */
function isolatedGit(root) {
  const config = path.join(root, 'gitconfig');
  writeFileSync(config, '[core]\n\tautocrlf = false\n[user]\n\tname = NextBlock tests\n\temail = tests@example.invalid\n');
  return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
}
/** Runs real git in `cwd` with the isolatedGit() `gitEnv`; returns the spawn result. */
function gitIn(cwd, args, gitEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return spawnSync('git', args, { cwd, env: { ...env, ...gitEnv }, encoding: 'utf8' });
}
/** Makes `project` a repository whose first commit holds every file in it. */
function commitProject(project, gitEnv) {
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'the project']]) {
    const res = gitIn(project, args, gitEnv);
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr || res.error}`);
  }
}
/**
 * A six-line file as `git merge-file` leaves it when the project and the release changed its third
 * line, with the updater's labels; `eols` are the line endings, line by line, repeating.
 */
function mergedWithConflict(dir, eols, gitEnv) {
  mkdirSync(dir, { recursive: true });
  const text = (third) => ['one', 'two', third, 'four', 'five', 'six'].map((line, index) => line + eols[index % eols.length]).join('');
  const [ours, base, theirs] = ['ours', 'base', 'theirs'].map((name) => path.join(dir, name));
  writeFileSync(ours, text('three, as the project edited it'));
  writeFileSync(base, text('three'));
  writeFileSync(theirs, text('three, as the release changed it'));
  const res = gitIn(dir, ['merge-file', '-L', 'your version', '-L', 'NextBlock 98.0.0', '-L', `NextBlock ${VERSION}`, ours, base, theirs], gitEnv);
  if (res.status !== 1) throw new Error(`git merge-file left ${res.status} conflict(s), expected 1: ${res.stderr}`);
  return readFileSync(ours, 'utf8');
}
/** `text` with every line ending in CRLF. */
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

describe("npm run update's schema step and the migration engine it runs on", () => {
  const ONE_PENDING = { FAKE_MIGRATIONS: '02001,02002', FAKE_APPLIED: '02001' };
  const NONE_PENDING = { FAKE_MIGRATIONS: '02001,02002', FAKE_APPLIED: '02001,02002' };

  /** A standalone project on `version` that runs its own copy of update.mjs, with `engine` as its migration engine. */
  function makeEngineProject(version, engine, files = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-update-engine-'));
    roots.push(root);
    const project = path.join(root, 'project');
    writeFiles(project, {
      'package.json': `${JSON.stringify({ name: 'site', private: true, nextblock: { version } }, null, 2)}\n`,
      [path.join('tools', 'update.mjs')]: readFileSync(UPDATE_SCRIPT, 'utf8'),
      [ENGINE_FILE]: engine,
      ...files,
    });
    return { project, bin: makeBin(root), script: path.join(project, 'tools', 'update.mjs'), schema: true, template: path.join(root, 'template') };
  }

  /** Updates `site` to VERSION, whose template brings `engine` as tools/lib/migrate-core.mjs; `nodeArgs` as in runUpdate. */
  function updateToRelease(site, engine, schemaEnv, nodeArgs = []) {
    writeFiles(site.template, { 'package.json': '{}\n', [ENGINE_FILE]: engine });
    return runUpdate(site, ['--yes'], { FAKE_NPM_INSTALL: '1', FAKE_TEMPLATE_DIR: site.template, ...schemaEnv }, nodeArgs);
  }

  it('runs a standalone update to a release on the engine that release brought, not the one it loaded first', SPAWNS, () => {
    const site = makeEngineProject('98.0.0', fakeEngine('98'));

    const run = updateToRelease(site, fakeEngine('99'), ONE_PENDING);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(path.join(site.project, ENGINE_FILE), 'utf8')).toBe(fakeEngine('99'));
    // The engine loaded first only read the env files. Every database call ran on the new one, the
    // update alert included, and it reads the env the first one loaded (its own load overrides nothing).
    expect(engineCalls(run.output, '98')).toEqual(['loadEnvFiles']);
    expect(engineCalls(run.output, '99')).toEqual(['loadEnvFiles', ...SCHEMA_READS, 'applyMigrations 02001,02002', 'runSql']);
    expect(run.output.indexOf('[engine 99] loadEnvFiles')).toBeGreaterThan(run.output.indexOf('Dependencies installed.'));
    expect(run.output).toContain('Using the migration engine as this update left it (tools/lib/migrate-core.mjs).');
    expect(run.output).toContain('Backend: postgres · env loaded by 98');
    expect(run.output).toContain('applied 02002_fake.sql');
    expect(run.output).toContain('Applied 1 migration(s) and re-applied the database grants.');
    expect(warningsIn(run.output).filter((line) => line.includes('migrate-core') || line.includes('grants'))).toEqual([]);
  });

  it('runs a monorepo update on the engine the git merge brought to apps/nextblock/tools/lib', SPAWNS, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-update-engine-git-'));
    roots.push(root);
    const checkout = path.join(root, 'checkout');
    const appEngine = path.join('apps', 'nextblock', ENGINE_FILE);
    const script = path.join(checkout, 'apps', 'nextblock', 'tools', 'update.mjs');
    mkdirSync(path.join(checkout, 'libs', 'db', 'src', 'supabase', 'migrations'), { recursive: true });
    writeFiles(checkout, { 'nx.json': '{}\n', [path.relative(checkout, script)]: readFileSync(UPDATE_SCRIPT, 'utf8'), [appEngine]: fakeEngine('98') });
    const upstream = path.join(root, 'upstream');
    writeFiles(upstream, { [appEngine]: fakeEngine('99') });
    const bin = makeBin(root);
    const fork = { FAKE_GIT_ORIGIN: 'https://github.com/someone/my-site.git', FAKE_GIT_BEHIND: '2', FAKE_GIT_MERGE: upstream, FAKE_NPM_INSTALL: '1' };

    const run = runUpdate({ project: checkout, bin, script, schema: true }, ['--yes'], { ...fork, ...ONE_PENDING }, ['--require', path.join(bin, 'fake-git.cjs')]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Upstream merged.');
    expect(readFileSync(path.join(checkout, appEngine), 'utf8')).toBe(fakeEngine('99'));
    expect(engineCalls(run.output, '98')).toEqual(['loadEnvFiles']);
    // No update alert to clear: a monorepo run records no version.
    expect(engineCalls(run.output, '99')).toEqual(['loadEnvFiles', ...SCHEMA_READS, 'applyMigrations 02001,02002']);
    expect(run.output).toContain('Using the migration engine as this update left it (apps/nextblock/tools/lib/migrate-core.mjs).');
    expect(run.output).toContain('Applied 1 migration(s) and re-applied the database grants.');
  });

  it('re-applies the database grants when nothing is pending, and not under --check, --skip-db, a conflict hold or Docker', SPAWNS, () => {
    const site = makeEngineProject(VERSION, fakeEngine('99'));

    // A plain run, which asks nothing for it (no --yes, no terminal), and --db-only.
    for (const flags of [[], ['--db-only']]) {
      const run = runUpdate(site, flags, NONE_PENDING);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('Schema is up to date (2 migration(s) recorded).');
      expect(engineCalls(run.output, '99'), flags.join(' ')).toEqual(['loadEnvFiles', ...SCHEMA_READS, 'applyMigrations (none)']);
      expect(run.output).toContain('Re-applied the database grants: the blanket grants to the API roles, then the revokes this version lists.');
    }

    // --check says so and writes nothing.
    const check = runUpdate(site, ['--check'], NONE_PENDING);
    expect(check.status, check.output).toBe(0);
    expect(engineCalls(check.output, '99')).toEqual(['loadEnvFiles', ...SCHEMA_READS]);
    expect(check.output).toContain('Would re-apply the database grants.');
    expect(check.output).not.toContain('Re-applied the database grants');

    // --skip-db never reaches the schema step.
    const skipped = runUpdate({ ...site, schema: false }, [], NONE_PENDING);
    expect(skipped.status, skipped.output).toBe(0);
    expect(skipped.output).not.toContain('Database schema');
    expect(engineCalls(skipped.output, '99')).toEqual(['loadEnvFiles']);

    // Unresolved conflicts from an earlier update hold the whole schema step.
    const held = runUpdate(site, [], { ...NONE_PENDING, FAKE_GIT_CONFLICTS: 'app/page.tsx' }, ['--require', path.join(site.bin, 'fake-git.cjs')]);
    expect(held.status, held.output).toBe(0);
    expect(held.output).toContain('Migrations are on hold until those are resolved.');
    expect(engineCalls(held.output, '99')).toEqual(['loadEnvFiles']);

    // A Docker project's stack applies its migrations itself (docker/migrate/run-migrations.sh grants nothing).
    const docker = makeEngineProject(VERSION, fakeEngine('99'), { 'docker-compose.yml': 'services: {}\n', '.env': 'POSTGRES_HOST=db\n' });
    const stack = runUpdate(docker, [], NONE_PENDING);
    expect(stack.status, stack.output).toBe(0);
    expect(stack.output).toContain('The Docker stack applies them on npm run docker:up.');
    expect(engineCalls(stack.output, '99')).toEqual(['loadEnvFiles']);
  });

  // The runs above are on VERSION already, so the code update brings nothing and no reload is tried.
  // These update from 98, so the engine the release brings is on disk and the reload is due: the hold
  // and the Docker hand-off must come first. Each fails with the reload moved above it.
  it('reloads no engine while unresolved conflicts hold the schema step of an update to a release', SPAWNS, () => {
    const site = makeEngineProject('98.0.0', fakeEngine('98'));

    const run = updateToRelease(site, fakeEngine('99'), { ...ONE_PENDING, FAKE_GIT_CONFLICTS: 'app/page.tsx' }, ['--require', path.join(site.bin, 'fake-git.cjs')]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Dependencies installed.');
    expect(readFileSync(path.join(site.project, ENGINE_FILE), 'utf8')).toBe(fakeEngine('99'));
    expect(heldFiles(run.output)).toEqual(['app/page.tsx']);
    expect(run.output).toContain('Migrations are on hold until those are resolved.');
    // The engine loaded first only read the env files, and the release's engine was never loaded.
    expect(engineCalls(run.output, '98')).toEqual(['loadEnvFiles']);
    expect(engineCalls(run.output, '99')).toEqual([]);
    expect(run.output).not.toContain('Using the migration engine as this update left it');
  });

  it("reloads no engine for a Docker project, whose stack applies the release's migrations itself", SPAWNS, () => {
    const site = makeEngineProject('98.0.0', fakeEngine('98'), { 'docker-compose.yml': 'services: {}\n', '.env': 'POSTGRES_HOST=db\n' });

    const run = updateToRelease(site, fakeEngine('99'), ONE_PENDING, ['--require', path.join(site.bin, 'fake-git.cjs')]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Dependencies installed.');
    expect(readFileSync(path.join(site.project, ENGINE_FILE), 'utf8')).toBe(fakeEngine('99'));
    expect(run.output).toContain('The Docker stack applies them on npm run docker:up.');
    // No schema call on either engine. The hand-off returns no engine, so main() clears the update
    // alert (runSql) with the one it loaded first, as every updater before 0.23.6 did.
    expect(engineCalls(run.output, '98')).toEqual(['loadEnvFiles', 'runSql']);
    expect(engineCalls(run.output, '99')).toEqual([]);
    expect(run.output).not.toContain('Using the migration engine as this update left it');
  });

  it('keeps the engine it loaded first, and says so, when the one the code update brought does not load', SPAWNS, () => {
    const brokenEngines = [
      ['a syntax error', 'export const version = ;\n', "SyntaxError: Unexpected token ';'"],
      ['a missing call', fakeEngine('99').replace('export async function readAppliedVersions', 'async function readAppliedVersions'), 'it exports no readAppliedVersions'],
    ];
    for (const [label, engine, reason] of brokenEngines) {
      expect(engine, label).not.toBe(fakeEngine('99'));
      const couldNotLoad = `Could not load tools/lib/migrate-core.mjs as this update left it: ${reason}`;

      // A migration pending: the engine loaded first applies it, and its own grant pass, as earlier updaters did.
      const pending = updateToRelease(makeEngineProject('98.0.0', fakeEngine('98')), engine, ONE_PENDING);
      expect(pending.status, `${label}\n${pending.output}`).toBe(0);
      expect(warningsIn(pending.output), label).toContain(couldNotLoad);
      expect(engineCalls(pending.output, '98'), label).toEqual(['loadEnvFiles', ...SCHEMA_READS, 'applyMigrations 02001,02002', 'runSql']);
      expect(engineCalls(pending.output, '99'), label).toEqual([]);
      expect(pending.output, label).toContain('Applied 1 migration(s), with the database grants of the version you updated from (above).');

      // Nothing pending: no grant pass at all, as the engine loaded first is the previous version's.
      const recorded = updateToRelease(makeEngineProject('98.0.0', fakeEngine('98')), engine, NONE_PENDING);
      expect(recorded.status, `${label}\n${recorded.output}`).toBe(0);
      expect(warningsIn(recorded.output), label).toContain(couldNotLoad);
      expect(engineCalls(recorded.output, '98'), label).toEqual(['loadEnvFiles', ...SCHEMA_READS, 'runSql']);
      expect(warningsIn(recorded.output), label).toContain(
        'The database grants were not re-applied: the migration engine this update brought did not load (above).',
      );
    }
  });

  // The hold reads the project with real git, and git merge-file writes its markers with CRLF when the
  // files it merges use CRLF. Through 0.23.5 the hold's pattern ended in `$` alone, which the CR of such
  // a marker line never matched, so an update that left a conflict in a CRLF file held nothing: it
  // applied the migrations over the conflict, and with the reload it imported the conflicted engine,
  // failed, and applied them with the engine it loaded first. The FAKE_GIT runs above answer `git grep`
  // themselves.
  describe('the conflict hold, on real git', () => {
    it('holds an update that leaves a conflict in a CRLF tools/lib/migrate-core.mjs, and loads no engine for it', SPAWNS, () => {
      // The project edited the engine's first line, which the release changes too: the merge conflicts there.
      const local = crlf(fakeEngine('98')).replace('\r\n', ' // edited in this project\r\n');
      const site = makeEngineProject('98.0.0', local);
      const root = path.dirname(site.project);
      const gitEnv = isolatedGit(root);
      commitProject(site.project, gitEnv);
      const templates = { '98.0.0': path.join(root, 'template-98'), [VERSION]: path.join(root, 'template-99') };
      writeFiles(templates['98.0.0'], { 'package.json': '{}\n', [ENGINE_FILE]: crlf(fakeEngine('98')) });
      writeFiles(templates[VERSION], { 'package.json': '{}\n', [ENGINE_FILE]: crlf(fakeEngine('99')) });

      const run = runUpdate(site, ['--yes'], { FAKE_NPM_INSTALL: '1', FAKE_TEMPLATE_DIRS: JSON.stringify(templates), ...ONE_PENDING, ...gitEnv });
      expect(run.status, run.output).toBe(0);
      // git merge-file wrote the marker with CRLF, as the three copies it merged use.
      expect(openerLines(readFileSync(path.join(site.project, ENGINE_FILE), 'utf8'))).toEqual([`${OPENER}\r`]);
      const warnings = warningsIn(run.output);
      expect(warnings).toContain('1 file(s) conflict with your edits and need resolving:');
      expect(warnings).toContain('1 file(s) still contain unresolved merge conflicts:');
      expect(heldFiles(run.output)).toEqual(['tools/lib/migrate-core.mjs']);
      expect(run.output).toContain('Migrations are on hold until those are resolved.');
      expect(run.output).toContain('Resolve the conflicts above, then re-run npm run update to migrate.');
      // Nothing applied, no grant pass, and the conflicted engine never imported: the engine loaded
      // first only read the env files.
      expect(engineCalls(run.output, '98')).toEqual(['loadEnvFiles']);
      expect(engineCalls(run.output, '99')).toEqual([]);
      expect(run.output).not.toContain('Using the migration engine as this update left it');
      expect(run.output).not.toContain('Could not load');
    });

    it('holds over every file an update left conflicted, whether its lines end in CRLF, LF or both', SPAWNS, () => {
      const site = makeEngineProject(VERSION, fakeEngine('99'));
      const root = path.dirname(site.project);
      const gitEnv = isolatedGit(root);
      const conflicted = {
        'app/crlf.ts': mergedWithConflict(path.join(root, 'merge-crlf'), ['\r\n'], gitEnv),
        'app/lf.ts': mergedWithConflict(path.join(root, 'merge-lf'), ['\n'], gitEnv),
        // CRLF on the two lines before the hunk, LF on the next: git picks the marker's ending itself.
        'app/mixed.ts': mergedWithConflict(path.join(root, 'merge-mixed'), ['\r\n', '\r\n', '\n'], gitEnv),
      };
      expect(openerLines(conflicted['app/crlf.ts'])).toEqual([`${OPENER}\r`]);
      expect(openerLines(conflicted['app/lf.ts'])).toEqual([OPENER]);
      expect(openerLines(conflicted['app/mixed.ts'])).toHaveLength(1);
      writeFiles(site.project, conflicted);
      commitProject(site.project, gitEnv);

      const run = runUpdate(site, [], { ...NONE_PENDING, ...gitEnv });
      expect(run.status, run.output).toBe(0);
      expect(warningsIn(run.output)).toContain('3 file(s) still contain unresolved merge conflicts:');
      expect(heldFiles(run.output)).toEqual(['app/crlf.ts', 'app/lf.ts', 'app/mixed.ts']);
      expect(run.output).toContain('Migrations are on hold until those are resolved.');
      expect(engineCalls(run.output, '99')).toEqual(['loadEnvFiles']);
    });

    it("matches no line of a file NextBlock ships, so the hold never stops an update on the release's own files", SPAWNS, () => {
      // A docs page or a test holding the marker alone on a line, in a release, would hold the schema
      // step of every update after it in every project. The pattern is git grep's, run as the hold runs it.
      // libs/db/src/supabase ships too: the CLI copies its config.toml, migrations and templates into every
      // project's tracked supabase/, and each update copies the migrations again (a seed migration quoting
      // the marker on a line of its own would hold every standalone update once committed).
      const pattern = holdPattern();
      expect(pattern).toBe(`^${OPENER}\r?$`);
      const top = gitIn(here, ['rev-parse', '--show-toplevel'], {});
      expect(top.status, top.stderr).toBe(0);
      const shipped = ['apps/nextblock', 'docs', 'apps/create-nextblock/templates/nextblock-template', 'libs/db/src/supabase'];
      const found = gitIn(top.stdout.trim(), ['grep', '-lE', pattern, '--', ...shipped], {});
      // 1 is git grep's "no line matched".
      expect(found.status, `${found.stdout}${found.stderr}`).toBe(1);
    });
  });

  it('keeps every call an updater makes on the engine exported by tools/lib/migrate-core.mjs', async () => {
    // The update to a release runs its schema step on that release's engine, so each updater calls the
    // engine of the release after it: a name dropped or renamed there leaves the update to that release on
    // the previous engine and its grants. A call update.mjs starts making joins SHIPPED_CALLS for good.
    // migrate-core.test.mjs pins what the calls take and answer, and that the engine imports no relative
    // module (the reload re-reads migrate-core.mjs alone).
    const SHIPPED_CALLS = ['loadEnvFiles', 'describeBackend', 'collectMigrations', 'readAppliedVersions', 'applyMigrations', 'runSql'];
    const source = readFileSync(UPDATE_SCRIPT, 'utf8');
    const listed = /^const MIGRATION_ENGINE_CALLS = \[([^\]]*)\];/m.exec(source)?.[1];
    expect(listed, 'update.mjs lists the engine calls it makes in MIGRATION_ENGINE_CALLS').toBeDefined();
    const calls = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const made = new Set([...source.matchAll(/\bcore\.(\w+)\(/g)].map((match) => match[1]));
    expect([...made].sort()).toEqual([...calls].sort());
    expect(SHIPPED_CALLS).toEqual(expect.arrayContaining(calls));
    const engine = await import('./lib/migrate-core.mjs');
    for (const name of SHIPPED_CALLS) expect(typeof engine[name], name).toBe('function');
  });
});
