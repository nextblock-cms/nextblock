import type { AffiliatesCopyDictionary } from '../types';

/**
 * Copy that only the public sandbox renders (`NEXT_PUBLIC_IS_SANDBOX=true`): its demo logins are
 * public and its database resets every 15 minutes, so the partner signup there runs every check and
 * writes nothing, and every visitor shares one demo partner. Every install seeds these rows.
 *
 * Keys: `affiliates.sandbox.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file).
 */
export const AFFILIATES_SANDBOX_COPY = {
  // The /partners signup form: the notice above it, and the panel a demo signup ends on.
  'affiliates.sandbox.signup_notice': {
    en: 'Demo mode: this form runs the real sign-up checks but creates no partner account and sends no email.',
    fr: "Mode démo : ce formulaire effectue les vraies vérifications d'inscription, mais il ne crée aucun compte partenaire et n'envoie aucun courriel.",
  },
  'affiliates.sandbox.signup_done_title': { en: 'Demo sign-up complete', fr: 'Inscription de démonstration terminée' },
  'affiliates.sandbox.signup_done_body': {
    en: 'On a real store, this step creates your partner account and a starter storefront at {url}, after an email confirmation when the store requires one. Nothing was saved here.',
    fr: "Dans une vraie boutique, cette étape crée votre compte partenaire et une vitrine de départ à l'adresse {url}, après une confirmation par courriel si la boutique l'exige. Rien n'a été enregistré ici.",
  },

  // The guide card above the /partners and /partenaires landing page ({email}: a demo login).
  'affiliates.sandbox.guide_title': { en: 'Explore the program in this demo', fr: 'Explorez le programme dans cette démo' },
  'affiliates.sandbox.guide_body': {
    en: 'This shared demo resets every 15 minutes. Try the program three ways:',
    fr: 'Cette démo partagée est réinitialisée toutes les 15 minutes. Essayez le programme de trois façons :',
  },
  'affiliates.sandbox.guide_storefront': {
    en: "Browse the demo partner's storefront, as shoppers see it",
    fr: 'Parcourez la vitrine du partenaire de démonstration, telle que la voient les clients',
  },
  'affiliates.sandbox.guide_portal': {
    en: 'Sign in as {email} to see the partner portal and edit the demo storefront',
    fr: 'Connectez-vous avec {email} pour voir le portail partenaire et modifier la vitrine de démonstration',
  },
  'affiliates.sandbox.guide_admin': {
    en: 'Sign in as {email} to approve storefronts and see the commission ledger',
    fr: 'Connectez-vous avec {email} pour approuver les vitrines et consulter le registre des commissions',
  },

  // The partner portal, above every page ({email}: the demo admin login).
  'affiliates.sandbox.portal_notice_title': { en: 'Shared demo account', fr: 'Compte de démonstration partagé' },
  'affiliates.sandbox.portal_notice_body': {
    en: 'Every visitor uses this account. The demo resets every 15 minutes and sends no email. After you submit your page, sign in as {email} to approve it.',
    fr: "Tous les visiteurs utilisent ce compte. La démo est réinitialisée toutes les 15 minutes et n'envoie aucun courriel. Après avoir soumis votre page, connectez-vous avec {email} pour l'approuver.",
  },
} as const satisfies AffiliatesCopyDictionary;
