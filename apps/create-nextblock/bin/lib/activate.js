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
 * `dashboardCheckout` mirrors `hasPackageCheckout()` there: false while the package has no
 * Freemius product, so the CMS offers no trial or checkout for it. `requires` mirrors its
 * `requires`: an add-on (Affiliates needs Commerce Pro) stays paused until its base is active.
 */
export const PREMIUM_PACKAGES = Object.freeze({
  'cortex-ai': Object.freeze({
    id: 'cortex-ai',
    name: 'NextBlock Cortex AI',
    label: 'Cortex AI',
    dependency: '@nextblock-cms/cortex',
    dashboardCheckout: true,
    requires: Object.freeze([]),
  }),
  ecommerce: Object.freeze({
    id: 'ecommerce',
    name: 'NextBlock™ Commerce Pro',
    label: 'Commerce Pro',
    dependency: '@nextblock-cms/ecommerce',
    dashboardCheckout: true,
    requires: Object.freeze([]),
  }),
  affiliates: Object.freeze({
    id: 'affiliates',
    name: 'NextBlock Affiliates & Creator Storefronts',
    label: 'Affiliates',
    dependency: '@nextblock-cms/affiliates',
    dashboardCheckout: true,
    requires: Object.freeze(['ecommerce']),
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
  affiliates: 'affiliates',
  affiliate: 'affiliates',
  partners: 'affiliates',
  storefronts: 'affiliates',
  'creator-storefronts': 'affiliates',
});

/** env-license.ts reads NEXTBLOCK_LICENSE_KEY as this package's key unless NEXTBLOCK_LICENSE_PACKAGE names another. */
const DEFAULT_LICENSE_PACKAGE = 'cortex-ai';

export const PREMIUM_DOCS_URL =
  'https://github.com/nextblock-cms/nextblock/blob/master/docs/06-CLI-AND-SCAFFOLDING.md#premium-packages';
export const UPDATE_DOCS_URL =
  'https://github.com/nextblock-cms/nextblock/blob/master/docs/13-STAYING-UP-TO-DATE.md';
export const AFFILIATES_DOCS_URL =
  'https://github.com/nextblock-cms/nextblock/blob/master/docs/15-AFFILIATES-AND-STOREFRONTS.md';

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
  const trialLabels = Object.values(PREMIUM_PACKAGES)
    .filter((pkg) => pkg.dashboardCheckout)
    .map((pkg) => pkg.label);
  const trialSentence =
    trialLabels.length === Object.keys(PREMIUM_PACKAGES).length
      ? 'each has a free 30-day trial, no credit card required'
      : `${joinNames(trialLabels)} ${trialLabels.length === 1 ? 'has' : 'each have'} a free 30-day trial, no credit card required`;
  // A key for any other package must say which one it unlocks.
  const article = (label) => (/^[aeiou]/i.test(label) ? 'an' : 'a');
  const keyNotes = packages
    .filter((pkg) => pkg.id !== DEFAULT_LICENSE_PACKAGE)
    .map(
      (pkg, index) =>
        `${article(pkg.label)} ${pkg.label} key ${index === 0 ? 'also needs ' : ''}NEXTBLOCK_LICENSE_PACKAGE=${pkg.id}`,
    );
  const keyNote = keyNotes.length ? ` (${keyNotes.join(', ')})` : '';
  const withoutCheckout = packages.filter((pkg) => !pkg.dashboardCheckout);
  const lines = [
    `${joinNames(packages.map((pkg) => pkg.name))} ${one ? 'needs' : 'need'} no install and no code change: a license switches ${one ? 'it' : 'them'} on in your running site.`,
    '',
    `NextBlock CMS is free and open source (AGPL-3.0). Premium packages add to it: today ${everyLabel}, with more to come. Their code already ships in every project, and ${trialSentence}.`,
    '',
    "  1. Sign in to your site's CMS (/cms) as an administrator.",
    '  2. Open Administration → Packages (/cms/settings/packages).',
    '  3. Start the free trial, or paste a license key you already have.',
    ...withoutCheckout.map(
      (pkg) =>
        `     ${pkg.label} cannot be bought or trialed from the dashboard yet; its guide explains how to activate it: ${
          pkg.id === 'affiliates' ? AFFILIATES_DOCS_URL : PREMIUM_DOCS_URL
        }`,
    ),
    ...packages
      .filter((pkg) => pkg.requires.length > 0)
      .map((pkg) => {
        const bases = joinNames(pkg.requires.map((id) => PREMIUM_PACKAGES[id]?.label ?? id));
        return `     ${pkg.label} is an add-on for ${bases}: activate ${bases} too, or it stays paused.`;
      }),
    '',
    `No browser (CI or a coding agent)? Set NEXTBLOCK_LICENSE_KEY instead${keyNote}: ${PREMIUM_DOCS_URL}`,
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
