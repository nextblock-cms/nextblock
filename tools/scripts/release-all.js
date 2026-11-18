#!/usr/bin/env node

// Build, verify and publish EVERY NextBlock package at one synchronized version, in two phases
// so that one npm browser approval covers every publish:
//
//   node tools/scripts/release-all.js 0.23.6                 # phase 1 (build), then phase 2 (publish)
//   node tools/scripts/release-all.js 0.23.6 --dry-run       # print both phases; change nothing
//   node tools/scripts/release-all.js 0.23.6 --rehearse      # both phases for real, `npm publish --dry-run`, stamps restored
//   node tools/scripts/release-all.js 0.23.6 --build-only    # phase 1 only (unattended, about 7 minutes)
//   node tools/scripts/release-all.js 0.23.6 --publish-only  # phase 2 only, when you are at the browser
//
// Phase 1 stamps the version into the 8 libs, the root, apps/nextblock and create-nextblock,
// syncs the CLI template, builds every lib, runs every publish check, and packs each package into
// dist/release with a manifest of the tarballs. It publishes nothing; when any step fails, every
// version stamp is restored. Phase 2 checks each tarball against its packed integrity, `npm whoami`
// and npm's view of which versions are out, then runs `npm publish <tarball>` for the packages in
// dependency order (utils → ui → sdk → db → editor → ecom → cortex → affiliates → create-nextblock),
// back to back. A package already on npm at the target version is skipped in both phases, so
// running the same explicit version again resumes a run that stopped part way; `--publish-only`
// resumes from the tarballs without rebuilding. A bump keyword (major|minor|patch) is refused while
// npm lacks the checkout's version of any package, since it would bump past that release. The plan
// and the failure handling are in lib/release-pipeline.js, the side effects in lib/release-steps.js.
//
// Call it with node. Windows PowerShell drops the `--` of `npm run release:all -- 0.23.6 --dry-run`
// and npm then keeps `--dry-run` for itself (the script honours npm_config_dry_run, but that is a
// safety net). Never pipe the output: npm's browser approval needs the terminal (EOTP otherwise);
// record a log with Start-Transcript instead.

const path = require('node:path');
const {
  BUMP_KEYWORDS,
  RELEASE_PACKAGES,
  STAMPED_DIRS,
  STAMPED_FILES,
  USAGE,
  UsageError,
  describeDryRun,
  describePublishFailure,
  parseReleaseArgs,
  planRelease,
  refuseKeywordPastUnfinishedRelease,
  resolveReleaseVersion,
  runBuildPhase,
  runPublishPhase,
  validateManifest,
} = require('./lib/release-pipeline');
const steps = require('./lib/release-steps');

const STAGING = path.relative(steps.workspaceRoot, steps.STAGING_DIR).split(path.sep).join('/');

const buildSteps = {
  snapshotStamps: () => steps.snapshotStamps(STAMPED_FILES),
  prepareStaging: () => steps.prepareStaging(steps.STAGING_DIR),
  stamp: (dir, version) => steps.stampVersion(dir, version),
  buildCli: () => steps.buildCliArtifact({ stagingDir: steps.STAGING_DIR }),
  buildLib: (pkg) => steps.buildLibArtifact(pkg.id, { stagingDir: steps.STAGING_DIR }),
  writeManifest: (manifest) => steps.writeManifest(manifest, steps.STAGING_DIR),
  now: () => new Date().toISOString(),
};

const publishSteps = {
  checkTarball: (entry) => steps.checkTarball(entry, { stagingDir: steps.STAGING_DIR }),
  whoami: () => steps.npmWhoami(),
  isPublished: (name, version) => steps.isPublished(name, version),
  publish: (entry, { dryRun }) => steps.publishTarball(path.join(steps.STAGING_DIR, entry.tarball), { dryRun }),
};

const log = (line) => console.log(line);

/** name → true (on npm), false (not on npm), or null (unknown, only when `tolerant`). */
async function queryPublished(version, { tolerant }) {
  const answers = await Promise.all(
    RELEASE_PACKAGES.map((pkg) =>
      steps.isPublished(pkg.name, version).catch((error) => {
        if (tolerant) return null;
        throw error;
      }),
    ),
  );
  return new Map(RELEASE_PACKAGES.map((pkg, index) => [pkg.name, answers[index]]));
}

function stampedFileList() {
  return STAMPED_FILES.join(', ');
}

function reportPublished(result, version, { dryRun }) {
  const names = (list) => list.map((pkg) => pkg.name).join(', ') || 'none';
  if (dryRun) {
    log(`\n✅ Rehearsal of ${version} passed: ${result.published.length} package(s) dry-run published (${names(result.published)}); already on npm: ${names(result.alreadyOut)}.`);
    return;
  }
  log(`\n✅ release:all ${version} complete: published ${names(result.published)}; already on npm: ${names(result.alreadyOut)}.`);
  if (result.published.length > 0) {
    log('npm takes a few minutes to list a new version. Before tagging or announcing, check that each tarball answers 200, e.g.');
    log(`  curl -sI https://registry.npmjs.org/create-nextblock/-/create-nextblock-${version}.tgz`);
  }
}

async function dryRun(options, version, currentVersions) {
  let manifest = null;
  let manifestError = null;
  if (options.publishOnly) {
    try {
      manifest = validateManifest(steps.readManifest(), version, { rehearsal: options.rehearse });
    } catch (error) {
      manifestError = error.message;
    }
  }
  const published = await queryPublished(version, { tolerant: true });
  for (const line of describeDryRun({ version, versionSpec: options.versionSpec, currentVersions, published, options, manifest, manifestError })) {
    log(line);
  }
  log('\nDRY RUN: nothing was stamped, built or published.');
  return manifestError ? 1 : 0;
}

async function publishOnly(options, version, currentVersions) {
  let manifest;
  try {
    manifest = validateManifest(steps.readManifest(), version, { rehearsal: options.rehearse });
  } catch (error) {
    console.error(`❌ ${error.message}`);
    return 1;
  }
  log(`\n🚀 release:all ${version}: phase 2${options.rehearse ? ' (rehearsal: npm publish --dry-run)' : ''}, from the build made ${manifest.createdAt}`);
  const drift = Object.entries(currentVersions).filter(([, current]) => current !== version);
  if (drift.length > 0 && !options.rehearse) {
    log(`⚠ The checkout is not stamped at ${version} (${drift.map(([dir, current]) => `${dir === '.' ? '(root)' : dir} ${current}`).join(', ')}): stamp it before committing the release.`);
  }

  let result;
  try {
    result = await runPublishPhase({ manifest, dryRun: options.rehearse, steps: publishSteps, log });
  } catch (error) {
    console.error(`\n❌ ${error.message}\nNothing was published.`);
    return 1;
  }
  if (result.failed) {
    for (const line of describePublishFailure(result, version)) console.error(line);
    return 1;
  }
  reportPublished(result, version, { dryRun: options.rehearse });
  return 0;
}

async function fullRun(options, version, currentVersions) {
  const label = options.rehearse ? ' (REHEARSAL: npm publish --dry-run, version stamps restored at the end)' : options.buildOnly ? ' (phase 1 only)' : '';
  log(`\n🚀 release:all → ${version}${label}`);
  // A rehearsal puts the stamped files back as it found them. Ctrl+C skips that restore (the
  // release scripts install no Ctrl+C handler, so the process ends at once), and a second rehearsal
  // would then snapshot, and keep, the stamps the first one left.
  const alreadyStamped = Object.entries(currentVersions).filter(([, current]) => current === version);
  if (options.rehearse && alreadyStamped.length > 0) {
    log(
      `⚠ ${alreadyStamped.map(([dir]) => (dir === '.' ? '(root)' : dir)).join(', ')} already read${alreadyStamped.length === 1 ? 's' : ''} ${version}, and the` +
        ' rehearsal restores the stamped files to what they hold now, so that stays. If an interrupted rehearsal left it, restore' +
        ` the version lines in ${stampedFileList()} by hand afterwards.`,
    );
  }

  // Which versions are out decides what to build. A registry error stops the run here, before
  // anything changes (a rehearsal treats an unknown answer as "not published").
  let published;
  try {
    published = await queryPublished(version, { tolerant: options.rehearse });
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : error}\nNothing was changed.`);
    return 1;
  }
  const plan = planRelease(version, new Set([...published].filter(([, out]) => out === true).map(([name]) => name)));
  const toShip = plan.filter((pkg) => !pkg.skip);
  for (const pkg of plan) log(`  ${pkg.name.padEnd(26)} ${pkg.skip ? 'already on npm: skip' : 'build, verify, pack, publish'}`);

  // A real release checks the npm login before building, not after minutes of builds.
  if (toShip.length > 0) {
    try {
      log(`\nnpm user: ${steps.npmWhoami()}`);
    } catch {
      if (!options.rehearse && !options.buildOnly) {
        console.error('\n❌ Not logged in to npm (`npm whoami` failed). Run `npm login` first, then re-run.');
        return 1;
      }
      log('\n⚠ Not logged in to npm: run `npm login` before publishing.');
    }
  }

  log(`\n════ Phase 1 of 2: build and verify everything (nothing is published) ════`);
  let built;
  try {
    built = await runBuildPhase({ version, plan, rehearsal: options.rehearse, steps: buildSteps, log });
  } catch (error) {
    console.error(`\n❌ Phase 1 failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  const { manifest, stamps } = built;
  const cliBuilt = manifest.packages.some((pkg) => pkg.kind === 'cli' && !pkg.skipped);

  if (options.buildOnly) {
    const builtCount = manifest.packages.filter((pkg) => !pkg.skipped).length;
    if (builtCount === 0) {
      log(`\n✅ Every package is already on npm at ${version}: nothing to build or publish (the version is stamped).`);
      return 0;
    }
    log(`\n✅ Phase 1 done: ${builtCount} package(s) built, verified and packed into ${STAGING}. Nothing was published.`);
    log(`Publish them when you can approve in the browser (one approval):\n  node tools/scripts/release-all.js ${version} --publish-only`);
    log(`To abandon the release instead, restore the version stamps in: ${stampedFileList()}.`);
    return 0;
  }

  log(`\n════ Phase 2 of 2: publish${options.rehearse ? ' (npm publish --dry-run)' : ''} ════`);
  let result;
  try {
    result = await runPublishPhase({ manifest, dryRun: options.rehearse, steps: publishSteps, log });
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : error}\nNothing was published.`);
    if (!options.rehearse) {
      console.error(`The checkout stays stamped at ${version} and ${STAGING} holds the verified tarballs. Fix the problem, then:\n  node tools/scripts/release-all.js ${version} --publish-only`);
    }
    return 1;
  } finally {
    if (options.rehearse) {
      const restored = stamps.restore();
      log(`\n↺ Rehearsal: restored ${restored.length} version-stamped file(s)${restored.length ? ` (${restored.join(', ')})` : ''}.`);
      if (cliBuilt) log('  templates/nextblock-template stays re-synced from apps/nextblock, as `npm run sync:create-nextblock` leaves it.');
    }
  }

  if (result.failed) {
    if (options.rehearse) {
      console.error(`\n❌ Rehearsal: \`npm publish --dry-run\` failed for ${result.failed.pkg.name}: ${result.failed.message}`);
    } else {
      for (const line of describePublishFailure(result, version)) console.error(line);
    }
    return 1;
  }
  reportPublished(result, version, { dryRun: options.rehearse });
  return 0;
}

async function main() {
  let options;
  try {
    options = parseReleaseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  for (const flag of options.fromNpmConfig) {
    log(`(${flag} reached this script through npm's own config: \`npm run\` under Windows PowerShell drops \`--\`. Call \`node tools/scripts/release-all.js\` directly.)`);
  }
  // Read above; child npm processes would only warn about these unknown configs.
  for (const key of ['npm_config_rehearse', 'npm_config_build_only', 'npm_config_publish_only']) delete process.env[key];

  const currentVersions = steps.readCurrentVersions(STAMPED_DIRS);
  let version;
  try {
    version = resolveReleaseVersion(options.versionSpec, currentVersions);
    if (BUMP_KEYWORDS.includes(options.versionSpec)) {
      // resolveReleaseVersion refused a keyword unless every package shares one version.
      const [currentVersion] = Object.values(currentVersions);
      log(`Checking that npm has ${currentVersion} of every package before "${options.versionSpec}" bumps it to ${version}…`);
      refuseKeywordPastUnfinishedRelease(options.versionSpec, currentVersion, await queryPublished(currentVersion, { tolerant: true }), {
        rehearsal: options.rehearse,
      });
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.dryRun) return dryRun(options, version, currentVersions);
  if (options.publishOnly) return publishOnly(options, version, currentVersions);
  return fullRun(options, version, currentVersions);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`\n❌ release:all failed: ${error instanceof Error ? error.stack || error.message : error}`);
    process.exitCode = 1;
  },
);
