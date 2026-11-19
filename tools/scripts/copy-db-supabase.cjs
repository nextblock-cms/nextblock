#!/usr/bin/env node

const fs = require('fs-extra');
// The OS's realpath (libuv): links resolved, and on Windows the long, real-case name.
const { realpath } = require('node:fs/promises');
const path = require('node:path');

// What @nextblock-cms/db ships under supabase/: the entries its consumers read from the installed
// package, and nothing else. create-nextblock's ensureSupabaseAssets copies all three into a new
// project (it refuses a package without config.toml or migrations/, and the project's
// tools/configure-supabase-auth.js uploads templates/ as the Auth emails); npm run update
// (apps/nextblock/tools/update.mjs) re-copies migrations/ and a missing config.toml; the build
// hook (tools/lib/migrate-core.mjs) reads migrations/ in node_modules. The rest of
// libs/db/src/supabase stays in the monorepo: functions/ (the maintainer-only migration-ingest
// edge function, which db:push:sandbox and db:functions deploy from libs/db/src; no consumer reads
// it from the package) and whatever the Supabase CLI or a maintainer leaves there. A denylist
// (.temp/, .branches/, .env*) used to decide, and it missed the CLI's local state that is not a
// dot path: local Studio saves SQL snippets to snippets/ (read-write), and `gen signing-key`
// writes signing_keys.json. verify-lib-dist.js check 13 holds the db tarball to this list (check 14
// holds the files inside migrations/ and templates/ to their names), and copy-db-supabase.test.ts
// fails when a consumer reads an entry it leaves out.
const SUPABASE_PACKAGE_ENTRIES = Object.freeze(['config.toml', 'migrations', 'templates']);

/** The db package's build output, relative to the workspace root (the db build step's cwd). */
const DB_DIST_DIR = path.join('dist', 'libs', 'db');

/**
 * Whether a path inside the supabase folder (relative to it, either separator) goes into the
 * package: it lies under one of SUPABASE_PACKAGE_ENTRIES and no segment starts with '.', at any
 * depth. A dot entry is tool state, config or a secret (the CLI's .temp/ and .branches/, an
 * ignore file, an .env file; an .env.example too, which check 12 refuses in the tarball), never
 * package content. '' is the folder itself.
 */
function shouldCopySupabaseEntry(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return true;
  return SUPABASE_PACKAGE_ENTRIES.includes(segments[0]) && !segments.some((segment) => segment.startsWith('.'));
}

/**
 * `destDir` resolved, once it is known to be the db dist folder's own supabase/: named `supabase`,
 * directly inside `distDir`, and a real folder (or not there yet). copySupabaseAssets empties it,
 * so a wrong argument (the source folder, dist/libs/db itself, the workspace root) must stop here,
 * and so must a link, since emptying one empties the folder it points at. This reads the path as
 * written; a link above it is copySupabaseAssets' real-path check's (refuseOverlap).
 */
async function resolveSupabaseDest(destDir, distDir) {
  const dest = path.resolve(destDir);
  const dist = path.resolve(distDir);
  // path.relative ignores case on Windows, where an Nx run can hand over the cwd as `d:`.
  if (path.relative(dist, dest) !== 'supabase') {
    throw new Error(
      `Refusing to copy into ${dest}: the copy empties its destination, which must be the db dist folder's supabase/ (${path.join(dist, 'supabase')})`
    );
  }
  const stat = await fs.lstat(dest).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isDirectory()) {
    throw new Error(
      `Refusing to copy into ${dest}: it is ${stat.isSymbolicLink() ? 'a link' : 'not a folder'}, and the copy empties its destination`
    );
  }
  return dest;
}

/**
 * Whether `inner` is `outer` or lies inside it, as folders (`/a/bc` is not inside `/a/b`). On
 * Windows path.relative ignores case, and returns an absolute path for another drive, which is
 * apart. `pathModule` is the platform's path module; a test passes path.win32 or path.posix.
 */
function isSameOrInside(outer, inner, pathModule = path) {
  const relative = pathModule.relative(outer, inner);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative))
  );
}

/**
 * Where `target` really is: its real path, or, while it does not exist yet, its nearest existing
 * ancestor's real path with the rest appended (emptyDir creates a missing destination, and the
 * copy then writes into wherever that is).
 */
async function realLocation(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Throws unless the real source and the real destination are apart. resolveSupabaseDest reads the
 * destination as written, and a link above it (dist/, dist/libs/ or dist/libs/db/) can make it the
 * source, a folder around the source or one inside it: with dist/libs/db a junction into
 * libs/db/src, emptyDir wiped libs/db/src/supabase. This guards the copy step only: `nx build db`
 * runs `vite build` first, whose emptyOutDir empties dist/libs/db through such a link before the
 * copy starts (release-lib.js deletes dist/libs/db before it builds: a link there is unlinked, and
 * its target kept).
 */
async function refuseOverlap(source, dest) {
  const [realSource, realDest] = await Promise.all([realLocation(source), realLocation(dest)]);
  if (isSameOrInside(realSource, realDest) || isSameOrInside(realDest, realSource)) {
    throw new Error(
      `Refusing to copy into ${dest}: it is really ${realDest}, which overlaps the source (${realSource}), and the copy empties its destination; is a folder above it a link?`
    );
  }
}

/**
 * Makes `destDir` hold exactly SUPABASE_PACKAGE_ENTRIES from `sourceDir`, minus every dot entry.
 * The copy owns its destination, so it empties it first: a merge kept whatever an earlier step
 * left there. The db build's dts step wrote supabase/functions/nextblock-migration-ingest/index.d.ts
 * (the Deno edge function's declaration, until libs/db/vite.config.mts excluded src/supabase), and
 * verify-lib-dist.js check 13 then refused every db release; a stale build's CLI state or an
 * obsolete migration would have survived the same way. `options.distDir` is the db dist directory:
 * `destDir` must be its supabase/ (resolveSupabaseDest), and must not really be, hold or sit inside
 * the source (refuseOverlap). Throws, before touching the destination, when an entry is missing in
 * the source: without it a scaffold fails (config.toml, migrations/) or never gets its Auth emails
 * (templates/), and only the release gate would notice.
 */
async function copySupabaseAssets(sourceDir, destDir, { distDir } = {}) {
  if (typeof distDir !== 'string' || distDir === '') {
    throw new TypeError('copySupabaseAssets needs options.distDir, the db dist directory its destination sits in');
  }
  const source = path.resolve(sourceDir);
  const dest = await resolveSupabaseDest(destDir, distDir);

  for (const entry of SUPABASE_PACKAGE_ENTRIES) {
    const from = path.join(source, entry);
    if (!(await fs.pathExists(from))) {
      throw new Error(`${from} is missing: @nextblock-cms/db ships supabase/${entry} (SUPABASE_PACKAGE_ENTRIES)`);
    }
  }
  await refuseOverlap(source, dest);

  await fs.emptyDir(dest);
  for (const entry of SUPABASE_PACKAGE_ENTRIES) {
    // fs-extra calls the filter for the entry and everything below it, and skips a refused folder whole.
    await fs.copy(path.join(source, entry), path.join(dest, entry), {
      filter: (src) => shouldCopySupabaseEntry(path.relative(source, src)),
    });
  }
}

async function main() {
  const repoRoot = process.cwd();
  const [sourceArg, destArg] = process.argv.slice(2);
  const distDir = path.join(repoRoot, DB_DIST_DIR);
  const sourceDir = sourceArg ? path.resolve(repoRoot, sourceArg) : path.join(repoRoot, 'libs', 'db', 'src', 'supabase');
  const destDir = destArg ? path.resolve(repoRoot, destArg) : path.join(distDir, 'supabase');
  const basePkgPath = path.join(repoRoot, 'libs', 'db', 'package.json');
  const distPkgPath = path.join(distDir, 'package.json');

  // A missing source fails the build like a missing entry: the package is useless without it.
  await copySupabaseAssets(sourceDir, destDir, { distDir });
  console.log(`[copy-db-supabase] Emptied ${destDir} and copied ${SUPABASE_PACKAGE_ENTRIES.join(', ')} into it`);

  if (await fs.pathExists(distPkgPath)) {
    const distPkg = await fs.readJson(distPkgPath);
    const basePkg = (await fs.pathExists(basePkgPath)) ? await fs.readJson(basePkgPath) : {};
    const merged = {
      ...distPkg,
      files: Array.from(
        new Set([
          ...(distPkg.files || []),
          ...(basePkg.files || []),
          'supabase/**',
          '*.js',
          '*.cjs.js',
          '*.es.js',
          '*.mjs',
          '*.d.ts',
        ]),
      ),
    };
    await fs.writeJson(distPkgPath, merged, { spaces: 2 });
    console.log('[copy-db-supabase] Updated dist package.json to include supabase assets.');
  } else {
    console.warn(`[copy-db-supabase] dist package.json not found at ${distPkgPath}`);
  }
}

module.exports = { SUPABASE_PACKAGE_ENTRIES, shouldCopySupabaseEntry, copySupabaseAssets, isSameOrInside };

// Guarded so a test can require the filter without copying anything.
if (require.main === module) {
  main().catch((err) => {
    console.error('[copy-db-supabase] Failed to copy supabase assets:', err);
    process.exit(1);
  });
}
