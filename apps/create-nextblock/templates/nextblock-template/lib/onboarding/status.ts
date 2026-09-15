import 'server-only';
// Derives the dashboard onboarding checklist live from configuration state. Every check
// reads public/service-role data only, so it works for both ADMIN and WRITER dashboards.
import { createClient } from '@nextblock-cms/db/server';
import { getStoreConfigStatus } from '@nextblock-cms/ecommerce/server';
import { NEXTBLOCK_PACKAGES, describePackageOffer } from '@nextblock-cms/utils';
import { getEmailPublicSettings } from '../config/email-settings';
import { getPrivacySettings } from '../privacy/settings';
import { getSystemConfiguration } from '../setup/system-config';
import { selfActionsSettingsUrl } from '../updates/repo-identity';
import { isMonorepoInstall } from '../updates/check-upstream';
import { isGithubConnectAvailable } from '../updates/github-device';

export type OnboardingStep = {
  key: string;
  title: string;
  description: string;
  href: string;
  done: boolean;
  optional: boolean;
  /** When true, render the CTA as an external link (new tab) instead of an in-app route. */
  isExternal?: boolean;
  /** When true, render the device-flow "Connect GitHub" control instead of a link. */
  connectGithub?: boolean;
  /** When true, render the "Build with Cortex" control that opens the site-builder chat. */
  openSiteBuilder?: boolean;
  /** Label for the CTA button; defaults to "Set up". */
  ctaLabel?: string;
  /** When true, the step is informational for this user: no CTA is rendered. */
  ctaHidden?: boolean;
};

export type OnboardingStatus = {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  dismissed: boolean;
  /** The viewer holds the ADMIN role (package purchases and activation are admin-only). */
  viewerIsAdmin: boolean;
  /**
   * Package the viewer can start a trial of from the dashboard right now (Cortex AI
   * when it is inactive and the viewer is an admin), independent of checklist state —
   * the ?cortex=site-builder deep link relies on it even when the checklist is dismissed.
   */
  trialOfferPackageId: 'cortex-ai' | null;
};

// Seeded defaults (libs/db baseline seed 00000000000003 + migration 00000000000004). The
// branding/copyright steps count as "done" only when the value has been customized away from
// these — a fresh install ships with the seeds, so a plain presence check would mark every
// step complete immediately.
const SEEDED_SITE_TITLE = 'NextBlock™ CMS';
// Every object_key a fresh install may ship as the DEFAULT logo — the original baseline WebP
// and the migration-00000000000004 email-safe PNG (which repoints the seeded default). A logo
// counts as customized only when it is none of these; a new default swap must be added here or
// branding falsely reads as done out of the box. Mirrors BUNDLED_PUBLIC_MEDIA_KEYS in
// lib/media/resolveMediaUrl.ts.
const SEEDED_LOGO_OBJECT_KEYS = new Set<string>([
  'images/nextblock-logo-small.webp',
  'images/nextblock-logo-button-tiny.png',
]);
const SEEDED_COPYRIGHT: Record<string, string> = {
  en: '© {year} Nextblock CMS. All rights reserved.',
  fr: '© {year} Nextblock CMS. Tous droits réservés.',
};

/** True when at least one language's copyright text is set AND differs from the seed. */
function hasCustomCopyright(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([lang, v]) => {
    if (typeof v !== 'string') return false;
    const trimmed = v.trim();
    return trimmed.length > 0 && trimmed !== (SEEDED_COPYRIGHT[lang] ?? '');
  });
}

/** Pull the active logo's media object_key from the (to-one) embedded relation. */
function extractLogoObjectKey(logoRow: unknown): string | null {
  if (!logoRow || typeof logoRow !== 'object') return null;
  const media = (logoRow as { media?: unknown }).media;
  const record = Array.isArray(media) ? media[0] : media;
  if (!record || typeof record !== 'object') return null;
  const key = (record as { object_key?: unknown }).object_key;
  return typeof key === 'string' ? key : null;
}

export async function getOnboardingStatus(opts: {
  isCortexAiActive?: boolean;
  isEcommerceActive: boolean;
}): Promise<OnboardingStatus> {
  const supabase = createClient();

  // Buying or activating a package is an ADMIN action (the packages page and the server
  // actions both enforce it), so writers see the Cortex step without a purchase button.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: viewerProfile } = user
    ? await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    : { data: null };
  const viewerIsAdmin = viewerProfile?.role === 'ADMIN';

  const [{ data: settingRows }, { data: logoRow }, emailPublic, privacy] = await Promise.all([
    supabase
      .from('site_settings')
      .select('key, value')
      .in('key', [
        'footer_copyright',
        'bot_protection_public',
        'cortex_ai_site_brief',
        'onboarding_state',
        'site_title',
      ]),
    supabase
      .from('logos')
      .select('media:media_id(object_key)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    getEmailPublicSettings(),
    getPrivacySettings(),
  ]);

  const rows = new Map((settingRows ?? []).map((r) => [r.key, r.value]));
  const botPublic = (rows.get('bot_protection_public') ?? {}) as Record<string, unknown>;
  const onboardingState = (rows.get('onboarding_state') ?? {}) as Record<string, unknown>;

  const siteTitleRaw = rows.get('site_title');
  const siteTitle = typeof siteTitleRaw === 'string' ? siteTitleRaw.trim() : '';
  const siteTitleCustomized = siteTitle.length > 0 && siteTitle !== SEEDED_SITE_TITLE;
  const logoObjectKey = extractLogoObjectKey(logoRow);
  const logoCustomized = Boolean(logoObjectKey) && !SEEDED_LOGO_OBJECT_KEYS.has(logoObjectKey ?? '');

  // Branding is "done" once the user renames the site or uploads their own logo — not merely
  // because the seeded NextBlock title/logo exist.
  const brandingDone = siteTitleCustomized || logoCustomized;
  const copyrightDone = hasCustomCopyright(rows.get('footer_copyright'));
  const emailDone = Boolean(emailPublic.host) || Boolean(process.env['SMTP_HOST']);
  const analyticsDone = Boolean(privacy.gtm_id);
  const botProvider = typeof botPublic['provider'] === 'string' ? (botPublic['provider'] as string) : 'none';
  const botDone = botProvider !== 'none' && botProvider !== '';

  // The Cortex site build counts as done once a build finished (brief status "built");
  // a customized site title is the fallback signal for sites set up by hand.
  const siteBrief = rows.get('cortex_ai_site_brief');
  const siteBriefBuilt =
    Boolean(siteBrief) &&
    typeof siteBrief === 'object' &&
    (siteBrief as { status?: unknown }).status === 'built';
  const siteBuildDone = siteBriefBuilt || siteTitleCustomized;

  const steps: OnboardingStep[] = [
    {
      key: 'admin',
      title: 'Create your admin account',
      description: 'Your administrator account is set up.',
      href: '/cms/users',
      done: true,
      optional: false,
    },
    opts.isCortexAiActive
      ? {
          key: 'cortex-site-builder',
          title: 'Build your site with Cortex AI',
          description: `Answer a few questions in the chat and Cortex replaces the NextBlock sample content with your own pages, menus, and branding. A single landing page is fine too.${
            viewerIsAdmin ? '' : ' An administrator runs the site builder from their dashboard.'
          }`,
          href: '/cms/dashboard?cortex=site-builder',
          done: siteBuildDone,
          optional: false,
          // The Cortex chat that receives the "Start" event mounts for admins only.
          ...(viewerIsAdmin ? { openSiteBuilder: true, ctaLabel: 'Start' } : { ctaHidden: true }),
        }
      : {
          key: 'cortex-site-builder',
          title: 'Build your site with Cortex AI',
          description: `${describePackageOffer(NEXTBLOCK_PACKAGES['cortex-ai']).summary} Cortex interviews you about your business and replaces the sample content with your own pages, menus, and branding. A single landing page is fine too.${
            viewerIsAdmin ? '' : ' Ask an administrator to start the trial from Settings → Packages.'
          }`,
          // The welcome flow: trial offer as a page, then the Cortex setup wizard.
          href: '/cms/welcome',
          done: siteBuildDone,
          optional: true,
          ...(viewerIsAdmin ? { ctaLabel: 'Start free trial' } : { ctaHidden: true }),
        },
    {
      key: 'branding',
      title: 'Add your branding',
      description: 'Upload your logo and set your site identity.',
      href: '/cms/settings/logos',
      done: brandingDone,
      optional: false,
    },
    {
      key: 'copyright',
      title: 'Set your copyright / footer',
      description: 'Configure the footer copyright shown across your site.',
      href: '/cms/settings/copyright',
      done: copyrightDone,
      optional: false,
    },
    {
      key: 'email',
      title: 'Configure email (SMTP)',
      description: 'Enable verification emails, password resets, and notifications.',
      href: '/cms/settings/email',
      done: emailDone,
      optional: false,
    },
    {
      key: 'analytics',
      title: 'Connect analytics',
      description: 'Add a Google Tag Manager ID for consent-gated analytics.',
      href: '/cms/settings/google-analytics',
      done: analyticsDone,
      optional: true,
    },
    {
      key: 'bot',
      title: 'Enable bot protection',
      description: 'Protect your sign-up and sign-in forms with a CAPTCHA.',
      href: '/cms/settings/bot-protection',
      done: botDone,
      optional: true,
    },
  ];

  if (opts.isEcommerceActive) {
    let paymentsDone = false;
    try {
      const storeStatus = await getStoreConfigStatus();
      paymentsDone = storeStatus.stripe.hasKeys || storeStatus.freemius.hasKeys;
    } catch {
      paymentsDone = false;
    }
    // Insert Payments before the optional steps.
    steps.splice(4, 0, {
      key: 'payments',
      title: 'Set up payment providers',
      description: 'Add your Stripe and/or Freemius API keys to accept payments.',
      href: '/cms/payments',
      done: paymentsDone,
      optional: false,
    });
  }

  // Monorepo-shaped installs (Vercel 1-click, GitHub fork, clone): remind the operator to
  // enable GitHub Actions so the upstream sync workflow can run. "done" flips once the
  // background poll (maybeRefreshUpstreamStatus) has seen the workflow registered.
  //
  // Gated on the LAYOUT, not on the host. This step's Connect GitHub button installs a
  // workflow that merges the NextBlock monorepo into the repository; offering it to a
  // flattened standalone project — which the previous "is this Vercel?" gate did for every
  // standalone app deployed on Vercel — would merge apps/ + libs/ + nx.json into a tree
  // that has none of them. Standalone installs update with `npm run update` instead.
  if (isMonorepoInstall()) {
    let actionsActive = false;
    try {
      const config = await getSystemConfiguration();
      const upstream = config.settings?.['upstream_status'] as
        | { actions_active?: boolean }
        | undefined;
      actionsActive = upstream?.actions_active === true;
    } catch {
      actionsActive = false;
    }
    const canConnect = !actionsActive && isGithubConnectAvailable();
    steps.push({
      key: 'github-actions',
      title: 'Automatic updates (GitHub Actions)',
      description: actionsActive
        ? 'The daily upstream-sync workflow is active for your repository.'
        : canConnect
          ? 'Connect GitHub to install the upstream-sync workflow into your repo — Vercel’s 1-click deploy can’t copy it automatically.'
          : 'Vercel deploys have GitHub Actions on by default — this completes once GitHub registers the sync workflow on your default branch. A manually forked repo needs Actions enabled under Settings → Actions.',
      href:
        selfActionsSettingsUrl() ??
        'https://github.com/nextblock-cms/nextblock/blob/HEAD/docs/13-STAYING-UP-TO-DATE.md',
      done: actionsActive,
      optional: true,
      isExternal: true,
      connectGithub: canConnect,
    });
  }

  const completed = steps.filter((s) => s.done).length;

  return {
    steps,
    completed,
    total: steps.length,
    dismissed: onboardingState['dismissed'] === true,
    viewerIsAdmin,
    trialOfferPackageId: !opts.isCortexAiActive && viewerIsAdmin ? 'cortex-ai' : null,
  };
}
