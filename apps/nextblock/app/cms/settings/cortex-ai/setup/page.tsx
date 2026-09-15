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
 * Three screens, one decision each: how to talk to Cortex (OpenRouter key for the
 * dashboard chat, or the MCP server for an external AI app), whether to add a free
 * stock-photo key, and the hand-off into the site builder. `?intent=site-builder`
 * is what every "Build my site" button links to: when a model key already exists the
 * wizard is skipped entirely and the chat opens straight away.
 *
 * The post-install welcome flow (`/cms/welcome`) renders this same wizard as steps
 * 2–4 after the trial offer.
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

  if (intent === 'site-builder' && status.hasModelKey) {
    redirect('/cms/dashboard?cortex=site-builder');
  }

  const props = await loadCortexSetupWizardProps(status);

  return <CortexSetupWizard {...props} intent={intent} />;
}
