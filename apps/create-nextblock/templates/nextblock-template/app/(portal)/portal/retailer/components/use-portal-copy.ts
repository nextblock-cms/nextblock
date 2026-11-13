'use client';

import { useAffiliatesCopy } from '@nextblock-cms/affiliates';

import { PORTAL_UI_COPY, type PortalTranslate } from './portal-copy';
import type { PortalLocale } from './portal-types';

/** `t` (typed portal keys) and the copy language, from the portal layout's `AffiliatesCopyProvider`. */
export function usePortalCopy(): { t: PortalTranslate; locale: PortalLocale } {
  const { t, locale } = useAffiliatesCopy(PORTAL_UI_COPY);
  return { t, locale };
}
