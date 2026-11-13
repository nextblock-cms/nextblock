import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findTemplateProblems } from './template-check.js';

const PROXIES = ['button', 'dialog'];
const ESLINT = "export default [];\n";

let root;
let template;
let dockerTemplate;

async function put(base, rel, content) {
  const full = join(base, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

const check = () =>
  findTemplateProblems(template, {
    uiProxyModules: PROXIES,
    standaloneEslintConfig: ESLINT,
    dockerTemplateDir: dockerTemplate,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'template-check-'));
  template = join(root, 'template');
  dockerTemplate = join(root, 'docker-template');

  await put(dockerTemplate, 'Dockerfile', 'FROM node\n');
  await put(dockerTemplate, 'docker/kong/kong.yml', '_format_version: "3.0"\n');

  // A complete template, as the sync leaves it.
  await put(template, 'Dockerfile', 'FROM node\n');
  await put(template, 'docker/kong/kong.yml', '_format_version: "3.0"\n');
  await put(
    template,
    'package.json',
    JSON.stringify({
      name: 'nextblock',
      nextblock: { install: 'standalone' },
      scripts: {
        'docker:setup': 'node scripts/docker-setup.mjs',
        'docker:up': 'docker compose up -d --build',
        'docker:down': 'docker compose down',
        'docker:logs': 'docker compose logs -f nextblock-cms',
      },
    }),
  );
  for (const name of PROXIES) await put(template, `lib/ui/${name}.ts`, "export * from '@nextblock-cms/ui';\n");
  await put(template, 'eslint.config.mjs', ESLINT);
  await put(
    template,
    'app/page.tsx',
    "import { Button } from '@nextblock-cms/ui';\nimport '@nextblock-cms/ui/styles/globals.css';\n",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findTemplateProblems', () => {
  it('passes a complete template (the barrel and the styles subpath are allowed)', async () => {
    await expect(check()).resolves.toEqual([]);
  });

  it('reports every gap of the half-built template the 0.23.0 sync left behind', async () => {
    await put(template, 'project.json', '{}');
    await put(template, 'tsconfig.tsbuildinfo', '{}');
    await put(template, 'package.json', JSON.stringify({ name: 'nextblock', nextblock: { install: 'monorepo' }, scripts: {} }));
    await rm(join(template, 'docker'), { recursive: true });
    await rm(join(template, 'lib/ui/dialog.ts'));
    await put(template, 'eslint.config.mjs', "import nx from '@nx/eslint-plugin';\n");
    await put(template, 'components/header-auth.tsx', "import { Button } from '@nextblock-cms/ui/button';\n");

    const problems = await check();

    expect(problems).toEqual([
      'project.json must not ship',
      'tsconfig.tsbuildinfo must not ship',
      'package.json has nextblock.install "monorepo", not "standalone"',
      'package.json has no docker:setup script',
      'package.json has no docker:up script',
      'package.json has no docker:down script',
      'package.json has no docker:logs script',
      'Docker asset docker/kong/kong.yml is missing',
      'lib/ui/dialog.ts is missing',
      'eslint.config.mjs is not the standalone config',
      'components/header-auth.tsx still imports @nextblock-cms/ui/button',
    ]);
  });

  it('reports a missing package.json and eslint config', async () => {
    await rm(join(template, 'package.json'));
    await rm(join(template, 'eslint.config.mjs'));

    await expect(check()).resolves.toEqual([
      'package.json is missing',
      'eslint.config.mjs is not the standalone config',
    ]);
  });

  it('skips the Docker check when there is no docker-template folder', async () => {
    await rm(dockerTemplate, { recursive: true });
    await rm(join(template, 'Dockerfile'));

    await expect(check()).resolves.toEqual([]);
  });
});

describe('sync-template.js wiring', () => {
  // The script runs the whole sync when imported, so its wiring is checked from the source.
  const source = () =>
    readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../sync-template.js'), 'utf8');

  it('ends with the template check and throws when it finds a problem', async () => {
    const text = await source();
    expect(text).toMatch(/findTemplateProblems\(TARGET_DIR,/);
    expect(text).toMatch(/if \(problems\.length > 0\) \{\s*throw new Error/);
  });

  it('lets removal failures reach the retry instead of swallowing them', async () => {
    expect(await source()).not.toMatch(/\.catch\(\(\) => undefined\)/);
  });
});
