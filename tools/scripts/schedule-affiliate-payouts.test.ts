import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The installer ships with the app (apps/nextblock/tools/), so CLI-scaffolded projects have it;
// this test stays in the monorepo's tools/ (scaffolds have no vitest). Requiring the CommonJS
// script is safe: `main()` is guarded by `require.main` and the env files are only read inside
// main(), so importing here never opens a database.
const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'nextblock');
const SCRIPT = path.join(APP_DIR, 'tools', 'schedule-affiliate-payouts.js');
const scheduler = require(SCRIPT);
const {
  DEFAULT_SCHEDULE,
  JOB_NAME,
  SECRET_NAME,
  buildPrintSql,
  envFilesFor,
  isLocalDatabaseUrl,
  loadEnvFiles,
  parseArgs,
  resolveCronUrl,
  resolveSchedule,
  scheduleInputs,
} = scheduler;

const SECRET = 'a-very-long-cron-secret-value-0123456789';

type Manifest = { scripts: Record<string, string> };
const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, 'utf8')) as Manifest;

/** Every `npm run <script>` in the string literals, template text and JSX text of `dir`'s sources. */
function npmRunCommands(dir: string): Map<string, string> {
  const commands = new Map<string, string>();
  const visitFile = (file: string) => {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      let value: string | null = null;
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) value = node.text;
      else if (ts.isJsxText(node)) value = node.getText(source);
      for (const match of value?.matchAll(/npm run ([a-z0-9:_-]+)/g) ?? []) {
        commands.set(match[1] as string, path.relative(APP_DIR, file).split(path.sep).join('/'));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) visitFile(full);
    }
  };
  walk(dir);
  return commands;
}

describe('schedule-affiliate-payouts: origin guard', () => {
  it('builds the cron route URL on an https origin', () => {
    expect(resolveCronUrl('https://shop.example.com')).toBe('https://shop.example.com/api/affiliates/cron/payouts');
    expect(resolveCronUrl('https://shop.example.com/some/page?x=1')).toBe('https://shop.example.com/api/affiliates/cron/payouts');
  });

  it('accepts http only for local development hosts', () => {
    expect(resolveCronUrl('http://localhost:4200')).toBe('http://localhost:4200/api/affiliates/cron/payouts');
    expect(resolveCronUrl('http://127.0.0.1:4200')).toBe('http://127.0.0.1:4200/api/affiliates/cron/payouts');
    expect(resolveCronUrl('http://[::1]:4200')).toBe('http://[::1]:4200/api/affiliates/cron/payouts');
    expect(resolveCronUrl('http://host.docker.internal:4200')).toBe('http://host.docker.internal:4200/api/affiliates/cron/payouts');
    expect(resolveCronUrl('http://shop.localhost')).toBe('http://shop.localhost/api/affiliates/cron/payouts');
  });

  it('refuses http to any other host, credentials and other schemes', () => {
    expect(() => resolveCronUrl('http://shop.example.com')).toThrow(/Refusing http/);
    expect(() => resolveCronUrl('http://localhost.evil.com')).toThrow(/Refusing http/);
    expect(() => resolveCronUrl('https://user:pass@shop.example.com')).toThrow(/credentials/);
    expect(() => resolveCronUrl('ftp://shop.example.com')).toThrow(/https/);
    expect(() => resolveCronUrl('not a url')).toThrow(/must be a URL/);
  });
});

describe('schedule-affiliate-payouts: schedule', () => {
  it('defaults to daily at 06:00 UTC', () => {
    expect(DEFAULT_SCHEDULE).toBe('0 6 * * *');
    expect(resolveSchedule({})).toBe('0 6 * * *');
  });

  it('accepts a five-field expression or an hour', () => {
    expect(resolveSchedule({ schedule: '30  7 * * 1-5' })).toBe('30 7 * * 1-5');
    expect(resolveSchedule({ schedule: '*/30 * * * *' })).toBe('*/30 * * * *');
    expect(resolveSchedule({ hour: '4' })).toBe('0 4 * * *');
  });

  it('refuses anything else (no SQL can ride along)', () => {
    expect(() => resolveSchedule({ schedule: "0 6 * * *'; drop table x; --" })).toThrow(/five-field/);
    expect(() => resolveSchedule({ schedule: '0 6 * *' })).toThrow(/five-field/);
    expect(() => resolveSchedule({ hour: '24' })).toThrow(/--hour/);
  });
});

describe('schedule-affiliate-payouts: arguments', () => {
  it('accepts bare mode words, a bare URL and --key=value or --key value options', () => {
    const parsed = parseArgs(['https://shop.example.com', 'status', '--schedule', '0 5 * * *', '--db=postgres://x']);
    expect(parsed.positionalUrl).toBe('https://shop.example.com');
    expect([...parsed.flags]).toEqual(['status']);
    expect(parsed.options).toEqual({ schedule: '0 5 * * *', db: 'postgres://x' });
    expect([...parseArgs(['--remove']).flags]).toEqual(['remove']);
  });
});

describe('schedule-affiliate-payouts: SQL', () => {
  const inputs = () =>
    scheduleInputs({ env: { CRON_SECRET: SECRET, NEXT_PUBLIC_URL: 'https://shop.example.com' }, options: {}, positionalUrl: undefined });

  it('POSTs the route with the bearer read from Vault at run time, never embedded in the job', () => {
    const { command, cronUrl, schedule } = inputs();
    expect(cronUrl).toBe('https://shop.example.com/api/affiliates/cron/payouts');
    expect(schedule).toBe('0 6 * * *');
    expect(command).toContain('net.http_post(');
    expect(command).toContain(`where name = '${SECRET_NAME}'`);
    expect(command).toContain('timeout_milliseconds := 90000');
    expect(command).not.toContain(SECRET);
  });

  it('prints the install statements for the SQL editor', () => {
    const sql = buildPrintSql(inputs());
    expect(sql).toContain('create extension if not exists pg_cron;');
    expect(sql).toContain('create extension if not exists pg_net with schema extensions;');
    expect(sql).toContain(`select vault.create_secret('${SECRET}', '${SECRET_NAME}'`);
    expect(sql).toContain(`select cron.schedule('${JOB_NAME}', '0 6 * * *', $cmd$`);
  });

  it('requires a CRON_SECRET of 16+ characters and a site origin', () => {
    expect(() => scheduleInputs({ env: {}, options: {}, positionalUrl: 'https://shop.example.com' })).toThrow(/CRON_SECRET is not set/);
    expect(() => scheduleInputs({ env: { CRON_SECRET: 'short' }, options: {}, positionalUrl: 'https://shop.example.com' })).toThrow(
      /at least 16/
    );
    expect(() => scheduleInputs({ env: { CRON_SECRET: SECRET }, options: {}, positionalUrl: undefined })).toThrow(/No site origin/);
  });

  it('prefers --url, then the positional URL, then NEXT_PUBLIC_URL', () => {
    const env = { CRON_SECRET: SECRET, NEXT_PUBLIC_URL: 'https://env.example.com' };
    expect(scheduleInputs({ env, options: { url: 'https://flag.example.com' }, positionalUrl: 'https://arg.example.com' }).cronUrl).toBe(
      'https://flag.example.com/api/affiliates/cron/payouts'
    );
    expect(scheduleInputs({ env, options: {}, positionalUrl: 'https://arg.example.com' }).cronUrl).toBe(
      'https://arg.example.com/api/affiliates/cron/payouts'
    );
  });

  it('uses TLS for every database but a local one', () => {
    expect(isLocalDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://postgres:x@db.abcdefghijkl.supabase.co:5432/postgres')).toBe(false);
  });
});

describe('schedule-affiliate-payouts: env files', () => {
  it('reads .env.local, then .env, from the directory it runs in (the project root under npm run)', () => {
    const project = path.resolve(tmpdir(), 'some-shop');
    expect(envFilesFor(project)).toEqual([path.join(project, '.env.local'), path.join(project, '.env')]);
  });

  it('loads them without overriding the environment, and not from the script folder', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'schedule-payouts-env-'));
    const keys = ['NB_SCHEDULER_TEST_A', 'NB_SCHEDULER_TEST_B', 'NB_SCHEDULER_TEST_C'] as const;
    writeFileSync(path.join(project, '.env.local'), 'NB_SCHEDULER_TEST_A=local\nNB_SCHEDULER_TEST_B=local\n');
    writeFileSync(path.join(project, '.env'), 'NB_SCHEDULER_TEST_A=env\nNB_SCHEDULER_TEST_C=env\n');
    process.env['NB_SCHEDULER_TEST_B'] = 'preset';
    try {
      expect(loadEnvFiles(project)).toEqual([path.join(project, '.env.local'), path.join(project, '.env')]);
      expect(process.env['NB_SCHEDULER_TEST_A']).toBe('local');
      expect(process.env['NB_SCHEDULER_TEST_B']).toBe('preset');
      expect(process.env['NB_SCHEDULER_TEST_C']).toBe('env');
      // A directory without env files loads nothing (the script's own folder is never consulted).
      expect(loadEnvFiles(path.join(project, 'missing'))).toEqual([]);
    } finally {
      for (const key of keys) delete process.env[key];
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('schedule-affiliate-payouts: ships with the app', () => {
  const appManifest = readManifest(path.join(APP_DIR, 'package.json'));

  it('is a script of the app manifest, which the CLI template and npm run update copy', () => {
    expect(appManifest.scripts['affiliates:schedule-payouts']).toBe('node tools/schedule-affiliate-payouts.js');
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('keeps the monorepo root command, and the old path, on the same file', () => {
    expect(readManifest(path.join(REPO_ROOT, 'package.json')).scripts['affiliates:schedule-payouts']).toBe(
      'node apps/nextblock/tools/schedule-affiliate-payouts.js'
    );
    expect(require('./schedule-affiliate-payouts.js')).toBe(scheduler);
  });

  it('lists every app script in FRAMEWORK_SCRIPTS, so npm run update brings it to existing projects', () => {
    // update.mjs runs main() on import, so read the array from its source.
    const updateSource = readFileSync(path.join(APP_DIR, 'tools', 'update.mjs'), 'utf8');
    const block = /const FRAMEWORK_SCRIPTS = \[([\s\S]*?)\];/.exec(updateSource)?.[1] ?? '';
    const frameworkScripts = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
    expect(frameworkScripts).toContain('build');
    expect(Object.keys(appManifest.scripts).filter((script) => !frameworkScripts.includes(script))).toEqual([]);
  });

  it('backs every npm command the CMS affiliates screens tell an operator to run', () => {
    const commands = npmRunCommands(path.join(APP_DIR, 'app', 'cms', 'affiliates'));
    expect([...commands.keys()]).toContain('affiliates:schedule-payouts');
    const missing = [...commands].filter(([script]) => !(script in appManifest.scripts)).map(([script, file]) => `${file}: npm run ${script}`);
    expect(missing, 'a standalone project only has the scripts of apps/nextblock/package.json').toEqual([]);
  });
});
