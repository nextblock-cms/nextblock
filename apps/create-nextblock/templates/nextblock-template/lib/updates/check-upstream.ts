import 'server-only';
// Track B — Decoupled application runtime update engine + Track-A conflict mirror.
//
// Two responsibilities, both writing into system_alerts via the service-role client
// (the key this install already has — no GitHub secrets required):
//   1. checkForUpstreamUpdate(): resolve the newest published version (the npm registry, with
//      GitHub's latest release as the fallback), compare it against this install's version,
//      and on a NON-git (standalone) install record a 'runtime_update_available' alert whose
//      links are for that version only, the download in this install's own layout
//      (resolveUpdateLinks).
//   2. checkForSyncConflicts(): for git-backed installs, poll THIS fork's issues for the
//      'nextblock-sync-conflict' label the sync workflow opens, and mirror open ones into
//      'merge_conflict' alerts (clearing them when the issue closes). This is the "pull"
//      half of Track A: the GitHub Action signals with the auto-provided GITHUB_TOKEN, and
//      the app — which holds the Supabase key — owns the alert write. Zero GitHub secrets.
//
// Private forks: set NEXTBLOCK_GITHUB_TOKEN so the issue/run polling is authenticated.
// Public forks need nothing (the unauthenticated GitHub API is sufficient).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getSystemConfiguration, setSystemConfigurationServiceRole } from '../setup/system-config';
import { resolveSelfRepo } from './repo-identity';
import pkg from '../../package.json';

const UPSTREAM_REPO = 'nextblock-cms/nextblock';
const RELEASES_API = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`;
// The npm registry is the authoritative version signal for standalone installs: the
// `create-nextblock` package ships the exact standalone template they were scaffolded
// from and is published in lockstep with the app, whereas GitHub release tags are cut by
// hand and lag (they have, in practice, sat many minor versions behind the real version —
// which silently disabled this whole check). Releases stay as the fallback.
const NPM_REGISTRY_API = 'https://registry.npmjs.org/create-nextblock/latest';
// One create-nextblock version's tarball: the standalone template `npm run update` installs. npm
// never lets a published version be replaced, so the file here is that version for good.
const NPM_TARBALL_BASE = 'https://registry.npmjs.org/create-nextblock/-/create-nextblock-';
// The versions a link is built from: x.y.z with an optional prerelease. Nothing in it can leave
// the URL path segment it goes into.
const LINKABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// The sync workflow tags its conflict issues with this hidden body marker. We match on it
// (not on a label) so a label that failed to create on GitHub can't hide a real conflict.
const CONFLICT_MARKER = '<!-- nextblock-sync-conflict -->';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // throttle the background poll to every 6h

export type UpdateTrack = 'git' | 'standalone';

export interface UpstreamUpdateResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  track: UpdateTrack;
  // The four below are for latestVersion only, or absent (resolveUpdateLinks).
  htmlUrl?: string;
  tarballUrl?: string;
  zipballUrl?: string;
  publishedAt?: string;
  alertRecorded: boolean;
  error?: string;
}

/** The fields of GitHub's latest release this module reads. */
export interface UpstreamRelease {
  tag_name?: string;
  html_url?: string;
  tarball_url?: string;
  zipball_url?: string;
  published_at?: string;
}

/** Where the update notice's download link comes from (resolveUpdateLinks). */
export type UpdateLinkSource = 'release' | 'tag' | 'npm' | 'none';

export interface UpdateLinks {
  source: UpdateLinkSource;
  tarballUrl?: string;
  zipballUrl?: string;
  htmlUrl?: string;
  publishedAt?: string;
}

/**
 * What GitHub said about the tag `v<version>` (upstreamTagStatus): 'missing' only when it answered
 * that there is no such tag, 'unknown' when it could not answer or was not asked.
 */
export type UpstreamTagStatus = 'exists' | 'missing' | 'unknown';

export interface SyncConflictResult {
  ok: boolean;
  repo: string | null;
  openConflicts: number;
  actionsActive: boolean;
  alertsWritten: number;
  alertsResolved: number;
  error?: string;
}

/** GitHub API headers, authenticated when a token is configured (needed for private forks). */
function githubHeaders(): Record<string, string> {
  const token =
    process.env.NEXTBLOCK_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nextblock-update-checker',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Compare two semver-ish strings. >0 if a>b, <0 if a<b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The NextBlock version this install is running.
 *
 * `package.json.nextblock.version` is the authoritative stamp, written by the scaffolder
 * and re-written by `npm run update`. A project's own `version` field belongs to the
 * user, and the moment they bump it for their own site — entirely normal — comparing a
 * release against it becomes meaningless. Fall back to it only for projects created
 * before the stamp existed.
 */
function readInstalledVersion(): string {
  const manifest = pkg as { version?: string; nextblock?: { version?: string } };
  const stamped = manifest.nextblock?.version?.trim();
  return stamped || manifest.version || '0.0.0';
}

/** Latest published `create-nextblock` version, or null when the registry is unreachable. */
async function fetchLatestFromNpm(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_API, {
      headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    const version = body.version?.trim();
    return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Is this install the NextBlock MONOREPO (a Vercel 1-click deploy, a GitHub fork, or a
 * clone) rather than the flattened standalone app that `npm create nextblock` produces?
 *
 * This — not the hosting platform — is what decides whether the upstream-sync GitHub
 * Action can work, because that Action merges the monorepo (`apps/`, `libs/`, `tools/`,
 * `nx.json`) into the repository. Merging it into a flat standalone project, whose tree is
 * `app/`, `components/`, `lib/`, would wreck the project. A standalone app pushed to GitHub
 * and deployed on Vercel is still standalone; where it is hosted is irrelevant.
 *
 * The marker lives in the bundled package.json (`nextblock.install`) so it is readable on a
 * serverless filesystem, where neither `nx.json` nor `.github/` is traced into the function.
 * Projects scaffolded before that marker existed fall back to filesystem probes and then to
 * 'standalone' — which at worst shows a 1-click deploy an extra update banner, and is the
 * safe default: it never offers to install the Action where it would do damage.
 */
export function isMonorepoInstall(): boolean {
  const manifest = pkg as { nextblock?: { install?: string } };
  const declared = manifest.nextblock?.install;
  if (declared === 'monorepo') return true;
  if (declared === 'standalone') return false;

  const cwd = process.cwd();
  try {
    if (existsSync(path.join(cwd, 'nx.json'))) return true;
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(path.join(cwd, '.github', 'workflows', 'nextblock-sync.yml'))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Classify how this install receives updates. Explicit NEXTBLOCK_UPDATE_TRACK wins;
 * otherwise a monorepo-shaped install with a resolvable GitHub repo is 'git' (Track A —
 * the daily Action merges upstream for it), and everything else is 'standalone' (Track B —
 * it needs `npm run update`).
 *
 * Deliberately NOT keyed on `process.env.VERCEL`: a standalone project deployed to Vercel
 * used to be classified 'git', which suppressed its update banner entirely while no Action
 * existed to update it — leaving it silently frozen.
 */
function detectTrack(): UpdateTrack {
  const override = process.env.NEXTBLOCK_UPDATE_TRACK?.trim().toLowerCase();
  if (override === 'git' || override === 'standalone') return override;
  if (!isMonorepoInstall()) return 'standalone';

  if (resolveSelfRepo()) {
    const cwd = process.cwd();
    try {
      if (existsSync(path.join(cwd, '.github', 'workflows', 'nextblock-sync.yml'))) return 'git';
    } catch {
      /* ignore */
    }
    try {
      const gitConfig = path.join(cwd, '.git', 'config');
      if (existsSync(gitConfig) && /nextblock/i.test(readFileSync(gitConfig, 'utf8'))) return 'git';
    } catch {
      /* ignore */
    }
    // Monorepo-shaped and GitHub-hosted, but the workflow isn't visible from here (normal
    // on a serverless filesystem). Trust the layout marker.
    return 'git';
  }
  return 'standalone';
}

/** A release's version: its tag without the leading `v`, or null. */
function releaseVersion(release: UpstreamRelease | null): string | null {
  return release?.tag_name?.trim().replace(/^v/i, '') || null;
}

/** GitHub's source archive of one upstream tag. */
function tagArchiveUrl(tag: string, format: 'tar.gz' | 'zip'): string {
  return `https://github.com/${UPSTREAM_REPO}/archive/refs/tags/${tag}.${format}`;
}

/**
 * The update notice's download and release-notes links, always for the version it announces.
 *
 * GitHub releases are cut by hand, for some versions only, so npm is usually ahead of the latest
 * one. Through 0.23.5 the links came from that release whatever its version: an install on 0.23.4
 * was told 0.23.5 was out and handed the 0.23.4 archive and notes.
 *
 * Release notes and the publish date come from GitHub's latest release, only when its tag is the
 * announced version: nothing else has them for that version. The download is in the install's
 * own layout:
 * - A flat project (what `npm create nextblock` makes): that version's create-nextblock tarball,
 *   the standalone template `npm run update` installs, when npm announced the version; else none.
 *   A GitHub source archive is the monorepo layout, which cannot be unpacked over a flat project.
 * - A monorepo: the matching release's archives, else those of the tag `v<version>` unless GitHub
 *   says that tag is missing (0.23.2 and 0.23.3 went to npm with no tag at all, and the archive of
 *   a missing tag is a 404), else none. A tag GitHub could not answer about (the unauthenticated
 *   API's 60 requests an hour, or no network) still gets its archives: archive downloads are
 *   outside that limit and work as soon as the tag exists, while an alert keeps the links it was
 *   first recorded with. Never the create-nextblock tarball: that is the flat template, which
 *   cannot be unpacked over apps/ + libs/.
 * A version that is not plain x.y.z[-prerelease] gets no links.
 */
export function resolveUpdateLinks({
  latestVersion,
  npmVersion,
  release,
  tagStatus,
  monorepo,
}: {
  latestVersion: string;
  npmVersion: string | null;
  release: UpstreamRelease | null;
  /** What GitHub said about the tag `v<latestVersion>`; only a monorepo reads it. */
  tagStatus: UpstreamTagStatus;
  /** This install has the monorepo layout (isMonorepoInstall); false for a flat project. */
  monorepo: boolean;
}): UpdateLinks {
  if (!LINKABLE_VERSION.test(latestVersion)) return { source: 'none' };

  const releaseTag = release?.tag_name?.trim() ?? '';
  const matching = release && releaseTag && releaseVersion(release) === latestVersion ? release : null;
  const notes = matching
    ? { htmlUrl: matching.html_url || undefined, publishedAt: matching.published_at || undefined }
    : {};
  const npmTarball = npmVersion === latestVersion ? `${NPM_TARBALL_BASE}${latestVersion}.tgz` : null;

  if (!monorepo) {
    return npmTarball ? { source: 'npm', tarballUrl: npmTarball, ...notes } : { source: 'none', ...notes };
  }
  if (matching) {
    return {
      source: 'release',
      tarballUrl: matching.tarball_url || tagArchiveUrl(releaseTag, 'tar.gz'),
      zipballUrl: matching.zipball_url || tagArchiveUrl(releaseTag, 'zip'),
      ...notes,
    };
  }
  if (tagStatus !== 'missing') {
    const tag = `v${latestVersion}`;
    return { source: 'tag', tarballUrl: tagArchiveUrl(tag, 'tar.gz'), zipballUrl: tagArchiveUrl(tag, 'zip') };
  }
  return { source: 'none' };
}

/**
 * Whether the upstream repository has the tag `v<version>`, from GitHub's refs API: 'missing' only
 * when GitHub answers that it has no such tag, 'unknown' when it cannot answer (unauthenticated,
 * the API allows 60 requests an hour per address, and a serverless host shares its address; or no
 * network). A monorepo is offered the tag's archive unless the tag is missing (resolveUpdateLinks).
 */
async function upstreamTagStatus(version: string): Promise<UpstreamTagStatus> {
  if (!LINKABLE_VERSION.test(version)) return 'missing';
  const tag = `v${version}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/git/ref/tags/${tag}`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 3600 },
    });
    if (res.status === 404) return 'missing';
    if (!res.ok) return 'unknown';
    // The single-ref endpoint matches exactly; reading the answer keeps a prefix match (what the
    // plural `git/refs` endpoint returns) from counting as the tag.
    const body = (await res.json()) as { ref?: unknown } | null;
    return body?.ref === `refs/tags/${tag}` ? 'exists' : 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * Determine the newest published NextBlock version. The npm registry is authoritative
 * (see NPM_REGISTRY_API); GitHub's latest release is the fallback, and its links are used only
 * when it is the version announced (resolveUpdateLinks).
 */
async function resolveLatestRelease(): Promise<{
  latestVersion: string | null;
  npmVersion: string | null;
  release: UpstreamRelease | null;
  error?: string;
}> {
  const [npmVersion, githubResult] = await Promise.all([
    fetchLatestFromNpm(),
    (async () => {
      try {
        const res = await fetch(RELEASES_API, {
          headers: githubHeaders(),
          signal: AbortSignal.timeout(15_000),
          next: { revalidate: 3600 },
        });
        if (res.status === 404) return { release: null }; // no releases cut yet
        if (!res.ok) return { release: null, error: `GitHub Releases API returned HTTP ${res.status}.` };
        return { release: await res.json() };
      } catch (caught) {
        return {
          release: null,
          error:
            caught instanceof Error
              ? `Could not reach the GitHub Releases API: ${caught.message}`
              : 'Could not reach the GitHub Releases API.',
        };
      }
    })(),
  ]);

  const tagVersion = releaseVersion(githubResult.release);
  // Whichever source is ahead wins: a hand-cut tag can lag npm, and npm can lag a
  // release that was published before the packages went out.
  const latestVersion =
    npmVersion && tagVersion
      ? compareSemver(npmVersion, tagVersion) >= 0
        ? npmVersion
        : tagVersion
      : (npmVersion ?? tagVersion);

  return {
    latestVersion,
    npmVersion,
    release: githubResult.release,
    // Only surface the GitHub error when npm did not answer either.
    error: latestVersion ? undefined : githubResult.error,
  };
}

/**
 * Resolve the newest published version and, on a standalone install that is behind,
 * record a runtime_update_available alert (deduped by latest version). Never throws.
 */
export async function checkForUpstreamUpdate(): Promise<UpstreamUpdateResult> {
  const currentVersion = readInstalledVersion();
  const track = detectTrack();
  const base: UpstreamUpdateResult = {
    ok: false,
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    track,
    alertRecorded: false,
  };

  const { latestVersion, npmVersion, release, error } = await resolveLatestRelease();
  if (error) return { ...base, error };
  if (!latestVersion) return { ...base, ok: true }; // nothing published yet

  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
  // Git-backed installs auto-merge via Track A — no runtime update alert for them.
  const recordsAlert = updateAvailable && track === 'standalone';
  const monorepo = isMonorepoInstall();
  // The alert is where these links are shown, so GitHub is asked about the tag (one more API
  // request) only when one may be recorded, the install is a monorepo (a flat project is never
  // offered a GitHub archive) and the latest release is not the announced version. Otherwise the
  // tag counts as unknown, which still links that version.
  const tagStatus: UpstreamTagStatus =
    recordsAlert && monorepo && releaseVersion(release) !== latestVersion
      ? await upstreamTagStatus(latestVersion)
      : 'unknown';
  const links = resolveUpdateLinks({ latestVersion, npmVersion, release, tagStatus, monorepo });

  const result: UpstreamUpdateResult = {
    ...base,
    ok: true,
    latestVersion,
    updateAvailable,
    htmlUrl: links.htmlUrl,
    tarballUrl: links.tarballUrl,
    zipballUrl: links.zipballUrl,
    publishedAt: links.publishedAt,
  };

  if (!recordsAlert) return result;

  try {
    const supabase = getServiceRoleSupabaseClient();
    // Deliberately NOT filtered on is_resolved: an admin who dismisses the banner for a
    // given version has answered for that version, and re-inserting it on the next
    // 6-hour poll would make the banner un-dismissable. A genuinely newer version
    // carries a different latest_version and still alerts.
    const { data: existing } = await supabase
      .from('system_alerts')
      .select('id, metadata')
      .eq('alert_type', 'runtime_update_available')
      .order('created_at', { ascending: false })
      .limit(50);

    const alreadyAlerted = (existing ?? []).some(
      (row) =>
        (row.metadata as { latest_version?: string } | null)?.latest_version === latestVersion,
    );
    if (alreadyAlerted) return result;

    const { error: insertError } = await supabase.from('system_alerts').insert({
      alert_type: 'runtime_update_available',
      title: `NextBlock ${latestVersion} is available`,
      message: `NextBlock ${latestVersion} is out — you are on ${currentVersion}. Run "npm run update" in your project to upgrade the code, dependencies and database schema in one step.`,
      metadata: {
        latest_version: latestVersion,
        current_version: currentVersion,
        update_command: 'npm run update',
        download_url: links.tarballUrl ?? null,
        zipball_url: links.zipballUrl ?? null,
        html_url: links.htmlUrl ?? null,
      },
    });
    if (insertError) {
      return { ...result, error: `Could not record the update alert: ${insertError.message}` };
    }
    return { ...result, alertRecorded: true };
  } catch (caught) {
    return {
      ...result,
      error:
        caught instanceof Error
          ? `Could not record the update alert: ${caught.message}`
          : 'Could not record the update alert.',
    };
  }
}

/**
 * Mirror Track-A sync conflicts (open GitHub issues labeled nextblock-sync-conflict in
 * THIS fork) into merge_conflict alerts, and resolve alerts whose issue has closed.
 * Returns a soft result (never throws) so the caller can surface errors without 500ing.
 */
export async function checkForSyncConflicts(): Promise<SyncConflictResult> {
  const self = resolveSelfRepo();
  const base: SyncConflictResult = {
    ok: false,
    repo: self ? `${self.owner}/${self.repo}` : null,
    openConflicts: 0,
    actionsActive: false,
    alertsWritten: 0,
    alertsResolved: 0,
  };
  if (!self) return { ...base, ok: true }; // not git-backed / repo unknown — nothing to mirror

  // 1) Open conflict issues. The /issues endpoint also returns PRs — filter them out.
  // Only an AUTHORITATIVE res.ok read may drive the resolve loop below: a 404 (private
  // fork without NEXTBLOCK_GITHUB_TOKEN, or a transient error) must NOT be read as "zero
  // open conflicts", or live conflict alerts would be wrongly auto-resolved and hidden.
  let issues: Array<{ number: number; html_url: string; body?: string | null; pull_request?: unknown }> =
    [];
  let issuesFetched = false;
  let fetchError: string | undefined;
  try {
    const url = `https://api.github.com/repos/${self.owner}/${self.repo}/issues?state=open&per_page=50`;
    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 600 },
    });
    if (res.ok) {
      issuesFetched = true;
      const data = await res.json();
      // Exclude PRs (the /issues endpoint returns them too) and keep only our marked issues.
      issues = (Array.isArray(data) ? data : [])
        .filter((i) => !i.pull_request)
        .filter((i) => typeof i.body === 'string' && i.body.includes(CONFLICT_MARKER));
    } else if (res.status === 404) {
      fetchError =
        'Could not read repository issues (HTTP 404). For a private fork, set NEXTBLOCK_GITHUB_TOKEN.';
    } else {
      fetchError = `GitHub issues API returned HTTP ${res.status}.`;
    }
  } catch (caught) {
    fetchError = caught instanceof Error ? caught.message : 'Could not reach the GitHub issues API.';
  }

  // 2) Is the sync workflow present AND enabled? (drives the onboarding "Actions" step)
  // We check the workflow's `state` rather than whether it has *run*: a healthy Vercel
  // deploy has Actions enabled by default, so the workflow is 'active' immediately — no
  // need to wait up to 24h for the first daily cron before the step completes.
  let actionsActive = false;
  try {
    const wfUrl = `https://api.github.com/repos/${self.owner}/${self.repo}/actions/workflows/nextblock-sync.yml`;
    const res = await fetch(wfUrl, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 600 },
    });
    if (res.ok) {
      const data = await res.json();
      actionsActive = data?.state === 'active';
    }
  } catch {
    /* best-effort */
  }

  // 3) Mirror issues <-> system_alerts.
  let alertsWritten = 0;
  let alertsResolved = 0;
  try {
    const supabase = getServiceRoleSupabaseClient();
    const { data: existing } = await supabase
      .from('system_alerts')
      .select('id, metadata')
      .eq('alert_type', 'merge_conflict')
      .eq('is_resolved', false)
      .limit(50);

    const alertByIssue = new Map<number, string>();
    for (const row of existing ?? []) {
      const issueNumber = (row.metadata as { issue_number?: number } | null)?.issue_number;
      if (typeof issueNumber === 'number') alertByIssue.set(issueNumber, row.id);
    }
    const openIssueNumbers = new Set(issues.map((i) => i.number));

    for (const issue of issues) {
      if (alertByIssue.has(issue.number)) continue;
      const { error } = await supabase.from('system_alerts').insert({
        alert_type: 'merge_conflict',
        title: 'Upstream sync needs manual resolution',
        message: `An automated upstream sync hit conflicts and could not merge. Resolve it on GitHub (issue #${issue.number}), then close the issue to clear this alert.`,
        metadata: {
          issue_number: issue.number,
          action_url: issue.html_url,
          repo: `${self.owner}/${self.repo}`,
        },
      });
      if (!error) alertsWritten += 1;
    }

    // Only resolve when the open-issue list is authoritative (res.ok). On a 404/error we
    // can't tell which issues are still open, so we leave existing alerts untouched.
    if (issuesFetched) {
      for (const [issueNumber, alertId] of alertByIssue) {
        if (openIssueNumbers.has(issueNumber)) continue;
        const { error } = await supabase
          .from('system_alerts')
          .update({ is_resolved: true, resolved_at: new Date().toISOString() })
          .eq('id', alertId);
        if (!error) alertsResolved += 1;
      }
    }
  } catch (caught) {
    return {
      ...base,
      actionsActive,
      openConflicts: issues.length,
      error: caught instanceof Error ? caught.message : 'Could not mirror conflict alerts.',
    };
  }

  return {
    ok: !fetchError,
    repo: `${self.owner}/${self.repo}`,
    openConflicts: issues.length,
    actionsActive,
    alertsWritten,
    alertsResolved,
    error: fetchError,
  };
}

export interface UpstreamStatusSnapshot {
  checked_at: string;
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  track: UpdateTrack;
  repo: string | null;
  open_conflicts: number;
  actions_active: boolean;
}

/** Run both checks and persist a status snapshot (read by the onboarding checklist). */
export async function refreshUpstreamStatus(): Promise<{
  update: UpstreamUpdateResult;
  conflicts: SyncConflictResult;
  snapshot: UpstreamStatusSnapshot | null;
}> {
  const update = await checkForUpstreamUpdate();
  const conflicts = await checkForSyncConflicts();

  let snapshot: UpstreamStatusSnapshot | null = null;
  try {
    const config = await getSystemConfiguration();
    snapshot = {
      checked_at: new Date().toISOString(),
      current_version: update.currentVersion,
      latest_version: update.latestVersion,
      update_available: update.updateAvailable,
      track: update.track,
      repo: conflicts.repo,
      open_conflicts: conflicts.openConflicts,
      actions_active: conflicts.actionsActive,
    };
    await setSystemConfigurationServiceRole({
      settings: { ...config.settings, upstream_status: snapshot },
    });
  } catch {
    /* best-effort — the alerts themselves are already written */
  }

  return { update, conflicts, snapshot };
}

/**
 * Mark the sync workflow as installed/active immediately after a successful Connect
 * install — so the onboarding step flips to done right away rather than waiting for the
 * next throttled poll (and GitHub's brief workflow-registration lag). Never throws.
 */
export async function markSyncWorkflowInstalled(): Promise<void> {
  try {
    const config = await getSystemConfiguration();
    const prev = config.settings?.['upstream_status'] as Partial<UpstreamStatusSnapshot> | undefined;
    const self = resolveSelfRepo();
    const snapshot: UpstreamStatusSnapshot = {
      checked_at: new Date().toISOString(),
      current_version: prev?.current_version ?? readInstalledVersion(),
      latest_version: prev?.latest_version ?? null,
      update_available: prev?.update_available ?? false,
      track: prev?.track ?? 'git',
      repo: self ? `${self.owner}/${self.repo}` : prev?.repo ?? null,
      open_conflicts: prev?.open_conflicts ?? 0,
      actions_active: true,
    };
    await setSystemConfigurationServiceRole({
      settings: { ...config.settings, upstream_status: snapshot },
    });
  } catch {
    /* best-effort */
  }
}

/** Throttled background refresh for the CMS layout's after() hook. Never throws. */
export async function maybeRefreshUpstreamStatus(): Promise<void> {
  try {
    const config = await getSystemConfiguration();
    const status = config.settings?.['upstream_status'] as { checked_at?: string } | undefined;
    const last = status?.checked_at ? Date.parse(status.checked_at) : 0;
    if (Number.isFinite(last) && Date.now() - last < REFRESH_INTERVAL_MS) return;
    await refreshUpstreamStatus();
  } catch {
    /* best-effort */
  }
}
