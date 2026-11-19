import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

// CommonJS helpers of tools/scripts/rehearse-release.js (the release rehearsal CI runs): what it
// points at the packed tarballs, what it accepts from the scaffold's install, build and tsc, and
// how it prepares its work folder. Also the workflow that runs it, and the scripts it moved.
const {
  REHEARSED_LIBS,
  compareWithBudget,
  emptyFolderInside,
  findBundledTestTooling,
  findPackagesNotFromTarballs,
  isInside,
  parseTscOutput,
  prepareCliFolders,
  rewireToTarballs,
} = require('./lib/release-rehearsal.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORK = path.resolve('/rehearsal');
const SCAFFOLD = path.join(WORK, 'scaffold');
const tarball = (file: string) => path.join(WORK, 'tarballs', file);
const TARBALLS = {
  utils: { name: '@nextblock-cms/utils', file: tarball('nextblock-cms-utils-0.23.6.tgz') },
  ui: { name: '@nextblock-cms/ui', file: tarball('nextblock-cms-ui-0.23.6.tgz') },
  db: { name: '@nextblock-cms/db', file: tarball('nextblock-cms-db-0.23.6.tgz') },
  ecommerce: { name: '@nextblock-cms/ecom', file: tarball('nextblock-cms-ecom-0.23.6.tgz') },
  cortex: { name: '@nextblock-cms/cortex', file: tarball('nextblock-cms-cortex-0.23.6.tgz') },
};

describe('rewireToTarballs', () => {
  it('points every @nextblock-cms/* dependency at its tarball, ecom under its alias, and overrides the same specs', () => {
    const template = {
      name: 'scaffold',
      dependencies: {
        '@nextblock-cms/ecommerce': 'npm:@nextblock-cms/ecom@latest',
        '@nextblock-cms/cortex': 'latest',
        '@nextblock-cms/ui': '^0.23.5',
        next: '^16.4.3',
      },
      devDependencies: { '@nextblock-cms/db': 'latest', supabase: '^2.117.0' },
      overrides: { postcss: '^8.5.10' },
    };
    const { pkg, changed } = rewireToTarballs(template, TARBALLS, SCAFFOLD);

    expect(pkg.dependencies).toEqual({
      '@nextblock-cms/ecommerce': 'file:../tarballs/nextblock-cms-ecom-0.23.6.tgz',
      '@nextblock-cms/cortex': 'file:../tarballs/nextblock-cms-cortex-0.23.6.tgz',
      '@nextblock-cms/ui': 'file:../tarballs/nextblock-cms-ui-0.23.6.tgz',
      next: '^16.4.3',
    });
    expect(pkg.devDependencies['@nextblock-cms/db']).toBe('file:../tarballs/nextblock-cms-db-0.23.6.tgz');
    // The libs' own sibling edges (cortex's npm:@nextblock-cms/ecom alias included) resolve through
    // these; a dependency and its override must carry one spec (EOVERRIDE otherwise).
    expect(pkg.overrides).toEqual({
      postcss: '^8.5.10',
      '@nextblock-cms/utils': 'file:../tarballs/nextblock-cms-utils-0.23.6.tgz',
      '@nextblock-cms/ui': 'file:../tarballs/nextblock-cms-ui-0.23.6.tgz',
      '@nextblock-cms/db': 'file:../tarballs/nextblock-cms-db-0.23.6.tgz',
      '@nextblock-cms/ecom': 'file:../tarballs/nextblock-cms-ecom-0.23.6.tgz',
      '@nextblock-cms/ecommerce': 'file:../tarballs/nextblock-cms-ecom-0.23.6.tgz',
      '@nextblock-cms/cortex': 'file:../tarballs/nextblock-cms-cortex-0.23.6.tgz',
    });
    for (const [name, spec] of Object.entries(pkg.dependencies as Record<string, string>)) {
      if (pkg.overrides[name]) expect(spec).toBe(pkg.overrides[name]);
    }
    expect(changed).toHaveLength(4);
    // The input is left as it was.
    expect(template.dependencies['@nextblock-cms/ui']).toBe('^0.23.5');
  });

  it('refuses a @nextblock-cms/* dependency with no tarball: the registry copy would make the rehearsal a mix', () => {
    expect(() => rewireToTarballs({ dependencies: { '@nextblock-cms/affiliates': 'latest' } }, TARBALLS, SCAFFOLD)).toThrow(
      'dependencies["@nextblock-cms/affiliates"] has no packed tarball'
    );
  });

  it('rehearses the libs the release ships, in its publish order', () => {
    expect(REHEARSED_LIBS).toBe(require('./lib/release-pipeline.js').LIBS);
    expect(REHEARSED_LIBS).toEqual(['utils', 'ui', 'sdk', 'db', 'editor', 'ecommerce', 'cortex', 'affiliates']);
  });
});

describe('findPackagesNotFromTarballs', () => {
  const files = Object.values(TARBALLS).map(({ file }) => file);

  it('passes an install whose every @nextblock-cms/* package came from a packed tarball, nested copies included', () => {
    const lock = {
      packages: {
        '': { name: 'scaffold' },
        'node_modules/@nextblock-cms/ui': { version: '0.23.6', resolved: 'file:../tarballs/nextblock-cms-ui-0.23.6.tgz' },
        'node_modules/@nextblock-cms/ecommerce': { name: '@nextblock-cms/ecom', resolved: 'file:../tarballs/nextblock-cms-ecom-0.23.6.tgz' },
        'node_modules/@nextblock-cms/cortex/node_modules/@nextblock-cms/utils': { resolved: 'file:../tarballs/nextblock-cms-utils-0.23.6.tgz' },
        'node_modules/react': { resolved: 'https://registry.npmjs.org/react/-/react-19.3.1.tgz' },
      },
    };
    expect(findPackagesNotFromTarballs(lock, files)).toEqual([]);
  });

  it('names a package npm took from the registry, or from a tarball the rehearsal did not pack', () => {
    const lock = {
      packages: {
        'node_modules/@nextblock-cms/db': { resolved: 'https://registry.npmjs.org/@nextblock-cms/db/-/db-0.23.5.tgz' },
        'node_modules/@nextblock-cms/ui': { resolved: 'file:../elsewhere/nextblock-cms-ui-0.23.4.tgz' },
        'node_modules/@nextblock-cms/sdk': {},
      },
    };
    expect(findPackagesNotFromTarballs(lock, files)).toEqual([
      'node_modules/@nextblock-cms/db came from https://registry.npmjs.org/@nextblock-cms/db/-/db-0.23.5.tgz, not from a packed tarball',
      'node_modules/@nextblock-cms/ui came from file:../elsewhere/nextblock-cms-ui-0.23.4.tgz, not from a packed tarball',
      'node_modules/@nextblock-cms/sdk came from (no "resolved" field), not from a packed tarball',
    ]);
  });
});

describe('parseTscOutput', () => {
  it('counts errors by code and by file, located or not, and nothing else', () => {
    const output = [
      "components/a.tsx(3,7): error TS2322: Type '{ variant: string; }' is not assignable to type 'ButtonProps'.",
      "components/a.tsx(9,1): error TS2322: Type 'x' is not assignable to type 'y'.",
      "app\\b.test.tsx(1,22): error TS2307: Cannot find module 'vitest' or its corresponding type declarations.",
      "  Property 'variant' does not exist on type 'IntrinsicAttributes'.",
      'error TS5083: Cannot read file \'/x/tsconfig.base.json\'.',
      'Found 4 errors in 3 files.',
      '',
    ].join('\r\n');
    expect(parseTscOutput(output)).toEqual({
      total: 4,
      byCode: { TS2307: 1, TS2322: 2, TS5083: 1 },
      byFile: { '(global)': 1, 'app/b.test.tsx': 1, 'components/a.tsx': 2 },
    });
    expect(parseTscOutput('')).toEqual({ total: 0, byCode: {}, byFile: {} });
  });
});

describe('compareWithBudget', () => {
  const budget = { total: 10, byCode: { TS2307: 6, TS7006: 4 } };

  it('passes counts at the budget', () => {
    expect(compareWithBudget({ total: 10, byCode: { TS2307: 6, TS7006: 4 } }, budget)).toEqual({ ok: true, over: [], lower: null });
  });

  it('fails a count above its budget, and any error code the budget does not list', () => {
    const verdict = compareWithBudget({ total: 10, byCode: { TS2307: 5, TS7006: 4, TS2322: 1 } }, budget);
    expect(verdict.ok).toBe(false);
    expect(verdict.over).toEqual(['TS2322: 1, budget 0']);
    expect(compareWithBudget({ total: 11, byCode: { TS2307: 7, TS7006: 4 } }, budget).over).toEqual([
      '11 errors in all, budget 10',
      'TS2307: 7, budget 6',
    ]);
  });

  it('passes fewer errors and names the lower budget to pin, so the next regression has no slack to hide in', () => {
    expect(compareWithBudget({ total: 7, byCode: { TS2307: 6, TS7006: 1 } }, budget)).toEqual({
      ok: true,
      over: [],
      lower: { total: 7, byCode: { TS2307: 6, TS7006: 1 } },
    });
  });
});

describe('findBundledTestTooling', () => {
  it('finds vitest and chai by module path or import, and a test file in a source map', () => {
    const hits = findBundledTestTooling([
      { path: 'server/chunks/a.js', text: 'module.exports = require("vitest");' },
      { path: 'server/chunks/b.js', text: '/* node_modules/chai/index.js */' },
      { path: 'static/chunks/c.js', text: 'self.__vitest_worker__ = 1' },
      { path: 'server/chunks/d.js.map', text: JSON.stringify({ sources: ['../app/cms/blocks/editors/SectionBlockEditor.test.tsx'] }) },
      { path: 'server/chunks/e.js.map', text: JSON.stringify({ sections: [{ map: { sources: ['node_modules/@vitest/spy/dist/index.js'] } }] }) },
    ]);
    expect(hits).toEqual([
      'server/chunks/a.js contains "require(\\"vitest\\")"',
      'server/chunks/b.js contains "node_modules/chai/"',
      'static/chunks/c.js contains "__vitest_worker__"',
      'server/chunks/d.js.map maps ../app/cms/blocks/editors/SectionBlockEditor.test.tsx',
      'server/chunks/e.js.map maps node_modules/@vitest/spy/dist/index.js',
    ]);
  });

  it('leaves words in code and text alone ("chain", process.env.VITEST, a comment that names vitest)', () => {
    expect(
      findBundledTestTooling([
        { path: 'server/a.js', text: 'const chain = []; if (process.env.VITEST) {} // runs under vitest too' },
        { path: 'server/a.js.map', text: JSON.stringify({ sources: ['../lib/testimonials.ts', '../lib/contest.tsx'] }) },
        { path: 'server/broken.js.map', text: '{not json' },
      ])
    ).toEqual([]);
  });
});

describe('isInside', () => {
  it('tells a work folder inside the repository from one outside it', () => {
    const repo = path.resolve('/repo');
    expect(isInside(repo, repo)).toBe(true);
    expect(isInside(path.join(repo, 'dist', 'rehearsal'), repo)).toBe(true);
    expect(isInside(path.resolve('/repo-rehearsal'), repo)).toBe(false);
    expect(isInside(path.resolve('/tmp/rehearsal'), repo)).toBe(false);
  });
});

describe('the work folder', () => {
  const made: string[] = [];
  const tempFolder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-rehearsal-test-'));
    made.push(dir);
    return dir;
  };
  const write = (file: string, text = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  afterEach(() => {
    // Links first, so removing a folder never reaches through one into another test folder.
    for (const dir of made) {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (fs.lstatSync(path.join(dir, entry)).isSymbolicLink()) fs.unlinkSync(path.join(dir, entry));
      }
    }
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("empties an earlier run's cli/ before the CLI is packed again, so a file deleted from the template cannot reach the scaffold", () => {
    // A --skip-pack re-run reuses the work folder, and tar only adds and overwrites: the two scripts
    // 0.23.6 moved out of the template would stay in the old extraction, and the CLI would copy them
    // into the new scaffold, where tsc counts their errors against a budget of 0.
    const workdir = tempFolder();
    const stale = path.join(workdir, 'cli', 'extract', 'package', 'templates', 'nextblock-template', 'scripts', 'validate-editor-block-schema.ts');
    write(stale, "import '../../../libs/utils/src/lib/editor-blocks';\n");
    write(path.join(workdir, 'cli', 'create-nextblock-0.23.5.tgz'));
    write(path.join(workdir, 'tarballs', 'tarballs.json'), '{}\n');

    const { cliDir, extractDir } = prepareCliFolders(workdir);

    expect(cliDir).toBe(path.join(workdir, 'cli'));
    expect(extractDir).toBe(path.join(workdir, 'cli', 'extract'));
    expect(fs.readdirSync(cliDir)).toEqual(['extract']);
    expect(fs.readdirSync(extractDir)).toEqual([]);
    // What --skip-pack reuses stays.
    expect(fs.readFileSync(path.join(workdir, 'tarballs', 'tarballs.json'), 'utf8')).toBe('{}\n');
  });

  it('creates the folders in a new work folder', () => {
    const workdir = tempFolder();
    const { extractDir } = prepareCliFolders(workdir);
    expect(fs.readdirSync(extractDir)).toEqual([]);
  });

  it('empties nothing outside the work folder: not the folder itself, not beside it, not through a link', () => {
    const workdir = tempFolder();
    const outside = tempFolder();
    write(path.join(outside, 'keep.txt'), 'keep');
    write(path.join(outside, 'cli', 'keep.txt'), 'keep');

    expect(() => emptyFolderInside(workdir, workdir)).toThrow('only empties folders inside its work folder');
    expect(() => emptyFolderInside(path.join(workdir, 'cli', '..'), workdir)).toThrow('only empties folders inside its work folder');
    expect(() => emptyFolderInside(path.join(outside, 'cli'), workdir)).toThrow('only empties folders inside its work folder');

    // A junction on Windows (no privilege needed), a folder symlink elsewhere.
    fs.symlinkSync(outside, path.join(workdir, 'cli'), 'junction');
    expect(() => emptyFolderInside(path.join(workdir, 'cli'), workdir)).toThrow('it is a link');
    expect(() => prepareCliFolders(workdir)).toThrow('it is a link');
    fs.symlinkSync(outside, path.join(workdir, 'via'), 'junction');
    expect(() => emptyFolderInside(path.join(workdir, 'via', 'cli'), workdir)).toThrow('outside the work folder');

    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(outside, 'cli', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it("is prepared by the script's CLI step with prepareCliFolders, never a bare mkdir", () => {
    // The tests above cover the helper; this keeps rehearse-release.js on it. With the old
    // `fs.mkdirSync(extractDir, { recursive: true })` back in scaffoldFromCli, every other test here
    // still passes, and a --skip-pack re-run extracts over the old extraction again.
    const script = path.join(__dirname, 'rehearse-release.js');
    const source = ts.createSourceFile(script, fs.readFileSync(script, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calledName = (call: ts.CallExpression) =>
      ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';

    // The helper tested above, as the script's require of ./lib/release-rehearsal binds it.
    const required = source.statements.flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap(({ name, initializer }) =>
            ts.isObjectBindingPattern(name) &&
            initializer !== undefined &&
            ts.isCallExpression(initializer) &&
            calledName(initializer) === 'require' &&
            initializer.arguments.length === 1 &&
            ts.isStringLiteral(initializer.arguments[0]) &&
            initializer.arguments[0].text === './lib/release-rehearsal'
              ? name.elements.map((element) => element.name.getText(source))
              : []
          )
        : []
    );
    expect(required).toContain('prepareCliFolders');

    const scaffoldFromCli = source.statements.find(
      (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'scaffoldFromCli'
    );
    const body = scaffoldFromCli?.body;
    if (!body) throw new Error('rehearse-release.js has no function scaffoldFromCli');
    const folderDeclarations: string[] = [];
    const folderMaking: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && /\b(?:cliDir|extractDir)\b/.test(node.name.getText(source))) {
        folderDeclarations.push(node.getText(source));
      }
      if (ts.isCallExpression(node) && /^(?:mkdir|mkdtemp)(?:Sync)?$/.test(calledName(node))) {
        folderMaking.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    // Both folders come from the helper (a const used before it would throw), and the step makes
    // no folder of its own beside them.
    expect(folderDeclarations).toEqual(['{ cliDir, extractDir } = prepareCliFolders(workdir)']);
    expect(folderMaking).toEqual([]);
  });
});

// Whether a change to `file` starts a workflow whose `paths` filter is `patterns`, by GitHub's
// documented rules: patterns apply in order and the last one that matches decides (a leading `!`
// excludes); `*` matches anything but `/`, `**` anything at all, and `**/` no folder too
// (`docs/**/*.md` matches `docs/README.md`). Other special characters are not modelled.
function startsWorkflow(patterns: string[], file: string) {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    let source = '';
    for (let i = 0; i < glob.length; i += 1) {
      if (glob.startsWith('**/', i)) {
        source += '(?:.*/)?';
        i += 2;
      } else if (glob.startsWith('**', i)) {
        source += '.*';
        i += 1;
      } else if (glob[i] === '*') {
        source += '[^/]*';
      } else if ('?+[]!'.includes(glob[i])) {
        throw new Error(`${pattern}: this test does not model GitHub's "${glob[i]}"`);
      } else {
        source += glob[i].replace(/[.^$|(){}\\]/g, '\\$&');
      }
    }
    if (new RegExp(`^${source}$`).test(file)) included = !negated;
  }
  return included;
}

describe('.github/workflows/release-rehearsal.yml', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release-rehearsal.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('syncs the template from the app before it rehearses, as a release does, and commits nothing', () => {
    // The rehearsal packs the template as it is on disk; pull requests change the app and leave the
    // generated template alone, so without the sync CI rehearsed the last committed one.
    const runs = workflow
      .split('\n')
      .map((line) => /^\s*(?:-\s+)?run:\s*(.+?)\s*$/.exec(line)?.[1])
      .filter((command): command is string => Boolean(command));
    const install = runs.indexOf('npm ci');
    const sync = runs.indexOf('npm run sync:create-nextblock');
    const rehearse = runs.findIndex((command) => command.startsWith('node tools/scripts/rehearse-release.js'));
    expect(install).toBeGreaterThanOrEqual(0);
    // The sync needs the root install (fs-extra, chalk).
    expect(sync).toBeGreaterThan(install);
    expect(rehearse).toBeGreaterThan(sync);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/\bgit\s+(?:add|commit|push)\b/);
  });

  it('runs for every change but docs/ and Markdown, and for the lib READMEs that verify-lib-dist check 8 reads', () => {
    // GitHub documents `!` for `paths` only; `paths-ignore` cannot take a README back.
    expect(workflow).not.toMatch(/^\s*paths-ignore:/m);
    const filters = [...workflow.matchAll(/^ +paths: \[(.*)\]$/gm)].map(([, list]) => JSON.parse(`[${list.replace(/'/g, '"')}]`) as string[]);
    expect(filters).toHaveLength(2); // push and pull_request
    for (const patterns of filters) {
      const runFor = (file: string) => startsWorkflow(patterns, file);
      expect(runFor('apps/nextblock/app/cms/media/page.tsx')).toBe(true);
      expect(runFor('.github/workflows/release-rehearsal.yml')).toBe(true);
      expect(runFor('libs/ui/README.md')).toBe(true);
      expect(runFor('libs/affiliates/README.md')).toBe(true);
      expect(runFor('docs/06-CLI-AND-SCAFFOLDING.md')).toBe(false);
      expect(runFor('docs/images/diagram.png')).toBe(false);
      expect(runFor('README.md')).toBe(false);
      expect(runFor('CLAUDE.md')).toBe(false);
      expect(runFor('libs/ui/CLAUDE.md')).toBe(false);
    }
  });
});

describe('the maintainer scripts moved out of the template', () => {
  // validate-editor-block-schema.ts and verify-custom-block-definitions.ts lived in
  // apps/nextblock/scripts, inside the app's tsconfig, until they moved to tools/scripts (they
  // import monorepo paths, which broke every scaffold's tsc). tsx runs them without a type-check,
  // and no other config covers tools/scripts, so this is what keeps them checked.
  it('type-check with tools/scripts/tsconfig.scripts.json', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(__dirname, 'tsconfig.scripts.json'), '--pretty', 'false', '--listFiles'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/);
    expect(lines.filter((line) => /error TS\d+/.test(line))).toEqual([]);
    expect(result.status).toBe(0);
    // Both are in the program, so dropping one from the config cannot pass for a clean check.
    const listed = lines.map((line) => line.trim().replace(/\\/g, '/'));
    for (const script of ['validate-editor-block-schema.ts', 'verify-custom-block-definitions.ts']) {
      expect(listed.filter((file) => file.endsWith(`/tools/scripts/${script}`))).toHaveLength(1);
    }
  }, 120_000);
});
