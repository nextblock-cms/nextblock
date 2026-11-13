import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TEMPLATE_DOCS_EXCLUDED_DIRS, shouldSyncTemplateDoc } from './template-docs.js';

// sync-template.js runs the whole sync when it is imported, so the docs filter lives in this
// module and the wiring is checked from the script's source.
const here = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(here, '../../../../docs');
const SYNC_SCRIPT = resolve(here, '../sync-template.js');

/** Every path under `dir` the docs sync would copy (a refused folder is not descended into). */
function syncedPaths(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (!shouldSyncTemplateDoc(full, DOCS_ROOT)) continue;
    out.push(relative(DOCS_ROOT, full).split(/[\\/]/).join('/'));
    if (entry.isDirectory()) syncedPaths(full, out);
  }
  return out;
}

describe('template docs sync filter', () => {
  it('keeps docs/prompts (internal build prompts) out of the template', () => {
    expect(TEMPLATE_DOCS_EXCLUDED_DIRS).toContain('prompts');
    expect(shouldSyncTemplateDoc(join(DOCS_ROOT, 'prompts'), DOCS_ROOT)).toBe(false);
    expect(shouldSyncTemplateDoc(join(DOCS_ROOT, 'prompts', 'Affiliate-Master-Prompt.md'), DOCS_ROOT)).toBe(false);
  });

  it('ships the documentation itself', () => {
    expect(shouldSyncTemplateDoc(DOCS_ROOT, DOCS_ROOT)).toBe(true);
    for (const file of ['15-AFFILIATES-AND-STOREFRONTS.md', 'README.md', join('assets', 'diagram.png'), 'prompts.md']) {
      expect(shouldSyncTemplateDoc(join(DOCS_ROOT, file), DOCS_ROOT), file).toBe(true);
    }
  });

  it('still skips node_modules anywhere, and anything outside docs/', () => {
    expect(shouldSyncTemplateDoc(join(DOCS_ROOT, 'node_modules', 'x', 'index.js'), DOCS_ROOT)).toBe(false);
    expect(shouldSyncTemplateDoc(join(DOCS_ROOT, 'assets', 'node_modules', 'x.js'), DOCS_ROOT)).toBe(false);
    expect(shouldSyncTemplateDoc(resolve(DOCS_ROOT, '..', 'package.json'), DOCS_ROOT)).toBe(false);
  });

  it('copies every numbered doc of the real docs folder and nothing under prompts/', () => {
    const synced = syncedPaths(DOCS_ROOT);
    const numbered = readdirSync(DOCS_ROOT).filter((name) => /^\d{2}-.+\.md$/.test(name));
    expect(numbered.length).toBeGreaterThan(10);
    expect(synced).toEqual(expect.arrayContaining(numbered));
    expect(synced.filter((file) => file === 'prompts' || file.startsWith('prompts/'))).toEqual([]);
    if (existsSync(join(DOCS_ROOT, 'prompts'))) {
      expect(readdirSync(join(DOCS_ROOT, 'prompts')).length).toBeGreaterThan(0);
    }
  });

  it('is the filter sync-template.js copies the docs with', () => {
    const source = readFileSync(SYNC_SCRIPT, 'utf8');
    expect(source).toMatch(/import \{ shouldSyncTemplateDoc \} from '\.\/lib\/template-docs\.js';/);
    const ensureDocsSync = /async function ensureDocsSync\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(ensureDocsSync).toContain('filter: (src) => shouldSyncTemplateDoc(src, ROOT_DOCS_DIR)');
  });
});
