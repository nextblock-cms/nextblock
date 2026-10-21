import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertLocalDatabaseUrl,
  expectedAssertionCount,
  parseArgs,
  summarize,
} from './run-security-verify.mjs';

describe('run-security-verify target guard', () => {
  it('accepts only this machine', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgres://postgres@localhost/postgres')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgresql://postgres@[::1]:5432/postgres')).not.toThrow();
  });

  it('refuses any remote host, the Supabase pooler included', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres')).toThrow(/Refusing/);
    expect(() => assertLocalDatabaseUrl('postgresql://postgres.abc:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toThrow(/Refusing/);
    expect(() => assertLocalDatabaseUrl('postgresql://u:p@127.0.0.1.attacker.example/db')).toThrow(/Refusing/);
    expect(() => assertLocalDatabaseUrl('host=127.0.0.1 dbname=postgres')).toThrow(/postgres/);
    expect(() => assertLocalDatabaseUrl('https://127.0.0.1/')).toThrow(/postgres/);
  });

  it('needs exactly one target', () => {
    expect(() => parseArgs([])).toThrow(/exactly one/);
    expect(() => parseArgs(['--docker', 'pg', '--db-url', 'postgresql://127.0.0.1/x'])).toThrow(/exactly one/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(parseArgs(['--docker', 'nb-redteam-pg', '--skip-grant-pass'])).toEqual({ dbUrl: null, docker: 'nb-redteam-pg', skipGrantPass: true });
  });
});

describe('run-security-verify verdict', () => {
  const output = [
    'psql:<stdin>:120: NOTICE:  PASS  first',
    'psql:<stdin>:121: NOTICE:  PASS  second',
  ].join('\n');

  it('passes only when every assertion printed PASS', () => {
    expect(summarize(output, 2).ok).toBe(true);
  });

  it('fails on a FAIL line, a psql ERROR, or an assertion that never ran', () => {
    expect(summarize(`${output}\npsql:<stdin>:122: NOTICE:  FAIL  third`, 3)).toMatchObject({ ok: false, failed: ['third'] });
    expect(summarize(`${output}\npsql:<stdin>:9: ERROR:  relation "x" does not exist`, 2).ok).toBe(false);
    expect(summarize(output, 3)).toMatchObject({ ok: false, missing: 1 });
    expect(summarize('', 0).ok).toBe(false);
  });

  it('counts the assertions of the real posture script', () => {
    const script = readFileSync(path.join(__dirname, 'security-verify.sql'), 'utf8');
    expect(expectedAssertionCount(script)).toBeGreaterThanOrEqual(84);
  });
});
