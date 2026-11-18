import { execSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

import { listFiles, toPosix } from './template-check.js';

// What `npm publish` would really put in the create-nextblock tarball, checked against the
// template on disk. npm packs a folder by its .npmignore, or by its .gitignore when it has none,
// and never ships either file (npm-packlist). The sync copies apps/nextblock with its .gitignore,
// so every rule written for git is also a packing rule: until 0.23.4 its `.env.*` kept
// .env.example and .env.docker.example out of every published CLI, and each `npm create
// nextblock` project got bin/'s short placeholder .env.example instead. template-check.js reads
// the disk copy, which was complete. Only npm knows what it packs, so this asks it.

/** Basenames npm never packs, whatever the ignore files say (npm-packlist's default rules). */
const NEVER_PACKED_NAMES = new Set(['.gitignore', '.npmignore', '.npmrc', '.DS_Store', 'npm-debug.log']);
const NEVER_PACKED_NAME_PATTERNS = [/^\..*\.swp$/, /^\._/, /\.orig$/];
/** Folders npm never packs, together with everything in them. */
const NEVER_PACKED_DIRS = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store']);
/** `.env` or `.env.<anything>`: a local env file unless it is an `.example` template. */
const ENV_FILE_NAME = /^\.env(\..+)?$/;

const PACK_COMMAND = 'npm pack --dry-run --ignore-scripts --json';

const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/** True for a path (relative, with `/`) that npm leaves out of every tarball. */
export function isNeverPackedByNpm(path) {
  const segments = path.split('/');
  const name = segments.pop();
  if (segments.some((segment) => NEVER_PACKED_DIRS.has(segment) || segment.startsWith('._'))) {
    return true;
  }
  return (
    NEVER_PACKED_NAMES.has(name) ||
    NEVER_PACKED_DIRS.has(name) ||
    NEVER_PACKED_NAME_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/** True for a local env file (`.env`, `.env.local`, ...), which must never ship. */
export function isLocalEnvFile(path) {
  const name = basenameOf(path);
  return ENV_FILE_NAME.test(name) && !name.endsWith('.example');
}

/**
 * The template files on disk that the tarball lacks, sorted. Files npm never packs are left out,
 * and so are local env files: they must stay out (findPackedEnvFiles reports one that ships).
 * `templateFiles` are relative to the template, `packedFiles` to the package root, and
 * `templatePath` is the template's folder inside the package. Every path uses `/`.
 */
export function findUnpackedTemplateFiles({ templateFiles, packedFiles, templatePath }) {
  const packed = new Set(packedFiles);
  return templateFiles
    .filter((file) => !isNeverPackedByNpm(file) && !isLocalEnvFile(file))
    .filter((file) => !packed.has(`${templatePath}/${file}`))
    .sort();
}

/** The local env files `npm publish` would ship, anywhere in the package, sorted. */
export function findPackedEnvFiles(packedFiles) {
  return packedFiles.filter(isLocalEnvFile).sort();
}

/** The file paths in `npm pack --dry-run --json` output, relative to the package root, with `/`. */
export function parsePackedFiles(output) {
  const excerpt = () => String(output).trim().slice(0, 200);
  let reports;
  try {
    reports = JSON.parse(output);
  } catch {
    throw new Error(`${PACK_COMMAND} printed no JSON: ${excerpt()}`);
  }
  const files = Array.isArray(reports) ? reports[0]?.files : undefined;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${PACK_COMMAND} listed no files: ${excerpt()}`);
  }
  return files.map((file) => String(file.path).replace(/\\/g, '/').replace(/^\.\//, ''));
}

/**
 * Runs `npm pack --dry-run` in `packageDir` and returns its stdout (npm writes notices to
 * stderr). --ignore-scripts keeps prepack, which runs this sync, from starting again. Flags beat
 * the npm_config_* variables an outer `npm publish` hands down, so `--json` holds under
 * `npm publish --silent` too.
 */
export function runNpmPackDryRun(packageDir, { exec = execSync } = {}) {
  try {
    return exec(PACK_COMMAND, {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(' ');
    throw new Error(`${PACK_COMMAND} failed in ${packageDir}: ${detail}`);
  }
}

/**
 * Runs `npm pack <tarball> --dry-run --json` and returns its stdout: npm reads an already packed
 * tarball and lists the files in it, in the same JSON as a folder's dry run. release:all publishes
 * that file with `npm publish <tarball>`, which runs no prepack, so it is checked as packed
 * (scripts/check-tarball.js). A tarball spec runs no lifecycle script; --ignore-scripts says so.
 */
export function runNpmPackTarball(tarballPath, { exec = execSync } = {}) {
  try {
    return exec(`npm pack "${tarballPath}" --dry-run --ignore-scripts --json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(' ');
    throw new Error(`npm pack --dry-run could not read ${tarballPath}: ${detail}`);
  }
}

/**
 * The `bin` scripts of `manifest` (a package.json) that `packedFiles` lacks, one line each: a
 * tarball without them installs a `create-nextblock` command that cannot start.
 */
export function findMissingBinFiles(manifest, packedFiles) {
  const bin = typeof manifest?.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest?.bin ?? {});
  const packed = new Set(packedFiles);
  return Object.entries(bin)
    .map(([command, target]) => [command, String(target).replace(/\\/g, '/').replace(/^\.\//, '')])
    .filter(([, target]) => !packed.has(target))
    .map(([command, target]) => `${target} (the \`${command}\` command) is not in the tarball`);
}

/**
 * What `npm publish` would get wrong, one line per problem: a template file it would leave out,
 * or a local env file it would publish. An empty list means the tarball is right. `pack` returns
 * npm's JSON output for `packageDir`; tests pass their own instead of running npm.
 */
export async function findPackProblems({ packageDir, templateDir, pack = runNpmPackDryRun }) {
  const templatePath = toPosix(relative(packageDir, templateDir));
  if (!templatePath || templatePath.startsWith('..') || isAbsolute(templatePath)) {
    throw new Error(`The template ${templateDir} is not inside the package ${packageDir}`);
  }

  const packedFiles = parsePackedFiles(await pack(packageDir));
  const templateFiles = (await listFiles(templateDir)).map((file) => toPosix(relative(templateDir, file)));

  return [
    ...findUnpackedTemplateFiles({ templateFiles, packedFiles, templatePath }).map(
      (file) =>
        `${templatePath}/${file} is not in the tarball: an ignore rule drops it (npm packs a folder by ` +
        `its .gitignore when it has no .npmignore, and the template's .gitignore is apps/nextblock's)`,
    ),
    ...findPackedEnvFiles(packedFiles).map(
      (file) => `${file} would be published: only *.example env files may ship`,
    ),
  ];
}
