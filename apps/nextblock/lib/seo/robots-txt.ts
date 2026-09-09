/**
 * Renders the operator's stored robots settings into the two shapes the app needs:
 * the `MetadataRoute.Robots` object Next.js serialises for `app/robots.ts`, and the
 * literal robots.txt text the admin preview shows, because somebody has to be able to
 * read the file they are about to publish.
 *
 * Those two are not siblings, and that is the whole point of this module. The
 * metadata object is the single source of truth; the text is produced from it by
 * {@link renderRobotsMetadata}, a line-for-line port of the serialiser Next actually
 * runs — `resolveRobots` in
 * `next/dist/build/webpack/loaders/metadata/resolve-route-data`, which the route
 * module Next generates for a dynamic `robots.ts` calls as
 * `resolveRouteData(await handler(), 'robots')`. The preview is therefore the file,
 * byte for byte, and not a second opinion about it.
 *
 * It used to be a second opinion, and that was a bug worth recording. `buildRobotsTxt`
 * appended `settings.customRules` verbatim while `buildRobotsMetadata` could only
 * re-express the standard directives it managed to parse, so every other custom line
 * was shown to the operator as live and never reached a crawler. The wrong assumption
 * behind that split was that `MetadataRoute.Robots` has no escape hatch for arbitrary
 * lines. It has one: each rule's `other` record, which Next emits verbatim as
 * `key: value`. Custom lines now genuinely reach the served file, and the two kinds
 * that still cannot be represented — comments, and lines with no `:` at all, neither
 * of which any crawler acts on — are reported by {@link listUnservedCustomRuleLines}
 * so the SEO screen can say so, rather than being displayed as though they were live.
 *
 * Nothing here throws or reads the environment. Callers hand in `isSandbox` and the
 * sitemap URL, which keeps the module pure enough to test and — more usefully —
 * means the admin preview can render "what production would serve" rather than
 * "what this dev machine would serve".
 */

import type { MetadataRoute } from 'next';
import type { RobotsSettings } from '@nextblock-cms/utils/seo';

export interface RobotsTxtOptions {
  /**
   * True on a disposable sandbox deployment. This overrides every stored setting,
   * so it is passed in rather than read from `process.env` here — the admin preview
   * must be able to show the production answer, and the sandbox's demo admin login
   * must not be able to change what the sandbox serves.
   */
  isSandbox: boolean;
  /**
   * Absolute URL of the sitemap, or null when there is nothing to advertise. Still
   * subject to `settings.sitemapEnabled`: a null (or blank) URL means "we could not
   * build one", the setting means "the operator does not want one".
   */
  sitemapUrl: string | null;
}

/**
 * One entry of `MetadataRoute.Robots['rules']`, derived from Next's own type rather
 * than restated, so a future change to the metadata contract surfaces here as a
 * compile error instead of as a silently ignored field.
 */
type RobotsRuleList = Extract<MetadataRoute.Robots['rules'], readonly unknown[]>;
type RobotsRule = RobotsRuleList[number];

/**
 * The sandbox file, and the reasoning that has to travel with it.
 *
 * Sandbox is a copy of production, so it must stay out of the search index. The
 * counter-intuitive part is that we ALLOW crawling in order to achieve that. Every
 * sandbox response already carries `noindex` — the `X-Robots-Tag` header from
 * next.config.js plus the robots meta in app/layout.tsx — and Googlebot can only
 * obey a noindex it is allowed to fetch. `Disallow: /` would block the fetch, so
 * Google would never read the noindex and could leave URL-only entries in the index
 * forever: the exact opposite of what we want. The Sitemap line is omitted because
 * the sandbox sitemap is empty by design (see app/sitemap.ts).
 *
 * This branch ignores the stored settings wholesale, deliberately. A sandbox visitor
 * signs in with a shared demo admin account, and "the demo admin flipped indexing
 * off" must not be able to turn the sandbox into a permanently half-indexed ghost.
 */
const SANDBOX_USER_AGENT_RULE = { allow: ['/'], disallow: [], userAgent: '*' } as const;

/** The file served when an operator switches indexing off for the whole site. */
const INDEXING_DISABLED_USER_AGENT_RULE = { allow: [], disallow: ['/'], userAgent: '*' } as const;

/** What a site with no usable configuration gets: fully crawlable. */
const PERMISSIVE_USER_AGENT_RULE = { allow: ['/'], disallow: [], userAgent: '*' } as const;

interface ResolvedUserAgentRule {
  allow: string[];
  disallow: string[];
  userAgent: string;
}

/**
 * The single decision layer both serialisers run through.
 *
 * Returning the resolved groups rather than a formatted string is what makes the two
 * public functions incapable of disagreeing about who may crawl what: they differ
 * only in how they render this answer, never in what it is.
 */
function resolveUserAgentRules(
  settings: RobotsSettings,
  options: RobotsTxtOptions,
): ResolvedUserAgentRule[] {
  if (options.isSandbox) {
    return [{ ...SANDBOX_USER_AGENT_RULE, allow: [...SANDBOX_USER_AGENT_RULE.allow], disallow: [] }];
  }

  if (!settings.isIndexingEnabled) {
    return [
      {
        ...INDEXING_DISABLED_USER_AGENT_RULE,
        allow: [],
        disallow: [...INDEXING_DISABLED_USER_AGENT_RULE.disallow],
      },
    ];
  }

  const rules = settings.userAgentRules.map((rule) => ({
    allow: [...rule.allow],
    disallow: [...rule.disallow],
    userAgent: rule.userAgent,
  }));

  // A robots.txt with no User-agent group is not a stricter file, it is a
  // meaningless one, and crawlers disagree about how to read one — so a
  // configuration that reduced to nothing falls back to the permissive wildcard
  // rather than to an empty file.
  return rules.length > 0
    ? rules
    : [{ ...PERMISSIVE_USER_AGENT_RULE, allow: [...PERMISSIVE_USER_AGENT_RULE.allow], disallow: [] }];
}

/**
 * The operator's free-form lines, normalised for parsing.
 *
 * CRLF is folded to LF because the textarea these come from submits whatever line
 * endings the operator's browser produced, and a Windows-authored block would
 * otherwise put stray carriage returns into a file that is parsed line by line.
 * Surrounding whitespace is trimmed so a block that is nothing but blank lines
 * reduces to the empty string.
 */
function normalizeCustomRules(customRules: string): string {
  if (typeof customRules !== 'string') {
    return '';
  }

  return customRules.replace(/\r\n/g, '\n').trim();
}

/**
 * The sitemap line's URL, or null when there is nothing worth advertising.
 *
 * A whitespace-only URL is treated as absent rather than emitted, because
 * `Sitemap:` with a blank value is a line a crawler will try to fetch and fail on.
 */
function resolveSitemapUrl(settings: RobotsSettings, options: RobotsTxtOptions): string | null {
  if (options.isSandbox || !settings.isIndexingEnabled || !settings.sitemapEnabled) {
    return null;
  }

  const trimmed = (options.sitemapUrl ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** One custom-rules group while it is still being collected, before it becomes a rule. */
interface CustomRuleGroup {
  allow: string[];
  crawlDelay?: number;
  disallow: string[];
  /** Directive name (original casing) to the values typed under it, in order. */
  other: Record<string, string[]>;
  userAgents: string[];
}

interface ParsedCustomRules {
  rules: RobotsRule[];
  /**
   * Lines the served file cannot carry, in the order they were typed. Every one of
   * them is a line crawlers would ignore anyway — see {@link parseCustomRules} — but
   * they are surfaced rather than swallowed so the operator is never left looking for
   * a line that quietly disappeared.
   */
  unserved: string[];
}

/**
 * Turns the free-form custom-rules block into `MetadataRoute.Robots` rules.
 *
 * Standard directives become the typed fields Next understands; everything else rides
 * the per-rule `other` record, which Next's serialiser emits verbatim as
 * `key: value`, preserving the key's casing. That covers the non-standard directives
 * operators actually write — `Clean-param`, `Request-rate`, `Host`, an extra
 * `Sitemap` — none of which had any representation before.
 *
 * Two shapes still cannot be represented, and both are reported as unserved rather
 * than pretended away:
 *
 *   - comments, because every line Next emits is a `name: value` pair; and
 *   - lines with no `:` (or an empty name), which are not robots.txt syntax at all.
 *
 * Neither changes what a crawler does, so the served file loses no meaning — but the
 * preview must not show them, and the operator deserves to be told why they are gone.
 *
 * Note that `other` lines render after their group's Allow/Disallow/Crawl-delay
 * regardless of where the operator typed them. That reordering is harmless (robots.txt
 * groups are unordered sets of directives) and, more to the point, it is visible: the
 * preview is generated from these same rules, so what the operator reads is what
 * crawlers get.
 */
function parseCustomRules(customRules: string): ParsedCustomRules {
  const normalized = normalizeCustomRules(customRules);
  if (normalized === '') {
    return { rules: [], unserved: [] };
  }

  const groups: CustomRuleGroup[] = [];
  const unserved: string[] = [];

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }

    if (line.startsWith('#')) {
      unserved.push(line);
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      unserved.push(line);
      continue;
    }

    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name === '') {
      unserved.push(line);
      continue;
    }

    const directive = name.toLowerCase();
    let current = groups[groups.length - 1];

    if (directive === 'user-agent') {
      // A blank agent name would open a group that applies to nobody, silently
      // orphaning every directive typed under it, so it is rejected outright.
      if (value === '') {
        unserved.push(line);
        continue;
      }

      // Consecutive `User-agent:` lines share the rules that follow them, which is
      // standard robots.txt and something operators genuinely write. Only start a
      // new group once the previous one has actually collected a directive.
      if (current && isEmptyGroup(current)) {
        current.userAgents.push(value);
      } else {
        groups.push({ allow: [], disallow: [], other: {}, userAgents: [value] });
      }
      continue;
    }

    // A directive with no preceding `User-agent:` is malformed robots.txt, but the
    // operator's intent is unambiguous, so it is attributed to the wildcard agent
    // rather than discarded.
    if (!current) {
      current = { allow: [], disallow: [], other: {}, userAgents: ['*'] };
      groups.push(current);
    }

    if (directive === 'allow') {
      // An empty value is kept rather than skipped: `Disallow:` with nothing after it
      // is the specified way of saying "nothing is disallowed", and dropping it would
      // turn a meaningful line into a missing one.
      current.allow.push(value);
      continue;
    }

    if (directive === 'disallow') {
      current.disallow.push(value);
      continue;
    }

    if (directive === 'crawl-delay') {
      const delay = Number.parseFloat(value);
      // Next emits the typed `crawlDelay` field only when it is truthy, so a zero,
      // a second crawl-delay in the same group, or something unparseable would be
      // dropped from the served file. Those go through `other` instead, where they
      // are emitted verbatim — the operator's line survives either way.
      if (current.crawlDelay === undefined && Number.isFinite(delay) && delay > 0) {
        current.crawlDelay = delay;
      } else {
        pushOther(current, name, value);
      }
      continue;
    }

    pushOther(current, name, value);
  }

  return { rules: groups.map(toCustomRule), unserved };
}

/** True while a group has collected nothing but `User-agent:` lines. */
function isEmptyGroup(group: CustomRuleGroup): boolean {
  return (
    group.allow.length === 0 &&
    group.disallow.length === 0 &&
    group.crawlDelay === undefined &&
    Object.keys(group.other).length === 0
  );
}

/**
 * Records a non-standard directive. Repeats accumulate into an array because Next
 * emits one line per array entry, which is the only way a group can carry the same
 * directive name twice.
 */
function pushOther(group: CustomRuleGroup, name: string, value: string): void {
  const existing = group.other[name];
  if (existing) {
    existing.push(value);
  } else {
    group.other[name] = [value];
  }
}

function toCustomRule(group: CustomRuleGroup): RobotsRule {
  const rule: RobotsRule = {
    userAgent: group.userAgents.length === 1 ? group.userAgents[0] : group.userAgents,
  };

  if (group.allow.length > 0) {
    rule.allow = group.allow;
  }
  if (group.disallow.length > 0) {
    rule.disallow = group.disallow;
  }
  if (group.crawlDelay !== undefined) {
    rule.crawlDelay = group.crawlDelay;
  }

  const otherKeys = Object.keys(group.other);
  if (otherKeys.length > 0) {
    const other: Record<string, string | string[]> = {};
    for (const key of otherKeys) {
      const values = group.other[key];
      other[key] = values.length === 1 ? values[0] : values;
    }
    (rule as any).other = other;
  }

  return rule;
}

/**
 * The `MetadataRoute.Robots` object served at /robots.txt by `app/robots.ts`, and the
 * object {@link buildRobotsTxt} renders for the admin preview.
 *
 * Empty `allow` / `disallow` arrays are omitted rather than passed through: Next
 * renders each entry as its own line, so an empty array contributes nothing while
 * still occupying a field, and leaving it out keeps the emitted object honest about
 * what the operator actually configured.
 */
export function buildRobotsMetadata(
  settings: RobotsSettings,
  options: RobotsTxtOptions,
): MetadataRoute.Robots {
  const rules: RobotsRule[] = resolveUserAgentRules(settings, options).map((rule) => {
    const metadataRule: RobotsRule = { userAgent: rule.userAgent };
    if (rule.allow.length > 0) {
      metadataRule.allow = rule.allow;
    }
    if (rule.disallow.length > 0) {
      metadataRule.disallow = rule.disallow;
    }
    // A group consisting of nothing but its `User-agent:` header is malformed, and
    // some parsers discard the groups that follow it. An empty `Disallow` value is
    // the specified way to say "nothing is disallowed", so that is what an otherwise
    // empty group carries.
    if (rule.allow.length === 0 && rule.disallow.length === 0) {
      metadataRule.disallow = [''];
    }
    return metadataRule;
  });

  // Custom rules survive an indexing-off switch, because they are how an operator
  // carves out the exceptions that must keep working regardless (a `.well-known`
  // path, a verification file). They do NOT survive the sandbox, for the reason
  // recorded on SANDBOX_USER_AGENT_RULE.
  if (!options.isSandbox) {
    rules.push(...parseCustomRules(settings.customRules).rules);
  }

  const result: MetadataRoute.Robots = { rules };

  const sitemapUrl = resolveSitemapUrl(settings, options);
  if (sitemapUrl) {
    result.sitemap = sitemapUrl;
  }

  return result;
}

/**
 * The literal robots.txt text for a settings object — what the admin preview shows.
 *
 * This is {@link buildRobotsMetadata} put through {@link renderRobotsMetadata}, which
 * is what makes the preview incapable of disagreeing with the served file: there is
 * one object, one renderer, and the renderer is Next's own algorithm. The route
 * itself still returns the metadata object rather than this string, so caching,
 * revalidation and content type are handled exactly the way they are for the sitemap.
 */
export function buildRobotsTxt(settings: RobotsSettings, options: RobotsTxtOptions): string {
  return renderRobotsMetadata(buildRobotsMetadata(settings, options));
}

/**
 * The custom-rules lines that will not appear in the served file, so the SEO screen
 * can tell the operator instead of leaving them to notice the absence.
 *
 * In the sandbox that is the entire block: the sandbox answer ignores stored settings
 * wholesale (see SANDBOX_USER_AGENT_RULE), so every custom line is inert there.
 */
export function listUnservedCustomRuleLines(
  settings: RobotsSettings,
  options: RobotsTxtOptions,
): string[] {
  const normalized = normalizeCustomRules(settings.customRules);

  if (options.isSandbox) {
    return normalized === ''
      ? []
      : normalized
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
  }

  return parseCustomRules(normalized).unserved;
}

/**
 * Serialises a `MetadataRoute.Robots` object exactly as Next.js does.
 *
 * This is a deliberate port of `resolveRobots` in
 * `next/dist/build/webpack/loaders/metadata/resolve-route-data`, down to the
 * capitalised `User-Agent:`, the blank line after every group including the last, and
 * the order of fields within a group. It exists so the admin preview can be the
 * served bytes rather than an approximation of them; the colocated test asserts the
 * two agree by importing Next's serialiser directly, so a change to Next's rendering
 * fails a test here instead of silently turning the preview back into a lie.
 */
export function renderRobotsMetadata(metadata: MetadataRoute.Robots): string {
  let content = '';

  const rules = Array.isArray(metadata.rules) ? metadata.rules : [metadata.rules];

  for (const rule of rules) {
    for (const agent of toArray(rule.userAgent || ['*'])) {
      content += `User-Agent: ${agent}\n`;
    }

    if (rule.allow) {
      for (const item of toArray(rule.allow)) {
        content += `Allow: ${item}\n`;
      }
    }

    if (rule.disallow) {
      for (const item of toArray(rule.disallow)) {
        content += `Disallow: ${item}\n`;
      }
    }

    if (rule.crawlDelay) {
      content += `Crawl-delay: ${rule.crawlDelay}\n`;
    }

    const ruleOther = (rule as any).other;
    if (ruleOther) {
      for (const key of Object.keys(ruleOther)) {
        const value = ruleOther[key];
        if (value === null || value === undefined) {
          continue;
        }
        for (const entry of toArray(value)) {
          content += `${key}: ${entry}\n`;
        }
      }
    }

    content += '\n';
  }

  if (metadata.host) {
    content += `Host: ${metadata.host}\n`;
  }

  if (metadata.sitemap) {
    for (const item of toArray(metadata.sitemap)) {
      content += `Sitemap: ${item}\n`;
    }
  }

  return content;
}

/** Next's `resolveArray`: a bare value becomes a one-element list, a list is left alone. */
function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
