const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { assertProjectRef, configPushArgs, linkArgs } = require('./lib/supabase-cli');

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
  } else {
    try {
      assertProjectRef(process.env.SUPABASE_PROJECT_ID);
    } catch (error) {
      console.error(`${colors.red}${error.message}${colors.reset}`);
      process.exit(1);
    }
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

async function deploy() {
  loadEnvFiles();

  console.log(`${colors.green}Starting Supabase deployment...${colors.reset}`);

  if (!checkEnv()) {
    process.exit(0);
  }

  const dbPassword = getDbPassword();
  if (!dbPassword) {
    console.error(
      `${colors.red}Could not determine database password.${colors.reset}`,
    );
    process.exit(1);
  }

  // Every CLI call names the project: Supabase CLI 3 targets the LOCAL stack when a database
  // command is given no --remote (lib/supabase-cli.js). The ref was validated in checkEnv().
  const target = { workdir: 'libs/db/src', projectRef: process.env.SUPABASE_PROJECT_ID };

  console.log(`${colors.green}Linking to Supabase project...${colors.reset}`);
  runCommand(['npx', 'supabase', ...linkArgs(target)].join(' '));

  console.log(
    `${colors.green}Pushing database migrations...${colors.reset}`,
  );
  runCommand('node tools/scripts/push-db-migrations.js --confirm --skip-link');

  console.log(
    `${colors.green}Pushing Supabase config (Site URL: ${process.env.NEXT_PUBLIC_URL})...${colors.reset}`,
  );
  runCommand(['npx', 'supabase', ...configPushArgs(target)].join(' '));

  console.log(
    `${colors.green}Syncing Supabase Auth SMTP + email templates...${colors.reset}`,
  );
  runCommand('node apps/nextblock/tools/configure-supabase-auth.js');

  console.log(`${colors.green}Supabase deployment complete!${colors.reset}`);
}

deploy();
