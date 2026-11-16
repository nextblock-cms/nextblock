// The `create` command (the CLI's default) and its flags, defined once for `bin/create-nextblock.js`
// and for the tests that parse real argv through commander (`create-command.test.js`).

import { mergeHeadlessOptions, readExplicitHeadlessOptions } from './headless.js';

/**
 * Register `create [project-directory]` on `program`. `action(projectDirectory, options)` receives
 * the options as the run should use them: the flags the user passed, with the NEXTBLOCK_* variables
 * filling whatever they left out once headless mode is on (`mergeHeadlessOptions`). Values
 * commander fills in itself never count as passed: it gives `--no-trial` a default of
 * `trial: true`, which used to hide NEXTBLOCK_TRIAL=false (`readExplicitHeadlessOptions`).
 */
export function defineCreateCommand(program, action, { env = process.env } = {}) {
  return program
    .command('create [project-directory]', { isDefault: true })
    .description('Bootstrap a NextBlock™ CMS project')
    .option('--skip-install', 'Skip installing dependencies')
    .option('-y, --yes', 'Skip all interactive prompts and use defaults')
    .option(
      '--non-interactive',
      'Headless run for coding agents: no prompts, JSON result on stdout, JSON errors on stderr. Requires --name and --email.',
    )
    .option('--name <name>', 'Your full name (headless: first administrator and trial owner)')
    .option('--email <email>', 'Your email address (headless: first administrator and trial owner)')
    .option('--mode <mode>', 'Headless hosting profile: docker (default) or cloud')
    .option('--project-name <name>', 'Project directory name (same as the positional argument)')
    .option('--license-key <key>', 'Headless: activate this NextBlock package key instead of provisioning a trial')
    .option('--no-trial', 'Headless: do not request a Cortex AI trial key (or set NEXTBLOCK_TRIAL=false)')
    .action((projectDirectory, _options, command) =>
      action(projectDirectory, mergeHeadlessOptions(readExplicitHeadlessOptions(command), env)),
    );
}
