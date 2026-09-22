import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTS_GRID_ANCHOR,
  POSTS_GRID_ANCHOR_PATTERN,
  resolvePostsGridAnchor,
  sanitizePostsGridAnchorInput,
} from './posts-grid-anchor';
import { PostsGridBlockSchema } from './blockRegistry';

describe('resolvePostsGridAnchor', () => {
  it("falls back to 'latest', the target of the seeded /articles#latest button", () => {
    expect(DEFAULT_POSTS_GRID_ANCHOR).toBe('latest');
    expect(resolvePostsGridAnchor(undefined)).toBe('latest');
    expect(resolvePostsGridAnchor('')).toBe('latest');
    expect(resolvePostsGridAnchor('   ')).toBe('latest');
  });

  it('uses a valid anchor as-is', () => {
    expect(resolvePostsGridAnchor('news')).toBe('news');
    expect(resolvePostsGridAnchor('deep-dives-2')).toBe('deep-dives-2');
    expect(resolvePostsGridAnchor(' news ')).toBe('news');
  });

  it('never renders an id that is not a lowercase slug', () => {
    expect(resolvePostsGridAnchor('Bad id')).toBe('latest');
    expect(resolvePostsGridAnchor('1st')).toBe('latest');
    expect(resolvePostsGridAnchor('<x>')).toBe('latest');
    expect(resolvePostsGridAnchor('a'.repeat(65))).toBe('latest');
    expect(resolvePostsGridAnchor(42)).toBe('latest');
    expect(resolvePostsGridAnchor(null)).toBe('latest');
  });
});

describe('sanitizePostsGridAnchorInput', () => {
  it('turns typed text into a value the pattern accepts', () => {
    for (const typed of ['News', 'Deep Dives', '1st grid', '--x', 'Été 2026', '#latest', 'a'.repeat(80), '123', '']) {
      expect(POSTS_GRID_ANCHOR_PATTERN.test(sanitizePostsGridAnchorInput(typed))).toBe(true);
    }
  });

  it('keeps the readable parts and lets a trailing hyphen through while typing', () => {
    expect(sanitizePostsGridAnchorInput('Deep Dives')).toBe('deep-dives');
    expect(sanitizePostsGridAnchorInput('deep-')).toBe('deep-');
    expect(sanitizePostsGridAnchorInput('1st grid')).toBe('st-grid');
    expect(sanitizePostsGridAnchorInput('#latest')).toBe('latest');
    expect(sanitizePostsGridAnchorInput('Été 2026')).toBe('ete-2026');
    expect(sanitizePostsGridAnchorInput('a'.repeat(80))).toHaveLength(64);
  });
});

describe('PostsGridBlockSchema anchor', () => {
  const base = { columns: 3, postsPerPage: 6, showPagination: true };

  it('accepts no anchor, an empty anchor and a slug', () => {
    expect(PostsGridBlockSchema.safeParse(base).success).toBe(true);
    expect(PostsGridBlockSchema.safeParse({ ...base, anchor: '' }).success).toBe(true);
    expect(PostsGridBlockSchema.safeParse({ ...base, anchor: 'latest' }).success).toBe(true);
  });

  it('rejects an anchor that is not a lowercase slug', () => {
    expect(PostsGridBlockSchema.safeParse({ ...base, anchor: 'Bad id' }).success).toBe(false);
    expect(PostsGridBlockSchema.safeParse({ ...base, anchor: '1st' }).success).toBe(false);
  });
});
