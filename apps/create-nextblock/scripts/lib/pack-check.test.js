import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findMissingBinFiles,
  findPackProblems,
  findPackedEnvFiles,
  findUnpackedTemplateFiles,
  isLocalEnvFile,
  isNeverPackedByNpm,
  parsePackedFiles,
  runNpmPackDryRun,
  runNpmPackTarball,
} from './pack-check.js';

// The app's own .gitignore: the sync copies it into the template byte for byte.
const APP_GITIGNORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../nextblock/.gitignore');
const TEMPLATE = 'templates/nextblock-template';

/** What `npm pack --dry-run --json` prints for a tarball holding `paths`. */
const packJson = (paths) =>
  JSON.stringify([
    {
      id: 'create-nextblock@0.0.0',
      name: 'create-nextblock',
      files: paths.map((path) => ({ path, size: 1, mode: 420 })),
    },
  ]);

let root;

async function put(base, rel, content = '') {
  const full = join(base, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pack-check-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isNeverPackedByNpm', () => {
  it('matches what npm-packlist always leaves out, at any depth', () => {
    for (const path of [
      '.gitignore',
      'app/.gitignore',
      '.npmignore',
      'docs/.npmrc',
      '.DS_Store',
      'public/.DS_Store',
      'npm-debug.log',
      '.git',
      'vendor/.git/HEAD',
      'CVS/Entries',
      'lib/.svn/entries',
      'lib/.hg/store',
      'app/.page.tsx.swp',
      '._page.tsx',
      'app/._folder/page.tsx',
      'app/page.tsx.orig',
    ]) {
      expect(isNeverPackedByNpm(path), path).toBe(true);
    }
  });

  it('keeps everything else, gitignore without its dot and dot folders included', () => {
    for (const path of [
      'gitignore',
      '.env.example',
      '.env.docker.example',
      '.dockerignore',
      '.swcrc',
      'public/.gitkeep',
      'app/.well-known/security.txt',
      'build/index.js',
      'logs/route.ts',
      'next-env.d.ts',
    ]) {
      expect(isNeverPackedByNpm(path), path).toBe(false);
    }
  });
});

describe('isLocalEnvFile', () => {
  it('matches .env and .env.<anything> at any depth', () => {
    for (const path of ['.env', '.env.local', '.env.production', 'app/.env.development.local', 'docker-template/.env']) {
      expect(isLocalEnvFile(path), path).toBe(true);
    }
  });

  it('leaves the .example templates and other names alone', () => {
    for (const path of ['.env.example', '.env.docker.example', 'docker-template/.env.docker.example', 'lib/env.ts', 'gitignore']) {
      expect(isLocalEnvFile(path), path).toBe(false);
    }
  });
});

describe('findUnpackedTemplateFiles', () => {
  const templateFiles = ['.env.docker.example', '.env.example', '.gitignore', 'gitignore', 'app/page.tsx'];

  it('reports the env templates the published 0.23.3 tarball left out', () => {
    const packedFiles = ['package.json', 'bin/create-nextblock.js', `${TEMPLATE}/gitignore`, `${TEMPLATE}/app/page.tsx`];

    expect(findUnpackedTemplateFiles({ templateFiles, packedFiles, templatePath: TEMPLATE })).toEqual([
      '.env.docker.example',
      '.env.example',
    ]);
  });

  it('passes once they ship (npm never ships .gitignore, so it is not asked for)', () => {
    const packedFiles = ['.env.docker.example', '.env.example', 'gitignore', 'app/page.tsx'].map(
      (file) => `${TEMPLATE}/${file}`,
    );

    expect(findUnpackedTemplateFiles({ templateFiles, packedFiles, templatePath: TEMPLATE })).toEqual([]);
  });

  it('reports every file of a folder an ignore rule drops', () => {
    expect(
      findUnpackedTemplateFiles({
        templateFiles: ['logs/route.ts', 'build/index.js', 'app/page.tsx'],
        packedFiles: [`${TEMPLATE}/app/page.tsx`],
        templatePath: TEMPLATE,
      }),
    ).toEqual(['build/index.js', 'logs/route.ts']);
  });

  it('looks for each file under the template folder, not at the package root', () => {
    expect(
      findUnpackedTemplateFiles({ templateFiles: ['app/page.tsx'], packedFiles: ['app/page.tsx'], templatePath: TEMPLATE }),
    ).toEqual(['app/page.tsx']);
  });

  it('never asks for a local env file: it must stay out of the tarball', () => {
    expect(
      findUnpackedTemplateFiles({ templateFiles: ['.env', '.env.local'], packedFiles: [], templatePath: TEMPLATE }),
    ).toEqual([]);
  });
});

describe('findPackedEnvFiles', () => {
  it('reports a local env file anywhere in the tarball and lets the .example templates ship', () => {
    expect(
      findPackedEnvFiles([
        `${TEMPLATE}/.env.local`,
        `${TEMPLATE}/.env.example`,
        `${TEMPLATE}/.env.docker.example`,
        'docker-template/.env.docker.example',
        'docker-template/.env',
        'bin/create-nextblock.js',
      ]),
    ).toEqual(['docker-template/.env', `${TEMPLATE}/.env.local`]);
  });
});

describe('parsePackedFiles', () => {
  it("returns npm's file paths with / and without a leading ./", () => {
    const output = JSON.stringify([{ files: [{ path: 'package.json' }, { path: '.\\bin\\create-nextblock.js' }, { path: './README.md' }] }]);

    expect(parsePackedFiles(output)).toEqual(['package.json', 'bin/create-nextblock.js', 'README.md']);
  });

  it('throws on output that is not a file list instead of passing an empty tarball', () => {
    expect(() => parsePackedFiles('npm error code ENOENT')).toThrow(/printed no JSON: npm error code ENOENT/);
    for (const output of ['[]', '{}', '[{}]', JSON.stringify([{ files: [] }])]) {
      expect(() => parsePackedFiles(output), output).toThrow(/listed no files/);
    }
  });
});

describe('runNpmPackDryRun', () => {
  it('runs npm pack --dry-run without lifecycle scripts in the package folder', () => {
    const exec = vi.fn(() => '[]');

    expect(runNpmPackDryRun('/work/create-nextblock', { exec })).toBe('[]');
    expect(exec).toHaveBeenCalledWith(
      'npm pack --dry-run --ignore-scripts --json',
      expect.objectContaining({ cwd: '/work/create-nextblock', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it("names the folder and the end of npm's stderr when npm fails", () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'npm notice\nnpm error code ENOENT\nnpm error syscall open\nnpm error enoent package.json\n',
      });
    });

    expect(() => runNpmPackDryRun('/work/create-nextblock', { exec })).toThrow(
      'npm pack --dry-run --ignore-scripts --json failed in /work/create-nextblock: ' +
        'npm error code ENOENT npm error syscall open npm error enoent package.json',
    );
  });
});

describe('runNpmPackTarball', () => {
  it('asks npm to read the packed tarball itself, running nothing', () => {
    const exec = vi.fn(() => '[]');

    expect(runNpmPackTarball('/work/dist/release/create-nextblock-1.0.0.tgz', { exec })).toBe('[]');
    expect(exec).toHaveBeenCalledWith(
      'npm pack "/work/dist/release/create-nextblock-1.0.0.tgz" --dry-run --ignore-scripts --json',
      expect.objectContaining({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it("names the tarball and the end of npm's stderr when npm cannot read it", () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error('Command failed'), { stderr: 'npm error code TAR_BAD_ARCHIVE\nnpm error Unrecognized archive format\n' });
    });

    expect(() => runNpmPackTarball('/work/x.tgz', { exec })).toThrow(
      'npm pack --dry-run could not read /work/x.tgz: npm error code TAR_BAD_ARCHIVE npm error Unrecognized archive format',
    );
  });
});

describe('findMissingBinFiles', () => {
  it('reports a bin script the tarball lacks, in either bin form', () => {
    expect(findMissingBinFiles({ name: 'create-nextblock', bin: { 'create-nextblock': 'bin/create-nextblock.js' } }, ['package.json'])).toEqual([
      'bin/create-nextblock.js (the `create-nextblock` command) is not in the tarball',
    ]);
    expect(findMissingBinFiles({ name: 'create-nextblock', bin: './bin/cli.js' }, ['package.json'])).toEqual([
      'bin/cli.js (the `create-nextblock` command) is not in the tarball',
    ]);
  });

  it('passes when every bin script ships, or there is none', () => {
    expect(findMissingBinFiles({ bin: { 'create-nextblock': './bin/create-nextblock.js' } }, ['bin/create-nextblock.js'])).toEqual([]);
    expect(findMissingBinFiles({ name: 'x' }, [])).toEqual([]);
  });
});

describe('findPackProblems', () => {
  let packageDir;
  let templateDir;

  beforeEach(async () => {
    packageDir = join(root, 'create-nextblock');
    templateDir = join(packageDir, TEMPLATE);
    await put(packageDir, 'package.json', '{"name":"create-nextblock","version":"0.0.0"}');
    for (const file of ['.env.example', '.env.docker.example', '.gitignore', 'gitignore', 'app/page.tsx']) {
      await put(templateDir, file, 'X=\n');
    }
  });

  it('reports what the 0.23.3 tarball dropped, and asks npm about the package folder', async () => {
    const pack = vi.fn(() => packJson(['package.json', `${TEMPLATE}/gitignore`, `${TEMPLATE}/app/page.tsx`]));

    await expect(findPackProblems({ packageDir, templateDir, pack })).resolves.toEqual([
      expect.stringMatching(/^templates\/nextblock-template\/\.env\.docker\.example is not in the tarball: an ignore rule drops it/),
      expect.stringMatching(/^templates\/nextblock-template\/\.env\.example is not in the tarball: an ignore rule drops it/),
    ]);
    expect(pack).toHaveBeenCalledWith(packageDir);
  });

  it('passes when npm packs the whole template', async () => {
    const pack = () =>
      packJson(['package.json', ...['.env.example', '.env.docker.example', 'gitignore', 'app/page.tsx'].map((f) => `${TEMPLATE}/${f}`)]);

    await expect(findPackProblems({ packageDir, templateDir, pack })).resolves.toEqual([]);
  });

  it('reports a local env file npm would publish (the template without its .gitignore)', async () => {
    await put(templateDir, '.env.local', 'SUPABASE_SECRET_KEY=x\n');
    const pack = () =>
      packJson([
        'package.json',
        ...['.env.example', '.env.docker.example', '.env.local', 'gitignore', 'app/page.tsx'].map((f) => `${TEMPLATE}/${f}`),
      ]);

    await expect(findPackProblems({ packageDir, templateDir, pack })).resolves.toEqual([
      'templates/nextblock-template/.env.local would be published: only *.example env files may ship',
    ]);
  });

  it('refuses a template outside the package', async () => {
    await expect(
      findPackProblems({ packageDir: templateDir, templateDir: packageDir, pack: () => packJson(['package.json']) }),
    ).rejects.toThrow(/is not inside the package/);
  });
});

// The fix and its proof in one: npm itself packs a stand-in for create-nextblock whose template
// carries the app's real .gitignore, exactly as the sync copies it. Losing a negation there, or a
// new rule that drops a template file, fails here instead of in a published tarball.
describe('npm pack with the real apps/nextblock/.gitignore', () => {
  async function packFixture(gitignore) {
    const packageDir = join(root, 'cli');
    const templateDir = join(packageDir, TEMPLATE);
    await put(packageDir, 'package.json', JSON.stringify({ name: 'pack-check-fixture', version: '0.0.0', private: true }));
    await put(templateDir, '.gitignore', gitignore);
    for (const file of ['.env.example', '.env.docker.example', 'gitignore', 'app/page.tsx']) {
      await put(templateDir, file, 'NEXT_PUBLIC_URL=\n');
    }
    // A developer's local env files, which the sync's copy of apps/nextblock would carry along.
    for (const file of ['.env', '.env.local', '.env.production']) {
      await put(templateDir, file, 'SUPABASE_SECRET_KEY=not-a-real-key\n');
    }
    const output = runNpmPackDryRun(packageDir);
    return {
      packed: parsePackedFiles(output),
      problems: await findPackProblems({ packageDir, templateDir, pack: () => output }),
    };
  }

  it('ships both env templates and keeps local env files and .gitignore out', async () => {
    const { packed, problems } = await packFixture(await readFile(APP_GITIGNORE, 'utf8'));

    expect(packed).toEqual(
      expect.arrayContaining(['.env.example', '.env.docker.example', 'gitignore', 'app/page.tsx'].map((f) => `${TEMPLATE}/${f}`)),
    );
    for (const file of ['.env', '.env.local', '.env.production', '.gitignore']) {
      expect(packed, file).not.toContain(`${TEMPLATE}/${file}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  // release:all publishes the packed file without a prepack, so check-tarball.js reads it back.
  it('reads a really packed tarball back, and notices a template file added after packing', async () => {
    const packageDir = join(root, 'cli');
    const templateDir = join(packageDir, TEMPLATE);
    await put(packageDir, 'package.json', JSON.stringify({ name: 'pack-check-fixture', version: '1.0.0', bin: { fixture: 'bin/cli.js' } }));
    await put(packageDir, 'bin/cli.js', '#!/usr/bin/env node\n');
    await put(templateDir, '.gitignore', await readFile(APP_GITIGNORE, 'utf8'));
    for (const file of ['.env.example', 'gitignore', 'app/page.tsx']) await put(templateDir, file, 'X=\n');
    const out = join(root, 'out');
    await mkdir(out);
    const [report] = JSON.parse(
      execSync(`npm pack --ignore-scripts --json --pack-destination "${out}"`, { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    const output = runNpmPackTarball(join(out, report.filename));
    const packed = parsePackedFiles(output);
    expect(packed).toEqual(expect.arrayContaining(['bin/cli.js', `${TEMPLATE}/.env.example`, `${TEMPLATE}/app/page.tsx`]));
    await expect(findPackProblems({ packageDir, templateDir, pack: () => output })).resolves.toEqual([]);

    await put(templateDir, 'app/late.tsx', 'export {};\n');
    await expect(findPackProblems({ packageDir, templateDir, pack: () => output })).resolves.toEqual([
      expect.stringMatching(/^templates\/nextblock-template\/app\/late\.tsx is not in the tarball/),
    ]);
  }, 120_000);

  it('catches the 0.23.3 tarball: without the negations npm drops both env templates', async () => {
    const withoutNegations = (await readFile(APP_GITIGNORE, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('!'))
      .join('\n');

    const { problems } = await packFixture(withoutNegations);

    expect(problems).toEqual([
      expect.stringMatching(/^templates\/nextblock-template\/\.env\.docker\.example is not in the tarball/),
      expect.stringMatching(/^templates\/nextblock-template\/\.env\.example is not in the tarball/),
    ]);
  }, 120_000);
});
