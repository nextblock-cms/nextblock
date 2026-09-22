// `create-nextblock activate` points the way; it installs nothing and writes nothing.
//
// Up to 0.21.1 `activate ecommerce` npm-installed @nextblock-cms/ecommerce (a dependency of
// every scaffold since 2026-06) and overwrote ten commerce routes with wrappers that imported
// page components from the package root, which only '@nextblock-cms/ecommerce/server' exports
// (CheckoutSuccessPage existed nowhere), so the project stopped building. Premium code ships in
// every project; a license switches it on at runtime (CMS → Administration → Packages, or
// NEXTBLOCK_LICENSE_KEY: apps/nextblock/lib/packages/env-license.ts). The command is kept,
// hidden from --help, because without it commander hands `activate` to the default `create`
// command and scaffolds a project named "activate".
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Mirrors NEXTBLOCK_PACKAGES in libs/utils/src/lib/nextblock-packages.ts (id and name);
 * activate.test.js fails on drift. `label` is the short name the guide uses in running text.
 */
export const PREMIUM_PACKAGES = Object.freeze({
  'cortex-ai': Object.freeze({
    id: 'cortex-ai',
    name: 'NextBlock Cortex AI',
    label: 'Cortex AI',
    dependency: '@nextblock-cms/cortex',
  }),
  ecommerce: Object.freeze({
    id: 'ecommerce',
    name: 'NextBlock™ Commerce Pro',
    label: 'Commerce Pro',
    dependency: '@nextblock-cms/ecommerce',
  }),
});

// Names people type for each package. Cortex's id is `cortex-ai`, never `ai`.
const PACKAGE_ALIASES = Object.freeze({
  'cortex-ai': 'cortex-ai',
  cortex: 'cortex-ai',
  ecommerce: 'ecommerce',
  ecom: 'ecommerce',
  commerce: 'ecommerce',
  'commerce-pro': 'ecommerce',
});

export const PREMIUM_DOCS_URL =
  'https://github.com/nextblock-cms/nextblock/blob/master/docs/06-CLI-AND-SCAFFOLDING.md#premium-packages';
export const UPDATE_DOCS_URL =
  'https://github.com/nextblock-cms/nextblock/blob/master/docs/13-STAYING-UP-TO-DATE.md';

/**
 * Files the old command overwrote with code that breaks the build or drops features. Its
 * coupons copies were identical to the real routes, so they are not listed.
 */
export const LEGACY_ACTIVATE_FILES = Object.freeze([
  'app/cms/orders/page.tsx',
  'app/cms/orders/[id]/page.tsx',
  'app/cms/products/page.tsx',
  'app/cms/products/new/page.tsx',
  'app/cms/products/[id]/edit/page.tsx',
  'app/cms/payments/page.tsx',
  'app/checkout/success/page.tsx',
  'app/api/checkout/route.ts',
]);

// "A", "A and B", "A, B and C".
function joinNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

/**
 * The packages `activate [package]` should explain: all of them when no name is given, the
 * one named otherwise, or `{ ok: false, message }` for a name that is not a premium package.
 */
export function resolvePremiumPackages(input) {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!raw) return { ok: true, packages: Object.values(PREMIUM_PACKAGES) };

  const id = PACKAGE_ALIASES[raw];
  if (!id) {
    const known = Object.values(PREMIUM_PACKAGES)
      .map((pkg) => `${pkg.id} (${pkg.name})`)
      .join(', ');
    return { ok: false, message: `Unknown package "${input}". NextBlock premium packages: ${known}.` };
  }
  return { ok: true, packages: [PREMIUM_PACKAGES[id]] };
}

/**
 * The premium dependencies a NextBlock project's package.json lacks (projects created before
 * the package shipped with every scaffold). [] when the manifest is not a NextBlock project's.
 */
export function findMissingPremiumDependencies(packageJson, packages) {
  const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  if (!('@nextblock-cms/db' in deps)) return [];
  return packages.filter((pkg) => !(pkg.dependency in deps));
}

/**
 * True for a file the old command wrote: a page wrapper importing its component from the
 * package root, or the untyped checkout route. The real routes import from
 * '@nextblock-cms/ecommerce/server' and type the checkout helper, so neither matches.
 */
export function isLegacyActivateWrapper(source) {
  return (
    /PageUI \} from '@nextblock-cms\/ecommerce';/.test(source) ||
    /function resolveProviderFromItem\(item\) \{/.test(source)
  );
}

/** The LEGACY_ACTIVATE_FILES under `projectDir` that still hold the old command's wrappers. */
export async function findLegacyActivateWrappers(projectDir) {
  const found = [];
  for (const file of LEGACY_ACTIVATE_FILES) {
    try {
      if (isLegacyActivateWrapper(await readFile(resolve(projectDir, file), 'utf8'))) found.push(file);
    } catch {
      // Absent or unreadable: nothing the old command left behind.
    }
  }
  return found;
}

/** The lines `activate` prints. Pure, so the copy is tested without running the CLI. */
export function buildActivationGuide(packages, { missing = [], legacyFiles = [] } = {}) {
  const one = packages.length === 1;
  const everyLabel = joinNames(Object.values(PREMIUM_PACKAGES).map((pkg) => pkg.label));
  // env-license.ts reads the key as Cortex AI's unless NEXTBLOCK_LICENSE_PACKAGE says otherwise.
  const commerceKeyNote = packages.some((pkg) => pkg.id === 'ecommerce')
    ? ' (a Commerce Pro key also needs NEXTBLOCK_LICENSE_PACKAGE=ecommerce)'
    : '';
  const lines = [
    `${joinNames(packages.map((pkg) => pkg.name))} ${one ? 'needs' : 'need'} no install and no code change: a license switches ${one ? 'it' : 'them'} on in your running site.`,
    '',
    `NextBlock CMS is free and open source (AGPL-3.0). Premium packages add to it: today ${everyLabel}, with more to come. Their code already ships in every project, and each has a free 30-day trial, no credit card required.`,
    '',
    "  1. Sign in to your site's CMS (/cms) as an administrator.",
    '  2. Open Administration → Packages (/cms/settings/packages).',
    '  3. Start the free trial, or paste a license key you already have.',
    '',
    `No browser (CI or a coding agent)? Set NEXTBLOCK_LICENSE_KEY instead${commerceKeyNote}: ${PREMIUM_DOCS_URL}`,
  ];

  for (const pkg of missing) {
    lines.push(
      '',
      `This project's package.json has no ${pkg.dependency}: it was created before ${pkg.label} shipped with every project. Update the project first (${UPDATE_DOCS_URL}) rather than installing the package on its own.`,
    );
  }

  if (legacyFiles.length) {
    lines.push(
      '',
      'An older `create-nextblock activate` overwrote these files with wrappers that break the build or drop features:',
      ...legacyFiles.map((file) => `  ${file}`),
      'Restore each one from your git history (before the activate run), or copy it from a fresh project made with the create-nextblock version this project came from.',
    );
  }

  return lines;
}
