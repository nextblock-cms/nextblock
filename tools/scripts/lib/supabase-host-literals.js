// No Supabase host is written into shipped code.
//
// A project reaches its own Supabase through the URL in its env (or the one /setup saves), and a
// factory with no env builds its client on UNCONFIGURED_SUPABASE_URL
// (libs/db/src/lib/supabase/unconfigured.ts): a `.invalid` host that never resolves, with a fetch that
// answers every request locally. Until 0.23.5 three factories fell back to
// `https://dummy.supabase.co` instead. That host sits on Supabase's real domain, and postgrest-js
// retries a failed GET three times, 1 s, 2 s and 4 s apart, so a create-nextblock scaffold building
// before /setup made about 1,300 connection attempts to it per build (post-publish check,
// 2026-11-17).
//
// The check fails on a string or template literal in apps/nextblock or libs that holds an http(s)
// URL on a Supabase domain (`supabase.co`, `supabase.in` and their subdomains), unless
// SUPABASE_HOST_LITERALS lists that exact literal for that module with why. Comments and JSX text
// do not count. The scan reads what scanRepository parses, plus apps/nextblock/tools and
// apps/nextblock/scripts (EXTRA_ROOTS), which the service-role boundary scan skips because nothing
// bundles them, but which ship in every scaffold and run there. Out of scope: tests, declaration
// files, stories, stale compiled twins, generated files, the CLI template (a copy of the app),
// apps/nextblock/public (no code) and the Deno edge function under libs/db/src/supabase/functions,
// which never ships to a scaffold.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { scanRepository } = require('./service-role-boundary.js');

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Shipped code the boundary scan leaves out: the build hook (tools/build-migrate.mjs is the
 * template's `prebuild`, so it runs in the very build that comes before /setup, along with
 * tools/lib/migrate-core.mjs) and the Node scripts.
 */
const EXTRA_ROOTS = ['apps/nextblock/tools', 'apps/nextblock/scripts'];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.stories\.[jt]sx?$/;

function walkSources(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || /^__(?:tests|mocks)__$/.test(entry.name)) continue;
      walkSources(absolute, found);
    } else if (SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
      found.push(absolute);
    }
  }
}

/** The modules the check reads, as `{ absolute, repoPath }`: scanRepository's, then EXTRA_ROOTS'. */
function hostLiteralModules() {
  const modules = new Map();
  for (const [absolute, mod] of scanRepository()) modules.set(absolute, { absolute, repoPath: mod.repoPath });
  for (const root of EXTRA_ROOTS) {
    const files = [];
    walkSources(path.join(REPO_ROOT, root), files);
    for (const absolute of files) {
      modules.set(absolute, { absolute, repoPath: path.relative(REPO_ROOT, absolute).split(path.sep).join('/') });
    }
  }
  return modules;
}

/** An http(s) URL on a Supabase domain, anywhere in a literal's text. */
const SUPABASE_URL_IN_TEXT = /https?:\/\/(?:[^\s'"`/?#]*\.)?supabase\.(?:co|in)(?![\w.-])/i;
/** Cheap text test before a module is parsed. */
const HINT = /supabase\.(?:co|in)/i;

/** Literals that hold a Supabase URL and never become a request target, by module, with why. */
const SUPABASE_HOST_LITERALS = new Map([
  [
    'apps/nextblock/app/setup/SetupWizard.tsx',
    { literals: ['https://YOUR-PROJECT.supabase.co'], why: "the Supabase URL field's placeholder text." },
  ],
]);

/** Script kind by extension, as the boundary scan does: `.js` may hold JSX. */
function parseSource(fileName, source) {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(fileName)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source; // drop a byte-order mark
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Every string or template literal of a parsed module that holds a Supabase URL, as
 * `{ text, line }`. A template literal is read whole, its substitutions as `x`, so
 * `https://${ref}.supabase.co` counts.
 */
function literalsIn(sourceFile) {
  const found = [];
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    let text = null;
    if (ts.isStringLiteralLike(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join('');
    }
    if (text !== null && SUPABASE_URL_IN_TEXT.test(text)) found.push({ text, line: at(node) });
    // A template expression's substitutions may hold literals of their own.
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Every literal of a module's source that holds a Supabase URL, as `{ text, line }`. */
function supabaseUrlLiteralsInSource(fileName, source) {
  return literalsIn(parseSource(fileName, source));
}

/**
 * Modules with a Supabase URL literal that SUPABASE_HOST_LITERALS does not list, modules that
 * cannot be parsed, and entries that no longer match their module.
 */
function findSupabaseHostLiteralProblems(
  modules = hostLiteralModules(),
  allowed = SUPABASE_HOST_LITERALS,
  readFile = (absolute) => fs.readFileSync(absolute, 'utf8')
) {
  const problems = [];
  const seen = new Map();
  for (const mod of modules.values()) {
    const source = readFile(mod.absolute);
    if (!HINT.test(source)) continue;
    const sourceFile = parseSource(mod.absolute, source);
    if (sourceFile.parseDiagnostics?.length > 0) {
      problems.push(`${mod.repoPath} cannot be parsed, so the Supabase host scan cannot check it: fix the syntax error.`);
      continue;
    }
    const found = literalsIn(sourceFile);
    if (found.length === 0) continue;
    seen.set(mod.repoPath, new Set(found.map(({ text }) => text)));
    const listed = new Set(allowed.get(mod.repoPath)?.literals ?? []);
    for (const { text, line } of found) {
      if (listed.has(text)) continue;
      problems.push(
        `${mod.repoPath} (line ${line}) writes a Supabase URL into code: ${JSON.stringify(text)}. A project's Supabase URL comes from its env, and a client with no env is built on UNCONFIGURED_SUPABASE_URL with unconfiguredSupabaseFetch (@nextblock-cms/db/server), which never leave the machine. A literal that never becomes a request target goes in SUPABASE_HOST_LITERALS (tools/scripts/lib/supabase-host-literals.js) with why.`
      );
    }
  }
  for (const [repoPath, { literals }] of allowed) {
    for (const text of literals) {
      if (!seen.get(repoPath)?.has(text)) {
        problems.push(`SUPABASE_HOST_LITERALS lists ${JSON.stringify(text)} for ${repoPath}, which no longer holds it: remove the entry.`);
      }
    }
  }
  return problems;
}

module.exports = {
  EXTRA_ROOTS,
  SUPABASE_HOST_LITERALS,
  findSupabaseHostLiteralProblems,
  hostLiteralModules,
  supabaseUrlLiteralsInSource,
};
