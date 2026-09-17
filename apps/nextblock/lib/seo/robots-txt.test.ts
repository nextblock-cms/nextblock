import { describe, expect, it } from 'vitest';
import type { MetadataRoute } from 'next';
// The serialiser Next itself runs for a dynamic `robots.ts` metadata route (see
// next/dist/build/webpack/loaders/next-metadata-route-loader.js). /robots.txt is NOT
// served that way any more — app/robots.txt/route.ts serves `buildRobotsTxt` directly,
// so preview and file are the same string by construction — but `renderRobotsMetadata`
// is still a port of this serialiser, and these tests pin that the port matches it for
// every field Next models. The one deliberate divergence is the per-rule `other` map:
// Next drops those directives, which is precisely why the route handler exists. If a
// Next upgrade moves or changes the serialiser, this import (or the assertions below)
// fail loudly, which is the signal we want.
import { resolveRobots as nextResolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data';
import { DEFAULT_ROBOTS_SETTINGS, type RobotsSettings } from '@nextblock-cms/utils/seo';

import {
  buildRobotsMetadata,
  buildRobotsTxt,
  listUnservedCustomRuleLines,
  renderRobotsMetadata,
  type RobotsTxtOptions,
} from './robots-txt';

const LIVE: RobotsTxtOptions = { isSandbox: false, sitemapUrl: 'https://example.com/sitemap.xml' };
const SANDBOX: RobotsTxtOptions = { isSandbox: true, sitemapUrl: 'https://example.com/sitemap.xml' };

/** A settings object built from the shipped defaults plus whatever the test cares about. */
function settings(overrides: Partial<RobotsSettings> = {}): RobotsSettings {
  return {
    customRules: DEFAULT_ROBOTS_SETTINGS.customRules,
    isIndexingEnabled: DEFAULT_ROBOTS_SETTINGS.isIndexingEnabled,
    sitemapEnabled: DEFAULT_ROBOTS_SETTINGS.sitemapEnabled,
    userAgentRules: [{ allow: ['/'], disallow: [], userAgent: '*' }],
    ...overrides,
  };
}

/** What Next would write to /robots.txt for these settings, produced by Next's own code. */
function served(value: RobotsSettings, options: RobotsTxtOptions): string {
  return nextResolveRobots(buildRobotsMetadata(value, options));
}

describe('renderRobotsMetadata', () => {
  // buildRobotsTxt is only trustworthy because this renderer is Next's renderer. Each
  // case here pins one rendering rule that a hand-written formatter tends to get
  // wrong: the capitalised field name, the blank line after the final group, the
  // per-entry expansion of `other`, and the position of host/sitemap.
  const cases: Array<{ metadata: MetadataRoute.Robots; name: string }> = [
    { metadata: { rules: [{ allow: '/', userAgent: '*' }] }, name: 'a single permissive group' },
    {
      metadata: { rules: [{ disallow: ['/cms', '/api'], userAgent: ['GPTBot', 'CCBot'] }] },
      name: 'one group shared by several agents',
    },
    {
      metadata: {
        rules: [{ crawlDelay: 10, disallow: [''], userAgent: 'Bingbot' }],
        sitemap: ['https://example.com/sitemap.xml', 'https://example.com/news.xml'],
      },
      name: 'a crawl delay, an empty disallow and two sitemaps',
    },
  ];

  for (const { metadata, name } of cases) {
    it(`matches Next's serialiser for ${name}`, () => {
      expect(renderRobotsMetadata(metadata)).toBe(nextResolveRobots(metadata));
    });
  }

  it('carries non-standard directives via `other`, which Next has no field for', () => {
    const metadata = {
      host: 'example.com',
      rules: [
        {
          other: { 'Clean-param': ['ref /articles/', 'utm_source /'], 'Request-Rate': '10/1m' },
          userAgent: 'Yandex',
        },
      ],
    } as MetadataRoute.Robots;

    expect(renderRobotsMetadata(metadata)).toBe(
      'User-Agent: Yandex\nClean-param: ref /articles/\nClean-param: utm_source /\nRequest-Rate: 10/1m\n\n' +
        'Host: example.com\n'
    );
    // Next's own serialiser dropped these until 16.3, which is why /robots.txt became a
    // route handler running our renderer instead of a metadata route. Next 16.3 emits them
    // too; this now pins that the two agree, so a future divergence fails here.
    expect(nextResolveRobots(metadata)).toBe(renderRobotsMetadata(metadata));
  });

  it("emits Next's exact shape, blank trailing line and all", () => {
    expect(renderRobotsMetadata({ rules: [{ allow: '/', userAgent: '*' }] })).toBe(
      'User-Agent: *\nAllow: /\n\n'
    );
  });
});

describe('buildRobotsTxt', () => {
  // The preview and the served file were once produced by two different formatters,
  // and the custom-rules block was the case where they disagreed: the preview showed
  // lines the metadata route could not carry, so an operator could read a directive
  // in the preview that no crawler ever received. Every case below asserts the
  // preview IS the served bytes, using Next's own serialiser as the reference.
  it('is byte-for-byte what Next serves for the default settings', () => {
    expect(buildRobotsTxt(settings(), LIVE)).toBe(served(settings(), LIVE));
    expect(buildRobotsTxt(settings(), LIVE)).toBe(
      'User-Agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n'
    );
  });

  it('is byte-for-byte what Next serves when indexing is switched off', () => {
    const off = settings({
      isIndexingEnabled: false,
      userAgentRules: [{ allow: ['/'], disallow: ['/cms'], userAgent: '*' }],
    });

    expect(buildRobotsTxt(off, LIVE)).toBe(served(off, LIVE));
    // No sitemap either: advertising one next to a blanket disallow is a
    // self-contradicting file.
    expect(buildRobotsTxt(off, LIVE)).toBe('User-Agent: *\nDisallow: /\n\n');
  });

  it('is byte-for-byte what Next serves when the sitemap is switched off', () => {
    const noSitemap = settings({ sitemapEnabled: false });

    expect(buildRobotsTxt(noSitemap, LIVE)).toBe(served(noSitemap, LIVE));
    expect(buildRobotsTxt(noSitemap, LIVE)).toBe('User-Agent: *\nAllow: /\n\n');
  });

  it('is byte-for-byte what Next serves for multiple user agents', () => {
    const many = settings({
      sitemapEnabled: false,
      userAgentRules: [
        { allow: ['/', '/public'], disallow: ['/cms', '/api'], userAgent: '*' },
        { allow: [], disallow: ['/'], userAgent: 'GPTBot' },
        { allow: [], disallow: [], userAgent: 'Bingbot' },
      ],
    });

    expect(buildRobotsTxt(many, LIVE)).toBe(served(many, LIVE));
    expect(buildRobotsTxt(many, LIVE)).toBe(
      'User-Agent: *\nAllow: /\nAllow: /public\nDisallow: /cms\nDisallow: /api\n\n' +
        'User-Agent: GPTBot\nDisallow: /\n\n' +
        // A group with no paths at all emits an empty `Disallow` value — the
        // specified way of saying "nothing is disallowed" — because a group that is
        // nothing but its `User-agent:` header is malformed and some parsers discard
        // the groups after it.
        'User-Agent: Bingbot\nDisallow: \n\n'
    );
  });

  it('is byte-for-byte what Next serves for a custom-rules block', () => {
    const custom = settings({
      customRules: '  User-agent: AhrefsBot\nDisallow: /\nCrawl-delay: 5  ',
    });

    expect(buildRobotsTxt(custom, LIVE)).toBe(served(custom, LIVE));
    expect(buildRobotsTxt(custom, LIVE)).toBe(
      'User-Agent: *\nAllow: /\n\n' +
        'User-Agent: AhrefsBot\nDisallow: /\nCrawl-delay: 5\n\n' +
        'Sitemap: https://example.com/sitemap.xml\n'
    );
  });

  it('serves the non-standard directives it shows, via the per-rule `other` escape hatch', () => {
    // These are the lines that used to appear in the preview and vanish from the
    // file. `Clean-param`, `Request-rate` and a per-group `Host` have no typed field
    // in `MetadataRoute.Robots`, and before Next 16.3 a metadata route dropped them.
    // app/robots.txt/route.ts serves `buildRobotsTxt` itself, which keeps them in the
    // file crawlers receive whatever Next's serialiser does. Next 16.3 carries `other`
    // through as well, checked here against its real serialiser.
    const custom = settings({
      customRules:
        'User-agent: Yandex\nClean-param: ref /articles/\nClean-param: utm_source /\nHost: example.com',
      sitemapEnabled: false,
    });

    expect(served(custom, LIVE)).toContain('Clean-param');
    expect(listUnservedCustomRuleLines(custom, LIVE)).toEqual([]);
    expect(buildRobotsTxt(custom, LIVE)).toBe(
      'User-Agent: *\nAllow: /\n\n' +
        'User-Agent: Yandex\nClean-param: ref /articles/\nClean-param: utm_source /\n' +
        'Host: example.com\n\n'
    );
  });

  it('normalises CRLF in custom rules typed from a Windows browser', () => {
    const windows = settings({ customRules: 'Crawl-delay: 10\r\nDisallow: /tmp', sitemapEnabled: false });

    expect(buildRobotsTxt(windows, LIVE)).toBe(served(windows, LIVE));
    // The directives are re-ordered into Next's per-group order (paths, then crawl
    // delay) rather than the order they were typed. Robots groups are unordered sets
    // of directives so nothing changes for a crawler, and — the part that matters —
    // the operator sees the re-ordering, because this text is the file.
    expect(buildRobotsTxt(windows, LIVE)).toBe(
      'User-Agent: *\nAllow: /\n\nUser-Agent: *\nDisallow: /tmp\nCrawl-delay: 10\n\n'
    );
  });

  it('falls back to the permissive wildcard when there are no rules', () => {
    // A file with no User-agent group is meaningless rather than strict, and
    // crawlers disagree about how to read one.
    const empty = settings({ sitemapEnabled: false, userAgentRules: [] });

    expect(buildRobotsTxt(empty, LIVE)).toBe(served(empty, LIVE));
    expect(buildRobotsTxt(empty, LIVE)).toBe('User-Agent: *\nAllow: /\n\n');
  });

  it('omits the sitemap when no site URL is known', () => {
    expect(buildRobotsTxt(settings(), { isSandbox: false, sitemapUrl: null })).toBe(
      'User-Agent: *\nAllow: /\n\n'
    );
    expect(buildRobotsTxt(settings(), { isSandbox: false, sitemapUrl: '   ' })).toBe(
      'User-Agent: *\nAllow: /\n\n'
    );
  });

  it('still appends custom rules while indexing is off', () => {
    const off = settings({ customRules: 'Allow: /.well-known/', isIndexingEnabled: false });

    expect(buildRobotsTxt(off, LIVE)).toBe(served(off, LIVE));
    expect(buildRobotsTxt(off, LIVE)).toBe(
      'User-Agent: *\nDisallow: /\n\nUser-Agent: *\nAllow: /.well-known/\n\n'
    );
  });

  it('ignores every operator setting in the sandbox', () => {
    // The sandbox must stay crawlable so Googlebot can read the X-Robots-Tag
    // noindex it is served; a Disallow would block the fetch and leave URL-only
    // entries in the index forever. A sandbox visitor sharing the demo admin
    // login must not be able to cause that.
    const hostile = settings({
      customRules: 'Disallow: /everything',
      isIndexingEnabled: false,
      sitemapEnabled: true,
      userAgentRules: [{ allow: [], disallow: ['/'], userAgent: '*' }],
    });

    for (const value of [hostile, settings()]) {
      const text = buildRobotsTxt(value, SANDBOX);
      expect(text).toBe(served(value, SANDBOX));
      expect(text).toBe('User-Agent: *\nAllow: /\n\n');
      expect(text).not.toContain('Sitemap');
      expect(text).not.toContain('Disallow');
    }
  });

  it('always ends with a newline', () => {
    for (const options of [LIVE, SANDBOX]) {
      expect(buildRobotsTxt(settings(), options).endsWith('\n')).toBe(true);
    }
  });
});

describe('buildRobotsMetadata', () => {
  it('mirrors the text serializer for the default settings', () => {
    expect(buildRobotsMetadata(settings(), LIVE)).toEqual({
      rules: [{ allow: ['/'], userAgent: '*' }],
      sitemap: 'https://example.com/sitemap.xml',
    });
  });

  it('omits empty allow/disallow arrays rather than emitting them', () => {
    expect(
      buildRobotsMetadata(
        settings({ sitemapEnabled: false, userAgentRules: [{ allow: [], disallow: ['/cms'], userAgent: 'GPTBot' }] }),
        LIVE
      )
    ).toEqual({ rules: [{ disallow: ['/cms'], userAgent: 'GPTBot' }] });
  });

  it('collapses to a site-wide disallow with no sitemap when indexing is off', () => {
    expect(
      buildRobotsMetadata(
        settings({ isIndexingEnabled: false, userAgentRules: [{ allow: ['/'], disallow: [], userAgent: '*' }] }),
        LIVE
      )
    ).toEqual({ rules: [{ disallow: ['/'], userAgent: '*' }] });
  });

  it('holds the sandbox invariant just as the text serializer does', () => {
    expect(
      buildRobotsMetadata(settings({ isIndexingEnabled: false, customRules: 'Disallow: /' }), SANDBOX)
    ).toEqual({ rules: [{ allow: ['/'], userAgent: '*' }] });
  });

  it('carries the custom-rules block into the served object', () => {
    expect(
      buildRobotsMetadata(
        settings({
          customRules:
            '# a comment\nUser-agent: GPTBot\nDisallow: /\nCrawl-delay: 10\nRequest-rate: 1/10s',
          sitemapEnabled: false,
        }),
        LIVE
      )
    ).toEqual({
      rules: [
        { allow: ['/'], userAgent: '*' },
        {
          crawlDelay: 10,
          disallow: ['/'],
          other: { 'Request-rate': '1/10s' },
          userAgent: 'GPTBot',
        },
      ],
    });
  });

  it('keeps consecutive user-agent lines on one group and repeats a directive via an array', () => {
    expect(
      buildRobotsMetadata(
        settings({
          customRules: 'User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\nCrawl-delay: 2\nCrawl-delay: 4',
          sitemapEnabled: false,
        }),
        LIVE
      )
    ).toEqual({
      rules: [
        { allow: ['/'], userAgent: '*' },
        {
          crawlDelay: 2,
          disallow: ['/'],
          // The second crawl delay would be lost by the typed field, so it rides
          // `other` and reaches the file instead of disappearing.
          other: { 'Crawl-delay': '4' },
          userAgent: ['GPTBot', 'CCBot'],
        },
      ],
    });
  });
});

describe('listUnservedCustomRuleLines', () => {
  it('is empty when every line can be served', () => {
    expect(
      listUnservedCustomRuleLines(
        settings({ customRules: 'User-agent: GPTBot\nDisallow: /\nClean-param: ref /' }),
        LIVE
      )
    ).toEqual([]);
  });

  it('names the lines the served file cannot carry', () => {
    // Comments and lines that are not `name: value` at all have no representation in
    // `MetadataRoute.Robots`. No crawler acts on either, so the file loses nothing —
    // but the operator has to be told, because a line that silently disappears from a
    // preview reads as a bug and invites a retry.
    expect(
      listUnservedCustomRuleLines(
        settings({ customRules: '# block the scrapers\nnot a directive\nUser-agent:\nDisallow: /x' }),
        LIVE
      )
    ).toEqual(['# block the scrapers', 'not a directive', 'User-agent:']);
  });

  it('reports the whole block in the sandbox, where custom rules are inert', () => {
    expect(
      listUnservedCustomRuleLines(settings({ customRules: 'User-agent: GPTBot\nDisallow: /' }), SANDBOX)
    ).toEqual(['User-agent: GPTBot', 'Disallow: /']);
  });

  it('accounts for every custom line: each one is either served or reported', () => {
    // The property the preview depends on. A line that is neither in the file nor in
    // the unserved list is exactly the failure this module was fixed for.
    const customRules =
      '# note\nUser-agent: GPTBot\nDisallow: /private\nCrawl-delay: 3\nClean-param: ref /\nnonsense';
    const value = settings({ customRules, sitemapEnabled: false });

    // Compared case-insensitively because Next writes the canonical `User-Agent:`
    // capitalisation whatever the operator typed, and robots.txt field names are
    // case-insensitive (RFC 9309 §2.2), so that rewrite carries no meaning.
    const text = buildRobotsTxt(value, LIVE).toLowerCase();
    const unserved = listUnservedCustomRuleLines(value, LIVE);

    for (const line of customRules.split('\n')) {
      if (unserved.includes(line)) {
        expect(text).not.toContain(line.toLowerCase());
      } else {
        expect(text).toContain(line.toLowerCase());
      }
    }
  });
});
