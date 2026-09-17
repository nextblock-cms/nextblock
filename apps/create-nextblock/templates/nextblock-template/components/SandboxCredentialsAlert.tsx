'use client';

import { Info } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils';

export function SandboxCredentialsAlert() {
  const { t } = useTranslations();

  // Only show in sandbox mode
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    return null;
  }

  return (
    <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-6 flex items-start gap-3 text-sm">
      <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
      <div className="text-blue-900 dark:text-blue-100">
        <p className="font-semibold mb-1">{t('demo_access_title')}</p>
        <p className="mb-2">
          {t('demo_access_desc')}
        </p>
        <ul className="space-y-1 font-mono text-xs bg-white/50 dark:bg-black/20 p-2 rounded border border-blue-100 dark:border-blue-900/50">
          {/* translate="no": browser auto-translate would rewrite the literal "password". */}
          <li>{t('demo_user_label')} <span translate="no" className="font-bold select-all">demo@nextblock.dev</span></li>
          <li>{t('demo_password_label')} <span translate="no" className="font-bold select-all">password</span></li>
        </ul>
      </div>
    </div>
  );
}
