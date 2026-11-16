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
// `npm view` answers VERSION. `npm install create-nextblock@<v>` stages FAKE_TEMPLATE_DIR as that
// package's template for a test that sets it; any other `npm install` succeeds only for a test that
// sets FAKE_NPM_INSTALL; anything else fails, so a run that reached a command it should not would
// show up as an error.
const FAKE_NPM = `import { cpSync } from 'node:fs';
import path from 'node:path';
const [command, spec = ''] = process.argv.slice(2);
if (command === 'view') console.log('${VERSION}');
else if (command === 'install' && process.env.FAKE_TEMPLATE_DIR && spec.startsWith('create-nextblock@')) {
  cpSync(process.env.FAKE_TEMPLATE_DIR, path.join('node_modules', 'create-nextblock', 'templates', 'nextblock-template'), { recursive: true });
} else if (!(command === 'install' && process.env.FAKE_NPM_INSTALL === '1')) process.exitCode = 1;
`;
// Preloaded with --require: answers the git commands updateCodeViaGit runs inside the updater, so no
// git starts, no repository or commit is needed and nothing reaches the network. FAKE_GIT_BEHIND is
// the upstream commit count; `git merge` copies FAKE_GIT_MERGE over the checkout. Any other git
// command fails, so a run that reached one would show up as an error.
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

/** Runs update.mjs in `project` (its cwd); `nodeArgs` go to Node before the script (the git preload). */
function runUpdate({ project, bin }, flags = [], extraEnv = {}, nodeArgs = []) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (KEEP_ENV.has(key.toUpperCase())) env[key] = value;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  const res = spawnSync(process.execPath, [...nodeArgs, UPDATE_SCRIPT, '--skip-db', ...flags], {
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
