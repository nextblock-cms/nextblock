import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findRepeatedMocks, rewriteUiImports } from './ui-imports.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../nextblock');

describe('rewriteUiImports', () => {
  it('points every component subpath at the barrel and leaves the stylesheets alone', () => {
    const source =
      "import { Button } from '@nextblock-cms/ui/button';\n" +
      'import { Dialog } from "@nextblock-cms/ui/dialog";\n' +
      "import '@nextblock-cms/ui/styles/globals.css';\n" +
      "import { cn } from '@nextblock-cms/utils/utils';\n";
    expect(rewriteUiImports(source)).toBe(
      "import { Button } from '@nextblock-cms/ui';\n" +
        'import { Dialog } from "@nextblock-cms/ui";\n' +
        "import '@nextblock-cms/ui/styles/globals.css';\n" +
        "import { cn } from '@nextblock-cms/utils/utils';\n"
    );
  });

  it('keeps the first of the identical shared-factory mocks the rewrite produces, with CRLF line endings kept', () => {
    const source = [
      "const ui = vi.hoisted(() => ({ Button: () => null, Avatar: () => null }));",
      "vi.mock('@nextblock-cms/ui/button', () => ui);",
      "vi.mock('@nextblock-cms/ui/avatar', () => ui);",
      "vi.mock('../app/actions', () => ({}));",
      '',
    ].join('\r\n');
    expect(rewriteUiImports(source)).toBe(
      [
        "const ui = vi.hoisted(() => ({ Button: () => null, Avatar: () => null }));",
        "vi.mock('@nextblock-cms/ui', () => ui);",
        "vi.mock('../app/actions', () => ({}));",
        '',
      ].join('\r\n')
    );
  });

  it('never merges mocks that differ: the template check reports those', () => {
    const source =
      "vi.mock('@nextblock-cms/ui/button', () => ({ Button: () => null }));\n" +
      "vi.mock('@nextblock-cms/ui/avatar', () => ({ Avatar: () => null }));\n";
    const rewritten = rewriteUiImports(source);
    expect(rewritten.split('\n').filter(Boolean)).toHaveLength(2);
    expect(findRepeatedMocks(rewritten)).toEqual([{ specifier: '@nextblock-cms/ui', count: 2 }]);
  });

  it('returns a file with no ui subpath unchanged, even with repeated identical lines', () => {
    const source = "vi.mock('@nextblock-cms/ui', () => ui);\nvi.mock('@nextblock-cms/ui', () => ui);\n";
    expect(rewriteUiImports(source)).toBe(source);
  });

  it('leaves the app tests that mock several ui components with one mock each after the rewrite', () => {
    for (const rel of ['components/header-auth.test.tsx', 'app/cms/components/CortexGlobalAgentChat.test.tsx']) {
      const rewritten = rewriteUiImports(readFileSync(resolve(APP, rel), 'utf8'));
      expect(findRepeatedMocks(rewritten), rel).toEqual([]);
      expect(rewritten, rel).toMatch(/vi\.mock\('@nextblock-cms\/ui', \(\) => ui\);/);
    }
  });
});

describe('findRepeatedMocks', () => {
  it('counts vi.mock calls per module and ignores vi.doMock', () => {
    const source =
      "vi.mock('a', () => ({}));\nvi.mock(\"a\", () => ({}));\nvi.mock(`b`, () => ({}));\nvi.doMock('b', () => ({}));\n";
    expect(findRepeatedMocks(source)).toEqual([{ specifier: 'a', count: 2 }]);
  });
});
