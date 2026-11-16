/**
 * UI copy of the footer's "Cookie settings" control and of the consent banner once it is reopened,
 * read through useLabel(). The inline English and French are what a visitor reads until the keys are
 * seeded, so they must match migration 02042 word for word (ConsentSettings.test.tsx compares them).
 * `close` is the shared key 02015 seeded.
 */
export const CONSENT_SETTINGS_COPY = {
  cookieSettings: {
    key: 'privacy.consent.cookie_settings',
    en: 'Cookie settings',
    fr: 'Paramètres des témoins',
  },
  currentChoice: {
    key: 'privacy.consent.current_choice',
    en: 'Your current choice is shown below. You can change it at any time.',
    fr: 'Votre choix actuel est indiqué ci-dessous. Vous pouvez le modifier en tout temps.',
  },
  close: { key: 'close', en: 'Close', fr: 'Fermer' },
} as const;

/** The keys 02042 seeds (`close` was seeded by 02015). */
export const CONSENT_SETTINGS_SEEDED_BY_02042 = [
  CONSENT_SETTINGS_COPY.cookieSettings,
  CONSENT_SETTINGS_COPY.currentChoice,
] as const;
