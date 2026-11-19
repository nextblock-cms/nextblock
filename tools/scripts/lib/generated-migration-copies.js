// The generated copies of the migration files, and whether they still match the files.
//
//   apps/nextblock/lib/setup/migrations-bundle.ts                  MIGRATIONS_BUNDLE, written by
//       tools/scripts/generate-migrations-bundle.ts (npm run generate:migrations-bundle): /setup applies
//       these where libs/db is not on disk (Vercel), and the create-nextblock template ships a copy.
//   apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts   SANDBOX_RESET_SQL, written by
//       tools/scripts/generate-sandbox-reset.ts (npm run generate:sandbox): the public sandbox replays
//       every file from it every 15 minutes.
//
// Nothing regenerates them on its own, so a migration edited after the last run leaves /setup and the
// sandbox creating what the file used to say (on 2026-11-18, 02043, 02044 and 02045 changed after the
// last generation, and the reset still embedded the helper that broke its own replay). This module
// rebuilds what each generator would embed from the files on disk and compares, without running the
// generators (they write files). Its rules copy the generators' own;
// tools/scripts/generated-migration-copies.test.ts holds them to the generators' source.

const BUNDLE_FILE = 'apps/nextblock/lib/setup/migrations-bundle.ts';
const BUNDLE_COMMAND = 'npm run generate:migrations-bundle';
const SANDBOX_FILE = 'apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts';
const SANDBOX_COMMAND = 'npm run generate:sandbox';

/** The line SANDBOX_RESET_SQL carries after the last file (generate-sandbox-reset.ts, Step C2). */
const SANDBOX_AFTER_MIGRATIONS = '\n\n  -- Step C2:';
/** Each file's line before its text in SANDBOX_RESET_SQL. */
const SANDBOX_FROM_LINE = /\n\n-- >>> FROM: (.+) <<<\n/g;

/** The files generate-migrations-bundle.ts embeds, in its order. */
function bundleFileNames(names) {
  return names.filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
}

/** The files generate-sandbox-reset.ts embeds, in its order. */
function sandboxFileNames(names) {
  return names
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => !name.toLowerCase().includes('sandbox'))
    .filter((name) => name !== '99999999999999_auto_sandbox_reset.sql')
    .sort();
}

/** One MIGRATIONS_BUNDLE entry as generate-migrations-bundle.ts writes it: LF line endings. */
function bundleEntry(name, text) {
  return { version: name.split('_')[0], name, sql: text.replace(/\r\n/g, '\n') };
}

/** One file's text as generate-sandbox-reset.ts embeds it: LF line endings, BEGIN; and COMMIT; stripped. */
function sandboxFileText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/(?:^|\n)\s*BEGIN\s*;/gi, '\n')
    .replace(/(?:^|\n)\s*COMMIT\s*;/gi, '\n');
}

/** The 1-based line where two texts first differ. */
function firstDifferentLine(expected, actual) {
  const want = expected.split('\n');
  const got = actual.split('\n');
  for (let index = 0; index < Math.max(want.length, got.length); index += 1) {
    if (want[index] !== got[index]) return index + 1;
  }
  return 0;
}

/** Names on disk the copy lacks, names it has that are not on disk, and an order that is not the generator's. */
function compareNames(expected, embedded, where) {
  const problems = [];
  const expectedSet = new Set(expected);
  const embeddedSet = new Set(embedded);
  for (const name of expected) {
    if (!embeddedSet.has(name)) problems.push(`${name}: on disk, missing from ${where}`);
  }
  for (const name of embedded) {
    if (!expectedSet.has(name)) problems.push(`${name}: in ${where}, not a migration file on disk`);
  }
  if (problems.length === 0 && expected.join('\n') !== embedded.join('\n')) {
    problems.push(`${where} lists the files in another order than their names sort`);
  }
  return problems;
}

/**
 * What differs between MIGRATIONS_BUNDLE and what generate-migrations-bundle.ts would write from
 * `files` ([{ name, text }], the migrations folder's .sql files): one line per problem, none when the
 * bundle is current.
 */
function compareMigrationsBundle(files, bundle) {
  const texts = new Map(files.map((file) => [file.name, file.text]));
  const expected = bundleFileNames([...texts.keys()]).map((name) => bundleEntry(name, texts.get(name)));
  const byName = new Map(bundle.map((entry) => [entry.name, entry]));
  const problems = compareNames(
    expected.map((entry) => entry.name),
    bundle.map((entry) => entry.name),
    'the bundle'
  );

  for (const entry of expected) {
    const embedded = byName.get(entry.name);
    if (!embedded) continue;
    if (embedded.version !== entry.version) {
      problems.push(`${entry.name}: the bundle gives it version ${embedded.version}, not ${entry.version}`);
    }
    if (embedded.sql !== entry.sql) {
      problems.push(`${entry.name}: the bundle holds another copy of it (differs from line ${firstDifferentLine(entry.sql, embedded.sql)})`);
    }
  }
  return problems;
}

/**
 * What differs between SANDBOX_RESET_SQL and what generate-sandbox-reset.ts would embed from `files`
 * ([{ name, text }]): each file after its FROM line, in order, nothing between them, the reset's Step C2
 * after the last. One line per problem, none when the reset is current.
 */
function compareSandboxReset(files, resetSql) {
  const texts = new Map(files.map((file) => [file.name, file.text]));
  const expected = sandboxFileNames([...texts.keys()]);
  const markers = [...resetSql.matchAll(SANDBOX_FROM_LINE)].map((match) => ({
    name: match[1],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const problems = compareNames(
    expected,
    markers.map((marker) => marker.name),
    'the sandbox reset'
  );

  markers.forEach((marker, index) => {
    if (!texts.has(marker.name) || !expected.includes(marker.name)) return;
    const next = markers[index + 1];
    const end = next ? next.start : resetSql.indexOf(SANDBOX_AFTER_MIGRATIONS, marker.end);
    const embedded = resetSql.slice(marker.end, end === -1 ? resetSql.length : end);
    const want = sandboxFileText(texts.get(marker.name));
    if (embedded !== want) {
      problems.push(`${marker.name}: the sandbox reset holds another copy of it (differs from line ${firstDifferentLine(want, embedded)})`);
    }
  });
  return problems;
}

function findVariableInitializer(ts, source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        let value = declaration.initializer;
        while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) {
          value = value.expression;
        }
        return value;
      }
    }
  }
  return undefined;
}

function parseModule(text, fileName) {
  const ts = require('typescript');
  return { ts, source: ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS) };
}

/**
 * MIGRATIONS_BUNDLE as `text` (the module's source) defines it, read with the TypeScript parser: the
 * module is never run, and each string is the value JavaScript gives it. Throws, naming the command,
 * when the module does not have the generator's shape.
 */
function readMigrationsBundleSource(text, fileName = BUNDLE_FILE) {
  const { ts, source } = parseModule(text, fileName);
  const fail = (reason) => new Error(`${fileName} ${reason}: regenerate it with ${BUNDLE_COMMAND}`);
  const list = findVariableInitializer(ts, source, 'MIGRATIONS_BUNDLE');
  if (!list || !ts.isArrayLiteralExpression(list)) throw fail('declares no MIGRATIONS_BUNDLE array');

  return list.elements.map((element, index) => {
    const entry = {};
    if (ts.isObjectLiteralExpression(element)) {
      for (const property of element.properties) {
        if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && ts.isStringLiteralLike(property.initializer)) {
          entry[property.name.text] = property.initializer.text;
        }
      }
    }
    for (const key of ['version', 'name', 'sql']) {
      if (typeof entry[key] !== 'string') throw fail(`has a MIGRATIONS_BUNDLE entry (index ${index}) without a string "${key}"`);
    }
    return { version: entry.version, name: entry.name, sql: entry.sql };
  });
}

/**
 * SANDBOX_RESET_SQL as `text` (the module's source) defines it: a template literal without
 * substitutions, read with the TypeScript parser as JavaScript cooks it (escapes undone, CRLF read as
 * LF). Throws, naming the command, when the module does not have the generator's shape.
 */
function readSandboxResetSource(text, fileName = SANDBOX_FILE) {
  const { ts, source } = parseModule(text, fileName);
  const value = findVariableInitializer(ts, source, 'SANDBOX_RESET_SQL');
  if (!value || !ts.isStringLiteralLike(value)) {
    throw new Error(`${fileName} declares no SANDBOX_RESET_SQL string: regenerate it with ${SANDBOX_COMMAND}`);
  }
  return value.text;
}

module.exports = {
  BUNDLE_COMMAND,
  BUNDLE_FILE,
  SANDBOX_AFTER_MIGRATIONS,
  SANDBOX_COMMAND,
  SANDBOX_FILE,
  bundleEntry,
  bundleFileNames,
  compareMigrationsBundle,
  compareSandboxReset,
  readMigrationsBundleSource,
  readSandboxResetSource,
  sandboxFileNames,
  sandboxFileText,
};
