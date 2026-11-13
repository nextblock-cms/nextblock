import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { findHtmlSinkProblems, htmlSinksInSource } = require('./lib/html-sinks.js');
const { scanRepository } = require('./lib/service-role-boundary.js');

type Entry = { why: string; sanitizedBy?: string[]; sanitizedInCallers?: string[]; noCallers?: string[]; allowedImporters?: string[] };

/** Fixture modules under /repo/, with a resolver for their relative imports. */
function problemsFor(files: Record<string, string>, sinks: Map<string, Entry>): string[] {
  const modules = new Map(Object.keys(files).map((repoPath) => [`/repo/${repoPath}`, { absolute: `/repo/${repoPath}`, repoPath }]));
  const resolveImport = (from: string, specifier: string) => {
    if (!specifier.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(from), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (candidate.slice('/repo/'.length) in files) return candidate;
    }
    return null;
  };
  return findHtmlSinkProblems(modules, sinks, (absolute: string) => files[absolute.slice('/repo/'.length)], resolveImport);
}

describe('HTML sink check', () => {
  it('finds every way a module writes HTML into a page, and nothing else', () => {
    const source = `
      import parse, { domToReact } from 'html-react-parser';
      import * as HRP from 'html-react-parser';
      const a = <div dangerouslySetInnerHTML={{ __html: html }} />;
      const b = React.createElement('div', { dangerouslySetInnerHTML: { __html: html } });
      const c = parse(html);
      const d = domToReact(nodes);
      el.innerHTML = html;
      el.outerHTML = html;
      el.insertAdjacentHTML('beforeend', html);
      range.createContextualFragment(html);
      document.write(html);
      const e = new DOMParser();
      const f = new Blob([html], { type: 'text/html' });
      const g = new Blob([json], { type: 'application/json' });
      stream.write(chunk);
      const h = el.innerHTML;
      const i = <iframe srcDoc={html} />;
      const j = { 'dangerouslySetInnerHTML': { __html: html } };
      const k = { srcDoc };
      el.innerHTML += html;
      el['innerHTML'] = html;
      el.setHTMLUnsafe(html);
      frame.setAttribute('srcdoc', html);
      document.execCommand('insertHTML', false, html);
      const doc = frame.contentDocument;
      doc.write(html);
      HRP.default(html);
      frame.srcdoc = html;
      document.writeln(html);
      Document.parseHTMLUnsafe(html);
      frame.setAttributeNS(null, 'srcdoc', html);
      const l = <iframe srcdoc={html} />;
      const m = { srcdoc: html };
      el.ownerDocument.write(html);
    `;
    expect(htmlSinksInSource('fixture.tsx', source)).toEqual([
      'dangerouslySetInnerHTML (line 4)',
      'dangerouslySetInnerHTML (line 5)',
      'html-react-parser parse() (line 6)',
      'html-react-parser domToReact() (line 7)',
      'innerHTML = (line 8)',
      'outerHTML = (line 9)',
      'insertAdjacentHTML() (line 10)',
      'createContextualFragment() (line 11)',
      'write() (line 12)',
      'new DOMParser (line 13)',
      'text/html Blob (line 14)',
      'srcDoc (line 18)',
      'dangerouslySetInnerHTML (line 19)',
      'srcDoc (line 20)',
      'innerHTML += (line 21)',
      'innerHTML = (line 22)',
      'setHTMLUnsafe() (line 23)',
      "setAttribute('srcdoc') (line 24)",
      "execCommand('insertHTML') (line 25)",
      'write() (line 27)',
      'html-react-parser HRP.default() (line 28)',
      'srcdoc = (line 29)',
      'writeln() (line 30)',
      'parseHTMLUnsafe() (line 31)',
      "setAttributeNS('srcdoc') (line 32)",
      'srcdoc (line 33)',
      'srcdoc (line 34)',
      'write() (line 35)',
    ]);
  });

  it('parses a .js module as JavaScript with JSX, and reports one it cannot parse', () => {
    expect(htmlSinksInSource('legacy.js', 'export const L = () => <div dangerouslySetInnerHTML={{ __html: html }} />;')).toEqual([
      'dangerouslySetInnerHTML (line 1)',
    ]);
    expect(problemsFor({ 'apps/nextblock/components/Broken.tsx': 'export const B = () => <div dangerouslySetInnerHTML={{ __html: html }} ;' }, new Map())).toEqual([
      'apps/nextblock/components/Broken.tsx cannot be parsed, so the HTML sink scan cannot prove it safe: fix the syntax error.',
    ]);
  });

  it('fails an unlisted sink and an entry with no sink left', () => {
    expect(
      problemsFor(
        { 'apps/nextblock/components/New.tsx': 'export const New = () => <div dangerouslySetInnerHTML={{ __html: html }} />;', 'apps/nextblock/components/Old.tsx': 'export const Old = 1;' },
        new Map([['apps/nextblock/components/Old.tsx', { why: 'gone' }]])
      )
    ).toEqual([
      'apps/nextblock/components/New.tsx writes HTML into a page (dangerouslySetInnerHTML (line 1)): render authored HTML through sanitizeAuthoredBlockHtml (@nextblock-cms/utils) and list the module in HTML_SINKS (tools/scripts/lib/html-sinks.js) with why it is safe.',
      'HTML_SINKS lists apps/nextblock/components/Old.tsx, which no longer writes HTML into a page: remove the entry.',
    ]);
  });

  it('fails a sink that stopped calling its sanitizer, a caller that stopped, and an importer that is not a caller', () => {
    const files = {
      'libs/ecommerce/src/lib/components/ShortDescription.tsx': 'export const S = ({ text }) => <div dangerouslySetInnerHTML={{ __html: toNoCookieEmbedSrc(text) ?? text }} />;',
      'apps/nextblock/components/blocks/renderers/ClientTextBlockRenderer.tsx': "import parse from 'html-react-parser'; export const C = ({ html }) => parse(html);",
      'apps/nextblock/components/BlockRenderer.tsx': "import { C } from './blocks/renderers/ClientTextBlockRenderer';\nexport const B = ({ html }) => <C html={sanitizeAuthoredBlockHtml(html)} />;",
      'apps/nextblock/components/blocks/renderers/TextBlockRenderer.tsx': "import { C } from './ClientTextBlockRenderer';\nexport const T = ({ html }) => <C html={html} />;",
      'apps/nextblock/components/Promo.tsx': "import { C } from './blocks/renderers/ClientTextBlockRenderer';\nexport const P = ({ html }) => <C html={html} />;",
    };
    const sinks = new Map<string, Entry>([
      ['libs/ecommerce/src/lib/components/ShortDescription.tsx', { why: 'short descriptions.', sanitizedBy: ['sanitizeAuthoredBlockHtml'] }],
      [
        'apps/nextblock/components/blocks/renderers/ClientTextBlockRenderer.tsx',
        {
          why: 'text blocks.',
          sanitizedInCallers: ['apps/nextblock/components/BlockRenderer.tsx', 'apps/nextblock/components/blocks/renderers/TextBlockRenderer.tsx'],
        },
      ],
    ]);
    expect(problemsFor(files, sinks)).toEqual([
      'libs/ecommerce/src/lib/components/ShortDescription.tsx no longer calls sanitizeAuthoredBlockHtml on the HTML it renders (dangerouslySetInnerHTML (line 1)). HTML_SINKS says: short descriptions.',
      'apps/nextblock/components/blocks/renderers/TextBlockRenderer.tsx no longer calls sanitizeAuthoredBlockHtml before handing HTML to apps/nextblock/components/blocks/renderers/ClientTextBlockRenderer.tsx. HTML_SINKS says: text blocks.',
      'apps/nextblock/components/Promo.tsx imports apps/nextblock/components/blocks/renderers/ClientTextBlockRenderer.tsx, which renders the HTML it is handed without sanitizing it: call sanitizeAuthoredBlockHtml on that HTML first and add the module to the entry\'s sanitizedInCallers (tools/scripts/lib/html-sinks.js).',
    ]);
  });

  it('fails any import or use of a component that runs the scripts it is given, except from its listed barrel', () => {
    const files = {
      'libs/editor/src/lib/components/HtmlContent.tsx': 'export const HtmlContent = ({ html }) => { el.innerHTML = html; };',
      'apps/nextblock/components/HtmlScriptExecutor.tsx': 'export default function HtmlScriptExecutor({ html }) { el.innerHTML = html; }',
      'libs/editor/src/index.ts':
        "export { HtmlContent } from './lib/components/HtmlContent';\nexport { HtmlContent as RichHtml, default as Html } from './lib/components/HtmlContent';\nimport Runner from './lib/components/HtmlContent';\nimport * as Lib from './lib/components/HtmlContent';\nexport { Runner, Lib };",
      'apps/nextblock/app/page.tsx': "import { HtmlContent } from '@nextblock-cms/editor';\nimport Runner from '../components/HtmlScriptExecutor';",
      'apps/nextblock/app/lazy.tsx': "const Lazy = dynamic(() => import('../components/HtmlScriptExecutor'));\nconst Editor = await import('@nextblock-cms/editor');\nexport const X = Editor.HtmlContent;",
      'apps/nextblock/app/indexed.tsx': "const m = await import('@nextblock-cms/editor');\nexport const Y = m['HtmlContent'];",
      'apps/nextblock/app/reexport.ts': "export { HtmlContent as Safe } from '@nextblock-cms/editor';",
      'apps/nextblock/app/destructured.tsx': "const { HtmlContent: Runner } = await import('@nextblock-cms/editor');\nexport const Z = () => <Runner html={h} />;",
      'apps/nextblock/app/keyed.tsx': "export const K = dynamic(() => import('@nextblock-cms/editor').then(({ 'HtmlContent': R }) => R));",
      'apps/nextblock/app/assigned.ts': "let R;\n({ HtmlContent: R } = editor);\nexport { R };",
      'apps/nextblock/app/types.tsx':
        "import type { HtmlContent } from '@nextblock-cms/editor';\nimport { type HtmlContent as H2 } from '@nextblock-cms/editor';\nexport type P = React.ComponentProps<typeof HtmlContent>;",
    };
    const sinks = new Map<string, Entry>([
      ['libs/editor/src/lib/components/HtmlContent.tsx', { why: 'runs scripts.', noCallers: ['HtmlContent'], allowedImporters: ['libs/editor/src/index.ts'] }],
      ['apps/nextblock/components/HtmlScriptExecutor.tsx', { why: 'runs scripts.', noCallers: ['HtmlScriptExecutor'] }],
    ]);
    const RUNS = 'which runs every script in the HTML it gets: sanitize the HTML with sanitizeAuthoredBlockHtml and render it some other way.';
    const ALIAS = (alias: string) =>
      `libs/editor/src/index.ts passes libs/editor/src/lib/components/HtmlContent.tsx on under another name (${alias}): an allowed importer may re-export HtmlContent only under that name, which is the name the check follows.`;
    // A type-only import names no component that could run, so types.tsx is clean.
    expect(problemsFor(files, sinks)).toEqual([
      ALIAS('HtmlContent as RichHtml'),
      ALIAS('default as Html'),
      ALIAS('a default import as Runner'),
      ALIAS('a namespace import as Lib'),
      `apps/nextblock/app/page.tsx imports apps/nextblock/components/HtmlScriptExecutor.tsx, ${RUNS}`,
      `apps/nextblock/app/page.tsx uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/lazy.tsx imports apps/nextblock/components/HtmlScriptExecutor.tsx, ${RUNS}`,
      `apps/nextblock/app/lazy.tsx uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/indexed.tsx uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/reexport.ts uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/destructured.tsx uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/keyed.tsx uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
      `apps/nextblock/app/assigned.ts uses HtmlContent (libs/editor/src/lib/components/HtmlContent.tsx), ${RUNS}`,
    ]);
  });
});

describe('the repository', () => {
  // Scanned once at collection time, like the other repository-wide gates.
  const problems: string[] = findHtmlSinkProblems(scanRepository());

  it('lists every HTML sink with why it is safe, and every sanitized sink still sanitizes', () => {
    expect(problems).toEqual([]);
  });
});
