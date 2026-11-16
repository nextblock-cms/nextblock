import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import {
  POSTCSS_ALIAS_ENTRY,
  POSTCSS_STUB_PATH,
  addPostcssBrowserAlias,
  applyPostcssBrowserAlias,
  describePostcssBrowserAlias,
  maskNonCode,
} from './postcss-browser-alias.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.resolve(here, rel), 'utf8').replace(/\r\n/g, '\n');

// next.config.js as `npm create nextblock` wrote it. 0.23.0 to 0.23.3 share one shape: the CLI's
// bin/lib/next-config.js patches applied to apps/nextblock/next.config.js, neither of which changed
// across those releases (derived from git HEAD before 0.23.4). 0.18.8 is the last release that wrote
// the whole file from a string template, where `turbopack` held only a comment.
const SCAFFOLD_0_23_3 = read('./__fixtures__/scaffold-0.23.3.next.config.txt');
const SCAFFOLD_0_18_8 = read('./__fixtures__/scaffold-0.18.8.next.config.txt');
// The app's own config, which a new scaffold inherits its turbopack block from.
const APP_CONFIG = read('../../next.config.js');

/** Run a next.config.js in a sandbox (stub requires, empty env) and return its export as plain JSON. */
function evaluateConfig(source) {
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    __dirname: '/project',
    __filename: '/project/next.config.js',
    process: { env: {}, cwd: () => '/project' },
    URL,
    require: (id) => {
      if (id === 'path' || id === 'node:path') return path.posix;
      if (id === 'fs' || id === 'node:fs') return { existsSync: () => false };
      if (id === '@vercel/toolbar/plugins/next') return { withVercelToolbar: () => (config) => config };
      if (id === 'webpack') return { NormalModuleReplacementPlugin: class {} };
      throw new Error(`unexpected require('${id}')`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'next.config.js' });
  return JSON.parse(JSON.stringify(cjsModule.exports, (key, value) => (typeof value === 'function' ? `[function ${key}]` : value)));
}

const APP_ALIAS = evaluateConfig(APP_CONFIG).turbopack.resolveAlias.postcss;

/** The config with the alias taken out again, for "nothing else changed" comparisons. */
function withoutPostcssAlias(config) {
  const copy = structuredClone(config);
  delete copy.turbopack.resolveAlias.postcss;
  if (Object.keys(copy.turbopack.resolveAlias).length === 0) delete copy.turbopack.resolveAlias;
  return copy;
}

describe('addPostcssBrowserAlias', () => {
  it("adds the entry to a 0.23.0–0.23.3 scaffold's turbopack.resolveAlias, the way the app has it", () => {
    const result = addPostcssBrowserAlias(SCAFFOLD_0_23_3);

    expect(result.status).toBe('patched');
    expect(result.how).toBe('entry');
    const patched = result.text;
    const block = patched.slice(patched.indexOf('    resolveAlias: {'), patched.indexOf('  transpilePackages:'));
    expect(block).toBe(
      [
        '    resolveAlias: {',
        "      'y-protocols/awareness': 'y-protocols/awareness.js',",
        '      // Browser bundles only: sanitize-html requires postcss but never calls it with style',
        '      // parsing off, so the client gets an empty module instead of ~18 KB gzipped of postcss.',
        '      // lib/browser-stubs/postcss.test.ts proves the sanitizer still works against the stub.',
        "      postcss: { browser: './lib/browser-stubs/postcss.cjs' },",
        '    },',
        '  },',
        '',
      ].join('\n'),
    );

    // The entry is the app's (what a new scaffold inherits), and nothing else in the config moved.
    const after = evaluateConfig(patched);
    expect(after.turbopack.resolveAlias.postcss).toEqual(APP_ALIAS);
    expect(withoutPostcssAlias(after)).toEqual(evaluateConfig(SCAFFOLD_0_23_3));
    // Only lines were added: dropping them gives back the original file.
    const added = patched.split('\n').filter((line) => !SCAFFOLD_0_23_3.split('\n').includes(line));
    expect(added).toHaveLength(4);
    expect(patched.split('\n').filter((line) => !added.includes(line)).join('\n')).toBe(SCAFFOLD_0_23_3);
  });

  it("gives a pre-0.19 scaffold's comment-only turbopack block a resolveAlias holding the entry", () => {
    const result = addPostcssBrowserAlias(SCAFFOLD_0_18_8);

    expect(result.status).toBe('patched');
    expect(result.how).toBe('resolveAlias');
    expect(result.text).toContain(
      [
        '  turbopack: {',
        '    // Turbopack-specific options can be configured here if needed.',
        '    resolveAlias: {',
        '      // Browser bundles only: sanitize-html requires postcss but never calls it with style',
        '      // parsing off, so the client gets an empty module instead of ~18 KB gzipped of postcss.',
        '      // lib/browser-stubs/postcss.test.ts proves the sanitizer still works against the stub.',
        "      postcss: { browser: './lib/browser-stubs/postcss.cjs' },",
        '    },',
        '  },',
      ].join('\n'),
    );
    const after = evaluateConfig(result.text);
    expect(after.turbopack.resolveAlias).toEqual({ postcss: APP_ALIAS });
    expect(withoutPostcssAlias(after)).toEqual(evaluateConfig(SCAFFOLD_0_18_8));
  });

  it('never touches a config that already has the alias: a second run, the app config, a commented-out entry', () => {
    const once = addPostcssBrowserAlias(SCAFFOLD_0_23_3).text;

    expect(addPostcssBrowserAlias(once)).toEqual({ status: 'present' });
    expect(addPostcssBrowserAlias(APP_CONFIG)).toEqual({ status: 'present' });
    const commentedOut = SCAFFOLD_0_23_3.replace(
      "      'y-protocols/awareness': 'y-protocols/awareness.js',\n",
      "      'y-protocols/awareness': 'y-protocols/awareness.js',\n      // postcss: { browser: './lib/browser-stubs/postcss.cjs' },\n",
    );
    expect(commentedOut).not.toBe(SCAFFOLD_0_23_3);
    expect(addPostcssBrowserAlias(commentedOut)).toEqual({ status: 'present' });
  });

  it('keeps CRLF line endings and adds no bare LF', () => {
    for (const fixture of [SCAFFOLD_0_23_3, SCAFFOLD_0_18_8]) {
      const crlf = fixture.replace(/\n/g, '\r\n');
      const result = addPostcssBrowserAlias(crlf);

      expect(result.status).toBe('patched');
      expect(/[^\r]\n/.test(result.text)).toBe(false);
      expect(result.text.replace(/\r\n/g, '\n')).toBe(addPostcssBrowserAlias(fixture).text);
    }
  });

  it('adds the comma a last entry lacks, keeps a trailing comment, and indents with tabs in a tab-indented file', () => {
    const source = [
      'module.exports = {',
      '\tturbopack: {',
      '\t\tresolveAlias: {',
      "\t\t\tunderscore: 'lodash' // keep me",
      '\t\t},',
      '\t},',
      '};',
      '',
    ].join('\n');
    const result = addPostcssBrowserAlias(source);

    expect(result.status).toBe('patched');
    expect(result.text).toContain("\t\t\tunderscore: 'lodash', // keep me\n");
    expect(result.text).toContain(`\t\t\t${POSTCSS_ALIAS_ENTRY}\n\t\t},`);
    expect(evaluateConfig(result.text).turbopack.resolveAlias).toEqual({ underscore: 'lodash', postcss: APP_ALIAS });
  });

  it('reads past comments, strings, templates and regexes that look like the anchors', () => {
    const source = [
      '// turbopack: { resolveAlias: { "decoy": true } }',
      "const note = 'turbopack: { resolveAlias: {';",
      'const tpl = `${"}"} resolveAlias: { ${`nested ${"{"}`}`;',
      'const re = /turbopack: \\{[}]/g;',
      '/** @type {{ resolveAlias?: string }} */',
      'module.exports = {',
      '  env: { NOTE: note, TPL: tpl, RE: re.source },',
      '  turbopack: {',
      "    resolveAlias: { 'y-protocols/awareness': 'y-protocols/awareness.js', 'x': '}'",
      '    },',
      '  },',
      '};',
      '',
    ].join('\n');
    const result = addPostcssBrowserAlias(source);

    expect(result.status).toBe('patched');
    expect(evaluateConfig(result.text).turbopack.resolveAlias).toEqual({
      'y-protocols/awareness': 'y-protocols/awareness.js',
      x: '}',
      postcss: APP_ALIAS,
    });
  });

  it.each([
    ['there is no turbopack block', 'module.exports = { reactStrictMode: true };\n', /no `turbopack: \{ … \}` object/],
    ['turbopack is a variable', 'const turbopack = {\n};\nmodule.exports = {\n  turbopack,\n};\n', /more than once/],
    ['turbopack is set from a reference', 'const base = {};\nmodule.exports = {\n  turbopack: base,\n};\n', /not a `turbopack: \{ … \}` object/],
    ['a later assignment replaces turbopack', 'const c = {\n  turbopack: {\n  },\n};\nc.turbopack = {};\nmodule.exports = c;\n', /more than once/],
    ['turbopack is a quoted key', "module.exports = {\n  'turbopack': {\n  },\n};\n", /in quotes/],
    ['resolveAlias is a quoted key', "module.exports = {\n  turbopack: {\n    'resolveAlias': {\n    },\n  },\n};\n", /in quotes/],
    [
      'resolveAlias sits outside turbopack',
      'module.exports = {\n  experimental: { resolveAlias: {\n  } },\n  turbopack: {\n  },\n};\n',
      /not a `resolveAlias: \{ … \}` object directly inside `turbopack`/,
    ],
    [
      'resolveAlias is nested deeper inside turbopack',
      "module.exports = {\n  turbopack: {\n    rules: { '*.svg': { resolveAlias: {\n    } } },\n  },\n};\n",
      /directly inside `turbopack`/,
    ],
    ['resolveAlias is a reference', 'const a = {};\nmodule.exports = {\n  turbopack: {\n    resolveAlias: a,\n  },\n};\n', /not a `resolveAlias: \{ … \}` object/],
    [
      'there are two resolveAlias keys',
      'module.exports = {\n  turbopack: {\n    resolveAlias: {\n    },\n  },\n  experimental: { turbo: { resolveAlias: {} } },\n};\n',
      /more than once/,
    ],
    [
      'resolveAlias already aliases postcss',
      "module.exports = {\n  turbopack: {\n    resolveAlias: {\n      postcss: 'postcss',\n    },\n  },\n};\n",
      /already says something about postcss/,
    ],
    [
      'resolveAlias spreads another object',
      'const base = {};\nmodule.exports = {\n  turbopack: {\n    resolveAlias: {\n      ...base,\n    },\n  },\n};\n',
      /spreads another object/,
    ],
    ['turbopack spreads another object', 'const base = {};\nmodule.exports = {\n  turbopack: {\n    ...base,\n  },\n};\n', /spreads another object/],
    ['resolveAlias is on one line', "module.exports = {\n  turbopack: {\n    resolveAlias: { a: 'b' },\n  },\n};\n", /written on one line/],
    ['turbopack is an empty one-liner', 'module.exports = {\n  turbopack: {},\n};\n', /written on one line/],
    ['the file is an ES module', 'export default {\n  turbopack: {\n  },\n};\n', /does not parse as a CommonJS script/],
  ])('refuses, and leaves the text alone, when %s', (_label, source, reason) => {
    const result = addPostcssBrowserAlias(source);

    expect(result.status).toBe('no-anchor');
    expect(result.reason).toMatch(reason);
    expect(result).not.toHaveProperty('text');
  });
});

describe('maskNonCode', () => {
  it('blanks comment, string, template and regex bodies at the same offsets and keeps the code', () => {
    const source = "a = 'x{' + `t${b + '}'}u` // c{\n/* d} */ r = /e{/g; f({ g: 1 });\n";
    const masked = maskNonCode(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    // Only the code's letters are left: a, b (inside ${…}), r, the g flag, f, g.
    expect(masked.replace(/[^a-z]/g, '')).toBe('abrgfg');
    expect(masked).toContain("a = '  ' + `");
    expect(masked).toContain("b + ' '"); // the code inside ${…} stays
    expect(masked).toContain('r = /  /g; f({ g: 1 });');
    expect((masked.match(/\{/g) ?? []).length).toBe((masked.match(/\}/g) ?? []).length);
  });

  it('returns null when a comment, string, template or regex never ends', () => {
    for (const source of ['a /* open', "a = 'open\n'", 'a = `open', 'a = `${b`', 'a = (/open\n/)']) {
      expect(maskNonCode(source), source).toBeNull();
    }
  });
});

describe('applyPostcssBrowserAlias', () => {
  const roots = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project directory with a next.config.js (or another config file) and, by default, the stub. */
  function project({ config = SCAFFOLD_0_23_3, configFile = 'next.config.js', stub = true } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-postcss-alias-'));
    roots.push(root);
    if (config !== null) writeFileSync(path.join(root, configFile), config);
    if (stub) {
      mkdirSync(path.join(root, path.dirname(POSTCSS_STUB_PATH)), { recursive: true });
      writeFileSync(path.join(root, POSTCSS_STUB_PATH), 'module.exports = {};\n');
    }
    return root;
  }
  const configBytes = (root, file = 'next.config.js') => readFileSync(path.join(root, file));
  const now = new Date('2026-11-14T12:00:00.000Z');
  const backupDir = (root) => path.join(root, '.nextblock-backup');

  it('patches next.config.js, keeps the old file in a self-ignoring backup, and says so', () => {
    const root = project();
    const result = applyPostcssBrowserAlias(root, { now });

    expect(result).toEqual({
      status: 'patched',
      file: 'next.config.js',
      how: 'entry',
      backup: path.join('.nextblock-backup', '2026-11-14T12-00-00-000Z', 'next.config.js'),
    });
    expect(configBytes(root).toString('utf8')).toBe(addPostcssBrowserAlias(SCAFFOLD_0_23_3).text);
    expect(readFileSync(path.join(root, result.backup), 'utf8')).toBe(SCAFFOLD_0_23_3);
    expect(readFileSync(path.join(backupDir(root), '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    expect(describePostcssBrowserAlias(result)).toEqual([
      { level: 'good', text: `next.config.js: added the postcss browser alias to turbopack.resolveAlias (backup: ${result.backup})` },
    ]);
  });

  it('changes nothing on a second run', () => {
    const root = project();
    applyPostcssBrowserAlias(root, { now });
    const first = configBytes(root);

    const again = applyPostcssBrowserAlias(root, { now: new Date('2026-11-15T12:00:00.000Z') });

    expect(again).toEqual({ status: 'present', file: 'next.config.js' });
    expect(configBytes(root).equals(first)).toBe(true);
    expect(readdirSync(backupDir(root)).filter((name) => name !== '.gitignore')).toEqual(['2026-11-14T12-00-00-000Z']);
    expect(describePostcssBrowserAlias(again)).toEqual([]);
  });

  it('leaves a next.config.js that already has the alias byte for byte alone, with no backup', () => {
    const fresh = addPostcssBrowserAlias(SCAFFOLD_0_23_3).text.replace(/\n/g, '\r\n');
    const root = project({ config: fresh });

    expect(applyPostcssBrowserAlias(root, { now })).toEqual({ status: 'present', file: 'next.config.js' });
    expect(configBytes(root).equals(Buffer.from(fresh, 'utf8'))).toBe(true);
    expect(existsSync(backupDir(root))).toBe(false);
  });

  it('reports what it would do on a dry run and writes nothing', () => {
    const root = project();
    const result = applyPostcssBrowserAlias(root, { dryRun: true, now });

    expect(result).toEqual({ status: 'would-patch', file: 'next.config.js', how: 'entry' });
    expect(configBytes(root).toString('utf8')).toBe(SCAFFOLD_0_23_3);
    expect(existsSync(backupDir(root))).toBe(false);
    expect(describePostcssBrowserAlias(result)).toEqual([
      { level: 'dim', text: 'would add the postcss browser alias to next.config.js (turbopack.resolveAlias)' },
    ]);
  });

  it('never adds the alias without the stub it points at, unless the stub arrives with the update (dry run)', () => {
    const root = project({ stub: false });
    const incoming = project({ config: null });

    expect(applyPostcssBrowserAlias(root, { now })).toEqual({ status: 'no-stub', file: 'next.config.js' });
    expect(configBytes(root).toString('utf8')).toBe(SCAFFOLD_0_23_3);
    expect(applyPostcssBrowserAlias(root, { dryRun: true, incomingDir: incoming }).status).toBe('would-patch');
    expect(describePostcssBrowserAlias({ status: 'no-stub', file: 'next.config.js' })).toEqual([]);
  });

  it('prints the entry to add, and changes nothing, when next.config.js has no safe anchor', () => {
    const config = 'module.exports = { reactStrictMode: true };\n';
    const root = project({ config });
    const result = applyPostcssBrowserAlias(root, { now });

    expect(result).toEqual({ status: 'no-anchor', file: 'next.config.js', reason: 'it has no `turbopack: { … }` object' });
    expect(configBytes(root).toString('utf8')).toBe(config);
    expect(existsSync(backupDir(root))).toBe(false);
    const lines = describePostcssBrowserAlias(result);
    expect(lines[0]).toEqual({
      level: 'warn',
      text: 'next.config.js has no postcss browser alias, and this update cannot add one safely: it has no `turbopack: { … }` object.',
    });
    expect(lines).toContainEqual({ level: 'code', text: "postcss: { browser: './lib/browser-stubs/postcss.cjs' }," });
  });

  it('reports, and never edits, a next.config.ts or next.config.mjs used instead of next.config.js', () => {
    const ts = project({ config: 'export default {\n  turbopack: {\n  },\n};\n', configFile: 'next.config.ts' });
    const result = applyPostcssBrowserAlias(ts, { now });

    expect(result).toEqual({ status: 'no-anchor', file: 'next.config.ts', reason: 'the update only edits next.config.js' });
    expect(describePostcssBrowserAlias(result)[0].text).toMatch(/^next\.config\.ts has no postcss browser alias/);
    expect(existsSync(backupDir(ts))).toBe(false);

    const mjs = project({ config: `export default { turbopack: { resolveAlias: { ${POSTCSS_ALIAS_ENTRY} } } };\n`, configFile: 'next.config.mjs' });
    expect(applyPostcssBrowserAlias(mjs, { now })).toEqual({ status: 'present', file: 'next.config.mjs' });
  });

  it('reports a next.config.js it cannot read, with the entry to add, instead of throwing', () => {
    const root = project({ config: null });
    mkdirSync(path.join(root, 'next.config.js'));
    const result = applyPostcssBrowserAlias(root, { now });

    expect(result).toEqual({ status: 'failed', file: 'next.config.js', reason: 'it could not be read (EISDIR)' });
    const lines = describePostcssBrowserAlias(result);
    expect(lines[0]).toEqual({
      level: 'warn',
      text: 'next.config.js: this update could not add the postcss browser alias: it could not be read (EISDIR).',
    });
    expect(lines).toContainEqual({ level: 'code', text: POSTCSS_ALIAS_ENTRY });
  });

  it('says nothing for a project with no next.config at all', () => {
    const root = project({ config: null });
    const result = applyPostcssBrowserAlias(root, { now });

    expect(result).toEqual({ status: 'no-config', file: 'next.config.js' });
    expect(describePostcssBrowserAlias(result)).toEqual([]);
    expect(describePostcssBrowserAlias(null)).toEqual([]);
  });
});
