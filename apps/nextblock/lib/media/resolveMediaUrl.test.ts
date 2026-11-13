import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import * as shared from '@nextblock-cms/utils/media-url';

import * as app from './resolveMediaUrl';

const APP_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(APP_DIR, '../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'libs/db/src/supabase/migrations');
const SANDBOX_RESET_DIR = path.join(APP_DIR, 'app/api/cron/reset-sandbox');
/** A quoted bare `images/<file>` key, as a media row or an image block stores it (no leading slash). */
const BARE_IMAGE_KEY = /['"`](images\/[^'"`/\s]+)['"`]/g;

describe('lib/media/resolveMediaUrl', () => {
  it('re-exports the shared resolver from @nextblock-cms/utils/media-url', () => {
    expect(app.resolveMediaUrl).toBe(shared.resolveMediaUrl);
    expect(app.resolveMediaUrlWithSupabaseFallback).toBe(shared.resolveMediaUrlWithSupabaseFallback);
    expect(app.getPublicMediaBaseUrl).toBe(shared.getPublicMediaBaseUrl);
    expect(app.BUNDLED_PUBLIC_MEDIA_KEYS).toBe(shared.BUNDLED_PUBLIC_MEDIA_KEYS);
  });
});

describe('BUNDLED_PUBLIC_MEDIA_KEYS', () => {
  it('names files that ship in public/, where /images/… is served from', () => {
    const missing = [...shared.BUNDLED_PUBLIC_MEDIA_KEYS].filter(
      (key) => !existsSync(path.join(APP_DIR, 'public', key))
    );

    expect(missing).toEqual([]);
  });

  it('holds every bundled key the forward migrations and the sandbox reset write', () => {
    // The catch-up replays the retired generation, including media since removed from public/
    // (images/mcp-prompt-to-production.webp), so only this generation's own files count.
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && !/_catchup_gen\d+\.sql$/.test(name))
      .map((name) => path.join(MIGRATIONS_DIR, name));
    const sandboxSources = readdirSync(SANDBOX_RESET_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'sandboxResetSql.ts')
      .map((name) => path.join(SANDBOX_RESET_DIR, name));

    const unlisted = new Set<string>();
    let seen = 0;
    for (const file of [...migrations, ...sandboxSources]) {
      for (const match of readFileSync(file, 'utf8').matchAll(BARE_IMAGE_KEY)) {
        seen += 1;
        if (!shared.isBundledPublicMediaKey(match[1])) unlisted.add(`${match[1]} (${path.basename(file)})`);
      }
    }

    expect(seen).toBeGreaterThan(0);
    expect([...unlisted]).toEqual([]);
  });
});
