// The template sync's one rewrite of the app's `@nextblock-cms/ui` imports, and the check that it left
// no test mocking one module twice.
//
// The published ui package is a single bundle: every component subpath maps to its barrel, so the
// sync rewrites `@nextblock-cms/ui/<component>` to `@nextblock-cms/ui` in every source file. A test
// that mocked several components by subpath then mocks the barrel several times, and vitest keeps
// only the last factory: through 0.23.5 the template's components/header-auth.test.tsx mocked the
// barrel three times and kept only Button. App tests therefore hand every such mock one shared
// factory (`vi.mock('@nextblock-cms/ui/button', () => ui)`), the rewrite turns those calls into
// identical lines, and rewriteUiImports keeps the first of them.

/** The specifiers the sync rewrites to the barrel (stylesheets keep their own export key). */
export const UI_SUBPATH_IMPORT = /@nextblock-cms\/ui\/(?!styles\/)[A-Za-z0-9/_-]+/g;

/** A whole-line `vi.mock('@nextblock-cms/ui', …);` statement, the shape the shared-factory mocks take. */
const ONE_LINE_UI_MOCK = /^vi\.mock\(\s*(['"])@nextblock-cms\/ui\1\s*,.*\);$/;

/**
 * `source` with every ui subpath import pointed at the barrel, and repeated identical one-line
 * `vi.mock('@nextblock-cms/ui', …);` statements reduced to their first occurrence. Line endings are
 * kept as they are.
 */
export function rewriteUiImports(source) {
  const rewritten = source.replace(UI_SUBPATH_IMPORT, '@nextblock-cms/ui');
  if (rewritten === source) return source;

  const seen = new Set();
  return rewritten
    .split(/(?<=\n)/)
    .filter((line) => {
      const statement = line.trim();
      if (!ONE_LINE_UI_MOCK.test(statement)) return true;
      if (seen.has(statement)) return false;
      seen.add(statement);
      return true;
    })
    .join('');
}

/** Module specifiers a file passes to `vi.mock` more than once (vitest keeps only the last factory). */
export function findRepeatedMocks(source) {
  const counts = new Map();
  for (const match of source.matchAll(/\bvi\.mock\(\s*(['"`])([^'"`]+)\1/g)) {
    counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([specifier, count]) => ({ specifier, count }));
}
