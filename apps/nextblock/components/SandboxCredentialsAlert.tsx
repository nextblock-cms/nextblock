'use client';

import Link from 'next/link';
import { Info } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils';
import { useLabel } from '../lib/i18n/use-label';

/**
 * The sandbox's demo partner, seeded by the reset cron (app/api/cron/reset-sandbox/affiliate-demo.ts)
 * when the Affiliates package is active there. Literals on purpose: that module is server-only.
 */
const DEMO_PARTNER_EMAIL = 'partner@nextblock.dev';
const DEMO_PARTNER_STOREFRONT_PATH = '/partners/studio-nova';

const CREDENTIALS_LIST_CLASS =
  'space-y-1 font-mono text-xs bg-white/50 dark:bg-black/20 p-2 rounded border border-blue-100 dark:border-blue-900/50';

export interface SandboxCredentialsAlertProps {
  /**
   * List the demo partner account and link its storefront. Pass true only while the Affiliates
   * package is active on the sandbox (`shouldShowSandboxDemoPartner()`): the reset cron seeds that
   * partner only then, and the storefront 404s otherwise.
   */
  showDemoPartner?: boolean;
}

export function SandboxCredentialsAlert({ showDemoPartner = false }: SandboxCredentialsAlertProps = {}) {
  const { t } = useTranslations();
  // Global keys (not affiliates.*): /sign-in and /sign-up only get the root translations payload.
  const label = useLabel();

  // Only show in sandbox mode
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    return null;
  }

  return (
    <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-6 flex items-start gap-3 text-sm">
      <Info aria-hidden="true" className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
      <div className="text-blue-900 dark:text-blue-100">
        <p className="font-semibold mb-1">{t('demo_access_title')}</p>
        <p className="mb-2">
          {t('demo_access_desc')}
        </p>
        <ul className={CREDENTIALS_LIST_CLASS}>
          {/* translate="no": browser auto-translate would rewrite the literal "password". */}
          <li>{t('demo_user_label')} <span translate="no" className="font-bold select-all">demo@nextblock.dev</span></li>
          <li>{t('demo_password_label')} <span translate="no" className="font-bold select-all">password</span></li>
        </ul>
        {showDemoPartner ? (
          <>
            <p className="mt-3 mb-2">
              {label(
                'demo_partner_access_desc',
                'To explore the partner portal, sign in with the demo partner account:',
                'Pour explorer le portail partenaire, connectez-vous avec le compte partenaire de démonstration :'
              )}
            </p>
            <ul className={CREDENTIALS_LIST_CLASS}>
              <li>{t('demo_user_label')} <span translate="no" className="font-bold select-all">{DEMO_PARTNER_EMAIL}</span></li>
              <li>{t('demo_password_label')} <span translate="no" className="font-bold select-all">password</span></li>
            </ul>
            <p className="mt-2">
              {/* No prefetch on storefront links (the referral cookie only follows real navigations). */}
              <Link
                href={DEMO_PARTNER_STOREFRONT_PATH}
                prefetch={false}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                {label(
                  'demo_partner_storefront_link',
                  "View the demo partner's public storefront",
                  'Voir la vitrine publique du partenaire de démonstration'
                )}
              </Link>
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
