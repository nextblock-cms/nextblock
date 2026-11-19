import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { rootPackageRanges } from './lib-build-plugins.mjs';

const root = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('rootPackageRanges (the third-party ranges a lib build publishes)', () => {
  it("reads each range from the root package.json, dependencies and devDependencies alike", () => {
    expect(rootPackageRanges(['zod', 'react'])).toEqual({
      zod: root.dependencies?.zod ?? root.devDependencies?.zod,
      react: root.dependencies?.react ?? root.devDependencies?.react,
    });
  });

  it('gives a package the root does not list the range of the one it releases in lockstep with', () => {
    expect(rootPackageRanges(['@tiptap/extension-list'], { sameRangeAs: { '@tiptap/extension-list': '@tiptap/core' } })).toEqual({
      '@tiptap/extension-list': rootPackageRanges(['@tiptap/core'])['@tiptap/core'],
    });
  });

  it('throws for a package the root does not list, so a typo cannot publish a manifest without it', () => {
    expect(() => rootPackageRanges(['class-variance-authorit'])).toThrow(
      'class-variance-authorit is not in the root package.json, so the lib build cannot take its published range from there'
    );
    expect(() => rootPackageRanges(['@tiptap/extension-list'], { sameRangeAs: { '@tiptap/extension-list': '@tiptap/missing' } })).toThrow(
      '@tiptap/extension-list is not in the root package.json'
    );
  });
});
