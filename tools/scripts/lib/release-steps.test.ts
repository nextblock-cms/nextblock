import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The side effects release:all is careful about: how `npm publish` runs (never piped, the
// tarball, the npmjs pin), the version-stamp restore, the tarball integrity check and the
// registry check. Nothing here runs npm, Nx or the network: every command goes to a fake exec.
const steps = require('./release-steps.js');
const {
  PUBLISH_EXEC_OPTIONS,
  STAGING_DIR,
  checkTarball,
  finalizeDistPackageJson,
  integrityOf,
  isPublished,
  packCommand,
  packDirectory,
  prepareStaging,
  publishCommand,
  publishTarball,
  publishedIntegrity,
  snapshotFiles,
  snapshotStamps,
  workspaceRoot,
} = steps;
const { TEMPLATE_PACKAGE_JSON } = require('./release-pipeline.js');

const tarball = path.join(STAGING_DIR, 'nextblock-cms-utils-0.23.6.tgz');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-steps-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('publishing a tarball', () => {
  it('publishes the packed file, public, with no lifecycle script and npmjs pinned for the scope too', () => {
    expect(publishCommand(tarball)).toBe(
      'npm publish "./dist/release/nextblock-cms-utils-0.23.6.tgz" --access public --ignore-scripts ' +
        '--registry=https://registry.npmjs.org/ --@nextblock-cms:registry=https://registry.npmjs.org/',
    );
  });

  it('adds --dry-run only when asked', () => {
    expect(publishCommand(tarball, { dryRun: true })).toMatch(/ --dry-run$/);
    expect(publishCommand(tarball, { dryRun: false })).not.toContain('--dry-run');
  });

  // npm's browser approval (auth-type web) prints a link and waits on the terminal: a piped
  // publish fails with EOTP, and captured output would hide the link.
  it('runs npm on the terminal itself, never piped, from the workspace root', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exec = vi.fn();

    publishTarball(tarball, { exec });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(publishCommand(tarball), { cwd: workspaceRoot, stdio: 'inherit', shell: true });
    expect(PUBLISH_EXEC_OPTIONS.stdio).toBe('inherit');
    expect(Object.isFrozen(PUBLISH_EXEC_OPTIONS)).toBe(true);
  });

  it('lets a failed publish throw', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exec = vi.fn(() => {
      throw new Error('Command failed: npm publish');
    });
    expect(() => publishTarball(tarball, { exec })).toThrow('Command failed: npm publish');
  });
});

describe('checkTarball', () => {
  function packed(content: string) {
    const file = path.join(tmp, 'create-nextblock-0.23.6.tgz');
    fs.writeFileSync(file, content);
    return { name: 'create-nextblock', version: '0.23.6', tarball: path.basename(file), integrity: integrityOf(file) };
  }

  it('computes the integrity npm reports (sha512, base64)', () => {
    const file = path.join(tmp, 'a.tgz');
    fs.writeFileSync(file, 'tarball bytes');
    expect(integrityOf(file)).toBe(`sha512-${crypto.createHash('sha512').update('tarball bytes').digest('base64')}`);
  });

  it('passes the tarball phase 1 packed', () => {
    expect(() => checkTarball(packed('original'), { stagingDir: tmp })).not.toThrow();
  });

  it('refuses a tarball that changed or went missing since it was packed', () => {
    const entry = packed('original');
    fs.writeFileSync(path.join(tmp, entry.tarball), 'rebuilt');
    expect(() => checkTarball(entry, { stagingDir: tmp })).toThrow(/changed after it was packed/);
    fs.rmSync(path.join(tmp, entry.tarball));
    expect(() => checkTarball(entry, { stagingDir: tmp })).toThrow(/is missing/);
  });

  it('refuses a manifest entry that points outside the staging folder', () => {
    const entry = { ...packed('original'), tarball: '../elsewhere.tgz' };
    expect(() => checkTarball(entry, { stagingDir: tmp })).toThrow(/names no tarball inside/);
  });
});

describe('snapshotFiles', () => {
  it('puts back the exact bytes of every file it changed, removes what did not exist, and lists them', () => {
    const crlf = Buffer.from('{\r\n  "version": "0.23.5"\r\n}\r\n');
    fs.mkdirSync(path.join(tmp, 'libs/utils'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'libs/utils/package.json'), crlf);
    fs.writeFileSync(path.join(tmp, 'package.json'), 'untouched');
    const snapshot = snapshotFiles(['libs/utils/package.json', 'package.json', 'libs/utils/package-lock.json'], { root: tmp });

    fs.writeFileSync(path.join(tmp, 'libs/utils/package.json'), '{\n  "version": "0.23.6"\n}\n');
    fs.writeFileSync(path.join(tmp, 'libs/utils/package-lock.json'), '{}');

    expect(snapshot.restore()).toEqual(['libs/utils/package.json', 'libs/utils/package-lock.json']);
    expect(fs.readFileSync(path.join(tmp, 'libs/utils/package.json')).equals(crlf)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'libs/utils/package-lock.json'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).toBe('untouched');
    expect(snapshot.restore()).toEqual([]);
  });

  it('recreates a file that was deleted (the template sync empties its folder first)', () => {
    fs.mkdirSync(path.join(tmp, 'template'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'template/package.json'), '{"version":"0.23.5"}');
    const snapshot = snapshotFiles(['template/package.json'], { root: tmp });
    fs.rmSync(path.join(tmp, 'template'), { recursive: true });

    expect(snapshot.restore()).toEqual(['template/package.json']);
    expect(fs.readFileSync(path.join(tmp, 'template/package.json'), 'utf8')).toBe('{"version":"0.23.5"}');
  });
});

// The template sync rewrites the template's package.json whole (dependencies from the root and the
// app, docker scripts, the standalone marker). Putting its old bytes back after a rehearsal or a
// failed phase 1 undid that sync for this one file while the rest of the template stayed synced.
describe('snapshotFiles versionOnly (the template package.json)', () => {
  const write = (rel: string, value: unknown, eol = '\n') => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), JSON.stringify(value, null, 2).replace(/\n/g, eol) + eol);
  };
  const read = (rel: string) => fs.readFileSync(path.join(tmp, rel), 'utf8');
  const before = { name: 'nextblock-template', version: '0.23.5', dependencies: { next: '16.0.0' } };
  const synced = { name: 'nextblock-template', version: '0.23.6', dependencies: { next: '16.1.0', zod: '4.1.0' }, scripts: { 'docker:up': 'docker compose up -d --build' } };

  it('gives back only the version, keeping what the sync wrote, in its formatting', () => {
    write('t/package.json', before);
    const snapshot = snapshotFiles(['t/package.json'], { root: tmp, versionOnly: ['t/package.json'] });
    write('t/package.json', synced);

    expect(snapshot.restore()).toEqual(['t/package.json']);
    expect(read('t/package.json')).toBe(JSON.stringify({ ...synced, version: '0.23.5' }, null, 2) + '\n');
    expect(snapshot.restore()).toEqual([]);
  });

  it('keeps CRLF line endings, and leaves a file whose version already matches', () => {
    write('t/package.json', before);
    const snapshot = snapshotFiles(['t/package.json'], { root: tmp, versionOnly: ['t/package.json'] });
    write('t/package.json', synced, '\r\n');
    snapshot.restore();
    expect(read('t/package.json')).toBe(JSON.stringify({ ...synced, version: '0.23.5' }, null, 2).replace(/\n/g, '\r\n') + '\r\n');

    write('t/package.json', { ...synced, version: '0.23.5' });
    expect(snapshot.restore()).toEqual([]);
  });

  it('puts the old bytes back when the file is gone or not JSON', () => {
    write('t/package.json', before);
    const original = read('t/package.json');
    const snapshot = snapshotFiles(['t/package.json'], { root: tmp, versionOnly: ['t/package.json'] });

    fs.rmSync(path.join(tmp, 't/package.json'));
    expect(snapshot.restore()).toEqual(['t/package.json']);
    expect(read('t/package.json')).toBe(original);

    fs.writeFileSync(path.join(tmp, 't/package.json'), '{ half written');
    expect(snapshot.restore()).toEqual(['t/package.json']);
    expect(read('t/package.json')).toBe(original);
  });

  it('snapshotStamps applies it to the template package.json only', () => {
    write('libs/utils/package.json', { name: '@nextblock-cms/utils', version: '0.23.5' });
    write(TEMPLATE_PACKAGE_JSON, before);
    const libBefore = read('libs/utils/package.json');
    const snapshot = snapshotStamps(['libs/utils/package.json', TEMPLATE_PACKAGE_JSON], { root: tmp });
    write('libs/utils/package.json', { name: '@nextblock-cms/utils', version: '0.23.6', extra: true });
    write(TEMPLATE_PACKAGE_JSON, synced);

    expect(snapshot.restore()).toEqual(['libs/utils/package.json', TEMPLATE_PACKAGE_JSON]);
    expect(read('libs/utils/package.json')).toBe(libBefore);
    expect(JSON.parse(read(TEMPLATE_PACKAGE_JSON))).toEqual({ ...synced, version: '0.23.5' });
  });
});

describe('packDirectory', () => {
  // `npm run build:<lib> --dry-run` exports npm_config_dry_run=true, and an `npm pack` that
  // inherits it reports a tarball it never writes: every release dry run of a lib failed that way.
  it('packs with --dry-run=false, whatever the environment says', () => {
    expect(packCommand('/out')).toBe('npm pack --ignore-scripts --json --dry-run=false --pack-destination "/out"');
  });

  const report = (filename: string) =>
    JSON.stringify([{ name: '@nextblock-cms/utils', version: '0.23.6', filename, integrity: 'sha512-x', size: 10, entryCount: 2, files: [{ path: 'package.json' }, { path: './index.es.js' }] }]);

  it("returns npm's report of the tarball it wrote", () => {
    const destination = path.join(tmp, 'out');
    const exec = vi.fn(() => {
      fs.writeFileSync(path.join(destination, 'nextblock-cms-utils-0.23.6.tgz'), 'tgz');
      return report('nextblock-cms-utils-0.23.6.tgz');
    });

    const packed = packDirectory(tmp, destination, { exec });

    expect(exec).toHaveBeenCalledWith(packCommand(destination), expect.objectContaining({ cwd: tmp }));
    expect(packed).toMatchObject({ name: '@nextblock-cms/utils', version: '0.23.6', entryCount: 2, files: ['package.json', 'index.es.js'] });
    expect(packed.tarballPath).toBe(path.join(destination, 'nextblock-cms-utils-0.23.6.tgz'));
  });

  it('refuses a report whose tarball is not on disk', () => {
    const exec = vi.fn(() => report('nextblock-cms-utils-0.23.6.tgz'));
    expect(() => packDirectory(tmp, path.join(tmp, 'out'), { exec })).toThrow(/npm pack reported nextblock-cms-utils-0\.23\.6\.tgz, but .* is missing/);
  });
});

describe('isPublished', () => {
  const view = (result: { stdout?: string; error?: Record<string, string> }) =>
    vi.fn(async () => {
      if (result.error) throw Object.assign(new Error('Command failed'), result.error);
      return { stdout: result.stdout ?? '', stderr: '' };
    });

  it('asks npm for the exact version, on npmjs', async () => {
    const exec = view({ stdout: '0.23.6\n' });
    await expect(isPublished('@nextblock-cms/utils', '0.23.6', { exec })).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'npm view @nextblock-cms/utils@0.23.6 version --registry=https://registry.npmjs.org/ --@nextblock-cms:registry=https://registry.npmjs.org/',
      expect.objectContaining({ cwd: workspaceRoot }),
    );
  });

  it('answers false when npm has no such version or package (E404)', async () => {
    const exec = view({ error: { stderr: 'npm error code E404\nnpm error 404 No match found for version 0.23.6\n' } });
    await expect(isPublished('@nextblock-cms/utils', '0.23.6', { exec })).resolves.toBe(false);
  });

  it('throws when npm cannot be asked, instead of guessing', async () => {
    const exec = view({ error: { stderr: 'npm error code ETIMEDOUT\nnpm error network request failed\n' } });
    await expect(isPublished('@nextblock-cms/utils', '0.23.6', { exec })).rejects.toThrow(
      /Could not ask npm whether @nextblock-cms\/utils@0\.23\.6 is published: .*ETIMEDOUT/,
    );
  });

  it('does not take another version on the line for this one', async () => {
    await expect(isPublished('@nextblock-cms/utils', '0.23.6', { exec: view({ stdout: '0.23.60\n' }) })).resolves.toBe(false);
  });
});

// release-lib.js and release-cli.js compare this with their own tarball after a failed publish:
// existence alone cannot tell this run's upload from a version npm had before.
describe('publishedIntegrity', () => {
  const INTEGRITY = 'sha512-VfQBPWcVekCw28t+oHXh71/DCHP1XvKyexW7REp1I6tlNiv+8NpglxXBSwdxnujNX3ZtZGfUIkHKg32fbxgvBg==';
  const view = (result: { stdout?: string; error?: Record<string, string> }) =>
    vi.fn(async () => {
      if (result.error) throw Object.assign(new Error('Command failed'), result.error);
      return { stdout: result.stdout ?? '', stderr: '' };
    });

  it('asks npm for the exact version’s dist.integrity, on npmjs, and reads it as npm prints it', async () => {
    const exec = view({ stdout: `${INTEGRITY}\n` });
    await expect(publishedIntegrity('create-nextblock', '0.23.5', { exec })).resolves.toBe(INTEGRITY);
    expect(exec).toHaveBeenCalledWith(
      'npm view create-nextblock@0.23.5 dist.integrity --registry=https://registry.npmjs.org/ --@nextblock-cms:registry=https://registry.npmjs.org/',
      expect.objectContaining({ cwd: workspaceRoot }),
    );
    await expect(publishedIntegrity('create-nextblock', '0.23.5', { exec: view({ stdout: `'${INTEGRITY}'\n` }) })).resolves.toBe(INTEGRITY);
  });

  it('answers null when npm has no such version or package (E404), or prints nothing', async () => {
    const e404 = view({ error: { stderr: 'npm error code E404\nnpm error 404 No match found for version 99.99.99\n' } });
    await expect(publishedIntegrity('create-nextblock', '99.99.99', { exec: e404 })).resolves.toBeNull();
    await expect(publishedIntegrity('create-nextblock', '99.99.99', { exec: view({ stdout: '\n' }) })).resolves.toBeNull();
  });

  it('throws when npm cannot be asked, instead of guessing', async () => {
    const exec = view({ error: { stderr: 'npm error code ETIMEDOUT\nnpm error network request failed\n' } });
    await expect(publishedIntegrity('create-nextblock', '0.23.6', { exec })).rejects.toThrow(
      /Could not ask npm which tarball it serves as create-nextblock@0\.23\.6: .*ETIMEDOUT/,
    );
  });
});

describe('prepareStaging', () => {
  it('empties a folder under dist/ only', () => {
    const outside = path.join(tmp, 'staging');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    expect(() => prepareStaging(outside)).toThrow(/Refusing to empty/);
    expect(() => prepareStaging(path.dirname(STAGING_DIR))).toThrow(/Refusing to empty/);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);

    const inside = path.join(path.dirname(STAGING_DIR), `release-steps-test-${process.pid}`);
    try {
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, 'old.tgz'), 'x');
      prepareStaging(inside);
      expect(fs.readdirSync(inside)).toEqual([]);
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
    }
  });
});

describe('finalizeDistPackageJson (premium libs)', () => {
  it('writes the entry points and exports, resolves sibling workspace specs, and drops nx', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manifestPath = path.join(tmp, 'package.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: '@nextblock-cms/cortex',
        version: '0.23.6',
        nx: { tags: ['scope:premium'] },
        dependencies: { '@nextblock-cms/db': 'workspace:*', '@nextblock-cms/ecommerce': 'workspace:*', zod: '^4.0.0' },
        peerDependencies: { '@nextblock-cms/utils': 'workspace:^' },
      }),
    );
    const exportsMap = { '.': { import: './index.es.js' } };

    finalizeDistPackageJson(manifestPath, 'cortex', exportsMap);

    const version = (lib: string) => JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'libs', lib, 'package.json'), 'utf8')).version;
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(pkg).toMatchObject({
      main: './index.cjs',
      module: './index.es.js',
      types: './index.d.ts',
      exports: exportsMap,
      publishConfig: { access: 'public' },
      dependencies: {
        '@nextblock-cms/db': `^${version('db')}`,
        '@nextblock-cms/ecommerce': `npm:@nextblock-cms/ecom@^${version('ecommerce')}`,
        zod: '^4.0.0',
      },
      peerDependencies: { '@nextblock-cms/utils': `^${version('utils')}` },
    });
    expect(pkg.nx).toBeUndefined();
  });
});
