import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Affiliates is a Commerce Pro add-on: the program runs only while both packages are active, and
 * every gate in the app goes through isAffiliatesProgramActive (2026-10-29). Before, each gate
 * checked the Affiliates package alone, so a site with Commerce off still ran partner signup and
 * the portal, and partners built storefronts that could never earn a commission.
 */

const mocks = vi.hoisted(() => ({ active: new Map<string, boolean | Error>() }));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: vi.fn(async (packageId: string) => {
    const state = mocks.active.get(packageId);
    if (state instanceof Error) throw state;
    return state === true;
  }),
}));

import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';
import { isAffiliatesProgramActive } from './package-state';

beforeEach(() => {
  mocks.active.clear();
  vi.mocked(verifyPackageOnline).mockClear();
});

describe('isAffiliatesProgramActive', () => {
  it('requires Commerce Pro: the registry names it as the add-on base', () => {
    expect(NEXTBLOCK_PACKAGES.affiliates.requires).toEqual(['ecommerce']);
  });

  it('is active only while Affiliates and Commerce Pro are both active', async () => {
    mocks.active.set('affiliates', true);
    mocks.active.set('ecommerce', true);
    await expect(isAffiliatesProgramActive()).resolves.toBe(true);
    expect(vi.mocked(verifyPackageOnline).mock.calls.map(([id]) => id).sort()).toEqual(['affiliates', 'ecommerce']);
  });

  it.each([
    ['Commerce Pro is off', { affiliates: true, ecommerce: false }],
    ['Affiliates is off', { affiliates: false, ecommerce: true }],
    ['both are off', { affiliates: false, ecommerce: false }],
  ])('is dormant when %s', async (_label, states) => {
    for (const [id, active] of Object.entries(states)) mocks.active.set(id, active);
    await expect(isAffiliatesProgramActive()).resolves.toBe(false);
  });

  it('reads a failed check as inactive and never throws', async () => {
    mocks.active.set('affiliates', true);
    mocks.active.set('ecommerce', new Error('network down'));
    await expect(isAffiliatesProgramActive()).resolves.toBe(false);
  });
});

describe('every Affiliates gate goes through isAffiliatesProgramActive', () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const DIRECT_CHECK = /verifyPackageOnline\(\s*(?:AFFILIATES_PACKAGE_ID|['"]affiliates['"])\s*[,)]|isPackageActive\(\s*AFFILIATES_PACKAGE_ID/;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it('finds no direct Affiliates package check outside lib/affiliates/package-state.ts', () => {
    const files = ['app', 'lib', 'components'].flatMap((dir) => sourceFiles(path.join(appRoot, dir)));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => !file.endsWith(path.join('lib', 'affiliates', 'package-state.ts')))
      .filter((file) => DIRECT_CHECK.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(appRoot, file).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('recognises the direct checks it guards against', () => {
    expect(DIRECT_CHECK.test('await verifyPackageOnline(AFFILIATES_PACKAGE_ID)')).toBe(true);
    expect(DIRECT_CHECK.test("verifyPackageOnline('affiliates').catch(() => false)")).toBe(true);
    expect(DIRECT_CHECK.test("isPackageActive(AFFILIATES_PACKAGE_ID, 'partner pages')")).toBe(true);
    expect(DIRECT_CHECK.test("verifyPackageOnline('ecommerce')")).toBe(false);
  });
});
