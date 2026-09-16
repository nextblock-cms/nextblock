import { redirect } from 'next/navigation';

import { CORTEX_AI_PACKAGE_ID } from '@nextblock-cms/cortex';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';

import { resolveCortexWelcomeDestination } from '../../../lib/cortex-ai/setup-state';
import { getCortexSetupStatus } from '../../../lib/cortex-ai/setup-status';
import { requireAdminSupabaseClient } from '../settings/cortex-ai/require-admin';
import { CortexSetupWizard } from '../settings/cortex-ai/setup/CortexSetupWizard';
import { loadCortexSetupWizardProps } from '../settings/cortex-ai/setup/load-wizard-props';
import { CortexOfferStep } from './CortexOfferStep';

/**
 * The first page a brand-new administrator sees after /setup.
 *
 * /setup itself runs before any session exists, and buying or activating a package is
 * an admin-only server action, so the trial offer cannot be a step inside that wizard.
 * It is the next best thing: the same stepper, continued on the first signed-in
 * page, before the dashboard (and its sample content) is ever shown.
 *
 *   1. Cortex AI   — the trial offer as a full page. "Not now" is as prominent as the
 *                    trial button and goes straight to the dashboard.
 *   2–5. Connect, Photos, Brief, Build — the Cortex setup wizard, rendered here once the
 *                    package is active so the flow never breaks.
 *
 * Nothing forces this route: it is reached only by the post-setup sign-in redirect
 * and by the dashboard checklist's "Start free trial" link, so a returning admin is
 * never trapped here. Every state it cannot act on redirects onward.
 */
export default async function CmsWelcomePage() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    // Purchases are disabled in the shared sandbox, and its Cortex key lives per browser.
    redirect('/cms/dashboard');
  }

  try {
    await requireAdminSupabaseClient();
  } catch {
    redirect('/cms/dashboard');
  }

  const isCortexActive = await verifyPackageOnline(CORTEX_AI_PACKAGE_ID).catch(() => false);

  if (!isCortexActive) {
    return <CortexOfferStep pkg={NEXTBLOCK_PACKAGES['cortex-ai']} />;
  }

  const status = await getCortexSetupStatus();

  // Where an active Cortex lands. This page re-runs on the server every time the
  // client router re-fetches the current route while the wizard is mounted on it:
  // after a server action that revalidates a path (none of the wizard's do), but ALSO
  // after any server action that writes a cookie, which the Supabase session refresh
  // does from inside whichever action happens to run once the access token has aged.
  // So the decision must be stable across the wizard's own saves: storing the
  // OpenRouter key on step 1, or switching the MCP server on, must NOT change where
  // this page sends the operator. `resolveCortexWelcomeDestination` holds the table;
  // in short, only a finished or skipped wizard leaves this route.
  const destination = resolveCortexWelcomeDestination(status);

  if (destination === 'site-builder') {
    redirect('/cms/dashboard?cortex=site-builder');
  }

  if (destination === 'dashboard') {
    // Finished or skipped without a model key (an MCP-only install): nothing left to ask.
    redirect('/cms/dashboard');
  }

  // Every other state is the wizard, at whatever step the operator is on.

  const props = await loadCortexSetupWizardProps(status);

  return (
    <CortexSetupWizard
      {...props}
      heading={{
        description:
          'Your trial is active. Four quick steps and Cortex builds your site. Everything here can be changed later in settings.',
        title: 'Set up Cortex AI',
      }}
      intent="site-builder"
      precedingSteps={['Cortex AI']}
      skipHref="/cms/dashboard"
      skipLabel="Skip for now and open the dashboard"
    />
  );
}
