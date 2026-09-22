import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PREMIUM_PACKAGES,
  buildActivationGuide,
  findLegacyActivateWrappers,
  findMissingPremiumDependencies,
  isLegacyActivateWrapper,
  resolvePremiumPackages,
} from './activate.js';

const here = dirname(fileURLToPath(import.meta.url));
// The registry the CMS sells from. Loaded by URL because it lives in another Nx project; the
// file has no imports, so it needs no aliases.
const { NEXTBLOCK_PACKAGES } = await import(
  pathToFileURL(resolve(here, '../../../../libs/utils/src/lib/nextblock-packages.ts')).href
);
const appDir = resolve(here, '../../../nextblock');
const appDependencies = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8')).dependencies;
const cliSource = readFileSync(resolve(here, '../create-nextblock.js'), 'utf8').replace(/\r\n/g, '\n');
const helperSource = readFileSync(resolve(here, 'activate.js'), 'utf8');
// Calls that install a package or change the project; neither the handler nor its helpers may make one.
const MUTATING_CALLS = [
  'execa(', 'spawn(', 'child_process', 'writeFile', 'appendFile', 'outputFile', 'ensureDir',
  'mkdir', 'writeJSON', 'writeJson', 'copy(', 'remove(', '.rm(', 'unlink', 'rename(',
];

const ids = (result) => result.packages.map((pkg) => pkg.id);

describe('resolvePremiumPackages', () => {
  it('maps every Commerce Pro spelling to ecommerce', () => {
    for (const input of ['ecommerce', ' Commerce ', 'ecom', 'commerce-pro']) {
      expect(ids(resolvePremiumPackages(input)), input).toEqual(['ecommerce']);
    }
  });

  it('maps cortex-ai and cortex to cortex-ai', () => {
    for (const input of ['cortex-ai', 'cortex']) {
      expect(ids(resolvePremiumPackages(input)), input).toEqual(['cortex-ai']);
    }
  });

  it('explains every package when none is named', () => {
    for (const input of [undefined, '']) {
      expect(ids(resolvePremiumPackages(input)).sort()).toEqual(['cortex-ai', 'ecommerce']);
    }
  });

  it('rejects other names (Cortex is never `ai`) and lists the real ones', () => {
    for (const input of ['ai', 'shop']) {
      const result = resolvePremiumPackages(input);
      expect(result.ok, input).toBe(false);
      expect(result.message).toContain('cortex-ai (NextBlock Cortex AI), ecommerce (NextBlock™ Commerce Pro)');
    }
  });
});

describe('PREMIUM_PACKAGES', () => {
  it('matches NEXTBLOCK_PACKAGES, the registry the CMS sells from', () => {
    expect(Object.keys(PREMIUM_PACKAGES).sort()).toEqual(Object.keys(NEXTBLOCK_PACKAGES).sort());
    for (const [id, pkg] of Object.entries(PREMIUM_PACKAGES)) {
      expect(pkg.id).toBe(id);
      expect(pkg.name, id).toBe(NEXTBLOCK_PACKAGES[id].name);
    }
  });

  it('only promises the trial the registry offers (30 days, no credit card)', () => {
    for (const [id, pkg] of Object.entries(NEXTBLOCK_PACKAGES)) {
      expect(pkg.trial?.days, id).toBe(30);
      expect(pkg.trial?.requiresPaymentMethod, id).toBe(false);
    }
  });

  it('names dependencies every scaffold already declares, so there is nothing to install', () => {
    for (const pkg of Object.values(PREMIUM_PACKAGES)) {
      expect(appDependencies, `apps/nextblock/package.json dependencies`).toHaveProperty([pkg.dependency]);
    }
  });
});

describe('findMissingPremiumDependencies', () => {
  const { ecommerce } = PREMIUM_PACKAGES;

  it('ignores a manifest that is not a NextBlock project', () => {
    expect(findMissingPremiumDependencies({}, [ecommerce])).toEqual([]);
    expect(findMissingPremiumDependencies(undefined, [ecommerce])).toEqual([]);
  });

  it('reports a premium dependency an older project lacks', () => {
    const manifest = { dependencies: { '@nextblock-cms/db': '^0.21.1' } };
    expect(findMissingPremiumDependencies(manifest, [ecommerce])).toEqual([ecommerce]);
  });

  it('reports nothing for a current project', () => {
    const manifest = {
      dependencies: {
        '@nextblock-cms/cortex': '^0.21.1',
        '@nextblock-cms/db': '^0.21.1',
        '@nextblock-cms/ecommerce': 'npm:@nextblock-cms/ecom@latest',
      },
    };
    expect(findMissingPremiumDependencies(manifest, Object.values(PREMIUM_PACKAGES))).toEqual([]);
  });
});

describe('isLegacyActivateWrapper', () => {
  it('recognises what the old command wrote', () => {
    expect(isLegacyActivateWrapper("import { OrdersPage as OrdersPageUI } from '@nextblock-cms/ecommerce';")).toBe(true);
    expect(isLegacyActivateWrapper('function resolveProviderFromItem(item) {')).toBe(true);
  });

  it("does not flag the app's own routes", async () => {
    for (const file of ['app/cms/orders/page.tsx', 'app/checkout/success/page.tsx', 'app/api/checkout/route.ts']) {
      expect(isLegacyActivateWrapper(readFileSync(resolve(appDir, file), 'utf8')), file).toBe(false);
    }
    // The same check over every path the old command wrote, as `activate` runs it in a project.
    expect(await findLegacyActivateWrappers(appDir)).toEqual([]);
  });

  it('names the wrappers left in a project and skips absent files', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'nextblock-activate-'));
    try {
      mkdirSync(join(projectDir, 'app/cms/orders'), { recursive: true });
      mkdirSync(join(projectDir, 'app/api/checkout'), { recursive: true });
      writeFileSync(
        join(projectDir, 'app/cms/orders/page.tsx'),
        "import { OrdersPage as OrdersPageUI } from '@nextblock-cms/ecommerce';\r\n",
      );
      writeFileSync(join(projectDir, 'app/api/checkout/route.ts'), 'function resolveProviderFromItem(item) {\n}\n');
      expect(await findLegacyActivateWrappers(projectDir)).toEqual(['app/cms/orders/page.tsx', 'app/api/checkout/route.ts']);
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  });
});

describe('buildActivationGuide', () => {
  it('points to the CMS and the headless key, never to an install', () => {
    const guide = buildActivationGuide([PREMIUM_PACKAGES.ecommerce]).join('\n');
    for (const text of ['/cms/settings/packages', '30-day', 'no credit card', 'NEXTBLOCK_LICENSE_KEY', 'AGPL-3.0']) {
      expect(guide).toContain(text);
    }
    expect(guide).not.toContain('npm install');
  });

  it('tells a Commerce Pro key to name its package, and only then', () => {
    const note = 'NEXTBLOCK_LICENSE_PACKAGE=ecommerce';
    expect(buildActivationGuide([PREMIUM_PACKAGES.ecommerce]).join('\n')).toContain(note);
    expect(buildActivationGuide(Object.values(PREMIUM_PACKAGES)).join('\n')).toContain(note);
    expect(buildActivationGuide([PREMIUM_PACKAGES['cortex-ai']]).join('\n')).not.toContain(note);
  });

  it('adds the missing-dependency and legacy-file notes only when there is something to report', () => {
    const plain = buildActivationGuide(Object.values(PREMIUM_PACKAGES)).join('\n');
    expect(plain).not.toContain('package.json has no');
    expect(plain).not.toContain('overwrote');

    const noted = buildActivationGuide([PREMIUM_PACKAGES.ecommerce], {
      missing: [PREMIUM_PACKAGES.ecommerce],
      legacyFiles: ['app/cms/orders/page.tsx'],
    }).join('\n');
    expect(noted).toContain('package.json has no @nextblock-cms/ecommerce');
    expect(noted).toContain('  app/cms/orders/page.tsx');
  });
});

describe('create-nextblock.js', () => {
  it('no longer carries the route wrappers the old activate wrote', () => {
    expect(cliSource).not.toContain('routesToInject');
  });

  it('keeps `activate` registered, hidden, so it never scaffolds a project named "activate"', () => {
    expect(cliSource).toContain(".command('activate [package]', { hidden: true })");
  });

  it('runs no install and writes no file from the activate handler', () => {
    const start = cliSource.indexOf('async function handleActivateCommand(');
    const body = cliSource.slice(start, cliSource.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(-1);
    for (const call of MUTATING_CALLS) {
      expect(body, call).not.toContain(call);
      expect(helperSource, `activate.js: ${call}`).not.toContain(call);
    }
  });
});
