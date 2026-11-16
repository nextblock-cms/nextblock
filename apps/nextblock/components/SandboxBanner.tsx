'use client';

import { TriangleAlert } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils/translations-context';

export function SandboxBanner() {
  const { t } = useTranslations();
  
  return (
    <div className="w-full z-[100] bg-amber-500 text-amber-950 px-4 py-2 text-center text-sm font-medium shadow-md flex items-center justify-center gap-2">
      <TriangleAlert className="w-4 h-4" />
      <span>
        {t('sandbox_mode_banner')}
      </span>
    </div>
  );
}
