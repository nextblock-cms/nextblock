import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The update notice announces the newest version that npm or GitHub's latest release knows, and
 * its links must be for that version. GitHub releases are cut by hand, for some versions only, so
 * npm is usually ahead: through 0.23.5 an install on 0.23.4 was told "NextBlock 0.23.5 is
 * available" and handed the v0.23.4 archive and release notes. And 0.23.2 / 0.23.3 went to npm
 * with no git tag, so an archive of `v<version>` can be a 404.
 *
 * The download is also in the install's own layout: a flat project (`npm create nextblock`) gets
 * the create-nextblock tarball, never a GitHub source archive (the monorepo layout, which cannot
 * be unpacked over it); a monorepo gets GitHub's archives only, never the create-nextblock tarball
 * (the flat template, which cannot be unpacked over apps/ + libs/).
 */

const NPM_LATEST = 'https://registry.npmjs.org/create-nextblock/latest';
const RELEASES_LATEST = 'https://api.github.com/repos/nextblock-cms/nextblock/releases/latest';
const TAG_REF_PREFIX = 'https://api.github.com/repos/nextblock-cms/nextblock/git/ref/tags/';

type Release = {
  tag_name?: string;
  html_url?: string;
  tarball_url?: string;
  zipball_url?: string;
  published_at?: string;
};

const mocks = vi.hoisted(() => ({
  /**
   * This install's package.json: the scaffolder's stamp is the version it runs, and `install` its
   * layout. Always set here: without it isMonorepoInstall() probes the working directory, which
   * in this repository holds nx.json.
   */
  manifest: { version: '1.0.0', nextblock: { version: '0.23.4', install: 'monorepo' } },
  /** create-nextblock's `latest` on npm; null: the registry cannot be reached. */
  npmVersion: '0.23.5' as string | null,
  /** GitHub's latest release; null: none cut (404). */
  release: null as Release | null,
  /** Tags the upstream repository has. */
  tags: new Set<string>(),
  /** Every api.github.com request fails this way (the unauthenticated limit, or no network). */
  githubDown: false as false | 'rate-limited' | 'offline',
  /** Replaces GitHub's answer to a tag lookup (a 200 naming another ref, a body that is not JSON). */
  tagAnswer: null as null | ((tag: string) => Response),
  fetched: [] as string[],
  existingAlerts: [] as Array<{ id: string; metadata: Record<string, unknown> }>,
  inserted: [] as Array<{ alert_type: string; title: string; message: string; metadata: Record<string, unknown> }>,
}));

vi.mock('../../package.json', () => ({ default: mocks.manifest }));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'system_alerts') throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({ data: mocks.existingAlerts, error: null }) }),
          }),
        }),
        insert: async (row: (typeof mocks.inserted)[number]) => {
          mocks.inserted.push(row);
          return { error: null };
        },
      };
    },
  }),
}));
vi.mock('../setup/system-config', () => ({
  getSystemConfiguration: vi.fn(),
  setSystemConfigurationServiceRole: vi.fn(),
}));

import { checkForUpstreamUpdate, resolveUpdateLinks } from './check-upstream';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  mocks.fetched.push(url);
  if (url === NPM_LATEST) {
    if (mocks.npmVersion === null) throw new TypeError('fetch failed');
    return json({ name: 'create-nextblock', version: mocks.npmVersion });
  }
  if (url.startsWith('https://api.github.com/')) {
    if (mocks.githubDown === 'offline') throw new TypeError('fetch failed');
    if (mocks.githubDown === 'rate-limited') return json({ message: 'API rate limit exceeded' }, 403);
  }
  if (url === RELEASES_LATEST) {
    return mocks.release ? json(mocks.release) : json({ message: 'Not Found' }, 404);
  }
  if (url.startsWith(TAG_REF_PREFIX)) {
    const tag = url.slice(TAG_REF_PREFIX.length);
    if (mocks.tagAnswer) return mocks.tagAnswer(tag);
    return mocks.tags.has(tag)
      ? json({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: '0123abcd' } })
      : json({ message: 'Not Found' }, 404);
  }
  throw new Error(`Unexpected fetch: ${url}`);
}

/** GitHub's latest-release answer for `v<version>`, its links as the API writes them. */
function githubRelease(version: string): Release {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/nextblock-cms/nextblock/releases/tag/v${version}`,
    tarball_url: `https://api.github.com/repos/nextblock-cms/nextblock/tarball/v${version}`,
    zipball_url: `https://api.github.com/repos/nextblock-cms/nextblock/zipball/v${version}`,
    published_at: '2026-11-16T15:00:00Z',
  };
}

const releaseNotes = (version: string) => `https://github.com/nextblock-cms/nextblock/releases/tag/v${version}`;
const tagArchive = (version: string, format: 'tar.gz' | 'zip') =>
  `https://github.com/nextblock-cms/nextblock/archive/refs/tags/v${version}.${format}`;
const npmTarball = (version: string) =>
  `https://registry.npmjs.org/create-nextblock/-/create-nextblock-${version}.tgz`;

/** A fresh scenario: an install of the given layout on 0.23.4, npm at 0.23.5, nothing on GitHub. */
function resetScenario(install: 'monorepo' | 'standalone') {
  mocks.manifest.nextblock.version = '0.23.4';
  mocks.manifest.nextblock.install = install;
  mocks.npmVersion = '0.23.5';
  mocks.release = null;
  mocks.tags = new Set();
  mocks.githubDown = false;
  mocks.tagAnswer = null;
  mocks.fetched = [];
  mocks.existingAlerts = [];
  mocks.inserted = [];
  // The update track is not the layout: a monorepo whose GitHub repository cannot be resolved is
  // on the standalone track too, and only that track records the alert.
  vi.stubEnv('NEXTBLOCK_UPDATE_TRACK', 'standalone');
  vi.stubEnv('NEXTBLOCK_GITHUB_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('GH_TOKEN', '');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Runs the check; the alert it recorded, if any. */
async function check() {
  const result = await checkForUpstreamUpdate();
  expect(mocks.inserted.length).toBeLessThanOrEqual(1);
  return { result, alert: mocks.inserted[0] };
}

/** Each link names `version`, and no link names another version. */
function expectLinksOnlyFor(version: string, links: unknown[]) {
  const urls = links.filter((link): link is string => typeof link === 'string');
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.match(/\d+\.\d+\.\d+/g)).toEqual([version]);
  }
}

function alertLinks(alert: (typeof mocks.inserted)[number] | undefined): unknown[] {
  const metadata = alert?.metadata ?? {};
  return [metadata['download_url'], metadata['zipball_url'], metadata['html_url']];
}

function tagLookups(): string[] {
  return mocks.fetched.filter((url) => url.startsWith(TAG_REF_PREFIX));
}

describe('checkForUpstreamUpdate on a monorepo: GitHub’s archives of the version it announces', () => {
  beforeEach(() => resetScenario('monorepo'));

  it('npm ahead of the latest release (0.23.5 on npm, v0.23.4 released): the v0.23.5 tag archives, no notes', async () => {
    mocks.release = githubRelease('0.23.4');
    mocks.tags = new Set(['v0.23.4', 'v0.23.5']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', updateAvailable: true, alertRecorded: true });
    expect(alert?.title).toBe('NextBlock 0.23.5 is available');
    expect(alert?.metadata).toMatchObject({
      latest_version: '0.23.5',
      current_version: '0.23.4',
      download_url: tagArchive('0.23.5', 'tar.gz'),
      zipball_url: tagArchive('0.23.5', 'zip'),
      // v0.23.4's release notes describe the version this install already runs.
      html_url: null,
    });
    expect(result.tarballUrl).toBe(tagArchive('0.23.5', 'tar.gz'));
    expect(result.zipballUrl).toBe(tagArchive('0.23.5', 'zip'));
    expect(result.htmlUrl).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
    expectLinksOnlyFor('0.23.5', alertLinks(alert));
    expect(tagLookups()).toEqual([`${TAG_REF_PREFIX}v0.23.5`]);
  });

  it('a version GitHub says has no tag (0.23.2, 0.23.3): no download, never the flat create-nextblock tarball', async () => {
    mocks.manifest.nextblock.version = '0.23.1';
    mocks.npmVersion = '0.23.3';
    mocks.release = githubRelease('0.23.1');
    mocks.tags = new Set(['v0.23.0', 'v0.23.1']);

    const { result, alert } = await check();

    // The alert still announces the version: a git clone's `npm run update` merges upstream.
    expect(result).toMatchObject({ latestVersion: '0.23.3', alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      latest_version: '0.23.3',
      download_url: null,
      zipball_url: null,
      html_url: null,
    });
    expect(result.tarballUrl).toBeUndefined();
    expect(result.zipballUrl).toBeUndefined();
    expect(tagLookups()).toEqual([`${TAG_REF_PREFIX}v0.23.3`]);
  });

  // An alert keeps the links it was first recorded with, so a poll that lands while GitHub is
  // rate-limited (or before the tag is pushed, which docs/06 does after the npm publish) must not
  // pin the flat create-nextblock tarball. The archive URL is outside the API's limit and works as
  // soon as the tag exists.
  it.each(['rate-limited', 'offline'] as const)(
    'GitHub %s, so the tag is unknown: the tag’s archives, never npm’s flat tarball',
    async (state) => {
      mocks.githubDown = state;
      mocks.tags = new Set(['v0.23.5']);

      const { result, alert } = await check();

      expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', alertRecorded: true });
      expect(result.error).toBeUndefined();
      expect(alert?.metadata).toMatchObject({
        download_url: tagArchive('0.23.5', 'tar.gz'),
        zipball_url: tagArchive('0.23.5', 'zip'),
        html_url: null,
      });
      expectLinksOnlyFor('0.23.5', alertLinks(alert));
      expect(tagLookups()).toEqual([`${TAG_REF_PREFIX}v0.23.5`]);
    },
  );

  // GitHub answered, and not with this tag: a prefix match or another ref counts as no tag.
  it('a 200 that names another ref: the tag counts as missing, so no download', async () => {
    mocks.tagAnswer = () => json({ ref: 'refs/tags/v0.23.5-rc.1', object: { type: 'commit', sha: '0123abcd' } });

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({ download_url: null, zipball_url: null, html_url: null });
    expect(tagLookups()).toEqual([`${TAG_REF_PREFIX}v0.23.5`]);
  });

  // A garbled answer says nothing about the tag, like no answer at all.
  it('a 200 whose body is not JSON: the tag is unknown, so its archives', async () => {
    mocks.tagAnswer = () => new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({
      download_url: tagArchive('0.23.5', 'tar.gz'),
      zipball_url: tagArchive('0.23.5', 'zip'),
      html_url: null,
    });
  });

  it('no release cut at all: the tag archives when the tag exists', async () => {
    mocks.tags = new Set(['v0.23.5']);

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({
      download_url: tagArchive('0.23.5', 'tar.gz'),
      zipball_url: tagArchive('0.23.5', 'zip'),
      html_url: null,
    });
  });

  it('the release ahead of npm (cut before the packages went out): that release’s links, no tag lookup', async () => {
    mocks.manifest.nextblock.version = '0.23.5';
    mocks.npmVersion = '0.23.5';
    mocks.release = githubRelease('0.24.0');

    const { result, alert } = await check();

    expect(result).toMatchObject({ latestVersion: '0.24.0', updateAvailable: true, alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      latest_version: '0.24.0',
      download_url: 'https://api.github.com/repos/nextblock-cms/nextblock/tarball/v0.24.0',
      zipball_url: 'https://api.github.com/repos/nextblock-cms/nextblock/zipball/v0.24.0',
      html_url: releaseNotes('0.24.0'),
    });
    expect(result.publishedAt).toBe('2026-11-16T15:00:00Z');
    expectLinksOnlyFor('0.24.0', alertLinks(alert));
    expect(tagLookups()).toEqual([]);
  });

  it('npm and the latest release on the same version: the release’s archives and notes, no tag lookup', async () => {
    mocks.release = githubRelease('0.23.5');

    const { result, alert } = await check();

    expect(result).toMatchObject({ latestVersion: '0.23.5', alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      download_url: 'https://api.github.com/repos/nextblock-cms/nextblock/tarball/v0.23.5',
      zipball_url: 'https://api.github.com/repos/nextblock-cms/nextblock/zipball/v0.23.5',
      html_url: releaseNotes('0.23.5'),
    });
    expect(result.publishedAt).toBe('2026-11-16T15:00:00Z');
    expectLinksOnlyFor('0.23.5', alertLinks(alert));
    expect(tagLookups()).toEqual([]);
  });

  it('a matching release without archive links: the archives of that release’s own tag', async () => {
    mocks.release = { tag_name: '0.23.5', html_url: 'https://github.com/nextblock-cms/nextblock/releases/tag/0.23.5' };

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({
      download_url: 'https://github.com/nextblock-cms/nextblock/archive/refs/tags/0.23.5.tar.gz',
      zipball_url: 'https://github.com/nextblock-cms/nextblock/archive/refs/tags/0.23.5.zip',
      html_url: 'https://github.com/nextblock-cms/nextblock/releases/tag/0.23.5',
    });
  });

  it('a prerelease tag is not the version npm announces: its notes are not offered for it', async () => {
    mocks.manifest.nextblock.version = '0.23.5';
    mocks.npmVersion = '0.24.0';
    mocks.release = githubRelease('0.24.0-rc.1');
    mocks.tags = new Set(['v0.24.0-rc.1', 'v0.24.0']);

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({
      latest_version: '0.24.0',
      download_url: tagArchive('0.24.0', 'tar.gz'),
      zipball_url: tagArchive('0.24.0', 'zip'),
      html_url: null,
    });
  });

  it('npm unreachable: GitHub’s latest release is the version announced, with its own links', async () => {
    mocks.npmVersion = null;
    mocks.release = githubRelease('0.23.5');

    const { result, alert } = await check();

    expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      download_url: 'https://api.github.com/repos/nextblock-cms/nextblock/tarball/v0.23.5',
      html_url: releaseNotes('0.23.5'),
    });
  });

  it('an install already on the latest version: no alert, no tag lookup, links still for that version', async () => {
    mocks.manifest.nextblock.version = '0.23.5';
    mocks.release = githubRelease('0.23.4');
    mocks.tags = new Set(['v0.23.5']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', updateAvailable: false, alertRecorded: false });
    expect(alert).toBeUndefined();
    expect(result.tarballUrl).toBe(tagArchive('0.23.5', 'tar.gz'));
    expect(result.htmlUrl).toBeUndefined();
    expect(tagLookups()).toEqual([]);
  });

  it('a git-backed install (Track A merges upstream itself): no alert and no tag lookup', async () => {
    vi.stubEnv('NEXTBLOCK_UPDATE_TRACK', 'git');
    mocks.release = githubRelease('0.23.4');
    mocks.tags = new Set(['v0.23.5']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ track: 'git', latestVersion: '0.23.5', updateAvailable: true, alertRecorded: false });
    expect(alert).toBeUndefined();
    expect(result.tarballUrl).toBe(tagArchive('0.23.5', 'tar.gz'));
    expect(tagLookups()).toEqual([]);
  });

  it('a version already alerted is not recorded again', async () => {
    mocks.existingAlerts = [{ id: 'alert-1', metadata: { latest_version: '0.23.5' } }];
    mocks.tags = new Set(['v0.23.5']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ latestVersion: '0.23.5', alertRecorded: false });
    expect(alert).toBeUndefined();
  });
});

describe('checkForUpstreamUpdate on a flat project: the create-nextblock tarball, never a GitHub archive', () => {
  beforeEach(() => resetScenario('standalone'));

  it('npm ahead of the latest release, the tag pushed: the npm tarball, and GitHub is not asked about the tag', async () => {
    mocks.release = githubRelease('0.23.4');
    mocks.tags = new Set(['v0.23.4', 'v0.23.5']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', updateAvailable: true, alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      latest_version: '0.23.5',
      download_url: npmTarball('0.23.5'),
      zipball_url: null,
      html_url: null,
    });
    expect(result.tarballUrl).toBe(npmTarball('0.23.5'));
    expect(result.zipballUrl).toBeUndefined();
    expectLinksOnlyFor('0.23.5', alertLinks(alert));
    expect(tagLookups()).toEqual([]);
  });

  it('npm and the latest release on the same version: the npm tarball, with that release’s notes', async () => {
    mocks.release = githubRelease('0.23.5');

    const { result, alert } = await check();

    expect(alert?.metadata).toMatchObject({
      download_url: npmTarball('0.23.5'),
      zipball_url: null,
      html_url: releaseNotes('0.23.5'),
    });
    expect(result.publishedAt).toBe('2026-11-16T15:00:00Z');
    expectLinksOnlyFor('0.23.5', alertLinks(alert));
    expect(tagLookups()).toEqual([]);
  });

  it('a version with no tag (0.23.3): the npm tarball, as for any version npm has', async () => {
    mocks.manifest.nextblock.version = '0.23.1';
    mocks.npmVersion = '0.23.3';
    mocks.release = githubRelease('0.23.1');

    const { alert } = await check();

    expect(alert?.metadata).toMatchObject({ download_url: npmTarball('0.23.3'), zipball_url: null, html_url: null });
    expect(tagLookups()).toEqual([]);
  });

  it('GitHub offline: the npm tarball all the same', async () => {
    mocks.githubDown = 'offline';

    const { result, alert } = await check();

    expect(result).toMatchObject({ ok: true, latestVersion: '0.23.5', alertRecorded: true });
    expect(alert?.metadata).toMatchObject({ download_url: npmTarball('0.23.5'), html_url: null });
  });

  it('the release ahead of npm: its notes and no download (npm has no 0.24.0 yet, and its archive is the monorepo layout)', async () => {
    mocks.manifest.nextblock.version = '0.23.5';
    mocks.npmVersion = '0.23.5';
    mocks.release = githubRelease('0.24.0');
    mocks.tags = new Set(['v0.24.0']);

    const { result, alert } = await check();

    expect(result).toMatchObject({ latestVersion: '0.24.0', updateAvailable: true, alertRecorded: true });
    expect(alert?.metadata).toMatchObject({
      latest_version: '0.24.0',
      download_url: null,
      zipball_url: null,
      html_url: releaseNotes('0.24.0'),
    });
    expect(result.tarballUrl).toBeUndefined();
    expect(result.publishedAt).toBe('2026-11-16T15:00:00Z');
    expectLinksOnlyFor('0.24.0', alertLinks(alert));
    expect(tagLookups()).toEqual([]);
  });
});

describe('resolveUpdateLinks', () => {
  it('never falls back to npm’s tarball of another version, in either layout', () => {
    // GitHub's release announced 0.24.0 (it does not match here), and npm has only 0.23.5.
    const input = { latestVersion: '0.24.0', npmVersion: '0.23.5', release: githubRelease('0.23.5'), tagStatus: 'missing' } as const;
    expect(resolveUpdateLinks({ ...input, monorepo: true })).toEqual({ source: 'none' });
    expect(resolveUpdateLinks({ ...input, monorepo: false })).toEqual({ source: 'none' });
  });

  it.each(['0.23.5/../../0.23.4', '0.23.5?ref=0.23.4', '0.23.5#x', '0.23.5 ', 'latest', '0.23'])(
    'builds no link from the version %j',
    (latestVersion) => {
      for (const tagStatus of ['exists', 'unknown'] as const) {
        const input = { latestVersion, npmVersion: latestVersion, release: null, tagStatus };
        expect(resolveUpdateLinks({ ...input, monorepo: true })).toEqual({ source: 'none' });
        expect(resolveUpdateLinks({ ...input, monorepo: false })).toEqual({ source: 'none' });
      }
    },
  );

  it('a monorepo takes the release, then the tag unless GitHub says it is missing, never npm’s flat tarball', () => {
    const base = { latestVersion: '0.23.5', npmVersion: '0.23.5', monorepo: true };
    const tagArchives = { source: 'tag', tarballUrl: tagArchive('0.23.5', 'tar.gz'), zipballUrl: tagArchive('0.23.5', 'zip') };
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.5'), tagStatus: 'exists' }).source).toBe('release');
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.5'), tagStatus: 'missing' }).source).toBe('release');
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.4'), tagStatus: 'exists' })).toEqual(tagArchives);
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.4'), tagStatus: 'unknown' })).toEqual(tagArchives);
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.4'), tagStatus: 'missing' })).toEqual({ source: 'none' });
    expect(resolveUpdateLinks({ ...base, release: null, tagStatus: 'missing' })).toEqual({ source: 'none' });
    expect(resolveUpdateLinks({ ...base, npmVersion: null, release: null, tagStatus: 'unknown' })).toEqual(tagArchives);
  });

  it('a flat project gets only the npm tarball, with the notes of a release that is the version', () => {
    const base = { latestVersion: '0.23.5', npmVersion: '0.23.5', monorepo: false, tagStatus: 'exists' } as const;
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.5') })).toEqual({
      source: 'npm',
      tarballUrl: npmTarball('0.23.5'),
      htmlUrl: releaseNotes('0.23.5'),
      publishedAt: '2026-11-16T15:00:00Z',
    });
    expect(resolveUpdateLinks({ ...base, release: githubRelease('0.23.4') })).toEqual({
      source: 'npm',
      tarballUrl: npmTarball('0.23.5'),
    });
    expect(resolveUpdateLinks({ ...base, latestVersion: '0.24.0', release: githubRelease('0.24.0') })).toEqual({
      source: 'none',
      htmlUrl: releaseNotes('0.24.0'),
      publishedAt: '2026-11-16T15:00:00Z',
    });
  });
});
