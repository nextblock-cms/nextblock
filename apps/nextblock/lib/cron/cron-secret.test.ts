import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const crypto = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  crypto.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: crypto.timingSafeEqual };
});

import { cronBearerMatches, isCronRequestAuthorized, parseCronBearerToken, readCronSecret } from './cron-secret';

/**
 * The scheduled routes' bearer check: SHA-256 digests compared with `timingSafeEqual` (a plain
 * `!==` leaks the secret's length and content through timing), each route's own policy for a
 * deployment without CRON_SECRET, and no minimum length (existing deployments keep working).
 */

const withAuthorization = (authorization?: string) => ({
  headers: new Headers(authorization === undefined ? {} : { authorization }),
});

describe('readCronSecret', () => {
  it('trims the secret and treats a blank one as unset', () => {
    expect(readCronSecret({ CRON_SECRET: '  s3cret \n' })).toBe('s3cret');
    expect(readCronSecret({ CRON_SECRET: '   ' })).toBe('');
    expect(readCronSecret({})).toBe('');
  });
});

describe('parseCronBearerToken', () => {
  it('reads the token of a Bearer header, whatever the scheme case and spacing', () => {
    expect(parseCronBearerToken('Bearer abc')).toBe('abc');
    expect(parseCronBearerToken('bearer    abc  ')).toBe('abc');
    expect(parseCronBearerToken('Bearer two words')).toBe('two words');
  });

  it('refuses anything else', () => {
    for (const header of [null, undefined, '', 'Bearer', 'Bearer   ', 'Basic abc', 'abc', 'Bearerabc']) {
      expect(parseCronBearerToken(header)).toBeNull();
    }
  });
});

describe('cronBearerMatches', () => {
  it('matches exactly the secret', () => {
    expect(cronBearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    for (const header of ['Bearer s3cre', 'Bearer s3cret!', 'Bearer S3CRET', 'Basic s3cret', 's3cret', null]) {
      expect(cronBearerMatches(header, 's3cret')).toBe(false);
    }
  });

  it('never matches an empty secret (no "Bearer undefined" or blank bearer gets through)', () => {
    for (const header of ['Bearer undefined', 'Bearer ', 'Bearer', '', null]) {
      expect(cronBearerMatches(header, '')).toBe(false);
    }
  });

  it('compares two SHA-256 digests in constant time, whatever the lengths', () => {
    crypto.timingSafeEqual.mockClear();
    expect(cronBearerMatches('Bearer x', 'a-much-longer-secret-than-the-token')).toBe(false);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
    const [presented, expected] = crypto.timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
    expect(presented).toHaveLength(32);
    expect(expected).toHaveLength(32);
  });
});

describe('isCronRequestAuthorized', () => {
  it("fails closed without a secret under the 'deny' policy (sandbox reset)", () => {
    for (const env of [{}, { CRON_SECRET: '' }, { CRON_SECRET: '  ' }]) {
      expect(isCronRequestAuthorized(withAuthorization(), { whenUnset: 'deny' }, env)).toBe(false);
      expect(isCronRequestAuthorized(withAuthorization('Bearer undefined'), { whenUnset: 'deny' }, env)).toBe(false);
      expect(isCronRequestAuthorized(withAuthorization('Bearer '), { whenUnset: 'deny' }, env)).toBe(false);
    }
  });

  it("stays open without a secret under the 'allow' policy (FX sync)", () => {
    expect(isCronRequestAuthorized(withAuthorization(), { whenUnset: 'allow' }, {})).toBe(true);
    expect(isCronRequestAuthorized(withAuthorization('Bearer anything'), { whenUnset: 'allow' }, { CRON_SECRET: ' ' })).toBe(true);
  });

  it('requires the bearer once the secret is set, under either policy', () => {
    const env = { CRON_SECRET: ' s3cret ' };
    for (const whenUnset of ['deny', 'allow'] as const) {
      expect(isCronRequestAuthorized(withAuthorization('Bearer s3cret'), { whenUnset }, env)).toBe(true);
      expect(isCronRequestAuthorized(withAuthorization('Bearer wrong'), { whenUnset }, env)).toBe(false);
      expect(isCronRequestAuthorized(withAuthorization(), { whenUnset }, env)).toBe(false);
    }
  });

  it('keeps short secrets working (no minimum length on these routes)', () => {
    expect(isCronRequestAuthorized(withAuthorization('Bearer abc'), { whenUnset: 'deny' }, { CRON_SECRET: 'abc' })).toBe(true);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('CRON_SECRET', 'from-process-env');
    try {
      expect(isCronRequestAuthorized(withAuthorization('Bearer from-process-env'), { whenUnset: 'deny' })).toBe(true);
      expect(isCronRequestAuthorized(withAuthorization('Bearer other'), { whenUnset: 'deny' })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('no plain bearer comparison in the app', () => {
  // A string comparison of the Authorization header with `Bearer ${secret}` is what the sandbox
  // reset and the FX sync used before this helper; it leaks the secret through timing.
  const APP_DIR = path.resolve(__dirname, '../..');
  const PLAIN_COMPARE = [
    /[!=]==?\s*`Bearer \$\{/,
    /`Bearer \$\{[^`]*\}`\s*[!=]==?/,
    /[!=]==?\s*['"]Bearer ['"]\s*\+/,
    /['"]Bearer ['"]\s*\+\s*[\w.$?[\]'"]+\s*[!=]==?/,
  ];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('finds the scheduled routes it guards', () => {
    const files = sourceFiles(path.join(APP_DIR, 'app', 'api', 'cron')).map((file) => path.basename(path.dirname(file)));
    expect(files).toEqual(expect.arrayContaining(['reset-sandbox', 'sync-currencies']));
  });

  it('compares a bearer only through a constant-time helper', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'lib', 'components']) {
      for (const file of sourceFiles(path.join(APP_DIR, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('Bearer ')) continue;
        for (const pattern of PLAIN_COMPARE) {
          if (pattern.test(text)) offenders.push(`${path.relative(APP_DIR, file)} ~ ${pattern}`);
        }
      }
    }
    expect(offenders, 'use isCronRequestAuthorized() from lib/cron/cron-secret').toEqual([]);
  });
});
