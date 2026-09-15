#!/usr/bin/env node
/**
 * Rewrites the repo-root `vercel.json` with the sandbox-only cron added.
 *
 * Master ships a cron-free `vercel.json` because that file reaches every Vercel 1-click
 * install and a Hobby account fails the deployment on any schedule more frequent than
 * once a day. The public sandbox (Vercel Pro) still resets every 15 minutes, so the
 * `sandbox-branch.yml` workflow runs this on a throwaway checkout and force-pushes the
 * result as the `sandbox` branch. Run it locally only to preview the output:
 *
 *   node tools/scripts/write-sandbox-vercel-config.js --print
 */
const fs = require('fs');
const path = require('path');

const SANDBOX_CRONS = [{ path: '/api/cron/reset-sandbox', schedule: '*/15 * * * *' }];

const file = path.resolve(__dirname, '..', '..', 'vercel.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));

if (Array.isArray(config.crons) && config.crons.length > 0) {
  console.error(
    'vercel.json on master must not declare crons (they ship to Hobby 1-click installs); refusing to merge.'
  );
  process.exit(1);
}

const next = { ...config, crons: SANDBOX_CRONS };
const json = `${JSON.stringify(next, null, 2)}\n`;

if (process.argv.includes('--print')) {
  process.stdout.write(json);
} else {
  fs.writeFileSync(file, json);
  console.log(`Wrote ${SANDBOX_CRONS.length} sandbox cron(s) to ${file}`);
}
