'use client';

import { useTranslations } from '@nextblock-cms/utils/translations-context';

export function ProfilePageMissingState() {
  const { t } = useTranslations();

  return <div>{t('profile_not_found')}</div>;
}
