import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// docker-setup.mjs only runs its main() when executed directly (`npm run docker:setup`), so
// importing it here neither preflights Docker nor writes .env nor starts the stack.
import { TURNSTILE_TEST_KEYS, isTurnstileTestKey, resolveTurnstileKeys } from './docker-setup.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const CF_ALWAYS_PASS_SITE_KEY = '1x00000000000000000000AA';
const CF_ALWAYS_PASS_SECRET_KEY = '1x0000000000000000000000000000000AA';

describe('docker:setup Turnstile defaults', () => {
  it('writes no captcha keys on a fresh install (honeypot-only until the operator configures real keys)', () => {
    expect(resolveTurnstileKeys('')).toEqual({ siteKey: '', secretKey: '', scrubbed: [] });
  });

  it('keeps real keys already present in .env (quoted or not)', () => {
    const env = [
      'POSTGRES_PASSWORD=abc',
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAAexampleSite',
      'TURNSTILE_SECRET_KEY="0x4AAAAAAAexampleSecret"',
    ].join('\n');
    expect(resolveTurnstileKeys(env)).toEqual({
      siteKey: '0x4AAAAAAAexampleSite',
      secretKey: '0x4AAAAAAAexampleSecret',
      scrubbed: [],
    });
  });

  it("drops Cloudflare's always-pass test pair left behind by an older docker:setup", () => {
    const env = [
      'POSTGRES_PASSWORD=abc',
      `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${CF_ALWAYS_PASS_SITE_KEY}`,
      `TURNSTILE_SECRET_KEY=${CF_ALWAYS_PASS_SECRET_KEY}`,
    ].join('\r\n');
    expect(resolveTurnstileKeys(env)).toEqual({
      siteKey: '',
      secretKey: '',
      scrubbed: ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
    });
  });

  it('scrubs a single test key without touching the other value', () => {
    const env = [
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAAexampleSite',
      `TURNSTILE_SECRET_KEY=${CF_ALWAYS_PASS_SECRET_KEY}`,
    ].join('\n');
    // The site key stays and the secret goes blank, so the app fails closed ("misconfigured")
    // instead of verifying against a secret that accepts every token.
    expect(resolveTurnstileKeys(env)).toEqual({
      siteKey: '0x4AAAAAAAexampleSite',
      secretKey: '',
      scrubbed: ['TURNSTILE_SECRET_KEY'],
    });
  });

  it('recognises every documented Cloudflare test key and nothing else', () => {
    expect(TURNSTILE_TEST_KEYS).toContain(CF_ALWAYS_PASS_SITE_KEY);
    expect(TURNSTILE_TEST_KEYS).toContain(CF_ALWAYS_PASS_SECRET_KEY);
    for (const key of TURNSTILE_TEST_KEYS) expect(isTurnstileTestKey(key)).toBe(true);
    expect(isTurnstileTestKey(` ${CF_ALWAYS_PASS_SITE_KEY} `)).toBe(true);
    expect(isTurnstileTestKey('')).toBe(false);
    expect(isTurnstileTestKey(undefined)).toBe(false);
    expect(isTurnstileTestKey(null)).toBe(false);
    expect(isTurnstileTestKey('0x4AAAAAAAexampleSite')).toBe(false);
  });

  it('never falls back to a test key in the script, and the env reference ships blank keys', () => {
    const script = read('tools/scripts/docker-setup.mjs');
    // The old shape was `readEnvValue(...) || TURNSTILE_TEST_SITE_KEY`.
    expect(script).not.toMatch(/\|\|\s*TURNSTILE_TEST/);
    expect(script).not.toMatch(/\|\|\s*'[123]x0{20,}/);
    expect(script).toMatch(/TURNSTILE_SECRET_KEY=\$\{turnstile\.secretKey\}/);

    const example = read('.env.docker.example');
    expect(example).toMatch(/^NEXT_PUBLIC_TURNSTILE_SITE_KEY=$/m);
    expect(example).toMatch(/^TURNSTILE_SECRET_KEY=$/m);
  });
});

describe('docker-compose.yml host port bindings', () => {
  const compose = read('docker-compose.yml');
  // Every `ports:` entry is a quoted list item ending in `:<containerPort>`; volume mounts in this
  // file are unquoted and contain a `/`, so they never match.
  const published = [...compose.matchAll(/^\s+-\s+'([^']+)'\s*$/gm)]
    .map((m) => m[1])
    .filter((entry) => /:\d+$/.test(entry) && !entry.includes('/'));
  const LOOPBACK_PREFIX = /^\$\{[A-Z_]+_BIND_HOST:-127\.0\.0\.1\}:/;

  it('binds Postgres, MinIO (S3 + console) and Kong to loopback by default, overridable per service', () => {
    expect(compose).toContain("'${DB_BIND_HOST:-127.0.0.1}:${POSTGRES_PORT_EXTERNAL:-54322}:5432'");
    expect(compose).toContain("'${KONG_BIND_HOST:-127.0.0.1}:${KONG_HTTP_PORT:-8000}:8000'");
    expect(compose).toContain("'${MINIO_BIND_HOST:-127.0.0.1}:${MINIO_S3_PORT:-9000}:9000'");
    expect(compose).toContain("'${MINIO_BIND_HOST:-127.0.0.1}:${MINIO_CONSOLE_PORT:-9001}:9001'");
  });

  it('publishes only the app port on every interface', () => {
    expect(published).toHaveLength(5);
    const allInterfaces = published.filter((entry) => !LOOPBACK_PREFIX.test(entry));
    expect(allInterfaces).toEqual(['${APP_PORT:-3000}:3000']);
  });

  it('documents the bind-host overrides in the env reference and the Docker guide', () => {
    const example = read('.env.docker.example');
    const docs = read('docs/11-SELF-HOSTED-DOCKER.md');
    for (const name of ['DB_BIND_HOST', 'KONG_BIND_HOST', 'MINIO_BIND_HOST']) {
      expect(example).toContain(`# ${name}=127.0.0.1`);
      expect(docs).toContain(`\`${name}\``);
    }
    expect(docs).toContain('### Hardening on a public server');
    expect(docs).toMatch(/firewall/i);
  });
});
