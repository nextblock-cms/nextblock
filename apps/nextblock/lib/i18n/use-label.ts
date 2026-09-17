'use client';

import { useTranslations } from '@nextblock-cms/utils';

type LabelValues = Record<string, string | number>;

function interpolate(template: string, values?: LabelValues) {
  if (!values) return template;

  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template
  );
}

/**
 * UI copy with built-in English and French fallbacks.
 *
 * `t()` answers an unseeded key with the key itself, so `t('x') || 'Fallback'` never falls
 * back and visitors read the raw key. Every key used through this hook is seeded by
 * migration 02015; the inline copy covers installs whose database predates it. Only the
 * public site needs this: `/cms` is English-only.
 */
export function useLabel() {
  const { lang, t } = useTranslations();

  return (key: string, en: string, fr: string, values?: LabelValues) => {
    const translated = t(key, values);
    if (translated !== key) return translated;

    return interpolate(lang.toLowerCase().startsWith('fr') ? fr : en, values);
  };
}
