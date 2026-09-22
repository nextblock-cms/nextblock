import chalk from 'chalk';

// NextBlock configuration moved from the terminal to the browser-based First-Boot
// Setup Wizard at /setup. This script no longer prompts for credentials — it just
// points you at the right place. (Self-hosted Docker still has a one-command,
// non-interactive bootstrap: `npm run docker:setup`.)

// `npx nx serve nextblock` runs `next dev --port 4200` (apps/nextblock/project.json).
const DEFAULT_LOCAL_URL = 'http://localhost:4200';

console.log(chalk.bold.green('🚀 NextBlock™ CMS Setup'));
console.log('');
console.log(
  chalk.gray('Configuration now happens in your browser — there are no terminal questions.')
);
console.log('');
console.log(chalk.bold('Cloud / local development'));
console.log(`  1. Start the app:   ${chalk.cyan('npx nx serve nextblock')}`);
console.log(`  2. Open:            ${chalk.cyan(DEFAULT_LOCAL_URL + '/setup')}`);
console.log(
  chalk.gray(
    '     The First-Boot Setup Wizard connects Supabase, configures storage / email,'
  )
);
console.log(
  chalk.gray(
    '     and creates your first administrator. A fresh instance redirects to /setup'
  )
);
console.log(chalk.gray('     automatically until an admin exists.'));
console.log('');
console.log(chalk.bold('Self-hosted Docker') + chalk.gray('  (one command, no cloud accounts)'));
console.log(
  `  ${chalk.cyan('npm run docker:setup')}   ${chalk.gray('# generates secrets + boots the stack, then open /setup')}`
);
console.log('');
console.log(
  chalk.gray(
    'Full guide: docs/05-DEVELOPER-GUIDE.md · Vercel one-click: docs/12-VERCEL-DEPLOYMENT.md'
  )
);
console.log('');
