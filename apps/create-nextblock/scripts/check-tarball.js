#!/usr/bin/env node

// Checks a packed create-nextblock tarball against the template on disk:
//
//   node apps/create-nextblock/scripts/check-tarball.js <create-nextblock-x.y.z.tgz>
//
// release:all (tools/scripts/lib/release-steps.js) syncs the template, packs the CLI with
// --ignore-scripts, and later publishes that tarball with `npm publish <tarball>`, which runs no
// prepack: the template sync does not run again, so the tarball must already hold it all. npm reads
// the tarball back (scripts/lib/pack-check.js), and every template file on disk must be in it, no
// local env file may be, and the `bin` script must be there. Exits 1 on any problem.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { findMissingBinFiles, findPackProblems, parsePackedFiles, runNpmPackTarball } from './lib/pack-check.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = resolve(PROJECT_ROOT, 'templates/nextblock-template');

async function main() {
  const [tarball] = process.argv.slice(2);
  if (!tarball) {
    throw new Error('Usage: node apps/create-nextblock/scripts/check-tarball.js <create-nextblock-x.y.z.tgz>');
  }

  console.log(chalk.blue(`Reading ${tarball} back (npm pack <tarball> --dry-run)`));
  const output = runNpmPackTarball(resolve(tarball));
  const packed = parsePackedFiles(output);
  const manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
  const problems = [
    ...(await findPackProblems({ packageDir: PROJECT_ROOT, templateDir: TEMPLATE_DIR, pack: () => output })),
    ...findMissingBinFiles(manifest, packed),
  ];
  if (problems.length > 0) {
    throw new Error(`${tarball} would publish a broken create-nextblock:\n  - ${problems.join('\n  - ')}`);
  }
  console.log(chalk.green(`${tarball} holds the whole template (${packed.length} files).`));
}

main().catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
