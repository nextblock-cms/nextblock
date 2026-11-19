import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// CommonJS script; its CLI entry is guarded by `require.main`, so requiring it copies nothing.
const { SUPABASE_PACKAGE_ENTRIES, copySupabaseAssets, isSameOrInside, shouldCopySupabaseEntry } = require('./copy-db-supabase.cjs');

const SCRIPT = join(__dirname, 'copy-db-supabase.cjs');
const ROOT = join(__dirname, '..', '..');
const dirs: string[] = [];

/** A throwaway directory holding exactly `files` (relative path with `/` -> contents). */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'copy-db-supabase-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const file = join(dir, ...name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

/** Every file under `dir`, relative with `/`, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(join(dir, entry.name), relative) : [relative];
    })
    .sort();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// libs/db/src/supabase as a maintainer's checkout holds it once the Supabase CLI and local Studio
// have run there: what the package ships...
const SHIPPED_FILES: Record<string, string> = {
  'config.toml': 'project_id = "fixture"\n',
  'migrations/02001_baseline_schema.sql': 'select 1;\n',
  'migrations/02042_consent_cookie_settings_copy.sql': 'select 2;\n',
  'templates/magic_link.html': '<p>fixture</p>\n',
  'templates/recovery.html': '<p>fixture</p>\n',
};
// ...and what stays in the monorepo.
const NOT_SHIPPED: Record<string, string> = {
  // Local state with no dot segment, which the old denylist and check 12 both let through: local
  // Studio saves SQL snippets to snippets/ (read-write), `supabase gen signing-key` writes keys.
  'snippets/local.sql': '-- saved in local Studio\nselect * from auth.users;\n',
  'signing_keys.json': '[{"kty":"EC","d":"fixture"}]\n',
  'seed.sql': 'insert into fixture values (1);\n',
  // The maintainer-only migration-ingest edge function: deployed from libs/db/src, read by no consumer.
  'functions/import_map.json': '{}\n',
  'functions/nextblock-migration-ingest/index.ts': 'export {};\n',
  'functions/.env.example': 'MIGRATION_INGEST_BEARER=\n',
  // Dot entries at the top and inside the shipped folders: the CLI's state, ignore files, env files.
  '.gitignore': '.branches\n.temp\n',
  '.temp/project-ref': 'fixture-ref\n',
  '.temp/start-secrets': 'fixture-secret\n',
  '.branches/_current_branch': 'fixture\n',
  '.env': 'FIXTURE_KEY=secret\n',
  '.env.example': 'FIXTURE_KEY=\n',
  'migrations/.temp/cli-latest': 'fixture\n',
  'migrations/.gitignore': '*.local.sql\n',
  'templates/.gitignore': 'drafts/\n',
  'templates/drafts/.env.local': 'FIXTURE_KEY=secret\n',
};
const SUPABASE = { ...SHIPPED_FILES, ...NOT_SHIPPED };
const SHIPPED = Object.keys(SHIPPED_FILES).sort();
// What dist/libs/db/supabase can hold before the copy runs: the db build's dts step declared the
// Deno edge function there (vite-plugin-dts emits every file tsconfig.lib.json includes), and an
// earlier build or step can leave the CLI's state and a migration removed upstream.
const STALE: Record<string, string> = {
  'functions/nextblock-migration-ingest/index.d.ts': 'export {};\n',
  '.temp/project-ref': 'stale-ref\n',
  'snippets/old.sql': 'select * from auth.users;\n',
  'migrations/02099_obsolete.sql': 'select 99;\n',
  'config.toml': 'project_id = "stale"\n',
};

/** A throwaway db dist directory holding `files`, and the supabase/ folder the copy owns inside it. */
function distFolder(files: Record<string, string> = {}) {
  const distDir = tree(files);
  return { distDir, dest: join(distDir, 'supabase') };
}

describe('SUPABASE_PACKAGE_ENTRIES', () => {
  it('is what the consumers read from the installed package: config.toml, migrations/ and templates/', () => {
    expect([...SUPABASE_PACKAGE_ENTRIES]).toEqual(['config.toml', 'migrations', 'templates']);

    const read = (file: string) => readFileSync(join(ROOT, ...file.split('/')), 'utf8');
    const named = (file: string, pattern: RegExp) => [...read(file).matchAll(pattern)].map((match) => match[1]);
    // Each pattern must keep finding its reads: rename the variable and the test fails, not passes.
    const reads = {
      // create-nextblock's ensureSupabaseAssets copies them into every new project.
      cli: named('apps/create-nextblock/bin/create-nextblock.js', /resolve\(packageSupabaseDir, '([^']+)'\)/g),
      // npm run update's refreshProjectMigrations.
      update: named('apps/nextblock/tools/update.mjs', /path\.join\(packageDir, '([^']+)'\)/g),
      // The build hook's packageMigrationsDir, in node_modules/@nextblock-cms/db.
      migrateCore: named('apps/nextblock/tools/lib/migrate-core.mjs', /path\.join\('supabase', '([^']+)'\)/g),
    };
    for (const [consumer, entries] of Object.entries(reads)) expect(entries.length, consumer).toBeGreaterThan(0);
    // Everything a consumer reads ships, and nothing ships that no consumer reads (functions/ does not).
    expect(new Set(Object.values(reads).flat())).toEqual(new Set(SUPABASE_PACKAGE_ENTRIES));
  });
});

describe('shouldCopySupabaseEntry', () => {
  it('keeps config.toml, migrations/ and templates/, at any depth and with either separator', () => {
    for (const path of [
      '',
      'config.toml',
      'migrations',
      'migrations/02001_baseline_schema.sql',
      'migrations\\02042_consent_cookie_settings_copy.sql',
      'templates',
      'templates/magic_link.html',
      'templates/partials/footer.html',
    ]) {
      expect(shouldCopySupabaseEntry(path), path).toBe(true);
    }
  });

  it("refuses every other top-level entry: local Studio's snippets/, signing_keys.json, seed files, functions/", () => {
    for (const path of ['snippets', 'snippets/local.sql', 'signing_keys.json', 'seed.sql', 'functions', 'functions/import_map.json']) {
      expect(shouldCopySupabaseEntry(path), path).toBe(false);
    }
  });

  it('refuses a dot entry at any depth, an .env.example included (check 12 refuses it in the tarball)', () => {
    for (const path of [
      '.temp',
      '.branches',
      '.gitignore',
      '.env',
      '.env.example',
      'migrations/.temp',
      'migrations/.temp/cli-latest',
      'migrations\\.gitignore',
      'templates/.gitignore',
      'templates/drafts/.env.local',
    ]) {
      expect(shouldCopySupabaseEntry(path), path).toBe(false);
    }
  });
});

describe('isSameOrInside (how refuseOverlap compares the real source and destination)', () => {
  it('reads Windows paths as folders: case aside, a shared prefix is apart, and so is another drive', () => {
    const cases: Array<[string, string, boolean]> = [
      ['C:\\a', 'C:\\a', true],
      ['C:\\a', 'c:\\A\\b', true], // path.relative ignores case on Windows
      ['C:\\a', 'C:\\a\\..b', true], // a folder whose name starts with two dots is inside
      ['C:\\a\\b', 'C:\\a', false],
      ['C:\\a', 'C:\\ab', false],
      // path.relative returns the other drive's path, absolute: the folders are apart.
      ['C:\\a', 'D:\\a\\b', false],
      ['C:\\a', 'D:\\a', false],
    ];
    for (const [outer, inner, inside] of cases) expect(isSameOrInside(outer, inner, win32), `${outer} | ${inner}`).toBe(inside);
  });

  it('reads POSIX paths as folders', () => {
    const cases: Array<[string, string, boolean]> = [
      ['/a', '/a', true],
      ['/a', '/a/b', true],
      ['/a', '/a/..b', true],
      ['/a/b', '/a', false],
      ['/a', '/ab', false],
      ['/a', '/A/b', false], // case counts on POSIX
    ];
    for (const [outer, inner, inside] of cases) expect(isSameOrInside(outer, inner, posix), `${outer} | ${inner}`).toBe(inside);
  });
});

// Several cases start the copy script in a child node process (execFileSync): under 1.2 s alone, past
// vitest's 5 s default in a loaded full run (2026-11-19), so the block gets room.
describe('copySupabaseAssets', { timeout: 30_000 }, () => {
  it('copies config.toml, migrations/ and templates/ and nothing else: no local state, no dot entry at any depth', async () => {
    const source = tree(SUPABASE);
    const { distDir, dest } = distFolder();

    await copySupabaseAssets(source, dest, { distDir });

    expect(listFiles(dest)).toEqual(SHIPPED);
    for (const name of Object.keys(NOT_SHIPPED)) expect(existsSync(join(dest, ...name.split('/'))), name).toBe(false);
    // A refused folder is skipped whole, not created empty.
    expect(readdirSync(dest).sort()).toEqual(['config.toml', 'migrations', 'templates']);
    expect(existsSync(join(dest, 'migrations', '.temp'))).toBe(false);
  });

  it('owns its destination: empties what an earlier build left there (the dts output for functions/, CLI state, an obsolete migration)', async () => {
    const source = tree(SUPABASE);
    // The rest of the db dist folder is the Vite build's, and stays.
    const { distDir, dest } = distFolder({
      'package.json': '{"name":"@nextblock-cms/db"}\n',
      'index.d.ts': 'export {};\n',
      ...Object.fromEntries(Object.entries(STALE).map(([name, text]) => [`supabase/${name}`, text])),
    });

    await copySupabaseAssets(source, dest, { distDir });

    expect(listFiles(dest)).toEqual(SHIPPED);
    expect(readFileSync(join(dest, 'config.toml'), 'utf8')).toBe(SHIPPED_FILES['config.toml']);
    expect(listFiles(distDir)).toEqual(['index.d.ts', 'package.json', ...SHIPPED.map((name) => `supabase/${name}`)]);
  });

  it('fails, before touching the destination, when one of them is missing (a scaffold refuses a package without config.toml or migrations/)', async () => {
    for (const missing of SUPABASE_PACKAGE_ENTRIES) {
      const source = tree(Object.fromEntries(Object.entries(SHIPPED_FILES).filter(([name]) => name.split('/')[0] !== missing)));
      const { distDir, dest } = distFolder({ 'supabase/migrations/02001_baseline_schema.sql': 'select 1;\n' });
      await expect(copySupabaseAssets(source, dest, { distDir }), missing).rejects.toThrow(
        `@nextblock-cms/db ships supabase/${missing}`
      );
      expect(listFiles(dest), missing).toEqual(['migrations/02001_baseline_schema.sql']);
    }
  });

  it("refuses, and empties nothing, unless the destination is the db dist folder's supabase/", async () => {
    const checkout = tree(Object.fromEntries(Object.entries(SUPABASE).map(([name, text]) => [`src/supabase/${name}`, text])));
    const source = join(checkout, 'src', 'supabase');
    const { distDir } = distFolder({ 'package.json': '{}\n', 'lib/supabase/types.d.ts': 'export {};\n' });
    const sibling = join(distDir, '..', `${basename(distDir)}-sibling`, 'supabase');
    mkdirSync(sibling, { recursive: true });
    dirs.push(dirname(sibling));
    writeFileSync(join(sibling, 'keep.txt'), 'keep\n');
    const before = listFiles(source);

    for (const wrong of [
      source, // the source folder itself: also named supabase, outside the dist folder
      distDir, // the whole dist folder
      join(distDir, 'lib', 'supabase'), // a supabase/ deeper in it
      join(distDir, 'migrations'), // another name directly inside it
      sibling, // a supabase/ beside it
    ]) {
      await expect(copySupabaseAssets(source, wrong, { distDir }), wrong).rejects.toThrow(/^Refusing to copy into /);
    }
    // No distDir to check the destination against: refused too.
    await expect(copySupabaseAssets(source, join(distDir, 'supabase'))).rejects.toThrow(TypeError);

    expect(listFiles(source)).toEqual(before);
    expect(listFiles(distDir)).toEqual(['lib/supabase/types.d.ts', 'package.json']);
    expect(listFiles(sibling)).toEqual(['keep.txt']);
  });

  it('refuses a destination that is a link: emptying it would empty the folder it points at', async () => {
    const source = tree(SUPABASE);
    const target = tree({ 'migrations/02001_baseline_schema.sql': 'select 1;\n' });
    const { distDir, dest } = distFolder();
    // A junction on Windows (no privilege needed); the type is ignored elsewhere.
    symlinkSync(target, dest, 'junction');

    await expect(copySupabaseAssets(source, dest, { distDir })).rejects.toThrow(/^Refusing to copy into .*: it is a link/);
    expect(listFiles(target)).toEqual(['migrations/02001_baseline_schema.sql']);
  });

  it('refuses a destination that a link above it makes the source, a folder holding it or one inside it, and the source survives', async () => {
    // The destination as written is <distDir>/supabase, which resolveSupabaseDest accepts; distDir is a
    // junction (no privilege needed on Windows) to each target below.
    const cases: Array<{ name: string; source: string; target: (root: string, source: string) => string }> = [
      // dist/libs/db -> libs/db/src: emptying the destination emptied libs/db/src/supabase.
      { name: 'the source', source: 'libs/db/src/supabase', target: (_root, source) => dirname(source) },
      { name: 'a folder holding the source', source: 'supabase/libs/db/src/supabase', target: (root) => root },
      // templates/supabase/ exists in the source (below): emptying it would delete source files.
      { name: 'a folder inside the source', source: 'libs/db/src/supabase', target: (_root, source) => join(source, 'templates') },
      // migrations/supabase/ does not exist: emptyDir would create it and the copy write into the source.
      { name: 'a missing folder inside the source', source: 'libs/db/src/supabase', target: (_root, source) => join(source, 'migrations') },
    ];

    for (const { name, source: sourcePath, target } of cases) {
      const root = tree(
        Object.fromEntries(
          Object.entries({ ...SHIPPED_FILES, 'templates/supabase/partial.html': '<p>fixture</p>\n' }).map(([file, text]) => [
            `${sourcePath}/${file}`,
            text,
          ])
        )
      );
      const source = join(root, ...sourcePath.split('/'));
      const distDir = join(tree({}), 'db');
      symlinkSync(target(root, source), distDir, 'junction');
      const before = listFiles(root);

      await expect(copySupabaseAssets(source, join(distDir, 'supabase'), { distDir }), name).rejects.toThrow(
        /^Refusing to copy into .*: it is really .*, which overlaps the source /
      );
      expect(listFiles(root), name).toEqual(before);
      expect(existsSync(join(source, 'migrations', 'supabase')), name).toBe(false);
    }
  });

  // os.tmpdir() can be spelled with 8.3 short names (C:\Users\LONGNA~1\...), which only the OS realpath
  // expands to the long ones a link written by realpathSync.native holds; where the two spellings agree
  // there is nothing to compare.
  it.skipIf(realpathSync.native(tmpdir()) === tmpdir())(
    'refuses a link above it whose target is spelled with long names, for a source spelled with 8.3 short names, and the source survives',
    async () => {
      const root = tree(Object.fromEntries(Object.entries(SHIPPED_FILES).map(([name, text]) => [`libs/db/src/supabase/${name}`, text])));
      const source = join(root, 'libs', 'db', 'src', 'supabase'); // os.tmpdir()'s spelling
      const longSrc = realpathSync.native(dirname(source));
      expect(longSrc).not.toBe(dirname(source));
      // dist/libs/db -> libs/db/src, as in the case above, with the target in its long spelling.
      const distDir = join(tree({}), 'db');
      symlinkSync(longSrc, distDir, 'junction');

      await expect(copySupabaseAssets(source, join(distDir, 'supabase'), { distDir })).rejects.toThrow(
        /^Refusing to copy into .*: it is really .*, which overlaps the source /
      );
      expect(listFiles(source)).toEqual(SHIPPED);
    }
  );

  it('copies from a folder whose path merely starts like the destination\'s: overlap is containment, not a shared prefix', async () => {
    // supabase-src beside supabase: as strings, one path starts with the other; as folders, they are apart.
    const { distDir, dest } = distFolder(
      Object.fromEntries(Object.entries(SHIPPED_FILES).map(([name, text]) => [`supabase-src/${name}`, text]))
    );
    const source = join(distDir, 'supabase-src');

    await copySupabaseAssets(source, dest, { distDir });

    expect(listFiles(dest)).toEqual(SHIPPED);
    expect(listFiles(source)).toEqual(SHIPPED);
  });

  it('runs as the db build step: empties dist/libs/db/supabase, copies into it and merges "files" into the dist manifest', () => {
    // A scratch workspace: the script resolves every default path against its cwd. dist/libs/db
    // holds what the Vite step wrote, the edge function's declaration under supabase/ included.
    const workspace = tree({
      ...Object.fromEntries(Object.entries(SUPABASE).map(([name, text]) => [`libs/db/src/supabase/${name}`, text])),
      'libs/db/package.json': JSON.stringify({ name: '@nextblock-cms/db', files: ['dist', 'supabase'] }),
      'dist/libs/db/package.json': JSON.stringify({ name: '@nextblock-cms/db', files: ['lib', '*.js'] }),
      'dist/libs/db/index.d.ts': 'export {};\n',
      ...Object.fromEntries(Object.entries(STALE).map(([name, text]) => [`dist/libs/db/supabase/${name}`, text])),
    });

    execFileSync(process.execPath, [SCRIPT, 'libs/db/src/supabase', 'dist/libs/db/supabase'], {
      cwd: workspace,
      stdio: 'pipe',
    });

    expect(listFiles(join(workspace, 'dist', 'libs', 'db', 'supabase'))).toEqual(SHIPPED);
    expect(existsSync(join(workspace, 'dist', 'libs', 'db', 'index.d.ts'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(workspace, 'dist', 'libs', 'db', 'package.json'), 'utf8'));
    expect(manifest.files).toEqual(['lib', '*.js', 'dist', 'supabase', 'supabase/**', '*.cjs.js', '*.es.js', '*.mjs', '*.d.ts']);
  });

  it('refuses a destination argument other than dist/libs/db/supabase, and the source and dist survive', () => {
    const workspace = tree({
      ...Object.fromEntries(Object.entries(SHIPPED_FILES).map(([name, text]) => [`libs/db/src/supabase/${name}`, text])),
      'dist/libs/db/package.json': JSON.stringify({ name: '@nextblock-cms/db', files: ['lib'] }),
    });

    for (const wrong of ['libs/db/src/supabase', 'dist/libs/db', 'dist/libs/supabase']) {
      let stderr = '';
      try {
        execFileSync(process.execPath, [SCRIPT, 'libs/db/src/supabase', wrong], { cwd: workspace, stdio: 'pipe' });
      } catch (error) {
        stderr = String((error as { stderr?: Buffer }).stderr ?? '');
      }
      expect(stderr, wrong).toContain('Refusing to copy into');
    }

    expect(listFiles(join(workspace, 'libs', 'db', 'src', 'supabase'))).toEqual(SHIPPED);
    expect(listFiles(join(workspace, 'dist'))).toEqual(['libs/db/package.json']);
  });

  it('refuses to run when dist/libs/db is a link into libs/db/src, and the source survives', () => {
    const workspace = tree(
      Object.fromEntries(Object.entries(SHIPPED_FILES).map(([name, text]) => [`libs/db/src/supabase/${name}`, text]))
    );
    mkdirSync(join(workspace, 'dist', 'libs'), { recursive: true });
    symlinkSync(join(workspace, 'libs', 'db', 'src'), join(workspace, 'dist', 'libs', 'db'), 'junction');

    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT, 'libs/db/src/supabase', 'dist/libs/db/supabase'], { cwd: workspace, stdio: 'pipe' });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    }

    expect(stderr).toMatch(/Refusing to copy into .*: it is really .*, which overlaps the source /);
    expect(listFiles(join(workspace, 'libs', 'db', 'src', 'supabase'))).toEqual(SHIPPED);
  });

  it('fails the db build when the source lacks a shipped entry, instead of warning', () => {
    const workspace = tree({ 'libs/db/src/supabase/config.toml': 'project_id = "fixture"\n' });

    expect(() =>
      execFileSync(process.execPath, [SCRIPT, 'libs/db/src/supabase', 'dist/libs/db/supabase'], { cwd: workspace, stdio: 'pipe' })
    ).toThrow(/ships supabase\/migrations/);
  });
});
