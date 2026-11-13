import { describe, expect, it } from 'vitest';

import { sanitizeStorefrontDoc } from '../storefront/sanitize';
import type { StorefrontInlineNode } from '../storefront/types';
import {
  normalizeRetailerCopilotText,
  parseRetailerCopilotMarkdownLite,
  retailerCopilotMarkdownToPlainText,
  splitRetailerCopilotParagraphs,
  stripRetailerCopilotHtml,
} from './markdown-lite';

const BOLD = { type: 'bold' } as const;
const ITALIC = { type: 'italic' } as const;
const link = (href: string) => ({ type: 'link', attrs: { href } }) as const;

function passesSanitizerUnchanged(content: StorefrontInlineNode[]): void {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content }] };
  const result = sanitizeStorefrontDoc(doc, { allowedImageOrigins: [] });
  expect(result.issues).toEqual([]);
  expect(result.changed).toBe(false);
}

describe('parseRetailerCopilotMarkdownLite', () => {
  it('turns **bold**, *italic* and links into marks in the sanitizer order', () => {
    const nodes = parseRetailerCopilotMarkdownLite(
      'Hello **bold** and *italic* with [my picks](https://shop.example/partners/jane) and [**loud**](https://shop.example/a).'
    );
    expect(nodes).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'bold', marks: [BOLD] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'italic', marks: [ITALIC] },
      { type: 'text', text: ' with ' },
      { type: 'text', text: 'my picks', marks: [link('https://shop.example/partners/jane')] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'loud', marks: [link('https://shop.example/a'), BOLD] },
      { type: 'text', text: '.' },
    ]);
    passesSanitizerUnchanged(nodes);
  });

  it('nests bold and italic', () => {
    expect(parseRetailerCopilotMarkdownLite('***both***')).toEqual([{ type: 'text', text: 'both', marks: [BOLD, ITALIC] }]);
    const nested = parseRetailerCopilotMarkdownLite('**bold *both* bold** and *it **both** it*');
    expect(nested).toEqual([
      { type: 'text', text: 'bold ', marks: [BOLD] },
      { type: 'text', text: 'both', marks: [BOLD, ITALIC] },
      { type: 'text', text: ' bold', marks: [BOLD] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'it ', marks: [ITALIC] },
      { type: 'text', text: 'both', marks: [BOLD, ITALIC] },
      { type: 'text', text: ' it', marks: [ITALIC] },
    ]);
    passesSanitizerUnchanged(nested);
    expect(parseRetailerCopilotMarkdownLite('**[label](https://shop.example/x)**')).toEqual([
      { type: 'text', text: 'label', marks: [link('https://shop.example/x'), BOLD] },
    ]);
  });

  it('keeps site-relative and mailto links, normalized the way the sanitizer does', () => {
    expect(parseRetailerCopilotMarkdownLite('[tea](/products/lavender-tea) [mail](mailto:jane@example.com) [home](https://Shop.Example)')).toEqual([
      { type: 'text', text: 'tea', marks: [link('/products/lavender-tea')] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'mail', marks: [link('mailto:jane@example.com')] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'home', marks: [link('https://shop.example/')] },
    ]);
  });

  it('drops unsafe links and keeps their text', () => {
    const hostile = [
      '[click](javascript:alert(1))',
      '[click](JAVASCRIPT:alert(1))',
      '[click](data:text/html;base64,PHNjcmlwdD4=)',
      '[click](vbscript:msgbox(1))',
      '[click](//evil.example/x)',
      '[click](https://user:pass@evil.example/)',
      '[click](file:///etc/passwd)',
      '[click](relative/path)',
      '[click](#top)',
    ];
    for (const source of hostile) {
      const nodes = parseRetailerCopilotMarkdownLite(source);
      expect(nodes, source).toEqual([{ type: 'text', text: 'click' }]);
    }
    // A tab inside the scheme is not a link at all (the text stays literal, nothing is linked).
    const tabbed = parseRetailerCopilotMarkdownLite('[click](java\tscript:alert(1))');
    expect(JSON.stringify(tabbed)).not.toContain('"link"');
  });

  it('accepts a quoted title and angle brackets, refuses a destination with spaces', () => {
    expect(parseRetailerCopilotMarkdownLite('[a](https://shop.example/x "Title")')).toEqual([
      { type: 'text', text: 'a', marks: [link('https://shop.example/x')] },
    ]);
    expect(parseRetailerCopilotMarkdownLite('[a](<https://shop.example/y>)')).toEqual([
      { type: 'text', text: 'a', marks: [link('https://shop.example/y')] },
    ]);
    expect(parseRetailerCopilotMarkdownLite('[a](https://shop.example/x y)')).toEqual([
      { type: 'text', text: '[a](https://shop.example/x y)' },
    ]);
    expect(parseRetailerCopilotMarkdownLite('[a](https://en.wikipedia.org/wiki/Tea_(drink))')).toEqual([
      { type: 'text', text: 'a', marks: [link('https://en.wikipedia.org/wiki/Tea_(drink)')] },
    ]);
  });

  it('leaves unmatched markers, arithmetic and escaped characters as text', () => {
    expect(parseRetailerCopilotMarkdownLite('**open and *half')).toEqual([{ type: 'text', text: '**open and *half' }]);
    expect(parseRetailerCopilotMarkdownLite('2 * 3 * 4 = 24')).toEqual([{ type: 'text', text: '2 * 3 * 4 = 24' }]);
    expect(parseRetailerCopilotMarkdownLite('a ** b ** c')).toEqual([{ type: 'text', text: 'a ** b ** c' }]);
    expect(parseRetailerCopilotMarkdownLite('\\*not italic\\* and \\[not a link](https://x.example)')).toEqual([
      { type: 'text', text: '*not italic* and [not a link](https://x.example)' },
    ]);
    expect(parseRetailerCopilotMarkdownLite('[unclosed](https://x.example')).toEqual([
      { type: 'text', text: '[unclosed](https://x.example' },
    ]);
  });

  it('turns line breaks into hard breaks, or spaces on request', () => {
    const source = 'Line one\nLine **two**\n\n\nLine three';
    expect(parseRetailerCopilotMarkdownLite(source)).toEqual([
      { type: 'text', text: 'Line one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Line ' },
      { type: 'text', text: 'two', marks: [BOLD] },
      { type: 'hardBreak' },
      { type: 'text', text: 'Line three' },
    ]);
    expect(parseRetailerCopilotMarkdownLite(source, { lineBreaks: 'space' })).toEqual([
      { type: 'text', text: 'Line one Line ' },
      { type: 'text', text: 'two', marks: [BOLD] },
      { type: 'text', text: ' Line three' },
    ]);
  });

  it('never emits markup, control characters or empty text', () => {
    const bell = String.fromCharCode(7);
    const rtlOverride = String.fromCharCode(0x202e);
    const nodes = parseRetailerCopilotMarkdownLite(
      `  <b>Bold</b> &amp; <script>alert(1)</script> ${bell}x${rtlOverride}y ![photo](https://images.example/a.png) end  `
    );
    expect(nodes).toEqual([{ type: 'text', text: 'Bold & alert(1) xy end' }]);
    expect(parseRetailerCopilotMarkdownLite('   ')).toEqual([]);
    expect(parseRetailerCopilotMarkdownLite(null)).toEqual([]);
    expect(parseRetailerCopilotMarkdownLite(42)).toEqual([]);
    expect(parseRetailerCopilotMarkdownLite('**  **')).toEqual([{ type: 'text', text: '** **' }]);
  });

  it('stays fast and bounded on pathological input', () => {
    const inputs = [
      '*'.repeat(5000),
      '['.repeat(5000),
      '**a'.repeat(2000),
      '*a '.repeat(2000),
      '[a]('.repeat(1500),
      '<a '.repeat(2000),
      `${'x'.repeat(20000)}**bold**`,
    ];
    const started = Date.now();
    for (const input of inputs) {
      const nodes = parseRetailerCopilotMarkdownLite(input);
      const length = nodes.reduce((total, node) => total + (node.type === 'text' ? node.text.length : 0), 0);
      expect(length).toBeLessThanOrEqual(5000);
      passesSanitizerUnchanged(nodes);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('produces nodes the sanitizer keeps unchanged for typical model output', () => {
    const samples = [
      'I **love** this *lavender* tea. Try it [here](https://shop.example/products/tea)!',
      'Tip: steep for **5 minutes**.\nThen add honey.',
      'Prix : 25,00 $ — *vraiment* bon.',
      'Emoji 🌿 and accents é à ç',
    ];
    for (const sample of samples) passesSanitizerUnchanged(parseRetailerCopilotMarkdownLite(sample));
  });
});

describe('retailerCopilotMarkdownToPlainText', () => {
  it('keeps the visible text on one line', () => {
    expect(retailerCopilotMarkdownToPlainText('**Bold** [label](https://x.example) *it*\nnext <i>line</i>')).toBe(
      'Bold label it next line'
    );
    expect(retailerCopilotMarkdownToPlainText('[bad](javascript:alert(1)) text')).toBe('bad text');
    expect(retailerCopilotMarkdownToPlainText(undefined)).toBe('');
  });

  it('keeps no-break spaces (French typography)', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(retailerCopilotMarkdownToPlainText(`Prix${nbsp}: 25,00${nbsp}$`)).toBe(`Prix${nbsp}: 25,00${nbsp}$`);
  });
});

describe('text helpers', () => {
  it('splits paragraphs at blank lines and normalizes each line', () => {
    expect(splitRetailerCopilotParagraphs('  First  line \n second\n\n\n\nThird\r\n\r\nFourth  ')).toEqual([
      'First line\nsecond',
      'Third',
      'Fourth',
    ]);
    expect(splitRetailerCopilotParagraphs('<p>One</p><p>Two</p>')).toEqual(['One', 'Two']);
    expect(splitRetailerCopilotParagraphs('')).toEqual([]);
  });

  it('normalizes control characters, tabs and blank lines', () => {
    expect(normalizeRetailerCopilotText('\n\n a\tb  c \r\n\r\n\r\n d \n\n')).toBe('a b c\n\nd');
  });

  it('strips stray HTML without touching prose comparisons', () => {
    expect(stripRetailerCopilotHtml('a < b and c > d')).toBe('a < b and c > d');
    expect(stripRetailerCopilotHtml('x<br>y<br/>z')).toBe('x\ny\nz');
    expect(stripRetailerCopilotHtml('<ul><li>one</li><li>two</li></ul>')).toBe('\n\n\none\ntwo\n\n');
    expect(stripRetailerCopilotHtml('Tom &amp; Jerry &lt;3 &#233;t&#xE9; &bogus;')).toBe('Tom & Jerry <3 été &bogus;');
    expect(stripRetailerCopilotHtml('a<!-- hidden -->b')).toBe('ab');
  });
});
