import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { defineCreateCommand } from './create-command.js';
import { readExplicitHeadlessOptions, validateHeadlessOptions } from './headless.js';

/**
 * The `create` command through real commander parsing (the CLI's own definition), not just
 * `mergeHeadlessOptions`. Review 2026-11-13 (L6): commander gives `--no-trial` a default of
 * `trial: true`, and the merge applied NEXTBLOCK_TRIAL only to an undefined `trial`, so
 * NEXTBLOCK_TRIAL=false never turned the trial off.
 */

const UNATTENDED = ['my-site', '--non-interactive', '--name', 'Ada Lovelace', '--email', 'ada@example.com'];

/** Parse argv the way `bin/create-nextblock.js` does and return what its handler receives. */
async function parse(args, env = {}) {
  const program = new Command().exitOverride();
  let received = null;

  defineCreateCommand(
    program,
    (projectDirectory, options) => {
      received = { options, projectDirectory };
    },
    { env },
  );
  await program.parseAsync(['node', 'create-nextblock', ...args]);

  return received;
}

/** Whether the headless run would ask the vendor for a trial key. */
async function requestsTrial(args, env = {}) {
  const { options, projectDirectory } = await parse(args, env);
  const validation = validateHeadlessOptions({ ...options, projectDirectory });

  expect(validation.ok).toBe(true);
  return validation.value.trial;
}

describe('NEXTBLOCK_TRIAL through real commander parsing', () => {
  it.each(['false', '0', 'no', 'off', 'FALSE'])('NEXTBLOCK_TRIAL=%s turns the trial off', async (value) => {
    const { options } = await parse(UNATTENDED, { NEXTBLOCK_TRIAL: value });

    expect(options.trial).toBe(false);
    expect(await requestsTrial(UNATTENDED, { NEXTBLOCK_TRIAL: value })).toBe(false);
  });

  it('requests the trial when neither the flag nor the variable says otherwise', async () => {
    const { options } = await parse(UNATTENDED);

    expect(options.trial).toBeUndefined();
    expect(await requestsTrial(UNATTENDED)).toBe(true);
    expect(await requestsTrial(UNATTENDED, { NEXTBLOCK_TRIAL: 'true' })).toBe(true);
    expect(await requestsTrial(UNATTENDED, { NEXTBLOCK_TRIAL: 'maybe' })).toBe(true);
  });

  it('an explicit --no-trial still wins, whatever the variable says', async () => {
    for (const env of [{}, { NEXTBLOCK_TRIAL: 'true' }, { NEXTBLOCK_TRIAL: '1' }, { NEXTBLOCK_TRIAL: 'false' }]) {
      const { options } = await parse([...UNATTENDED, '--no-trial'], env);
      expect(options.trial, JSON.stringify(env)).toBe(false);
      expect(await requestsTrial([...UNATTENDED, '--no-trial'], env), JSON.stringify(env)).toBe(false);
    }
  });

  it('applies when the variables alone switch headless mode on (the PowerShell path)', async () => {
    const { options, projectDirectory } = await parse(['my-site'], {
      NEXTBLOCK_EMAIL: 'ada@example.com',
      NEXTBLOCK_NAME: 'Ada Lovelace',
      NEXTBLOCK_NON_INTERACTIVE: '1',
      NEXTBLOCK_TRIAL: 'false',
    });

    expect(projectDirectory).toBe('my-site');
    expect(options).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace', nonInteractive: true, trial: false });
  });

  it('never touches an interactive run, and flags still beat the other variables', async () => {
    expect((await parse(['my-site', '--yes'], { NEXTBLOCK_TRIAL: 'false', NEXTBLOCK_EMAIL: 'x@example.com' })).options).toEqual({ yes: true });

    const { options } = await parse([...UNATTENDED, '--mode', 'cloud'], { NEXTBLOCK_MODE: 'docker', NEXTBLOCK_NAME: 'Env Name' });
    expect(options).toMatchObject({ mode: 'cloud', name: 'Ada Lovelace' });
  });
});

describe('readExplicitHeadlessOptions', () => {
  it('drops the values commander filled in for options the environment can fill, and keeps every passed value', async () => {
    const program = new Command().exitOverride();
    const command = program
      .command('create [dir]', { isDefault: true })
      .option('--no-trial')
      .option('--port <port>', 'not a headless option', '3000')
      .action(() => undefined);

    await program.parseAsync(['node', 'cli', 'site']);
    expect(command.opts()).toEqual({ port: '3000', trial: true });
    expect(readExplicitHeadlessOptions(command)).toEqual({ port: '3000' });

    await program.parseAsync(['node', 'cli', 'site', '--no-trial', '--port', '4000']);
    expect(readExplicitHeadlessOptions(command)).toEqual({ port: '4000', trial: false });
  });
});
