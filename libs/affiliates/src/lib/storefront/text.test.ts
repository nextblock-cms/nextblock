import { describe, expect, it } from 'vitest';
import { hasStorefrontVisibleText, storefrontJsonbTextByteLength } from './text';

// Special characters are built from code points: the source stays ASCII.
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('storefrontJsonbTextByteLength', () => {
  // The 02030 CHECKs measure octet_length(content::text), and Postgres prints jsonb with a space
  // after every ':' and ',' between members and elements (never inside strings).
  it('counts the value as Postgres prints it as jsonb text', () => {
    expect(storefrontJsonbTextByteLength({ a: [1, 2], b: 'x:,y' })).toBe(26); // {"a": [1, 2], "b": "x:,y"}
    expect(storefrontJsonbTextByteLength({ type: 'doc', content: [] })).toBe(30); // {"type": "doc", "content": []}
    expect(storefrontJsonbTextByteLength([{ a: 1 }, [2, { b: [] }]])).toBe(26); // [{"a": 1}, [2, {"b": []}]]
    expect(storefrontJsonbTextByteLength({ a: undefined, b: 1 })).toBe(8); // {"b": 1}
    expect(storefrontJsonbTextByteLength([])).toBe(2);
    expect(storefrontJsonbTextByteLength({})).toBe(2);
    expect(storefrontJsonbTextByteLength('a,b:c')).toBe(7);
    expect(storefrontJsonbTextByteLength(undefined)).toBe(0);
  });

  it('never counts a separator inside a string, escaped quotes and backslashes included', () => {
    expect(storefrontJsonbTextByteLength({ k: 'q",:' })).toBe(14); // {"k": "q\",:"}
    expect(storefrontJsonbTextByteLength({ k: 'back\\', l: ',' })).toBe(25); // {"k": "back\\", "l": ","}
    expect(storefrontJsonbTextByteLength({ n: 'a\nb' })).toBe(13); // {"n": "a\nb"}
  });

  it('counts UTF-8 bytes', () => {
    expect(storefrontJsonbTextByteLength({ t: `${ch(0xe9)}${ch(0x1f600)}` })).toBe(15); // {"t": "é😀"}
  });
});

describe('hasStorefrontVisibleText', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const hardBreak = { type: 'hardBreak' };

  it('is false for inline content that shows nothing', () => {
    for (const blank of [' ', '   ', ch(0xa0), ch(0x200b), ch(0xad), ch(0x2060), ch(0xfeff), ch(0x3164), ch(0x2800), '\n', ch(0x202e)]) {
      expect(hasStorefrontVisibleText([text(blank)]), `U+${blank.codePointAt(0)?.toString(16)}`).toBe(false);
    }
    expect(hasStorefrontVisibleText([])).toBe(false);
    expect(hasStorefrontVisibleText([hardBreak])).toBe(false);
    expect(hasStorefrontVisibleText([text(' '), hardBreak, text(ch(0xa0, 0x200b))])).toBe(false);
    // Only own `text` of a `text` node counts.
    expect(hasStorefrontVisibleText([{ type: 'image', text: 'x' }, null, 'x', 42, { type: 'text', text: 7 }])).toBe(false);
    expect(hasStorefrontVisibleText([Object.create({ type: 'text', text: 'inherited' }) as unknown])).toBe(false);
  });

  it('is true as soon as one text node holds a visible character', () => {
    expect(hasStorefrontVisibleText([text('a')])).toBe(true);
    expect(hasStorefrontVisibleText([text(' '), hardBreak, text(' Real ')])).toBe(true);
    expect(hasStorefrontVisibleText([text(ch(0x1f600))])).toBe(true);
    expect(hasStorefrontVisibleText([text(`${ch(0x200b)}.`)])).toBe(true);
  });
});
