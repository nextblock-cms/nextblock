#!/usr/bin/env node

// Rehearses a NextBlock release end to end, publishing nothing, and builds the scaffold a user
// would get from it:
//
//   node tools/scripts/rehearse-release.js [--workdir <dir>] [--version <x.y.z>]
//                                          [--skip-pack] [--skip-scaffold] [--no-boot] [--write-budget]
//
// 1. Libraries: `release-lib.js <lib> <version> --dry-run` for all eight in publish order (the real
//    Nx build, the verify-lib-dist checks and `npm publish --dry-run`, with no npm credentials), then
//    `npm pack` of each dist folder. The version stamps release-lib writes are restored afterwards,
//    byte for byte.
// 2. CLI: `npm pack --ignore-scripts` in apps/create-nextblock (the template as it is on disk: run
//    `npm run sync:create-nextblock` first, as a release does and the CI workflow does), extracted
//    into the work folder's emptied cli/ (a re-run never reuses an old extraction), its own
//    @nextblock-cms/db pointed at the packed tarball (it copies supabase/ from there), and run from
//    the extraction: `--non-interactive --mode cloud --skip-install --no-trial`, which sends nothing
//    to the license service.
// 3. Scaffold: every @nextblock-cms/* dependency and override pointed at the tarballs, `npm install`
//    from the public registry (install scripts off), and a check that the lockfile resolved every
//    @nextblock-cms/* package to a tarball.
// 4. Checks, with nothing removed from the scaffold (test files included): `next build`, a scan of
//    the build for bundled test tooling, `DOCKER_BUILD=true next build` with a boot of the
//    standalone server.js, and `tsc --noEmit` (test files left out: no scaffold installs vitest)
//    against the pinned budget in release-rehearsal-tsc-budget.json.
//
// Why: the monorepo never builds a scaffold the way users get one, so packaging breaks reached users
// first. Every scaffold from 0.23.0 to 0.23.3 failed `next build` with "Can't resolve 'vitest'", and
// through 0.23.5 every one carried 457 type errors from a declaration that imported a package
// nothing installed. Nothing here touches a database: the scaffold builds with no Supabase settings,
// as a fresh `npm create nextblock` does, and `next build` runs directly, never `npm run build`
// (its prebuild hook migrates). The work folder must lie outside the repository: Node resolves
// packages up the tree, so a scaffold inside it would find the monorepo's node_modules and hide
// exactly the missing-package failures this exists to catch.

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  REHEARSED_LIBS,
  compareWithBudget,
  findBundledTestTooling,
  findPackagesNotFromTarballs,
  isInside,
  parseTscOutput,
  prepareCliFolders,
  rewireToTarballs,
} = require('./lib/release-rehearsal');

const repoRoot = path.resolve(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const BUDGET_FILE = path.join(__dirname, 'release-rehearsal-tsc-budget.json');
const CLI_DIR = path.join(repoRoot, 'apps', 'create-nextblock');
const SCAFFOLD_NAME = 'scaffold';
/** What the type-check leaves out of the scaffold (see the tsc step). */
const TEST_FILE_GLOBS = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'];
const USAGE =
  'Usage: node tools/scripts/rehearse-release.js [--workdir <dir>] [--version <x.y.z>] [--skip-pack] [--skip-scaffold] [--no-boot] [--write-budget]';

/** The variables a scaffold step inherits: the OS's own, none of the developer's app settings. */
const KEEP_ENV =
  /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|COMSPEC|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|USER|USERNAME|LOGNAME|SHELL|LANG|LC_ALL|TERM|CI|GITHUB_ACTIONS|RUNNER_TEMP|XDG_CACHE_HOME|XDG_CONFIG_HOME|NPM_CONFIG_CACHE|HTTPS?_PROXY|NO_PROXY)$/i;

function parseArgs(argv) {
  const options = { workdir: null, version: null, skipPack: false, skipScaffold: false, boot: true, writeBudget: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      i += 1;
      return next;
    };
    if (arg === '--workdir') options.workdir = path.resolve(value());
    else if (arg === '--version') options.version = value();
    else if (arg === '--skip-pack') options.skipPack = true;
    else if (arg === '--skip-scaffold') options.skipScaffold = true;
    else if (arg === '--no-boot') options.boot = false;
    else if (arg === '--write-budget') options.writeBudget = true;
    else throw new Error(`Unknown argument ${arg}\n${USAGE}`);
  }
  if (options.version !== null && !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`--version takes a plain x.y.z version (release-lib refuses pre-releases), not ${options.version}`);
  }
  if (options.skipScaffold) options.skipPack = true;
  return options;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const seconds = (since) => Math.round((Date.now() - since) / 1000);

/** A cmd.exe argument: quoted when it holds a space or a character cmd would act on. */
const quoteForCmd = (arg) => (/[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

/**
 * Runs a command, streaming its output to this process and to `logFile`, and resolves with its exit
 * status, its stdout alone (where npm --json and the CLI write their JSON) and both streams in
 * order. npm and npx go through cmd.exe on Windows (they are .cmd shims); everything else, Node
 * scripts included, is spawned directly.
 */
function run(command, args, { cwd, env = process.env, logFile, quiet = false } = {}) {
  return new Promise((resolve) => {
    const viaShell = IS_WINDOWS && (command === 'npm' || command === 'npx');
    const child = viaShell
      ? spawn([command, ...args].map(quoteForCmd).join(' '), { cwd, env, shell: true, windowsHide: true })
      : spawn(command, args, { cwd, env, windowsHide: true });
    const all = [];
    const stdout = [];
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    log?.write(`\n$ ${[command, ...args].join(' ')}\n  (in ${cwd ?? process.cwd()})\n`);
    const onData = (stream, own) => (chunk) => {
      all.push(chunk);
      own?.push(chunk);
      log?.write(chunk);
      if (!quiet) stream.write(chunk);
    };
    child.stdout.on('data', onData(process.stdout, stdout));
    child.stderr.on('data', onData(process.stderr, null));
    let settled = false;
    const finish = (status, extra = '') => {
      if (settled) return;
      settled = true;
      log?.end(extra ? `\n${extra}\n` : undefined);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        output: `${Buffer.concat(all).toString('utf8')}${extra ? `\n${extra}` : ''}`,
      });
    };
    child.on('error', (error) => finish(-1, error.message));
    child.on('close', (status, signal) => finish(status ?? (signal ? 128 : -1)));
  });
}

/** The JSON document npm prints on stdout for `--json`, after any notices. */
function parseNpmJson(output) {
  const start = output.search(/^\s*[[{]/m);
  if (start === -1) throw new Error(`npm printed no JSON:\n${output.slice(-500)}`);
  return JSON.parse(output.slice(start));
}

function scaffoldEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (KEEP_ENV.test(key)) env[key] = value;
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', ...extra };
}

/* ------------------------------------ steps ------------------------------------ */

class StepFailure extends Error {}

const report = { startedAt: new Date().toISOString(), steps: [], ok: false };

async function step(name, action, { fatal = true } = {}) {
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  const entry = { name, ok: false, seconds: 0 };
  report.steps.push(entry);
  try {
    const details = await action();
    entry.ok = true;
    if (details) entry.details = details;
    console.log(`✓ ${name} (${seconds(started)} s)`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${name}: ${entry.error}`);
    if (fatal) throw new StepFailure(entry.error);
  } finally {
    entry.seconds = seconds(started);
  }
  return entry;
}

/** Saves the files release-lib stamps (every lib's package.json and lockfile) to restore them later. */
function snapshotStamps(backupDir) {
  const files = REHEARSED_LIBS.flatMap((lib) => [`libs/${lib}/package.json`, `libs/${lib}/package-lock.json`]);
  const saved = files.map((rel) => {
    const absolute = path.join(repoRoot, ...rel.split('/'));
    if (!fs.existsSync(absolute)) return { rel, absolute, bytes: null };
    const bytes = fs.readFileSync(absolute);
    const copy = path.join(backupDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, bytes);
    return { rel, absolute, bytes };
  });
  return {
    restore() {
      const changed = [];
      for (const { rel, absolute, bytes } of saved) {
        if (bytes === null) {
          if (fs.existsSync(absolute)) {
            fs.rmSync(absolute, { force: true });
            changed.push(`${rel} (removed)`);
          }
          continue;
        }
        if (fs.existsSync(absolute) && sha256(fs.readFileSync(absolute)) === sha256(bytes)) continue;
        fs.writeFileSync(absolute, bytes);
        changed.push(rel);
      }
      const drift = saved.filter(({ absolute, bytes }) =>
        bytes === null ? fs.existsSync(absolute) : !fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== sha256(bytes)
      );
      if (drift.length > 0) throw new Error(`could not restore ${drift.map(({ rel }) => rel).join(', ')} (copies in ${backupDir})`);
      return changed;
    },
  };
}

async function packLibs({ workdir, version, logs }) {
  const tarballsDir = path.join(workdir, 'tarballs');
  fs.mkdirSync(tarballsDir, { recursive: true });
  // No credentials at all: `npm publish --dry-run` only warns that it needs a login, and nothing
  // this rehearsal runs could publish even if a flag went missing.
  const emptyUserconfig = path.join(workdir, 'empty.npmrc');
  fs.writeFileSync(emptyUserconfig, '');
  const env = {
    ...process.env,
    npm_config_userconfig: emptyUserconfig,
    // `npm publish` otherwise asks the registry about the version first, and refuses one npm
    // already serves (the checkout's own version, between releases).
    npm_config_force: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // Nx loads the root .env* files into every task by default: never a local or production config.
    NX_LOAD_DOT_ENV_FILES: 'false',
    NX_NO_CLOUD: 'true',
    NX_TUI: 'false',
    NX_DAEMON: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete env.npm_config_dry_run;
  const stamps = snapshotStamps(path.join(workdir, 'stamp-backup'));
  const tarballs = {};
  try {
    for (const lib of REHEARSED_LIBS) {
      await step(`release-lib.js ${lib} ${version} --dry-run`, async () => {
        const result = await run(process.execPath, [path.join(__dirname, 'release-lib.js'), lib, version, '--dry-run'], {
          cwd: repoRoot,
          env,
          logFile: path.join(logs, `release-lib-${lib}.log`),
        });
        if (result.status !== 0) throw new Error(`exited ${result.status} (logs/release-lib-${lib}.log)`);
      });
      await step(`npm pack dist/libs/${lib}`, async () => {
        const distDir = path.join(repoRoot, 'dist', 'libs', lib);
        if (fs.existsSync(path.join(distDir, '.npmrc'))) throw new Error(`dist/libs/${lib}/.npmrc is left from a publish step`);
        const result = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballsDir], {
          cwd: distDir,
          env,
          logFile: path.join(logs, `pack-${lib}.log`),
          quiet: true,
        });
        if (result.status !== 0) throw new Error(`npm pack exited ${result.status}`);
        const [packed] = parseNpmJson(result.stdout);
        if (packed.version !== version) throw new Error(`packed ${packed.name}@${packed.version}, expected ${version}`);
        tarballs[lib] = { name: packed.name, file: path.join(tarballsDir, packed.filename), size: packed.size, entryCount: packed.entryCount, integrity: packed.integrity };
        return `${packed.filename}: ${packed.entryCount} files, ${Math.round(packed.size / 1024)} KB`;
      });
    }
  } finally {
    await step('restore the version stamps', () => {
      const restored = stamps.restore();
      return restored.length > 0 ? `restored ${restored.join(', ')}` : 'nothing to restore';
    }, { fatal: false });
  }
  fs.writeFileSync(path.join(tarballsDir, 'tarballs.json'), `${JSON.stringify(tarballs, null, 2)}\n`);
  return tarballs;
}

function readPackedTarballs(workdir) {
  const file = path.join(workdir, 'tarballs', 'tarballs.json');
  if (!fs.existsSync(file)) throw new Error(`--skip-pack needs ${file} from an earlier run`);
  const tarballs = readJson(file);
  for (const lib of REHEARSED_LIBS) {
    if (!tarballs[lib] || !fs.existsSync(tarballs[lib].file)) throw new Error(`no packed tarball for ${lib} in ${path.dirname(file)}`);
  }
  return tarballs;
}

async function scaffoldFromCli({ workdir, tarballs, logs }) {
  // Emptied first: extracting over a --skip-pack re-run's old extraction would carry files deleted
  // from the template since into the scaffold (prepareCliFolders says why).
  const { cliDir, extractDir } = prepareCliFolders(workdir);
  let cliTarball;

  await step('npm pack --ignore-scripts apps/create-nextblock', async () => {
    const result = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', cliDir], {
      cwd: CLI_DIR,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      logFile: path.join(logs, 'pack-cli.log'),
      quiet: true,
    });
    if (result.status !== 0) throw new Error(`npm pack exited ${result.status}`);
    const [packed] = parseNpmJson(result.stdout);
    cliTarball = path.join(cliDir, packed.filename);
    return `${packed.filename}: ${packed.entryCount} files, ${Math.round(packed.size / 1024)} KB`;
  });

  const cliPackage = path.join(extractDir, 'package');
  await step('extract the CLI and install its dependencies (db from its tarball)', async () => {
    // A relative archive path keeps a drive letter away from GNU tar, which reads "C:" as a host.
    const extracted = await run('tar', ['-xzf', path.relative(extractDir, cliTarball)], { cwd: extractDir, logFile: path.join(logs, 'cli-install.log') });
    if (extracted.status !== 0) throw new Error(`tar exited ${extracted.status}`);
    const manifestPath = path.join(cliPackage, 'package.json');
    const { pkg } = rewireToTarballs(readJson(manifestPath), tarballs, cliPackage);
    delete pkg.devDependencies;
    fs.writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const installed = await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: cliPackage,
      env: scaffoldEnv(),
      logFile: path.join(logs, 'cli-install.log'),
    });
    if (installed.status !== 0) throw new Error(`npm install exited ${installed.status}`);
    const stray = findPackagesNotFromTarballs(readJson(path.join(cliPackage, 'package-lock.json')), Object.values(tarballs).map(({ file }) => file));
    if (stray.length > 0) throw new Error(stray.join('; '));
  });

  const scaffoldDir = path.join(workdir, SCAFFOLD_NAME);
  await step('run the extracted CLI (headless, cloud mode, no install, no trial)', async () => {
    const result = await run(
      process.execPath,
      [path.join(cliPackage, 'bin', 'create-nextblock.js'), SCAFFOLD_NAME, '--non-interactive', '--mode', 'cloud', '--skip-install', '--no-trial'],
      { cwd: workdir, env: scaffoldEnv({ NEXTBLOCK_TRIAL: 'false', FORCE_COLOR: '0' }), logFile: path.join(logs, 'cli-run.log') }
    );
    if (result.status !== 0) throw new Error(`the CLI exited ${result.status}`);
    const json = result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1);
    const outcome = JSON.parse(json);
    if (outcome.ok !== true) throw new Error(`the CLI reported ${JSON.stringify(outcome).slice(0, 300)}`);
    if (!fs.existsSync(path.join(scaffoldDir, 'supabase', 'migrations'))) throw new Error('the scaffold has no supabase/migrations');
  });

  await step('point the scaffold at the tarballs and npm install', async () => {
    const manifestPath = path.join(scaffoldDir, 'package.json');
    const { pkg, changed } = rewireToTarballs(readJson(manifestPath), tarballs, scaffoldDir);
    fs.writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.appendFileSync(path.join(logs, 'scaffold-install.log'), `${changed.join('\n')}\n`);
    const installed = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: scaffoldDir,
      env: scaffoldEnv(),
      logFile: path.join(logs, 'scaffold-install.log'),
    });
    if (installed.status !== 0) throw new Error(`npm install exited ${installed.status}`);
    const stray = findPackagesNotFromTarballs(readJson(path.join(scaffoldDir, 'package-lock.json')), Object.values(tarballs).map(({ file }) => file));
    if (stray.length > 0) throw new Error(stray.join('; '));
    return `${changed.length} dependencies pointed at tarballs`;
  });

  return scaffoldDir;
}

/** Every file under `dir` (relative, '/'-separated) that `accept` keeps, skipping folders `skip` names. */
function listFiles(dir, accept, skip = new Set()) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(path.relative(dir, full).split(path.sep).join('/'))) walk(full);
      } else if (accept(entry.name)) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function nextBuild(scaffoldDir, logs, logName, extraEnv = {}) {
  return run(process.execPath, [path.join(scaffoldDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: scaffoldDir,
    env: scaffoldEnv({ NODE_ENV: 'production', ...extraEnv }),
    logFile: path.join(logs, logName),
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 15_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

/** Starts the standalone server the Dockerfile runs, as it lays the folder out, and asks it two pages. */
async function bootStandalone(scaffoldDir, logs) {
  const standalone = path.join(scaffoldDir, '.next', 'standalone');
  fs.cpSync(path.join(scaffoldDir, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true });
  if (fs.existsSync(path.join(scaffoldDir, 'public'))) fs.cpSync(path.join(scaffoldDir, 'public'), path.join(standalone, 'public'), { recursive: true });
  const port = await freePort();
  const logFile = path.join(logs, 'standalone-server.log');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: standalone,
    env: scaffoldEnv({ NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' }),
    windowsHide: true,
  });
  const log = fs.createWriteStream(logFile);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    let status = null;
    while (Date.now() < deadline && exited === null) {
      try {
        status = await httpGet(`${base}/api/setup/status`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (exited !== null) throw new Error(`server.js exited ${exited} (logs/standalone-server.log)`);
    if (!status) throw new Error('server.js did not answer within 90 s (logs/standalone-server.log)');
    // The readiness route answers 503 until a first admin exists (always so here: no database),
    // with the same JSON body; anything else means the route itself broke.
    let body = null;
    try {
      body = JSON.parse(status.body);
    } catch {
      // judged below
    }
    if (![200, 503].includes(status.status) || typeof body?.initialized !== 'boolean') {
      throw new Error(`/api/setup/status answered ${status.status} ${status.body.slice(0, 200)}`);
    }
    const home = await httpGet(`${base}/`);
    if (home.status >= 500) throw new Error(`/ answered ${home.status}`);
    return `/api/setup/status ${status.status} (initialized: ${body.initialized}), / ${home.status}${home.headers.location ? ` -> ${home.headers.location}` : ''}`;
  } finally {
    child.kill();
  }
}

async function checkScaffold({ scaffoldDir, logs, options }) {
  const failures = [];
  const check = async (name, action) => {
    const entry = await step(name, action, { fatal: false });
    if (!entry.ok) failures.push(name);
  };

  await check('the scaffold keeps its test files (nothing removed)', () => {
    const tests = listFiles(scaffoldDir, (name) => /\.test\.[cm]?[jt]sx?$/.test(name), new Set(['node_modules', '.next']));
    if (!tests.includes('app/cms/blocks/editors/SectionBlockEditor.test.tsx')) {
      throw new Error('app/cms/blocks/editors/SectionBlockEditor.test.tsx is missing: the rehearsal must build the scaffold as shipped');
    }
    return `${tests.length} test files`;
  });

  await check('next build', async () => {
    const result = await nextBuild(scaffoldDir, logs, 'next-build.log');
    if (result.status !== 0) throw new Error(`next build exited ${result.status} (logs/next-build.log)`);
    const files = listFiles(path.join(scaffoldDir, '.next'), (name) => /\.(c|m)?js$|\.map$/.test(name), new Set(['cache', 'standalone'])).map((rel) => ({
      path: rel,
      text: fs.readFileSync(path.join(scaffoldDir, '.next', ...rel.split('/')), 'utf8'),
    }));
    const hits = findBundledTestTooling(files);
    if (hits.length > 0) throw new Error(`the build bundles test tooling: ${hits.slice(0, 5).join('; ')}`);
    return `${files.length} build files scanned, no test tooling`;
  });

  await check('DOCKER_BUILD=true next build (standalone server.js)', async () => {
    const result = await nextBuild(scaffoldDir, logs, 'next-build-docker.log', { DOCKER_BUILD: 'true' });
    if (result.status !== 0) throw new Error(`next build exited ${result.status} (logs/next-build-docker.log)`);
    const standalone = path.join(scaffoldDir, '.next', 'standalone');
    if (!fs.existsSync(path.join(standalone, 'server.js'))) throw new Error('.next/standalone/server.js was not written');
    const traced = listFiles(path.join(standalone, 'node_modules'), () => true).filter((rel) => /(^|\/)(@vitest|vitest|chai)\//.test(rel));
    if (traced.length > 0) throw new Error(`the standalone output carries test tooling: ${traced.slice(0, 3).join(', ')}`);
    return 'server.js written, no test tooling traced';
  });

  if (options.boot && !failures.includes('DOCKER_BUILD=true next build (standalone server.js)')) {
    await check('boot the standalone server', () => bootStandalone(scaffoldDir, logs));
  }

  await check('tsc --noEmit against the pinned budget', async () => {
    // The scaffold's own tsconfig, minus test files: they import vitest, which a scaffold does not
    // install, so each new app test would add errors here (181 in 0.23.6) and push CI over budget
    // for no fault of its own. User projects keep their tsconfig as the CLI wrote it.
    const tsconfig = readJson(path.join(scaffoldDir, 'tsconfig.json'));
    const rehearsalConfig = path.join(scaffoldDir, 'tsconfig.rehearsal.json');
    fs.writeFileSync(
      rehearsalConfig,
      `${JSON.stringify({ extends: './tsconfig.json', exclude: [...new Set([...(tsconfig.exclude ?? []), ...TEST_FILE_GLOBS])] }, null, 2)}\n`
    );
    const result = await run(process.execPath, [path.join(scaffoldDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.basename(rehearsalConfig), '--pretty', 'false'], {
      cwd: scaffoldDir,
      env: scaffoldEnv(),
      logFile: path.join(logs, 'tsc.log'),
      quiet: true,
    });
    const counts = parseTscOutput(result.output);
    if (result.status !== 0 && counts.total === 0) throw new Error(`tsc exited ${result.status} without reporting an error (logs/tsc.log)`);
    report.tsc = counts;
    console.log(`  ${counts.total} errors: ${Object.entries(counts.byCode).map(([code, count]) => `${code} ${count}`).join(', ') || 'none'}`);
    if (options.writeBudget) {
      const previous = fs.existsSync(BUDGET_FILE) ? readJson(BUDGET_FILE) : {};
      fs.writeFileSync(BUDGET_FILE, `${JSON.stringify({ why: previous.why ?? '', total: counts.total, byCode: counts.byCode }, null, 2)}\n`);
      return `budget written: ${counts.total} errors`;
    }
    if (!fs.existsSync(BUDGET_FILE)) throw new Error(`${path.relative(repoRoot, BUDGET_FILE)} is missing; pin one with --write-budget`);
    const verdict = compareWithBudget(counts, readJson(BUDGET_FILE));
    if (!verdict.ok) throw new Error(`over the pinned budget: ${verdict.over.join('; ')} (logs/tsc.log lists every error)`);
    if (verdict.lower) {
      console.log(
        `  Fewer errors than pinned: lower ${path.relative(repoRoot, BUDGET_FILE)} to ${JSON.stringify(verdict.lower)} (or rerun with --write-budget).`
      );
    }
    return `${counts.total} errors, within the budget`;
  });

  return failures;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const workdir = options.workdir ?? path.join(os.tmpdir(), `nextblock-release-rehearsal-${Date.now()}`);
  if (isInside(workdir, repoRoot)) {
    console.error(`The work folder ${workdir} is inside the repository; pick one outside it (see the header of this script).`);
    return 2;
  }
  if (!options.skipPack && fs.existsSync(workdir) && fs.readdirSync(workdir).length > 0) {
    console.error(`The work folder ${workdir} is not empty; pick a new one, or pass --skip-pack / --skip-scaffold to reuse it.`);
    return 2;
  }
  const logs = path.join(workdir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const version = options.version ?? readJson(path.join(CLI_DIR, 'package.json')).version;
  report.version = version;
  report.workdir = workdir;
  console.log(`Release rehearsal of ${version} in ${workdir}`);

  let failures = [];
  try {
    const tarballs = options.skipPack ? readPackedTarballs(workdir) : await packLibs({ workdir, version, logs });
    let scaffoldDir = path.join(workdir, SCAFFOLD_NAME);
    if (options.skipScaffold) {
      if (!fs.existsSync(path.join(scaffoldDir, 'node_modules'))) throw new StepFailure(`--skip-scaffold needs an installed ${scaffoldDir}`);
    } else {
      if (fs.existsSync(scaffoldDir)) fs.rmSync(scaffoldDir, { recursive: true, force: true });
      scaffoldDir = await scaffoldFromCli({ workdir, tarballs, logs });
    }
    failures = await checkScaffold({ scaffoldDir, logs, options });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    // A failed step is already in the summary; anything else gets its own line.
    if (!(error instanceof StepFailure)) {
      console.error(error instanceof Error ? error.stack : error);
      report.error = failures[failures.length - 1];
    }
  } finally {
    report.ok = failures.length === 0 && report.steps.every((entry) => entry.ok);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(workdir, 'rehearsal-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log('\nRelease rehearsal summary');
  for (const entry of report.steps) {
    console.log(`  ${entry.ok ? '✓' : '✗'} ${entry.name} (${entry.seconds} s)${entry.details ? `: ${entry.details}` : ''}${entry.error ? `: ${entry.error}` : ''}`);
  }
  if (report.error) console.log(`  ✗ ${report.error}`);
  console.log(`\n${report.ok ? 'The release rehearsal passed.' : 'The release rehearsal FAILED.'} Logs and the report: ${workdir}`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
);
