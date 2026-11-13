#!/usr/bin/env node
/**
 * The affiliate payout scheduler lives in the app: apps/nextblock/tools/schedule-affiliate-payouts.js,
 * so every scaffolded project ships `npm run affiliates:schedule-payouts` (the root script runs
 * that file too). This path keeps `node tools/scripts/schedule-affiliate-payouts.js …` working from
 * the repo root; the script reads `.env.local` from the directory it runs in.
 */
const path = require('path');

// Resolved at run time: the file belongs to another Nx project (the app).
const scheduler = require(path.join(__dirname, '..', '..', 'apps', 'nextblock', 'tools', 'schedule-affiliate-payouts.js'));

module.exports = scheduler;

if (require.main === module) {
  scheduler.runCli();
}
