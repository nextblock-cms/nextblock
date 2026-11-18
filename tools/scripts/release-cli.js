#!/usr/bin/env node

// Publish the create-nextblock CLI alone (npm run build:cli):
//
//   node tools/scripts/release-cli.js [<version>|patch|minor|major] [--dry-run]
//
// Only for a release in which no lib changed since the last lib publish: new scaffolds install the
// libs at `latest`, so a template that needs unpublished lib code breaks every one of them (0.23.2,
// 2026-11-13). Otherwise use release-all.js, which runs these steps inside its two phases.
// Steps (lib/release-steps.js): stamp the root, apps/nextblock and create-nextblock, sync the
// template, pack create-nextblock into dist/release-cli, read the tarball back to check it holds
// the whole template, and `npm publish <tarball>`, which runs no prepack (the sync just ran).
// A failure restores the version stamps (unless npm serves this very tarball after all: see
// settleSingleReleaseFailure). --dry-run prints the steps and changes nothing. Versions are plain
// x.y.z: pre-releases are refused (lib/release-pipeline.js says why).

const path = require('node:path');
const {
  CLI_STAMPED_DIRS,
  TEMPLATE_PACKAGE_JSON,
  UsageError,
  filesStampedIn,
  parseSingleReleaseArgs,
  settleSingleReleaseFailure,
} = require('./lib/release-pipeline');
const steps = require('./lib/release-steps');

const USAGE = 'Usage: node tools/scripts/release-cli.js [<version>|patch|minor|major] [--dry-run]';

async function main() {
  let options;
  try {
    options = parseSingleReleaseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  const { versionSpec, dryRun } = options;
  // Read above; child npm processes must not inherit it (an `npm pack` under it writes no tarball).
  delete process.env.npm_config_dry_run;

  const stagingDir = path.join(steps.workspaceRoot, 'dist', 'release-cli');
  const staging = path.relative(steps.workspaceRoot, stagingDir).split(path.sep).join('/');

  console.log(`\n🚀 Releasing create-nextblock CLI (${versionSpec})`);

  if (dryRun) {
    console.log('⚠️  DRY RUN MODE: nothing is stamped, synced, packed or published.');
    for (const dir of CLI_STAMPED_DIRS) {
      console.log(`> npm version ${versionSpec} --no-git-tag-version --allow-same-version   (in ${dir === '.' ? 'the root' : dir})`);
    }
    console.log('> npm run sync:create-nextblock   (template + npm pack checks)');
    console.log(`> npm pack --ignore-scripts --json --dry-run=false --pack-destination ${staging}   (in apps/create-nextblock)`);
    console.log(`> node apps/create-nextblock/scripts/check-tarball.js ${staging}/create-nextblock-<version>.tgz`);
    console.log(`> npm publish ./${staging}/create-nextblock-<version>.tgz --access public --ignore-scripts ${steps.REGISTRY_FLAGS.join(' ')}`);
    console.log('\n✅ Release plan printed (dry run).\n');
    return 0;
  }

  const stamps = steps.snapshotStamps([...filesStampedIn(CLI_STAMPED_DIRS), TEMPLATE_PACKAGE_JSON]);

  let cliVersion;
  let artifact;
  let stage = 'build';
  try {
    steps.prepareStaging(stagingDir);
    console.log('\n→ Bumping versions...');
    const versions = CLI_STAMPED_DIRS.map((dir) => steps.stampVersion(dir, versionSpec));
    cliVersion = versions[versions.length - 1];

    console.log('\n→ Syncing the template and packing create-nextblock...');
    artifact = steps.buildCliArtifact({ stagingDir });
    if (artifact.name !== 'create-nextblock' || artifact.version !== cliVersion) {
      throw new Error(`npm packed ${artifact.name}@${artifact.version}, expected create-nextblock@${cliVersion}.`);
    }

    console.log('\n→ Publishing create-nextblock...');
    stage = 'publish';
    steps.publishTarball(artifact.tarballPath);
    console.log(`\n✅ Release complete! create-nextblock@${artifact.version}\n`);
    return 0;
  } catch (error) {
    console.error('\n❌ Release failed.');
    if (error instanceof Error) console.error(error.message);
    const settled = await settleSingleReleaseFailure({
      stage,
      name: 'create-nextblock',
      version: cliVersion,
      integrity: artifact?.integrity,
      steps: {
        publishedIntegrity: steps.publishedIntegrity,
        restore: () => {
          const restored = stamps.restore();
          if (restored.length > 0) console.log(`↺ Reverted the version stamps: ${restored.join(', ')}.`);
          return restored;
        },
      },
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
    console.error(`\n❌ release-cli failed: ${error instanceof Error ? error.stack || error.message : error}`);
    process.exitCode = 1;
  },
);
