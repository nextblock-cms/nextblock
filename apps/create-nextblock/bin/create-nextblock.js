#!/usr/bin/env node

import * as clack from '@clack/prompts';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import { program } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import {
  DEFAULT_LICENSE_SERVICE_URL,
  HeadlessError,
  SWALLOWED_FLAGS_ERROR,
  bootstrapInstance,
  checkDockerAvailable,
  detectSwallowedHeadlessFlags,
  emitJsonError,
  emitJsonResult,
  generateAdminPassword,
  generateMcpBearerToken,
  mergeHeadlessOptions,
  readEnvFile,
  requestTrialLicense,
  resolveAppUrlFromEnv,
  summarizeReadiness,
  upsertEnvFile,
  validateHeadlessOptions,
  waitForReadiness,
  writeAgentGuardrails,
  writeAgentMcpConfigs,
} from './lib/headless.js';
import { patchNextConfigForStandalone } from './lib/next-config.js';
import { STANDALONE_ESLINT_CONFIG } from './lib/eslint-config.js';
import { FALLBACK_OVERRIDES } from './lib/fallback-overrides.js';

const DEFAULT_PROJECT_NAME = 'nextblock-cms';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_DIR = resolve(__dirname, '../templates/nextblock-template');
const REPO_ROOT = resolve(__dirname, '../../..');
const EDITOR_UTILS_SOURCE_DIR = resolve(REPO_ROOT, 'libs/editor/src/lib/utils');
const IS_WINDOWS = process.platform === 'win32';
const CLI_VERSION = createRequire(import.meta.url)('../package.json').version;

const UI_PROXY_MODULES = [
  'avatar',
  'badge',
  'button',
  'card',
  'checkbox',
  'ColorPicker',
  'ConfirmationDialog',
  'CustomSelectWithInput',
  'dialog',
  'dropdown-menu',
  'input',
  'label',
  'popover',
  'progress',
  'select',
  'separator',
  'Skeleton',
  'table',
  'textarea',
  'tooltip',
  'ui',
];

const PACKAGE_VERSION_SOURCES = {
  '@nextblock-cms/ui': resolve(REPO_ROOT, 'libs/ui/package.json'),
  '@nextblock-cms/utils': resolve(REPO_ROOT, 'libs/utils/package.json'),
  '@nextblock-cms/db': resolve(REPO_ROOT, 'libs/db/package.json'),
  '@nextblock-cms/editor': resolve(REPO_ROOT, 'libs/editor/package.json'),
  '@nextblock-cms/sdk': resolve(REPO_ROOT, 'libs/sdk/package.json'),
  '@nextblock-cms/cortex': resolve(REPO_ROOT, 'libs/cortex/package.json'),
};

program
  .name('create-nextblock')
  .description('NextBlock™ CMS CLI')
  .version(CLI_VERSION, '-v, --version');

program
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
  .option('--no-trial', 'Headless: do not request a Cortex AI trial key')
  .action(handleCommand);

program
  .command('activate [module]')
  .description('Activate a premium NextBlock™ CMS module')
  .action(handleActivateCommand);

await program.parseAsync(process.argv).catch((error) => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});

async function handleCommand(projectDirectory, rawOptions) {
  // NEXTBLOCK_* variables are the shell-proof form of the headless flags (PowerShell
  // strips the `--` that `npm create nextblock -- --flag` depends on).
  const options = mergeHeadlessOptions(rawOptions, process.env);

  if (options.nonInteractive) {
    return handleHeadlessCommand(projectDirectory, options);
  }

  if (detectSwallowedHeadlessFlags(process.env)) {
    // npm ate the flag; an agent must not be dropped into interactive prompts silently.
    emitJsonError(SWALLOWED_FLAGS_ERROR);
    process.exit(1);
  }

  const { skipInstall, yes } = options;

  try {
    console.log(chalk.bold.cyan(`\n🧱 create-nextblock v${CLI_VERSION}\n`));

    // Pick the hosting profile up front (interactive only). Cloud = Vercel + Supabase Cloud;
    // Docker = a fully local self-hosted sandbox that needs no cloud accounts.
    let hostingMode = 'cloud';
    if (!yes) {
      const modeChoice = await clack.select({
        message: 'Select your target hosting environment profile:',
        options: [
          { value: 'cloud', label: 'Managed Cloud Mode (Vercel + Supabase Cloud)' },
          {
            value: 'docker',
            label: 'Local Self-Hosted Docker Mode (One-Click Local Sandbox)',
          },
        ],
        initialValue: 'cloud',
      });
      if (clack.isCancel(modeChoice)) {
        handleWizardCancel('Setup cancelled.');
      }
      hostingMode = modeChoice;
    }

    // Cloud / local configuration moved to the browser First-Boot Setup Wizard (/setup), so the
    // CLI no longer asks for Supabase / R2 / SMTP credentials here. Docker still preflights below.
    if (!yes && hostingMode === 'docker') {
      clack.note(
        [
          'Local Self-Hosted Docker Mode runs everything on your machine — no cloud accounts needed.',
          '',
          'Requirement:',
          '  • Docker Desktop installed and running  (https://www.docker.com/products/docker-desktop)',
          '',
          'Optional (you can skip both at the prompts):',
          '  • Cloudflare Turnstile keys (bot protection)',
          '  • SMTP credentials (otherwise sign-ups auto-confirm with no email)',
        ].join('\n'),
        'One-click local sandbox',
      );

      const ready = await clack.confirm({
        message: 'Is Docker Desktop installed and running?',
        initialValue: true,
      });
      if (clack.isCancel(ready)) {
        handleWizardCancel('Setup cancelled.');
      }
      if (!ready) {
        clack.note(
          'No problem — nothing was created. Install & start Docker Desktop, then run\n`npm create nextblock` again.',
          'Come back when ready',
        );
        return;
      }
    }

    let projectName = projectDirectory;

    if (!projectName) {
      if (yes) {
        projectName = DEFAULT_PROJECT_NAME;
        console.log(
          chalk.blue(
            `Using default project name because --yes was provided: ${projectName}`,
          ),
        );
      } else {
        const projectPrompt = await clack.text({
          message: 'What is your project named?',
          initialValue: DEFAULT_PROJECT_NAME,
          validate: (value) =>
            !value ? 'Project name is required' : undefined,
        });
        if (clack.isCancel(projectPrompt)) {
          handleWizardCancel('Setup cancelled.');
        }

        projectName = projectPrompt.trim() || DEFAULT_PROJECT_NAME;
      }
    }

    const projectDir = resolve(process.cwd(), projectName);
    await ensureEmptyDirectory(projectDir);

    console.log(chalk.green(`Project name: ${projectName}`));
    console.log(
      chalk.blue(
        `Options: skipInstall=${skipInstall ? 'true' : 'false'}, yes=${yes ? 'true' : 'false'}`,
      ),
    );

    await scaffoldProject(projectDir, { skipInstall, log: console.log });

    // Run the post-scaffold flow after dependencies are installed so package assets are available.
    // Docker boots the local stack; everything else just materializes Supabase assets and points
    // the user at the browser First-Boot Setup Wizard at /setup (no terminal credential prompts).
    if (!yes && hostingMode === 'docker') {
      await runDockerSetup(projectDir, projectName);
    } else {
      await runCloudScaffold(projectDir, projectName);
    }
  } catch (error) {
    console.error(
      chalk.red(
        error instanceof Error ? error.message : 'An unexpected error occurred',
      ),
    );
    process.exit(1);
  }
}

/**
 * The scaffold pipeline shared by the interactive and headless flows: copy the template,
 * apply the standalone-project transforms, and install. `log` receives every progress
 * line so the headless flow can route it to stderr and keep stdout for its JSON result.
 */
async function scaffoldProject(projectDir, { skipInstall = false, log = console.log } = {}) {
  log(chalk.blue('Copying project files...'));
  await copyTemplateTo(projectDir);
  log(chalk.green('Template copied successfully.'));

  await removeBackups(projectDir);

  await ensureClientComponents(projectDir);
  log(chalk.green('Client component directives applied.'));

  await ensureClientProviders(projectDir);
  log(chalk.green('Client provider wrappers configured.'));

  await sanitizeBlockEditorImports(projectDir);
  log(chalk.green('Block editor imports sanitized.'));

  await sanitizeUiImports(projectDir);
  log(chalk.green('UI component imports normalized.'));

  await ensureUiProxies(projectDir);
  log(chalk.green('UI proxy modules generated.'));

  const editorUtilNames = await ensureEditorUtils(projectDir);
  if (editorUtilNames.length > 0) {
    log(chalk.green('Editor utility shims generated.'));
  }

  await ensureGitignore(projectDir);
  log(chalk.green('.gitignore ready.'));

  await ensureEnvExample(projectDir);
  log(chalk.green('.env.example ready.'));

  await sanitizeLayout(projectDir);
  log(chalk.green('Global styles configured.'));

  await sanitizeTailwindConfig(projectDir);
  log(chalk.green('tailwind.config.js sanitized.'));

  await normalizeTsconfig(projectDir);
  log(chalk.green('tsconfig.json normalized.'));

  await sanitizeNextConfig(projectDir);
  log(chalk.green('next.config.js sanitized.'));

  await writeStandaloneEslintConfig(projectDir);
  log(chalk.green('eslint.config.mjs ready.'));

  await transformPackageJson(projectDir);
  log(chalk.green('Dependencies updated for public packages.'));

  await ensurePublicNpmrc(projectDir);
  log(chalk.green('Enforced public registry for initial install.'));

  // Keep `.env*` out of coding agents' context on every scaffold (Claude Code permission
  // deny rules + .cursorignore). Harmless without an agent; essential with one.
  await writeAgentGuardrails(projectDir);
  log(chalk.green('Agent guardrails written (.claude/settings.json, .cursorignore).'));

  await initializeGit(projectDir, { log });

  if (!skipInstall) {
    await installDependencies(projectDir, { log });
  } else {
    log(chalk.yellow('Skipping dependency installation.'));
  }
}

/**
 * `create-nextblock --non-interactive`: the agent-driven path.
 *
 * Contract: progress goes to stderr; success prints ONE JSON document on stdout; any
 * failure prints ONE JSON document on stderr and exits 1. Secrets never appear in either.
 *
 * Docker mode (default) boots the whole stack, waits for `/api/setup/status`, creates the
 * first administrator through `/api/setup/bootstrap`, and writes the MCP client configs
 * so the agent's next session can mutate the site. Cloud mode stops after scaffolding and
 * hands the Supabase connection to the browser wizard at /setup.
 */
async function handleHeadlessCommand(projectDirectory, options) {
  const validation = validateHeadlessOptions({
    ...options,
    defaultProjectName: DEFAULT_PROJECT_NAME,
    projectDirectory,
  });

  if (!validation.ok) {
    emitJsonError(validation.error);
    process.exit(1);
  }

  const { attended, email, licenseKey: providedLicenseKey, mode, name, projectName, trial } = validation.value;
  const log = (message) => process.stderr.write(`${message}\n`);
  const serviceUrl = (process.env.NEXTBLOCK_LICENSE_SERVICE_URL || DEFAULT_LICENSE_SERVICE_URL).trim();

  // Attended mode (no --name/--email): the human creates the administrator and starts the
  // free Cortex AI trial in the browser — a real Freemius trial with its reminder emails —
  // and the agent polls /api/setup/status until "mcpReady". Nothing personal passes
  // through the agent. Unattended mode (both given) does it all headlessly instead.
  const handoffSteps = (appUrl, statusUrl) => [
    `Tell the user to open ${appUrl}/setup in a browser and create their administrator account (their own name, email and password).`,
    `On the welcome screen that follows, the user starts the free 30-day Cortex AI trial (no credit card). That unlocks the MCP server for you.`,
    `Meanwhile poll GET ${statusUrl} until "mcpReady" is true, then restart your session so it loads .mcp.json / .cursor/mcp.json and call tools/list on the "nextblock" MCP server.`,
  ];

  try {
    log(
      chalk.bold.cyan(
        `create-nextblock v${CLI_VERSION} — headless ${mode} install (${attended ? 'attended: the user finishes setup in the browser' : 'unattended'})`,
      ),
    );

    if (mode === 'docker') {
      const docker = checkDockerAvailable();
      if (!docker.ok) {
        throw new HeadlessError('DOCKER_UNAVAILABLE', docker.message, {
          hint: 'Start Docker Desktop and retry, or pass --mode cloud to hand off to the browser setup wizard.',
        });
      }
    }

    const projectDir = resolve(process.cwd(), projectName);

    try {
      await ensureEmptyDirectory(projectDir);
    } catch (error) {
      throw new HeadlessError('DIRECTORY_NOT_EMPTY', error instanceof Error ? error.message : String(error), {
        projectDir,
      });
    }

    await scaffoldProject(projectDir, { skipInstall: options.skipInstall, log });

    // License: an explicit key wins; otherwise ask the vendor for a trial. A refusal or an
    // unreachable service is reported, not fatal — the site still scaffolds and boots, and
    // the trial can be started from CMS Settings → Packages later.
    let license;
    if (providedLicenseKey) {
      license = { key: providedLicenseKey, kind: null, status: 'provided' };
    } else if (trial) {
      log(chalk.blue('Requesting a Cortex AI trial key from the NextBlock license service...'));
      const result = await requestTrialLicense({ cliVersion: CLI_VERSION, email, name, serviceUrl });
      license = result.ok
        ? { expiresAt: result.expiresAt, key: result.licenseKey, kind: result.kind, status: 'provisioned', trialDays: result.trialDays }
        : { code: result.code, key: null, kind: null, message: result.message, status: 'unavailable' };
      log(
        result.ok
          ? chalk.green('Trial key provisioned.')
          : chalk.yellow(`Trial not provisioned (${result.code}): ${result.message}`),
      );
    } else {
      license = { key: null, kind: null, status: 'skipped' };
    }

    const mcpToken = generateMcpBearerToken();
    const envValues = {
      MCP_BEARER_TOKEN: mcpToken,
      ...(license.key
        ? { NEXTBLOCK_LICENSE_KEY: license.key, NEXTBLOCK_LICENSE_KIND: license.kind ?? '' }
        : {}),
    };

    const licenseSummary = {
      status: attended ? 'browser' : license.status,
      ...(attended
        ? { message: 'The user starts the free Cortex AI trial on the welcome screen after creating their account.' }
        : {}),
      ...(license.kind ? { kind: license.kind } : {}),
      ...(license.expiresAt ? { expiresAt: license.expiresAt } : {}),
      ...(license.code ? { code: license.code, message: license.message } : {}),
    };

    if (mode === 'cloud') {
      try {
        await ensureSupabaseAssets(projectDir, { log, required: false });
      } catch {
        // Non-fatal: the wizard still works; db:migrate just needs these assets present.
      }

      await upsertEnvFile(resolve(projectDir, '.env.local'), envValues, {
        header: '# Written by create-nextblock --non-interactive. Do not commit.',
      });

      const appUrl = 'http://localhost:3000';
      const statusUrl = `${appUrl}/api/setup/status`;
      const configFiles = await writeAgentMcpConfigs(projectDir, { token: mcpToken, url: `${appUrl}/api/mcp` });

      emitJsonResult({
        ok: true,
        mode,
        attended,
        projectName,
        projectDir,
        appUrl,
        statusUrl,
        handoff: { setupUrl: `${appUrl}/setup`, welcomeUrl: `${appUrl}/cms/welcome` },
        mcp: {
          url: `${appUrl}/api/mcp`,
          transport: 'http',
          configFiles,
          ready: false,
          tokenLocation: '.env.local (MCP_BEARER_TOKEN)',
        },
        license: { ...licenseSummary, keyLocation: license.key ? '.env.local (NEXTBLOCK_LICENSE_KEY)' : null },
        admin: { email: email ?? null, created: false },
        nextSteps: [
          `cd ${projectName} && npm run dev`,
          `Tell the user to open ${appUrl}/setup in a browser to connect Supabase and create their administrator account${email ? ` (${email})` : ''}.`,
          ...(attended
            ? [handoffSteps(appUrl, statusUrl)[1]]
            : [`The provisioned license key activates itself on the first GET ${statusUrl} after setup.`]),
          `Poll GET ${statusUrl} until "mcpReady" is true, then restart your coding agent session so it loads .mcp.json / .cursor/mcp.json.`,
        ],
      });
      return;
    }

    // Docker: the setup script persists the token and key into the .env compose reads, boots
    // the stack, and may remap the app port — so the real URL is read back from .env.
    await runDockerSetupHeadless(projectDir, { env: envValues, log });

    const dockerEnv = await readEnvFile(resolve(projectDir, '.env'));
    const appUrl = resolveAppUrlFromEnv(dockerEnv);
    const statusUrl = `${appUrl}/api/setup/status`;

    log(chalk.blue(`Waiting for ${statusUrl} to report the database ready...`));
    const ready = await waitForReadiness(statusUrl, {
      onTick: ({ attempt, lastError }) => {
        if (attempt % 5 === 0) {
          log(chalk.gray(`  still waiting (attempt ${attempt}${lastError ? `: ${lastError}` : ''})`));
        }
      },
      timeoutMs: 5 * 60_000,
      until: 'dbReady',
    });

    if (!ready.ok) {
      throw new HeadlessError('STACK_NOT_READY', ready.message, {
        hint: 'Check `docker compose logs -f nextblock-cms` in the project, then re-run `npm run docker:setup`.',
        lastError: ready.lastError,
        statusUrl,
      });
    }

    const configFiles = await writeAgentMcpConfigs(projectDir, { token: mcpToken, url: `${appUrl}/api/mcp` });

    if (attended) {
      const readiness = summarizeReadiness(ready.report);

      emitJsonResult({
        ok: true,
        mode,
        attended: true,
        projectName,
        projectDir,
        appUrl,
        statusUrl,
        handoff: { setupUrl: `${appUrl}/setup`, welcomeUrl: `${appUrl}/cms/welcome` },
        mcp: {
          url: `${appUrl}/api/mcp`,
          transport: 'http',
          configFiles,
          ready: false,
          tokenLocation: '.env (MCP_BEARER_TOKEN)',
        },
        license: { status: 'browser', message: 'The user starts the free Cortex AI trial on the welcome screen after creating their account.' },
        admin: { email: null, created: false, createdBy: 'user in the browser setup wizard' },
        readiness,
        nextSteps: handoffSteps(appUrl, statusUrl),
      });
      return;
    }

    const adminPassword = generateAdminPassword();
    log(chalk.blue(`Creating the first administrator (${email})...`));
    const boot = await bootstrapInstance({
      admin: { email, fullName: name, password: adminPassword },
      appUrl,
      token: mcpToken,
    });

    if (!boot.ok) {
      throw new HeadlessError('BOOTSTRAP_FAILED', boot.message, {
        hint: `Finish setup in a browser at ${appUrl}/setup, then restart your agent session.`,
        status: boot.status,
        statusUrl,
      });
    }

    // The password is the operator's, not the agent's: it lives in the env file the agent
    // guardrails deny, next to the other secrets, and is never printed.
    await upsertEnvFile(resolve(projectDir, '.env'), {
      NEXTBLOCK_ADMIN_EMAIL: email,
      NEXTBLOCK_ADMIN_PASSWORD: adminPassword,
    });

    // Short, non-fatal wait for the license to land: the bootstrap already activated it
    // when a key was provisioned; otherwise this simply reports what is still missing.
    const final = await waitForReadiness(statusUrl, { intervalMs: 2_000, timeoutMs: 30_000, until: 'mcpReady' });
    const readiness = summarizeReadiness(final.report ?? boot.body);
    const bootLicense =
      boot.body?.license?.env && typeof boot.body.license.env === 'object' ? boot.body.license.env : null;

    emitJsonResult({
      ok: true,
      mode,
      projectName,
      projectDir,
      appUrl,
      statusUrl,
      mcp: {
        url: `${appUrl}/api/mcp`,
        transport: 'http',
        configFiles,
        ready: readiness?.mcpReady === true,
        tokenLocation: '.env (MCP_BEARER_TOKEN)',
      },
      license: {
        ...licenseSummary,
        keyLocation: license.key ? '.env (NEXTBLOCK_LICENSE_KEY)' : null,
        activation: bootLicense ? { state: bootLicense.state ?? null, error: bootLicense.error ?? null } : null,
      },
      admin: {
        email,
        created: boot.body?.admin?.created === true,
        passwordLocation: '.env (NEXTBLOCK_ADMIN_PASSWORD)',
        signInUrl: `${appUrl}/sign-in`,
      },
      readiness,
      nextSteps: [
        ...(readiness?.mcpReady
          ? ['Restart your coding agent session so it loads .mcp.json / .cursor/mcp.json, then call tools/list on the nextblock MCP server.']
          : [`MCP is not ready yet — poll GET ${statusUrl} and follow its nextSteps.`]),
        ...(readiness?.nextSteps ?? []),
      ],
    });
  } catch (error) {
    const payload =
      error instanceof HeadlessError
        ? error.toPayload()
        : { error: 'SCAFFOLD_FAILED', message: error instanceof Error ? error.message : String(error) };
    emitJsonError(payload);
    process.exit(1);
  }
}

async function handleActivateCommand(moduleName) {
  if (!moduleName || moduleName !== 'ecommerce') {
    console.error(
      chalk.red('Invalid module name. Supported modules: ecommerce'),
    );
    process.exit(1);
  }

  clack.intro(`🚀 Activating NextBlock™ module: ${moduleName}`);

  const projectPath = process.cwd();

  // 1. Install NPM package
  clack.note(`Installing @nextblock-cms/${moduleName}...`);

  await execa(
    'npm',
    ['install', `@nextblock-cms/ecommerce@npm:@nextblock-cms/ecom@latest`],
    { cwd: projectPath, stdio: 'inherit' },
  );
  clack.note('NPM package installed!');

  // 2. Inject Route Wrappers
  clack.note('Injecting route wrappers...');

  const routesToInject = {
    'app/cms/orders/page.tsx': `import { OrdersPage as OrdersPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function OrdersPage() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <OrdersPageUI />;
}`,
    'app/cms/orders/[id]/page.tsx': `import { OrderDetailPage as OrderDetailPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }
  const resolvedParams = await params;
  return <OrderDetailPageUI params={resolvedParams} />;
}`,
    'app/cms/products/page.tsx': `import { ProductsPage as ProductsPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function ProductsPage() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <ProductsPageUI />;
}`,
    'app/cms/products/new/page.tsx': `import { NewProductPage as NewProductPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function NewProductPage() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <NewProductPageUI />;
}`,
    'app/cms/products/[id]/edit/page.tsx': `import { EditProductPage as EditProductPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  const resolvedParams = await params;
  return <EditProductPageUI params={resolvedParams} />;
}`,
    'app/cms/payments/page.tsx': `import { PaymentsPage as PaymentsPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function PaymentsPage() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <PaymentsPageUI />;
}`,
    'app/cms/coupons/page.tsx': `import { CouponsPage as CouponsPageUI } from '@nextblock-cms/ecommerce/server';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function CouponsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <CouponsPageUI searchParams={await searchParams} />;
}`,
    'app/cms/coupons/[id]/edit/page.tsx': `import { EditCouponPage as EditCouponPageUI } from '@nextblock-cms/ecommerce/server';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';

export default async function EditCouponPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    redirect('/cms/settings/packages');
  }

  return <EditCouponPageUI params={params} />;
}`,
    'app/checkout/success/page.tsx': `import { CheckoutSuccessPage as CheckoutSuccessPageUI } from '@nextblock-cms/ecommerce';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { notFound } from 'next/navigation';

export default async function CheckoutSuccessPage() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
    notFound();
  }

  return <CheckoutSuccessPageUI />;
}`,
    'app/api/checkout/route.ts': `import { NextResponse } from 'next/server';
import { getPaymentProvider } from '@nextblock-cms/ecommerce/server';
import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { normalizeCustomerAddress } from '@nextblock-cms/ecommerce';

function resolveProviderFromItem(item) {
  if (item?.provider === 'stripe' || item?.provider === 'freemius') {
    return item.provider;
  }

  if (item?.payment_provider === 'stripe' || item?.payment_provider === 'freemius') {
    return item.payment_provider;
  }

  if (item?.product_type === 'digital') {
    return 'freemius';
  }

  if (item?.product_type === 'physical') {
    return 'stripe';
  }

  if (item?.freemius_product_id) {
    return 'freemius';
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const isOnline = await verifyPackageOnline('ecommerce');
    if (!isOnline) {
      return NextResponse.json({ error: 'Ecommerce module license is inactive' }, { status: 403 });
    }

    const {
      items,
      customerEmail,
      customerPhone,
      billingAddress,
      shippingAddress,
      shippingMethodId,
      currencyCode,
      locale,
      couponCode,
      couponContextItems,
    } = await req.json();

    if (!items || !Array.isArray(items)) {
      return NextResponse.json({ error: 'Invalid items data' }, { status: 400 });
    }

    const providerNames = Array.from(
      new Set(items.map((item) => resolveProviderFromItem(item)).filter(Boolean))
    );

    if (providerNames.length === 0) {
      return NextResponse.json(
        { error: 'Each checkout request must include provider-aware cart items.' },
        { status: 400 }
      );
    }

    if (providerNames.length > 1) {
      return NextResponse.json(
        { error: 'Mixed-provider carts must be checked out in separate steps.' },
        { status: 400 }
      );
    }

    const providerName = providerNames[0];

    if (providerName === 'freemius' && items.length !== 1) {
      return NextResponse.json(
        { error: 'Freemius items must be checked out one at a time.' },
        { status: 400 }
      );
    }

    if (!billingAddress) {
      return NextResponse.json({ error: 'Billing address is required' }, { status: 400 });
    }

    const supabase = createClient();
    const provider = getPaymentProvider(providerName);

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;
    const resolvedCustomerEmail = user?.email || customerEmail || null;

    const { url, error, errorKey, errorParams, errorStatus, customProps } =
      await provider.createCheckoutSession({
        items,
        customerEmail: resolvedCustomerEmail,
        customerPhone,
        userId,
        billingAddress: normalizeCustomerAddress(billingAddress) ?? billingAddress,
        shippingAddress:
          providerName === 'stripe'
            ? normalizeCustomerAddress(shippingAddress)
            : null,
        shippingMethodId: providerName === 'stripe' ? shippingMethodId : null,
        currencyCode: typeof currencyCode === 'string' ? currencyCode : null,
        locale: typeof locale === 'string' ? locale : null,
        couponCode: typeof couponCode === 'string' ? couponCode : null,
        couponContextItems: Array.isArray(couponContextItems) ? couponContextItems : items,
      });

    if (error) {
      console.error('Checkout Error:', error);
      return NextResponse.json(
        { error, errorKey, errorParams },
        { status: errorStatus ?? 500 }
      );
    }

    return NextResponse.json({ url, customProps });
  } catch (err: any) {
    console.error('Checkout API Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}`,
  };

  for (const [routePath, content] of Object.entries(routesToInject)) {
    const fullPath = resolve(projectPath, routePath);
    await fs.ensureDir(dirname(fullPath));
    await fs.writeFile(fullPath, content);
  }

  clack.outro(
    '✅ Ecommerce module activated successfully! You can now use the storefront features.',
  );
}

// clack validator that rejects empty/whitespace-only input with a labelled message.
function requiredValue(label) {
  return (value) =>
    value && String(value).trim() ? undefined : `${label} is required`;
}

// Read the current value of a `KEY=` line from an .env file body (handles quotes),
// so re-runs can reuse already-generated secrets instead of regenerating them.
function readEnvValue(envContent, key) {
  for (const line of envContent.split(/\r?\n/)) {
    if (line.startsWith(key)) {
      return line.slice(key.length).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return '';
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function runSetupWizard(projectDir, projectName) {
  const projectPath = resolve(projectDir);
  process.chdir(projectPath);

  // Prerequisites + readiness were already confirmed up front in handleCommand (before any
  // scaffolding), so the wizard goes straight to collecting configuration.
  clack.intro('🚀 NextBlock™ CMS setup');

  await fs.ensureDir(resolve(projectPath, 'supabase'));

  // 1. Supabase — same questions/order as setup.mjs. Nothing is masked: you are pasting
  //    keys you just copied, and seeing them makes paste mistakes easy to spot.
  clack.note('Get these from https://supabase.com/dashboard', 'Supabase project');
  const supabase = await clack.group(
    {
      projectId: () =>
        clack.text({
          message: 'Project ID (Project Settings > General > "Reference ID"):',
          validate: requiredValue('Project Reference ID'),
        }),
      postgresUrl: () =>
        clack.text({
          message:
            'Connection String (Connect > Direct connection > URI — replace [YOUR-PASSWORD] with your DB password):',
          placeholder: 'postgresql://...',
          validate: requiredValue('Connection string'),
        }),
      anonKey: () =>
        clack.text({
          message: 'Project API Key — anon / public (Project Settings > API Keys):',
          validate: requiredValue('Anon key'),
        }),
      serviceKey: () =>
        clack.text({
          message: 'Service Role Key — service_role (Project Settings > API Keys):',
          validate: requiredValue('Service role key'),
        }),
      accessToken: () =>
        clack.text({
          message:
            'Personal Access Token (Account > Access Tokens > Generate new token):',
          validate: requiredValue('Access token'),
        }),
      siteUrl: () =>
        clack.text({
          // Standalone `npm run dev` is plain `next dev` on :3000 (NOT `nx serve` on :4200),
          // so the local default differs from the monorepo setup wizard on purpose.
          message: 'Public site URL [NEXT_PUBLIC_URL]:',
          initialValue: 'http://localhost:3000',
          validate: requiredValue('Site URL'),
        }),
    },
    { onCancel: () => handleWizardCancel('Setup cancelled.') },
  );

  const projectId = supabase.projectId.trim();
  const postgresUrl = supabase.postgresUrl.trim();
  const siteUrl = supabase.siteUrl.trim().replace(/\/+$/, '');
  const supabaseUrl = `https://${projectId}.supabase.co`;

  // Extract the database password from the connection string; prompt if it is missing
  // or still the [YOUR-PASSWORD] placeholder.
  let dbPassword = '';
  try {
    dbPassword = decodeURIComponent(new URL(postgresUrl).password);
  } catch {
    // Fall through to the manual prompt below.
  }
  if (!dbPassword || /YOUR-PASSWORD/i.test(dbPassword)) {
    const passwordPrompt = await clack.text({
      message:
        'Could not read the DB password from the URI. Enter your Postgres database password:',
      validate: requiredValue('Database password'),
    });
    if (clack.isCancel(passwordPrompt)) {
      handleWizardCancel('Setup cancelled.');
    }
    dbPassword = passwordPrompt.trim();
  }

  // 2. Cloudflare R2 — required. Powers media uploads, image processing, and backups.
  clack.note('https://dash.cloudflare.com  > R2', 'Cloudflare R2 storage');
  const r2 = await clack.group(
    {
      accountId: () =>
        clack.text({
          message: 'R2 Account ID (R2 overview > Account details):',
          validate: requiredValue('R2 Account ID'),
        }),
      bucketName: () =>
        clack.text({
          message: 'R2 Bucket Name:',
          validate: requiredValue('R2 Bucket Name'),
        }),
      publicBaseUrl: () =>
        clack.text({
          message:
            'R2 Public Development URL (Bucket > Settings > Public Development URL, e.g. https://pub-xxxx.r2.dev):',
          validate: requiredValue('R2 Public Development URL'),
        }),
      accessKey: () =>
        clack.text({
          message: 'R2 Access Key ID (R2 > Manage API Tokens):',
          validate: requiredValue('R2 Access Key ID'),
        }),
      secretKey: () =>
        clack.text({
          message:
            'R2 Secret Access Key (shown only once when the token is created):',
          validate: requiredValue('R2 Secret Access Key'),
        }),
    },
    { onCancel: () => handleWizardCancel('Setup cancelled.') },
  );

  // 3. SMTP — required. Sends the sign-up confirmation email your first admin needs.
  clack.note('SMTP2GO works very well: https://www.smtp2go.com', 'SMTP email');
  const smtp = await clack.group(
    {
      host: () =>
        clack.text({
          message: 'SMTP Host (e.g. mail.smtp2go.com):',
          validate: requiredValue('SMTP Host'),
        }),
      port: () =>
        clack.text({
          message: 'SMTP Port (465 = SSL, 587 = STARTTLS):',
          initialValue: '465',
          validate: requiredValue('SMTP Port'),
        }),
      user: () =>
        clack.text({
          message: 'SMTP User:',
          validate: requiredValue('SMTP User'),
        }),
      pass: () =>
        clack.text({
          message: 'SMTP Password:',
          validate: requiredValue('SMTP Password'),
        }),
      fromEmail: () =>
        clack.text({
          message: 'From Email (the address confirmation emails are sent from):',
          validate: requiredValue('From Email'),
        }),
      fromName: () =>
        clack.text({
          message: 'From Name (e.g. NextBlock):',
          validate: requiredValue('From Name'),
        }),
    },
    { onCancel: () => handleWizardCancel('Setup cancelled.') },
  );

  const smtpValues = {
    host: smtp.host,
    port: smtp.port,
    user: smtp.user,
    pass: smtp.pass,
    fromEmail: smtp.fromEmail,
    fromName: smtp.fromName,
  };

  // 4. Write .env.local with everything we collected. Mirror setup.mjs: seed from the
  //    template .env.example when present, replace keys line-by-line, append any missing,
  //    and reuse already-generated secrets so re-runs are idempotent. .env.local is what
  //    `next dev` loads first and is covered by the generated .gitignore.
  clack.note('Writing .env.local...');
  const envPath = resolve(projectPath, '.env.local');
  const envExamplePath = resolve(projectPath, '.env.example');
  let envContent = '';
  if (await fs.pathExists(envPath)) {
    envContent = await fs.readFile(envPath, 'utf8');
  } else if (await fs.pathExists(envExamplePath)) {
    envContent = await fs.readFile(envExamplePath, 'utf8');
  }

  const cronSecret = readEnvValue(envContent, 'CRON_SECRET=') || generateSecret();
  const draftSecret =
    readEnvValue(envContent, 'DRAFT_MODE_SECRET=') || generateSecret();
  const revalidateSecret =
    readEnvValue(envContent, 'REVALIDATE_SECRET_TOKEN=') || generateSecret();

  const replacements = {
    'SUPABASE_PROJECT_ID=': `SUPABASE_PROJECT_ID=${projectId}`,
    'POSTGRES_URL=': `POSTGRES_URL=${postgresUrl}`,
    'POSTGRES_PASSWORD=': `POSTGRES_PASSWORD="${dbPassword}"`,
    'NEXT_PUBLIC_SUPABASE_URL=': `NEXT_PUBLIC_SUPABASE_URL=${supabaseUrl}`,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=': `NEXT_PUBLIC_SUPABASE_ANON_KEY=${supabase.anonKey}`,
    'SUPABASE_SERVICE_ROLE_KEY=': `SUPABASE_SERVICE_ROLE_KEY=${supabase.serviceKey}`,
    'SUPABASE_ACCESS_TOKEN=': `SUPABASE_ACCESS_TOKEN=${supabase.accessToken}`,
    'NEXT_PUBLIC_URL=': `NEXT_PUBLIC_URL=${siteUrl}`,
    'CRON_SECRET=': `CRON_SECRET=${cronSecret}`,
    'DRAFT_MODE_SECRET=': `DRAFT_MODE_SECRET=${draftSecret}`,
    'REVALIDATE_SECRET_TOKEN=': `REVALIDATE_SECRET_TOKEN=${revalidateSecret}`,
    // Build-time migration hook gate for standalone installs (Milestone 4): on a
    // production build with POSTGRES_URL set, pending migrations are applied before
    // `next build`. Skips gracefully when the DB is unreachable.
    'NEXTBLOCK_BUILD_MIGRATE=': 'NEXTBLOCK_BUILD_MIGRATE=1',
    // The R2 public URL is consumed under two names (next/image remotePatterns + CSP, and
    // media URL resolution) — write the same value to both, matching setup.mjs.
    'NEXT_PUBLIC_R2_PUBLIC_URL=': `NEXT_PUBLIC_R2_PUBLIC_URL=${r2.publicBaseUrl}`,
    'NEXT_PUBLIC_R2_BASE_URL=': `NEXT_PUBLIC_R2_BASE_URL=${r2.publicBaseUrl}`,
    'R2_ACCOUNT_ID=': `R2_ACCOUNT_ID=${r2.accountId}`,
    'R2_BUCKET_NAME=': `R2_BUCKET_NAME=${r2.bucketName}`,
    'R2_ACCESS_KEY_ID=': `R2_ACCESS_KEY_ID=${r2.accessKey}`,
    'R2_SECRET_ACCESS_KEY=': `R2_SECRET_ACCESS_KEY=${r2.secretKey}`,
    'SMTP_HOST=': `SMTP_HOST=${smtpValues.host}`,
    'SMTP_PORT=': `SMTP_PORT=${smtpValues.port}`,
    'SMTP_USER=': `SMTP_USER=${smtpValues.user}`,
    'SMTP_PASS=': `SMTP_PASS=${smtpValues.pass}`,
    'SMTP_FROM_EMAIL=': `SMTP_FROM_EMAIL=${smtpValues.fromEmail}`,
    'SMTP_FROM_NAME=': `SMTP_FROM_NAME=${smtpValues.fromName}`,
    'SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=':
      'SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=30',
  };

  const appliedKeys = new Set();
  const updatedLines = envContent.split(/\r?\n/).map((line) => {
    for (const [key, value] of Object.entries(replacements)) {
      if (line.startsWith(key)) {
        appliedKeys.add(key);
        return value;
      }
    }
    return line;
  });

  // Append any keys missing from the seed so nothing is silently dropped.
  for (const [key, value] of Object.entries(replacements)) {
    if (!appliedKeys.has(key)) {
      updatedLines.push(value);
    }
  }

  await fs.writeFile(envPath, updatedLines.join('\n'), 'utf8');
  clack.note(
    'Supabase, R2, SMTP, site URL, and generated secrets saved to .env.local',
  );

  // 5. Materialize Supabase assets (migrations, config.toml, branded auth email
  //    templates) out of the installed @nextblock-cms/db package.
  await ensureSupabaseAssets(projectPath, { required: true });

  // 6. Link the project and apply the schema. These are the standalone equivalents of the
  //    monorepo `npm run db:link` + `npm run db:migrate:fresh` (which do not exist in a
  //    generated project): we drive the Supabase CLI directly, authenticating with the
  //    access token so no browser login is required.
  const supabaseBin = await getSupabaseBinary(projectPath);
  const command = supabaseBin === 'npx' ? 'npx' : supabaseBin;
  // `--yes` skips npx's "Ok to proceed?" install prompt if it ever falls back to npx
  // (i.e. the supabase devDependency somehow isn't installed) so it can't hang the wizard.
  const sbArgs = (args) =>
    supabaseBin === 'npx' ? ['--yes', 'supabase', ...args] : args;
  const supabaseEnv = {
    ...process.env,
    SUPABASE_ACCESS_TOKEN: supabase.accessToken,
    SUPABASE_DB_PASSWORD: dbPassword,
    POSTGRES_URL: postgresUrl,
  };

  const applySchema = await clack.confirm({
    message:
      'Apply the database schema to the linked project now? (Safe for a new database; does not delete existing data.)',
    initialValue: true,
  });
  if (clack.isCancel(applySchema)) {
    handleWizardCancel('Setup cancelled.');
  }

  // Stream the Supabase CLI's own output (stdio: inherit) instead of hiding it behind a
  // spinner — link/push are long-running and a spinner over inherited output looks frozen.
  clack.log.step('Linking to your Supabase project...');
  try {
    await execa(
      command,
      sbArgs(['link', '--project-ref', projectId, '--password', dbPassword]),
      { stdio: 'inherit', cwd: projectPath, env: supabaseEnv },
    );

    if (applySchema) {
      clack.log.step(
        'Applying the database schema — this can take a minute on a fresh project...',
      );
      await execa(command, sbArgs(['db', 'push', '--include-all']), {
        stdio: ['pipe', 'inherit', 'inherit'],
        cwd: projectPath,
        input: 'y\n', // Auto-confirm the push prompt
        env: supabaseEnv,
      });

      clack.log.success('Database schema applied.');
    } else {
      clack.log.info(
        'Linked. Skipped schema push — run `npx supabase db push --include-all` when ready.',
      );
    }
  } catch (error) {
    clack.log.warn(
      'Database setup failed. You can run `npx supabase db push --include-all` manually.',
    );
    if (error instanceof Error) {
      clack.note(error.message);
    }
  }

  // 7. Configure hosted Supabase Auth via the Management API: site URL + custom SMTP +
  //    branded email templates. This is the same mechanism as `npm run configure:supabase-auth`
  //    in the monorepo, and it's what lets Supabase email your first admin's confirmation link.
  //    (We deliberately do NOT `supabase config push` the whole config.toml — that pushes
  //    local-only/unset values like env(TARGET_URL) and isn't what the monorepo does.)
  await configureHostedSupabaseAuth(projectPath, {
    projectId,
    siteUrl,
    accessToken: supabase.accessToken,
    smtpValues,
  });

  // 8. Optional premium modules (CLI-specific; requires a license + registry access).
  const setupPremium = await clack.confirm({
    message: 'Do you have a license and want to install premium modules now?',
    initialValue: false,
  });
  if (clack.isCancel(setupPremium)) {
    handleWizardCancel('Setup cancelled.');
  }
  if (setupPremium) {
    clack.note('Installing @nextblock-cms/ecommerce...');
    await execa(
      'npm',
      ['install', '@nextblock-cms/ecommerce@npm:@nextblock-cms/ecom@latest'],
      {
        cwd: projectPath,
        stdio: 'inherit',
      },
    );
    clack.note('Premium module installed!');
  }

  clack.outro(
    [
      `🎉 Your NextBlock™ project ${projectName ? `"${projectName}" ` : ''}is ready!`,
      '',
      'Next steps:',
      `  1. Start the app:       cd ${projectName} && npm run dev   → ${siteUrl}`,
      `  2. Create your account: open ${siteUrl}/sign-up`,
      '     The FIRST account to sign up automatically becomes the ADMIN.',
      '  3. Confirm your email:  click the link sent to your inbox',
      `  4. Sign in — you'll land in the CMS at ${siteUrl}/cms/dashboard`,
    ].join('\n'),
  );
}

// Local Self-Hosted Docker Mode: materialize the supabase migrations out of the installed
// @nextblock-cms/db package (the migration-runner container applies them on boot), then hand off
// to the project's own zero-dependency Docker setup script (prompts + .env + `docker compose up`).
async function runCloudScaffold(projectDir, projectName) {
  const projectPath = resolve(projectDir);

  // Materialize the Supabase assets (migrations + config) so `npm run db:migrate` works later,
  // then hand off entirely to the browser First-Boot Setup Wizard for configuration. No
  // credentials are collected in the terminal.
  try {
    await ensureSupabaseAssets(projectPath, { required: false });
  } catch {
    // Non-fatal: the wizard still works; db:migrate just needs these assets present.
  }

  console.log(
    chalk.green(
      `\nSuccess! Your NextBlock™ CMS project "${projectName}" is scaffolded.\n`,
    ),
  );
  console.log(chalk.cyan('Next steps:'));
  console.log(chalk.cyan(`  1. cd ${projectName}`));
  console.log(chalk.cyan('  2. npm run dev'));
  console.log(
    `  3. Open ${chalk.cyan('/setup')} ${chalk.gray('in your browser (the URL npm run dev prints, e.g. http://localhost:3000/setup)')}`,
  );
  console.log(
    chalk.gray('     Connect Supabase, configure storage / email, and create your administrator.'),
  );
  console.log('');
  console.log(chalk.gray('  Self-hosted Docker instead?   npm run docker:setup'));
  console.log(chalk.gray('  One-click cloud deploy:       see docs/12-VERCEL-DEPLOYMENT.md'));
}

async function runDockerSetup(projectDir, projectName) {
  const projectPath = resolve(projectDir);
  process.chdir(projectPath);

  clack.intro('🐳 NextBlock™ CMS — Local Self-Hosted Docker setup');

  await ensureSupabaseAssets(projectPath, { required: true });

  const setupScript = resolve(projectPath, 'scripts', 'docker-setup.mjs');
  if (!(await fs.pathExists(setupScript))) {
    clack.note(
      'scripts/docker-setup.mjs is missing from the template. Run `npm run sync:create-nextblock` and try again.',
      'Docker setup unavailable',
    );
    return;
  }

  // The script drives docker compose interactively; inherit stdio so its prompts work.
  await runCommand('node', ['scripts/docker-setup.mjs'], { cwd: projectPath });

  // docker-setup may have remapped the app port; read the URL it actually chose.
  const appUrl = resolveAppUrlFromEnv(await readEnvFile(resolve(projectPath, '.env')));

  clack.outro(
    `🎉 Your NextBlock™ project ${projectName ? `"${projectName}" ` : ''}is running in Docker.\nApp: ${appUrl}   (first sign-up becomes ADMIN)`,
  );
}

/**
 * Headless Docker boot. The scaffold's MCP token and provisioned key travel to
 * scripts/docker-setup.mjs through the environment, which persists them into the `.env`
 * compose reads. The script's own output is routed to stderr so stdout stays reserved
 * for the JSON result.
 */
async function runDockerSetupHeadless(projectDir, { env = {}, log }) {
  const projectPath = resolve(projectDir);

  await ensureSupabaseAssets(projectPath, { log, required: true });

  const setupScript = resolve(projectPath, 'scripts', 'docker-setup.mjs');
  if (!(await fs.pathExists(setupScript))) {
    throw new HeadlessError(
      'TEMPLATE_INCOMPLETE',
      'scripts/docker-setup.mjs is missing from the template. Run `npm run sync:create-nextblock` and try again.',
    );
  }

  log(chalk.blue('Booting the local Docker stack (first run pulls images and builds the app)...'));

  try {
    await runCommand('node', ['scripts/docker-setup.mjs'], {
      cwd: projectPath,
      env: { ...process.env, ...env },
      stdio: ['ignore', process.stderr, process.stderr],
    });
  } catch (error) {
    throw new HeadlessError('DOCKER_SETUP_FAILED', error instanceof Error ? error.message : String(error), {
      hint: 'Re-run `npm run docker:setup` inside the project to see the full compose output.',
    });
  }
}

async function configureHostedSupabaseAuth(
  projectDir,
  { projectId, siteUrl, accessToken, smtpValues },
) {
  if (!projectId || !siteUrl || !accessToken) {
    clack.note(
      'Skipped hosted Supabase Auth sync because the project ref, site URL, or access token is missing.',
    );
    return;
  }

  const spinner = clack.spinner();
  spinner.start('Syncing hosted Supabase Auth SMTP and branded email templates...');

  try {
    await execa('node', ['tools/configure-supabase-auth.js'], {
      cwd: projectDir,
      env: {
        ...process.env,
        SUPABASE_PROJECT_ID: projectId,
        NEXT_PUBLIC_URL: siteUrl,
        SUPABASE_ACCESS_TOKEN: accessToken,
        SMTP_HOST: smtpValues.host,
        SMTP_PORT: smtpValues.port,
        SMTP_USER: smtpValues.user,
        SMTP_PASS: smtpValues.pass,
        SMTP_FROM_EMAIL: smtpValues.fromEmail,
        SMTP_FROM_NAME: smtpValues.fromName,
        SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT:
          process.env.SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT || '30',
      },
    });
    spinner.stop('Hosted Supabase Auth configured.');
  } catch (error) {
    spinner.stop(
      'Hosted Supabase Auth sync skipped. You can rerun it later with npm run configure:supabase-auth.',
    );
    clack.note(
      error instanceof Error ? error.message : String(error),
      'Supabase Auth Sync',
    );
  }
}

function handleWizardCancel(message) {
  clack.cancel(message ?? 'Setup cancelled.');
  process.exit(1);
}

async function ensureEmptyDirectory(projectDir) {
  const exists = await fs.pathExists(projectDir);
  if (!exists) {
    return;
  }

  const contents = await fs.readdir(projectDir);
  if (contents.length > 0) {
    throw new Error(
      `Directory "${projectDir}" already exists and is not empty.`,
    );
  }
}

async function copyTemplateTo(projectDir) {
  const templateExists = await fs.pathExists(TEMPLATE_DIR);
  if (!templateExists) {
    throw new Error(
      `Template directory not found at ${TEMPLATE_DIR}. Run "npm run sync:create-nextblock" to populate it.`,
    );
  }

  await fs.ensureDir(projectDir);

  await fs.copy(TEMPLATE_DIR, projectDir, {
    dereference: true,
    filter: (src) => {
      const relativePath = relative(TEMPLATE_DIR, src);
      if (!relativePath) {
        return true;
      }

      const segments = relativePath.split(sep);
      return !segments.includes('.git') && !segments.includes('node_modules');
    },
  });
}

async function removeBackups(projectDir) {
  const backupDir = resolve(projectDir, 'backup');
  if (await fs.pathExists(backupDir)) {
    await fs.remove(backupDir);
  }
  const backupsDir = resolve(projectDir, 'backups');
  if (await fs.pathExists(backupsDir)) {
    await fs.remove(backupsDir);
  }
}

async function ensureGitignore(projectDir) {
  const gitignorePath = resolve(projectDir, '.gitignore');
  const npmIgnorePath = resolve(projectDir, '.npmignore');
  const repoGitignorePath = resolve(REPO_ROOT, '.gitignore');

  const defaultLines = [
    '# Dependencies',
    'node_modules',
    '',
    '# Next.js build output',
    '.next',
    'out',
    '',
    '# Production',
    'build',
    'dist',
    '',
    '# Logs',
    'logs',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
    '',
    '# Environment',
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.test.local',
    '.env.production.local',
    '',
    // Coding-agent MCP client configs carry the instance bearer token verbatim (the
    // clients cannot read it from .env), so they must never be committed.
    '# Coding agent MCP configs (contain the MCP bearer token)',
    '.mcp.json',
    '.cursor/mcp.json',
    '.claude/settings.local.json',
    '',
    '# Backups',
    'backup/',
    'backups/',
    // Written by `npm run update` when it replaces a framework file. Local safety copies
    // of the previous version — useful to diff against, never to commit.
    '.nextblock-backup/',
    '',
    '# Misc',
    '.DS_Store',
  ];

  let repoLines = [];
  if (await fs.pathExists(repoGitignorePath)) {
    const raw = await fs.readFile(repoGitignorePath, 'utf8');
    repoLines = raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/, '').replace(/apps\/nextblock\//g, ''))
      .map((line) => (line.trim() === '' ? '' : line));
  }

  let content = '';

  if (await fs.pathExists(resolve(projectDir, 'gitignore'))) {
    await fs.move(resolve(projectDir, 'gitignore'), gitignorePath, {
      overwrite: true,
    });
  }

  if (await fs.pathExists(gitignorePath)) {
    content = await fs.readFile(gitignorePath, 'utf8');
  } else if (await fs.pathExists(npmIgnorePath)) {
    await fs.move(npmIgnorePath, gitignorePath, { overwrite: true });
    content = await fs.readFile(gitignorePath, 'utf8');
  } else {
    content = defaultLines.join('\n') + '\n';
  }

  const lines =
    content === ''
      ? []
      : content
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line) => line.replace(/\s+$/, ''));

  const existing = new Set(lines);
  let updated = false;

  const mergeLine = (line) => {
    if (line === undefined || line === null) {
      return;
    }
    if (line === '') {
      if (lines.length === 0 || lines[lines.length - 1] === '') {
        return;
      }
      lines.push('');
      updated = true;
      return;
    }
    if (!existing.has(line)) {
      lines.push(line);
      existing.add(line);
      updated = true;
    }
  };

  for (const line of repoLines) {
    mergeLine(line);
  }

  mergeLine('');

  for (const line of defaultLines) {
    mergeLine(line);
  }

  const normalized = [];
  for (const line of lines) {
    if (line === '') {
      if (normalized.length === 0 || normalized[normalized.length - 1] === '') {
        continue;
      }
      normalized.push('');
    } else {
      normalized.push(line);
    }
  }

  if (normalized.length === 0 || normalized[normalized.length - 1] !== '') {
    normalized.push('');
  }

  const nextContent = normalized.join('\n');

  if (updated || content !== nextContent) {
    await fs.writeFile(gitignorePath, nextContent);
  }
}

async function ensureEnvExample(projectDir) {
  const destination = resolve(projectDir, '.env.example');
  if (await fs.pathExists(destination)) {
    return;
  }

  const templatePaths = [
    resolve(TEMPLATE_DIR, '.env.example'),
    resolve(REPO_ROOT, '.env.example'),
    resolve(REPO_ROOT, '.env.exemple'),
  ];

  for (const candidate of templatePaths) {
    if (await fs.pathExists(candidate)) {
      await fs.copy(candidate, destination);
      return;
    }
  }

  const placeholder = `# Environment variables for NextBlock™ CMS
NEXT_PUBLIC_URL=

# Supabase  —  the setup wizard fills this whole block.
SUPABASE_PROJECT_ID=
POSTGRES_URL=
POSTGRES_PASSWORD=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ACCESS_TOKEN=

# Auto-generated by the setup wizard.
CRON_SECRET=
DRAFT_MODE_SECRET=
REVALIDATE_SECRET_TOKEN=

# Cloudflare R2  —  setup writes the public URL to both keys.
NEXT_PUBLIC_R2_PUBLIC_URL=
NEXT_PUBLIC_R2_BASE_URL=
R2_ACCOUNT_ID=
R2_BUCKET_NAME=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=

# Email SMTP Configuration
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=
SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=30
`;

  await fs.writeFile(destination, placeholder);
}

async function ensureSupabaseAssets(projectDir, options = {}) {
  const { required = false, log = null } = options;
  const destSupabaseDir = resolve(projectDir, 'supabase');
  await fs.ensureDir(destSupabaseDir);

  const { dir: packageSupabaseDir, triedPaths } =
    await resolvePackageSupabaseDir(projectDir);
  if (!packageSupabaseDir) {
    const message =
      'Unable to locate supabase assets in @nextblock-cms/db. Please ensure dependencies are installed.' +
      (triedPaths.length > 0
        ? `\nChecked:\n - ${triedPaths.join('\n - ')}`
        : '');
    if (required) {
      throw new Error(message);
    } else {
      // The headless flow passes its stderr logger; clack draws to stdout, which is
      // reserved for the JSON result there.
      if (log) {
        log(chalk.yellow(message));
      } else {
        clack.note(message);
      }
      return { migrationsCopied: false, configCopied: false, projectId: null };
    }
  }

  let migrationsCopied = false;
  let configCopied = false;

  const sourceConfigPath = resolve(packageSupabaseDir, 'config.toml');
  const destinationConfigPath = resolve(destSupabaseDir, 'config.toml');
  if (await fs.pathExists(sourceConfigPath)) {
    await fs.copy(sourceConfigPath, destinationConfigPath, {
      overwrite: true,
      errorOnExist: false,
    });
    configCopied = true;
  }

  const sourceMigrations = resolve(packageSupabaseDir, 'migrations');
  const destMigrations = resolve(destSupabaseDir, 'migrations');
  if (await fs.pathExists(sourceMigrations)) {
    await fs.copy(sourceMigrations, destMigrations, {
      overwrite: true,
      errorOnExist: false,
    });
    migrationsCopied = true;
  }

  // Branded Auth email templates. configure-supabase-auth.js resolves the supabase dir by
  // requiring a templates/ subdir, and uploads these via the Management API. Without them
  // the hosted-auth + SMTP sync silently skips and the first admin never gets a
  // confirmation email — so copy them alongside config.toml + migrations.
  const sourceTemplates = resolve(packageSupabaseDir, 'templates');
  const destTemplates = resolve(destSupabaseDir, 'templates');
  if (await fs.pathExists(sourceTemplates)) {
    await fs.copy(sourceTemplates, destTemplates, {
      overwrite: true,
      errorOnExist: false,
    });
  }

  if (required) {
    if (!configCopied) {
      throw new Error(
        `Missing supabase/config.toml in the installed @nextblock-cms/db package (checked ${packageSupabaseDir}).`,
      );
    }
    if (!migrationsCopied) {
      throw new Error(
        `Missing supabase/migrations in the installed @nextblock-cms/db package (checked ${packageSupabaseDir}).`,
      );
    }
  }

  return { migrationsCopied, configCopied };
}

async function resolvePackageSupabaseDir(projectDir) {
  const triedPaths = [];
  const candidateBases = new Set();

  const installDir = resolve(
    projectDir,
    'node_modules',
    '@nextblock-cms',
    'db',
  );
  candidateBases.add(installDir);

  const tryResolveFrom = (fromPath) => {
    try {
      const resolver = createRequire(fromPath);
      const pkgPath = resolver.resolve('@nextblock-cms/db/package.json');
      return dirname(pkgPath);
    } catch {
      return null;
    }
  };

  const projectPkg = resolve(projectDir, 'package.json');
  const resolvedProject = tryResolveFrom(projectPkg);
  if (resolvedProject) {
    candidateBases.add(resolvedProject);
    const parent = dirname(resolvedProject);
    candidateBases.add(parent);
  }

  const localResolve = tryResolveFrom(__filename);
  if (localResolve) {
    candidateBases.add(localResolve);
    candidateBases.add(dirname(localResolve));
  }

  candidateBases.add(REPO_ROOT);
  candidateBases.add(resolve(REPO_ROOT, 'libs', 'db'));
  candidateBases.add(resolve(REPO_ROOT, 'dist', 'libs', 'db'));

  const candidateSegments = [
    'supabase',
    'src/supabase',
    'dist/supabase',
    'dist/libs/db/supabase',
    'dist/lib/supabase',
    'lib/supabase',
  ];

  for (const base of Array.from(candidateBases).filter(Boolean)) {
    for (const segment of candidateSegments) {
      const candidate = resolve(base, segment);
      triedPaths.push(candidate);
      if (await fs.pathExists(candidate)) {
        return { dir: candidate, triedPaths };
      }
    }
  }

  return { dir: null, triedPaths };
}

async function ensureClientComponents(projectDir) {
  const relativePaths = [
    'components/env-var-warning.tsx',
    'app/providers.tsx',
    'app/ToasterProvider.tsx',
    'context/AuthContext.tsx',
    'context/CurrentContentContext.tsx',
    'context/LanguageContext.tsx',
  ];

  for (const relativePath of relativePaths) {
    const absolutePath = resolve(projectDir, relativePath);
    if (!(await fs.pathExists(absolutePath))) {
      continue;
    }

    const original = await fs.readFile(absolutePath, 'utf8');
    const trimmed = original.trimStart();
    if (
      trimmed.startsWith("'use client'") ||
      trimmed.startsWith('"use client"') ||
      trimmed.startsWith('/* @client */')
    ) {
      continue;
    }

    await fs.writeFile(absolutePath, `'use client';\n\n${original}`);
  }
}

async function ensureClientProviders(projectDir) {
  const providersPath = resolve(projectDir, 'app/providers.tsx');
  if (!(await fs.pathExists(providersPath))) {
    return;
  }

  let content = await fs.readFile(providersPath, 'utf8');
  const wrapperImportStatement =
    "import { TranslationsProvider } from '@nextblock-cms/utils';";
  const existingImportRegex =
    /import\s+\{\s*TranslationsProvider\s*\}\s*from\s*['"]@nextblock-cms\/utils['"];?/;
  const legacyImportRegex =
    /import\s+\{\s*TranslationsProvider\s*\}\s*from\s*['"]@\/lib\/client-translations['"];?/;

  if (existingImportRegex.test(content) || legacyImportRegex.test(content)) {
    content = content
      .replace(existingImportRegex, wrapperImportStatement)
      .replace(legacyImportRegex, wrapperImportStatement);
  } else if (!content.includes(wrapperImportStatement)) {
    const lines = content.split(/\r?\n/);
    const firstImport = lines.findIndex((line) => line.startsWith('import'));
    const insertIndex = firstImport === -1 ? 0 : firstImport + 1;
    lines.splice(insertIndex, 0, wrapperImportStatement);
    content = lines.join('\n');
  }

  await fs.writeFile(providersPath, content);

  const wrapperPath = resolve(projectDir, 'lib/client-translations.tsx');
  if (await fs.pathExists(wrapperPath)) {
    await fs.remove(wrapperPath);
  }
}

async function ensureEditorUtils(projectDir) {
  const exists = await fs.pathExists(EDITOR_UTILS_SOURCE_DIR);
  if (!exists) {
    return [];
  }

  const entries = await fs.readdir(EDITOR_UTILS_SOURCE_DIR);
  const utilNames = entries
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.replace(/\.ts$/, ''));

  if (utilNames.length === 0) {
    return [];
  }

  const destinationDir = resolve(projectDir, 'lib/editor/utils');
  await fs.ensureDir(destinationDir);

  for (const utilName of utilNames) {
    const sourcePath = resolve(EDITOR_UTILS_SOURCE_DIR, `${utilName}.ts`);
    const destinationPath = resolve(destinationDir, `${utilName}.ts`);
    await fs.copy(sourcePath, destinationPath);
  }

  return utilNames;
}

async function sanitizeBlockEditorImports(projectDir) {
  const blockEditorPath = resolve(
    projectDir,
    'app/cms/blocks/components/BlockEditorArea.tsx',
  );
  if (!(await fs.pathExists(blockEditorPath))) {
    return;
  }

  const content = await fs.readFile(blockEditorPath, 'utf8');
  const replacements = [
    { pattern: /(\.\.\/editors\/[A-Za-z0-9_-]+)\.js/g, replacement: '$1.tsx' },
    { pattern: /(\.\.\/actions)\.js/g, replacement: '$1.ts' },
  ];

  const updated = replacements.reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, replacement),
    content,
  );

  if (updated !== content) {
    await fs.writeFile(blockEditorPath, updated);
  }
}

async function sanitizeUiImports(projectDir) {
  const searchDirs = ['app', 'components', 'context', 'lib'];
  const validExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
  const files = [];

  for (const relativeDir of searchDirs) {
    const absoluteDir = resolve(projectDir, relativeDir);
    if (await fs.pathExists(absoluteDir)) {
      await collectFiles(absoluteDir, files, validExtensions);
    }
  }

  for (const filePath of files) {
    const original = await fs.readFile(filePath, 'utf8');
    const updated = original.replace(
      /@nextblock-cms\/ui\/(?!styles\/)[A-Za-z0-9/_-]+/g,
      '@nextblock-cms/ui',
    );
    if (updated !== original) {
      await fs.writeFile(filePath, updated);
    }
  }
}

async function collectFiles(directory, accumulator, extensions) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, accumulator, extensions);
    } else {
      const dotIndex = entry.name.lastIndexOf('.');
      if (dotIndex !== -1) {
        const ext = entry.name.slice(dotIndex);
        if (extensions.has(ext)) {
          accumulator.push(fullPath);
        }
      }
    }
  }
}

async function ensureUiProxies(projectDir) {
  const proxiesDir = resolve(projectDir, 'lib/ui');
  await fs.ensureDir(proxiesDir);

  const proxyContent = "export * from '@nextblock-cms/ui';\n";

  for (const moduleName of UI_PROXY_MODULES) {
    const proxyPath = resolve(proxiesDir, `${moduleName}.ts`);
    if (!(await fs.pathExists(proxyPath))) {
      await fs.outputFile(proxyPath, proxyContent);
    }
  }
}

async function sanitizeLayout(projectDir) {
  await ensureGlobalStyles(projectDir);
  await ensureEditorStyles(projectDir);

  const layoutPath = resolve(projectDir, 'app/layout.tsx');
  if (!(await fs.pathExists(layoutPath))) {
    return;
  }

  const requiredImports = [
    "import '@nextblock-cms/ui/styles/globals.css';",
  ];

  const content = await fs.readFile(layoutPath, 'utf8');
  let updated = content.replace(/import\s+['"]\.\/globals\.css['"];?\s*/g, '');
  updated = updated.replace(/import\s+['"]\.\/editor\.css['"];?\s*/g, '');

  const missingImports = requiredImports.filter(
    (statement) => !updated.includes(statement),
  );
  if (missingImports.length > 0) {
    updated = `${missingImports.join('\n')}\n${updated}`;
  }

  if (updated !== content) {
    await fs.writeFile(layoutPath, updated);
  }
}

async function ensureGlobalStyles(projectDir) {
  const destination = resolve(projectDir, 'app/globals.css');

  if (!(await fs.pathExists(destination))) {
    return;
  }

  const content = (await fs.readFile(destination, 'utf8')).trim();
  if (
    content === '' ||
    content.startsWith('/* Project-level overrides') ||
    content.includes('@tailwind base')
  ) {
    await fs.remove(destination);
  }
}

async function ensureEditorStyles(projectDir) {
  const stylesDir = resolve(projectDir, 'app');
  const editorPath = resolve(stylesDir, 'editor.css');
  const dragHandlePath = resolve(stylesDir, 'drag-handle.css');

  for (const filePath of [editorPath, dragHandlePath]) {
    if (await fs.pathExists(filePath)) {
      const content = (await fs.readFile(filePath, 'utf8')).trim();
      if (
        content === '' ||
        content.startsWith('/* Editor styles placeholder') ||
        content.includes('@nextblock-cms/editor/styles')
      ) {
        await fs.remove(filePath);
      }
    }
  }
}

async function sanitizeTailwindConfig(projectDir) {
  const tailwindConfigPath = resolve(projectDir, 'tailwind.config.js');
  const content = `/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './context/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@nextblock-cms/ui/**/*.{js,ts,jsx,tsx}',
    './node_modules/@nextblock-cms/editor/**/*.{js,ts,jsx,tsx}',
  ],
  safelist: [
    'animate-enter',
    'animate-leave',
    'dark',
    'text-primary',
    'text-secondary',
    'text-accent',
    'text-muted',
    'text-destructive',
    'text-background',
  ],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
`;

  await fs.writeFile(tailwindConfigPath, content);
}

async function normalizeTsconfig(projectDir) {
  const tsconfigPath = resolve(projectDir, 'tsconfig.json');
  if (!(await fs.pathExists(tsconfigPath))) {
    return;
  }

  const tsconfig = await fs.readJSON(tsconfigPath);
  if ('extends' in tsconfig) {
    delete tsconfig.extends;
  }

  if ('references' in tsconfig) {
    delete tsconfig.references;
  }
  const defaultInclude = new Set([
    'next-env.d.ts',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '.next/types/**/*.ts',
    // Next 16 (Turbopack dev) auto-adds this on first `next dev`; pre-include it so the
    // "we reconfigured your tsconfig" message never appears.
    '.next/dev/types/**/*.ts',
  ]);

  if (Array.isArray(tsconfig.include)) {
    for (const entry of tsconfig.include) {
      if (typeof entry === 'string' && !entry.includes('../')) {
        defaultInclude.add(entry);
      }
    }
  }

  tsconfig.include = Array.from(defaultInclude);

  const defaultExclude = new Set(['node_modules']);
  if (Array.isArray(tsconfig.exclude)) {
    for (const entry of tsconfig.exclude) {
      if (typeof entry === 'string' && !entry.includes('../')) {
        defaultExclude.add(entry);
      }
    }
  }

  tsconfig.exclude = Array.from(defaultExclude);

  tsconfig.compilerOptions = {
    ...(tsconfig.compilerOptions ?? {}),
    // No baseUrl: TypeScript 6 deprecates it (TS5101), and the paths below are './'-relative,
    // which TypeScript resolves against this file's directory without it.
    skipLibCheck: true,
    // Next 16 sets this on first run (React automatic runtime); pre-set it to avoid the
    // "mandatory changes were made to your tsconfig" message.
    jsx: 'react-jsx',
  };

  const compilerOptions = tsconfig.compilerOptions;
  compilerOptions.paths = {
    ...(compilerOptions.paths ?? {}),
    '@/*': ['./*'],
    '@nextblock-cms/ui/*': ['./lib/ui/*'],
    '@nextblock-cms/editor/utils/*': ['./lib/editor/utils/*'],
  };

  await fs.writeJSON(tsconfigPath, tsconfig, { spaces: 2 });
}

/**
 * The template ships the app's own next.config.js; derive the standalone variant from it
 * (bin/lib/next-config.js) instead of rewriting the file from a string template that drifts.
 */
async function sanitizeNextConfig(projectDir) {
  const nextConfigPath = resolve(projectDir, 'next.config.js');
  const source = await fs.readFile(nextConfigPath, 'utf8');
  await fs.writeFile(nextConfigPath, patchNextConfigForStandalone(source));
}

/**
 * The template's eslint.config.mjs is the monorepo's (it imports @nx/eslint-plugin and a
 * ../../ root config that a scaffold does not have), so replace it with the standalone one
 * from bin/lib/eslint-config.js. Always written, so an older template cannot leak through.
 */
async function writeStandaloneEslintConfig(projectDir) {
  await fs.writeFile(resolve(projectDir, 'eslint.config.mjs'), STANDALONE_ESLINT_CONFIG);
}

async function ensurePublicNpmrc(projectDir) {
  const npmrcPath = resolve(projectDir, '.npmrc');
  // Force the public registry for the @nextblock-cms scope for the initial install
  // This ensures that even if the user has a global .npmrc pointing to GitHub,
  // we use the public ghost modules (or full modules) from npmjs.org first.
  const content = '@nextblock-cms:registry=https://registry.npmjs.org\n';
  await fs.writeFile(npmrcPath, content);
}

async function transformPackageJson(projectDir) {
  const packageJsonPath = resolve(projectDir, 'package.json');
  if (!(await fs.pathExists(packageJsonPath))) {
    return;
  }

  const packageJson = await fs.readJSON(packageJsonPath);
  const projectName = basename(projectDir);

  // Capture the template's version BEFORE the manifest becomes the user's to manage.
  // From here on `packageJson.version` belongs to their site; this stamp is what
  // `npm run update` and the dashboard's update check compare against, so that a user
  // versioning their own project can never break update detection.
  const scaffoldedFrom =
    typeof packageJson.version === 'string' ? packageJson.version : null;

  if (projectName) {
    packageJson.name = projectName;
  }

  packageJson.version = packageJson.version ?? '0.1.0';
  packageJson.private = packageJson.private ?? true;

  // `install` is the authoritative answer to "can the upstream-sync GitHub Action work
  // here?". The Action merges the NextBlock MONOREPO into the repository, so it only makes
  // sense for a repo that IS the monorepo (a 1-click deploy, fork or clone). This project
  // is the flattened standalone app, so the answer is no — and the marker must overwrite
  // the "monorepo" value the template inherits from apps/nextblock/package.json.
  packageJson.nextblock = {
    ...(packageJson.nextblock ?? {}),
    install: 'standalone',
    ...(scaffoldedFrom ? { version: scaffoldedFrom, installedAt: new Date().toISOString() } : {}),
  };

  packageJson.dependencies = packageJson.dependencies ?? {};

  for (const [pkgName, manifestPath] of Object.entries(
    PACKAGE_VERSION_SOURCES,
  )) {
    if (pkgName in packageJson.dependencies) {
      const current = packageJson.dependencies[pkgName];
      if (typeof current === 'string' && current.startsWith('workspace:')) {
        let versionSpecifier = 'latest';
        try {
          const manifest = await fs.readJSON(manifestPath);
          if (manifest.version) {
            versionSpecifier = `^${manifest.version}`;
          }
        } catch {
          versionSpecifier = 'latest';
        }

        packageJson.dependencies[pkgName] = versionSpecifier;
      }
    }
  }

  // Mirror the monorepo's defensive dependency overrides into the generated project so a
  // fresh `npm install` reproduces the "0 vulnerabilities" posture and silences deprecated
  // transitive deps (e.g. uuid@10). Read live from the repo root when available (local dev /
  // `npm run test-create`); fall back to FALLBACK_OVERRIDES (./lib/fallback-overrides.js)
  // in the published CLI, where the monorepo root is not on disk.
  let rootOverrides = FALLBACK_OVERRIDES;
  let supabaseCliVersion = '^2.117.0'; // keep in sync with the repo root devDependency
  try {
    const rootPkg = await fs.readJSON(resolve(REPO_ROOT, 'package.json'));
    if (rootPkg?.overrides && Object.keys(rootPkg.overrides).length > 0) {
      rootOverrides = rootPkg.overrides;
    }
    const rootSupabase =
      rootPkg?.devDependencies?.supabase ?? rootPkg?.dependencies?.supabase;
    if (rootSupabase) {
      supabaseCliVersion = rootSupabase;
    }
  } catch {
    // Published CLI: repo root package.json not present — keep the baked-in fallbacks.
  }
  // Project-specific overrides (if any) win over the inherited defaults.
  packageJson.overrides = { ...rootOverrides, ...(packageJson.overrides ?? {}) };

  // Ship the Supabase CLI as a devDependency so setup / link / db push use a locally-installed
  // binary. Without it, `npx supabase` downloads the CLI (~40MB) and shows an "Ok to proceed?"
  // prompt mid-wizard that looks like a hang.
  packageJson.devDependencies = packageJson.devDependencies ?? {};
  if (!packageJson.devDependencies.supabase) {
    packageJson.devDependencies.supabase = supabaseCliVersion;
  }

  // npm throws EOVERRIDE when a package is BOTH a direct dependency and has an override with a
  // different spec (e.g. dependencies.uuid ^11.0.4 vs overrides.uuid ^11.1.1). Align any such
  // direct (dev)dependency to the override value so they share the exact same spec — which is
  // also what lets the override dedupe that package's transitive copies.
  for (const [name, spec] of Object.entries(packageJson.overrides)) {
    if (typeof spec !== 'string') continue;
    if (packageJson.dependencies?.[name] !== undefined) {
      packageJson.dependencies[name] = spec;
    }
    if (packageJson.devDependencies?.[name] !== undefined) {
      packageJson.devDependencies[name] = spec;
    }
  }

  await fs.writeJSON(packageJsonPath, packageJson, { spaces: 2 });
}

async function installDependencies(projectDir, { log = console.log } = {}) {
  const npmCommand = IS_WINDOWS ? 'npm.cmd' : 'npm';
  log(chalk.blue('Installing dependencies with npm...'));
  // In the headless flow `log` writes to stderr; keep npm's own output there too so
  // stdout stays reserved for the JSON result.
  await runCommand(npmCommand, ['install'], {
    cwd: projectDir,
    ...(log === console.log ? {} : { stdio: ['ignore', process.stderr, process.stderr] }),
  });
  log(chalk.green('Dependencies installed.'));
}

async function initializeGit(projectDir, { log = console.log } = {}) {
  const gitDirectory = resolve(projectDir, '.git');
  if (await fs.pathExists(gitDirectory)) {
    return;
  }

  try {
    log(chalk.blue('Initializing Git repository...'));
    // In the headless flow `log` writes to stderr; keep git's own output there too so
    // stdout stays reserved for the JSON result.
    await runCommand('git', ['init'], {
      cwd: projectDir,
      ...(log === console.log ? {} : { stdio: ['ignore', process.stderr, process.stderr] }),
    });
    log(chalk.green('Git repository initialized.'));
  } catch (error) {
    log(
      chalk.yellow(
        `Skipping Git initialization: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: IS_WINDOWS,
      ...options,
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function getSupabaseBinary(projectDir) {
  const binDir = resolve(projectDir, 'node_modules', '.bin');
  const ext = IS_WINDOWS ? '.cmd' : '';
  const binaryPath = resolve(binDir, `supabase${ext}`);
  if (await fs.pathExists(binaryPath)) {
    return binaryPath;
  }
  return 'npx';
}

