const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { assertProjectRef, genTypesArgs, isStaleCliRefusal, supabaseCliInvocation } = require('./lib/supabase-cli');

// Load env from monorepo root .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });

const PROJECT_ID = process.env.SUPABASE_PROJECT_ID || process.env.NEXT_PUBLIC_SUPABASE_PROJECT_ID;
const OUTPUT_PATH = path.resolve(process.cwd(), 'libs/db/src/lib/supabase/types.ts');

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main() {
  if (!PROJECT_ID) {
    console.error('Error: SUPABASE_PROJECT_ID is not set in .env.local');
    process.exit(1);
  }

  let args;
  let cli;
  try {
    // `gen types --remote=<ref>`, run from the repo root with no --workdir: CLI 3 reads the LOCAL
    // database when no target is given, and with no link in the current directory it generates
    // through the Management API, as CLI 2's `--project-id` did (lib/supabase-cli.js).
    assertProjectRef(PROJECT_ID);
    args = genTypesArgs({ projectRef: PROJECT_ID });
    // No shell: the CLI's Node entry under this Node (supabaseCliInvocation).
    cli = supabaseCliInvocation({ from: process.cwd() });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  console.log(`Generating Supabase types for project '${PROJECT_ID}'...`);

  const result = spawnSync(cli.command, [...cli.prefix, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    console.error('Failed to generate types via Supabase CLI.');
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (isStaleCliRefusal(output)) {
      console.error('This Supabase CLI predates 3.0 (no --remote). Run `npm ci` to install the version package.json pins.');
    }
    console.error(result.stderr || (result.error && result.error.message) || '');
    process.exit(result.status || 1);
  }

  // Stdout is the TypeScript; the CLI's `Target: project <ref>` line goes to stderr. Refuse
  // anything that is not a types file rather than overwrite types.ts with it.
  if (!/export type Database\b/.test(result.stdout || '')) {
    console.error('The Supabase CLI printed no `Database` type; types.ts was left unchanged.');
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  try {
    ensureDirFor(OUTPUT_PATH);
    fs.writeFileSync(OUTPUT_PATH, result.stdout, 'utf8');
    console.log(`Types written to ${OUTPUT_PATH}`);
  } catch (e) {
    console.error(`Failed to write types to ${OUTPUT_PATH}`);
    console.error(e.message);
    process.exit(1);
  }
}

main();
