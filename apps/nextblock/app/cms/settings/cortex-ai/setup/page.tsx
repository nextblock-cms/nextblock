import { redirect } from 'next/navigation';

import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { CORTEX_AI_PACKAGE_ID } from '@nextblock-cms/cortex';

import { getCortexSetupStatus } from '../../../../../lib/cortex-ai/setup-status';
import { requireAdminSupabaseClient } from '../require-admin';
import { CortexSetupWizard } from './CortexSetupWizard';
import { loadCortexSetupWizardProps } from './load-wizard-props';

type CortexSetupPageProps = {
  searchParams?: Promise<{ intent?: string }>;
};

/**
 * The Cortex AI first-run wizard.
 *
 * Four screens, one decision each: how to talk to Cortex (OpenRouter key for the
 * dashboard chat, or the MCP server for an external AI app), whether to add a free
 * stock-photo key, the site brief questionnaire (or leave it for the chat interview),
 * and the hand-off into the site builder. `?intent=site-builder`
 * is what every "Build my site" button links to: when the install is already
 * `readyForSiteBuilder` (an env key, or a stored key with the wizard finished or
 * skipped) the wizard is skipped entirely and the chat opens straight away.
 *
 * The redirect deliberately keys on `readyForSiteBuilder`, not `hasModelKey`: the
 * key is stored on step 1, and this route re-renders whenever a server action
 * revalidates it, so redirecting on `hasModelKey` would throw the operator into the
 * chat mid-wizard before the model, photos or "Start building" were chosen. A stored
 * key with the wizard unfinished renders the wizard with the key already connected.
 *
 * The post-install welcome flow (`/cms/welcome`) renders this same wizard as steps
 * 2–5 after the trial offer.
 */
export default async function CortexSetupPage({ searchParams }: CortexSetupPageProps) {
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  if (isSandbox) {
    // The sandbox keeps the visitor's key in their browser; the settings page handles that.
    redirect('/cms/settings/cortex-ai');
  }

  try {
    await requireAdminSupabaseClient();
  } catch {
    redirect('/cms/dashboard');
  }

  const isPackageActive = await verifyPackageOnline(CORTEX_AI_PACKAGE_ID).catch(() => false);

  if (!isPackageActive) {
    redirect('/cms/dashboard');
  }

  const params = searchParams ? await searchParams : {};
  const intent = params.intent === 'site-builder' ? 'site-builder' : null;
  const status = await getCortexSetupStatus();

  if (intent === 'site-builder' && status.readyForSiteBuilder) {
    redirect('/cms/dashboard?cortex=site-builder');
  }

  const props = await loadCortexSetupWizardProps(status);

  return <CortexSetupWizard {...props} intent={intent} />;
}
