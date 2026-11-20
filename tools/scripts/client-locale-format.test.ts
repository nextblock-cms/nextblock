import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A client component renders twice: on the server (UTC, the server's locale) and in the browser.
 * `toLocaleString()`, `toLocaleDateString()` and `toLocaleTimeString()` answer differently on each,
 * so text they print during the first render makes React throw #418 (hydration mismatch) and
 * rebuild the page on the client (`/cms/media/[id]/edit` did). `suppressHydrationWarning` only hides
 * it: React then keeps the server's text, and the Messages, Interactions and public thread pages
 * showed every time in the server's time zone. Print a timestamp with
 * `apps/nextblock/components/LocalDateTime.tsx` instead (UTC text on the server and while hydrating,
 * the viewer's own right after).
 *
 * This guard parses every `'use client'` module in apps/nextblock and libs (tests excluded) and
 * fails on a `toLocale*String()` call outside the allow-list below, or on an allow-list count that
 * no longer matches (remove or lower the entry). A call is allowed only when it can never reach the
 * first render: browser-only state, data fetched after mount, a click handler, or an explicit
 * locale and time zone (the same text on both sides). The scan sees only modules that carry the
 * directive themselves, not helpers they import.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['apps/nextblock', 'libs'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo', '.nx', 'out', '__fixtures__']);
const SKIP_PATHS = new Set(['apps/nextblock/public']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

/** repo path -> how many calls it may make, and why none of them reaches the first render. */
const ALLOWED: ReadonlyMap<string, { calls: number; why: string }> = new Map([
  ['apps/nextblock/components/LocalDateTime.tsx', { calls: 1, why: 'the component itself: only after hydration' }],
  [
    'apps/nextblock/app/article/[slug]/PostClientContent.tsx',
    { calls: 1, why: "the published date, with the post's language and timeZone 'UTC': the same text on both sides" },
  ],
  ['apps/nextblock/app/cms/pages/components/PageForm.tsx', { calls: 1, why: '`lastSaved` is set in the browser by an autosave' }],
  ['apps/nextblock/app/cms/posts/components/PostForm.tsx', { calls: 1, why: '`lastSaved` is set in the browser by an autosave' }],
  [
    'libs/ecommerce/src/lib/pages/cms/products/components/ProductForm.tsx',
    { calls: 1, why: '`lastSaved` is set in the browser by an autosave' },
  ],
  ['apps/nextblock/components/PostCommentsSection.tsx', { calls: 1, why: 'comments are fetched in the browser after mount' }],
  ['apps/nextblock/components/ProductReviewsSection.tsx', { calls: 1, why: 'reviews are fetched in the browser after mount' }],
  ['apps/nextblock/components/StaffReplies.tsx', { calls: 1, why: 'replies to comments and reviews fetched after mount' }],
  [
    'apps/nextblock/app/cms/settings/site-scripts/components/SiteScriptManager.tsx',
    { calls: 1, why: "the restore confirmation's label, built in the click handler" },
  ],
  [
    'apps/nextblock/app/cms/settings/packages/usePackageCheckout.ts',
    { calls: 1, why: "`formatPackageDate`: the trial's end, shown once a checkout finished in the browser" },
  ],
  [
    'apps/nextblock/components/seo/SeoAuditPanel.tsx',
    { calls: 1, why: "a character count with the explicit locale 'en-US' (the CMS is English-only)" },
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const repoPath = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(repoPath)) continue;
      yield* walk(absolute);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
      yield repoPath;
    }
  }
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

/** True when the module's first statement is the `'use client'` directive. */
function isClientModule(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

/** Each `x.toLocale*String(…)` call (optional chaining included), as `method (line n)`. */
function localeFormatCalls(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  if (!isClientModule(source)) return [];
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && LOCALE_METHODS.has(callee.name.text)) {
        const { line } = source.getLineAndCharacterOfPosition(callee.name.getStart(source));
        calls.push(`${callee.name.text} (line ${line + 1})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function findProblems(read: (repoPath: string) => string, files: Iterable<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    // Parse only a file that names one of the methods: a few dozen of the app's thousands.
    const text = read(file);
    const calls = text.includes('toLocale') ? localeFormatCalls(file, text) : [];
    const allowed = ALLOWED.get(file);
    if (calls.length === 0 && !allowed) continue;
    seen.add(file);
    if (!allowed) {
      problems.push(
        `${file}: ${calls.join(', ')}. A client component renders on the server too: print timestamps with components/LocalDateTime.tsx (React #418 otherwise).`,
      );
    } else if (calls.length !== allowed.calls) {
      problems.push(
        `${file}: ${calls.length} toLocale*String() call(s) (${calls.join(', ') || 'none'}), allowed ${allowed.calls} (${allowed.why}). Use LocalDateTime for a new one, or lower the entry.`,
      );
    }
  }
  for (const file of ALLOWED.keys()) {
    if (!seen.has(file)) problems.push(`${file} is allow-listed but no longer a client module calling toLocale*String(): remove the entry.`);
  }
  return problems;
}

describe('client-side locale formatting', () => {
  it('finds calls only in client modules, with optional chaining, and never in comments or strings', () => {
    const client = [
      "'use client';",
      '// new Date(x).toLocaleString() in a comment is prose',
      "const label = 'toLocaleDateString()';",
      'export const A = ({ at }) => <span>{new Date(at).toLocaleString()}</span>;',
      'export const B = ({ at }) => <span>{at?.toLocaleTimeString([], { hour: "2-digit" })}</span>;',
      "export const C = ({ n }) => <span>{n.toLocaleString('en-US')}</span>;",
    ].join('\n');
    expect(localeFormatCalls('fixture.tsx', client)).toEqual([
      'toLocaleString (line 4)',
      'toLocaleTimeString (line 5)',
      'toLocaleString (line 6)',
    ]);
    expect(localeFormatCalls('server.tsx', 'export const S = ({ at }) => <span>{new Date(at).toLocaleString()}</span>;')).toEqual([]);
    expect(localeFormatCalls('late.tsx', "import x from 'y';\n'use client';\nconst s = new Date().toLocaleString();")).toEqual([]);
  });

  it('fails an unlisted client module, a count that changed and a stale entry', () => {
    const files: Record<string, string> = {
      'apps/nextblock/app/cms/x/Fresh.tsx': "'use client';\nexport const F = ({ at }) => <b>{new Date(at).toLocaleDateString()}</b>;",
      'apps/nextblock/components/LocalDateTime.tsx': "'use client';\nconst a = d.toLocaleString();\nconst b = d.toLocaleString();",
    };
    const problems = findProblems((file) => files[file] ?? '', Object.keys(files));
    expect(problems[0]).toMatch(/^apps\/nextblock\/app\/cms\/x\/Fresh\.tsx: toLocaleDateString \(line 2\)\. .*LocalDateTime/);
    expect(problems[1]).toMatch(/^apps\/nextblock\/components\/LocalDateTime\.tsx: 2 toLocale\*String\(\) call\(s\)/);
    expect(problems.slice(2).every((problem) => problem.endsWith('remove the entry.'))).toBe(true);
    expect(problems).toHaveLength(2 + ALLOWED.size - 1);
  });

  // Walks and reads every source file of the app and the libraries: slow on a loaded machine.
  it('every client module in apps/nextblock and libs formats dates and numbers only where the first render never sees it', { timeout: 60_000 }, () => {
    const files = SCAN_ROOTS.flatMap((root) => [...walk(path.join(ROOT, root))]);
    expect(files.length).toBeGreaterThan(100);
    expect(findProblems((file) => readFileSync(path.join(ROOT, file), 'utf8'), files)).toEqual([]);
  });
});
