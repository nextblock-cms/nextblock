// The two phases of `release:all` (tools/scripts/release-all.js), with every side effect
// passed in, so the plan, the skip-if-published rule and the failure handling are tested
// without npm, Nx or the network (release-pipeline.test.ts). The real effects live in
// release-steps.js.
//
// Why two phases: the npm account uses auth-type web. The first `npm publish` opens a browser
// approval, one approval covers about five minutes of publishes, and an unanswered prompt expires
// after about seven (E404 on /-/v1/done). The old script built each package (about a minute)
// right before publishing it, so a nine-package release lasted about 15 minutes, asked for two or
// three approvals, and on 2026-11-17 three 0.23.5 attempts died on prompts that expired between
// builds. Now phase 1 builds, verifies and packs everything (no publish), and phase 2 publishes
// the packed tarballs back to back, in dependency order, inside one approval window.

'use strict';

const LIBS = ['utils', 'ui', 'sdk', 'db', 'editor', 'ecommerce', 'cortex', 'affiliates'];
const CLI_NAME = 'create-nextblock';

/** The npm name of a lib folder: libs/ecommerce publishes as @nextblock-cms/ecom. */
function packageNameFor(lib) {
  return `@nextblock-cms/${lib === 'ecommerce' ? 'ecom' : lib}`;
}

/**
 * Every package release:all ships, in publish order. Each lib's @nextblock-cms/* dependencies
 * go out before it (cortex needs db, ecommerce and utils; affiliates needs utils and ui), and the
 * CLI goes last: a new scaffold installs the libs at `latest`, so they must be on npm first.
 */
const RELEASE_PACKAGES = Object.freeze([
  ...LIBS.map((lib) => Object.freeze({ id: lib, kind: 'lib', name: packageNameFor(lib), dir: `libs/${lib}` })),
  Object.freeze({ id: 'cli', kind: 'cli', name: CLI_NAME, dir: 'apps/create-nextblock' }),
]);

/**
 * Phase 1 builds the CLI first: its template sync is the step most likely to fail (Windows file
 * locks, scripts/lib/fs-retry.js), and it needs no lib build, so a failure there costs a minute,
 * not ten. The libs then build in publish order.
 */
const BUILD_ORDER = Object.freeze([RELEASE_PACKAGES[RELEASE_PACKAGES.length - 1], ...RELEASE_PACKAGES.slice(0, -1)]);

/** The root, the app (the template's source) and the CLI carry the CLI's version. */
const CLI_STAMPED_DIRS = Object.freeze(['.', 'apps/nextblock', 'apps/create-nextblock']);

/**
 * Folders whose package.json carries the release version, stamped with `npm version` before
 * anything builds. Every lib is stamped first, the ones already on npm included: release-steps
 * resolves sibling `workspace:` specs, and the ui, editor and db builds write their sibling peers,
 * from the versions in libs/<lib>/package.json.
 */
const STAMPED_DIRS = Object.freeze([...LIBS.map((lib) => `libs/${lib}`), ...CLI_STAMPED_DIRS]);

/** The template sync copies the app's version into this file, so it is a version stamp too. */
const TEMPLATE_PACKAGE_JSON = 'apps/create-nextblock/templates/nextblock-template/package.json';

const posixJoin = (dir, file) => (dir === '.' ? file : `${dir}/${file}`);

/** package.json and package-lock.json in each folder: `npm version` updates a lockfile that exists. */
function filesStampedIn(dirs) {
  return dirs.flatMap((dir) => [posixJoin(dir, 'package.json'), posixJoin(dir, 'package-lock.json')]);
}

/**
 * Every file a release may rewrite to stamp a version: each stamped folder's package.json and
 * package-lock.json, and the template's package.json. The build phase snapshots them first and
 * restores them all when it fails.
 */
const STAMPED_FILES = Object.freeze([...filesStampedIn(STAMPED_DIRS), TEMPLATE_PACKAGE_JSON]);

/** release-steps.js passes these to every `npm publish`, `npm view` and `npm whoami`. */
const PUBLISH_REGISTRY = 'https://registry.npmjs.org/';
const PUBLISH_REGISTRY_FLAGS = Object.freeze([`--registry=${PUBLISH_REGISTRY}`, `--@nextblock-cms:registry=${PUBLISH_REGISTRY}`]);

/** x.y.z: the only kind of version the release scripts publish. */
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
/** x.y.z with a pre-release part (0.24.0-rc.0), with or without build metadata after it. */
const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-./;
/** x.y.z with build metadata only (0.23.6+build.1); captures the x.y.z. */
const BUILD_METADATA_VERSION = /^(\d+\.\d+\.\d+)\+./;
const BUMP_KEYWORDS = ['major', 'minor', 'patch'];
const PRE_KEYWORDS = ['premajor', 'preminor', 'prepatch', 'prerelease'];

/**
 * Why a pre-release is refused: npm publishes one only under a dist-tag, and these scripts pass
 * none (npm 11 refuses such a publish, after a whole phase 1; npm 10 made the rc `latest` for every
 * `npm create nextblock`). A dist-tag alone would not do either: a published create-nextblock
 * installs the libs at `latest`, so a pre-release scaffold would get the last stable libs.
 */
const PRERELEASE_REFUSAL =
  'is a pre-release version, which the release scripts do not publish: npm takes one only under a dist-tag (--tag),' +
  ' and a published create-nextblock installs the libs at `latest`, so a pre-release scaffold would get the last stable libs.' +
  ' Release a plain x.y.z version.';

/**
 * Returns a version spec a release script can publish: a plain x.y.z version or a bump keyword.
 * A pre-release version or keyword gets the reason it is refused. Build metadata is refused for its
 * own reason: `npm version` and `npm publish` drop it (0.23.6+build.1 is stamped and published as
 * 0.23.6), so phase 1 would pack a version other than the one it was asked for.
 */
function assertVersionSpec(versionSpec) {
  if (PLAIN_VERSION.test(versionSpec) || BUMP_KEYWORDS.includes(versionSpec)) return versionSpec;
  if (PRE_KEYWORDS.includes(versionSpec) || PRERELEASE_VERSION.test(versionSpec)) {
    throw new UsageError(`"${versionSpec}" ${PRERELEASE_REFUSAL}`);
  }
  const build = BUILD_METADATA_VERSION.exec(versionSpec);
  if (build) {
    throw new UsageError(`"${versionSpec}" carries build metadata, which npm drops (\`npm version\` writes ${build[1]}): pass ${build[1]}.`);
  }
  throw new UsageError(`"${versionSpec}" is not a version: pass an explicit version (e.g. 0.23.6) or major|minor|patch.`);
}

const MODE_FLAGS = Object.freeze({
  '--dry-run': 'npm_config_dry_run',
  '--rehearse': 'npm_config_rehearse',
  '--build-only': 'npm_config_build_only',
  '--publish-only': 'npm_config_publish_only',
});

const USAGE = [
  'Usage: node tools/scripts/release-all.js <version> [--dry-run] [--rehearse] [--build-only | --publish-only]',
  '',
  '  <version>       an explicit x.y.z version (0.23.6), or major|minor|patch when every package is at one',
  '                  version and npm has that version of every package (re-run an explicit version to resume)',
  '  --dry-run       print both phases; stamp, build and publish nothing',
  '  --rehearse      run both phases for real but publish with `npm publish --dry-run`, then restore every version stamp',
  '  --build-only    phase 1 only: stamp, build, verify and pack into dist/release; publish nothing',
  '  --publish-only  phase 2 only: publish the tarballs a finished phase 1 left in dist/release',
].join('\n');

class UsageError extends Error {}

/**
 * Reads the command line. Unknown options are refused: a mistyped `--dryrun` used to be ignored,
 * which turned a plan request into a real release. Under Windows PowerShell, `npm run release:all
 * -- 0.23.6 --dry-run` loses its `--`, and npm then keeps `--dry-run` for itself and hands the
 * script only the version; npm still exports the flag as `npm_config_dry_run=true` (and an unknown
 * one such as `--build-only` as `npm_config_build_only=true`), so those are honoured too.
 */
function parseReleaseArgs(argv, env = {}) {
  const flags = new Set();
  const positionals = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      if (!Object.hasOwn(MODE_FLAGS, arg)) throw new UsageError(`Unknown option ${arg}.`);
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }

  const fromNpmConfig = [];
  for (const [flag, envKey] of Object.entries(MODE_FLAGS)) {
    if (!flags.has(flag) && String(env[envKey] ?? '').toLowerCase() === 'true') {
      flags.add(flag);
      fromNpmConfig.push(flag);
    }
  }

  if (positionals.length !== 1) {
    throw new UsageError(positionals.length === 0 ? 'Missing <version>.' : `Expected one version, got ${positionals.join(' ')}.`);
  }
  const versionSpec = assertVersionSpec(positionals[0]);

  const options = {
    versionSpec,
    dryRun: flags.has('--dry-run'),
    rehearse: flags.has('--rehearse'),
    buildOnly: flags.has('--build-only'),
    publishOnly: flags.has('--publish-only'),
    fromNpmConfig,
  };
  if (options.buildOnly && options.publishOnly) {
    throw new UsageError('--build-only and --publish-only exclude each other: pass neither to run both phases.');
  }
  if (options.rehearse && options.buildOnly) {
    throw new UsageError('--rehearse runs both phases (or phase 2 with --publish-only); a build-only run publishes nothing to rehearse.');
  }
  // Phase 1 leaves the checkout stamped at the release version, so a keyword here would be applied
  // to that version and name the next one, never the build waiting in dist/release.
  if (options.publishOnly && BUMP_KEYWORDS.includes(versionSpec)) {
    throw new UsageError(
      `--publish-only publishes the build in dist/release: pass the version phase 1 stamped (e.g. 0.23.6), not "${versionSpec}", which would bump past it.`,
    );
  }
  return options;
}

/**
 * The one version every package is stamped to. A bump keyword is applied once, to the version the
 * packages share; packages that disagree need an explicit version (release:all exists to put them
 * back in step). Resolving it up front is also what lets the skip-if-published check run for a
 * keyword, which the old script could not do.
 */
function resolveReleaseVersion(versionSpec, currentVersions) {
  assertVersionSpec(versionSpec);
  if (PLAIN_VERSION.test(versionSpec)) return versionSpec;
  const distinct = [...new Set(Object.values(currentVersions))];
  if (distinct.length !== 1) {
    const listed = Object.entries(currentVersions)
      .map(([label, version]) => `${label} ${version}`)
      .join(', ');
    throw new UsageError(
      `"${versionSpec}" needs every package at one version, but they differ (${listed}): pass an explicit version` +
        ' (or, if a run stopped while stamping, a rehearsal included, put its version lines back first).',
    );
  }
  return bumpVersion(distinct[0], versionSpec);
}

/** `npm version major|minor|patch` on a plain x.y.z version. */
function bumpVersion(version, keyword) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) {
    throw new UsageError(`Cannot apply "${keyword}" to ${version} (not a plain x.y.z version): pass an explicit version.`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (keyword === 'major') return `${major + 1}.0.0`;
  if (keyword === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * A bump keyword starts the NEXT release from the version the checkout carries, so it is refused
 * while npm lacks that version of any package. A real phase 1 leaves every package stamped at the
 * release version and phase 2 never restores the stamps: after a release that stopped part way, or
 * a --build-only run, a keyword would bump past it (0.23.6 left half published while all of 0.23.7
 * went out). Running the same explicit version again is what resumes. The same stamps are also
 * what an interrupted --rehearse leaves (Ctrl+C skips its restore), and there the remedy is to
 * restore them by hand, never to resume, so the message names both, the rehearsal first when the
 * refused run is a rehearsal itself.
 * `published` maps each package name to true, false, or null (npm could not be asked).
 */
function refuseKeywordPastUnfinishedRelease(versionSpec, currentVersion, published, { rehearsal = false } = {}) {
  if (!BUMP_KEYWORDS.includes(versionSpec)) return;
  const missing = RELEASE_PACKAGES.filter((pkg) => published.get(pkg.name) === false).map((pkg) => pkg.name);
  const unknown = RELEASE_PACKAGES.filter((pkg) => published.get(pkg.name) == null).map((pkg) => pkg.name);
  if (missing.length > 0) {
    const causes = [
      `- An interrupted --rehearse left these stamps: put the version lines in the stamped package.json and package-lock.json files back by hand (\`git diff\` shows them), then run the same command again.`,
      `- A release of ${currentVersion} stopped part way or was only built: resume it with \`node tools/scripts/release-all.js ${currentVersion}\` (add --publish-only when dist/release holds its tarballs), or put the stamps back to abandon it.`,
    ];
    throw new UsageError(
      [
        `"${versionSpec}" would bump past ${currentVersion}: the checkout is stamped at ${currentVersion}, but npm does not have it for ${missing.join(', ')}. Either:`,
        ...(rehearsal ? causes : [...causes].reverse()),
        `- Or npm has not listed a release of ${currentVersion} that just finished: that can take a few minutes.`,
        'To release another version, pass it explicitly.',
      ].join('\n'),
    );
  }
  if (unknown.length > 0) {
    throw new UsageError(
      `"${versionSpec}" bumps ${currentVersion} only once npm has it for every package, and npm could not be asked about ${unknown.join(', ')}: pass an explicit version.`,
    );
  }
}

/**
 * The command line of release-lib.js (`<library> [<version>|major|minor|patch] [--dry-run]`, with
 * `withLibrary`) and release-cli.js (`[<version>|major|minor|patch] [--dry-run]`); the version
 * defaults to `patch`. `npm run build:<lib> --dry-run` hands the flag to npm, which exports it as
 * npm_config_dry_run, so that counts as --dry-run too. The caller must then remove it from its own
 * environment: every child npm reads it, and an `npm pack` under it writes no tarball.
 */
function parseSingleReleaseArgs(argv, env = {}, { withLibrary = false } = {}) {
  const unknown = argv.filter((arg) => arg.startsWith('-') && arg !== '--dry-run');
  if (unknown.length > 0) throw new UsageError(`Unknown option ${unknown.join(' ')}.`);
  const positionals = argv.filter((arg) => !arg.startsWith('-'));
  const library = withLibrary ? positionals.shift() : undefined;
  if (withLibrary && !library) throw new UsageError('Missing <library>.');
  if (positionals.length > 1) throw new UsageError(`Unexpected ${positionals.slice(1).join(' ')}.`);
  return {
    library,
    versionSpec: positionals.length === 1 ? assertVersionSpec(positionals[0]) : 'patch',
    dryRun: argv.includes('--dry-run') || String(env.npm_config_dry_run ?? '').toLowerCase() === 'true',
  };
}

/**
 * What release-lib.js and release-cli.js do with their version stamps after a failure. Before the
 * publish nothing can be out, so the stamps are restored. After a failed `npm publish`, npm is
 * asked which tarball it serves as that version (`dist.integrity`), and that is compared with the
 * integrity of the tarball this run packed:
 * - the same: the upload went through (a lost response, a timeout after it). It counts as
 *   published and the stamps stay, since restoring would leave the checkout behind what npm serves
 *   and npm refuses to publish that version again;
 * - another one: npm had the version before this run, from other code (older or newer: a stale
 *   checkout, or a fix re-released under the old number). Nothing was published, so the stamps are
 *   restored and the release fails, with both remedies named;
 * - none, or npm cannot say: the stamps are restored, with a hint. npm may have accepted an upload
 *   it has not listed yet (it can take minutes; re-running the explicit version then counts it as
 *   published) or refused before any upload (no login, a version below npm's latest): the error is
 *   on screen, so the hint names both.
 * Asking only whether the version exists could not tell the first two apart. A dry run always
 * restores.
 *
 * steps: publishedIntegrity(name, version) → Promise<string | null>, restore() → string[] (the
 *   files it changed).
 */
async function settleSingleReleaseFailure({ stage, dryRun = false, name, version, integrity, steps, log = ignoreLog }) {
  if (stage !== 'publish' || dryRun || !name || !version) return { published: false, restored: steps.restore() };

  let served;
  let askError = null;
  try {
    served = await steps.publishedIntegrity(name, version);
  } catch (error) {
    askError = error instanceof Error ? error.message : String(error);
  }
  if (integrity && served === integrity) {
    log(`npm reported a failure, but it serves this very tarball as ${name}@${version} (same integrity): counted as published, and the version stamps stay.`);
    return { published: true, restored: [] };
  }

  const restored = steps.restore();
  if (typeof served === 'string' && !integrity) {
    log(
      `npm lists ${name}@${version}, but this run's tarball integrity is unknown, so it cannot tell whether this run uploaded it.` +
        ` The version stamps are restored: compare \`npm view ${name}@${version} dist.integrity\` with the tarball before releasing again.`,
    );
  } else if (typeof served === 'string') {
    // Either side can hold the newer code: a checkout behind npm (a stale worktree), or a fix
    // re-released under the old version number.
    log(
      `npm already has ${name}@${version}, built from other code than this run's tarball (npm: ${served}; this run: ${integrity}),` +
        ' so nothing was published, and the version stamps are restored.' +
        ` If this checkout is behind npm (\`npm view ${name} version\` shows npm's latest), update it before releasing;` +
        " if npm's copy is the older code, release a version above npm's latest.",
    );
  } else {
    // The publish ran with stdio 'inherit', so its error is on screen and not in hand here: npm may
    // have refused before any upload (no login, a version below npm's latest), or accepted an
    // upload it has not listed yet.
    const reason = !askError
      ? `npm does not list ${name}@${version}`
      : /^Could not ask npm\b/.test(askError)
        ? askError
        : `Could not ask npm which tarball it serves as ${name}@${version} (${askError})`;
    log(
      `${reason}, so the version stamps are restored. If npm accepted the upload, it can take a few minutes to list it:` +
        ` re-running with the explicit version ${version} then counts an identical tarball as published. Otherwise fix the error npm` +
        " printed above first (not logged in: `npm login`; a version below npm's latest needs a dist-tag these scripts never pass:" +
        " update a checkout that is behind npm, or release a version above npm's latest).",
    );
  }
  return { published: false, restored };
}

/** The file `npm pack` writes for a package: @scope/name 1.2.3 → scope-name-1.2.3.tgz. */
function tarballFileName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * The release plan: every package, in publish order, with `skip` set when `<name>@<version>` is
 * already on npm. npm refuses to republish a version, so a run that stopped part way is finished
 * by running the same version again: what went out is skipped (never rebuilt or republished, only
 * stamped), and the rest is built and published.
 */
function planRelease(version, publishedNames = new Set()) {
  return RELEASE_PACKAGES.map((pkg) => ({ ...pkg, version, skip: publishedNames.has(pkg.name) }));
}

const MANIFEST_FORMAT = 1;

/** The phases' default `log`: tests that do not read the output pass none. */
const ignoreLog = () => undefined;

/** What phase 1 leaves in dist/release beside the tarballs, and phase 2 publishes from. */
function createManifest({ version, rehearsal, createdAt, plan, artifacts }) {
  return {
    format: MANIFEST_FORMAT,
    version,
    rehearsal: Boolean(rehearsal),
    createdAt,
    packages: plan.map((pkg) => {
      const base = { id: pkg.id, kind: pkg.kind, name: pkg.name, version };
      if (pkg.skip) return { ...base, skipped: 'already on npm' };
      const artifact = artifacts.get(pkg.id);
      return {
        ...base,
        tarball: artifact.filename,
        integrity: artifact.integrity,
        size: artifact.size,
        entryCount: artifact.entryCount,
      };
    }),
  };
}

/**
 * Refuses a manifest phase 2 must not publish from: none, an older format, another version, a
 * package list that is not this release's, a package without a tarball and integrity, or (for a
 * real publish) the tarballs of a rehearsal, whose version stamps were already restored.
 */
function validateManifest(manifest, version, { rehearsal = false } = {}) {
  const rerun = `run \`node tools/scripts/release-all.js ${version}\` (or with --build-only) first`;
  if (!manifest) throw new Error(`dist/release holds no finished build: ${rerun}.`);
  if (manifest.format !== MANIFEST_FORMAT) throw new Error(`dist/release was built by another version of release:all: ${rerun}.`);
  if (manifest.version !== version) {
    throw new Error(`dist/release holds a build of ${manifest.version}, not ${version}: ${rerun}.`);
  }
  if (manifest.rehearsal && !rehearsal) {
    throw new Error(`dist/release holds the tarballs of a rehearsal, whose version stamps were restored: ${rerun}.`);
  }
  const expected = RELEASE_PACKAGES.map((pkg) => pkg.name).join(', ');
  const listed = Array.isArray(manifest.packages) ? manifest.packages.map((pkg) => pkg?.name).join(', ') : '';
  if (listed !== expected) throw new Error(`dist/release/release-manifest.json does not list this release's packages in order: ${rerun}.`);
  for (const pkg of manifest.packages) {
    if (pkg.version !== version) throw new Error(`${pkg.name} in the manifest is ${pkg.version}, not ${version}: ${rerun}.`);
    if (!pkg.skipped && (typeof pkg.tarball !== 'string' || typeof pkg.integrity !== 'string')) {
      throw new Error(`${pkg.name} has no tarball in the manifest: ${rerun}.`);
    }
  }
  return manifest;
}

/**
 * Phase 1: stamp every package, then build, verify and pack everything that is not on npm yet.
 * Nothing is published. When any step fails, every version stamp is restored and the error is
 * rethrown, so the checkout is left as it was; dist/release then holds no manifest, and phase 2
 * refuses to run from it.
 *
 * steps: snapshotStamps() → { restore() → string[] }, prepareStaging(), stamp(dir, version),
 *   buildCli(pkg) / buildLib(pkg) → { name, version, filename, integrity, size, entryCount },
 *   writeManifest(manifest), now() → ISO string.
 */
async function runBuildPhase({ version, plan, rehearsal = false, steps, log = ignoreLog }) {
  const stamps = await steps.snapshotStamps();
  try {
    await steps.prepareStaging();

    log(`\n→ Stamping ${version} into ${STAMPED_DIRS.length} package.json files`);
    for (const dir of STAMPED_DIRS) await steps.stamp(dir, version);

    const byId = new Map(plan.map((pkg) => [pkg.id, pkg]));
    const artifacts = new Map();
    for (const { id } of BUILD_ORDER) {
      const pkg = byId.get(id);
      if (pkg.skip) {
        log(`\n⏭  ${pkg.name}@${version} is already on npm: not rebuilt (its version is stamped).`);
        continue;
      }
      log(`\n→ ${pkg.name}: ${pkg.kind === 'cli' ? 'sync the template, pack, check the tarball' : 'build, pack, verify'}`);
      const artifact = pkg.kind === 'cli' ? await steps.buildCli(pkg) : await steps.buildLib(pkg);
      if (artifact.name !== pkg.name || artifact.version !== version) {
        throw new Error(`npm packed ${artifact.name}@${artifact.version}, expected ${pkg.name}@${version}.`);
      }
      artifacts.set(id, artifact);
      log(`✓ ${artifact.filename} (${artifact.entryCount} files)`);
    }

    const manifest = createManifest({ version, rehearsal, createdAt: steps.now(), plan, artifacts });
    await steps.writeManifest(manifest);
    return { manifest, stamps };
  } catch (error) {
    try {
      const restored = await stamps.restore();
      log(`\n↺ Phase 1 failed: restored ${restored.length} version-stamped file${restored.length === 1 ? '' : 's'}${restored.length ? ` (${restored.join(', ')})` : ''}. Nothing was published.`);
    } catch (restoreError) {
      log(
        `\n⚠ Phase 1 failed and restoring the version stamps failed too (${restoreError instanceof Error ? restoreError.message : restoreError}).` +
          ` Check ${STAMPED_FILES.join(', ')}. Nothing was published.`,
      );
    }
    throw error;
  }
}

/**
 * Phase 2: publish the tarballs phase 1 verified, back to back, in publish order. Every check runs
 * before the first publish, so a problem stops the phase while nothing is out: each tarball must
 * still match the integrity npm reported when it packed it, `npm whoami` must answer (a rehearsal
 * only warns), and npm is asked again which versions are out (a run that resumes right after a
 * failure may only now see what the previous run published, since npm takes minutes to list a new
 * version). A failed publish is checked against npm once: when the version is there after all
 * (a lost response, a duplicate refused), it counts as out and the phase goes on; otherwise the
 * phase stops and the result names what went out and what is left. Phase 2 never restores version
 * stamps: once a package may be out, the checkout stays at the release version so the rest can be
 * published with --publish-only.
 *
 * steps: checkTarball(entry), whoami() → string, isPublished(name, version) → Promise<boolean>,
 *   publish(entry, { dryRun }) (throws when npm fails).
 */
async function runPublishPhase({ manifest, dryRun = false, steps, log = ignoreLog }) {
  const candidates = manifest.packages.filter((pkg) => !pkg.skipped);
  const skippedAtBuild = manifest.packages.filter((pkg) => pkg.skipped);
  const result = { published: [], alreadyOut: [...skippedAtBuild], failed: null, notAttempted: [] };
  if (candidates.length === 0) return result;

  for (const pkg of candidates) await steps.checkTarball(pkg);

  if (dryRun) {
    try {
      log(`npm user: ${await steps.whoami()}`);
    } catch {
      log('⚠ `npm whoami` failed: a real release would stop here. Run `npm login` before releasing.');
    }
  } else {
    let user;
    try {
      user = await steps.whoami();
    } catch {
      throw new Error('Not logged in to npm (`npm whoami` failed): run `npm login`, then publish the same tarballs with --publish-only.');
    }
    log(`npm user: ${user}`);
  }

  const status = await Promise.all(candidates.map((pkg) => steps.isPublished(pkg.name, pkg.version)));
  const alreadyOut = candidates.filter((_, index) => status[index]);
  const queue = candidates.filter((_, index) => !status[index]);
  for (const pkg of alreadyOut) log(`⏭  ${pkg.name}@${pkg.version} is already on npm: skipped.`);
  result.alreadyOut.push(...alreadyOut);
  if (queue.length === 0) return result;

  log(
    dryRun
      ? `\nPublishing ${queue.length} package${queue.length === 1 ? '' : 's'} with \`npm publish --dry-run\`: no approval, nothing reaches npm.`
      : `\n\x07Publishing ${queue.length} package${queue.length === 1 ? '' : 's'} back to back. npm opens ONE browser approval at the first publish:` +
          '\napprove it and the others follow without asking (one approval covers about five minutes of publishes;' +
          '\nthis takes about three). If npm asks again before the last package, approve once more.',
  );

  for (let index = 0; index < queue.length; index += 1) {
    const pkg = queue[index];
    try {
      await steps.publish(pkg, { dryRun });
      result.published.push(pkg);
    } catch (error) {
      let out = false;
      if (!dryRun) {
        try {
          out = await steps.isPublished(pkg.name, pkg.version);
        } catch {
          out = false;
        }
      }
      if (out) {
        log(`⏭  npm reported a failure, but ${pkg.name}@${pkg.version} is on npm: counted as published.`);
        result.alreadyOut.push(pkg);
        continue;
      }
      result.failed = { pkg, message: error instanceof Error ? error.message : String(error) };
      result.notAttempted = queue.slice(index + 1);
      return result;
    }
  }
  return result;
}

/** The lines the release prints when phase 2 stops: what is out, what is left, how to resume. */
function describePublishFailure(result, version) {
  const names = (list) => list.map((pkg) => pkg.name).join(', ') || 'none';
  return [
    `❌ Publishing ${result.failed.pkg.name}@${version} failed: ${result.failed.message}`,
    `   Published now: ${names(result.published)}.`,
    `   Already on npm: ${names(result.alreadyOut)}.`,
    `   Not published: ${names([result.failed.pkg, ...result.notAttempted])}.`,
    '',
    `The checkout stays stamped at ${version} and dist/release still holds the verified tarballs.`,
    `Resume (publishes only what is not on npm yet, with one new approval):`,
    `  node tools/scripts/release-all.js ${version} --publish-only`,
    `If the error says the version already exists, npm may not list it yet: wait a few minutes and resume.`,
  ];
}

/** The plan `--dry-run` prints. `published` maps a package name to true, false, or null (unknown). */
function describeDryRun({ version, versionSpec, currentVersions, published, options, manifest, manifestError }) {
  const lines = [];
  const flags = [options.rehearse && '--rehearse', options.buildOnly && '--build-only', options.publishOnly && '--publish-only']
    .filter(Boolean)
    .join(' ');
  lines.push(`release:all ${version}${versionSpec !== version ? ` (${versionSpec})` : ''}${flags ? ` ${flags}` : ''}: DRY RUN, nothing is stamped, built or published`);

  const status = (name) =>
    published.get(name) === true ? '  (already on npm: skip)' : published.get(name) == null ? '  (npm status unknown)' : '';

  lines.push('', 'Packages, in publish order (current → target):');
  for (const pkg of RELEASE_PACKAGES) {
    const current = currentVersions[pkg.dir] ?? '(unknown)';
    lines.push(`  ${pkg.name.padEnd(26)} ${String(current).padEnd(10)} → ${version}${status(pkg.name)}`);
  }
  for (const [label, dir] of [['(root nextblock)', '.'], ['(apps/nextblock)', 'apps/nextblock']]) {
    lines.push(`  ${label.padEnd(26)} ${String(currentVersions[dir] ?? '(unknown)').padEnd(10)} → ${version}`);
  }

  if (!options.publishOnly) {
    lines.push('', 'Phase 1: build and verify everything; nothing is published');
    lines.push('  clear dist/release');
    lines.push(`  npm version ${version} in ${STAMPED_DIRS.map((dir) => (dir === '.' ? '(root)' : dir)).join(', ')}`);
    for (const { id } of BUILD_ORDER) {
      const pkg = RELEASE_PACKAGES.find((entry) => entry.id === id);
      if (published.get(pkg.name) === true) {
        lines.push(`  ${pkg.name.padEnd(26)} skip: ${version} is already on npm`);
      } else if (pkg.kind === 'cli') {
        lines.push(`  ${pkg.name.padEnd(26)} npm run sync:create-nextblock (template + npm pack checks), npm pack → dist/release, check the tarball holds the whole template`);
      } else {
        lines.push(`  ${pkg.name.padEnd(26)} nx build (production), npm pack → dist/release, verify-lib-dist checks on the packed files`);
      }
    }
    lines.push('  write dist/release/release-manifest.json (tarballs + integrity)');
    if (options.buildOnly) {
      lines.push('', `Then, at the browser: node tools/scripts/release-all.js ${version} --publish-only`);
      return lines;
    }
  }

  lines.push('', `Phase 2: publish back to back${options.rehearse ? ' with npm publish --dry-run' : ' (one npm browser approval)'}`);
  if (options.publishOnly) {
    if (manifestError) {
      lines.push(`  ✗ ${manifestError}`);
      return lines;
    }
    lines.push(`  from the build made ${manifest.createdAt}`);
  }
  lines.push('  check every tarball against its integrity, npm whoami, ask npm again which versions are out');
  lines.push(`  each publish adds: --access public --ignore-scripts ${PUBLISH_REGISTRY_FLAGS.join(' ')}${options.rehearse ? ' --dry-run' : ''}`);
  const entries = options.publishOnly
    ? manifest.packages.map((pkg) => ({ ...pkg, skipped: pkg.skipped || published.get(pkg.name) === true }))
    : RELEASE_PACKAGES.map((pkg) => ({ ...pkg, skipped: published.get(pkg.name) === true, tarball: tarballFileName(pkg.name, version) }));
  for (const pkg of entries) {
    lines.push(
      pkg.skipped
        ? `  ${pkg.name.padEnd(26)} skip: already on npm`
        : `  ${pkg.name.padEnd(26)} npm publish ./dist/release/${pkg.tarball}`,
    );
  }
  if (options.rehearse && !options.publishOnly) lines.push('  restore every version stamp phase 1 wrote');
  return lines;
}

module.exports = {
  BUILD_ORDER,
  BUMP_KEYWORDS,
  CLI_STAMPED_DIRS,
  LIBS,
  PLAIN_VERSION,
  PUBLISH_REGISTRY,
  PUBLISH_REGISTRY_FLAGS,
  RELEASE_PACKAGES,
  STAMPED_DIRS,
  STAMPED_FILES,
  TEMPLATE_PACKAGE_JSON,
  USAGE,
  UsageError,
  assertVersionSpec,
  bumpVersion,
  createManifest,
  describeDryRun,
  describePublishFailure,
  filesStampedIn,
  packageNameFor,
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
};
