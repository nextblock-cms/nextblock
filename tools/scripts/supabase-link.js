#!/usr/bin/env node
'use strict';

/**
 * Runs `supabase link` for SUPABASE_PROJECT_ID (from .env.local, loaded by `npm run db:link`).
 *
 * Supabase CLI 3's `link` never connects to the database, ignores `--password` (and warns about
 * it), and writes only libs/db/src/supabase/.temp/. It authenticates with SUPABASE_ACCESS_TOKEN or
 * a `supabase login`. The ref is validated first: CLI 3 looks any value that is not 20 lowercase
 * letters up as a branch name of the project the directory is already linked to.
 */

const { spawnSync } = require('node:child_process');
const { assertProjectRef, linkArgs, supabaseCliInvocation } = require('./lib/supabase-cli');

const { SUPABASE_PROJECT_ID } = process.env;

if (!SUPABASE_PROJECT_ID) {
  console.error('Missing SUPABASE_PROJECT_ID environment variable.');
  process.exit(1);
}

let cli;
try {
  assertProjectRef(SUPABASE_PROJECT_ID);
  // No shell: the CLI's Node entry under this Node (lib/supabase-cli.js → supabaseCliInvocation).
  cli = supabaseCliInvocation({ from: process.cwd() });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const args = [...cli.prefix, ...linkArgs({ workdir: 'libs/db/src', projectRef: SUPABASE_PROJECT_ID })];

const result = spawnSync(cli.command, args, { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
