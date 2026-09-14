import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { normalizeRobotsSettings, type RobotsSettings } from '@nextblock-cms/utils/seo';
import { buildRobotsTxt } from '../../lib/seo/robots-txt';
import { hasResolvedSiteUrl, resolveSiteUrl } from '../../lib/site-url';

/**
 * /robots.txt, generated from the operator's stored settings.
 *
 * This is a route handler rather than an `app/robots.ts` metadata route on purpose.
 * The metadata route hands a `MetadataRoute.Robots` object to Next's own serialiser,
 * and that serialiser (`resolveRobots`, Next 16.2) knows only `User-Agent`, `Allow`,
 * `Disallow`, `Crawl-delay`, `Host` and `Sitemap`. Every non-standard directive an
 * operator types into the SEO screen — `Clean-param`, `Request-rate`, a per-group
 * `Host` — was rendered in the CMS preview and then silently dropped from the served
 * file, which is exactly the "preview that lies" the SEO screen exists to prevent.
 *
 * Serving `buildRobotsTxt` directly makes the preview the served bytes by
 * construction: same settings, same renderer (`renderRobotsMetadata`, Next's algorithm
 * plus the `other` escape hatch). The two files cannot coexist — Next rewrites
 * `app/robots.ts` to this very path — so `app/robots.ts` was removed in the same change.
 * The externally visible path is unchanged; `isSetupAllowlisted()` in proxy.ts still
 * allowlists the literal '/robots.txt'.
 *
 * Caching matches what the metadata route had: the response is static, rebuilt at
 * most hourly, and `revalidateRobotsFile()` in cms/settings/seo/actions.ts evicts it
 * by path the moment an operator saves. `force-static` is explicit because a GET
 * route handler is dynamic by default and nothing here reads request data.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

/**
 * The `site_settings` row the SEO screen writes, seeded by migration 30 and moved into
 * the ADMIN-only write group by migration 31 — a WRITER could otherwise have PATCHed
 * this row through PostgREST and de-indexed the whole site, since RLS, not the server
 * action, is the boundary that actually holds.
 */
const ROBOTS_SETTINGS_KEY = 'seo_robots_settings';

/**
 * Reads the stored robots configuration, falling back to the permissive defaults on
 * any failure whatsoever.
 *
 * The anon client is the right one here, and deliberately so: `seo_robots_settings`
 * is a non-secret key and `site_settings`' read policy is already public for
 * non-secret keys, so nothing on this path needs the service role. Handing a
 * service-role client to a route that anonymous crawlers hit would be a needless
 * escalation.
 *
 * The failure handling matters more than it looks. A crawler that receives a 500 for
 * robots.txt may treat the entire site as disallowed until it next succeeds, so an
 * unreachable database — or an install that has not yet run `npm run db:migrate`,
 * where this settings row does not exist — must produce a valid, permissive file
 * rather than an error. `normalizeRobotsSettings` handles the other half of that:
 * whatever jsonb hands back, including null, a string or a half-migrated object,
 * becomes a complete `RobotsSettings`.
 */
async function loadRobotsSettings(): Promise<RobotsSettings> {
  try {
    const supabase = getSsgSupabaseClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', ROBOTS_SETTINGS_KEY)
      .maybeSingle();

    if (error) {
      console.error('robots.txt: failed to read the robots settings; serving defaults.', error);
      return normalizeRobotsSettings(undefined);
    }

    // A missing row is not an error — it is a site whose operator has never opened
    // the SEO screen — and the defaults are exactly what that site should serve.
    return normalizeRobotsSettings(data?.value);
  } catch (error) {
    console.error('robots.txt: robots settings lookup threw; serving defaults.', error);
    return normalizeRobotsSettings(undefined);
  }
}

async function renderRobotsFile(): Promise<string> {
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  // The sandbox answer ignores every stored setting, so there is nothing to read.
  // Skipping the query keeps a disposable deployment's robots.txt working even when
  // its database is asleep or being reset by the cron job. Why the sandbox ALLOWS
  // crawling is written down on SANDBOX_USER_AGENT_RULE in lib/seo/robots-txt.ts.
  if (isSandbox) {
    return buildRobotsTxt(normalizeRobotsSettings(undefined), {
      isSandbox: true,
      sitemapUrl: null,
    });
  }

  // Explicit NEXT_PUBLIC_URL → Vercel production URL → local-dev fallback.
  const siteUrl = resolveSiteUrl();

  if (!hasResolvedSiteUrl()) {
    console.warn(
      'Warning: no site URL is set for robots.txt (NEXT_PUBLIC_URL / Vercel production URL). Defaulting to http://localhost:3000. Set NEXT_PUBLIC_URL for production.'
    );
  }

  const settings = await loadRobotsSettings();

  return buildRobotsTxt(settings, {
    isSandbox: false,
    sitemapUrl: `${siteUrl}/sitemap.xml`,
  });
}

export async function GET(): Promise<Response> {
  const body = await renderRobotsFile();

  return new Response(body, {
    status: 200,
    headers: {
      // The same content type and cache header Next's metadata route loader emits.
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
