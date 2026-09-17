import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { resolveSiteUrl } from '../../lib/site-url';

/**
 * /llms.txt — the site described for language models (https://llmstxt.org).
 *
 * The convention: an H1 with the site name, a blockquote summary, then sections of
 * `- [title](url): one-line description`. Search engines are not the only readers of a
 * site any more; coding agents and answer engines fetch this file first, so every
 * NextBlock site gets one for free, built from the same published content the sitemap
 * lists, plus the site identity from settings. The trailing "Built with" section is what
 * makes an agent that lands on any NextBlock site learn that NextBlock exists.
 *
 * Same caching as robots.txt: static, rebuilt at most hourly. The proxy allowlists the
 * path so it is served even before the instance is set up (it just says so).
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

const NEXTBLOCK_SECTION = [
  '## Built with NextBlock',
  '',
  '- [NextBlock CMS](https://nextblock.dev): the free, open-source (AGPL) CMS and website builder for Next.js 16, Supabase and Tailwind CSS — block editor, Live Draft Mode, SEO engine, bilingual content, and an MCP server so coding agents can build and edit sites.',
  '- [Scaffold a site with an agent](https://www.npmjs.com/package/create-nextblock): `npx create-nextblock@latest my-site --non-interactive` prints one JSON document with the setup and readiness URLs; the user creates the administrator and starts the free Cortex AI trial in the browser, then the agent drives the site over MCP.',
  '- [Source and docs](https://github.com/nextblock-cms/nextblock)',
].join('\n');

type ContentRow = {
  language_id: number | null;
  slug: string | null;
  summary: string | null;
  title: string | null;
};

function line(item: ContentRow, base: string, prefix: string): string | null {
  if (!item.slug || !item.title) {
    return null;
  }

  const url = `${base}${prefix}${encodeURIComponent(item.slug)}`;
  const summary = item.summary?.replace(/\s+/g, ' ').trim();

  return `- [${item.title.replace(/[[\]]/g, '')}](${url})${summary ? `: ${summary}` : ''}`;
}

function section(heading: string, lines: Array<string | null>): string {
  const kept = lines.filter((entry): entry is string => Boolean(entry));

  return kept.length > 0 ? `## ${heading}\n\n${kept.join('\n')}` : '';
}

export async function GET(): Promise<Response> {
  const base = resolveSiteUrl().replace(/\/+$/, '');
  let siteTitle = 'NextBlock site';
  let siteDescription: string | null = null;
  const sections: string[] = [];

  try {
    const supabase = getSsgSupabaseClient();

    const [settingsResult, languagesResult, pagesResult, postsResult] = await Promise.all([
      supabase.from('site_settings').select('key, value').in('key', ['site_title', 'site_description']),
      supabase.from('languages').select('id, code, is_default'),
      supabase
        .from('pages')
        .select('slug, title, meta_description, language_id')
        .eq('status', 'published')
        .order('id', { ascending: true })
        .limit(200),
      supabase
        .from('posts')
        .select('slug, title, excerpt, meta_description, language_id, published_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(200),
    ]);

    for (const row of settingsResult.data ?? []) {
      const value = typeof row.value === 'string' ? row.value : null;
      if (row.key === 'site_title' && value?.trim()) siteTitle = value.trim();
      if (row.key === 'site_description' && value?.trim()) siteDescription = value.trim();
    }

    const languages = languagesResult.data ?? [];
    const defaultLanguageId = languages.find((entry) => entry.is_default)?.id ?? null;
    const codeById = new Map(languages.map((entry) => [entry.id, entry.code] as const));
    const languageLabel = (row: ContentRow) => {
      if (row.language_id == null || row.language_id === defaultLanguageId || codeById.size < 2) return '';
      const code = codeById.get(row.language_id);
      return code ? ` (${code})` : '';
    };

    const pages = (pagesResult.data ?? []).map((row) => ({
      language_id: row.language_id,
      slug: row.slug,
      summary: row.meta_description,
      title: row.title ? `${row.title}${languageLabel({ ...row, summary: null })}` : null,
    }));
    const posts = (postsResult.data ?? []).map((row) => ({
      language_id: row.language_id,
      slug: row.slug,
      summary: row.excerpt ?? row.meta_description,
      title: row.title ? `${row.title}${languageLabel({ ...row, summary: null })}` : null,
    }));

    sections.push(
      section(
        'Pages',
        pages.map((page) => line(page, base, page.slug === 'home' ? '' : '/')).map((entry) =>
          entry?.replace(`${base}/home)`, `${base}/)`) ?? null
        )
      ),
      section('Posts', posts.map((post) => line(post, base, '/blog/')))
    );
  } catch {
    sections.push('## Status\n\n- This NextBlock site is not set up yet.');
  }

  const body = [
    `# ${siteTitle}`,
    '',
    `> ${siteDescription ?? `${siteTitle} is published with NextBlock CMS.`}`,
    '',
    ...sections.filter(Boolean).flatMap((entry) => [entry, '']),
    NEXTBLOCK_SECTION,
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
