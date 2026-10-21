#!/usr/bin/env node
// Claude Code Stop hook (.claude/settings.json): before a Claude session in this repository
// finishes a turn with code changes, run the static security checks (`npm run security:check`)
// and, if they fail, send Claude back to fix them instead of handing broken security work to
// the user. CI (.github/workflows/security.yml) runs the same checks after a push; this catches
// them before the commit.
//
// Cheap when idle: it does nothing unless app, lib, tooling or migration files differ from HEAD,
// and it remembers the last change set that passed (a hash in .git/), so a turn that changed
// nothing new costs one `git` call. It never blocks twice in a row (`stop_hook_active`), so a
// check Claude cannot fix ends in a visible warning instead of a loop.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PATHSPECS = ['apps/nextblock', 'libs', 'tools', '.github/workflows', 'package.json'];
const CHECK_FILES = [
  'tools/scripts/service-role-boundary.test.ts',
  'tools/scripts/migration-grants.test.ts',
  'tools/scripts/run-security-verify.test.ts',
  'apps/nextblock/tools/lib/migrate-core.test.mjs',
];

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** A hash of every relevant change (tracked diff + untracked file contents), or null when there is none. */
function changeSetHash() {
  const diff = git(['diff', 'HEAD', '--', ...PATHSPECS]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...PATHSPECS]);
  if (diff === null || untracked === null) return null;
  const files = untracked.split('\n').filter(Boolean);
  if (!diff.trim() && files.length === 0) return null;
  const hash = createHash('sha256').update(diff);
  for (const file of files.sort()) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(readFileSync(path.join(repoRoot, file)));
    } catch {
      // deleted between the listing and the read
    }
  }
  return hash.digest('hex');
}

function main() {
  const input = readStdin();
  const gitDir = git(['rev-parse', '--absolute-git-dir'])?.trim();
  if (!gitDir) return; // not a checkout: nothing to guard
  const stampFile = path.join(gitDir, 'claude-security-check.pass');

  const hash = changeSetHash();
  if (!hash) return;
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === hash) return;

  const vitest = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) return; // dependencies not installed; CI still runs the checks
  const run = spawnSync(process.execPath, [vitest, 'run', ...CHECK_FILES], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });

  if (run.status === 0) {
    writeFileSync(stampFile, `${hash}\n`);
    return;
  }

  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const failures = output
    .split('\n')
    .filter((line) => /FAIL|AssertionError|✗|×|Error:|^\s*[+-]\s+"/.test(line))
    .slice(0, 60)
    .join('\n');
  const summary = failures || output.slice(-3000);

  if (input.stop_hook_active) {
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          'Security checks (npm run security:check) are still failing after a retry. Do not commit until they pass. See .claude/skills/nextblock-security/SKILL.md.',
      }),
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'The repository security checks failed (npm run security:check). If a failure comes from your changes, fix the cause, not the test: ' +
        'load the nextblock-security skill (.claude/skills/nextblock-security/SKILL.md) for what each check guards. ' +
        'If the failing tests or files are ones you did not change, another session sharing this checkout may be mid-change: ' +
        'do not edit, weaken or skip them; say in your reply which checks fail and that they are not yours. Failures:\n' +
        summary,
    }),
  );
}

main();
