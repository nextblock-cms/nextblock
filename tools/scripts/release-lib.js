#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { CORTEX_EXPORTS, ECOM_EXPORTS } = require('./lib-publish-exports');
const { verifyLibDist } = require('./verify-lib-dist');

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(
    'Usage: node tools/scripts/release-lib.js <library> [<version>|patch|minor|major] [--dry-run]',
  );
  process.exit(1);
}

// Accepts an npm bump keyword (patch/minor/major) OR an explicit semver (e.g. 0.8.0).
function isVersionSpec(value) {
  return (
    typeof value === 'string' &&
    (['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'].includes(
      value,
    ) ||
      /^\d+\.\d+\.\d+([-+].+)?$/.test(value))
  );
}

const library = args[0];
const versionArg = args.slice(1).find((a) => !a.startsWith('--'));
const versionSpec = isVersionSpec(versionArg) ? versionArg : 'patch';
const dryRun = args.includes('--dry-run');

const workspaceRoot = process.cwd();
const libDir = path.join(workspaceRoot, 'libs', library);
const packageJsonPath = path.join(libDir, 'package.json');
const distDir = path.join(workspaceRoot, 'dist', 'libs', library);
const nxProject = library;

if (!fs.existsSync(packageJsonPath)) {
  console.error(`Library package.json not found at ${packageJsonPath}`);
  process.exit(1);
}

const originalPackageJsonRaw = fs.readFileSync(packageJsonPath, 'utf8');
const lockfilePath = path.join(libDir, 'package-lock.json');
const hadLockfile = fs.existsSync(lockfilePath);
let version;
let packageName;

function run(command, options = {}) {
  execSync(command, { stdio: 'inherit', shell: true, ...options });
}

// @nextblock-cms/db -> libs/db ; @nextblock-cms/ecom -> libs/ecommerce ;
// @nextblock-cms/cortex -> libs/cortex (the legacy @nextblock/ scope is still
// handled below as a defensive fallback for any un-migrated reference).
function resolveSiblingVersion(depName) {
  const suffix = depName.startsWith('@nextblock-cms/')
    ? depName.replace('@nextblock-cms/', '')
    : depName.startsWith('@nextblock/')
      ? depName.replace('@nextblock/', '')
      : depName;
  const dir = suffix === 'ecom' ? 'ecommerce' : suffix;
  const siblingPkgPath = path.join(workspaceRoot, 'libs', dir, 'package.json');
  try {
    const siblingPkg = JSON.parse(fs.readFileSync(siblingPkgPath, 'utf8'));
    if (siblingPkg.version) return `^${siblingPkg.version}`;
  } catch {
    // fall through to a floating spec
  }
  return 'latest';
}

function resolveWorkspaceDeps(pkg) {
  if (pkg.dependencies) {
    for (const depName of Object.keys(pkg.dependencies)) {
      const spec = pkg.dependencies[depName];
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        if (depName === '@nextblock-cms/ecommerce') {
          pkg.dependencies[depName] = `npm:@nextblock-cms/ecom@${resolveSiblingVersion('@nextblock-cms/ecom')}`;
          continue;
        }
        pkg.dependencies[depName] = resolveSiblingVersion(depName);
      }
    }
  }
}

// libs/ecommerce ships source-available + license-gated (same model as Cortex AI): the
// real module is published publicly to npmjs and gated at runtime via
// verifyPackageOnline('ecommerce'). Its vite build copies the raw source package.json,
// which lacks entry points and still has workspace:* deps — normalize it for publish.
function finalizeEcomDistPackageJson(distPkgPath) {
  const pkg = JSON.parse(fs.readFileSync(distPkgPath, 'utf8'));

  pkg.main = './index.cjs.js';
  pkg.module = './index.es.js';
  pkg.types = './index.d.ts';
  // Defined in lib-publish-exports.js (shared with the publish check).
  pkg.exports = ECOM_EXPORTS;

  resolveWorkspaceDeps(pkg);

  pkg.publishConfig = { access: 'public' };
  delete pkg.nx; // workspace-internal metadata, not for the published package

  fs.writeFileSync(distPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(
    '✓ Normalized ecom dist package.json (entry points + resolved sibling deps + public access)',
  );
}

function finalizeCortexDistPackageJson(distPkgPath) {
  const pkg = JSON.parse(fs.readFileSync(distPkgPath, 'utf8'));

  pkg.main = './index.cjs.js';
  pkg.module = './index.es.js';
  pkg.types = './index.d.ts';
  pkg.exports = CORTEX_EXPORTS;

  resolveWorkspaceDeps(pkg);

  pkg.publishConfig = { access: 'public' };
  delete pkg.nx;

  fs.writeFileSync(distPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(
    '✓ Normalized cortex dist package.json (entry points + resolved sibling deps + public access)',
  );
}

try {
  const pkg = JSON.parse(originalPackageJsonRaw);
  packageName = pkg.name;

  console.log(`\n🚀 Releasing ${packageName} (${library})`);

  if (fs.existsSync(distDir)) {
    console.log(`→ Cleaning dist directory: ${distDir}`);
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  console.log(`→ Setting version (${versionSpec})`);
  const versionCommand = `npm version ${versionSpec} --no-git-tag-version --allow-same-version`;
  run(versionCommand, { cwd: libDir });

  const updatedPackageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf8'),
  );
  version = updatedPackageJson.version;
  console.log(`✓ Version bumped to ${version}`);

  console.log('\n→ Building with Nx');
  const buildCommand = `npx nx run ${nxProject}:build --skip-nx-cache --with-deps`;
  // Run with the nx daemon OFF: the persistent daemon accumulates memory across the
  // sequential per-lib builds in `release:all` and was OOM-killing the bundler ("cannot
  // allocate memory"). Daemon-off recomputes the graph per invocation and frees it on exit.
  //
  // ...and with plugin ISOLATION off too. Daemon-off makes every nx invocation fork a
  // worker process per plugin, which then waits on a socket handshake ("load" message)
  // that nx hard-times-out at 10s. Mid-`release:all` — machine already loaded from the
  // preceding lib builds — that handshake intermittently misses the window and the run
  // dies with "Plugin worker ... exited unexpectedly" / "Failed to load 1 default Nx
  // plugin(s)". Loading plugins in-process removes the fork, the socket, and the timeout.
  //
  // NODE_ENV is forced to production. Left unset, the Nx Vite executor builds in development
  // mode, so plugin-react emits `jsxDEV(..., this)` with this machine's absolute source
  // paths. That shipped in 0.19.0: the `this` argument is illegal inside files with inline
  // server actions, so every scaffolded project failed `next build` with "Server Actions
  // cannot use `this`" (85 times, all from @nextblock-cms/ecom).
  run(buildCommand, {
    cwd: workspaceRoot,
    env: { ...process.env, NODE_ENV: 'production', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' },
  });

  if (!fs.existsSync(distDir)) {
    throw new Error(`Build output not found at ${distDir}`);
  }

  // Source-available premium libs copy raw package.json files during Vite builds;
  // normalize their manifests (entry points + resolved sibling deps) before publish.
  if (library === 'ecommerce' || library === 'ecom') {
    finalizeEcomDistPackageJson(path.join(distDir, 'package.json'));
  }
  if (library === 'cortex') {
    finalizeCortexDistPackageJson(path.join(distDir, 'package.json'));
  }

  // Never publish a build that would break `next build` in a scaffolded project: development
  // JSX, consumed subpaths that were not emitted, or exports lost to a stale `.js` twin.
  // Runs AFTER the manifests are finalized, so it judges the package.json that actually
  // ships. Run before, it rejected ecommerce 0.19.1: the raw manifest has no `exports` yet.
  console.log('\n→ Verifying the build is publishable');
  verifyLibDist(library);
  console.log('✓ Build verified');

  // -------------------------------------------------------------------------
  // PUBLISH TO NPM (PUBLIC)
  // Every package — including premium commerce — is published publicly to npmjs.
  // Premium features are source-available and gated at runtime via
  // verifyPackageOnline() + checkout license confirmation (the Cortex AI model);
  // there is no private GitHub Packages registry or ghost-stub twin.
  // -------------------------------------------------------------------------
  console.log('\n→ Publishing to npm (Public)');

  // Local .npmrc forces the public registry for this scope, overriding any global config.
  const distNpmrcPath = path.join(distDir, '.npmrc');
  const publicNpmrcContent = [
    'registry=https://registry.npmjs.org',
    '@nextblock-cms:registry=https://registry.npmjs.org',
    'always-auth=true',
  ].join('\n');

  fs.writeFileSync(distNpmrcPath, publicNpmrcContent);
  console.log('✓ Created local .npmrc in dist to force npmjs.org registry');

  const publishArgs = ['npm', 'publish', '--access', 'public'];
  if (dryRun) {
    publishArgs.push('--dry-run');
  }

  try {
    run(publishArgs.join(' '), { cwd: distDir });
    console.log(
      `\n✅ Published ${packageName}@${version}${dryRun ? ' (dry run)' : ''}\n`,
    );
  } finally {
    if (fs.existsSync(distNpmrcPath)) fs.unlinkSync(distNpmrcPath);
  }

  if (!hadLockfile && fs.existsSync(lockfilePath)) {
    fs.rmSync(lockfilePath);
  }
} catch (error) {
  console.error('\n❌ Release failed.');
  if (version === undefined) {
    // Version bump did not succeed, nothing to revert.
  } else {
    console.log('↺ Reverting package.json to previous version.');
    fs.writeFileSync(packageJsonPath, originalPackageJsonRaw, 'utf8');
  }
  if (!hadLockfile && fs.existsSync(lockfilePath)) {
    fs.rmSync(lockfilePath, { force: true });
  }
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}
