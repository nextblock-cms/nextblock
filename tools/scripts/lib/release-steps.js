// The real side effects of a release, shared by release-all.js (both phases), release-lib.js (one
// lib) and release-cli.js (the CLI alone): version stamps and their restore, the lib build and its
// publish checks, the CLI template sync, packing, and `npm publish <tarball>`.
//
// Every package is packed into a tarball once, the checks judge that tarball, and the publish
// uploads exactly that file. `npm publish <tarball>` runs no lifecycle script (only a folder
// publish does), so publishing the CLI no longer re-runs its `prepack` template sync: the sync ran
// right before the pack, and check-tarball.js read the tarball back to confirm it holds the whole
// template.

'use strict';

const { exec, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { publishExportsFor } = require('../lib-publish-exports');
const { verifyLibDist } = require('../verify-lib-dist');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const DIST_DIR = path.join(workspaceRoot, 'dist');
/** Where phase 1 leaves the tarballs and release-manifest.json for phase 2. */
const STAGING_DIR = path.join(DIST_DIR, 'release');
const MANIFEST_FILE = 'release-manifest.json';
const CLI_DIR = path.join(workspaceRoot, 'apps', 'create-nextblock');

/**
 * Every package is public on npmjs. The flags beat any npmrc that points the scope or the default
 * registry elsewhere; until the tarball flow, release-lib.js wrote a dist/.npmrc for the same pin.
 */
const {
  PUBLISH_REGISTRY: NPM_REGISTRY,
  PUBLISH_REGISTRY_FLAGS: REGISTRY_FLAGS,
  TEMPLATE_PACKAGE_JSON,
} = require('./release-pipeline');

/**
 * How `npm publish` runs: in a terminal of its own, never piped. The account uses auth-type web,
 * so npm prints an approval link and waits on the terminal; piping its output fails the prompt
 * (EOTP), and capturing it would hide the link.
 */
const PUBLISH_EXEC_OPTIONS = Object.freeze({ cwd: workspaceRoot, stdio: 'inherit', shell: true });

const toPosix = (value) => value.split(path.sep).join('/');
const relativeToRoot = (absolute) => toPosix(path.relative(workspaceRoot, absolute)) || '.';

/** The last lines of a failed command's output, for an error message. */
function outputTail(error) {
  return String(error?.stderr || error?.stdout || error?.message || error)
    .trim()
    .split(/\r?\n/)
    .slice(-3)
    .join(' ');
}

function run(command, options = {}) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: 'inherit', shell: true, cwd: workspaceRoot, ...options });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readVersion(relDir) {
  try {
    return readJson(path.join(workspaceRoot, relDir, 'package.json')).version ?? '(unknown)';
  } catch {
    return '(unknown)';
  }
}

/** The version in each stamped folder's package.json, keyed by folder (`.` is the root). */
function readCurrentVersions(dirs) {
  return Object.fromEntries(dirs.map((dir) => [dir, readVersion(dir)]));
}

/* ---------------------------------- stamps ---------------------------------- */

const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN']);

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs a file write again when Windows still holds the file (Defender, an editor): see fs-retry.js. */
function retryWrite(action, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_FS_CODES.has(error?.code)) throw error;
      pause(200 * attempt);
    }
  }
}

/**
 * Remembers the bytes of `relPaths` (or that a file is absent) so `restore()` can put them back
 * exactly: a stamped package.json, a lockfile `npm version` rewrote or created. `restore()`
 * returns the files it changed.
 *
 * A package.json listed in `versionOnly` gets back only its `version` while it still exists: the
 * rest of the file is kept as it is now. That is for the template's package.json, which the
 * template sync regenerates whole (dependencies from the root and the app, the docker scripts, the
 * standalone marker), so restoring its old bytes would undo a sync of everything but the version.
 */
function snapshotFiles(relPaths, { root = workspaceRoot, versionOnly = [] } = {}) {
  const versionOnlyFiles = new Set(versionOnly);
  const entries = relPaths.map((rel) => {
    const absolute = path.join(root, rel);
    return { rel, absolute, original: fs.existsSync(absolute) ? fs.readFileSync(absolute) : null, onlyVersion: versionOnlyFiles.has(rel) };
  });
  return {
    files: entries.map((entry) => entry.rel),
    restore() {
      const restored = [];
      for (const { rel, absolute, original, onlyVersion } of entries) {
        const current = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
        if (original === null) {
          if (current === null) continue;
          retryWrite(() => fs.rmSync(absolute, { force: true }));
        } else {
          if (current !== null && current.equals(original)) continue;
          const next = onlyVersion && current !== null ? withVersionOf(current, original) : original;
          if (next === null) continue;
          retryWrite(() => {
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, next);
          });
        }
        restored.push(rel);
      }
      return restored;
    },
  };
}

/**
 * `current` (a package.json) with the `version` of `original`, in `current`'s own indentation and
 * line endings; null when the versions already agree. Either file failing to parse, or lacking a
 * string version, gives `original` back whole.
 */
function withVersionOf(current, original) {
  const text = current.toString('utf8');
  let currentPkg;
  let originalPkg;
  try {
    currentPkg = JSON.parse(text);
    originalPkg = JSON.parse(original.toString('utf8'));
  } catch {
    return original;
  }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(currentPkg) || !isObject(originalPkg) || typeof currentPkg.version !== 'string' || typeof originalPkg.version !== 'string') {
    return original;
  }
  if (currentPkg.version === originalPkg.version) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const body = JSON.stringify({ ...currentPkg, version: originalPkg.version }, null, indent).replace(/\n/g, eol);
  return Buffer.from(/\r?\n$/.test(text) ? `${body}${eol}` : body, 'utf8');
}

/**
 * snapshotFiles for version stamps: the template's package.json gets back only its version (the
 * template sync rewrote the rest of it from apps/nextblock, as `npm run sync:create-nextblock`
 * leaves it).
 */
function snapshotStamps(relPaths, { root = workspaceRoot } = {}) {
  return snapshotFiles(relPaths, { root, versionOnly: [TEMPLATE_PACKAGE_JSON] });
}

/**
 * `npm version <spec>` in one folder (package.json, and its package-lock.json when it has one).
 * A lockfile npm creates where there was none is removed, as release-lib.js always did.
 */
function stampVersion(relDir, versionSpec) {
  const dir = path.join(workspaceRoot, relDir);
  const lockfile = path.join(dir, 'package-lock.json');
  const hadLockfile = fs.existsSync(lockfile);
  const before = readVersion(relDir);
  execSync(`npm version ${versionSpec} --no-git-tag-version --allow-same-version`, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true,
  });
  if (!hadLockfile && fs.existsSync(lockfile)) fs.rmSync(lockfile, { force: true });
  const after = readVersion(relDir);
  console.log(`  ${(relDir === '.' ? '(root)' : relDir).padEnd(24)} ${before} → ${after}`);
  return after;
}

/* --------------------------------- staging --------------------------------- */

/** Empties a staging folder under dist/ (and refuses any other place). */
function prepareStaging(stagingDir = STAGING_DIR) {
  const relative = path.relative(DIST_DIR, stagingDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to empty ${stagingDir}: release staging lives under ${DIST_DIR}.`);
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
}

function writeManifest(manifest, stagingDir = STAGING_DIR) {
  fs.writeFileSync(path.join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

/** The manifest phase 1 wrote, or null when there is none. */
function readManifest(stagingDir = STAGING_DIR) {
  const file = path.join(stagingDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    throw new Error(`${relativeToRoot(file)} is not valid JSON: run the build phase again.`);
  }
}

/** The integrity npm reports for a tarball (`npm pack --json`, the registry's dist.integrity). */
function integrityOf(file) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

/** The command packDirectory runs in a package folder. */
function packCommand(destination) {
  return `npm pack --ignore-scripts --json --dry-run=false --pack-destination "${destination}"`;
}

/**
 * `npm pack --json` in a package folder, writing the tarball into `destination`. `--ignore-scripts`:
 * a lib's copied source manifest must not run lifecycle scripts from dist/, and the CLI's prepack
 * would run the template sync again right after it ran. `--dry-run=false`: a child npm reads
 * npm_config_dry_run from the environment (`npm run build:<lib> --dry-run` exports it), and an
 * `npm pack` under it reports a tarball it never writes. Returns npm's own report of the tarball.
 * `exec` is for tests.
 */
function packDirectory(packageDir, destination, { exec: execFn = execSync } = {}) {
  fs.mkdirSync(destination, { recursive: true });
  let output;
  try {
    output = execFn(packCommand(destination), {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    });
  } catch (error) {
    throw new Error(`npm pack failed in ${relativeToRoot(packageDir)}: ${outputTail(error)}`);
  }

  let report;
  try {
    [report] = JSON.parse(output);
  } catch {
    throw new Error(`npm pack --json printed no JSON in ${relativeToRoot(packageDir)}: ${String(output).slice(0, 200)}`);
  }
  if (!report || typeof report.filename !== 'string' || typeof report.integrity !== 'string' || !Array.isArray(report.files)) {
    throw new Error(`npm pack --json gave no tarball report in ${relativeToRoot(packageDir)}.`);
  }
  const tarballPath = path.join(destination, report.filename);
  if (!fs.existsSync(tarballPath)) throw new Error(`npm pack reported ${report.filename}, but ${relativeToRoot(tarballPath)} is missing.`);
  return {
    name: report.name,
    version: report.version,
    filename: report.filename,
    integrity: report.integrity,
    size: report.size,
    entryCount: report.entryCount ?? report.files.length,
    files: report.files.map((file) => String(file.path).replace(/\\/g, '/').replace(/^\.\//, '')),
    tarballPath,
  };
}

/* ---------------------------------- libs ---------------------------------- */

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
  try {
    const siblingPkg = readJson(path.join(workspaceRoot, 'libs', dir, 'package.json'));
    if (siblingPkg.version) return `^${siblingPkg.version}`;
  } catch {
    // fall through to a floating spec
  }
  return 'latest';
}

// Every section npm installs from: a `workspace:` spec left in any of them fails the
// consumer's install with EUNSUPPORTEDPROTOCOL (verify-lib-dist.js check 9 refuses it).
const INSTALLED_DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function resolveWorkspaceDeps(pkg) {
  for (const section of INSTALLED_DEPENDENCY_SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const depName of Object.keys(deps)) {
      const spec = deps[depName];
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        if (depName === '@nextblock-cms/ecommerce') {
          deps[depName] = `npm:@nextblock-cms/ecom@${resolveSiblingVersion('@nextblock-cms/ecom')}`;
          continue;
        }
        deps[depName] = resolveSiblingVersion(depName);
      }
    }
  }
}

// The source-available premium libs (ecommerce, cortex, affiliates) are published publicly to
// npmjs and gated at runtime via verifyPackageOnline('<package id>'). Their Vite builds copy
// the raw source package.json, which may lack entry points and still has workspace:* deps
// and the `nx` field, so normalize it for publish. `publishExportsFor(library)` (shared with
// the publish check) decides which libs get this step and the exports map they ship.
function finalizeDistPackageJson(distPkgPath, library, exportsMap) {
  const pkg = readJson(distPkgPath);

  pkg.main = './index.cjs';
  pkg.module = './index.es.js';
  pkg.types = './index.d.ts';
  pkg.exports = exportsMap;

  resolveWorkspaceDeps(pkg);

  pkg.publishConfig = { access: 'public' };
  delete pkg.nx; // workspace-internal metadata, not for the published package

  fs.writeFileSync(distPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ Normalized ${library} dist package.json (entry points + resolved sibling deps + public access)`);
}

/**
 * Builds one lib (its package.json already carries the release version), finalizes its manifest,
 * packs it into `stagingDir`, and runs the verify-lib-dist checks on the packed file list, so the
 * checks judge the tarball that will be published. A lib that fails a check leaves no tarball.
 */
function buildLibArtifact(library, { stagingDir = STAGING_DIR } = {}) {
  const distDir = path.join(DIST_DIR, 'libs', library);

  // fs.rmSync unlinks a link at this path and keeps its target (libs/db/CLAUDE.md: never link dist/).
  if (fs.existsSync(distDir)) {
    console.log(`→ Cleaning ${relativeToRoot(distDir)}`);
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  // The build target is plain `vite build` (inferred by @nx/vite/plugin) after the lib's `typecheck`.
  // It never built sibling libs: each lib externalizes them and reads their types from source.
  //
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
  // NODE_ENV is forced to production. Left unset, the build can run in development mode:
  // @nx/vite/plugin resolves every Vite config in development mode while Nx computes the
  // project graph, and Vite then sets NODE_ENV=development in that process. With plugin
  // isolation off (above) that process is this nx run, and the `vite build` task inherits it,
  // so plugin-react emits `jsxDEV(..., this)` with this machine's absolute source
  // paths. That shipped in 0.19.0: the `this` argument is illegal inside files with inline
  // server actions, so every scaffolded project failed `next build` with "Server Actions
  // cannot use `this`" (85 times, all from @nextblock-cms/ecom).
  run(`npx nx run ${library}:build --skip-nx-cache`, {
    env: { ...process.env, NODE_ENV: 'production', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' },
  });

  if (!fs.existsSync(distDir)) throw new Error(`Build output not found at ${distDir}`);

  // Source-available premium libs copy raw package.json files during Vite builds;
  // normalize their manifests (entry points + resolved sibling deps) before packing.
  const publishExports = publishExportsFor(library);
  if (publishExports) finalizeDistPackageJson(path.join(distDir, 'package.json'), library, publishExports);

  console.log(`→ Packing ${relativeToRoot(distDir)}`);
  const packed = packDirectory(distDir, stagingDir);

  // Never publish a build that would break `next build` in a scaffolded project: development
  // JSX, consumed subpaths that were not emitted, or exports lost to a stale `.js` twin.
  // Runs AFTER the manifests are finalized, so it judges the package.json that actually
  // ships (`manifestFinalized`: a `workspace:` spec left in it now is a real problem), and on
  // the file list of the packed tarball. Run before the finalize step, it rejected ecommerce
  // 0.19.1: the raw manifest has no `exports` yet.
  console.log('→ Verifying the packed build is publishable');
  try {
    verifyLibDist(library, { manifestFinalized: true, listPackedFiles: () => packed.files });
  } catch (error) {
    fs.rmSync(packed.tarballPath, { force: true });
    throw error;
  }
  console.log('✓ Build verified');
  return packed;
}

/* ----------------------------------- CLI ----------------------------------- */

/**
 * Regenerates the CLI template, packs create-nextblock into `stagingDir`, and reads the tarball
 * back to check it against the template (apps/create-nextblock/scripts/check-tarball.js). The root,
 * app and CLI package.json files must already carry the release version: the sync copies the
 * app's into the template.
 */
function buildCliArtifact({ stagingDir = STAGING_DIR } = {}) {
  // Copies apps/nextblock into templates/nextblock-template and ends with the template check and
  // an `npm pack --dry-run` check of the package folder (scripts/lib/pack-check.js).
  run('npm run sync:create-nextblock');

  console.log(`→ Packing ${relativeToRoot(CLI_DIR)}`);
  const packed = packDirectory(CLI_DIR, stagingDir);

  // The publish runs no prepack, so this tarball is all that ships: npm reads it back, and every
  // template file on disk must be in it, with no local env file and the `bin` script present.
  try {
    run(`node apps/create-nextblock/scripts/check-tarball.js "${relativeToRoot(packed.tarballPath)}"`);
  } catch (error) {
    fs.rmSync(packed.tarballPath, { force: true });
    throw error;
  }
  return packed;
}

/* --------------------------------- publish --------------------------------- */

/** Refuses a tarball that is missing or no longer the one phase 1 packed. */
function checkTarball(entry, { stagingDir = STAGING_DIR } = {}) {
  if (typeof entry.tarball !== 'string' || path.basename(entry.tarball) !== entry.tarball) {
    throw new Error(`${entry.name}: the manifest names no tarball inside ${relativeToRoot(stagingDir)}.`);
  }
  const file = path.join(stagingDir, entry.tarball);
  if (!fs.existsSync(file)) {
    throw new Error(`${relativeToRoot(file)} is missing: run the build phase again.`);
  }
  const actual = integrityOf(file);
  if (actual !== entry.integrity) {
    throw new Error(`${relativeToRoot(file)} changed after it was packed (integrity ${actual}, packed ${entry.integrity}): run the build phase again.`);
  }
}

/** The command that publishes one packed tarball (a path relative to the workspace root). */
function publishCommand(tarballPath, { dryRun = false } = {}) {
  const relative = path.relative(workspaceRoot, tarballPath);
  const spec = relative.startsWith('..') || path.isAbsolute(relative) ? tarballPath : `./${toPosix(relative)}`;
  return ['npm', 'publish', `"${spec}"`, '--access', 'public', '--ignore-scripts', ...REGISTRY_FLAGS, ...(dryRun ? ['--dry-run'] : [])].join(' ');
}

/** Publishes one tarball. Throws when npm fails. `exec` is for tests. */
function publishTarball(tarballPath, { dryRun = false, exec: execFn = execSync } = {}) {
  const command = publishCommand(tarballPath, { dryRun });
  console.log(`\n$ ${command}`);
  execFn(command, { ...PUBLISH_EXEC_OPTIONS });
}

const execAsync = promisify(exec);

/**
 * True when `<name>@<version>` is on npm, false when npm answers E404 (no such package or
 * version), and an error for anything else (the registry is unreachable): a release must not
 * guess. `npm view <name> version` would only give `latest`, so the exact version is asked for.
 */
async function isPublished(name, version, { exec: execFn = execAsync } = {}) {
  const spec = `${name}@${version}`;
  try {
    const { stdout } = await execFn(`npm view ${spec} version ${REGISTRY_FLAGS.join(' ')}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(version);
  } catch (error) {
    if (/\bE404\b/.test(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`)) return false;
    throw new Error(`Could not ask npm whether ${spec} is published: ${outputTail(error)}`);
  }
}

/**
 * The integrity npm serves for `<name>@<version>` (`dist.integrity`: the sha512 `npm pack` reports
 * for a tarball), or null when npm has no such version (E404). Throws when npm cannot be asked.
 * Unlike isPublished, it tells this run's upload apart from a tarball npm had before.
 */
async function publishedIntegrity(name, version, { exec: execFn = execAsync } = {}) {
  const spec = `${name}@${version}`;
  try {
    const { stdout } = await execFn(`npm view ${spec} dist.integrity ${REGISTRY_FLAGS.join(' ')}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return /\bsha512-[A-Za-z0-9+/]+={0,2}/.exec(String(stdout))?.[0] ?? null;
  } catch (error) {
    if (/\bE404\b/.test(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`)) return null;
    throw new Error(`Could not ask npm which tarball it serves as ${spec}: ${outputTail(error)}`);
  }
}

/** The logged-in npm user; throws when there is none (npm answers E401). */
function npmWhoami() {
  return execSync(`npm whoami ${REGISTRY_FLAGS[0]}`, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  }).trim();
}

module.exports = {
  CLI_DIR,
  MANIFEST_FILE,
  NPM_REGISTRY,
  PUBLISH_EXEC_OPTIONS,
  REGISTRY_FLAGS,
  STAGING_DIR,
  buildCliArtifact,
  buildLibArtifact,
  checkTarball,
  finalizeDistPackageJson,
  integrityOf,
  isPublished,
  npmWhoami,
  packCommand,
  packDirectory,
  prepareStaging,
  publishCommand,
  publishTarball,
  publishedIntegrity,
  readCurrentVersions,
  readManifest,
  readVersion,
  resolveSiblingVersion,
  snapshotFiles,
  snapshotStamps,
  stampVersion,
  workspaceRoot,
  writeManifest,
};
