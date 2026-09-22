import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FALLBACK_OVERRIDES } from './fallback-overrides.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootOverrides = JSON.parse(readFileSync(resolve(here, '../../../../package.json'), 'utf8')).overrides;
// The app's update script owns this table; loaded by URL because it lives in another Nx project.
const { MANAGED_OVERRIDES } = await import(
  pathToFileURL(resolve(here, '../../../nextblock/tools/lib/managed-overrides.mjs')).href
);

// Every value a published create-nextblock has written for each override, oldest first (the
// CLI wrote none before 2026-06-11). Append the new value when you raise one. An old value
// missing from MANAGED_OVERRIDES[name].previous would stay in existing projects forever:
// `npm run update` would take it for the owner's own pin.
const SHIPPED = {
  glob: ['^10.4.5', '^13.0.6'],
  postcss: ['^8.5.12', '^8.5.26', '^8.5.28'],
  qs: ['^6.15.2', '^6.16.0'],
  uuid: ['^11.1.1', '^14.0.2'],
};

describe('FALLBACK_OVERRIDES', () => {
  it('matches the monorepo root overrides, which the CLI uses from a checkout', () => {
    for (const [name, spec] of Object.entries(FALLBACK_OVERRIDES)) {
      expect(rootOverrides[name], `root package.json overrides.${name}`).toBe(spec);
    }
  });

  it("is what `npm run update` moves existing projects to (managed-overrides.mjs)", () => {
    for (const [name, { current }] of Object.entries(MANAGED_OVERRIDES)) {
      expect(FALLBACK_OVERRIDES[name], `FALLBACK_OVERRIDES.${name}`).toBe(current);
    }
  });

  it('is the newest value in SHIPPED, so the next raise is guarded too', () => {
    for (const [name, history] of Object.entries(SHIPPED)) {
      expect(FALLBACK_OVERRIDES[name], `FALLBACK_OVERRIDES.${name}`).toBe(history.at(-1));
    }
  });

  it('lists every earlier shipped value as `previous`, so `npm run update` moves it', () => {
    for (const [name, history] of Object.entries(SHIPPED)) {
      const { current, previous } = MANAGED_OVERRIDES[name];
      for (const spec of history) {
        expect([...previous, current], `MANAGED_OVERRIDES.${name} is missing ${spec}`).toContain(spec);
      }
    }
  });

  it('has an entry in MANAGED_OVERRIDES and SHIPPED for every version range it writes', () => {
    const ranges = Object.entries(FALLBACK_OVERRIDES).filter(([, spec]) => !spec.startsWith('npm:'));
    for (const [name] of ranges) {
      expect(MANAGED_OVERRIDES, `MANAGED_OVERRIDES.${name}`).toHaveProperty(name);
      expect(SHIPPED, `SHIPPED.${name}`).toHaveProperty(name);
    }
  });
});
