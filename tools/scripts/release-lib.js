#!/usr/bin/env node

// Build and publish ONE library (npm run build:<lib>):
//
//   node tools/scripts/release-lib.js <library> [<version>|patch|minor|major] [--dry-run]
//
// `<library>` is the libs/ folder (use `ecommerce` for @nextblock-cms/ecom). For a release of every
// package use release-all.js: it runs these same steps for all of them first and publishes
// afterwards, inside one npm approval. Steps (lib/release-steps.js): stamp libs/<lib>/package.json,
// build with Nx, finalize the premium manifests, pack into dist/release-lib, run the
// verify-lib-dist checks on the packed files, and `npm publish <tarball>`. A failure restores the
// version stamp (unless npm serves this very tarball after all: see settleSingleReleaseFailure),
// and so does --dry-run, which builds and packs for real and ends with `npm publish --dry-run`.
// Versions are plain x.y.z: pre-releases are refused (lib/release-pipeline.js says why).

const fs = require('node:fs');
const path = require('node:path');
const { UsageError, parseSingleReleaseArgs, settleSingleReleaseFailure } = require('./lib/release-pipeline');
const steps = require('./lib/release-steps');

const USAGE = 'Usage: node tools/scripts/release-lib.js <library> [<version>|patch|minor|major] [--dry-run]';

async function main() {
  let options;
  try {
    options = parseSingleReleaseArgs(process.argv.slice(2), process.env, { withLibrary: true });
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  const { library, versionSpec, dryRun } = options;
  // Read above. Every child npm would read it too: `npm pack` would then write no tarball (and the
  // publish already passes --dry-run itself when this is a dry run).
  delete process.env.npm_config_dry_run;

  const libDir = `libs/${library}`;
  const packageJsonPath = path.join(steps.workspaceRoot, libDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`Library package.json not found at ${packageJsonPath}\n${USAGE}`);
    return 1;
  }

  const stagingDir = path.join(steps.workspaceRoot, 'dist', 'release-lib');
  const stamps = steps.snapshotFiles([`${libDir}/package.json`, `${libDir}/package-lock.json`]);
  const restoreStamps = (reason) => {
    const restored = stamps.restore();
    if (restored.length > 0) console.log(`↺ ${reason}: restored ${restored.join(', ')}.`);
    return restored;
  };

  let packageName;
  let version;
  let artifact;
  let stage = 'build';
  try {
    packageName = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).name;
    console.log(`\n🚀 Releasing ${packageName} (${library})${dryRun ? ' (DRY RUN: npm publish --dry-run, version restored at the end)' : ''}`);

    steps.prepareStaging(stagingDir);
    console.log(`→ Setting version (${versionSpec})`);
    version = steps.stampVersion(libDir, versionSpec);

    console.log('\n→ Building with Nx');
    artifact = steps.buildLibArtifact(library, { stagingDir });
    if (artifact.name !== packageName || artifact.version !== version) {
      throw new Error(`npm packed ${artifact.name}@${artifact.version}, expected ${packageName}@${version}.`);
    }

    // Every package, premium commerce included, is published publicly to npmjs: premium features
    // are source-available and gated at runtime via verifyPackageOnline().
    console.log('\n→ Publishing to npm (public)');
    stage = 'publish';
    steps.publishTarball(artifact.tarballPath, { dryRun });
    console.log(`\n✅ Published ${artifact.name}@${artifact.version}${dryRun ? ' (dry run)' : ''}\n`);

    if (dryRun) restoreStamps('Dry run');
    return 0;
  } catch (error) {
    console.error('\n❌ Release failed.');
    if (error instanceof Error) console.error(error.message);
    const settled = await settleSingleReleaseFailure({
      stage,
      dryRun,
      name: packageName,
      version,
      integrity: artifact?.integrity,
      steps: { publishedIntegrity: steps.publishedIntegrity, restore: () => restoreStamps('Reverted the version') },
      log: (line) => console.log(line),
    });
    return settled.published ? 0 : 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`\n❌ release-lib failed: ${error instanceof Error ? error.stack || error.message : error}`);
    process.exitCode = 1;
  },
);
