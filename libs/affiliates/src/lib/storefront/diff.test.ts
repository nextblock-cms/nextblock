import { describe, expect, it } from 'vitest';
import { diffStorefrontBlocks } from './diff';
import type { StorefrontBlockNode, StorefrontDoc } from './types';

const p = (value: string): StorefrontBlockNode => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
const docOf = (...labels: string[]): StorefrontDoc => ({ type: 'doc', content: labels.map(p) });

describe('diffStorefrontBlocks', () => {
  it('marks every block added when nothing is published', () => {
    expect(diffStorefrontBlocks(null, docOf('a', 'b'))).toEqual({ statuses: ['added', 'added'], removedCount: 0 });
    expect(diffStorefrontBlocks({ type: 'doc', content: [] }, docOf('a'))).toEqual({ statuses: ['added'], removedCount: 0 });
  });

  it('marks identical documents unchanged', () => {
    expect(diffStorefrontBlocks(docOf('a', 'b', 'c'), docOf('a', 'b', 'c'))).toEqual({
      statuses: ['unchanged', 'unchanged', 'unchanged'],
      removedCount: 0,
    });
  });

  it('ignores object key order', () => {
    const published: StorefrontDoc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'T', marks: [{ type: 'bold' }] }] }],
    };
    const reordered = JSON.parse('{"content":[{"content":[{"marks":[{"type":"bold"}],"text":"T","type":"text"}],"attrs":{"level":2},"type":"heading"}],"type":"doc"}') as StorefrontDoc;
    expect(diffStorefrontBlocks(published, reordered)).toEqual({ statuses: ['unchanged'], removedCount: 0 });
  });

  it('pairs a replaced block as changed', () => {
    expect(diffStorefrontBlocks(docOf('a', 'b', 'c'), docOf('a', 'x', 'c'))).toEqual({
      statuses: ['unchanged', 'changed', 'unchanged'],
      removedCount: 0,
    });
  });

  it('marks blocks added at the start, middle and end', () => {
    expect(diffStorefrontBlocks(docOf('a', 'b'), docOf('x', 'a', 'y', 'b', 'z'))).toEqual({
      statuses: ['added', 'unchanged', 'added', 'unchanged', 'added'],
      removedCount: 0,
    });
  });

  it('counts removed blocks', () => {
    expect(diffStorefrontBlocks(docOf('a', 'b', 'c', 'd'), docOf('a', 'd'))).toEqual({
      statuses: ['unchanged', 'unchanged'],
      removedCount: 2,
    });
    expect(diffStorefrontBlocks(docOf('a', 'b'), { type: 'doc', content: [] })).toEqual({ statuses: [], removedCount: 2 });
  });

  it('pairs within a gap: two replaced by one is one change and one removal', () => {
    expect(diffStorefrontBlocks(docOf('a', 'b', 'c', 'd'), docOf('a', 'x', 'd'))).toEqual({
      statuses: ['unchanged', 'changed', 'unchanged'],
      removedCount: 1,
    });
    expect(diffStorefrontBlocks(docOf('a', 'b', 'd'), docOf('a', 'x', 'y', 'd'))).toEqual({
      statuses: ['unchanged', 'changed', 'added', 'unchanged'],
      removedCount: 0,
    });
  });

  it('keeps the longest common subsequence when blocks move', () => {
    const result = diffStorefrontBlocks(docOf('a', 'b', 'c', 'd'), docOf('b', 'c', 'd', 'a'));
    expect(result).toEqual({ statuses: ['unchanged', 'unchanged', 'unchanged', 'added'], removedCount: 1 });
  });

  it('returns one status per draft block for large and malformed documents', () => {
    const big = (prefix: string, count: number): StorefrontDoc => docOf(...Array.from({ length: count }, (_, index) => `${prefix}${index}`));
    const draft = big('d', 2000);
    const result = diffStorefrontBlocks(big('p', 2000), draft);
    expect(result.statuses).toHaveLength(2000);
    expect(result.statuses.every((status) => status === 'changed')).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(diffStorefrontBlocks(null, { type: 'doc', content: 'x' } as unknown as StorefrontDoc)).toEqual({ statuses: [], removedCount: 0 });
    expect(diffStorefrontBlocks({ type: 'doc', content: [BigInt(1), Symbol('s'), () => 1] } as unknown as StorefrontDoc, docOf('a')).statuses).toEqual(['changed']);
  });
});
