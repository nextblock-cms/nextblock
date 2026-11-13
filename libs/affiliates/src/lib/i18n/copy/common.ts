import type { AffiliatesCopyDictionary } from '../types';

/** Keys: `affiliates.common.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file). */
export const AFFILIATES_COMMON_COPY = {
  // Generic actions and states
  'affiliates.common.loading': { en: 'Loading…', fr: 'Chargement…' },
  'affiliates.common.saving': { en: 'Saving…', fr: 'Enregistrement…' },
  'affiliates.common.saved': { en: 'Saved', fr: 'Enregistré' },
  'affiliates.common.save': { en: 'Save', fr: 'Enregistrer' },
  'affiliates.common.cancel': { en: 'Cancel', fr: 'Annuler' },
  'affiliates.common.close': { en: 'Close', fr: 'Fermer' },
  'affiliates.common.back': { en: 'Back', fr: 'Retour' },
  'affiliates.common.continue': { en: 'Continue', fr: 'Continuer' },
  'affiliates.common.retry': { en: 'Try again', fr: 'Réessayer' },
  'affiliates.common.learn_more': { en: 'Learn more', fr: 'En savoir plus' },
  'affiliates.common.copy_link': { en: 'Copy link', fr: 'Copier le lien' },
  'affiliates.common.link_copied': { en: 'Link copied', fr: 'Lien copié' },
  'affiliates.common.optional': { en: 'Optional', fr: 'Facultatif' },
  'affiliates.common.required': { en: 'Required', fr: 'Obligatoire' },

  // Program
  'affiliates.common.partner': { en: 'Partner', fr: 'Partenaire' },
  'affiliates.common.partner_program': { en: 'Partner program', fr: 'Programme de partenaires' },

  // Tiers (fallback names of the seeded tiers; `name_translations` wins when set)
  'affiliates.common.tier_name_starter_partner': { en: 'Starter Partner', fr: 'Partenaire Départ' },
  'affiliates.common.tier_name_growth_partner': { en: 'Growth Partner', fr: 'Partenaire Croissance' },
  'affiliates.common.tier_name_elite_partner': { en: 'Elite Partner', fr: 'Partenaire Élite' },
  'affiliates.common.tier_name_founding_ambassador': { en: 'Founding Ambassador', fr: 'Ambassadeur fondateur' },
  'affiliates.common.tier_name_fallback': { en: 'Partner tier', fr: 'Niveau partenaire' },
  'affiliates.common.tier_commission_rate': { en: '{rate}% commission', fr: 'Commission de {rate} %' },
  'affiliates.common.tier_spots_remaining_one': { en: '1 spot left', fr: '1 place restante' },
  'affiliates.common.tier_spots_remaining_other': { en: '{count} spots left', fr: '{count} places restantes' },
  'affiliates.common.tier_unlimited_spots': { en: 'Unlimited spots', fr: 'Places illimitées' },
  'affiliates.common.tier_sold_out': { en: 'No spots left', fr: 'Complet' },
  'affiliates.common.tier_limited_time': { en: 'Limited-time offer', fr: 'Offre à durée limitée' },

  // Onboarding (the four steps, in order)
  'affiliates.common.step_account': { en: 'Account created', fr: 'Compte créé' },
  'affiliates.common.step_profile': { en: 'Bio and profile completed', fr: 'Bio et profil complétés' },
  // Stripe Connect done, or a payout email saved while some commissions are paid by hand (02036).
  'affiliates.common.step_payouts': { en: 'Payouts set up', fr: 'Versements configurés' },
  'affiliates.common.step_storefront': { en: 'Storefront submitted and published', fr: 'Vitrine soumise et publiée' },
  'affiliates.common.step_done': { en: 'Done', fr: 'Terminé' },
  'affiliates.common.step_to_do': { en: 'To do', fr: 'À faire' },
  // The tracker picks _one for 0 or 1 completed step (French singular), else _other.
  'affiliates.common.onboarding_progress_one': {
    en: '{completed} of {total} steps complete',
    fr: '{completed} étape sur {total} terminée',
  },
  'affiliates.common.onboarding_progress_other': {
    en: '{completed} of {total} steps complete',
    fr: '{completed} étapes sur {total} terminées',
  },

  // Storefront page statuses
  'affiliates.common.page_status_draft': { en: 'Draft', fr: 'Brouillon' },
  'affiliates.common.page_status_pending_review': { en: 'In review', fr: 'En révision' },
  'affiliates.common.page_status_published': { en: 'Published', fr: 'Publiée' },
  'affiliates.common.page_status_changes_requested': { en: 'Changes requested', fr: 'Modifications demandées' },

  // Commission statuses
  'affiliates.common.commission_status_pending_clearance': { en: 'Pending clearance', fr: 'En attente de confirmation' },
  'affiliates.common.commission_status_cleared': { en: 'Cleared', fr: 'Confirmée' },
  'affiliates.common.commission_status_paid': { en: 'Paid', fr: 'Payée' },
  'affiliates.common.commission_status_voided_refund': { en: 'Voided (refund)', fr: 'Annulée (remboursement)' },

  // Payout statuses
  'affiliates.common.payout_status_processing': { en: 'Processing', fr: 'En traitement' },
  'affiliates.common.payout_status_completed': { en: 'Sent', fr: 'Envoyé' },
  'affiliates.common.payout_status_failed': { en: 'Failed', fr: 'Échec' },

  // Partner account statuses
  'affiliates.common.account_status_active': { en: 'Active', fr: 'Actif' },
  'affiliates.common.account_status_suspended': { en: 'Suspended', fr: 'Suspendu' },

  // Errors
  'affiliates.common.error_generic': {
    en: 'Something went wrong. Please try again.',
    fr: "Une erreur s'est produite. Veuillez réessayer.",
  },
  'affiliates.common.error_network': {
    en: "We couldn't reach the server. Check your connection and try again.",
    fr: 'Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.',
  },
  'affiliates.common.error_unauthorized': { en: 'Please sign in to continue.', fr: 'Veuillez vous connecter pour continuer.' },
  'affiliates.common.error_forbidden': { en: "You don't have access to this page.", fr: "Vous n'avez pas accès à cette page." },
  'affiliates.common.error_suspended': {
    en: 'Your partner account is suspended. Contact us if you have questions.',
    fr: 'Votre compte partenaire est suspendu. Communiquez avec nous si vous avez des questions.',
  },
  'affiliates.common.error_package_inactive': {
    en: "The partner program isn't available right now.",
    fr: "Le programme de partenaires n'est pas offert pour le moment.",
  },
  'affiliates.common.error_rate_limited': {
    en: 'Too many requests. Wait a moment, then try again.',
    fr: 'Trop de demandes. Patientez un instant, puis réessayez.',
  },
  'affiliates.common.error_validation': { en: 'Some fields need your attention.', fr: 'Certains champs doivent être corrigés.' },
  'affiliates.common.error_not_found': {
    en: "We couldn't find what you were looking for.",
    fr: "Nous n'avons pas trouvé ce que vous cherchiez.",
  },
  'affiliates.common.error_save_failed': {
    en: "Your changes couldn't be saved. Please try again.",
    fr: "Vos modifications n'ont pas pu être enregistrées. Veuillez réessayer.",
  },
  'affiliates.common.error_handle_taken': {
    en: 'That handle is already taken. Try another one.',
    fr: 'Cet identifiant est déjà utilisé. Essayez-en un autre.',
  },
  'affiliates.common.error_handle_invalid': {
    en: 'Use 3 to 32 lowercase letters, numbers or hyphens, starting and ending with a letter or number.',
    fr: "Utilisez de 3 à 32 lettres minuscules, chiffres ou traits d'union, en commençant et en terminant par une lettre ou un chiffre.",
  },
  'affiliates.common.error_handle_reserved': {
    en: 'That handle is reserved. Try another one.',
    fr: 'Cet identifiant est réservé. Essayez-en un autre.',
  },
  'affiliates.common.error_role_conflict': {
    en: "This account can't join the partner program. Sign in with a customer account or contact us.",
    fr: 'Ce compte ne peut pas rejoindre le programme de partenaires. Connectez-vous avec un compte client ou communiquez avec nous.',
  },
  'affiliates.common.error_affiliate_exists': {
    en: "You're already a partner. Open your partner portal to continue.",
    fr: 'Vous êtes déjà partenaire. Ouvrez votre portail partenaire pour continuer.',
  },
  'affiliates.common.error_program_full': {
    en: 'The partner program is full right now. Please check back soon.',
    fr: 'Le programme de partenaires est complet pour le moment. Revenez bientôt.',
  },
} as const satisfies AffiliatesCopyDictionary;
