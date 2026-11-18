import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The plan and the failure handling of release:all, with fake steps: nothing here runs npm, Nx or
// the network. The real steps are in release-steps.js (release-steps.test.ts).
const pipeline = require('./release-pipeline.js');
const {
  BUILD_ORDER,
  LIBS,
  RELEASE_PACKAGES,
  STAMPED_DIRS,
  STAMPED_FILES,
  TEMPLATE_PACKAGE_JSON,
  UsageError,
  createManifest,
  describeDryRun,
  describePublishFailure,
  parseReleaseArgs,
  parseSingleReleaseArgs,
  planRelease,
  refuseKeywordPastUnfinishedRelease,
  resolveReleaseVersion,
  runBuildPhase,
  runPublishPhase,
  settleSingleReleaseFailure,
  tarballFileName,
  validateManifest,
} = pipeline;

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '0.23.6';
const PUBLISH_ORDER = [
  '@nextblock-cms/utils',
  '@nextblock-cms/ui',
  '@nextblock-cms/sdk',
  '@nextblock-cms/db',
  '@nextblock-cms/editor',
  '@nextblock-cms/ecom',
  '@nextblock-cms/cortex',
  '@nextblock-cms/affiliates',
  'create-nextblock',
];

type Pkg = { id: string; kind: string; name: string; dir: string; version?: string; skip?: boolean };
type Entry = { id: string; kind: string; name: string; version: string; tarball?: string; integrity?: string; skipped?: string };

const artifactFor = (pkg: Pkg, version = VERSION) => ({
  name: pkg.name,
  version,
  filename: tarballFileName(pkg.name, version),
  integrity: `sha512-${pkg.id}`,
  size: 100,
  entryCount: 10,
});

/** Fake phase 1 steps that record every call, in order, into `events`. */
function fakeBuildSteps(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const restore = vi.fn(() => {
    events.push('restore');
    return ['libs/utils/package.json'];
  });
  const steps = {
    snapshotStamps: vi.fn(() => {
      events.push('snapshot');
      return { restore };
    }),
    prepareStaging: vi.fn(() => events.push('prepare')),
    stamp: vi.fn((dir: string, version: string) => events.push(`stamp ${dir} ${version}`)),
    buildCli: vi.fn((pkg: Pkg) => {
      events.push(`build ${pkg.name}`);
      return artifactFor(pkg);
    }),
    buildLib: vi.fn((pkg: Pkg) => {
      events.push(`build ${pkg.name}`);
      return artifactFor(pkg);
    }),
    writeManifest: vi.fn(() => events.push('manifest')),
    now: () => '2026-11-17T20:00:00.000Z',
    ...overrides,
  };
  return { steps, events, restore };
}

/** A manifest as phase 1 writes it for `plan`. */
function manifestFor(plan: Pkg[], extra: Record<string, unknown> = {}) {
  const artifacts = new Map(plan.filter((pkg) => !pkg.skip).map((pkg) => [pkg.id, artifactFor(pkg)]));
  return { ...createManifest({ version: VERSION, rehearsal: false, createdAt: 'now', plan, artifacts }), ...extra };
}

/** Fake phase 2 steps; `published` lists the names npm already has. */
function fakePublishSteps({ published = [] as string[], failPublish = {} as Record<string, string>, ...overrides } = {}) {
  const events: string[] = [];
  const onNpm = new Set(published);
  const steps = {
    checkTarball: vi.fn((entry: Entry) => events.push(`check ${entry.name}`)),
    whoami: vi.fn(() => {
      events.push('whoami');
      return 'nextblockcms';
    }),
    isPublished: vi.fn(async (name: string) => {
      events.push(`view ${name}`);
      return onNpm.has(name);
    }),
    publish: vi.fn((entry: Entry, { dryRun }: { dryRun: boolean }) => {
      events.push(`publish ${entry.name}${dryRun ? ' --dry-run' : ''}`);
      if (failPublish[entry.name]) throw new Error(failPublish[entry.name]);
    }),
    ...overrides,
  };
  return { steps, events, onNpm };
}

describe('the release plan', () => {
  it('publishes the libs in dependency order, then the CLI', () => {
    expect(RELEASE_PACKAGES.map((pkg: Pkg) => pkg.name)).toEqual(PUBLISH_ORDER);
    expect(planRelease(VERSION).map((pkg: Pkg) => [pkg.name, pkg.version, pkg.skip])).toEqual(
      PUBLISH_ORDER.map((name) => [name, VERSION, false]),
    );
  });

  // npm resolves a lib's siblings from the registry, so each must be out before the lib that
  // imports it; a new import that breaks the order fails here instead of in a release.
  it('puts every sibling a lib imports or declares before that lib', () => {
    const position = new Map(LIBS.map((lib: string, index: number) => [lib, index]));
    const isTest = (file: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split(path.sep).includes('__tests__');
    const sourceFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.[cm]?[jt]sx?$/.test(entry.name) && !isTest(full) ? [full] : [];
      });
    const problems: string[] = [];
    for (const lib of LIBS) {
      const used = new Set<string>();
      for (const file of sourceFiles(path.join(REPO_ROOT, 'libs', lib, 'src'))) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@nextblock-cms\/([a-z-]+)/g)) {
          used.add(match[1]);
        }
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'libs', lib, 'package.json'), 'utf8'));
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(manifest[section] ?? {})) {
          if (name.startsWith('@nextblock-cms/')) used.add(name.slice('@nextblock-cms/'.length));
        }
      }
      for (const sibling of used) {
        const folder = sibling === 'ecom' ? 'ecommerce' : sibling;
        if (folder === lib) continue;
        const siblingAt = position.get(folder);
        if (siblingAt === undefined) problems.push(`${lib} uses @nextblock-cms/${sibling}, which release:all does not publish`);
        else if (siblingAt > (position.get(lib) ?? -1)) problems.push(`${lib} uses ${folder}, which publishes after it`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('builds the CLI first (its template sync fails fastest), then the libs in publish order', () => {
    expect(BUILD_ORDER.map((pkg: Pkg) => pkg.name)).toEqual(['create-nextblock', ...PUBLISH_ORDER.slice(0, -1)]);
  });

  it('marks what npm already has as skipped, nothing else', () => {
    const plan = planRelease(VERSION, new Set(['@nextblock-cms/utils', 'create-nextblock']));
    expect(plan.filter((pkg: Pkg) => pkg.skip).map((pkg: Pkg) => pkg.name)).toEqual(['@nextblock-cms/utils', 'create-nextblock']);
  });

  it('stamps every lib, the root, the app and the CLI, and restores their lockfiles and the template manifest too', () => {
    expect(STAMPED_DIRS).toEqual([...LIBS.map((lib: string) => `libs/${lib}`), '.', 'apps/nextblock', 'apps/create-nextblock']);
    expect(STAMPED_FILES).toEqual(
      expect.arrayContaining([
        'libs/ecommerce/package.json',
        'libs/ecommerce/package-lock.json',
        'package.json',
        'package-lock.json',
        'apps/nextblock/package.json',
        'apps/create-nextblock/package.json',
        'apps/create-nextblock/package-lock.json',
        TEMPLATE_PACKAGE_JSON,
      ]),
    );
    for (const file of STAMPED_FILES.filter((entry: string) => entry.endsWith('package.json'))) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    }
  });

  it('names tarballs the way npm pack does', () => {
    expect(tarballFileName('@nextblock-cms/ecom', '1.2.3')).toBe('nextblock-cms-ecom-1.2.3.tgz');
    expect(tarballFileName('create-nextblock', '1.2.3')).toBe('create-nextblock-1.2.3.tgz');
  });
});

describe('parseReleaseArgs', () => {
  it('reads the version and the mode flags', () => {
    expect(parseReleaseArgs(['0.23.6'])).toEqual({
      versionSpec: '0.23.6',
      dryRun: false,
      rehearse: false,
      buildOnly: false,
      publishOnly: false,
      fromNpmConfig: [],
    });
    expect(parseReleaseArgs(['--publish-only', '0.23.6', '--rehearse'])).toMatchObject({ publishOnly: true, rehearse: true });
    expect(parseReleaseArgs(['patch', '--dry-run'])).toMatchObject({ versionSpec: 'patch', dryRun: true });
  });

  it('refuses an unknown option instead of ignoring it (a mistyped --dry-run used to publish)', () => {
    expect(() => parseReleaseArgs(['0.23.6', '--dryrun'])).toThrow(UsageError);
    expect(() => parseReleaseArgs(['0.23.6', '-n'])).toThrow(/Unknown option -n/);
  });

  it('needs exactly one version', () => {
    expect(() => parseReleaseArgs([])).toThrow(/Missing <version>/);
    expect(() => parseReleaseArgs(['0.23.6', '0.23.7'])).toThrow(/one version/);
    expect(() => parseReleaseArgs(['0.23'])).toThrow(/not a version/);
  });

  // npm 11 refuses a pre-release publish without --tag (after a whole phase 1), npm 10 tagged it
  // `latest`, and a published create-nextblock installs the libs at `latest` anyway.
  it('refuses a pre-release, as a keyword or an explicit version, and says why', () => {
    for (const spec of ['prerelease', 'prepatch', '0.24.0-rc.0', '0.24.0-rc.0+b1']) {
      expect(() => parseReleaseArgs([spec]), spec).toThrow(/is a pre-release version, which the release scripts do not publish/);
    }
    expect(() => parseReleaseArgs(['0.24.0-rc.0'])).toThrow(/installs the libs at `latest`/);
  });

  // npm needs no dist-tag for build metadata: `npm version` and `npm publish` drop it, so phase 1
  // would pack 0.23.6 for a run asked to release 0.23.6+build.1.
  it('refuses build metadata for its own reason, naming the version to pass', () => {
    expect(() => parseReleaseArgs(['0.23.6+build.1'])).toThrow('"0.23.6+build.1" carries build metadata, which npm drops (`npm version` writes 0.23.6): pass 0.23.6.');
    expect(() => parseReleaseArgs(['0.23.6+build.1'])).not.toThrow(/dist-tag/);
  });

  // Phase 1 leaves the checkout stamped at the release version, so `patch` would name the next one.
  it('refuses a bump keyword with --publish-only', () => {
    expect(() => parseReleaseArgs(['patch', '--publish-only'])).toThrow(/--publish-only publishes the build in dist\/release: pass the version phase 1 stamped/);
    expect(() => parseReleaseArgs(['minor'], { npm_config_publish_only: 'true' })).toThrow(UsageError);
    expect(parseReleaseArgs(['0.23.6', '--publish-only'])).toMatchObject({ versionSpec: '0.23.6', publishOnly: true });
  });

  // `npm run release:all -- 0.23.6 --dry-run` in Windows PowerShell loses `--`; npm keeps the flags.
  it('honours the flags npm kept for itself and exported as npm_config_*', () => {
    const env = { npm_config_dry_run: 'true', npm_config_build_only: 'true', npm_config_rehearse: 'false' };
    expect(parseReleaseArgs(['0.23.6'], env)).toMatchObject({
      dryRun: true,
      buildOnly: true,
      rehearse: false,
      fromNpmConfig: ['--dry-run', '--build-only'],
    });
    expect(parseReleaseArgs(['0.23.6', '--dry-run'], { npm_config_dry_run: 'true' }).fromNpmConfig).toEqual([]);
  });

  it('refuses modes that exclude each other', () => {
    expect(() => parseReleaseArgs(['0.23.6', '--build-only', '--publish-only'])).toThrow(/exclude each other/);
    expect(() => parseReleaseArgs(['0.23.6', '--rehearse', '--build-only'])).toThrow(/publishes nothing to rehearse/);
  });
});

describe('resolveReleaseVersion', () => {
  const aligned = { 'libs/utils': '0.23.5', '.': '0.23.5', 'apps/create-nextblock': '0.23.5' };

  it('keeps an explicit version, and refuses a pre-release one', () => {
    expect(resolveReleaseVersion('0.24.1', { a: '1.0.0', b: '2.0.0' })).toBe('0.24.1');
    expect(() => resolveReleaseVersion('0.24.0-rc.1', aligned)).toThrow(/pre-release/);
  });

  it('applies a bump keyword once, to the version every package shares', () => {
    expect(resolveReleaseVersion('patch', aligned)).toBe('0.23.6');
    expect(resolveReleaseVersion('minor', aligned)).toBe('0.24.0');
    expect(resolveReleaseVersion('major', aligned)).toBe('1.0.0');
  });

  it('refuses a keyword when the packages disagree or the shared version is not plain', () => {
    expect(() => resolveReleaseVersion('patch', { ...aligned, 'libs/ui': '0.23.4' })).toThrow(/they differ \(.*libs\/ui 0\.23\.4/);
    // A Ctrl+C while phase 1 stamps (a rehearsal's included) leaves the folders uneven.
    expect(() => resolveReleaseVersion('patch', { ...aligned, 'libs/ui': '0.23.6' })).toThrow(/if a run stopped while stamping, a rehearsal included, put its version lines back first/);
    expect(() => resolveReleaseVersion('patch', { a: '0.24.0-rc.1' })).toThrow(/not a plain x\.y\.z version/);
  });
});

describe('refuseKeywordPastUnfinishedRelease', () => {
  const answers = (overrides: Record<string, boolean | null> = {}) =>
    new Map<string, boolean | null>(PUBLISH_ORDER.map((name) => [name, Object.hasOwn(overrides, name) ? overrides[name] : true]));

  it('lets a keyword bump a version npm has for every package', () => {
    expect(() => refuseKeywordPastUnfinishedRelease('patch', '0.23.5', answers())).not.toThrow();
  });

  // A real phase 1 leaves every package stamped and phase 2 never restores: `patch` re-run after a
  // stopped 0.23.6 used to release all of 0.23.7 and leave 0.23.6 half published.
  it('refuses a keyword while npm lacks the stamped version of any package, and names the resume command', () => {
    const run = () => refuseKeywordPastUnfinishedRelease('patch', '0.23.6', answers({ '@nextblock-cms/sdk': false, 'create-nextblock': false }));
    expect(run).toThrow(UsageError);
    expect(run).toThrow(/"patch" would bump past 0\.23\.6: .*npm does not have it for @nextblock-cms\/sdk, create-nextblock\./);
    expect(run).toThrow(/node tools\/scripts\/release-all\.js 0\.23\.6`/);
  });

  // An interrupted --rehearse leaves the same stamps as a stopped release, but its remedy is to put
  // them back by hand: resuming would start a real release of a version still being rehearsed.
  it('names an interrupted rehearsal too, and puts it first when the refused run is a rehearsal', () => {
    const message = (options?: { rehearsal: boolean }) => {
      try {
        refuseKeywordPastUnfinishedRelease('patch', '0.23.6', answers({ '@nextblock-cms/utils': false }), options);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    const asRelease = message();
    const asRehearsal = message({ rehearsal: true });
    for (const text of [asRelease, asRehearsal]) {
      expect(text).toContain('An interrupted --rehearse left these stamps: put the version lines');
      expect(text).toContain('resume it with `node tools/scripts/release-all.js 0.23.6`');
      expect(text).toContain('npm has not listed a release of 0.23.6 that just finished');
    }
    expect(asRehearsal.indexOf('interrupted --rehearse')).toBeLessThan(asRehearsal.indexOf('resume it with'));
    expect(asRelease.indexOf('resume it with')).toBeLessThan(asRelease.indexOf('interrupted --rehearse'));
  });

  it('refuses a keyword when npm cannot say, and never refuses an explicit version', () => {
    expect(() => refuseKeywordPastUnfinishedRelease('minor', '0.23.5', answers({ '@nextblock-cms/db': null }))).toThrow(
      /npm could not be asked about @nextblock-cms\/db: pass an explicit version/,
    );
    expect(() => refuseKeywordPastUnfinishedRelease('patch', '0.23.5', new Map())).toThrow(/could not be asked/);
    expect(() => refuseKeywordPastUnfinishedRelease('0.23.7', '0.23.6', answers({ '@nextblock-cms/sdk': false }))).not.toThrow();
  });
});

describe('parseSingleReleaseArgs (release-lib.js, release-cli.js)', () => {
  it('reads the library, the version (patch by default) and --dry-run', () => {
    expect(parseSingleReleaseArgs(['utils', '0.23.6', '--dry-run'], {}, { withLibrary: true })).toEqual({
      library: 'utils',
      versionSpec: '0.23.6',
      dryRun: true,
    });
    expect(parseSingleReleaseArgs(['ecommerce'], {}, { withLibrary: true })).toEqual({ library: 'ecommerce', versionSpec: 'patch', dryRun: false });
    expect(parseSingleReleaseArgs(['minor'])).toEqual({ library: undefined, versionSpec: 'minor', dryRun: false });
  });

  // `npm run build:utils --dry-run` (or PowerShell dropping `--`) leaves the flag to npm.
  it('honours npm_config_dry_run', () => {
    expect(parseSingleReleaseArgs(['utils', '0.23.6'], { npm_config_dry_run: 'true' }, { withLibrary: true }).dryRun).toBe(true);
    expect(parseSingleReleaseArgs([], { npm_config_dry_run: 'false' }).dryRun).toBe(false);
  });

  it('refuses an unknown option, a missing library, an extra argument, a pre-release and a non-version', () => {
    expect(() => parseSingleReleaseArgs(['utils', '--dryrun'], {}, { withLibrary: true })).toThrow(/Unknown option --dryrun/);
    expect(() => parseSingleReleaseArgs(['--dry-run'], {}, { withLibrary: true })).toThrow(/Missing <library>/);
    expect(() => parseSingleReleaseArgs(['0.23.6', 'patch'])).toThrow(/Unexpected patch/);
    expect(() => parseSingleReleaseArgs(['prerelease'])).toThrow(/pre-release/);
    expect(() => parseSingleReleaseArgs(['utils', '0.24.0-rc.0'], {}, { withLibrary: true })).toThrow(/pre-release/);
    expect(() => parseSingleReleaseArgs(['next'])).toThrow(/"next" is not a version/);
  });
});

describe('settleSingleReleaseFailure (release-lib.js, release-cli.js)', () => {
  const THIS_TARBALL = 'sha512-this-run';
  const fakeSteps = (publishedIntegrity: () => Promise<string | null>) => ({
    publishedIntegrity: vi.fn(publishedIntegrity),
    restore: vi.fn(() => ['libs/utils/package.json']),
  });
  const settle = (steps: ReturnType<typeof fakeSteps>, extra: Record<string, unknown> = {}) =>
    settleSingleReleaseFailure({ stage: 'publish', name: 'create-nextblock', version: VERSION, integrity: THIS_TARBALL, steps, ...extra });

  it('restores the stamps after a failure before the publish, without asking npm', async () => {
    const steps = fakeSteps(async () => THIS_TARBALL);
    await expect(settle(steps, { stage: 'build' })).resolves.toEqual({ published: false, restored: ['libs/utils/package.json'] });
    expect(steps.publishedIntegrity).not.toHaveBeenCalled();
  });

  // A publish can reach the registry and still exit non-zero (a lost response, a timeout after the
  // upload). Restoring then left the checkout behind npm, and npm refuses to publish that version again.
  it('keeps the stamps when npm serves this very tarball after a failed publish', async () => {
    const steps = fakeSteps(async () => THIS_TARBALL);
    const log = vi.fn();
    await expect(settle(steps, { log })).resolves.toEqual({ published: true, restored: [] });
    expect(steps.publishedIntegrity).toHaveBeenCalledWith('create-nextblock', VERSION);
    expect(steps.restore).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('it serves this very tarball as create-nextblock@0.23.6 (same integrity): counted as published'));
  });

  // npm refuses to publish over a version it has (before any upload): a checkout behind npm, or a
  // re-run of an old version, used to be reported as this run's publish, with exit 0. Either side
  // may hold the newer code, so the message names both remedies and never just "bump".
  it('restores and fails when npm had the version from another tarball before this run', async () => {
    const steps = fakeSteps(async () => 'sha512-older-code');
    const log = vi.fn();
    await expect(settle(steps, { log })).resolves.toEqual({ published: false, restored: ['libs/utils/package.json'] });
    const [line] = log.mock.calls.map(([text]) => String(text));
    expect(line).toContain("npm already has create-nextblock@0.23.6, built from other code than this run's tarball (npm: sha512-older-code; this run: sha512-this-run), so nothing was published");
    expect(line).toContain("If this checkout is behind npm (`npm view create-nextblock version` shows npm's latest), update it before releasing");
    expect(line).toContain("if npm's copy is the older code, release a version above npm's latest");
  });

  // npm may have refused before any upload (no login, a version below its latest) or accepted one it
  // has not listed yet: the publish error is on screen, not in hand, so the hint covers both.
  it('restores with a hint when npm does not list the version, or cannot be asked', async () => {
    const missing = fakeSteps(async () => null);
    const log = vi.fn();
    expect((await settle(missing, { log })).published).toBe(false);
    expect(missing.restore).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('npm does not list create-nextblock@0.23.6, so the version stamps are restored. If npm accepted the upload'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('re-running with the explicit version 0.23.6 then counts an identical tarball as published'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Otherwise fix the error npm printed above first (not logged in: `npm login`'));

    // publishedIntegrity's own message is printed once, not wrapped in itself.
    const unreachable = fakeSteps(async () => {
      throw new Error('Could not ask npm which tarball it serves as create-nextblock@0.23.6: npm error code ETIMEDOUT');
    });
    const unreachableLog = vi.fn();
    await settle(unreachable, { log: unreachableLog });
    expect(unreachable.restore).toHaveBeenCalledTimes(1);
    const [unreachableLine] = unreachableLog.mock.calls.map(([text]) => String(text));
    expect(unreachableLine).toMatch(/^Could not ask npm which tarball it serves as create-nextblock@0\.23\.6: npm error code ETIMEDOUT, so the version stamps are restored\./);
    expect(unreachableLine.match(/Could not ask npm/g)).toHaveLength(1);

    const bare = fakeSteps(async () => {
      throw new Error('ETIMEDOUT');
    });
    const bareLog = vi.fn();
    await settle(bare, { log: bareLog });
    expect(bareLog).toHaveBeenCalledWith(expect.stringContaining('Could not ask npm which tarball it serves as create-nextblock@0.23.6 (ETIMEDOUT)'));
  });

  it('always restores a dry run, and cannot count a publish without this run’s integrity', async () => {
    const rehearsal = fakeSteps(async () => THIS_TARBALL);
    expect((await settle(rehearsal, { dryRun: true })).published).toBe(false);
    expect(rehearsal.publishedIntegrity).not.toHaveBeenCalled();
    expect(rehearsal.restore).toHaveBeenCalledTimes(1);

    const noIntegrity = fakeSteps(async () => THIS_TARBALL);
    const log = vi.fn();
    expect((await settle(noIntegrity, { integrity: undefined, log })).published).toBe(false);
    expect(noIntegrity.restore).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot tell whether this run uploaded it'));
  });
});

describe('runBuildPhase', () => {
  it('stamps everything before building, builds the CLI first, and writes a manifest in publish order', async () => {
    const { steps, events } = fakeBuildSteps();
    const plan = planRelease(VERSION);

    const { manifest } = await runBuildPhase({ version: VERSION, plan, steps });

    const firstBuild = events.findIndex((event) => event.startsWith('build'));
    expect(events.slice(0, 2)).toEqual(['snapshot', 'prepare']);
    expect(events.slice(2, firstBuild)).toEqual(STAMPED_DIRS.map((dir: string) => `stamp ${dir} ${VERSION}`));
    expect(events.slice(firstBuild, -1)).toEqual(BUILD_ORDER.map((pkg: Pkg) => `build ${pkg.name}`));
    expect(events.at(-1)).toBe('manifest');
    expect(steps.writeManifest).toHaveBeenCalledWith(manifest);
    expect(manifest).toMatchObject({ format: 1, version: VERSION, rehearsal: false, createdAt: '2026-11-17T20:00:00.000Z' });
    expect(manifest.packages.map((pkg: Entry) => [pkg.name, pkg.tarball, pkg.integrity])).toEqual(
      RELEASE_PACKAGES.map((pkg: Pkg) => [pkg.name, tarballFileName(pkg.name, VERSION), `sha512-${pkg.id}`]),
    );
  });

  it('does not rebuild what npm already has, but still stamps it', async () => {
    const { steps, events } = fakeBuildSteps();
    const plan = planRelease(VERSION, new Set(['@nextblock-cms/utils', '@nextblock-cms/ui', 'create-nextblock']));

    const { manifest } = await runBuildPhase({ version: VERSION, plan, steps });

    expect(events).toContain(`stamp libs/utils ${VERSION}`);
    expect(events).toContain(`stamp apps/create-nextblock ${VERSION}`);
    expect(events.filter((event) => event.startsWith('build'))).toEqual(
      ['sdk', 'db', 'editor', 'ecom', 'cortex', 'affiliates'].map((name) => `build @nextblock-cms/${name}`),
    );
    expect(manifest.packages.filter((pkg: Entry) => pkg.skipped).map((pkg: Entry) => pkg.name)).toEqual([
      '@nextblock-cms/utils',
      '@nextblock-cms/ui',
      'create-nextblock',
    ]);
  });

  it('stops at the first failed build, writes no manifest, and restores every stamp', async () => {
    const buildLib = vi.fn((pkg: Pkg) => {
      if (pkg.id === 'editor') throw new Error('verify-lib-dist: 2 problems');
      return artifactFor(pkg);
    });
    const { steps, events, restore } = fakeBuildSteps({ buildLib });
    const log = vi.fn();

    await expect(runBuildPhase({ version: VERSION, plan: planRelease(VERSION), steps, log })).rejects.toThrow('verify-lib-dist: 2 problems');

    expect(buildLib.mock.calls.map(([pkg]) => pkg.id)).toEqual(['utils', 'ui', 'sdk', 'db', 'editor']);
    expect(steps.writeManifest).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('restore');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restored 1 version-stamped file (libs/utils/package.json). Nothing was published.'));
  });

  it('restores the stamps when stamping itself fails part way', async () => {
    const stamp = vi.fn((dir: string) => {
      if (dir === 'libs/db') throw new Error('npm version failed');
    });
    const { steps, restore } = fakeBuildSteps({ stamp });

    await expect(runBuildPhase({ version: VERSION, plan: planRelease(VERSION), steps })).rejects.toThrow('npm version failed');
    expect(steps.buildCli).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('refuses a tarball npm packed under another name or version', async () => {
    const buildCli = vi.fn((pkg: Pkg) => artifactFor(pkg, '0.23.5'));
    const { steps, restore } = fakeBuildSteps({ buildCli });

    await expect(runBuildPhase({ version: VERSION, plan: planRelease(VERSION), steps })).rejects.toThrow(
      'npm packed create-nextblock@0.23.5, expected create-nextblock@0.23.6.',
    );
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('still throws the build error when the restore fails too, and says which files to check', async () => {
    const restore = vi.fn(() => {
      throw new Error('EPERM: package.json is locked');
    });
    const { steps } = fakeBuildSteps({
      snapshotStamps: () => ({ restore }),
      buildCli: () => {
        throw new Error('template sync failed');
      },
    });
    const log = vi.fn();

    await expect(runBuildPhase({ version: VERSION, plan: planRelease(VERSION), steps, log })).rejects.toThrow('template sync failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restoring the version stamps failed too (EPERM: package.json is locked)'));
  });
});

describe('runPublishPhase', () => {
  it('checks every tarball, the login and npm before the first publish, then publishes in order', async () => {
    const { steps, events } = fakePublishSteps();

    const result = await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps });

    const firstPublish = events.findIndex((event) => event.startsWith('publish'));
    expect(events.slice(0, firstPublish)).toEqual([
      ...PUBLISH_ORDER.map((name) => `check ${name}`),
      'whoami',
      ...PUBLISH_ORDER.map((name) => `view ${name}`),
    ]);
    expect(events.slice(firstPublish)).toEqual(PUBLISH_ORDER.map((name) => `publish ${name}`));
    expect(result.published.map((pkg: Entry) => pkg.name)).toEqual(PUBLISH_ORDER);
    expect(result.failed).toBeNull();
  });

  it('passes --dry-run to every publish in a rehearsal', async () => {
    const { steps, events } = fakePublishSteps();
    await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), dryRun: true, steps });
    expect(events.filter((event) => event.startsWith('publish'))).toEqual(PUBLISH_ORDER.map((name) => `publish ${name} --dry-run`));
  });

  it('skips what phase 1 skipped and what reached npm since, publishing the rest', async () => {
    const plan = planRelease(VERSION, new Set(['@nextblock-cms/utils']));
    const { steps, events } = fakePublishSteps({ published: ['@nextblock-cms/ui'] });

    const result = await runPublishPhase({ manifest: manifestFor(plan), steps });

    expect(events).not.toContain('check @nextblock-cms/utils');
    expect(events).not.toContain('view @nextblock-cms/utils');
    expect(events.filter((event) => event.startsWith('publish'))).toEqual(PUBLISH_ORDER.slice(2).map((name) => `publish ${name}`));
    expect(result.alreadyOut.map((pkg: Entry) => pkg.name)).toEqual(['@nextblock-cms/utils', '@nextblock-cms/ui']);
  });

  it('publishes nothing when a tarball no longer matches its integrity, even the last one', async () => {
    const checkTarball = vi.fn((entry: Entry) => {
      if (entry.name === 'create-nextblock') throw new Error('dist/release/create-nextblock-0.23.6.tgz changed after it was packed');
    });
    const { steps } = fakePublishSteps({ checkTarball });

    await expect(runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps })).rejects.toThrow('changed after it was packed');
    expect(steps.publish).not.toHaveBeenCalled();
  });

  it('publishes nothing without an npm login, and a rehearsal only warns', async () => {
    const whoami = vi.fn(() => {
      throw new Error('E401');
    });
    const real = fakePublishSteps({ whoami });
    await expect(runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps: real.steps })).rejects.toThrow(/Not logged in to npm.*--publish-only/);
    expect(real.steps.publish).not.toHaveBeenCalled();

    const rehearsal = fakePublishSteps({ whoami });
    const log = vi.fn();
    const result = await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), dryRun: true, steps: rehearsal.steps, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a real release would stop here'));
    expect(result.published).toHaveLength(PUBLISH_ORDER.length);
  });

  it('publishes nothing when npm cannot say which versions are out', async () => {
    const isPublished = vi.fn(async (name: string) => {
      if (name === '@nextblock-cms/db') throw new Error('Could not ask npm whether @nextblock-cms/db@0.23.6 is published: ETIMEDOUT');
      return false;
    });
    const { steps } = fakePublishSteps({ isPublished });

    await expect(runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps })).rejects.toThrow('ETIMEDOUT');
    expect(steps.publish).not.toHaveBeenCalled();
  });

  it('stops at a failed publish and reports what is out and what is left', async () => {
    const { steps, events } = fakePublishSteps({ failPublish: { '@nextblock-cms/editor': 'E404 Not Found - GET https://registry.npmjs.org/-/v1/done' } });

    const result = await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps });

    expect(events.filter((event) => event.startsWith('publish'))).toEqual(PUBLISH_ORDER.slice(0, 5).map((name) => `publish ${name}`));
    expect(result.published.map((pkg: Entry) => pkg.name)).toEqual(PUBLISH_ORDER.slice(0, 4));
    expect(result.failed).toMatchObject({ pkg: { name: '@nextblock-cms/editor' }, message: expect.stringContaining('/-/v1/done') });
    expect(result.notAttempted.map((pkg: Entry) => pkg.name)).toEqual(PUBLISH_ORDER.slice(5));
    // the failed one was checked against npm once more before giving up
    expect(events.filter((event) => event === 'view @nextblock-cms/editor')).toHaveLength(2);
  });

  it('goes on when a failed publish turns out to be on npm (a lost response, a refused duplicate)', async () => {
    const { steps, onNpm } = fakePublishSteps();
    steps.publish.mockImplementation((entry: Entry) => {
      if (entry.name === '@nextblock-cms/db') {
        onNpm.add(entry.name);
        throw new Error('E403 You cannot publish over the previously published versions: 0.23.6');
      }
    });

    const result = await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), steps });

    expect(result.failed).toBeNull();
    expect(result.alreadyOut.map((pkg: Entry) => pkg.name)).toEqual(['@nextblock-cms/db']);
    expect(result.published.map((pkg: Entry) => pkg.name)).toEqual(PUBLISH_ORDER.filter((name) => name !== '@nextblock-cms/db'));
  });

  it('does not ask npm about a failed dry-run publish: a rehearsal failure is a real failure', async () => {
    const { steps, events } = fakePublishSteps({ failPublish: { '@nextblock-cms/sdk': 'npm error code E400' } });

    const result = await runPublishPhase({ manifest: manifestFor(planRelease(VERSION)), dryRun: true, steps });

    expect(result.failed?.pkg.name).toBe('@nextblock-cms/sdk');
    expect(events.filter((event) => event === 'view @nextblock-cms/sdk')).toHaveLength(1);
  });

  it('asks for no login when there is nothing to publish', async () => {
    const plan = planRelease(VERSION, new Set(PUBLISH_ORDER));
    const { steps } = fakePublishSteps();

    const result = await runPublishPhase({ manifest: manifestFor(plan), steps });

    expect(steps.whoami).not.toHaveBeenCalled();
    expect(steps.publish).not.toHaveBeenCalled();
    expect(result.alreadyOut).toHaveLength(PUBLISH_ORDER.length);
  });
});

describe('validateManifest', () => {
  const manifest = manifestFor(planRelease(VERSION));

  it('accepts the manifest of a finished phase 1 for the same version', () => {
    expect(validateManifest(manifest, VERSION)).toBe(manifest);
  });

  it('refuses a missing build, another version, another format or another package list', () => {
    expect(() => validateManifest(null, VERSION)).toThrow(/holds no finished build/);
    expect(() => validateManifest(manifest, '0.23.7')).toThrow(/holds a build of 0\.23\.6, not 0\.23\.7/);
    expect(() => validateManifest({ ...manifest, format: 0 }, VERSION)).toThrow(/another version of release:all/);
    expect(() => validateManifest({ ...manifest, packages: manifest.packages.slice(1) }, VERSION)).toThrow(/does not list this release's packages/);
    const reordered = [manifest.packages[1], manifest.packages[0], ...manifest.packages.slice(2)];
    expect(() => validateManifest({ ...manifest, packages: reordered }, VERSION)).toThrow(/in order/);
  });

  it('refuses a package without its tarball, or at another version', () => {
    const noTarball = manifest.packages.map((pkg: Entry, index: number) => (index === 3 ? { ...pkg, integrity: undefined } : pkg));
    expect(() => validateManifest({ ...manifest, packages: noTarball }, VERSION)).toThrow('@nextblock-cms/db has no tarball in the manifest');
    const stale = manifest.packages.map((pkg: Entry, index: number) => (index === 0 ? { ...pkg, version: '0.23.5' } : pkg));
    expect(() => validateManifest({ ...manifest, packages: stale }, VERSION)).toThrow('@nextblock-cms/utils in the manifest is 0.23.5');
  });

  it("refuses a rehearsal's tarballs for a real publish, not for another rehearsal", () => {
    const rehearsal = { ...manifest, rehearsal: true };
    expect(() => validateManifest(rehearsal, VERSION)).toThrow(/tarballs of a rehearsal/);
    expect(validateManifest(rehearsal, VERSION, { rehearsal: true })).toBe(rehearsal);
  });
});

describe('describeDryRun', () => {
  const currentVersions = Object.fromEntries(STAMPED_DIRS.map((dir: string) => [dir, '0.23.5']));
  const base = { dryRun: true, rehearse: false, buildOnly: false, publishOnly: false };
  const describe2 = (options: Record<string, boolean>, published = new Map<string, boolean | null>(), extra = {}) =>
    describeDryRun({ version: VERSION, versionSpec: VERSION, currentVersions, published, options: { ...base, ...options }, ...extra }).join('\n');

  it('prints both phases: every build step, then every publish in order', () => {
    const text = describe2({});
    const phase1 = text.slice(text.indexOf('Phase 1'), text.indexOf('Phase 2'));
    const phase2 = text.slice(text.indexOf('Phase 2'));
    expect(phase1).toContain('npm version 0.23.6 in libs/utils');
    expect(phase1.indexOf('create-nextblock')).toBeLessThan(phase1.indexOf('@nextblock-cms/utils'));
    const publishLines = phase2.split('\n').filter((line) => line.includes('npm publish ./dist/release/'));
    expect(publishLines.map((line) => line.trim().split(/\s+/)[0])).toEqual(PUBLISH_ORDER);
    expect(phase2).toContain('--access public --ignore-scripts --registry=https://registry.npmjs.org/');
    expect(phase2).not.toContain('--dry-run');
  });

  it('marks what npm already has, and what it could not tell', () => {
    const text = describe2({}, new Map([['@nextblock-cms/utils', true], ['@nextblock-cms/ui', null]]));
    expect(text).toMatch(/@nextblock-cms\/utils\s+0\.23\.5\s+→ 0\.23\.6\s+\(already on npm: skip\)/);
    expect(text).toMatch(/@nextblock-cms\/ui\s+0\.23\.5\s+→ 0\.23\.6\s+\(npm status unknown\)/);
    expect(text).toMatch(/@nextblock-cms\/utils\s+skip: already on npm/);
    expect(text).not.toContain('npm publish ./dist/release/nextblock-cms-utils-0.23.6.tgz');
  });

  it('stops after phase 1 for --build-only, and names the publish step', () => {
    const text = describe2({ buildOnly: true });
    expect(text).not.toContain('Phase 2');
    expect(text).toContain('node tools/scripts/release-all.js 0.23.6 --publish-only');
  });

  it('prints phase 2 alone for --publish-only, or why it cannot run', () => {
    const manifest = manifestFor(planRelease(VERSION));
    const text = describe2({ publishOnly: true }, new Map([['@nextblock-cms/ui', true]]), { manifest });
    expect(text).not.toContain('Phase 1');
    expect(text).toContain('from the build made now');
    expect(text).toMatch(/@nextblock-cms\/ui\s+skip: already on npm/);
    expect(text).toContain('npm publish ./dist/release/nextblock-cms-utils-0.23.6.tgz');
    expect(describe2({ publishOnly: true }, new Map(), { manifestError: 'dist/release holds no finished build' })).toContain(
      '✗ dist/release holds no finished build',
    );
  });

  it('adds --dry-run to every publish, and the stamp restore, for --rehearse', () => {
    const text = describe2({ rehearse: true });
    expect(text).toContain('Phase 2: publish back to back with npm publish --dry-run');
    expect(text).toMatch(/each publish adds: .* --dry-run/);
    expect(text).toContain('restore every version stamp phase 1 wrote');
  });
});

describe('describePublishFailure', () => {
  it('names what went out, what did not, and the command that resumes', () => {
    const [utils, ui, sdk, db] = manifestFor(planRelease(VERSION)).packages;
    const text = describePublishFailure({ published: [ui], alreadyOut: [utils], failed: { pkg: sdk, message: 'E404 /-/v1/done' }, notAttempted: [db] }, VERSION).join('\n');
    expect(text).toContain('Publishing @nextblock-cms/sdk@0.23.6 failed: E404 /-/v1/done');
    expect(text).toContain('Published now: @nextblock-cms/ui.');
    expect(text).toContain('Already on npm: @nextblock-cms/utils.');
    expect(text).toContain('Not published: @nextblock-cms/sdk, @nextblock-cms/db.');
    expect(text).toContain('node tools/scripts/release-all.js 0.23.6 --publish-only');
  });
});
