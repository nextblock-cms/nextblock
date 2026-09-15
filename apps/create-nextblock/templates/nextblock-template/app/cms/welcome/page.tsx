import { redirect } from 'next/navigation';

import { CORTEX_AI_PACKAGE_ID } from '@nextblock-cms/cortex';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';

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

  // Where an active Cortex lands. This page re-runs on the server every time a server
  // action revalidates a path while it is the current route (the Next client router
  // re-fetches the current route after such an action), so the decision must be
  // stable across the wizard's own saves: storing the OpenRouter key on step 1 flips
  // `hasModelKey` but must NOT change where this page sends the operator.
  //
  //   key source            wizard finished/skipped   MCP on   ->  destination
  //   (a) none              yes                       yes          dashboard          (!needsSetup, !ready)
  //   (b) stored            no                        any          wizard             (!ready, wizard shows the key + model picker)
  //   (c) env               any                       any          site builder       (ready: self-host, no wizard needed)
  //   (d) stored            yes                       any          site builder       (ready)
  //   (e) none              no                        no           wizard             (needsSetup)
  //   (f) none              yes                       no           dashboard          (skipped with "later": nothing left to ask)
  //   (g) none              no                        yes          dashboard          (!needsSetup: MCP-only install, chat has no key)
  //
  // Only (c) and (d) open the chat; (b) is the mid-wizard state the old `hasModelKey`
  // check got wrong. `readyForSiteBuilder` encodes (b)–(d); `needsSetup` separates (e)
  // from (a)/(f)/(g).
  if (status.readyForSiteBuilder) {
    redirect('/cms/dashboard?cortex=site-builder');
  }

  if (!status.needsSetup && !status.hasStoredOpenRouterKey) {
    // (a), (f), (g): MCP configured or the wizard already finished/skipped, and no key
    // waiting for the rest of the wizard: nothing left to ask.
    redirect('/cms/dashboard');
  }

  // (b) and (e): render the wizard.

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
