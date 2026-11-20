const { execSync } = require('child_process');
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

function runCommand(command) {
  try {
    console.log(`${colors.blue}Running: ${command}${colors.reset}`);
    execSync(command, { stdio: 'inherit' });
  } catch {
    console.error(`${colors.red}Command failed: ${command}${colors.reset}`);
    process.exit(1);
  }
}

function detectWorkDirFlag() {
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
    return '--workdir ../../libs/db/src';
  }

  if (fs.existsSync(standaloneDbPath)) {
    console.log(
      `${colors.blue}Detected standalone environment (./supabase).${colors.reset}`,
    );
    return '';
  }

  if (fs.existsSync(rootDbPath)) {
    console.log(
      `${colors.blue}Detected monorepo workspace root (libs/db/src).${colors.reset}`,
    );
    return '--workdir libs/db/src';
  }

  return '';
}

// A Supabase project ref is exactly 20 lowercase letters. Supabase CLI 3 looks any other value up as
// a branch name of the project this directory is already linked to, so anything else is refused.
const PROJECT_REF_RE = /^[a-z]{20}$/;

/**
 * The installed Supabase CLI's major version, or null when it cannot be read. `npm run update`
 * ships this script to projects created before Supabase CLI 3 whose `supabase` devDependency is
 * still 2.x, so the target flags depend on the version (docs/13 → "Supabase CLI 3").
 */
function supabaseMajorVersion() {
  try {
    const output = execSync('npx supabase --version', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseSupabaseMajorVersion(output);
  } catch {
    return null;
  }
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
 * The commands for one CLI major, each naming its target. CLI 3 reads the LOCAL stack when a
 * database command is given no `--remote`, and wants `--yes` for every hosted write; CLI 2 targets
 * the linked project by default, and `--linked` says so. An unreadable version gets the CLI 3
 * flags: a CLI 2 then stops on "unknown flag: --remote" instead of pushing anywhere.
 */
function deployCommands({ major, projectRef, dbPassword, workDirFlag }) {
  const parts = (...items) => items.filter(Boolean).join(' ');
  if (major !== null && major < 3) {
    return {
      link: parts('npx supabase link --project-ref', projectRef, '--password', dbPassword, workDirFlag, '--yes'),
      push: parts('npx supabase db push --linked --password', dbPassword, '--yes', workDirFlag),
      config: parts('npx supabase config push', workDirFlag, '--yes'),
    };
  }
  const remote = `--remote=${projectRef}`;
  return {
    // CLI 3's link never connects to the database and ignores --password.
    link: parts('npx supabase link --project-ref', projectRef, workDirFlag),
    push: parts('npx supabase db push', remote, '--password', dbPassword, '--yes', workDirFlag),
    config: parts('npx supabase config push', remote, '--yes', workDirFlag),
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

  const workDirFlag = detectWorkDirFlag();
  const major = supabaseMajorVersion();
  const commands = deployCommands({ major, projectRef, dbPassword, workDirFlag });

  console.log(`${colors.green}Linking to Supabase project...${colors.reset}`);
  runCommand(commands.link);

  console.log(
    `${colors.green}Pushing database migrations...${colors.reset}`,
  );
  runCommand(commands.push);

  console.log(
    `${colors.green}Pushing Supabase config (Site URL: ${process.env.NEXT_PUBLIC_URL})...${colors.reset}`,
  );
  runCommand(commands.config);

  console.log(
    `${colors.green}Syncing Supabase Auth SMTP + email templates...${colors.reset}`,
  );
  runCommand('node tools/configure-supabase-auth.js');

  console.log(`${colors.green}Supabase deployment complete!${colors.reset}`);
}

module.exports = { deployCommands, parseSupabaseMajorVersion, supabaseMajorVersion };

if (require.main === module) {
  deploy();
}
