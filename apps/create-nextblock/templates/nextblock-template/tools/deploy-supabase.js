const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
};

function loadEnvFiles() {
  const candidates = [
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false, quiet: true });
    }
  }
}

function getDbPassword() {
  if (process.env.SUPABASE_DB_PASSWORD) {
    return process.env.SUPABASE_DB_PASSWORD;
  }

  if (process.env.POSTGRES_URL) {
    try {
      const url = new URL(process.env.POSTGRES_URL);
      return url.password;
    } catch {
      return null;
    }
  }

  return null;
}

function checkEnv() {
  const missing = [];

  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    missing.push('SUPABASE_ACCESS_TOKEN');
  }
  if (!process.env.SUPABASE_PROJECT_ID) {
    missing.push('SUPABASE_PROJECT_ID');
  }
  if (!process.env.NEXT_PUBLIC_URL) {
    missing.push('NEXT_PUBLIC_URL');
  }

  const dbPassword = getDbPassword();
  if (!dbPassword) {
    missing.push('SUPABASE_DB_PASSWORD (or POSTGRES_URL)');
  }

  if (missing.length > 0) {
    console.log(
      `${colors.yellow}Skipping Supabase deployment: Missing environment variables: ${missing.join(', ')}${colors.reset}`,
    );
    console.log(
      `${colors.yellow}This is expected for pull requests or forks without secrets configured.${colors.reset}`,
    );
    return false;
  }

  return true;
}

/**
 * How to start the project's Supabase CLI with no shell: `{ command, prefix }`, run as
 * `spawnSync(command, [...prefix, ...args])`. The `supabase` package's bin is a Node script in 2.117+
 * and 3.x (`dist/supabase.js`, which starts the platform binary), so it runs under this Node; a
 * package whose bin is the binary itself has it started directly. With no `supabase` package
 * installed, `npm run deploy:supabase` falls back to `npm exec --yes -- supabase` through npm's own
 * script (`npm_execpath`), which quotes each argument itself.
 *
 * Never a command string or `npx.cmd` through a shell: the shell gets the database password unescaped,
 * so a password holding `&`, `|`, `<`, `>`, `^`, `%`, `"`, `$`, `;` or a backtick breaks the command
 * or runs part of it as another one (Node 24+ warns about `shell: true` with arguments: DEP0190).
 * The monorepo's tools/scripts/lib/supabase-cli.js has the same function; deploy-supabase.test.mjs
 * holds the two to the same answer.
 */
function supabaseCliInvocation({
  from = process.cwd(),
  resolvePackageJson = (dir) => require.resolve('supabase/package.json', { paths: [dir] }),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  exists = fs.existsSync,
  platform = process.platform,
  nodePath = process.execPath,
  npmExecPath = process.env.npm_execpath,
} = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(from);
  } catch {
    if (typeof npmExecPath === 'string' && /npm-cli\.js$/i.test(npmExecPath)) {
      return { command: nodePath, prefix: [npmExecPath, 'exec', '--yes', '--', 'supabase'] };
    }
    throw new Error('The Supabase CLI is not installed (no `supabase` package). Run `npm install` first.');
  }
  const manifest = JSON.parse(readFile(packageJsonPath));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.supabase;
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error(`The installed supabase package (${manifest.version || 'unknown version'}) has no \`supabase\` bin.`);
  }
  const binPath = path.resolve(path.dirname(packageJsonPath), bin);
  if (/\.[cm]?js$/i.test(binPath)) {
    return { command: nodePath, prefix: [binPath] };
  }
  // Windows starts only a path with its extension when no shell is involved.
  if (platform === 'win32' && !/\.exe$/i.test(binPath) && exists(`${binPath}.exe`)) {
    return { command: `${binPath}.exe`, prefix: [] };
  }
  return { command: binPath, prefix: [] };
}

/** The line printed before a command runs, with the database password masked. */
function printableCommand(args, secret) {
  return ['supabase', ...args]
    .map((arg) => (secret && arg === secret ? '<db-password>' : arg.includes(' ') ? `"${arg}"` : arg))
    .join(' ');
}

function runSupabase(cli, args, secret) {
  const shown = printableCommand(args, secret);
  console.log(`${colors.blue}Running: ${shown}${colors.reset}`);
  const result = spawnSync(cli.command, [...cli.prefix, ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`${colors.red}Command failed: ${shown}${colors.reset}`);
    process.exit(1);
  }
}

function runNodeScript(script) {
  console.log(`${colors.blue}Running: node ${script}${colors.reset}`);
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`${colors.red}Command failed: node ${script}${colors.reset}`);
    process.exit(1);
  }
}

/** `--workdir <dir>` as two arguments, or none. */
function detectWorkDirArgs() {
  const monorepoDbPath = path.join(
    process.cwd(),
    '../../libs/db/src/supabase/config.toml',
  );
  const standaloneDbPath = path.join(process.cwd(), 'supabase/config.toml');
  const rootDbPath = path.join(process.cwd(), 'libs/db/src/supabase/config.toml');

  if (fs.existsSync(monorepoDbPath)) {
    console.log(
      `${colors.blue}Detected monorepo environment (../../libs/db/src).${colors.reset}`,
    );
    return ['--workdir', '../../libs/db/src'];
  }

  if (fs.existsSync(standaloneDbPath)) {
    console.log(
      `${colors.blue}Detected standalone environment (./supabase).${colors.reset}`,
    );
    return [];
  }

  if (fs.existsSync(rootDbPath)) {
    console.log(
      `${colors.blue}Detected monorepo workspace root (libs/db/src).${colors.reset}`,
    );
    return ['--workdir', 'libs/db/src'];
  }

  return [];
}

// A Supabase project ref is exactly 20 lowercase letters. Supabase CLI 3 looks any other value up as
// a branch name of the project this directory is already linked to, so anything else is refused.
const PROJECT_REF_RE = /^[a-z]{20}$/;

/**
 * The installed Supabase CLI's major version, or null when it cannot be read. `npm run update`
 * ships this script to projects created before Supabase CLI 3 whose `supabase` devDependency is
 * still 2.x, so the target flags depend on the version (docs/13 → "Supabase CLI 3").
 */
function supabaseMajorVersion(cli = supabaseCliInvocation()) {
  const result = spawnSync(cli.command, [...cli.prefix, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseSupabaseMajorVersion(result.stdout);
}

/**
 * The major version from `supabase --version` output: the version on a line of its own. CLI 2 may
 * add "A new version of Supabase CLI is available: v3.2.0 (currently installed v2.122.1)", which
 * must not count, so only a line that starts with the version does.
 */
function parseSupabaseMajorVersion(output) {
  const match = /^\s*v?(\d+)\.\d+\.\d+\s*$/m.exec(String(output || ''));
  return match ? Number(match[1]) : null;
}

/**
 * The CLI arguments for one CLI major, each command naming its target, as arrays (no shell ever
 * sees them). CLI 3 reads the LOCAL stack when a database command is given no `--remote`, and wants
 * `--yes` for every hosted write; CLI 2 targets the linked project by default, and `--linked` says
 * so. An unreadable version gets the CLI 3 flags: a CLI 2 then stops on "unknown flag: --remote"
 * instead of pushing anywhere.
 */
function deployCommands({ major, projectRef, dbPassword, workDirArgs = [] }) {
  if (major !== null && major < 3) {
    return {
      link: ['link', '--project-ref', projectRef, '--password', dbPassword, ...workDirArgs, '--yes'],
      push: ['db', 'push', '--linked', '--password', dbPassword, '--yes', ...workDirArgs],
      config: ['config', 'push', ...workDirArgs, '--yes'],
    };
  }
  const remote = `--remote=${projectRef}`;
  return {
    // CLI 3's link never connects to the database and ignores --password.
    link: ['link', '--project-ref', projectRef, ...workDirArgs],
    push: ['db', 'push', remote, '--password', dbPassword, '--yes', ...workDirArgs],
    config: ['config', 'push', remote, '--yes', ...workDirArgs],
  };
}

async function deploy() {
  loadEnvFiles();

  console.log(`${colors.green}Starting Supabase deployment...${colors.reset}`);

  if (!checkEnv()) {
    process.exit(0);
  }

  const projectRef = process.env.SUPABASE_PROJECT_ID;
  if (!PROJECT_REF_RE.test(projectRef)) {
    console.error(
      `${colors.red}SUPABASE_PROJECT_ID must be your project ref: exactly 20 lowercase letters (Project Settings → General).${colors.reset}`,
    );
    process.exit(1);
  }

  const dbPassword = getDbPassword();
  if (!dbPassword) {
    console.error(
      `${colors.red}Could not determine database password.${colors.reset}`,
    );
    process.exit(1);
  }

  let cli;
  try {
    cli = supabaseCliInvocation();
  } catch (error) {
    console.error(`${colors.red}${error.message}${colors.reset}`);
    process.exit(1);
  }

  const workDirArgs = detectWorkDirArgs();
  const major = supabaseMajorVersion(cli);
  const commands = deployCommands({ major, projectRef, dbPassword, workDirArgs });

  console.log(`${colors.green}Linking to Supabase project...${colors.reset}`);
  runSupabase(cli, commands.link, dbPassword);

  console.log(
    `${colors.green}Pushing database migrations...${colors.reset}`,
  );
  runSupabase(cli, commands.push, dbPassword);

  console.log(
    `${colors.green}Pushing Supabase config (Site URL: ${process.env.NEXT_PUBLIC_URL})...${colors.reset}`,
  );
  runSupabase(cli, commands.config, dbPassword);

  console.log(
    `${colors.green}Syncing Supabase Auth SMTP + email templates...${colors.reset}`,
  );
  runNodeScript('tools/configure-supabase-auth.js');

  console.log(`${colors.green}Supabase deployment complete!${colors.reset}`);
}

module.exports = {
  deployCommands,
  parseSupabaseMajorVersion,
  printableCommand,
  supabaseCliInvocation,
  supabaseMajorVersion,
};

if (require.main === module) {
  deploy();
}
