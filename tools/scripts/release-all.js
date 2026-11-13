#!/usr/bin/env node

// Build + publish EVERY NextBlock package at a single, synchronized version.
//
//   npm run release:all -- 0.8.0            # stamp all packages to 0.8.0 and publish
//   npm run release:all -- minor            # bump each by minor (note: only syncs if already aligned)
//   npm run release:all -- 0.8.0 --dry-run  # print the plan, change/publish nothing
//
// Publishes in dependency order so each package's @nextblock-cms/* deps are already on
// npmjs when it goes out: libs (utils → ui → sdk → db → editor → ecommerce → cortex →
// affiliates) then the CLI.
// The CLI step (release-cli.js) also stamps the root + template (apps/nextblock) and the
// create-nextblock package, syncs the template, and publishes create-nextblock.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionArg = args.find((a) => !a.startsWith('--'));

function isVersionSpec(value) {
  return (
    typeof value === 'string' &&
    (['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'].includes(
      value,
    ) ||
      /^\d+\.\d+\.\d+([-+].+)?$/.test(value))
  );
}

if (!isVersionSpec(versionArg)) {
  console.error(
    'Usage: npm run release:all -- <version|patch|minor|major> [--dry-run]\n' +
      'Pass an explicit version (e.g. 0.8.0) to synchronize every package to the same version.',
  );
  process.exit(1);
}

const versionSpec = versionArg;
const workspaceRoot = process.cwd();

// Dependency-ordered: a package's @nextblock-cms/* deps must publish before it.
// cortex depends on db + ecommerce + utils; affiliates (utils + ui) goes after it, and every
// lib before the CLI, whose template depends on all of them.
const LIBS = ['utils', 'ui', 'sdk', 'db', 'editor', 'ecommerce', 'cortex', 'affiliates'];

function pkgName(lib) {
  return `@nextblock-cms/${lib === 'ecommerce' ? 'ecom' : lib}`;
}

function readVersion(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relPath), 'utf8')).version;
  } catch {
    return '(unknown)';
  }
}

function run(command) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: 'inherit', shell: true, cwd: workspaceRoot });
}

// An explicit semver stamps every package to the same version, so "already on npm at that
// version" is knowable up front. Bump keywords (patch/minor/...) resolve per-package at
// release-lib time, so we can't pre-check them.
const isExplicitVersion = /^\d+\.\d+\.\d+([-+].+)?$/.test(versionSpec);

function publishedVersion(name) {
  try {
    return execSync(`npm view ${name} version`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    return null; // never published, or the registry is unreachable — let the real step decide
  }
}

// npm refuses to republish an existing version, so a mid-chain failure used to strand the
// run: re-running died immediately on the packages that HAD gone out. Skip those instead,
// which makes `release:all <same version>` a safe resume.
const alreadyPublished = new Set(
  isExplicitVersion
    ? LIBS.filter((lib) => publishedVersion(pkgName(lib)) === versionSpec)
    : [],
);

// A skipped lib still has to carry the target version locally: release-lib.js resolves
// sibling `workspace:*` deps by reading libs/<name>/package.json, so a stale version there
// would publish downstream packages pointing at the wrong sibling range.
function stampLocalVersion(lib) {
  const pkgPath = path.join(workspaceRoot, 'libs', lib, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (pkg.version === versionSpec) return;
  pkg.version = versionSpec;
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline);
  console.log(`  ↳ stamped libs/${lib}/package.json to ${versionSpec} (not republished)`);
}

console.log(
  `\n🚀 release:all → "${versionSpec}"${dryRun ? '   (DRY RUN — plan only, nothing changed or published)' : ''}`,
);
console.log('\nPlan (publish order, current → target):');
for (const lib of LIBS) {
  const status = alreadyPublished.has(lib) ? '   (already on npm — skip)' : '';
  console.log(
    `  ${pkgName(lib).padEnd(26)} ${String(readVersion(`libs/${lib}/package.json`)).padEnd(10)} → ${versionSpec}${status}`,
  );
}
console.log(
  `  ${'create-nextblock (CLI)'.padEnd(26)} ${String(readVersion('apps/create-nextblock/package.json')).padEnd(10)} → ${versionSpec}`,
);
console.log(
  `  ${'(root nextblock)'.padEnd(26)} ${String(readVersion('package.json')).padEnd(10)} → ${versionSpec}`,
);
console.log(
  `  ${'(template)'.padEnd(26)} ${String(readVersion('apps/nextblock/package.json')).padEnd(10)} → ${versionSpec}`,
);

if (dryRun) {
  console.log('\nDRY RUN — would run:');
  for (const lib of LIBS) {
    if (alreadyPublished.has(lib)) {
      console.log(`  (skip ${pkgName(lib)} — ${versionSpec} already published)`);
      continue;
    }
    console.log(`  node tools/scripts/release-lib.js ${lib} ${versionSpec}`);
  }
  console.log(`  node tools/scripts/release-cli.js ${versionSpec}`);
  console.log('\nNo versions changed, nothing built or published.');
  process.exit(0);
}

// Preflight: fail fast if not authenticated, so we never half-publish the set.
try {
  const who = execSync('npm whoami', {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  console.log(`\nnpm user: ${who}`);
} catch {
  console.error(
    '\n❌ Not logged in to npm (`npm whoami` failed). Run `npm login` first, then re-run.',
  );
  process.exit(1);
}

try {
  for (const lib of LIBS) {
    if (alreadyPublished.has(lib)) {
      console.log(`\n⏭  ${pkgName(lib)}@${versionSpec} is already on npm — skipping.`);
      stampLocalVersion(lib);
      continue;
    }
    run(`node tools/scripts/release-lib.js ${lib} ${versionSpec}`);
  }
  // Also stamps root + template (apps/nextblock) + create-nextblock, syncs the template,
  // and publishes the create-nextblock CLI.
  run(`node tools/scripts/release-cli.js ${versionSpec}`);

  console.log(`\n✅ release:all complete — every package published at ${versionSpec}.`);
} catch (error) {
  console.error('\n❌ release:all failed.');
  if (error instanceof Error) console.error(error.message);
  console.error(
    'Some packages may already be published. Inspect with `npm view <pkg> version`, then re-run for the remaining packages.',
  );
  process.exit(1);
}
