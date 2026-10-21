import 'server-only';

// app/cms/settings/seo/page.tsx
import { hasResolvedSiteUrl, resolveSiteUrl } from '../../../../lib/site-url';
import { getRedirects, getRobotsSettings } from './actions';
import { requireAdminSupabaseClient } from './require-admin';
import { SeoSettingsClient } from './SeoSettingsClient';

/**
 * The SEO operations screen: which URLs moved, and what crawlers are allowed to do.
 *
 * ADMIN-only, and gated here as well as in every action and in RLS. The gate is
 * repeated rather than delegated because the three layers protect different things:
 * this one stops a WRITER from ever seeing the screen (a redirect list is a map of a
 * site's history, and the robots block is a map of what it is hiding), the actions
 * stop a hand-rolled request that never loaded the page, and RLS stops everything
 * else. `requireAdminSupabaseClient` throws, which is the right behaviour for a
 * Server Component: an unauthorised visitor gets the error boundary instead of a
 * half-rendered admin screen.
 *
 * The two reads run concurrently because they are independent — one hits
 * `cms_redirects`, the other one row of `site_settings` — and running them in series
 * would add a whole round trip to a screen that is already behind an auth check.
 */
export default async function SeoSettingsPage() {
  await requireAdminSupabaseClient();

  const [redirects, robotsSettings] = await Promise.all([getRedirects(), getRobotsSettings()]);

  // Resolved on the server, where the deployment's env actually lives, and handed to
  // the preview as data. The client component must never try to work this out for
  // itself: `NEXT_PUBLIC_URL` is inlined at build time and the Vercel fallbacks are
  // server-only, so a browser-side guess would quietly show a different sitemap URL
  // from the one crawlers are given.
  const siteUrl = resolveSiteUrl();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SeoSettingsClient
        initialRedirects={redirects}
        initialRobotsSettings={robotsSettings}
        isSandbox={process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'}
        isSiteUrlConfigured={hasResolvedSiteUrl()}
        sitemapUrl={`${siteUrl}/sitemap.xml`}
      />
    </div>
  );
}
