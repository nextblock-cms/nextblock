import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  STANDALONE_NEXT_CONFIG_PATCHES,
  STANDALONE_TRANSPILE_PACKAGES,
  patchNextConfigForStandalone,
} from './next-config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The real app config: this test is the drift guard between apps/nextblock and the scaffold.
const APP_NEXT_CONFIG = resolve(here, '../../../nextblock/next.config.js');

const appSource = readFileSync(APP_NEXT_CONFIG, 'utf8');

describe('patchNextConfigForStandalone', () => {
  it("every required patch still finds its anchor in the app's next.config.js", () => {
    const normalized = appSource.replace(/\r\n/g, '\n');

    for (const patch of STANDALONE_NEXT_CONFIG_PATCHES.filter((p) => p.required)) {
      const found = patch.regex ? patch.regex.test(normalized) : normalized.includes(patch.from);
      expect(found, `anchor for "${patch.name}"`).toBe(true);
    }
  });

  it('produces syntactically valid JavaScript', () => {
    const patched = patchNextConfigForStandalone(appSource);

    expect(() => new vm.Script(patched, { filename: 'next.config.js' })).not.toThrow();
  });

  it('applies the standalone differences and nothing else', () => {
    const patched = patchNextConfigForStandalone(appSource).replace(/\r\n/g, '\n');

    expect(patched).toContain('outputFileTracingRoot: path.join(__dirname),');
    expect(patched).not.toContain("path.join(__dirname, '../../')");
    expect(patched).toContain('typescript: { ignoreBuildErrors: true },');

    for (const name of STANDALONE_TRANSPILE_PACKAGES) {
      expect(patched).toContain(`'${name}',`);
    }

    // What used to break scaffolds on Next 16: webpack-only options and a webpack() hook.
    expect(patched).not.toContain('cssChunking');
    expect(patched).not.toMatch(/^\s*webpack: \(/m);

    // Inherited from the app untouched.
    expect(patched).toContain('turbopack: {');
    expect(patched).toContain('async headers()');
    expect(patched).toContain('allowedDevOrigins');
  });

  it('preserves CRLF line endings when the source uses them', () => {
    const crlf = appSource.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const patched = patchNextConfigForStandalone(crlf);

    expect(patched.includes('\r\n')).toBe(true);
    expect(patched.split('\r\n').length).toBe(patched.split('\n').length);
  });

  it('fails loudly when a required anchor is missing', () => {
    expect(() => patchNextConfigForStandalone('module.exports = {};')).toThrow(/found no anchor/);
  });
});
