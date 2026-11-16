'use client';

import { useTranslations } from '@nextblock-cms/utils/translations-context';

export function ProfilePageHeader() {
  const { t } = useTranslations();

  return (
    <div className="mb-8">
      <h1 className="text-3xl font-bold tracking-tight">{t('profile_settings_title')}</h1>
      <p className="text-muted-foreground mt-2">
        {t('profile_settings_description')}
      </p>
    </div>
  );
}
