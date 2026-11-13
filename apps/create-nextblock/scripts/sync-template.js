#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import chalk from 'chalk';
import { STANDALONE_ESLINT_CONFIG } from '../bin/lib/eslint-config.js';
import { retryTransientFsErrors } from './lib/fs-retry.js';
import { findTemplateProblems } from './lib/template-check.js';
import { shouldSyncTemplateDoc } from './lib/template-docs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const SOURCE_DIR = resolve(PROJECT_ROOT, '../nextblock');
const TARGET_DIR = resolve(PROJECT_ROOT, 'templates/nextblock-template');
const REPO_ROOT = resolve(PROJECT_ROOT, '..', '..');
const ROOT_DOCS_DIR = resolve(REPO_ROOT, 'docs');
const ROOT_PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
// Hand-maintained standalone Docker assets (Dockerfile, docker-compose.yml, docker/**, the
// zero-dep scripts/docker-setup.mjs) that ship into every generated project for Docker mode.
const DOCKER_TEMPLATE_DIR = resolve(PROJECT_ROOT, 'docker-template');
const UI_GLOBALS_SOURCE = resolve(
  PROJECT_ROOT,
  '../../libs/ui/src/styles/globals.css',
);
const UI_PROXY_MODULES = [
  'avatar',
  'badge',
  'button',
  'card',
  'checkbox',
  'ColorPicker',
  'ConfirmationDialog',
  'CustomSelectWithInput',
  'dialog',
  'dropdown-menu',
  'input',
  'label',
  'popover',
  'progress',
  'select',
  'separator',
  'Skeleton',
  'table',
  'textarea',
  'tooltip',
  'ui',
];

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'tmp',
  'coverage',
  'backup',
  'backups',
  '.nextblock-backup',
]);

async function ensureTemplateSync() {
  const sourceExists = await fs.pathExists(SOURCE_DIR);
  if (!sourceExists) {
    throw new Error(
      `Source project not found at ${SOURCE_DIR}. Please ensure apps/nextblock exists before syncing.`,
    );
  }

  console.log(
    chalk.blue(
      `Syncing template from ${chalk.bold(relative(PROJECT_ROOT, SOURCE_DIR))} to ${chalk.bold(
        relative(PROJECT_ROOT, TARGET_DIR),
      )}`,
    ),
  );

  // A file this sync wrote a moment ago can still be locked by a scanner or an editor on Windows
  // (scripts/lib/fs-retry.js). Every step is idempotent, so a step that hits a lock runs again
  // whole instead of leaving a half-built template behind.
  const retry = (label, action) =>
    retryTransientFsErrors(label, action, { log: (message) => console.log(chalk.yellow(message)) });

  await fs.ensureDir(TARGET_DIR);
  await retry('Emptying the template', () => emptyDirOneEntryAtATime(TARGET_DIR));

  await retry('Copying apps/nextblock', () =>
    fs.copy(SOURCE_DIR, TARGET_DIR, {
      dereference: true,
      filter: (src) => {
        const rel = relative(SOURCE_DIR, src);
        if (!rel) {
          return true;
        }

        const segments = rel.split(sep);
        return segments.every((segment) => !IGNORED_SEGMENTS.has(segment));
      },
    }),
  );

  const steps = [
    ensureEnvExample,
    ensureTemplateGitignore,
    ensureGlobalStyles,
    ensureClientTranslations,
    ensureDocsSync,
    sanitizeBlockEditorImports,
    sanitizeUiImports,
    ensureUiProxies,
    removeBackups,
    syncPackageVersions,
    ensureStandaloneEslintConfig,
    ensureDockerAssets,
    removeTemplateProjectJson,
    removeBuildArtifacts,
    markTemplateAsStandalone,
    ensureTemplateReadme,
  ];
  for (const step of steps) {
    await retry(step.name, step);
  }

  // `npm publish` runs this sync in prepack, so a template that falls short of what the steps
  // promise stops the publish here, before anything reaches npm (scripts/lib/template-check.js).
  const problems = await findTemplateProblems(TARGET_DIR, {
    uiProxyModules: UI_PROXY_MODULES,
    standaloneEslintConfig: STANDALONE_ESLINT_CONFIG,
    dockerTemplateDir: DOCKER_TEMPLATE_DIR,
  });
  if (problems.length > 0) {
    throw new Error(`The synced template is incomplete:\n  - ${problems.join('\n  - ')}`);
  }

  console.log(chalk.green('Template sync complete.'));
}

// fs-extra's emptyDir starts every removal at once and rejects on the first failure while the
// rest keep running, so a retry would race them. One entry at a time, with Node's own per-path
// retries (EBUSY, ENOTEMPTY, EPERM), leaves nothing running behind a failed attempt.
async function emptyDirOneEntryAtATime(dir) {
  for (const entry of await fs.readdir(dir)) {
    await rm(resolve(dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * The app's eslint.config.mjs only loads inside the monorepo (it imports @nx/eslint-plugin and a
 * ../../ root config). The CLI replaces it at scaffold time, but `npm run update` copies and
 * 3-way-merges framework files from THIS template, so the template must carry the same standalone
 * config: otherwise every update puts the unloadable monorepo config back, and a release that
 * edits the app's config conflicts in a file the user never touched.
 */
async function ensureStandaloneEslintConfig() {
  await fs.writeFile(resolve(TARGET_DIR, 'eslint.config.mjs'), STANDALONE_ESLINT_CONFIG);
}

async function ensureEnvExample() {
  const envTargets = [
    resolve(REPO_ROOT, '.env.example'),
    resolve(REPO_ROOT, '.env.exemple'),
    resolve(SOURCE_DIR, '.env.example'),
    resolve(SOURCE_DIR, '.env.exemple'),
  ];

  const destination = resolve(TARGET_DIR, '.env.example');

  for (const envPath of envTargets) {
    if (await fs.pathExists(envPath)) {
      await fs.copy(envPath, destination);
      return;
    }
  }

  const placeholder = `# Environment variables for NextBlock™ CMS
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
NEXT_PUBLIC_URL=http://localhost:3000
`;

  await fs.writeFile(destination, placeholder);
}

async function ensureDocsSync() {
  const destination = resolve(TARGET_DIR, 'docs');
  console.log(
    chalk.blue(
      `Syncing docs from ${chalk.bold(relative(PROJECT_ROOT, ROOT_DOCS_DIR))}`,
    ),
  );

  await fs.emptyDir(destination);
  // Internal build prompts (docs/prompts) stay in the monorepo: see scripts/lib/template-docs.js.
  await fs.copy(ROOT_DOCS_DIR, destination, {
    dereference: true,
    filter: (src) => shouldSyncTemplateDoc(src, ROOT_DOCS_DIR),
  });
}

async function ensureTemplateGitignore() {
  const destination = resolve(TARGET_DIR, 'gitignore'); // Rename to gitignore
  const content = `.DS_Store
node_modules
dist
.next
out
build
coverage
*.log
logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

.env
.env.*
.env.local
.env.development.local
.env.production.local
.env.test.local

.vscode
.idea
.swp
*.sw?

supabase/.temp
supabase/.branches

# Local safety copies written by \`npm run update\` when it replaces a framework file.
.nextblock-backup/

# Coding-agent MCP client configs written by \`create-nextblock --non-interactive\`.
# They carry the instance's MCP bearer token verbatim, so they must never be committed.
.mcp.json
.cursor/mcp.json
.claude/settings.local.json
`;
  await fs.outputFile(destination, content);
}

async function ensureGlobalStyles() {
  const destination = resolve(TARGET_DIR, 'app/globals.css');

  if (await fs.pathExists(destination)) {
    await fs.remove(destination);
  }

  if (await fs.pathExists(UI_GLOBALS_SOURCE)) {
    await fs.copy(UI_GLOBALS_SOURCE, destination);
    return;
  }

  const fallback = `@tailwind base;
@tailwind components;
@tailwind utilities;
`;

  await fs.outputFile(destination, fallback);
}

async function ensureClientTranslations() {
  const providersPath = resolve(TARGET_DIR, 'app/providers.tsx');
  if (!(await fs.pathExists(providersPath))) {
    return;
  }

  let content = await fs.readFile(providersPath, 'utf8');
  const wrapperImportPath = '@nextblock-cms/utils';
  const wrapperImportStatement = `import { TranslationsProvider } from '${wrapperImportPath}';`;
  const existingImportRegex =
    /import\s+\{\s*TranslationsProvider\s*\}\s*from\s*['"]@nextblock-cms\/utils['"];?/;
  const legacyImportRegex =
    /import\s+\{\s*TranslationsProvider\s*\}\s*from\s*['"]@\/lib\/client-translations['"];?/;

  if (existingImportRegex.test(content) || legacyImportRegex.test(content)) {
    content = content
      .replace(existingImportRegex, wrapperImportStatement)
      .replace(legacyImportRegex, wrapperImportStatement);
  } else if (!content.includes(wrapperImportStatement)) {
    const lines = content.split(/\r?\n/);
    const insertIndex =
      lines.findIndex((line) => line.startsWith('import')) + 1;
    if (insertIndex > 0) {
      lines.splice(insertIndex, 0, wrapperImportStatement);
      content = lines.join('\n');
    } else {
      content = `${wrapperImportStatement}\n${content}`;
    }
  }

  await fs.writeFile(providersPath, content);

  const wrapperPath = resolve(TARGET_DIR, 'lib/client-translations.tsx');
  if (await fs.pathExists(wrapperPath)) {
    await fs.remove(wrapperPath);
  }
}

async function sanitizeBlockEditorImports() {
  const blockEditorPath = resolve(
    TARGET_DIR,
    'app/cms/blocks/components/BlockEditorArea.tsx',
  );
  if (!(await fs.pathExists(blockEditorPath))) {
    return;
  }

  const replacements = [
    { pattern: /(\.\.\/editors\/[A-Za-z0-9_-]+)\.js/g, replacement: '$1.tsx' },
    { pattern: /(\.\.\/actions)\.js/g, replacement: '$1.ts' },
  ];

  const content = await fs.readFile(blockEditorPath, 'utf8');
  let updated = content;

  for (const { pattern, replacement } of replacements) {
    updated = updated.replace(pattern, replacement);
  }

  if (updated !== content) {
    await fs.writeFile(blockEditorPath, updated);
  }
}

async function sanitizeUiImports() {
  const searchDirs = ['app', 'components', 'context', 'lib'];
  const validExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const filesToProcess = [];

  for (const relativeDir of searchDirs) {
    const absoluteDir = resolve(TARGET_DIR, relativeDir);
    if (await fs.pathExists(absoluteDir)) {
      await collectFiles(absoluteDir, filesToProcess, validExtensions);
    }
  }

  for (const filePath of filesToProcess) {
    const original = await fs.readFile(filePath, 'utf8');
    const replaced = original.replace(
      /@nextblock-cms\/ui\/(?!styles\/)[A-Za-z0-9/_-]+/g,
      '@nextblock-cms/ui',
    );

    if (replaced !== original) {
      await fs.writeFile(filePath, replaced);
    }
  }
}

async function collectFiles(directory, accumulator, extensions) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, accumulator, extensions);
    } else {
      const dotIndex = entry.name.lastIndexOf('.');
      if (dotIndex !== -1) {
        const ext = entry.name.slice(dotIndex);
        if (extensions.has(ext)) {
          accumulator.push(fullPath);
        }
      }
    }
  }
}

async function ensureUiProxies() {
  const proxiesDir = resolve(TARGET_DIR, 'lib/ui');
  await fs.ensureDir(proxiesDir);

  const proxyContent = "export * from '@nextblock-cms/ui';\n";

  for (const moduleName of UI_PROXY_MODULES) {
    const proxyPath = resolve(proxiesDir, `${moduleName}.ts`);
    if (!(await fs.pathExists(proxyPath))) {
      await fs.outputFile(proxyPath, proxyContent);
    }
  }
}

async function removeBackups() {
  const targets = [
    resolve(TARGET_DIR, 'backup'),
    resolve(TARGET_DIR, 'backups'),
  ];

  // fs.remove ignores a missing path; any other failure reaches the step retry.
  await Promise.all(targets.map((dir) => fs.remove(dir)));
}

async function removeTemplateProjectJson() {
  const projectJsonPath = resolve(TARGET_DIR, 'project.json');
  await fs.remove(projectJsonPath);
}

// The wholesale copy of apps/nextblock brings its README, which is written for the MONOREPO:
// it tells the reader to run `npx nx serve nextblock` (a script a scaffolded project does not
// have) and links to `../../docs/*` (paths that do not exist outside the repo). Replace it
// with one written for the project the CLI actually produces.
async function ensureTemplateReadme() {
  const content = `# NextBlock

Your NextBlock site — a standalone Next.js app with the CMS, block editor and storefront
built in. Everything here is yours to edit.

## Everyday commands

\`\`\`bash
npm run dev             # start the dev server on http://localhost:3000
npm run build           # production build (applies pending migrations first)
npm start               # serve the production build
npm run lint            # lint
\`\`\`

## Keeping NextBlock up to date

\`\`\`bash
npm run update              # code + dependencies + database schema, in one step
npm run update -- --check   # show what would change; write nothing
\`\`\`

New framework code comes from the published \`create-nextblock\` package and is applied as a
**git 3-way merge**, so edits you made to NextBlock's own files are preserved — only a change
that genuinely overlaps yours conflicts, with the usual \`<<<<<<<\` markers. Your own pages,
components, content and \`.env\` are never touched.

If a merge does conflict, the update finishes the code and dependency work and **stops before
touching the database**. Fix the conflicts, then run \`npm run update\` again to apply the
migrations — or \`git reset --hard HEAD\` to back the whole update out. Either way the database
is untouched until you say so.

Commit your work before updating: a clean git tree is what lets you review the result with
\`git diff\` and undo it with \`git reset\`.

Full details: [docs/13-STAYING-UP-TO-DATE.md](./docs/13-STAYING-UP-TO-DATE.md).

## Running the whole stack locally with Docker

\`\`\`bash
npm run docker:setup    # first run: generate .env, build, and start everything
npm run docker:up       # rebuild and restart (also applies pending migrations)
npm run docker:down     # stop (your data persists in Docker volumes)
npm run docker:logs     # follow the app logs
\`\`\`

On a Docker install, run \`npm run update\` and then \`npm run docker:up\` — the stack applies
the migrations itself.

## Documentation

The \`docs/\` folder ships with your project:

- [01-PROJECT-OVERVIEW.md](./docs/01-PROJECT-OVERVIEW.md) — how the pieces fit together
- [03-CMS-AND-EDITOR.md](./docs/03-CMS-AND-EDITOR.md) — the editor and block system
- [04-DATABASE-AND-AUTH.md](./docs/04-DATABASE-AND-AUTH.md) — schema, auth and migrations
- [10-CUSTOM-BLOCKS.md](./docs/10-CUSTOM-BLOCKS.md) — building your own blocks
- [13-STAYING-UP-TO-DATE.md](./docs/13-STAYING-UP-TO-DATE.md) — updating
`;
  await fs.outputFile(resolve(TARGET_DIR, 'README.md'), content);
}

// apps/nextblock/package.json declares `nextblock.install = "monorepo"` — the marker that
// tells the runtime the upstream-sync GitHub Action can work here, because the repository IS
// the monorepo. The template is the flattened standalone app, where that Action would merge
// apps/ + libs/ + nx.json into a tree that has none of them, so the marker must be flipped.
// The CLI also sets this at scaffold time; doing it here as well means the template is
// correct on its own, and the value is never wrong for even one step of the pipeline.
async function markTemplateAsStandalone() {
  const pkgPath = resolve(TARGET_DIR, 'package.json');
  if (!(await fs.pathExists(pkgPath))) return;
  const pkg = await fs.readJSON(pkgPath);
  pkg.nextblock = { ...(pkg.nextblock ?? {}), install: 'standalone' };
  await fs.writeJSON(pkgPath, pkg, { spaces: 2 });
}

// Build artifacts that the wholesale copy of apps/nextblock drags along. tsconfig.tsbuildinfo
// alone is ~3.7 MB of incremental-compile state that is meaningless outside the monorepo, and
// it shipped in the published CLI tarball and in every scaffolded project.
async function removeBuildArtifacts() {
  const targets = ['tsconfig.tsbuildinfo', '.DS_Store', 'Thumbs.db'];
  await Promise.all(targets.map((name) => fs.remove(resolve(TARGET_DIR, name))));
}

// Copy the standalone Docker assets into the template and register the docker:* npm scripts so a
// generated project can run `npm run docker:setup` for the one-click local self-hosted sandbox.
async function ensureDockerAssets() {
  if (!(await fs.pathExists(DOCKER_TEMPLATE_DIR))) {
    return;
  }

  console.log(chalk.blue('Adding Docker self-hosted assets to the template'));
  await fs.copy(DOCKER_TEMPLATE_DIR, TARGET_DIR, {
    overwrite: true,
    dereference: true,
  });

  const pkgPath = resolve(TARGET_DIR, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJson(pkgPath);
    pkg.scripts = pkg.scripts || {};
    pkg.scripts['docker:setup'] = 'node scripts/docker-setup.mjs';
    pkg.scripts['docker:up'] = 'docker compose up -d --build';
    pkg.scripts['docker:down'] = 'docker compose down';
    pkg.scripts['docker:logs'] = 'docker compose logs -f nextblock-cms';
    await fs.writeJson(pkgPath, pkg, { spaces: 2 });
  }
}

async function syncPackageVersions() {
  const targetPackageJsonPath = resolve(TARGET_DIR, 'package.json');
  const sourcePackageJsonPath = resolve(SOURCE_DIR, 'package.json');

  if (!(await fs.pathExists(targetPackageJsonPath))) return;
  if (!(await fs.pathExists(ROOT_PACKAGE_JSON))) return;
  if (!(await fs.pathExists(sourcePackageJsonPath))) return;

  const rootPkg = await fs.readJson(ROOT_PACKAGE_JSON);
  const sourcePkg = await fs.readJson(sourcePackageJsonPath);
  const targetPkg = await fs.readJson(targetPackageJsonPath);

  let modified = false;

  const getVersion = (pkgName, sourceVersion) => {
    if (rootPkg.dependencies && rootPkg.dependencies[pkgName]) {
      return rootPkg.dependencies[pkgName];
    }
    if (rootPkg.devDependencies && rootPkg.devDependencies[pkgName]) {
      return rootPkg.devDependencies[pkgName];
    }
    return sourceVersion;
  };

  const processSection = (sectionName) => {
    if (!sourcePkg[sectionName]) return;
    targetPkg[sectionName] = targetPkg[sectionName] || {};

    for (const [pkgName, sourceVersion] of Object.entries(
      sourcePkg[sectionName],
    )) {
      if (sourceVersion.startsWith('workspace:')) {
        targetPkg[sectionName][pkgName] = 'workspace:*';
        continue;
      }
      const versionToUse = getVersion(pkgName, sourceVersion);
      if (targetPkg[sectionName][pkgName] !== versionToUse) {
        targetPkg[sectionName][pkgName] = versionToUse;
        modified = true;
      }
    }
  };

  processSection('dependencies');
  processSection('devDependencies');

  const criticalDevDeps = [
    'tailwindcss',
    'postcss',
    'autoprefixer',
    'typescript',
    '@tailwindcss/postcss',
  ];

  criticalDevDeps.forEach((pkg) => {
    const ver = getVersion(pkg, null);
    if (ver) {
      targetPkg.devDependencies = targetPkg.devDependencies || {};
      if (targetPkg.devDependencies[pkg] !== ver) {
        targetPkg.devDependencies[pkg] = ver;
        modified = true;
      }
    }
  });

  if (modified) {
    console.log(
      chalk.green(
        'Synced all dependencies dynamically with root/source package.json',
      ),
    );
    if (targetPkg.dependencies) {
      targetPkg.dependencies = Object.keys(targetPkg.dependencies)
        .sort()
        .reduce((obj, key) => {
          obj[key] = targetPkg.dependencies[key];
          return obj;
        }, {});
    }
    await fs.writeJson(targetPackageJsonPath, targetPkg, { spaces: 2 });
  }
}

ensureTemplateSync().catch((error) => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
