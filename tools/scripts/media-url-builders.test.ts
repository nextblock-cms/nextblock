import { describe, expect, it } from 'vitest';

const { MEDIA_BASE_READERS, findHandBuiltMediaUrlProblems, mediaBaseReferencesInSource } = require('./lib/media-url-builders.js');
const { scanRepository } = require('./lib/service-role-boundary.js');

/** Fixture modules under /repo/. */
function problemsFor(files: Record<string, string>, readers: Map<string, string>): string[] {
  const modules = new Map(Object.keys(files).map((repoPath) => [`/repo/${repoPath}`, { absolute: `/repo/${repoPath}`, repoPath }]));
  return findHandBuiltMediaUrlProblems(modules, readers, (absolute: string) => files[absolute.slice('/repo/'.length)]);
}

describe('media URL builder check', () => {
  it('finds every read of the public media base, and nothing else', () => {
    const source = [
      '// `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${key}` in a comment is prose, and so is /storage/v1/object/public',
      '/* process.env.NEXT_PUBLIC_R2_PUBLIC_URL */',
      'const a = `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${key}`;',
      "const b = process.env['NEXT_PUBLIC_R2_BASE_URL'];",
      'const { NEXT_PUBLIC_R2_PUBLIC_URL: publicBase } = process.env;',
      'const c = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${key}`;',
      "const d = supabaseUrl + '/storage/v1/object/public/media/' + key;",
      'const e = process.env[`NEXT_PUBLIC_R2_BASE_URL`];',
      'const f = import.meta.env.NEXT_PUBLIC_R2_PUBLIC_URL;',
      "const g = 'Set NEXT_PUBLIC_R2_BASE_URL in .env.local';",
      'const h = resolveMediaUrl(key);',
      'const i = process.env.NEXT_PUBLIC_SUPABASE_URL;',
    ].join('\n');

    expect(mediaBaseReferencesInSource('fixture.ts', source)).toEqual([
      'NEXT_PUBLIC_R2_BASE_URL (line 3)',
      "'NEXT_PUBLIC_R2_BASE_URL' (line 4)",
      'NEXT_PUBLIC_R2_PUBLIC_URL (line 5)',
      '/storage/v1/object/public (line 6)',
      '/storage/v1/object/public (line 7)',
      "'NEXT_PUBLIC_R2_BASE_URL' (line 8)",
      'NEXT_PUBLIC_R2_PUBLIC_URL (line 9)',
    ]);
  });

  it('parses a .js module as JavaScript with JSX, and reports one it cannot parse', () => {
    expect(
      mediaBaseReferencesInSource('legacy.js', 'export const L = ({ k }) => <img src={process.env.NEXT_PUBLIC_R2_BASE_URL + "/" + k} />;')
    ).toEqual(['NEXT_PUBLIC_R2_BASE_URL (line 1)']);
    expect(problemsFor({ 'apps/nextblock/components/Broken.tsx': 'export const B = () => <img src={`${process.env.NEXT_PUBLIC_R2_BASE_URL}/x`} ;' }, new Map())).toEqual([
      'apps/nextblock/components/Broken.tsx cannot be parsed, so the media URL scan cannot check it: fix the syntax error.',
    ]);
  });

  it('fails a module outside the allow-list and an entry that no longer reads the base', () => {
    expect(
      problemsFor(
        {
          'libs/ecommerce/src/lib/Thumb.tsx': 'const R2 = process.env.NEXT_PUBLIC_R2_BASE_URL || "";\nexport const src = (key) => `${R2}/${key}`;',
          'apps/nextblock/lib/storage/provider.ts': 'export const base = () => process.env.NEXT_PUBLIC_R2_BASE_URL;',
          'apps/nextblock/proxy.ts': 'export const csp = "img-src \'self\'";',
          'apps/nextblock/components/Card.tsx': "import { resolveMediaUrl } from '../lib/media/resolveMediaUrl';\nexport const src = (key) => resolveMediaUrl(key);",
        },
        new Map([
          ['apps/nextblock/lib/storage/provider.ts', 'the storage provider'],
          ['apps/nextblock/proxy.ts', 'the CSP'],
        ])
      )
    ).toEqual([
      'libs/ecommerce/src/lib/Thumb.tsx reads the public media base (NEXT_PUBLIC_R2_BASE_URL (line 1)): build media URLs with resolveMediaUrl or resolveMediaUrlWithSupabaseFallback (@nextblock-cms/utils/media-url; app-side lib/media/resolveMediaUrl.ts), which serve the bundled public/images keys from /images. A module that reads the base only as configuration goes in MEDIA_BASE_READERS (tools/scripts/lib/media-url-builders.js) with why.',
      'MEDIA_BASE_READERS lists apps/nextblock/proxy.ts, which no longer reads the public media base: remove the entry.',
    ]);
  });

  it('says why each allow-listed module reads the base', () => {
    for (const [repoPath, why] of MEDIA_BASE_READERS as Map<string, string>) {
      expect(why.trim(), repoPath).not.toBe('');
    }
  });
});

describe('the repository', () => {
  // Scanned once at collection time, like the other repository-wide gates.
  const problems: string[] = findHandBuiltMediaUrlProblems(scanRepository());

  it('builds every media display URL through resolveMediaUrl', () => {
    expect(problems).toEqual([]);
  });
});
