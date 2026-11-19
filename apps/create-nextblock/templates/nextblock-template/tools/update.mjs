#!/usr/bin/env node
// `npm run update` — one command that brings ANY NextBlock install up to date.
//
//   npm run update                 update code, dependencies and database schema
//   npm run update -- --check      report what would change; touch nothing
//   npm run update -- --yes        don't prompt (implied by CI=true)
//   npm run update -- --force      run even when already on the latest version
//   npm run update -- --skip-db    code + dependencies only
//   npm run update -- --db-only    schema only: pending migrations and the database grants
//
// It detects which of the four supported installs it is running inside and picks the
// right code channel for it:
//
//   Layout            Install path                         Code channel
//   ────────────────  ───────────────────────────────────  ──────────────────────────────
//   Nx monorepo       git clone (contributor)              git pull --ff-only origin
//   Nx monorepo       Vercel 1-click / GitHub fork         git merge upstream/master
//   Flat app          npm create nextblock (managed cloud) create-nextblock@latest on npm
//   Flat app          npm create nextblock (Docker)        create-nextblock@latest on npm
//
// The flat-app channel deliberately uses the published `create-nextblock` package rather
// than a GitHub release tarball: that package already ships the complete standalone
// template (the exact artifact the project was scaffolded from), it is versioned in
// lockstep with the app, and it needs no release tooling that does not exist yet. A
// GitHub source archive is the *monorepo* layout (apps/, libs/, tools/) and cannot be
// unpacked over a flat project at all.
//
// Schema always moves last, after dependencies are installed, so the newest migrations
// are on disk before they are applied. Migrations are forward-only and each one is
// applied and recorded inside a single transaction — see ./lib/migrate-core.mjs. The
// schema step runs on the engine the code update brought (loadUpdatedMigrationEngine), and
// re-applies the database grants even when nothing is pending (reapplyDatabaseGrants).

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

// Loaded defensively, like ./lib/migrate-core.mjs: an updater that cannot start cannot repair
// itself, so a project missing this file (a partial sync, a trimmed tools/) still updates and
// only skips the override refresh.
let refreshManagedOverrides = () => [];
try {
  ({ refreshManagedOverrides } = await import('./lib/managed-overrides.mjs'));
} catch {
  /* tools/lib/managed-overrides.mjs is missing */
}
// Same for the next.config.js postcss browser alias: without the file the update only leaves
// next.config.js alone.
let applyPostcssBrowserAlias = () => null;
let describePostcssBrowserAlias = () => [];
try {
  ({ applyPostcssBrowserAlias, describePostcssBrowserAlias } = await import('./lib/postcss-browser-alias.mjs'));
} catch {
  /* tools/lib/postcss-browser-alias.mjs is missing */
}

const UPSTREAM_URL = 'https://github.com/nextblock-cms/nextblock.git';
const UPSTREAM_SLUG = 'nextblock-cms/nextblock';
const UPSTREAM_BRANCH = 'master';
const TEMPLATE_PACKAGE = 'create-nextblock';
const TEMPLATE_SUBPATH = path.join('templates', 'nextblock-template');

/**
 * Files and directories the update owns and may overwrite. Everything else in the
 * project is the user's: .env*, public/, supabase/ (refreshed separately from the
 * @nextblock-cms/db package), package.json (merged, never replaced), README.md, and the
 * four files the scaffolder generates per-project — next.config.js, tailwind.config.js,
 * tsconfig.json, .gitignore. Two of those get one change each and are never replaced:
 * next.config.js one anchored edit, the postcss browser alias (./lib/postcss-browser-alias.mjs);
 * tsconfig.json the TypeScript 6 option, written back as JSON (keepTsconfigCompilingOnTs6, which
 * skips a tsconfig that is not plain JSON).
 *
 * proxy.test.ts stays off the list on purpose. No updater has refreshed it, so a project keeps the
 * copy it was scaffolded with (0.22.1, 0.23.0 and 0.23.4 each shipped a different one), and a 3-way
 * merge would read that copy as the developer's edit: the next release that changes the file could
 * conflict there and hold the migrations, over a test nothing in a standalone project builds or
 * runs. A root file added here later has the same problem when earlier releases shipped different
 * copies of it.
 *
 * instrumentation.ts and .browserslistrc were left off until 0.23.6, so a project scaffolded before
 * them never received them: without instrumentation.ts the CMS second-factor gate is not registered
 * on a cold server, and without .browserslistrc Next compiles for its own default browsers (Safari
 * 16.4 and up, among others) instead of NextBlock's list (Safari 15.4 and up). Neither carries
 * the proxy.test.ts risk today: a project that lacks one gets it copied in, instrumentation.ts has
 * had one version since it first shipped (2026-10-21), and .browserslistrc has not changed since
 * 2026-06-08, so the merge either copies it (a project still on the release it was scaffolded with)
 * or leaves the project's copy alone (upstream unchanged since the project's recorded release).
 * The update that brings 0.23.6 still runs the previous updater, so they arrive with
 * `npm run update -- --force` after it or with the next release's update (docs/13 → 0.23.6).
 */
const FRAMEWORK_PATHS = [
  'app',
  'components',
  'context',
  'hooks',
  'lib',
  'types',
  'tools',
  'scripts',
  'docker',
  'docs',
  'proxy.ts',
  'instrumentation.ts',
  'index.d.ts',
  'next-env.d.ts',
  'postcss.config.js',
  'eslint.config.mjs',
  '.browserslistrc',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'AGENTS.md',
  'CLAUDE.md',
];

/** Build artifacts and OS junk that must never be copied into a project. */
const NEVER_COPY = new Set(['tsconfig.tsbuildinfo', '.DS_Store', 'Thumbs.db', 'npm-debug.log']);

/** package.json scripts the framework owns; anything else the user added survives. */
const FRAMEWORK_SCRIPTS = [
  'dev',
  'prebuild',
  'build',
  'start',
  'lint',
  'update',
  'update:check',
  'deploy:supabase',
  'configure:supabase-auth',
  'affiliates:schedule-payouts',
  'docker:setup',
  'docker:up',
  'docker:down',
  'docker:logs',
];

/* ------------------------------------------------------------------- io --- */

const C = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    }
  : new Proxy({}, { get: () => (s) => s });

const say = (msg = '') => console.log(msg);
const step = (msg) => console.log(`\n${C.bold(`▸ ${msg}`)}`);
const info = (msg) => console.log(`  ${msg}`);
const good = (msg) => console.log(`  ${C.green('✓')} ${msg}`);
const warn = (msg) => console.log(`  ${C.yellow('!')} ${msg}`);
const fail = (msg) => console.log(`  ${C.red('✗')} ${msg}`);

const IS_WINDOWS = process.platform === 'win32';
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';

/**
 * npm on Windows is a .cmd shim, and since Node's CVE-2024-27980 fix a .cmd/.bat file
 * cannot be spawned without `shell: true` — it fails with EINVAL. Every npm argument this
 * file passes is a literal flag or package spec with no spaces (paths travel via `cwd`),
 * so the shell's naive arg joining is safe here.
 */
const npmOptions = (options) => (IS_WINDOWS ? { shell: true, ...options } : options);

/** Run a command with inherited stdio. Returns the exit status. */
function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...(cmd === NPM ? npmOptions(options) : options),
  });
  return { ok: res.status === 0, status: res.status ?? 1, error: res.error };
}

/** Run a command and capture stdout. Never throws. */
function capture(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...(cmd === NPM ? npmOptions(options) : options),
  });
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

/**
 * Ask before doing something irreversible.
 *
 * A non-interactive stdin is NOT consent: piping or redirecting input must not silently
 * approve overwriting a project's files. Only an explicit --yes (or CI=true) does that;
 * otherwise a missing TTY declines and says how to opt in.
 */
async function confirm(question, flags) {
  if (flags.yes || process.env.CI === 'true') return true;
  if (!process.stdin.isTTY) {
    warn(`${question} — no interactive terminal; declining. Re-run with --yes to proceed.`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/* --------------------------------------------------------------- helpers --- */

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * TypeScript 6 deprecates `compilerOptions.baseUrl` (error TS5101 unless
 * `"ignoreDeprecations": "6.0"` is set), and create-nextblock wrote `baseUrl: "."` into every
 * scaffold's tsconfig.json before 0.21. New scaffolds no longer get it. For an existing project we
 * keep baseUrl, because the project's own code may import paths rooted at it, and silence the
 * deprecation exactly as TypeScript's error message suggests. A tsconfig that is not plain JSON
 * (comments) is left alone.
 */
function keepTsconfigCompilingOnTs6(root, projectPkg, { dryRun = false } = {}) {
  const tsconfigPath = path.join(root, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;
  const tsSpec = projectPkg.devDependencies?.typescript ?? projectPkg.dependencies?.typescript ?? '';
  const major = parseInt(String(tsSpec).replace(/^[^0-9]*/, ''), 10);
  if (!(major >= 6)) return null;
  const tsconfig = readJson(tsconfigPath);
  const options = tsconfig?.compilerOptions;
  if (!options || options.baseUrl === undefined || options.ignoreDeprecations !== undefined) return null;
  if (dryRun) return 'tsconfig.json: would add "ignoreDeprecations": "6.0" (TypeScript 6 deprecates baseUrl)';
  options.ignoreDeprecations = '6.0';
  writeJson(tsconfigPath, tsconfig);
  return 'tsconfig.json: added "ignoreDeprecations": "6.0" (TypeScript 6 deprecates baseUrl)';
}

function walkUpFor(startDir, predicate, maxDepth = 8) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every file under `root`, as paths relative to `root`. */
function listFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile() && !NEVER_COPY.has(entry.name)) out.push(path.relative(base, full));
  }
  return out;
}

function sameContents(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function copyInto(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Compare two semver-ish strings. >0 if a>b. Matches lib/updates/check-upstream.ts. */
function compareSemver(a, b) {
  const parse = (v) =>
    String(v)
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The NextBlock version this install is running.
 *
 * `package.json.nextblock.version` is the authoritative stamp: a project's own
 * `version` field belongs to the user, and the moment they bump it for their own site
 * (entirely normal) a comparison against it becomes meaningless. Fall back to `version`
 * for projects scaffolded before the stamp existed.
 */
function readInstalledVersion(pkg) {
  const stamped = pkg?.nextblock?.version;
  if (typeof stamped === 'string' && stamped.trim()) return stamped.trim();
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
}

/* ----------------------------------------------------------- the shapes --- */

function detectInstall(cwd) {
  const monorepoRoot = walkUpFor(
    cwd,
    (dir) =>
      existsSync(path.join(dir, 'nx.json')) &&
      existsSync(path.join(dir, 'libs', 'db', 'src', 'supabase', 'migrations')),
  );
  if (monorepoRoot) {
    const git = capture('git', ['rev-parse', '--show-toplevel'], { cwd: monorepoRoot });
    const origin = capture('git', ['remote', 'get-url', 'origin'], { cwd: monorepoRoot });
    const isUpstream =
      origin.ok && new RegExp(`${UPSTREAM_SLUG.replace('/', '[/:]')}(\\.git)?$`, 'i').test(origin.stdout);
    return {
      layout: 'monorepo',
      root: monorepoRoot,
      hasGit: git.ok,
      originUrl: origin.ok ? origin.stdout : null,
      channel: git.ok ? (isUpstream ? 'git-clone' : 'git-fork') : 'none',
    };
  }

  const projectRoot = walkUpFor(cwd, (dir) => existsSync(path.join(dir, 'package.json'))) ?? cwd;
  const envText = ['.env.local', '.env']
    .map((f) => {
      try {
        return readFileSync(path.join(projectRoot, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const isDocker =
    existsSync(path.join(projectRoot, 'docker-compose.yml')) &&
    (/^\s*MINIO_ROOT_USER=/m.test(envText) || /^\s*POSTGRES_HOST=db\s*$/m.test(envText));

  return {
    layout: 'standalone',
    root: projectRoot,
    hasGit: capture('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot }).ok,
    originUrl: null,
    channel: 'npm',
    isDocker,
  };
}

function describeInstall(install) {
  switch (install.channel) {
    case 'git-clone':
      return 'Nx monorepo, cloned from upstream (contributor install)';
    case 'git-fork':
      return `Nx monorepo fork / Vercel 1-click deploy (origin: ${install.originUrl})`;
    case 'npm':
      return install.isDocker
        ? 'standalone project (npm create nextblock → Docker)'
        : 'standalone project (npm create nextblock → managed cloud)';
    default:
      return 'Nx monorepo without a git remote (downloaded archive)';
  }
}

/* ------------------------------------------------------- git code update --- */

function gitDirty(root) {
  const res = capture('git', ['status', '--porcelain'], { cwd: root });
  return res.ok && res.stdout.length > 0;
}

function ensureUpstreamRemote(root) {
  const existing = capture('git', ['remote', 'get-url', 'upstream'], { cwd: root });
  if (existing.ok) {
    if (existing.stdout !== UPSTREAM_URL) {
      run('git', ['remote', 'set-url', 'upstream', UPSTREAM_URL], { cwd: root, stdio: 'ignore' });
    }
    return;
  }
  run('git', ['remote', 'add', 'upstream', UPSTREAM_URL], { cwd: root, stdio: 'ignore' });
}

/** How many upstream commits this checkout is missing. null when it can't be determined. */
function commitsBehind(root, channel, flags = {}) {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (!branch.ok) return null;
  // Under --check the fetch went to FETCH_HEAD rather than a remote-tracking branch.
  const ref =
    channel === 'git-clone'
      ? `origin/${branch.stdout}`
      : flags.check
        ? 'FETCH_HEAD'
        : `upstream/${UPSTREAM_BRANCH}`;
  const counted = capture('git', ['rev-list', '--count', `HEAD..${ref}`], { cwd: root });
  return counted.ok ? Number.parseInt(counted.stdout, 10) : null;
}

/**
 * Fetch the reference this install tracks.
 *
 * Under --check nothing may be written, and configuring a remote IS a write:
 * ensureUpstreamRemote() rewrites any existing `upstream` URL that isn't character-for-character
 * the canonical https form — which silently repoints a maintainer's `git@github.com:` remote,
 * or an internal mirror, from a command that promises to change nothing. So --check fetches
 * the upstream URL directly into FETCH_HEAD and leaves .git/config alone.
 */
function fetchUpstream(root, channel, flags = {}) {
  if (channel === 'git-clone') {
    return run('git', ['fetch', '--no-tags', 'origin'], { cwd: root });
  }
  if (flags.check) {
    return run('git', ['fetch', '--no-tags', UPSTREAM_URL, UPSTREAM_BRANCH], { cwd: root });
  }
  ensureUpstreamRemote(root);
  return run('git', ['fetch', '--no-tags', 'upstream', UPSTREAM_BRANCH], { cwd: root });
}

function updateCodeViaGit(install, flags) {
  const { root, channel } = install;

  if (gitDirty(root) && !flags.force) {
    fail('Your working tree has uncommitted changes.');
    info('Commit or stash them first, then re-run:');
    info(C.cyan('  git stash push -u -m "before nextblock update"'));
    info(C.cyan('  npm run update'));
    info(`Or re-run with ${C.cyan('--force')} to merge on top of them (not recommended).`);
    return { ok: false, changed: false };
  }

  step('Fetching upstream');
  const fetched = fetchUpstream(root, channel);
  if (!fetched.ok) {
    fail('Could not reach GitHub. Check your network and try again.');
    return { ok: false, changed: false };
  }

  const behind = commitsBehind(root, channel);
  if (behind === 0 && !flags.force) {
    // As in the npm channel: the merge that brought 0.23.4's blockEditorLoaders.ts ran the updater
    // from before it, which has no editor check, so a run with nothing to merge is the first to warn.
    reportUnlistedBlockEditors(path.join(root, 'apps', 'nextblock'), 'apps/nextblock/');
    good('Code is already up to date.');
    return { ok: true, changed: false };
  }
  if (behind != null) info(`${behind} new upstream commit(s).`);

  step('Merging upstream changes');
  if (channel === 'git-clone') {
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout;
    const pulled = run('git', ['pull', '--ff-only', 'origin', branch], { cwd: root });
    if (!pulled.ok) {
      fail(`Could not fast-forward ${branch}.`);
      info('You have local commits. Rebase them onto upstream, then re-run:');
      info(C.cyan(`  git pull --rebase origin ${branch}`));
      return { ok: false, changed: false };
    }
  } else {
    // --allow-unrelated-histories: a Vercel 1-click deploy creates a fresh repository
    // rather than a fork, so it shares no history with upstream and a plain merge is
    // refused. The first merge bridges them; later merges are ordinary. Same flag the
    // nextblock-sync GitHub Action uses.
    const merged = run(
      'git',
      ['merge', '--no-edit', '--allow-unrelated-histories', `upstream/${UPSTREAM_BRANCH}`],
      { cwd: root },
    );
    if (!merged.ok) {
      run('git', ['merge', '--abort'], { cwd: root, stdio: 'ignore' });
      fail('Upstream could not be merged automatically — the merge was aborted, nothing changed.');
      say();
      info('Resolve it by hand:');
      info(C.cyan(`  git fetch upstream ${UPSTREAM_BRANCH}`));
      info(C.cyan(`  git merge --allow-unrelated-histories upstream/${UPSTREAM_BRANCH}`));
      info(C.cyan('  # fix the conflicted files, then:'));
      info(C.cyan('  git add -A && git commit && npm run update'));
      return { ok: false, changed: false };
    }
  }

  good('Upstream merged.');
  // Editors of the fork's own that the merged CMS cannot open.
  reportUnlistedBlockEditors(path.join(root, 'apps', 'nextblock'), 'apps/nextblock/');
  return { ok: true, changed: true };
}

/* --------------------------------------------------- npm/template update --- */

function latestTemplateVersion() {
  const res = capture(NPM, ['view', `${TEMPLATE_PACKAGE}@latest`, 'version']);
  if (res.ok && /^\d+\.\d+\.\d+/.test(res.stdout)) return { version: res.stdout };
  const reason = res.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'npm view failed';
  return { version: null, reason };
}

/** Download create-nextblock@version into a temp dir and return the template path. */
function stageTemplate(version) {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'nextblock-update-'));
  writeJson(path.join(stage, 'package.json'), {
    name: 'nextblock-update-stage',
    version: '1.0.0',
    private: true,
  });
  const installed = run(
    NPM,
    [
      'install',
      `${TEMPLATE_PACKAGE}@${version}`,
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--omit=optional',
      '--loglevel=error',
    ],
    { cwd: stage },
  );
  if (!installed.ok) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: `npm could not download ${TEMPLATE_PACKAGE}@${version}` };
  }
  const templateDir = path.join(stage, 'node_modules', TEMPLATE_PACKAGE, TEMPLATE_SUBPATH);
  if (!existsSync(templateDir)) {
    rmSync(stage, { recursive: true, force: true });
    return {
      ok: false,
      error: `${TEMPLATE_PACKAGE}@${version} does not contain ${TEMPLATE_SUBPATH}`,
    };
  }
  return { ok: true, stage, templateDir };
}

/* ------------------------------------------- git 3-way merge (preferred) --- */

/**
 * Can we merge rather than overwrite?
 *
 * Requires a git repository with at least one commit and a clean working tree — not
 * because the merge itself needs them (it does not; see mergeTemplates below), but so the
 * result is reviewable and reversible: `git diff` shows exactly what the update did,
 * `git checkout -- <file>` backs out one file, `git reset --hard HEAD` backs out all of it.
 */
function gitMergeability(projectRoot) {
  if (!capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot }).ok) {
    return { ok: false, reason: 'this project is not a git repository' };
  }
  if (!capture('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot }).ok) {
    return { ok: false, reason: 'this git repository has no commits yet' };
  }
  const status = capture('git', ['status', '--porcelain'], { cwd: projectRoot });
  if (!status.ok) return { ok: false, reason: 'could not read the git status' };
  if (status.stdout.length > 0) {
    return { ok: false, reason: 'the working tree has uncommitted changes' };
  }
  return { ok: true };
}

/** Heuristic used to keep binary assets away from a textual 3-way merge. */
function looksBinary(file) {
  try {
    const buf = readFileSync(file);
    const limit = Math.min(buf.length, 8000);
    for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** Every framework file present in a staged template, relative to it. */
function frameworkFilesIn(templateDir) {
  const files = [];
  for (const entry of FRAMEWORK_PATHS) {
    const from = path.join(templateDir, entry);
    if (!existsSync(from)) continue;
    if (statSync(from).isDirectory()) files.push(...listFiles(from, templateDir));
    else if (!NEVER_COPY.has(entry)) files.push(entry);
  }
  return files.sort();
}

/**
 * Merge one NextBlock version into another, file by file, using `git merge-file`.
 *
 * `git merge-file OURS BASE THEIRS` is a standalone textual 3-way merge: it rewrites OURS
 * in place with the combined result and exits with the number of conflict hunks. It is
 * deliberately used here in preference to `git apply --3way`, which implies `--index` and
 * therefore drags in three couplings this has no need of:
 *   * it STAGES its result, so `git diff` shows the developer nothing;
 *   * it requires every patched path to be present in the index, so a single framework
 *     path the project happens to gitignore aborts the whole update;
 *   * it requires the worktree to match the index, so anything that dirties a patched file
 *     mid-run (a dev server regenerating next-env.d.ts, say) aborts it too.
 * merge-file has none of those: it is plain file-in, file-out, touching no git state.
 *
 * Four cases per file, cheapest first:
 *   1. the project does not have it        -> upstream added it; copy.
 *   2. upstream did not change it          -> leave the developer's copy entirely alone.
 *   3. the developer never edited it       -> copy the new version.
 *   4. both changed it                     -> real 3-way merge; conflicts get markers.
 * Files upstream deleted are never removed — case 2 simply never fires for them.
 */
function mergeTemplates(projectRoot, oldTemplateDir, newTemplateDir, versions) {
  const emptyBase = path.join(mkdtempSync(path.join(os.tmpdir(), 'nb-base-')), 'empty');
  writeFileSync(emptyBase, '', 'utf8');

  const summary = { added: [], updated: [], untouched: [], conflicts: [], binary: [], failed: [] };
  try {
    for (const rel of frameworkFilesIn(newTemplateDir)) {
      const theirs = path.join(newTemplateDir, rel);
      const basePath = path.join(oldTemplateDir, rel);
      const ours = path.join(projectRoot, rel);
      const hasBase = existsSync(basePath);

      if (!existsSync(ours)) {
        copyInto(theirs, ours);
        summary.added.push(rel);
        continue;
      }
      if (hasBase && sameContents(basePath, theirs)) {
        summary.untouched.push(rel); // upstream unchanged — never touch the project's copy
        continue;
      }
      if (hasBase && sameContents(basePath, ours)) {
        copyInto(theirs, ours); // developer never edited it — take the new version wholesale
        summary.updated.push(rel);
        continue;
      }
      if (looksBinary(theirs) || looksBinary(ours)) {
        // A textual merge would corrupt it. Keep the project's file and say so.
        summary.binary.push(rel);
        continue;
      }

      const res = capture(
        'git',
        [
          'merge-file',
          '-L',
          'your version',
          '-L',
          `NextBlock ${versions.from}`,
          '-L',
          `NextBlock ${versions.to}`,
          ours,
          hasBase ? basePath : emptyBase,
          theirs,
        ],
        { cwd: projectRoot },
      );
      // Exit status is the number of conflict hunks, or negative (255) on a real error.
      if (res.status === 0) summary.updated.push(rel);
      else if (res.status > 0 && res.status < 128) summary.conflicts.push(rel);
      else summary.failed.push(rel);
    }
    return { ok: true, ...summary };
  } finally {
    try {
      rmSync(path.dirname(emptyBase), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* leave it for the OS temp cleaner */
    }
  }
}
/** Work out which framework files differ between the staged template and the project. */
function planFileSync(templateDir, projectRoot) {
  const adds = [];
  const updates = [];
  for (const entry of FRAMEWORK_PATHS) {
    const from = path.join(templateDir, entry);
    if (!existsSync(from)) continue;
    const relatives = statSync(from).isDirectory()
      ? listFiles(from, templateDir)
      : NEVER_COPY.has(entry)
        ? []
        : [entry];
    for (const rel of relatives) {
      const src = path.join(templateDir, rel);
      const dest = path.join(projectRoot, rel);
      if (!existsSync(dest)) adds.push(rel);
      else if (!sameContents(src, dest)) updates.push(rel);
    }
  }
  return { adds: adds.sort(), updates: updates.sort() };
}

function applyFileSync(templateDir, projectRoot, plan) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(projectRoot, '.nextblock-backup');
  const backupDir = path.join(backupRoot, stamp);
  for (const rel of plan.updates) {
    copyInto(path.join(projectRoot, rel), path.join(backupDir, rel));
  }
  // Make the backup tree self-ignoring. Scaffolded projects are git repos, and without
  // this every update would drop hundreds of files into `git status` (and into any
  // `git add -A`). A nested .gitignore works for projects that already exist, with no
  // dependency on the scaffolder's ignore list.
  if (plan.updates.length > 0) {
    try {
      writeFileSync(
        path.join(backupRoot, '.gitignore'),
        '# NextBlock update backups — local safety copies, never committed.\n*\n',
        'utf8',
      );
    } catch {
      /* non-fatal */
    }
  }
  for (const rel of [...plan.adds, ...plan.updates]) {
    copyInto(path.join(templateDir, rel), path.join(projectRoot, rel));
  }
  return plan.updates.length > 0 ? backupDir : null;
}

/**
 * Merge the template's manifest into the project's, in place.
 *
 * Third-party ranges (next, react, tailwind, …) are taken verbatim from the template —
 * that IS the dependency update. `@nextblock-cms/*` entries are left alone when the
 * project already has them: the scaffolder writes floating ranges there, so `npm
 * install` picks up new libs without this script guessing published versions. New
 * NextBlock packages are added as `latest`, matching what the scaffolder writes.
 *
 * An override NextBlock wrote in an earlier release moves to the current default first
 * (see ./lib/managed-overrides.mjs); an override the owner set still wins over the template.
 */
function mergePackageJson(templatePkg, projectPkg, newVersion) {
  // Keyed by package name so the override pass below can correct a line it contradicts.
  const added = new Map();
  const bumped = new Map();
  const realigned = [];
  const overrides = refreshManagedOverrides(projectPkg);

  for (const section of ['dependencies', 'devDependencies']) {
    const fromTemplate = templatePkg[section] ?? {};
    projectPkg[section] = projectPkg[section] ?? {};
    for (const [name, range] of Object.entries(fromTemplate)) {
      const current = projectPkg[section][name];
      const isNextBlockPkg = name.startsWith('@nextblock-cms/');
      let next = range;
      if (isNextBlockPkg) {
        // `workspace:*` only resolves inside the monorepo. The scaffolder rewrites it, but
        // a manually-copied template (or a project that predates that rewrite) can still
        // carry it, and npm then fails the whole install with EUNSUPPORTEDPROTOCOL. Treat
        // it as "no usable range" rather than preserving it.
        if (current && !String(current).startsWith('workspace:')) continue;
        next = String(range).startsWith('npm:') ? range : 'latest';
      }
      if (current === next) continue;
      if (current == null) added.set(name, `${name}@${next}`);
      else bumped.set(name, `${name} ${current} → ${next}`);
      projectPkg[section][name] = next;
    }
  }

  // npm throws EOVERRIDE when a package is BOTH a direct dependency and carries an
  // override with a different spec. The scaffolder aligns them; taking the template's
  // range verbatim above can knock them back out of alignment (e.g. overrides.uuid
  // ^11.1.1 vs the template's dependencies.uuid ^11.0.4), which fails `npm install`.
  // Re-assert the alignment — the override always wins, exactly as at scaffold time. The log
  // says what the project ends up with: a range this merge just raised is reported as held
  // by the override, not as a bump followed by a revert.
  for (const [name, spec] of Object.entries(projectPkg.overrides ?? {})) {
    if (typeof spec !== 'string') continue;
    for (const section of ['dependencies', 'devDependencies']) {
      const range = projectPkg[section]?.[name];
      if (range === undefined || range === spec) continue;
      projectPkg[section][name] = spec;
      if (added.has(name)) {
        added.set(name, `${name}@${spec} (your overrides.${name})`);
      } else if (bumped.delete(name)) {
        realigned.push(`${name} stays at ${spec}: your overrides.${name} pins it (this release ships ${range})`);
      } else {
        realigned.push(`${name} → ${spec} (matches your overrides.${name})`);
      }
    }
  }

  projectPkg.scripts = projectPkg.scripts ?? {};
  for (const key of FRAMEWORK_SCRIPTS) {
    const value = templatePkg.scripts?.[key];
    if (value && projectPkg.scripts[key] !== value) projectPkg.scripts[key] = value;
  }

  // NOTE: the nextblock.version stamp is deliberately NOT written here. It is written by
  // stampVersion() only after `npm install` succeeds — otherwise a failed install would
  // leave the manifest claiming the new version, and the next `npm run update` would say
  // "already up to date" and never finish the job.

  return { added: [...added.values()], bumped: [...bumped.values()], realigned, overrides };
}

/** Record the NextBlock version this project is now on. Call only after a successful install. */
function stampVersion(projectRoot, version) {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) return false;
  pkg.nextblock = {
    ...(pkg.nextblock ?? {}),
    version,
    updatedAt: new Date().toISOString(),
  };
  writeJson(pkgPath, pkg);
  return true;
}

/**
 * Force the @nextblock-cms/* packages to their newest published versions.
 *
 * Their ranges are dist-tags (`latest`), and npm treats an already-resolved dist-tag
 * dependency as still valid — a plain `npm install` will happily keep the version in the
 * lockfile and never re-resolve. Without this step the framework source updates while the
 * libraries it imports stay pinned at whatever was installed on the day the project was
 * scaffolded. An explicit `pkg@latest` install re-resolves and rewrites the lockfile.
 */
function upgradeNextBlockPackages(projectRoot, projectPkg) {
  const specs = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(projectPkg[section] ?? {})) {
      if (!name.startsWith('@nextblock-cms/')) continue;
      // Preserve an alias mapping (e.g. "@nextblock-cms/ecommerce": "npm:@nextblock-cms/ecom@latest")
      // by re-specifying it verbatim; installing `name@latest` would silently drop the alias.
      // A leftover `workspace:*` is not installable outside the monorepo — resolve it to latest.
      const spec = String(range);
      specs.push(spec.startsWith('npm:') ? `${name}@${spec}` : `${name}@latest`);
    }
  }
  if (specs.length === 0) return { ok: true, specs };
  const res = run(NPM, ['install', ...specs, '--no-audit', '--no-fund'], { cwd: projectRoot });
  return { ok: res.ok, specs };
}

/**
 * Copy the migration SQL out of the freshly-installed @nextblock-cms/db package into
 * <project>/supabase/, which is what Docker mounts and what the build hook reads. The
 * scaffolder materializes this directory exactly once, at creation time; without this
 * refresh a project that upgrades its packages ends up with new TypeScript types over an
 * old schema.
 */
function refreshProjectMigrations(projectRoot) {
  const packageDir = path.join(
    projectRoot,
    'node_modules',
    '@nextblock-cms',
    'db',
    'supabase',
  );
  if (!existsSync(packageDir)) return { ok: false, copied: 0, reason: '@nextblock-cms/db has no bundled supabase/ directory' };

  let copied = 0;
  const fromMigrations = path.join(packageDir, 'migrations');
  if (existsSync(fromMigrations)) {
    const target = path.join(projectRoot, 'supabase', 'migrations');
    for (const name of readdirSync(fromMigrations)) {
      if (!/^\d+_.*\.sql$/.test(name)) continue;
      const src = path.join(fromMigrations, name);
      const dest = path.join(target, name);
      if (existsSync(dest) && sameContents(src, dest)) continue;
      copyInto(src, dest);
      copied += 1;
    }
  }

  // config.toml only lands if the project has none — it carries per-project settings.
  const fromConfig = path.join(packageDir, 'config.toml');
  const destConfig = path.join(projectRoot, 'supabase', 'config.toml');
  if (existsSync(fromConfig) && !existsSync(destConfig)) copyInto(fromConfig, destConfig);

  return { ok: true, copied };
}

/** Warn when a NextBlock package is missing from next.config.js transpilePackages. */
function checkTranspilePackages(projectRoot, projectPkg) {
  const configPath = path.join(projectRoot, 'next.config.js');
  if (!existsSync(configPath)) return [];
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  return Object.keys(projectPkg.dependencies ?? {})
    .filter((name) => name.startsWith('@nextblock-cms/'))
    .filter((name) => !text.includes(name));
}

/**
 * Print what applyPostcssBrowserAlias() did to next.config.js, what a --check run would do, or
 * the entry to add by hand when the file has no anchor the patch can trust.
 */
function reportPostcssBrowserAlias(result) {
  for (const { level, text } of describePostcssBrowserAlias(result)) {
    if (level === 'good') good(text);
    else if (level === 'warn') warn(text);
    else if (level === 'code') info(C.cyan(`    ${text}`));
    else if (level === 'dim') info(C.dim(text));
    else info(text);
  }
}

/* -------------------------------------------------------- block editors --- */

/** What the editor check reads, relative to the app (a standalone project, or apps/nextblock). */
const BLOCK_EDITOR_PATHS = {
  registry: 'lib/blocks/blockRegistry.ts',
  editors: 'app/cms/blocks/editors',
  loaders: 'app/cms/blocks/components/blockEditorLoaders.ts',
};
/** The files an extension-less import('../editors/<name>') resolves to. */
const EDITOR_MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
/** A registry name the check can look up and print: relative path segments, ASCII only. */
const EDITOR_NAME_RE = /^(?:[\w$-]+(?:\.[\w$-]+)*\/)*[\w$-]+(?:\.[\w$-]+)*$/;
/** A test, spec, story (.story or .stories) or declaration: mapping one would bundle it into the CMS (the 0.23.0 build failure). */
const NOT_AN_EDITOR_RE = /\.(?:test|spec|story|stories|d)$/i;
/**
 * A line git merge-file writes to open or close a conflict hunk (`<<<<<<< your version`,
 * `>>>>>>> NextBlock 0.23.5`). In JavaScript a multiline `$` matches before a CR as well as an LF,
 * so this and CONFLICT_SEPARATOR_RE find a CRLF file's markers too; git grep's `$` does not
 * (UNRESOLVED_CONFLICT_PATTERN).
 */
const CONFLICT_MARKER_RE = /^(?:<{7}|>{7})(?: |$)/m;
/**
 * The `=======` line between a hunk's two sides. Seven `=` alone on a line are also a markdown
 * heading underline, which a registry template literal may hold, so hasMergeConflict counts such a
 * line only where it is code.
 */
const CONFLICT_SEPARATOR_RE = /^={7}[ \t]*$/gm;

const WORD_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /\d[\w.]*/y;
const PUNCT_RE = /\.\.\.|=>|[=!]==?|[<>]=|&&|\|\||\?\?|[^\s\w$'"`]/y;
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
/** Words after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Just enough of a JavaScript/TypeScript tokenizer to read object keys and string values. Comments
 * are dropped, and a string, template literal or regular expression is one token, so nothing inside
 * one reads as code. Tokens are { type, value, start } with type 'word', 'number', 'punct',
 * 'string', 'template' (plus `substitution`) or 'regex', and `start` the index of the token's first
 * character in the source. Returns null for what it cannot read with confidence: an unterminated
 * string, template literal or comment.
 */
function tokenizeSource(source) {
  const n = source.length;
  // Each skip takes the index of the opening character and returns the index past the token, or -1.
  const skipComment = (k) => {
    if (source[k] !== '/') return k;
    if (source[k + 1] === '/') {
      const end = source.indexOf('\n', k);
      return end < 0 ? n : end;
    }
    if (source[k + 1] !== '*') return k;
    const end = source.indexOf('*/', k + 2);
    return end < 0 ? -1 : end + 2;
  };
  const skipString = (start) => {
    for (let k = start + 1; k < n; k += 1) {
      if (source[k] === '\\') k += source[k + 1] === '\r' && source[k + 2] === '\n' ? 2 : 1; // `\` + CRLF continues the line
      else if (source[k] === source[start]) return k + 1;
      else if (source[k] === '\n' || source[k] === '\r') return -1;
    }
    return -1;
  };
  // A `${…}` part is read by scan() itself, regular expressions and nested templates included.
  const skipTemplate = (start) => {
    for (let k = start + 1; k < n; k += 1) {
      if (source[k] === '\\') k += 1;
      else if (source[k] === '`') return k + 1;
      else if (source[k] === '$' && source[k + 1] === '{') {
        k = scan(k + 2, [], true) - 1;
        if (k < 0) return -1;
      }
    }
    return -1;
  };
  const skipRegex = (start) => {
    let inClass = false;
    for (let k = start + 1; k < n; k += 1) {
      if (source[k] === '\\') k += 1;
      else if (source[k] === '\n' || source[k] === '\r') return -1;
      else if (source[k] === '[') inClass = true;
      else if (source[k] === ']') inClass = false;
      else if (source[k] === '/' && !inClass) {
        let end = k + 1;
        while (end < n && /[A-Za-z]/.test(source[end])) end += 1;
        return end;
      }
    }
    return -1;
  };
  const sticky = (re, at) => {
    re.lastIndex = at;
    return re.exec(source)?.[0];
  };
  // Tokens from `start` into `tokens`, to the end of the source; or, for a template substitution
  // (`inner`), to the brace that closes it. Returns the index past where it stopped, or -1.
  const scan = (start, tokens, inner) => {
    let depth = 0;
    for (let i = start; i < n; ) {
      if (/\s/.test(source[i])) {
        i += 1;
        continue;
      }
      const afterComment = skipComment(i);
      if (afterComment !== i) {
        if (afterComment < 0) return -1;
        i = afterComment;
        continue;
      }
      const previous = tokens.at(-1);
      const regexMayStart =
        !previous ||
        (previous.type === 'punct' && !CLOSERS.has(previous.value)) ||
        (previous.type === 'word' && REGEX_AFTER_WORDS.has(previous.value));
      let end;
      if (source[i] === '"' || source[i] === "'") {
        end = skipString(i);
        if (end < 0) return -1;
        tokens.push({ type: 'string', value: source.slice(i + 1, end - 1), start: i });
      } else if (source[i] === '`') {
        end = skipTemplate(i);
        if (end < 0) return -1;
        const value = source.slice(i + 1, end - 1);
        tokens.push({ type: 'template', value, substitution: value.includes('${'), start: i });
      } else if (source[i] === '/' && regexMayStart && (end = skipRegex(i)) > 0) {
        tokens.push({ type: 'regex', value: source.slice(i, end), start: i });
      } else {
        const word = sticky(WORD_RE, i);
        const number = word ? undefined : sticky(NUMBER_RE, i);
        const text = word ?? number ?? sticky(PUNCT_RE, i);
        if (!text) return -1;
        if (inner && text === '{') depth += 1;
        else if (inner && text === '}' && depth-- === 0) return i + 1;
        tokens.push({ type: word ? 'word' : number ? 'number' : 'punct', value: text, start: i });
        end = i + text.length;
      }
      i = end;
    }
    return inner ? -1 : n;
  };

  const tokens = [];
  return scan(0, tokens, false) < 0 ? null : tokens;
}

/**
 * Whether a file still holds a merge conflict: a `<<<<<<<` or `>>>>>>>` line, or a `=======` line
 * that is code, which a hunk resolved by deleting only the outer two lines leaves behind. A
 * `=======` line inside a template literal, a string or a comment is text: the tokenizer starts no
 * token there. A file it cannot read counts as clean here, and the readers below then say nothing.
 */
function hasMergeConflict(source) {
  if (CONFLICT_MARKER_RE.test(source)) return true;
  const separators = [...source.matchAll(CONFLICT_SEPARATOR_RE)].map((match) => match.index);
  if (separators.length === 0) return false;
  const codeStarts = new Set((tokenizeSource(source) ?? []).map((token) => token.start));
  return separators.some((index) => codeStarts.has(index));
}

/**
 * The members of the object literal whose `{` is tokens[open], each as its tokens, split at the
 * commas outside brackets; or null when the object never closes.
 */
function readObjectMembers(tokens, open) {
  const members = [];
  let member = [];
  let depth = 0;
  for (let k = open + 1; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.type === 'punct' && depth === 0 && (token.value === ',' || token.value === '}')) {
      if (member.length > 0) members.push(member); // an empty one is a trailing comma
      member = [];
      if (token.value === '}') return members;
      continue;
    }
    if (token.type === 'punct' && OPENERS.has(token.value)) depth += 1;
    else if (token.type === 'punct' && CLOSERS.has(token.value) && (depth -= 1) < 0) return null;
    member.push(token);
  }
  return null; // never closed
}

/**
 * The keys of the object literal whose `{` is tokens[open], or null when one member is not
 * `key: value` with an identifier or plain string key: a spread, a shorthand, a method, an
 * accessor or a computed key adds entries this cannot name.
 */
function readObjectKeys(tokens, open) {
  const members = readObjectMembers(tokens, open);
  if (!members) return null;
  const keys = new Set();
  for (const [key, colon] of members) {
    if (colon?.type !== 'punct' || colon.value !== ':') return null;
    if (key.type !== 'word' && (key.type !== 'string' || key.value.includes('\\'))) return null;
    keys.add(key.value);
  }
  return keys;
}

/**
 * Whether the `<` at tokens[open] opens a method's type parameters: the `>` that closes it (a depth
 * count over `<` and `>`) is followed by `(`. Otherwise it opens type arguments.
 */
function opensTypeParameters(tokens, open) {
  let depth = 0;
  for (let k = open; k < tokens.length; k += 1) {
    const { type, value } = tokens[k];
    if (type !== 'punct') continue;
    if (value === '<') depth += 1;
    else if (value === '>' && (depth -= 1) === 0) return tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '(';
  }
  return false;
}

/**
 * Whether an object member (its tokens) sets EditorComponent, its key quoted or not: a property
 * (`EditorComponent: …`), a method (`EditorComponent() {…}`, `EditorComponent<T>() {…}`) or the
 * shorthand, so the token after the key is `:`, `(`, `<` or none, and after `<` the `>` that
 * closes it is followed by `(`. Any other is no such member: readObjectMembers splits a type's
 * `Map<string, EditorComponent>` at its comma into a member `EditorComponent >`, and
 * `Map<string, EditorComponent<Props>>` into `EditorComponent < Props > >`. That scan runs over
 * `tokens`, the whole file's, as a comma also splits a method's type parameters
 * (`EditorComponent<T, U>() {…}`). `EditorComponent: undefined` or `: null` sets nothing, and the
 * CMS opens the file.
 */
function setsEditorComponent([key, next, value, ...rest], tokens) {
  if (key.value !== 'EditorComponent' || (key.type !== 'word' && key.type !== 'string')) return false;
  if (next && !(next.type === 'punct' && [':', '(', '<'].includes(next.value))) return false;
  if (next?.value === '<' && !opensTypeParameters(tokens, tokens.indexOf(next))) return false;
  const unset = next?.value === ':' && value?.type === 'word' && (value.value === 'undefined' || value.value === 'null');
  return !(unset && rest.length === 0);
}

/**
 * The keys of the BLOCK_EDITOR_LOADERS object literal, or null when they cannot all be read: no
 * such declaration, a value that is not a plain object literal, or a member readObjectKeys refuses.
 */
function readBlockEditorLoaderKeys(source) {
  const tokens = tokenizeSource(source);
  if (!tokens) return null;
  for (let at = 0; at + 1 < tokens.length; at += 1) {
    const [keyword, name] = [tokens[at], tokens[at + 1]];
    if (keyword.type !== 'word' || !['const', 'let', 'var'].includes(keyword.value)) continue;
    if (name.type !== 'word' || name.value !== 'BLOCK_EDITOR_LOADERS') continue;
    // The value follows the first `=` outside brackets: a type annotation may hold braces and `=>`.
    let depth = 0;
    let open = -1;
    for (let k = at + 2; k < tokens.length && open < 0 && depth >= 0; k += 1) {
      const token = tokens[k];
      if (token.type !== 'punct') continue;
      if (OPENERS.has(token.value)) depth += 1;
      else if (CLOSERS.has(token.value)) depth -= 1;
      else if (depth === 0 && token.value === ';') break;
      else if (depth === 0 && token.value === '=') open = k + 1;
    }
    if (open < 0) continue; // declared without a value: the declaration that has one comes later
    return tokens[open]?.type === 'punct' && tokens[open].value === '{' ? readObjectKeys(tokens, open) : null;
  }
  return null;
}

/**
 * Every editorComponentFilename the registry writes as a string literal, or null when it cannot be
 * read. A definition that also sets EditorComponent is left out: EditableBlock and ColumnEditor open
 * that component instead, so its file needs no loader. Only a member of the filename's own object
 * literal counts; a spread is not followed.
 */
function readRegistryEditorFilenames(source) {
  const tokens = tokenizeSource(source);
  if (!tokens) return null;
  const filenames = [];
  const opens = []; // the brackets around tokens[k], innermost last
  const opensEditorComponent = new Map(); // `{` index -> whether that object literal sets EditorComponent
  for (let k = 0; k < tokens.length; k += 1) {
    const [key, colon, value] = [tokens[k], tokens[k + 1], tokens[k + 2]];
    if (key.type === 'punct' && OPENERS.has(key.value)) opens.push(k);
    else if (key.type === 'punct' && CLOSERS.has(key.value)) opens.pop();
    if (key.value !== 'editorComponentFilename' || (key.type !== 'word' && key.type !== 'string')) continue;
    if (tokens[k - 1]?.type === 'punct' && tokens[k - 1].value === '.') continue; // `def.editorComponentFilename : '…'` reads one
    if (colon?.type !== 'punct' || colon.value !== ':' || !value) continue;
    if (value.type !== 'string' && (value.type !== 'template' || value.substitution)) continue;
    const open = opens.at(-1);
    if (open !== undefined && tokens[open].value === '{') {
      if (!opensEditorComponent.has(open)) {
        opensEditorComponent.set(open, readObjectMembers(tokens, open)?.some((member) => setsEditorComponent(member, tokens)) === true);
      }
      if (opensEditorComponent.get(open)) continue;
    }
    filenames.push(value.value);
  }
  return filenames;
}

/**
 * Editors the CMS cannot open: each editorComponentFilename lib/blocks/blockRegistry.ts writes as a
 * string in a definition that sets no EditorComponent of its own, whose module exists in
 * app/cms/blocks/editors (nested paths included), and whose name without its extension, the key
 * getLazyBlockEditor looks up, BLOCK_EDITOR_LOADERS lacks.
 *
 * Through 0.23.3 the CMS imported an editor by that name alone, so a project that added its own
 * editor there (docs/07) needed nothing else. Since 0.23.4 it opens only the editors that
 * app/cms/blocks/components/blockEditorLoaders.ts maps, and logs "No editor component found" for any
 * other; the update brings the map without a conflict, and a standalone project has no vitest to run
 * blockEditorLoaders.test.ts. Registry names with no file (cart, checkout, product_details, the
 * testimonial placeholder) are skipped, so the shipped files report nothing; so are test, spec,
 * story and declaration names, and any name that is not ASCII path segments (EDITOR_NAME_RE).
 *
 * Returns { conflicted: [file] } when either file holds a merge conflict (hasMergeConflict),
 * { missing: [name] } otherwise, or null when there is nothing to compare: a file is missing (a
 * project before 0.23.4 has no map and still opens editors by name), or the registry or the map
 * cannot be read.
 */
function findUnlistedBlockEditors(appRoot) {
  const fsPath = (relative) => path.join(appRoot, ...relative.split('/'));
  const { registry, editors, loaders } = BLOCK_EDITOR_PATHS;
  if (![registry, editors, loaders].every((relative) => existsSync(fsPath(relative)))) return null;
  const sources = { [loaders]: readFileSync(fsPath(loaders), 'utf8'), [registry]: readFileSync(fsPath(registry), 'utf8') };
  const conflicted = Object.keys(sources).filter((relative) => hasMergeConflict(sources[relative]));
  if (conflicted.length > 0) return { conflicted };
  const filenames = readRegistryEditorFilenames(sources[registry]);
  if (!filenames) return null;
  const names = new Set();
  for (const filename of filenames) {
    const name = filename.trim().replace(/\.[jt]sx?$/, '');
    if (!EDITOR_NAME_RE.test(name) || NOT_AN_EDITOR_RE.test(name)) continue;
    if (EDITOR_MODULE_EXTENSIONS.some((extension) => isFile(fsPath(`${editors}/${name}${extension}`)))) names.add(name);
  }
  if (names.size === 0) return { missing: [] };
  const keys = readBlockEditorLoaderKeys(sources[loaders]);
  return keys ? { missing: [...names].filter((name) => !keys.has(name)).sort() } : null;
}

/** The BLOCK_EDITOR_LOADERS key for an editor name, quoted when it is not an identifier ('faq/FaqBlockEditor'). */
const loaderKeyOf = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);

/**
 * Print what findUnlistedBlockEditors found: each editor the CMS cannot open with the line that
 * opens it, or one line naming the file whose merge conflict stopped the check. `prefix` places the
 * app in the repository ('apps/nextblock/' in the monorepo). A warning only: it never fails or
 * prompts, and an error costs one dim line.
 */
function reportUnlistedBlockEditors(appRoot, prefix = '') {
  let found;
  try {
    found = findUnlistedBlockEditors(appRoot);
  } catch (err) {
    info(C.dim(`Could not check the block editors against BLOCK_EDITOR_LOADERS: ${err?.message ?? err}`));
    return;
  }
  const { registry, editors, loaders } = BLOCK_EDITOR_PATHS;
  if (found?.conflicted) {
    const files = found.conflicted.map((relative) => `${prefix}${relative}`);
    const one = files.length === 1;
    warn(
      `${files.join(' and ')} ${one ? 'has a merge conflict' : 'have merge conflicts'}, so the block editors were not ` +
        `checked: resolve the conflict${one ? ' in that file' : 's in those files'}, then run ${C.cyan('npm run update')} again.`,
    );
    return;
  }
  const missing = found?.missing ?? [];
  if (missing.length === 0) return;
  const one = missing.length === 1;
  warn(
    `${missing.length} block editor${one ? '' : 's'} in ${prefix}${editors} ${one ? 'is' : 'are'} named in ${prefix}${registry} ` +
      `but missing from BLOCK_EDITOR_LOADERS, so the CMS opens nothing for ${one ? 'its block' : 'their blocks'}.`,
  );
  info(
    `Since 0.23.4 the CMS opens only the editors listed there. Add ${one ? 'this line' : 'these lines'} to ` +
      `BLOCK_EDITOR_LOADERS in ${prefix}${loaders}:`,
  );
  for (const name of missing) info(C.cyan(`    ${loaderKeyOf(name)}: () => import('../editors/${name}'),`));
}

async function updateCodeViaNpm(install, flags) {
  const { root } = install;
  const pkgPath = path.join(root, 'package.json');
  const projectPkg = readJson(pkgPath);
  if (!projectPkg) {
    fail(`Could not read ${pkgPath}.`);
    return { ok: false, changed: false };
  }

  const current = readInstalledVersion(projectPkg);
  step('Checking npm for a newer release');
  const { version: latest, reason } = latestTemplateVersion();
  if (!latest) {
    fail(`Could not reach the npm registry to look up ${TEMPLATE_PACKAGE}.`);
    info(C.dim(reason));
    return { ok: false, changed: false };
  }
  info(`installed ${C.bold(current)} · latest ${C.bold(latest)}`);

  if (compareSemver(latest, current) <= 0 && !flags.force) {
    // The update that installed TypeScript 6 ran the PREVIOUS update.mjs, which predates this
    // step, so check here too or it would never run for that project. Idempotent.
    const tsconfigNote = keepTsconfigCompilingOnTs6(root, projectPkg, { dryRun: flags.check });
    if (tsconfigNote) good(tsconfigNote);
    // Same for the editor check: the update that brought 0.23.4's blockEditorLoaders.ts ran the
    // 0.23.3 updater, which has none, so the run docs/13 asks for after it is the first to warn.
    reportUnlistedBlockEditors(root);
    // Same for the overrides NextBlock wrote in earlier releases: the update that brought this
    // script ran the previous one, which kept them. Moving one needs an `npm install`, so the
    // run then counts as a change and main() installs.
    const overrideNotes = refreshManagedOverrides(flags.check ? structuredClone(projectPkg) : projectPkg);
    if (overrideNotes.length > 0 && flags.check) {
      for (const line of overrideNotes) info(C.dim(`would move ${line}`));
    } else if (overrideNotes.length > 0) {
      const original = readFileSync(pkgPath, 'utf8');
      writeJson(pkgPath, projectPkg);
      for (const line of overrideNotes) good(line);
      good('Code is already up to date.');
      // Nothing else records this move, so a failed install has to undo it: otherwise the next
      // run finds the overrides already current, reports nothing to do, and never installs.
      // main() adds the postcss alias below after that install, beside the transpilePackages check.
      return {
        ok: true,
        changed: true,
        version: current,
        restoreOnInstallFailure: { path: pkgPath, text: original },
      };
    }
    // Same for the postcss browser alias in next.config.js: the update that brought 0.23.4 and
    // lib/browser-stubs/postcss.cjs ran the 0.23.3 updater, which never edits next.config.js, so
    // this run is the first that can add it. Idempotent: a file that has it is never touched.
    reportPostcssBrowserAlias(applyPostcssBrowserAlias(root, { dryRun: flags.check }));
    good('Code is already up to date.');
    return { ok: true, changed: false, version: current };
  }

  step(`Downloading ${TEMPLATE_PACKAGE}@${latest}`);
  const staged = stageTemplate(latest);
  if (!staged.ok) {
    fail(staged.error);
    return { ok: false, changed: false };
  }

  let oldStaged = null;
  try {
    const templatePkg = readJson(path.join(staged.templateDir, 'package.json')) ?? {};
    const plan = planFileSync(staged.templateDir, root);

    step('Reviewing changes');
    info(`${plan.adds.length} new file(s), ${plan.updates.length} file(s) to update.`);
    if (flags.check) {
      const preview = [...plan.adds.map((f) => `+ ${f}`), ...plan.updates.map((f) => `~ ${f}`)];
      for (const line of preview.slice(0, 40)) info(C.dim(line));
      if (preview.length > 40) info(C.dim(`… and ${preview.length - 40} more`));
      const mergeable = gitMergeability(root);
      info(
        mergeable.ok
          ? C.dim('These would be applied as a git 3-way merge against your edits.')
          : C.dim(`Files would be replaced (${mergeable.reason}).`),
      );
      // The stub may only arrive with this release, so the staged template counts as having it.
      reportPostcssBrowserAlias(applyPostcssBrowserAlias(root, { dryRun: true, incomingDir: staged.templateDir }));
      return { ok: true, changed: false, version: current };
    }

    if (plan.adds.length === 0 && plan.updates.length === 0) {
      good('Every framework file already matches the new release.');
    } else {
      // Preferred path: a real 3-way merge, so a developer's edits to framework files are
      // preserved and only genuine overlaps conflict — the same experience as `git pull`,
      // for a project that has no upstream to pull from. Needs the PREVIOUS version's
      // template as the merge base.
      const mergeable = gitMergeability(root);
      let merged = null;

      if (mergeable.ok) {
        step(`Preparing a 3-way merge (${current} → ${latest})`);
        oldStaged = stageTemplate(current);
        if (oldStaged.ok) {
          if (!(await confirm(`Merge ${plan.adds.length + plan.updates.length} upstream file change(s)?`, flags))) {
            info('Nothing was changed.');
            return { ok: true, changed: false, declined: true, version: current };
          }
          // Re-check cleanliness now: staging the base ran a full npm download and the
          // prompt above may have waited on a human, so the tree could have been dirtied
          // (a dev server regenerating next-env.d.ts, an editor saving) since the first
          // check. Merging into a tree we have not verified would blur the developer's own
          // uncommitted work into the update, with no way to tell them apart afterwards.
          const stillClean = gitMergeability(root);
          if (!stillClean.ok) {
            fail(`Your working tree changed while this ran — ${stillClean.reason}.`);
            info('Commit or stash it, then re-run ' + C.cyan('npm run update') + '. Nothing was changed.');
            return { ok: false, changed: false };
          }
          merged = mergeTemplates(root, oldStaged.templateDir, staged.templateDir, {
            from: current,
            to: latest,
          });
        } else {
          warn(`Could not fetch ${TEMPLATE_PACKAGE}@${current} as a merge base; falling back to file replacement.`);
        }
      } else {
        info(C.dim(`No 3-way merge available — ${mergeable.reason}.`));
      }

      if (merged?.ok) {
        const touched = merged.added.length + merged.updated.length + merged.conflicts.length;
        good(
          `Merged ${latest} into ${touched} file(s) ` +
            `(${merged.added.length} new, ${merged.updated.length} updated, ${merged.untouched.length} unchanged upstream).`,
        );
        for (const rel of merged.binary) {
          warn(`Kept your version of ${rel} — binary files are never merged automatically.`);
        }
        for (const rel of merged.failed) {
          warn(`Could not merge ${rel}; your version was left untouched.`);
        }
        if (merged.conflicts.length > 0) {
          warn(`${merged.conflicts.length} file(s) conflict with your edits and need resolving:`);
          for (const f of merged.conflicts.slice(0, 20)) info(C.dim(`  ${f}`));
          if (merged.conflicts.length > 20) info(C.dim(`  … and ${merged.conflicts.length - 20} more`));
          say();
          info('Each carries the usual conflict markers. To inspect or back out:');
          info(C.cyan('  git status                  # incl. the files added by this update'));
          info(C.cyan('  git diff                    # what changed in files you already had'));
          info(C.cyan('  git checkout -- <file>      # discard the merge for one file'));
          info(C.cyan('  git reset --hard HEAD       # undo this update entirely'));
          say();
          info(
            `${C.bold('When the conflicts are fixed, run')} ${C.cyan('npm run update')} ${C.bold('again')} — ` +
              'it will pick up where it left off and apply the database migrations.',
          );
        } else {
          info(
            'No conflicts. Review with ' +
              C.cyan('git status') +
              ' and ' +
              C.cyan('git diff') +
              ', then commit when happy.',
          );
        }
      } else {
        // Fallback: no git, no commits, a dirty tree, or the merge machinery failed.
        // Replace the files and keep a copy of anything overwritten.
        warn('Replaced files are backed up under .nextblock-backup/ — diff it back if you had edits.');
        if (!(await confirm(`Replace ${plan.adds.length + plan.updates.length} file(s)?`, flags))) {
          info('Nothing was changed.');
          return { ok: true, changed: false, declined: true, version: current };
        }
        const backupDir = applyFileSync(staged.templateDir, root, plan);
        good(`Applied. ${backupDir ? `Backup: ${path.relative(root, backupDir)}` : 'No backup needed.'}`);
      }
    }

    // Once, after the merge or the replacement: editors of the project's own that the new
    // release's CMS cannot open.
    reportUnlistedBlockEditors(root);

    step('Updating package.json');
    const merged = mergePackageJson(templatePkg, projectPkg, latest);
    writeJson(pkgPath, projectPkg);
    for (const line of merged.overrides) good(line);
    for (const line of merged.added) good(`added ${line}`);
    for (const line of merged.bumped) good(line);
    for (const line of merged.realigned) info(C.dim(line));
    if (merged.added.length + merged.bumped.length + merged.overrides.length === 0) {
      info('No dependency changes.');
    }
    const tsconfigNote = keepTsconfigCompilingOnTs6(root, projectPkg);
    if (tsconfigNote) good(tsconfigNote);

    return { ok: true, changed: true, version: latest };
  } finally {
    // Best-effort: on Windows a just-written node_modules tree can still be locked by an
    // indexer or AV scanner, and rmSync throws EBUSY/EPERM (force:true only swallows
    // ENOENT). Throwing here would mask an otherwise successful update, so retry and
    // then give up — the OS reclaims the temp directory anyway.
    for (const dir of [staged.stage, oldStaged?.ok ? oldStaged.stage : null]) {
      if (!dir) continue;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* leave it for the OS temp cleaner */
      }
    }
  }
}

/* -------------------------------------------------------------- schema --- */

/**
 * The line `git merge-file` writes to open a hunk under mergeTemplates()' first label, as the
 * pattern unresolvedConflicts() hands `git grep -E`. merge-file writes it with CRLF when the three
 * files it merges (the project's and the two published copies) use CRLF, and git grep keeps the CR in
 * the line, which `$` alone never matched: through 0.23.5 an update that left a conflict in a CRLF
 * file held nothing and applied the migrations over it. About half the template files
 * create-nextblock has published are CRLF (this file and tools/lib/migrate-core.mjs among them), so
 * in a standalone project that was a conflict in any of those, on any system. The hold also keeps the
 * reload from importing a tools/lib/migrate-core.mjs the merge left conflicted (updateSchema). `\r` is
 * a JavaScript escape, so git receives a literal CR; capture() starts git with no shell in between.
 */
const UNRESOLVED_CONFLICT_PATTERN = '^<<<<<<< your version\r?$';

/**
 * Unresolved merge conflicts left in the project by a previous `npm run update`: the tracked files
 * holding UNRESOLVED_CONFLICT_PATTERN, whatever their line endings.
 *
 * The marker label is the one mergeTemplates() passes to `git merge-file`, so this cannot
 * be confused with a conflict from the developer's own git work. Used to refuse the schema
 * step until the tree is coherent again.
 */
function unresolvedConflicts(projectRoot) {
  // Anchored to the start of a line: that is where git merge-file writes the marker, and
  // anchoring stops the match from firing on source that merely *mentions* the string —
  // this file being the first example.
  const res = capture('git', ['grep', '-lE', UNRESOLVED_CONFLICT_PATTERN, '--', '.'], {
    cwd: projectRoot,
  });
  // exit 1 with no output is git grep's "no matches"; anything else (not a repo, etc.) is
  // simply "cannot tell", and must not block an update.
  if (!res.stdout) return [];
  return res.stdout.split('\n').filter(Boolean);
}

/**
 * The calls the schema step and main() make on the migration engine. The update to a release runs
 * its schema step on that release's tools/lib/migrate-core.mjs (loadUpdatedMigrationEngine), so an
 * updater calls the engine of the release after it: every release's engine keeps each name an
 * earlier updater lists here (update.test.mjs pins them), and one that lacks a name is not used.
 */
const MIGRATION_ENGINE_CALLS = ['loadEnvFiles', 'describeBackend', 'collectMigrations', 'readAppliedVersions', 'applyMigrations', 'runSql'];

/** The migration engine's path in this install, for messages. */
const migrationEngineFile = (install) =>
  install.layout === 'monorepo' ? 'apps/nextblock/tools/lib/migrate-core.mjs' : 'tools/lib/migrate-core.mjs';

/** An error on one line: its message, after its name when that says more than "Error" (a SyntaxError). */
const errorLine = (err) =>
  err instanceof Error ? (err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message) : String(err);

/**
 * The migration engine for the schema step of a run that updated the code.
 *
 * main() imports tools/lib/migrate-core.mjs before the code update, which replaces it (the template
 * sync in a standalone project, the git merge in the monorepo), and Node keeps a module once loaded.
 * Through 0.23.5 the update that brought a release therefore applied that release's migrations with
 * the previous release's engine and post-apply grant pass: GRANTS_SQL grants EXECUTE on every public
 * function to the API roles and then revokes only what its API_ROLE_REVOKE_SQL lists, so a function
 * the new release revokes stayed callable until the next build hook run (after the update to 0.23.6,
 * anon could call publish_product_draft). The query gives the file a module URL of its own, so Node
 * reads it from disk again; it stays one string literal, like every import() here. The new engine
 * reads process.env, which the first engine's loadEnvFiles filled, and its own loadEnvFiles
 * overrides nothing.
 *
 * A file that does not load, or lacks a call in MIGRATION_ENGINE_CALLS, leaves the engine loaded
 * first, marked not current: the schema step then applies pending migrations with it, as earlier
 * updaters did, and never runs a grant pass of its own with it.
 */
async function loadUpdatedMigrationEngine(loaded, install) {
  const file = migrationEngineFile(install);
  try {
    const engine = await import('./lib/migrate-core.mjs?after-update');
    const missing = MIGRATION_ENGINE_CALLS.filter((name) => typeof engine[name] !== 'function');
    if (missing.length > 0) throw new Error(`it exports no ${missing.join(', ')}`);
    await engine.loadEnvFiles(install.root);
    info(C.dim(`Using the migration engine as this update left it (${file}).`));
    return { core: engine, current: true };
  } catch (err) {
    warn(`Could not load ${file} as this update left it: ${errorLine(err)}`);
    info(
      'This run keeps the copy loaded before the update, with the database grants of the version you updated from. ' +
        `Run ${C.cyan('npm run update')} again to apply this version's grants (if that file fails to load again, fix it first).`,
    );
    return { core: loaded, current: false };
  }
}

/**
 * The post-apply grant pass with nothing to apply: GRANTS_SQL grants the API roles their blanket
 * privileges on public, then takes back what the trigger-function revoke and API_ROLE_REVOKE_SQL
 * list, as the build hook does on every production build. Through 0.23.5 an update ran it only
 * after applying a migration, so the grants of an update that applied a release's migrations with
 * the previous engine (above) waited for the build hook; now running `npm run update` again closes
 * that gap. Not under --check, which writes nothing, and not with an engine the code update
 * replaced: its pass is the previous version's, and would hand back what a newer pass took away.
 */
async function reapplyDatabaseGrants(core, current, flags) {
  if (flags.check) {
    info(C.dim('Would re-apply the database grants.'));
    return { ok: true, applied: 0 };
  }
  if (!current) {
    warn('The database grants were not re-applied: the migration engine this update brought did not load (above).');
    return { ok: true, applied: 0 };
  }
  // Given no file, applyMigrations applies nothing and then runs the grant pass, as it does after
  // every apply on both backends (and has PostgREST reload its schema).
  const result = await core.applyMigrations([]);
  if (!result.ok) {
    fail(`Could not re-apply the database grants: ${result.error}`);
    return { ok: false, applied: 0 };
  }
  good('Re-applied the database grants: the blanket grants to the API roles, then the revokes this version lists.');
  return { ok: true, applied: 0 };
}

async function updateSchema(install, core, flags, { codeChanged = false } = {}) {
  step('Database schema');

  // Never migrate over an unresolved merge. The developer has not yet decided what their
  // code is, so moving the schema ahead of it — or worse, doing it while they are still
  // deciding whether to keep the update at all — is exactly the wrong order.
  const unresolved = unresolvedConflicts(install.root);
  if (unresolved.length > 0 && !flags.check) {
    warn(`${unresolved.length} file(s) still contain unresolved merge conflicts:`);
    for (const f of unresolved.slice(0, 20)) info(C.dim(`  ${f}`));
    if (unresolved.length > 20) info(C.dim(`  … and ${unresolved.length - 20} more`));
    say();
    info('Migrations are on hold until those are resolved. Then run:');
    info(C.cyan('  npm run update            # finishes the job (applies the migrations)'));
    info('Or abandon the update entirely — the database was never touched:');
    info(C.cyan('  git reset --hard HEAD'));
    return { ok: true, applied: 0, deferred: true };
  }

  // The self-hosted Docker stack ships its OWN migration runner (the `migrate` service in
  // docker-compose.yml, which mounts ./supabase/migrations and tracks applied versions in
  // public._nextblock_docker_migrations — a different table from the one used everywhere
  // else). Applying from here would run every migration a second time against a database
  // that already has them. The refreshed SQL is already on disk, so hand off to the stack.
  if (install.isDocker) {
    good('Refreshed migrations are staged in supabase/migrations.');
    info(`The Docker stack applies them on ${C.cyan('npm run docker:up')}.`);
    return { ok: true, applied: 0 };
  }

  // After the hold, which finds an engine file the merge left conflicted whatever its line endings,
  // so the reload never imports one, and outside Docker, whose stack runs its own migrations and no
  // blanket grant (docker/migrate/run-migrations.sh). update.test.mjs fails if the reload moves above
  // either. The result names the engine used, which main() keeps for the update alert.
  const engine = codeChanged ? await loadUpdatedMigrationEngine(core, install) : { core, current: true };
  return { ...(await applyPendingMigrations(install, engine, flags)), core: engine.core };
}

/** `text` in lines of at most `width` characters, broken at spaces (a longer word keeps a line to itself). */
function wrapText(text, width = 96) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The engine refused to apply over an empty migration history (emptyHistoryRefusal in
 * ./lib/migrate-core.mjs), in readAppliedVersions or applyMigrations, and wrote nothing: this database
 * holds content, and with nothing recorded the run would replay a retired squash generation over it.
 * `message` says why and what to restore; this adds what that means for this install, and main() how
 * to go on. An updater from before the refusal prints the same message as a history it could not read,
 * or as a failed migration.
 */
function refuseEmptyHistory(install, message) {
  fail('Refusing to apply migrations to this database:');
  for (const line of wrapText(message)) info(line);
  say();
  // Only the monorepo has db:migrate and db:migrate:repair-history (its root package.json), and its
  // refusal always means "never crossed": its folder holds one generation, so no retired file.
  if (install.layout === 'monorepo') {
    info(`${C.cyan('npm run db:migrate')} refuses this database too. Do not get past it with`);
    info(`${C.cyan('npm run db:migrate:repair-history')}: it records only this generation's versions, so the`);
    info('catch-up would still find no retired version recorded, and replay that whole generation.');
  }
  info('The build hook stops at the same point: a production build applies nothing until this is fixed.');
  return { ok: false, applied: 0, refused: true };
}

/**
 * Apply what is pending on `core`, which then runs the grant pass; with nothing pending, run the
 * grant pass alone (reapplyDatabaseGrants). `current` is false for an engine the code update replaced.
 */
async function applyPendingMigrations(install, { core, current }, flags) {
  const backend = core.describeBackend();
  if (backend.kind === 'none') {
    warn(`No database connection is configured (${backend.detail}).`);
    info('Set POSTGRES_URL (or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_ID) and re-run.');
    return { ok: false, applied: 0 };
  }
  info(`Backend: ${backend.kind} · ${backend.detail}`);

  const { files, sources } = core.collectMigrations(install.root);
  if (files.length === 0) {
    warn('No migration files were found — nothing to apply.');
    return { ok: true, applied: 0 };
  }
  for (const source of sources) {
    if (source.contributed > 0) {
      info(`${source.contributed} migration(s) from the ${source.label} copy`);
    }
  }

  // The engine judges an empty history by the files this run would apply, before anything is listed or asked.
  const applied = await core.readAppliedVersions(files);
  if (applied.refusal) return refuseEmptyHistory(install, applied.error);
  if (!applied.ok) {
    fail(`Could not read the migration history: ${applied.error}`);
    return { ok: false, applied: 0 };
  }
  // Versions recorded remotely that have no file here mean the two histories have diverged
  // — most often an install that predates a squash, where the retired generation's numbering
  // (00000000000000–00000000000042 for generation 1) is still recorded. That matters because
  // Supabase (and this applier) match history by VERSION ONLY, never by content: a local file
  // whose number is already recorded is skipped in silence, with no error and no output. Warn
  // rather than block — this applier is exactly the one that is SUPPOSED to run here. It
  // tolerates retired rows, and the catch-up reads them to decide what to replay, so the rows
  // must survive until after it has run. Reconciling them away is the step that comes AFTER,
  // and only the monorepo has a reason and a script for it: its db:migrate runs `supabase db
  // push`, which refuses while they remain, and its root package.json holds
  // db:migrate:repair-history. A standalone project's package.json is apps/nextblock's, which
  // has neither, and nothing it runs needs them gone: this applier, the build hook and /setup
  // use the history only to skip recorded files (docs/13 → "The contract every applier honours").
  const localVersions = new Set(files.map((f) => f.version));
  const remoteOnly = [...applied.versions].filter((v) => !localVersions.has(v)).sort();
  if (remoteOnly.length > 0) {
    warn(`${remoteOnly.length} version(s) are recorded in the database with no matching file:`);
    for (const v of remoteOnly.slice(0, 10)) info(C.dim(`  ${v}`));
    if (remoteOnly.length > 10) info(C.dim(`  … and ${remoteOnly.length - 10} more`));
    info('Migrations are matched by version, never by content, so a local file reusing one');
    info('of those numbers would never run. A migration squash retired them; applying the');
    info('pending files below is what carries this database across it.');
    if (install.layout === 'monorepo') {
      info(`Afterwards, clear the retired rows once with ${C.cyan('npm run db:migrate:repair-history')}`);
      info('(it detects the squash and offers to reconcile). Do not run it first — the catch-up');
      info('reads those rows to decide what to replay.');
    } else {
      info('In a standalone project, leave them: this updater, the build hook and /setup use the history');
      info('only to skip recorded files, so rows without a file change nothing for them, and the catch-up');
      info(`reads those rows to decide what to replay. Only the Supabase CLI objects (${C.cyan('supabase db push')}`);
      info('refuses while they remain); if you run it on this database, docs/13-STAYING-UP-TO-DATE.md');
      info('("The contract every applier honours") says when it is safe to remove them.');
    }
    say();
  }

  const pending = files.filter((f) => !applied.versions.has(f.version));

  if (pending.length === 0) {
    good(`Schema is up to date (${files.length} migration(s) recorded).`);
    return reapplyDatabaseGrants(core, current, flags);
  }

  info(`${C.bold(String(pending.length))} pending migration(s):`);
  for (const entry of pending) info(C.dim(`  ${entry.name}`));

  if (flags.check) return { ok: true, applied: 0 };
  if (!(await confirm(`Apply ${pending.length} migration(s) now?`, flags))) {
    warn('Skipped. Apply later with "npm run update -- --db-only".');
    return { ok: false, applied: 0 };
  }

  const result = await core.applyMigrations(files, {
    onApplied: (entry) => good(`applied ${entry.name}`),
  });
  if (result.refusal) return refuseEmptyHistory(install, result.error);
  if (!result.ok) {
    fail(`Migration failed after ${result.applied} file(s): ${result.error}`);
    info('The failed migration rolled back; re-run once the cause is fixed.');
    return { ok: false, applied: result.applied };
  }
  good(
    current
      ? `Applied ${result.applied} migration(s) and re-applied the database grants.`
      : `Applied ${result.applied} migration(s), with the database grants of the version you updated from (above).`,
  );
  return { ok: true, applied: result.applied };
}

/**
 * Clear the dashboard's "update available" banner for versions we have actually reached.
 *
 * Scoped to `metadata.latest_version <= installedVersion` on purpose. The dashboard dedupes
 * alerts by version and never re-inserts one it has already written, so resolving an alert
 * for a version this install has NOT reached would suppress that banner permanently — which
 * is exactly what would happen when a GitHub release is tagged before the npm packages go
 * out and the dashboard is briefly ahead of the registry.
 */
async function clearUpdateAlert(core, installedVersion) {
  const escaped = String(installedVersion).replace(/'/g, "''");
  const res = await core.runSql(
    `update public.system_alerts
        set is_resolved = true, resolved_at = now()
      where alert_type = 'runtime_update_available'
        and is_resolved = false
        and string_to_array(regexp_replace(coalesce(metadata->>'latest_version', '0'), '[^0-9.].*$', ''), '.')::int[]
            <= string_to_array(regexp_replace('${escaped}', '[^0-9.].*$', ''), '.')::int[];`,
  );
  return res.ok;
}

/* ----------------------------------------------------------------- main --- */

function parseFlags(argv) {
  const set = new Set(argv);
  return {
    check: set.has('--check') || set.has('--dry-run'),
    yes: set.has('--yes') || set.has('-y'),
    force: set.has('--force'),
    skipDb: set.has('--skip-db'),
    dbOnly: set.has('--db-only'),
    help: set.has('--help') || set.has('-h'),
  };
}

/** This script's path in this install, from its root: what PowerShell users run with node. */
const updaterFile = (install) => (install.layout === 'monorepo' ? 'apps/nextblock/tools/update.mjs' : 'tools/update.mjs');

function printHelp(install) {
  say(`
${C.bold('npm run update')} — bring this NextBlock install up to date.

  ${C.cyan('npm run update')}                 code + dependencies + database schema
  ${C.cyan('npm run update -- --check')}      report what would change; change nothing
  ${C.cyan('npm run update -- --yes')}        never prompt
  ${C.cyan('npm run update -- --force')}      run even when already on the latest version
  ${C.cyan('npm run update -- --skip-db')}    code + dependencies only
  ${C.cyan('npm run update -- --db-only')}    schema only: pending migrations and the database grants

  On Windows PowerShell the bare ${C.cyan('--')} is stripped and the flag never arrives;
  call this script directly instead, e.g. ${C.cyan(`node ${updaterFile(install)} --db-only`)}.
`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  // Before the help, which names this install's path to the script (a standalone project has no apps/).
  const install = detectInstall(process.cwd());
  if (flags.help) return printHelp(install);

  say(`\n${C.bold('NextBlock update')} ${C.dim(flags.check ? '(check only)' : '')}`);
  info(describeInstall(install));
  info(C.dim(install.root));

  // Loaded here for loadEnvFiles, --check and a run that changes no code. The code update below may
  // replace tools/lib/migrate-core.mjs, so a run that updates the code loads it again for the schema
  // step (loadUpdatedMigrationEngine): a release's migrations then run with that release's engine and
  // post-apply grant pass, API_ROLE_REVOKE_SQL included. The schema step hands back the engine it
  // used, for the update alert below.
  let core;
  try {
    core = await import('./lib/migrate-core.mjs');
  } catch (err) {
    fail(`Could not load the migration engine: ${err?.message ?? err}`);
    process.exitCode = 1;
    return;
  }
  await core.loadEnvFiles(install.root);

  let codeChanged = false;
  let restoreOnInstallFailure = null;
  let newVersion = null;

  if (!flags.dbOnly) {
    if (install.channel === 'none') {
      step('Source code');
      warn('This monorepo has no git remote, so the code cannot be updated automatically.');
      info(`Clone it instead: ${C.cyan(`git clone ${UPSTREAM_URL}`)}`);
    } else if (install.layout === 'monorepo') {
      if (flags.check) {
        step('Checking upstream');
        if (fetchUpstream(install.root, install.channel, flags).ok) {
          const behind = commitsBehind(install.root, install.channel, flags);
          info(behind === 0 ? 'Code is up to date.' : `${behind ?? '?'} new upstream commit(s).`);
        } else {
          fail('Could not reach GitHub.');
        }
      } else {
        const res = updateCodeViaGit(install, flags);
        if (!res.ok) {
          process.exitCode = 1;
          return;
        }
        codeChanged = res.changed;
      }
    } else {
      const res = await updateCodeViaNpm(install, flags);
      if (!res.ok) {
        process.exitCode = 1;
        return;
      }
      codeChanged = res.changed;
      newVersion = res.version ?? null;
      restoreOnInstallFailure = res.restoreOnInstallFailure ?? null;
    }
  }

  if (codeChanged && !flags.check) {
    step('Installing dependencies');
    const installed = run(NPM, ['install'], { cwd: install.root });
    if (!installed.ok) {
      if (restoreOnInstallFailure) {
        writeFileSync(restoreOnInstallFailure.path, restoreOnInstallFailure.text, 'utf8');
        info('package.json is back as it was, so the next run moves the overrides again.');
      }
      fail('npm install failed — fix the error above, then re-run "npm run update".');
      process.exitCode = 1;
      return;
    }
    good('Dependencies installed.');

    if (install.layout === 'standalone') {
      const projectPkg = readJson(path.join(install.root, 'package.json')) ?? {};
      const upgraded = upgradeNextBlockPackages(install.root, projectPkg);
      if (!upgraded.ok) {
        fail('Could not upgrade the @nextblock-cms/* packages — fix the error above and re-run.');
        process.exitCode = 1;
        return;
      }
      if (upgraded.specs.length > 0) good(`Upgraded ${upgraded.specs.length} NextBlock package(s).`);

      // Only now is the new version genuinely installed — record it.
      if (newVersion) stampVersion(install.root, newVersion);

      const refreshed = refreshProjectMigrations(install.root);
      if (refreshed.ok) {
        good(
          refreshed.copied > 0
            ? `Refreshed ${refreshed.copied} migration file(s) in supabase/migrations.`
            : 'Migration files in supabase/migrations are already current.',
        );
      } else {
        warn(refreshed.reason);
      }

      for (const name of checkTranspilePackages(install.root, projectPkg)) {
        warn(`Add "${name}" to transpilePackages in next.config.js.`);
      }
      // After the file sync, so lib/browser-stubs/postcss.cjs is on disk before anything points at it.
      reportPostcssBrowserAlias(applyPostcssBrowserAlias(install.root));
    }
  }

  let schemaOk = true;
  let schemaDeferred = false;
  let schemaRefused = false;
  if (!flags.skipDb) {
    const res = await updateSchema(install, core, flags, { codeChanged: codeChanged && !flags.check });
    schemaOk = res.ok;
    schemaDeferred = res.deferred === true;
    schemaRefused = res.refused === true;
    if (res.core) core = res.core;
  }

  // Only after an update that fully landed. A no-op run must not clear a banner advertising
  // a version this install has not reached, and neither must a run whose schema step is
  // still waiting on the developer to resolve conflicts.
  if (!flags.check && codeChanged && newVersion && schemaOk && !schemaDeferred) {
    await clearUpdateAlert(core, newVersion).catch(() => false);
  }

  step('Done');
  if (schemaRefused) {
    // The engine refused an empty history (refuseEmptyHistory): no rebuild and no re-run applies
    // anything until its cause is fixed, --check or not.
    info(`The database was not changed. Fix what is described above, then run ${C.cyan('npm run update')} again.`);
  } else if (flags.check) {
    info('Nothing was changed. Run "npm run update" to apply.');
  } else if (schemaDeferred) {
    info('Resolve the conflicts above, then re-run ' + C.cyan('npm run update') + ' to migrate.');
  } else if (install.isDocker) {
    info(`Rebuild the stack: ${C.cyan('npm run docker:up')}`);
  } else if (install.layout === 'monorepo') {
    info(`Restart the dev server: ${C.cyan('npm run dev')}`);
  } else {
    info(`Rebuild and restart: ${C.cyan('npm run build')} then ${C.cyan('npm start')}`);
  }
  say();

  if (!schemaOk) process.exitCode = 1;
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
