import { relative, resolve, sep } from 'node:path';
import fs from 'fs-extra';

// What the template sync promises about the finished template, checked from disk. `npm publish`
// runs the sync in `prepack`, so a template that falls short stops the publish before anything
// reaches npm. A half-built template is committed in e8f20a73 (2026-11-13): no Docker assets, no
// lib/ui proxies, project.json and tsconfig.tsbuildinfo still present, "install": "monorepo".
// The sync's removal steps used to swallow every error, so that could also have shipped silently.

const MUST_BE_ABSENT = ['project.json', 'tsconfig.tsbuildinfo'];
const DOCKER_SCRIPTS = ['docker:setup', 'docker:up', 'docker:down', 'docker:logs'];
const SOURCE_DIRS = ['app', 'components', 'context', 'lib'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
/** The same pattern sanitizeUiImports rewrites to the `@nextblock-cms/ui` barrel. */
const UI_SUBPATH_IMPORT = /@nextblock-cms\/ui\/(?!styles\/)[A-Za-z0-9/_-]+/;

const toPosix = (path) => path.split(sep).join('/');

async function listFiles(dir, accept = () => true, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, accept, out);
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

const hasSourceExtension = (name) => {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTENSIONS.has(name.slice(dot));
};

/**
 * Returns one line per broken promise; an empty list means the template is complete.
 * `dockerTemplateDir` is optional: every file under it must exist at the same path in the template.
 */
export async function findTemplateProblems(
  templateDir,
  { uiProxyModules, standaloneEslintConfig, dockerTemplateDir },
) {
  const problems = [];

  for (const name of MUST_BE_ABSENT) {
    if (await fs.pathExists(resolve(templateDir, name))) problems.push(`${name} must not ship`);
  }

  const packageJsonPath = resolve(templateDir, 'package.json');
  if (!(await fs.pathExists(packageJsonPath))) {
    problems.push('package.json is missing');
  } else {
    const pkg = await fs.readJson(packageJsonPath);
    const install = pkg.nextblock?.install;
    if (install !== 'standalone') {
      problems.push(`package.json has nextblock.install ${JSON.stringify(install)}, not "standalone"`);
    }
    for (const script of DOCKER_SCRIPTS) {
      if (!pkg.scripts?.[script]) problems.push(`package.json has no ${script} script`);
    }
  }

  if (dockerTemplateDir && (await fs.pathExists(dockerTemplateDir))) {
    for (const file of await listFiles(dockerTemplateDir)) {
      const rel = relative(dockerTemplateDir, file);
      if (!(await fs.pathExists(resolve(templateDir, rel)))) {
        problems.push(`Docker asset ${toPosix(rel)} is missing`);
      }
    }
  }

  for (const moduleName of uiProxyModules) {
    if (!(await fs.pathExists(resolve(templateDir, 'lib/ui', `${moduleName}.ts`)))) {
      problems.push(`lib/ui/${moduleName}.ts is missing`);
    }
  }

  const eslintConfigPath = resolve(templateDir, 'eslint.config.mjs');
  if (
    !(await fs.pathExists(eslintConfigPath)) ||
    (await fs.readFile(eslintConfigPath, 'utf8')) !== standaloneEslintConfig
  ) {
    problems.push('eslint.config.mjs is not the standalone config');
  }

  for (const dir of SOURCE_DIRS) {
    const absoluteDir = resolve(templateDir, dir);
    if (!(await fs.pathExists(absoluteDir))) continue;
    for (const file of await listFiles(absoluteDir, hasSourceExtension)) {
      const match = (await fs.readFile(file, 'utf8')).match(UI_SUBPATH_IMPORT);
      if (match) problems.push(`${toPosix(relative(templateDir, file))} still imports ${match[0]}`);
    }
  }

  return problems;
}
