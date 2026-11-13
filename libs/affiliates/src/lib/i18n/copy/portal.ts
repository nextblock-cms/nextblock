import type { AffiliatesCopyDictionary } from '../types';

/**
 * Keys: `affiliates.portal.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file).
 * The partner portal (`/portal/retailer/**`): shell, overview, storefront studio, payouts, uploads.
 */
export const AFFILIATES_PORTAL_COPY = {
  // Shell and navigation
  'affiliates.portal.meta_title': { en: 'Partner portal', fr: 'Portail partenaire' },
  'affiliates.portal.shell_eyebrow': { en: 'Partner portal', fr: 'Portail partenaire' },
  'affiliates.portal.nav_label': { en: 'Partner portal sections', fr: 'Sections du portail partenaire' },
  'affiliates.portal.nav_overview': { en: 'Overview', fr: 'Aperçu' },
  'affiliates.portal.nav_storefront': { en: 'Storefront', fr: 'Vitrine' },
  'affiliates.portal.nav_payouts': { en: 'Payouts', fr: 'Versements' },
  'affiliates.portal.view_storefront': { en: 'View my storefront', fr: 'Voir ma vitrine' },
  'affiliates.portal.opens_new_tab': { en: '(opens in a new tab)', fr: "(s'ouvre dans un nouvel onglet)" },
  'affiliates.portal.suspended_title': { en: 'Your partner account is suspended', fr: 'Votre compte partenaire est suspendu' },
  'affiliates.portal.suspended_body': {
    en: "Your storefront and referral links are paused, and you can't make changes for now. Your earnings history stays available here. Contact us if you have questions.",
    fr: "Votre vitrine et vos liens de recommandation sont en pause, et vous ne pouvez rien modifier pour le moment. L'historique de vos gains reste disponible ici. Communiquez avec nous si vous avez des questions.",
  },
  'affiliates.portal.suspended_reason': { en: 'Reason given: {reason}', fr: 'Motif indiqué : {reason}' },

  // Overview
  'affiliates.portal.overview_meta_title': { en: 'Partner dashboard', fr: 'Tableau de bord partenaire' },
  'affiliates.portal.overview_title': { en: 'Partner dashboard', fr: 'Tableau de bord partenaire' },
  'affiliates.portal.overview_greeting': {
    en: "Hi {name}, here's how your storefront is doing.",
    fr: 'Bonjour {name}, voici où en est votre vitrine.',
  },
  'affiliates.portal.overview_tier': { en: 'Your tier: {tier}, {rate} commission', fr: 'Votre niveau : {tier}, commission de {rate}' },
  // When the partner joined their current tier: affiliate_profiles.tier_changed_at, else created_at
  // (seeded by migration 02035, which added the column).
  'affiliates.portal.overview_tier_since': { en: 'Tier since {date}', fr: 'À ce niveau depuis le {date}' },
  'affiliates.portal.welcome_title': {
    en: 'Welcome to the partner program, {name}!',
    fr: 'Bienvenue dans le programme de partenaires, {name}!',
  },
  // "Set up your payouts", not "connect your bank": with manual payouts (02036) a payout email is
  // the setup. Changed by migration 02036.
  'affiliates.portal.welcome_body': {
    en: 'Three steps get your storefront live: complete your profile, set up your payouts, then build your page and submit it for approval. Your links start earning commissions after the first approval.',
    fr: 'Trois étapes pour mettre votre vitrine en ligne : complétez votre profil, configurez vos versements, puis créez votre page et soumettez-la pour approbation. Vos liens commencent à rapporter des commissions après la première approbation.',
  },
  'affiliates.portal.banner_changes_title': { en: 'Changes requested', fr: 'Modifications demandées' },
  'affiliates.portal.banner_changes_body': {
    en: "We reviewed your storefront and asked for a few changes before it can go live. Here's the note from our team:",
    fr: 'Nous avons examiné votre vitrine et demandé quelques modifications avant sa mise en ligne. Voici la note de notre équipe :',
  },
  'affiliates.portal.banner_changes_action': { en: 'Open the storefront studio', fr: 'Ouvrir le studio de vitrine' },
  'affiliates.portal.banner_review_title': { en: 'Your storefront is in review', fr: 'Votre vitrine est en révision' },
  'affiliates.portal.banner_review_body': {
    en: "We'll email you as soon as it's approved. Your referral links start earning commissions from that first approval.",
    fr: "Nous vous écrirons par courriel dès qu'elle sera approuvée. Vos liens de recommandation commenceront à rapporter des commissions à partir de cette première approbation.",
  },
  'affiliates.portal.banner_review_update_title': { en: 'Your changes are in review', fr: 'Vos modifications sont en révision' },
  'affiliates.portal.banner_review_update_body': {
    en: "Your current storefront stays live while we review the update. We'll email you when it's done.",
    fr: "Votre vitrine actuelle reste en ligne pendant que nous examinons la mise à jour. Nous vous écrirons par courriel une fois l'examen terminé.",
  },
  'affiliates.portal.banner_not_approved_title': {
    en: "Your links don't earn commissions yet",
    fr: 'Vos liens ne rapportent pas encore de commissions',
  },
  'affiliates.portal.banner_not_approved_body': {
    en: 'Commissions start once your storefront is approved for the first time. Finish your page and submit it for review.',
    fr: 'Les commissions commencent dès la première approbation de votre vitrine. Terminez votre page et soumettez-la pour révision.',
  },
  'affiliates.portal.banner_not_approved_action': { en: 'Finish my storefront', fr: 'Terminer ma vitrine' },
  'affiliates.portal.ledger_error_title': { en: "Your earnings couldn't be loaded", fr: "Vos gains n'ont pas pu être chargés" },
  'affiliates.portal.ledger_error_body': {
    en: 'This is usually temporary. Reload the page in a moment.',
    fr: "C'est généralement temporaire. Rechargez la page dans un instant.",
  },

  // Onboarding tracker
  'affiliates.portal.progress_title': { en: 'Getting started', fr: 'Premiers pas' },
  'affiliates.portal.progress_next_step': { en: 'Next step', fr: 'Prochaine étape' },
  'affiliates.portal.progress_action_profile': { en: 'Complete my profile', fr: 'Compléter mon profil' },
  'affiliates.portal.progress_action_payouts': { en: 'Set up my payouts', fr: 'Configurer mes versements' },
  'affiliates.portal.progress_action_storefront': { en: 'Build my storefront', fr: 'Créer ma vitrine' },

  // Overview figures
  'affiliates.portal.stats_title': { en: 'Your numbers', fr: 'Vos chiffres' },
  'affiliates.portal.stats_payouts_link': { en: 'See payouts and commissions', fr: 'Voir les versements et les commissions' },
  'affiliates.portal.stats_clicks': { en: 'Referral visits', fr: 'Visites issues de vos liens' },
  'affiliates.portal.stats_clicks_hint': { en: 'New visitors who arrived through your links.', fr: 'Nouveaux visiteurs arrivés par vos liens.' },
  'affiliates.portal.stats_pending': { en: 'Pending ({days}-day refund window)', fr: 'En attente (période de remboursement de {days} jours)' },
  'affiliates.portal.stats_pending_hint': {
    en: 'Commissions still inside the refund window.',
    fr: 'Commissions encore dans la période de remboursement.',
  },
  'affiliates.portal.stats_cleared': { en: 'Ready for payout', fr: 'Prêt pour le versement' },
  'affiliates.portal.stats_cleared_hint': {
    en: 'Cleared commissions waiting for the next payout.',
    fr: 'Commissions confirmées en attente du prochain versement.',
  },
  'affiliates.portal.stats_paid': { en: 'Paid out (lifetime)', fr: 'Versé (depuis le début)' },
  'affiliates.portal.recent_title': { en: 'Recent commissions', fr: 'Commissions récentes' },
  'affiliates.portal.recent_empty': {
    en: 'No commissions yet. Share your storefront and referral links to start earning.',
    fr: "Aucune commission pour l'instant. Partagez votre vitrine et vos liens de recommandation pour commencer à gagner.",
  },

  // Share tools
  'affiliates.portal.share_title': { en: 'Share and earn', fr: 'Partager et gagner' },
  'affiliates.portal.share_description': {
    en: 'Send people to your storefront, or link to any page of the store with your referral code. Orders from your links earn you a commission.',
    fr: "Dirigez les gens vers votre vitrine, ou créez un lien vers n'importe quelle page de la boutique avec votre code de recommandation. Les commandes passées grâce à vos liens vous rapportent une commission.",
  },
  'affiliates.portal.share_description_not_approved': {
    en: "Your links are ready to copy. They start earning commissions after your storefront's first approval.",
    fr: 'Vos liens sont prêts à copier. Ils commenceront à rapporter des commissions après la première approbation de votre vitrine.',
  },
  'affiliates.portal.share_storefront_label': { en: 'Your storefront link', fr: 'Lien de votre vitrine' },
  'affiliates.portal.share_storefront_not_live': {
    en: "Your storefront goes live after it's approved; until then this link shows a page that isn't available yet.",
    fr: "Votre vitrine sera en ligne après son approbation; d'ici là, ce lien mène à une page qui n'est pas encore accessible.",
  },
  'affiliates.portal.share_ref_label': { en: 'Link to any page of the store', fr: "Lien vers n'importe quelle page de la boutique" },
  'affiliates.portal.share_ref_hint': {
    en: 'Paste a page address from this site, like a product page. Your referral code is added for you.',
    fr: "Collez l'adresse d'une page de ce site, comme une page de produit. Votre code de recommandation est ajouté pour vous.",
  },
  'affiliates.portal.share_ref_placeholder': { en: '/product/your-favorite', fr: '/product/votre-favori' },
  'affiliates.portal.share_ref_result_label': { en: 'Your referral link', fr: 'Votre lien de recommandation' },
  'affiliates.portal.share_ref_error_invalid': {
    en: "That doesn't look like a page address. Try something like /product/your-favorite.",
    fr: 'Cette adresse ne semble pas valide. Essayez quelque chose comme /product/votre-favori.',
  },
  'affiliates.portal.share_ref_error_other_site': {
    en: "Use a page from this store. Links to other sites don't earn commissions.",
    fr: "Utilisez une page de cette boutique. Les liens vers d'autres sites ne rapportent pas de commissions.",
  },
  'affiliates.portal.share_ref_error_excluded': {
    en: "That page can't carry a referral link. Pick a public page of the store.",
    fr: 'Cette page ne peut pas porter de lien de recommandation. Choisissez une page publique de la boutique.',
  },
  'affiliates.portal.copy_manual': {
    en: "Couldn't copy automatically. The link is selected: press Ctrl+C (or ⌘+C) to copy it.",
    fr: 'Copie automatique impossible. Le lien est sélectionné : appuyez sur Ctrl+C (ou ⌘+C) pour le copier.',
  },

  // Ledger tables
  'affiliates.portal.table_date': { en: 'Date', fr: 'Date' },
  'affiliates.portal.table_order': { en: 'Order', fr: 'Commande' },
  'affiliates.portal.table_amount': { en: 'Amount', fr: 'Montant' },
  'affiliates.portal.table_rate': { en: 'Rate', fr: 'Taux' },
  'affiliates.portal.table_status': { en: 'Status', fr: 'Statut' },
  'affiliates.portal.table_clears_on': { en: 'Clears on', fr: 'Date de confirmation' },
  'affiliates.portal.table_sent_on': { en: 'Sent on', fr: 'Envoyé le' },
  'affiliates.portal.table_details': { en: 'Details', fr: 'Détails' },
  'affiliates.portal.table_showing_latest': {
    en: 'Showing the latest {shown} of {total}',
    fr: 'Affichage des {shown} plus récents sur {total}',
  },
  'affiliates.portal.commission_refunded': { en: '{amount} refunded', fr: '{amount} remboursé' },
  'affiliates.portal.payout_reference': { en: 'Ref. {reference}', fr: 'Réf. {reference}' },
  'affiliates.portal.payout_failed_note': {
    en: "The transfer failed. We'll try again automatically.",
    fr: 'Le virement a échoué. Nous réessaierons automatiquement.',
  },
  'affiliates.portal.payout_failed_review_note': {
    en: "The transfer failed. We'll look into it and send it again.",
    fr: 'Le virement a échoué. Nous allons vérifier la situation et vous le renvoyer.',
  },
  'affiliates.portal.payout_processing_note': { en: 'Being sent to your bank.', fr: "En cours d'envoi vers votre banque." },
  // A payout the operator sent outside Stripe and recorded in the CMS (02036): "PayPal · Ref. 5TY…",
  // then the note the admin wrote for the partner. Seeded by migration 02036.
  'affiliates.portal.payout_manual_reference': { en: '{channel} · Ref. {reference}', fr: '{channel} · Réf. {reference}' },
  'affiliates.portal.payout_manual_note': { en: 'Note: {note}', fr: 'Note : {note}' },
  // A manual payout the store prepared (02036: its commissions are reserved) and has not recorded as
  // sent yet: no channel or reference exists yet.
  'affiliates.portal.payout_manual_sending_note': { en: 'Being sent to you directly.', fr: 'Envoi direct en cours.' },
  'affiliates.portal.payout_channel_paypal': { en: 'PayPal', fr: 'PayPal' },
  'affiliates.portal.payout_channel_interac': { en: 'Interac e-Transfer', fr: 'Virement Interac' },
  'affiliates.portal.payout_channel_wise': { en: 'Wise', fr: 'Wise' },
  'affiliates.portal.payout_channel_bank_transfer': { en: 'Bank transfer', fr: 'Virement bancaire' },
  'affiliates.portal.payout_channel_other': { en: 'Other method', fr: 'Autre mode de paiement' },
  // The commissions table's extra column while some commissions are paid through Stripe and others
  // by hand: how each one is (or was) paid. Seeded by migration 02036.
  'affiliates.portal.table_payout': { en: 'Payout', fr: 'Versement' },
  'affiliates.portal.commission_payout_stripe': { en: 'Stripe transfer', fr: 'Virement Stripe' },
  'affiliates.portal.commission_payout_direct': { en: 'Sent directly', fr: 'Envoi direct' },
  // Automatic PayPal Payouts (02037, seeded by its section 7, like every PayPal key below): a
  // commission PayPal pays (or paid) for this partner, and the payout history's "PayPal · {status}"
  // rows, with PayPal's transaction id once paid and the claim hint while PayPal waits for the partner.
  'affiliates.portal.commission_payout_paypal': { en: 'PayPal', fr: 'PayPal' },
  'affiliates.portal.payout_paypal_status': { en: 'PayPal · {status}', fr: 'PayPal · {status}' },
  'affiliates.portal.payout_paypal_status_sent': { en: 'Sent', fr: 'Envoyé' },
  'affiliates.portal.payout_paypal_status_unclaimed': { en: 'Waiting for you to claim it', fr: 'En attente que vous le réclamiez' },
  'affiliates.portal.payout_paypal_status_paid': { en: 'Paid', fr: 'Payé' },
  'affiliates.portal.payout_paypal_status_returned': { en: 'Returned', fr: 'Retourné' },
  'affiliates.portal.payout_paypal_status_not_sent': { en: 'Not sent', fr: 'Non envoyé' },
  'affiliates.portal.payout_paypal_transaction': { en: 'Transaction {reference}', fr: 'Transaction {reference}' },
  'affiliates.portal.payout_paypal_claim_hint': {
    en: 'Claim it in PayPal: check the email PayPal sent to {email}.',
    fr: 'Réclamez-le dans PayPal : consultez le courriel que PayPal a envoyé à {email}.',
  },
  'affiliates.portal.payout_paypal_back_in_balance': {
    en: 'The amount went back to your balance.',
    fr: 'Le montant est retourné dans votre solde.',
  },

  // Storefront studio
  'affiliates.portal.studio_meta_title': { en: 'Storefront studio', fr: 'Studio de vitrine' },
  'affiliates.portal.studio_title': { en: 'Storefront studio', fr: 'Studio de vitrine' },
  'affiliates.portal.studio_description': {
    en: 'Build your storefront page, pick the products you love and tell your story. Changes save automatically as a draft; your profile and page go live only after we approve them, and your current storefront stays live in the meantime.',
    fr: "Créez la page de votre vitrine, choisissez les produits que vous aimez et racontez votre histoire. Vos modifications sont enregistrées automatiquement comme brouillon; votre profil et votre page ne sont mis en ligne qu'après notre approbation, et votre vitrine actuelle reste en ligne entre-temps.",
  },
  'affiliates.portal.studio_live_at': { en: 'Live at', fr: "En ligne à l'adresse" },
  'affiliates.portal.studio_missing_title': { en: 'Your storefront page is missing', fr: 'La page de votre vitrine est introuvable' },
  'affiliates.portal.studio_missing_body': {
    en: "Contact us and we'll set it up for you.",
    fr: 'Communiquez avec nous et nous la créerons pour vous.',
  },
  'affiliates.portal.studio_changes_body': {
    en: 'Update your storefront with these notes in mind, then submit it again:',
    fr: 'Mettez votre vitrine à jour en tenant compte de ces remarques, puis soumettez-la de nouveau :',
  },
  'affiliates.portal.studio_pending_title': { en: 'In review', fr: 'En révision' },
  'affiliates.portal.studio_pending_body': {
    en: 'Editing is paused while we review your storefront. Withdraw the submission if you need to change something.',
    fr: 'La modification est en pause pendant que nous examinons votre vitrine. Retirez la soumission si vous devez changer quelque chose.',
  },
  'affiliates.portal.studio_locked_pending': {
    en: 'Editing is paused while your storefront is in review.',
    fr: 'La modification est en pause pendant la révision de votre vitrine.',
  },
  'affiliates.portal.studio_locked_suspended': {
    en: 'Your account is suspended, so editing is turned off.',
    fr: 'Votre compte est suspendu : la modification est désactivée.',
  },
  'affiliates.portal.conflict_title': { en: 'This storefront changed somewhere else', fr: 'Cette vitrine a été modifiée ailleurs' },
  'affiliates.portal.conflict_reload': { en: 'Load the latest version', fr: 'Charger la dernière version' },

  // Page details
  'affiliates.portal.settings_title': { en: 'Page details', fr: 'Détails de la page' },
  'affiliates.portal.settings_description': {
    en: 'The title and description shown in search results and when your page is shared.',
    fr: 'Le titre et la description affichés dans les résultats de recherche et lors du partage de votre page.',
  },
  'affiliates.portal.settings_page_title': { en: 'Page title', fr: 'Titre de la page' },
  'affiliates.portal.settings_meta': { en: 'Meta description', fr: 'Description (moteurs de recherche)' },
  'affiliates.portal.meta_hint_empty': {
    en: 'Describe your storefront in a sentence or two. About 70 to {max} characters works best.',
    fr: "Décrivez votre vitrine en une ou deux phrases. De 70 à {max} caractères environ, c'est idéal.",
  },
  'affiliates.portal.meta_hint_ok': { en: 'Good length for search results.', fr: 'Bonne longueur pour les résultats de recherche.' },
  'affiliates.portal.meta_hint_long': {
    en: 'Search engines usually show about {max} characters; the rest may be cut off.',
    fr: 'Les moteurs de recherche affichent environ {max} caractères; le reste peut être coupé.',
  },
  'affiliates.portal.character_count': { en: '{count} of {max} characters', fr: '{count} sur {max} caractères' },

  // Page content and autosave
  'affiliates.portal.content_title': { en: 'Page content', fr: 'Contenu de la page' },
  'affiliates.portal.content_description': {
    en: 'Type / to add headings, lists, images or a product grid with /promote.',
    fr: 'Tapez / pour ajouter des titres, des listes, des images ou une grille de produits avec /promote.',
  },
  'affiliates.portal.content_editor_label': { en: 'Storefront page content', fr: 'Contenu de la page de vitrine' },
  'affiliates.portal.autosave_saved': { en: 'All changes saved', fr: 'Toutes les modifications sont enregistrées' },
  'affiliates.portal.autosave_saving': { en: 'Saving…', fr: 'Enregistrement…' },
  'affiliates.portal.autosave_unsaved': { en: 'Unsaved changes', fr: 'Modifications non enregistrées' },
  'affiliates.portal.autosave_error': {
    en: "Couldn't save. We'll try again when you keep editing.",
    fr: 'Enregistrement impossible. Nous réessaierons lorsque vous poursuivrez vos modifications.',
  },

  // Preview
  'affiliates.portal.preview_title': { en: 'Preview', fr: 'Aperçu' },
  'affiliates.portal.preview_show': { en: 'Show preview', fr: "Afficher l'aperçu" },
  'affiliates.portal.preview_hide': { en: 'Hide preview', fr: "Masquer l'aperçu" },
  'affiliates.portal.preview_description': {
    en: "See your draft the way visitors will once it's approved.",
    fr: 'Voyez votre brouillon comme les visiteurs le verront une fois approuvé.',
  },
  'affiliates.portal.preview_untitled': { en: 'Untitled storefront', fr: 'Vitrine sans titre' },
  'affiliates.portal.preview_featured_heading': { en: 'Featured products', fr: 'Produits vedettes' },
  'affiliates.portal.preview_photo_credit': { en: 'Photo: {photographer} / {provider}', fr: 'Photo : {photographer} / {provider}' },

  // Review and publish
  'affiliates.portal.publish_title': { en: 'Review and publish', fr: 'Révision et publication' },
  'affiliates.portal.publish_status_label': { en: 'Status:', fr: 'Statut :' },
  'affiliates.portal.publish_explainer': {
    en: 'When you are ready, submit your storefront for approval. Your profile and page changes go live only after we approve them; the version visitors see now stays live until then.',
    fr: "Lorsque tout est prêt, soumettez votre vitrine pour approbation. Les modifications de votre profil et de votre page ne sont mises en ligne qu'après notre approbation; la version que voient les visiteurs reste en ligne d'ici là.",
  },
  'affiliates.portal.publish_live': { en: 'Your storefront is live.', fr: 'Votre vitrine est en ligne.' },
  'affiliates.portal.publish_not_live': { en: "Your storefront isn't live yet.", fr: "Votre vitrine n'est pas encore en ligne." },
  'affiliates.portal.submit_button': { en: 'Submit for approval', fr: 'Soumettre pour approbation' },
  'affiliates.portal.submitting': { en: 'Submitting…', fr: 'Soumission…' },
  'affiliates.portal.submit_success': {
    en: "Submitted! We'll email you when it's reviewed.",
    fr: 'Soumise! Nous vous écrirons par courriel après la révision.',
  },
  'affiliates.portal.submit_save_first': {
    en: "Your latest changes aren't saved yet. Wait a moment and try again.",
    fr: 'Vos dernières modifications ne sont pas encore enregistrées. Patientez un instant et réessayez.',
  },
  'affiliates.portal.submit_need_title': { en: 'Add a page title before submitting.', fr: 'Ajoutez un titre de page avant de soumettre.' },
  'affiliates.portal.submit_need_content': {
    en: 'Add some content to your page before submitting.',
    fr: 'Ajoutez du contenu à votre page avant de soumettre.',
  },
  'affiliates.portal.submit_up_to_date': {
    en: 'Your live storefront is up to date. Edit your page or profile to submit changes.',
    fr: 'Votre vitrine en ligne est à jour. Modifiez votre page ou votre profil pour soumettre des changements.',
  },
  'affiliates.portal.withdraw_button': { en: 'Withdraw submission', fr: 'Retirer la soumission' },
  'affiliates.portal.withdrawing': { en: 'Withdrawing…', fr: 'Retrait…' },
  'affiliates.portal.withdraw_success': {
    en: 'Submission withdrawn. You can edit your storefront again.',
    fr: 'Soumission retirée. Vous pouvez de nouveau modifier votre vitrine.',
  },
  'affiliates.portal.copilot_bio_applied': {
    en: 'The assistant filled in your bio and meta description. Review them, then save your profile.',
    fr: "L'assistant a rempli votre bio et votre description. Relisez-les, puis enregistrez votre profil.",
  },
  'affiliates.portal.copilot_unavailable': {
    en: "The storefront assistant isn't available on this site right now. You can still edit your page yourself.",
    fr: "L'assistant de vitrine n'est pas disponible sur ce site pour le moment. Vous pouvez tout de même modifier votre page vous-même.",
  },

  // Profile
  'affiliates.portal.profile_title': { en: 'Your profile', fr: 'Votre profil' },
  'affiliates.portal.profile_description': {
    en: 'Shown at the top of your storefront. Changes go live with your next approval.',
    fr: 'Affiché en haut de votre vitrine. Les modifications sont mises en ligne à votre prochaine approbation.',
  },
  'affiliates.portal.avatar_alt': { en: 'Profile photo of {name}', fr: 'Photo de profil de {name}' },
  'affiliates.portal.avatar_upload': { en: 'Upload a photo', fr: 'Téléverser une photo' },
  'affiliates.portal.avatar_change': { en: 'Change photo', fr: 'Changer la photo' },
  'affiliates.portal.avatar_uploading': { en: 'Uploading…', fr: 'Téléversement…' },
  'affiliates.portal.avatar_uploaded': { en: 'Photo updated.', fr: 'Photo mise à jour.' },
  'affiliates.portal.avatar_hint': {
    en: 'JPEG, PNG, WebP, AVIF or GIF, up to 2 MB. We crop it to a square.',
    fr: "JPEG, PNG, WebP, AVIF ou GIF, jusqu'à 2 Mo. Nous la recadrons en carré.",
  },
  'affiliates.portal.profile_display_name': { en: 'Display name', fr: 'Nom affiché' },
  'affiliates.portal.profile_bio': { en: 'Bio', fr: 'Bio' },
  'affiliates.portal.profile_bio_hint': {
    en: 'Write at least {min} characters to complete your profile.',
    fr: 'Écrivez au moins {min} caractères pour compléter votre profil.',
  },
  'affiliates.portal.profile_bio_hint_ok': {
    en: 'Tell visitors who you are and why they can trust your picks.',
    fr: 'Dites aux visiteurs qui vous êtes et pourquoi ils peuvent se fier à vos choix.',
  },
  'affiliates.portal.profile_social_title': { en: 'Social links', fr: 'Réseaux sociaux' },
  'affiliates.portal.profile_social_hint': {
    en: 'Optional. Use the full address of your profile, for example https://instagram.com/yourname.',
    fr: "Facultatif. Utilisez l'adresse complète de votre profil, par exemple https://instagram.com/votrenom.",
  },
  'affiliates.portal.profile_social_invalid': {
    en: "Use a secure link (https) to this network's own site.",
    fr: 'Utilisez un lien sécurisé (https) vers le site de ce réseau.',
  },
  'affiliates.portal.social_website': { en: 'Website', fr: 'Site Web' },
  'affiliates.portal.social_instagram': { en: 'Instagram', fr: 'Instagram' },
  'affiliates.portal.social_tiktok': { en: 'TikTok', fr: 'TikTok' },
  'affiliates.portal.social_youtube': { en: 'YouTube', fr: 'YouTube' },
  'affiliates.portal.social_x': { en: 'X (Twitter)', fr: 'X (Twitter)' },
  'affiliates.portal.social_facebook': { en: 'Facebook', fr: 'Facebook' },
  'affiliates.portal.social_pinterest': { en: 'Pinterest', fr: 'Pinterest' },
  'affiliates.portal.social_linkedin': { en: 'LinkedIn', fr: 'LinkedIn' },
  'affiliates.portal.profile_locale': { en: 'Language', fr: 'Langue' },
  'affiliates.portal.profile_locale_hint': {
    en: 'The language of our emails to you and of your storefront. A new language reaches your live page at its next approval.',
    fr: "La langue de nos courriels et de votre vitrine. Une nouvelle langue s'applique à votre page en ligne à sa prochaine approbation.",
  },
  'affiliates.portal.locale_en': { en: 'English', fr: 'English' },
  'affiliates.portal.locale_fr': { en: 'Français', fr: 'Français' },
  'affiliates.portal.profile_save': { en: 'Save profile', fr: 'Enregistrer le profil' },
  'affiliates.portal.profile_saved': { en: 'Profile saved.', fr: 'Profil enregistré.' },
  'affiliates.portal.profile_saved_completed': {
    en: "Profile saved. That's one step done!",
    fr: 'Profil enregistré. Une étape de franchie!',
  },
  'affiliates.portal.profile_unsaved': { en: 'Unsaved changes', fr: 'Modifications non enregistrées' },

  // Featured products
  'affiliates.portal.featured_title': { en: 'Featured products', fr: 'Produits vedettes' },
  'affiliates.portal.featured_description': {
    en: 'Pick up to {max} products to feature on your storefront, after your page content. Products already shown in a product grid appear only once.',
    fr: "Choisissez jusqu'à {max} produits à mettre en vedette dans votre vitrine, après le contenu de votre page. Les produits déjà présents dans une grille n'apparaissent qu'une fois.",
  },
  'affiliates.portal.featured_empty': { en: 'No featured products yet.', fr: "Aucun produit vedette pour l'instant." },
  'affiliates.portal.featured_choose': { en: 'Choose products', fr: 'Choisir des produits' },
  'affiliates.portal.featured_edit': { en: 'Edit featured products', fr: 'Modifier les produits vedettes' },
  'affiliates.portal.featured_remove': { en: 'Remove {name}', fr: 'Retirer {name}' },
  'affiliates.portal.featured_unavailable': { en: 'Unavailable product', fr: 'Produit non disponible' },

  // Action errors
  'affiliates.portal.error_social_links': {
    en: "Some social links can't be used. Check the highlighted fields.",
    fr: 'Certains liens de réseaux sociaux ne peuvent pas être utilisés. Vérifiez les champs signalés.',
  },
  'affiliates.portal.error_pending_review': {
    en: "Your storefront is in review, so it can't be changed right now. Withdraw the submission to edit it.",
    fr: 'Votre vitrine est en révision et ne peut pas être modifiée pour le moment. Retirez la soumission pour la modifier.',
  },
  'affiliates.portal.error_conflict': {
    en: 'Your storefront was changed in another tab or on another device. Load the latest version to keep editing; unsaved changes here will be lost.',
    fr: 'Votre vitrine a été modifiée dans un autre onglet ou sur un autre appareil. Chargez la dernière version pour continuer; les modifications non enregistrées ici seront perdues.',
  },
  'affiliates.portal.error_empty_storefront': {
    en: 'Add some content to your storefront before submitting it.',
    fr: 'Ajoutez du contenu à votre vitrine avant de la soumettre.',
  },
  'affiliates.portal.error_storefront_too_large': {
    en: 'Your storefront is too large to save. Remove some text, links or images so it can be saved.',
    fr: "Votre vitrine est trop volumineuse pour être enregistrée. Retirez du texte, des liens ou des images pour pouvoir l'enregistrer.",
  },
  'affiliates.portal.error_missing_title': { en: 'Add a page title before submitting.', fr: 'Ajoutez un titre de page avant de soumettre.' },
  'affiliates.portal.error_nothing_to_submit': {
    en: 'Nothing has changed since your last approval.',
    fr: "Rien n'a changé depuis votre dernière approbation.",
  },
  'affiliates.portal.error_not_pending': { en: "There's no submission to withdraw.", fr: "Il n'y a aucune soumission à retirer." },
  'affiliates.portal.error_submit_cooldown': {
    en: 'You can submit your storefront again 10 minutes after your last submission. Try again in a few minutes.',
    fr: 'Vous pourrez soumettre votre vitrine de nouveau 10 minutes après votre dernière soumission. Réessayez dans quelques minutes.',
  },
  'affiliates.portal.error_sandbox': { en: 'Payouts are turned off in this demo.', fr: 'Les versements sont désactivés dans cette démo.' },
  'affiliates.portal.error_connect_unavailable': {
    en: "We couldn't reach Stripe right now. Try again in a moment.",
    fr: 'Impossible de joindre Stripe pour le moment. Réessayez dans un instant.',
  },
  'affiliates.portal.error_payouts_not_configured': {
    en: "Bank payouts aren't available on this store yet. Try again once the store has finished setting up its payment account.",
    fr: "Les versements bancaires ne sont pas encore offerts sur cette boutique. Réessayez lorsque la boutique aura terminé la configuration de son compte de paiement.",
  },
  // The payout email form (02036): not one deliverable-looking address. Seeded by migration 02036.
  'affiliates.portal.error_payout_email': {
    en: 'Enter a valid email address, like name@example.com.',
    fr: 'Entrez une adresse courriel valide, comme nom@exemple.com.',
  },
  // The PayPal email and its confirmation differ (checked in the form before anything is sent; 02037).
  'affiliates.portal.error_payout_email_mismatch': {
    en: "The two email addresses don't match.",
    fr: 'Les deux adresses courriel ne correspondent pas.',
  },
  // The confirmation of a new PayPal email was left empty (02037).
  'affiliates.portal.error_payout_email_confirm_empty': {
    en: 'Type your PayPal email again to confirm it.',
    fr: 'Entrez de nouveau votre courriel PayPal pour le confirmer.',
  },

  // Upload errors
  'affiliates.portal.upload_error_rate_limited': {
    en: "You've uploaded a lot of images in the last hour. Try again later.",
    fr: "Vous avez téléversé beaucoup d'images dans la dernière heure. Réessayez plus tard.",
  },
  'affiliates.portal.upload_error_image_limit': {
    en: 'Your storefront has reached its image limit. Reuse an image you already uploaded.',
    fr: "Votre vitrine a atteint sa limite d'images. Réutilisez une image déjà téléversée.",
  },
  'affiliates.portal.upload_error_too_large_avatar': {
    en: 'That photo is larger than 2 MB. Choose a smaller one.',
    fr: 'Cette photo dépasse 2 Mo. Choisissez-en une plus petite.',
  },
  'affiliates.portal.upload_error_too_large_image': {
    en: 'That image is larger than 5 MB. Choose a smaller one.',
    fr: 'Cette image dépasse 5 Mo. Choisissez-en une plus petite.',
  },
  'affiliates.portal.upload_error_type': { en: 'Use a JPEG, PNG, WebP, AVIF or GIF image.', fr: 'Utilisez une image JPEG, PNG, WebP, AVIF ou GIF.' },
  'affiliates.portal.upload_error_invalid': {
    en: "That file couldn't be read as an image. Try another one.",
    fr: "Ce fichier n'a pas pu être lu comme une image. Essayez-en un autre.",
  },
  'affiliates.portal.upload_error_unavailable': {
    en: "Image uploads aren't available right now. Try again later.",
    fr: "Le téléversement d'images n'est pas offert pour le moment. Réessayez plus tard.",
  },
  'affiliates.portal.upload_error_generic': { en: "The upload didn't work. Try again.", fr: "Le téléversement n'a pas fonctionné. Réessayez." },

  // Payouts page
  'affiliates.portal.payouts_meta_title': { en: 'Payouts', fr: 'Versements' },
  'affiliates.portal.payouts_title': { en: 'Payouts', fr: 'Versements' },
  'affiliates.portal.payouts_description': {
    en: 'Your commissions clear after the refund window, then go to your bank automatically through Stripe.',
    fr: 'Vos commissions sont confirmées après la période de remboursement, puis versées automatiquement dans votre compte bancaire par Stripe.',
  },
  // Manual payouts (affiliates_settings.payoutMethods, 02036): every commission paid by hand
  // (_manual), or some through Stripe and the others by hand (_mixed). {site} is the site title.
  // Seeded by migration 02036, like every key down to faq_payout_answer_mixed that mentions it.
  'affiliates.portal.payouts_description_manual': {
    en: 'Your commissions clear after the refund window, then {site} sends them to you directly, by PayPal or Interac e-Transfer.',
    fr: 'Vos commissions sont confirmées après la période de remboursement, puis {site} vous les envoie directement, par PayPal ou virement Interac.',
  },
  'affiliates.portal.payouts_description_mixed': {
    en: 'Your commissions clear after the refund window. Depending on the order, they then go to your bank through Stripe, or {site} sends them to you directly.',
    fr: 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite versées dans votre compte bancaire par Stripe, ou {site} vous les envoie directement.',
  },
  // Every kind of order paid with PayPal Payouts (02037): automatic to a PayPal account, or by hand
  // to a partner who chose Interac e-Transfer.
  'affiliates.portal.payouts_description_paypal': {
    en: 'Your commissions clear after the refund window, then go to your PayPal account automatically, or by Interac e-Transfer if you choose it.',
    fr: 'Vos commissions sont confirmées après la période de remboursement, puis envoyées automatiquement dans votre compte PayPal, ou par virement Interac si vous le choisissez.',
  },
  // Some kinds of order through Stripe Connect and the others with PayPal Payouts (02037).
  'affiliates.portal.payouts_description_stripe_paypal': {
    en: 'Your commissions clear after the refund window. Depending on the order, they then go to your bank through Stripe, or to your PayPal account automatically (or by Interac e-Transfer if you choose it).',
    fr: 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite versées dans votre compte bancaire par Stripe, ou envoyées automatiquement dans votre compte PayPal (ou par virement Interac si vous le choisissez).',
  },
  // Some kinds of order with PayPal Payouts and the others sent by hand (02037).
  'affiliates.portal.payouts_description_paypal_manual': {
    en: 'Your commissions clear after the refund window. Depending on the order, they then go to your PayPal account automatically (or by Interac e-Transfer if you choose it), or {site} sends them to you directly.',
    fr: 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite envoyées automatiquement dans votre compte PayPal (ou par virement Interac si vous le choisissez), ou {site} vous les envoie directement.',
  },
  // The "How you get paid" card, shown while some gateway is paid by hand (or with PayPal, 02037).
  'affiliates.portal.payout_methods_title': { en: 'How you get paid', fr: 'Comment vous êtes payé' },
  'affiliates.portal.payout_methods_manual': {
    en: '{site} sends your commissions to you directly, by PayPal or Interac e-Transfer.',
    fr: '{site} vous envoie vos commissions directement, par PayPal ou virement Interac.',
  },
  'affiliates.portal.payout_methods_mixed_intro': {
    en: 'How a commission is paid depends on how the order was paid.',
    fr: "Le mode de versement d'une commission dépend du mode de paiement de la commande.",
  },
  'affiliates.portal.payout_methods_orders_stripe': { en: 'Orders paid through Stripe', fr: 'Commandes payées par Stripe' },
  'affiliates.portal.payout_methods_orders_freemius': { en: 'Orders paid through Freemius', fr: 'Commandes payées par Freemius' },
  'affiliates.portal.payout_methods_by_stripe': {
    en: 'Your commissions are transferred to your Stripe account.',
    fr: 'Vos commissions sont virées dans votre compte Stripe.',
  },
  'affiliates.portal.payout_methods_by_site': {
    en: 'Your commissions are sent to you directly by {site}, by PayPal or Interac e-Transfer.',
    fr: 'Vos commissions vous sont envoyées directement par {site}, par PayPal ou virement Interac.',
  },
  // A kind of order paid with PayPal Payouts (02037), the card's one sentence when every kind is.
  'affiliates.portal.payout_methods_by_paypal': {
    en: 'Your commissions are sent to your PayPal account automatically, or by Interac e-Transfer if you choose it.',
    fr: 'Vos commissions sont envoyées automatiquement dans votre compte PayPal, ou par virement Interac si vous le choisissez.',
  },
  // PayPal returned the last payout sent to the partner's current PayPal email: the run does not send
  // there again until the partner saves their payout email again (a new address, or the same one once
  // their PayPal account can take it: payout_email_retry_paypal), and the store pays them by hand
  // meanwhile (02037).
  'affiliates.portal.payout_paypal_returned_notice': {
    en: 'PayPal returned the last payout sent to {email}. Check that it is the email of your PayPal account (or open and confirm a PayPal account with it), then save it again below, or choose Interac e-Transfer. Until you do, {site} pays you by hand.',
    fr: "PayPal a retourné le dernier versement envoyé à {email}. Vérifiez qu'il s'agit bien du courriel de votre compte PayPal (ou ouvrez et confirmez un compte PayPal avec ce courriel), puis enregistrez-le de nouveau ci-dessous, ou choisissez le virement Interac. D'ici là, {site} vous paie manuellement.",
  },
  // The button that saves the same PayPal email again after PayPal returned a payout from it (02037),
  // and what the form says once it is saved.
  'affiliates.portal.payout_email_retry_paypal': {
    en: 'I checked it: try PayPal again',
    fr: "Je l'ai vérifié : réessayer PayPal",
  },
  'affiliates.portal.payout_email_retry_saved': {
    en: 'Saved: PayPal is tried at this address again with your next payout.',
    fr: 'Enregistré : PayPal sera réessayé à cette adresse lors de votre prochain versement.',
  },
  // The payout email form. Since 02037 the partner chooses PayPal or Interac e-Transfer first
  // (affiliate_profiles.payout_email_kind): payout_email_label is now the question above that choice
  // and payout_email_help the PayPal warning (both reworded by 02037, keys kept).
  'affiliates.portal.payout_email_label': {
    en: 'How do you want to receive your payouts?',
    fr: 'Comment voulez-vous recevoir vos versements?',
  },
  'affiliates.portal.payout_email_help': {
    en: 'Use the email of your PayPal account. A payout to an address without a confirmed PayPal account waits 30 days to be claimed, then returns.',
    fr: "Utilisez le courriel de votre compte PayPal. Un versement envoyé à une adresse sans compte PayPal confirmé attend 30 jours d'être réclamé, puis il est retourné.",
  },
  'affiliates.portal.payout_kind_paypal': { en: 'PayPal', fr: 'PayPal' },
  'affiliates.portal.payout_kind_interac': { en: 'Interac e-Transfer', fr: 'Virement Interac' },
  'affiliates.portal.payout_email_paypal_label': { en: 'Email of your PayPal account', fr: 'Courriel de votre compte PayPal' },
  'affiliates.portal.payout_email_paypal_confirm_label': { en: 'Confirm your PayPal email', fr: 'Confirmez votre courriel PayPal' },
  // Under the PayPal email while it is new for PayPal: a confirmation field follows (02037).
  'affiliates.portal.payout_email_paypal_confirm_hint': {
    en: 'A new PayPal email is typed twice: confirm it in the next field.',
    fr: 'Un nouveau courriel PayPal doit être entré deux fois : confirmez-le dans le champ suivant.',
  },
  'affiliates.portal.payout_email_interac_label': { en: 'Email for Interac e-Transfers', fr: 'Courriel pour les virements Interac' },
  // _help while some kind of order is paid with PayPal Payouts (automatic); _help_manual while the
  // store pays every commission outside Stripe by hand (PayPal ones too).
  'affiliates.portal.payout_email_interac_help': {
    en: 'Interac e-Transfers are sent by {site} by hand, usually less often.',
    fr: 'Les virements Interac sont envoyés manuellement par {site}, habituellement moins souvent.',
  },
  'affiliates.portal.payout_email_interac_help_manual': {
    en: '{site} sends Interac e-Transfers by hand.',
    fr: '{site} envoie les virements Interac manuellement.',
  },
  'affiliates.portal.payout_email_remove': { en: 'Remove', fr: 'Retirer' },
  'affiliates.portal.payout_email_saved': { en: 'Payout email saved.', fr: 'Courriel de versement enregistré.' },
  'affiliates.portal.payout_email_removed': { en: 'Payout email removed.', fr: 'Courriel de versement retiré.' },
  'affiliates.portal.connect_title': { en: 'Bank payouts', fr: 'Versements bancaires' },
  'affiliates.portal.connect_sandbox': {
    en: "Payouts are turned off in this demo, so Stripe can't be connected here.",
    fr: 'Les versements sont désactivés dans cette démo; Stripe ne peut donc pas être connecté ici.',
  },
  'affiliates.portal.connect_not_configured': {
    en: "Bank payouts aren't available on this store yet. Once the store finishes setting up its payment account, you can connect your bank account here. The commissions you earn until then are kept.",
    fr: "Les versements bancaires ne sont pas encore offerts sur cette boutique. Dès que la boutique aura terminé la configuration de son compte de paiement, vous pourrez connecter votre compte bancaire ici. Les commissions gagnées d'ici là sont conservées.",
  },
  'affiliates.portal.connect_intro': {
    en: 'Connect a bank account through Stripe to receive your commissions automatically. Stripe handles identity checks and bank details securely; we never see them.',
    fr: "Connectez un compte bancaire par l'entremise de Stripe pour recevoir vos commissions automatiquement. Stripe s'occupe de façon sécurisée de la vérification d'identité et des coordonnées bancaires; nous n'y avons jamais accès.",
  },
  // While the store pays some commissions by hand (02036): Stripe pays only the others, whichever
  // kind of order the settings route to it ("How you get paid" says which).
  'affiliates.portal.connect_intro_partial': {
    en: 'Connect a bank account through Stripe to receive the commissions we pay through Stripe. Stripe handles identity checks and bank details securely; we never see them.',
    fr: "Connectez un compte bancaire par l'entremise de Stripe pour recevoir les commissions que nous payons par Stripe. Stripe s'occupe de façon sécurisée de la vérification d'identité et des coordonnées bancaires; nous n'y avons jamais accès.",
  },
  'affiliates.portal.connect_country': { en: 'Country of your bank account', fr: 'Pays de votre compte bancaire' },
  'affiliates.portal.connect_country_hint': { en: "This can't be changed later.", fr: 'Ce choix ne pourra pas être modifié par la suite.' },
  'affiliates.portal.connect_button': {
    en: 'Connect bank account (automated payouts)',
    fr: 'Connecter un compte bancaire (versements automatisés)',
  },
  'affiliates.portal.connect_opening': { en: 'Opening Stripe…', fr: 'Ouverture de Stripe…' },
  'affiliates.portal.connect_incomplete': {
    en: "Your Stripe account setup isn't finished yet.",
    fr: "La configuration de votre compte Stripe n'est pas terminée.",
  },
  'affiliates.portal.connect_review': {
    en: 'Stripe is reviewing your details. This usually takes a few minutes, sometimes longer.',
    fr: 'Stripe vérifie vos renseignements. Cela prend généralement quelques minutes, parfois plus.',
  },
  'affiliates.portal.connect_continue': { en: 'Continue setup', fr: 'Poursuivre la configuration' },
  'affiliates.portal.connect_check_status': { en: 'Check status', fr: "Vérifier l'état" },
  'affiliates.portal.connect_checking': { en: 'Checking your Stripe account…', fr: 'Vérification de votre compte Stripe…' },
  'affiliates.portal.connect_ready': { en: 'Automated payouts are on', fr: 'Les versements automatisés sont activés' },
  'affiliates.portal.connect_ready_body': {
    en: 'Cleared commissions are sent to your bank automatically. Manage your bank details and see transfers in your Stripe Express dashboard.',
    fr: 'Les commissions confirmées sont versées automatiquement dans votre compte bancaire. Gérez vos coordonnées bancaires et consultez vos virements dans votre tableau de bord Stripe Express.',
  },
  'affiliates.portal.connect_ready_body_partial': {
    en: 'Cleared commissions we pay through Stripe are sent to your bank automatically. Manage your bank details and see transfers in your Stripe Express dashboard.',
    fr: 'Les commissions confirmées que nous payons par Stripe sont versées automatiquement dans votre compte bancaire. Gérez vos coordonnées bancaires et consultez vos virements dans votre tableau de bord Stripe Express.',
  },
  'affiliates.portal.connect_dashboard': { en: 'Open my Stripe Express dashboard', fr: 'Ouvrir mon tableau de bord Stripe Express' },
  'affiliates.portal.connect_ready_message': {
    en: 'Your Stripe account is ready. Payouts are on.',
    fr: 'Votre compte Stripe est prêt. Les versements sont activés.',
  },
  'affiliates.portal.connect_incomplete_message': {
    en: 'Stripe still needs a few details. Continue the setup to turn on payouts.',
    fr: 'Stripe a encore besoin de quelques renseignements. Poursuivez la configuration pour activer les versements.',
  },
  'affiliates.portal.connect_error_return': {
    en: "We couldn't reopen Stripe's setup. Try again.",
    fr: 'Impossible de rouvrir la configuration de Stripe. Réessayez.',
  },
  'affiliates.portal.balance_title': { en: 'Your balance', fr: 'Votre solde' },
  'affiliates.portal.balance_pending': {
    en: 'Pending ({days}-day refund window)',
    fr: 'En attente (période de remboursement de {days} jours)',
  },
  'affiliates.portal.balance_pending_hint': { en: 'Next commission clears on {date}.', fr: 'Prochaine confirmation le {date}.' },
  'affiliates.portal.balance_pending_hint_empty': { en: 'Nothing pending right now.', fr: 'Rien en attente pour le moment.' },
  'affiliates.portal.balance_cleared': { en: 'Cleared, awaiting payout', fr: 'Confirmé, en attente de versement' },
  'affiliates.portal.balance_cleared_hint': {
    en: 'Paid automatically once it reaches {min}.',
    fr: "Versé automatiquement dès qu'il atteint {min}.",
  },
  // Every commission paid by hand (02036), or some through Stripe and the others by hand: {stripe}
  // and {manual} split the cleared amount.
  'affiliates.portal.balance_cleared_manual_hint': {
    en: 'Paid by {site} once it reaches {min}.',
    fr: 'Versé par {site} une fois le minimum de {min} atteint.',
  },
  'affiliates.portal.balance_cleared_mixed_hint': {
    en: '{stripe} goes by Stripe transfer and {manual} is paid by {site}, each once it reaches {min}.',
    fr: '{stripe} part par virement Stripe et {manual} est versé par {site}, chacun une fois le minimum de {min} atteint.',
  },
  // 02037: the commissions PayPal pays this partner automatically ({paypal}), alone or beside the
  // Stripe ones or the ones the store pays by hand.
  'affiliates.portal.balance_cleared_paypal_hint': {
    en: 'Sent by PayPal once it reaches {min}.',
    fr: 'Envoyé par PayPal une fois le minimum de {min} atteint.',
  },
  'affiliates.portal.balance_cleared_stripe_paypal_hint': {
    en: '{stripe} goes by Stripe transfer and {paypal} by PayPal, each once it reaches {min}.',
    fr: '{stripe} part par virement Stripe et {paypal} par PayPal, chacun une fois le minimum de {min} atteint.',
  },
  'affiliates.portal.balance_cleared_paypal_manual_hint': {
    en: '{paypal} goes by PayPal and {manual} is paid by {site}, each once it reaches {min}.',
    fr: '{paypal} part par PayPal et {manual} est versé par {site}, chacun une fois le minimum de {min} atteint.',
  },
  'affiliates.portal.balance_processing_hint': {
    en: '{amount} is on its way to your bank.',
    fr: '{amount} est en route vers votre compte bancaire.',
  },
  // A manual payout the store prepared and is sending (02036): no bank transfer through Stripe.
  'affiliates.portal.balance_processing_manual_hint': {
    en: "We're sending you {amount} directly.",
    fr: 'Nous vous envoyons {amount} directement.',
  },
  // A PayPal payout PayPal has not paid yet (02037), or one waiting for the partner to claim it.
  'affiliates.portal.balance_processing_paypal_hint': {
    en: '{amount} is on its way to your PayPal account.',
    fr: '{amount} est en route vers votre compte PayPal.',
  },
  'affiliates.portal.balance_unclaimed_paypal_hint': {
    en: '{amount} is waiting for you to claim it in PayPal.',
    fr: '{amount} attend que vous le réclamiez dans PayPal.',
  },
  'affiliates.portal.balance_failed_retry_hint': {
    en: "A transfer of {amount} failed. We'll try again automatically.",
    fr: 'Un virement de {amount} a échoué. Nous réessaierons automatiquement.',
  },
  'affiliates.portal.balance_failed_review_hint': {
    en: "A transfer of {amount} failed. We'll look into it and send it again.",
    fr: 'Un virement de {amount} a échoué. Nous allons vérifier la situation et vous le renvoyer.',
  },
  'affiliates.portal.balance_paid': { en: 'Paid out (lifetime)', fr: 'Versé (depuis le début)' },
  'affiliates.portal.balance_next_payout': { en: 'Next automated payout', fr: 'Prochain versement automatisé' },
  // The figure for the commissions paid by hand (02036).
  'affiliates.portal.balance_next_manual_payout': { en: 'Next payout from {site}', fr: 'Prochain versement de {site}' },
  // The figure for the commissions PayPal pays automatically (02037): the daily payout run sends them.
  'affiliates.portal.balance_next_paypal_payout': { en: 'Next PayPal payout', fr: 'Prochain versement PayPal' },
  'affiliates.portal.next_payout_scheduled_hint': {
    en: 'Estimate. Payouts run automatically once a day.',
    fr: 'Estimation. Les versements sont faits automatiquement une fois par jour.',
  },
  'affiliates.portal.next_payout_paused': { en: 'Paused', fr: 'En pause' },
  'affiliates.portal.next_payout_paused_hint': {
    en: 'Automated payouts are paused for now. Your balance is safe.',
    fr: 'Les versements automatisés sont en pause pour le moment. Votre solde est conservé.',
  },
  'affiliates.portal.next_payout_not_eligible': { en: 'After your first approval', fr: 'Après votre première approbation' },
  'affiliates.portal.next_payout_not_eligible_hint': {
    en: 'Payouts start once your storefront is approved.',
    fr: "Les versements commencent dès l'approbation de votre vitrine.",
  },
  'affiliates.portal.next_payout_connect': { en: 'Connect your bank account', fr: 'Connectez votre compte bancaire' },
  'affiliates.portal.next_payout_connect_hint': {
    en: 'Payouts start once Stripe confirms your account.',
    fr: 'Les versements commencent dès que Stripe confirme votre compte.',
  },
  'affiliates.portal.next_payout_below_minimum': { en: 'Below the minimum', fr: 'Sous le minimum' },
  'affiliates.portal.next_payout_below_minimum_hint': {
    en: 'Payouts start at {min}; {remaining} to go, counting commissions still pending.',
    fr: 'Les versements commencent à {min}; il manque {remaining}, en comptant les commissions en attente.',
  },
  // Nothing cleared or pending for this way of paying (a partner paid in full, or whose commissions
  // are all paid the other way, has earnings). Changed by migration 02036.
  'affiliates.portal.next_payout_none': { en: 'Nothing to pay out yet', fr: "Rien à verser pour l'instant" },
  'affiliates.portal.next_payout_none_hint': {
    en: 'Payouts start once your cleared balance reaches {min}.',
    fr: 'Les versements commencent dès que votre solde confirmé atteint {min}.',
  },
  // The next payout the operator sends by hand (02036): no date, no Stripe.
  'affiliates.portal.next_payout_email_required': { en: 'Add your payout email', fr: 'Ajoutez votre courriel de versement' },
  'affiliates.portal.next_payout_email_required_hint': {
    en: '{site} needs it to send your payouts.',
    fr: '{site} en a besoin pour vous envoyer vos versements.',
  },
  'affiliates.portal.next_payout_manual': { en: 'Paid by {site}', fr: 'Versé par {site}' },
  'affiliates.portal.next_payout_manual_ready_hint': {
    en: '{site} sends your cleared balance to {email} by PayPal or Interac e-Transfer.',
    fr: '{site} envoie votre solde confirmé à {email} par PayPal ou virement Interac.',
  },
  'affiliates.portal.next_payout_manual_clearing_hint': {
    en: 'Sent to {email} by PayPal or Interac e-Transfer once your cleared balance reaches {min}.',
    fr: 'Envoyé à {email} par PayPal ou virement Interac une fois que votre solde confirmé atteint {min}.',
  },
  // A manual payout is prepared (its amount is fixed) and on its way (02036).
  'affiliates.portal.next_payout_manual_sending_hint': {
    en: '{site} is sending you {amount}.',
    fr: '{site} vous envoie {amount}.',
  },
  // The automatic PayPal payouts (02037): nothing cleared yet, and a PayPal payout on its way.
  'affiliates.portal.next_payout_paypal_hint': {
    en: 'Sent by PayPal on the next daily run once you reach {min}.',
    fr: 'Envoyé par PayPal au prochain versement quotidien, une fois le minimum de {min} atteint.',
  },
  'affiliates.portal.next_payout_paypal_sending': { en: 'On its way', fr: 'En route' },
  'affiliates.portal.commissions_title': { en: 'Commissions', fr: 'Commissions' },
  'affiliates.portal.commissions_empty': { en: 'No commissions yet.', fr: "Aucune commission pour l'instant." },
  'affiliates.portal.payouts_history_title': { en: 'Payout history', fr: 'Historique des versements' },
  'affiliates.portal.payouts_empty': { en: 'No payouts yet.', fr: "Aucun versement pour l'instant." },

  // How payouts work
  'affiliates.portal.faq_title': { en: 'How payouts work', fr: 'Fonctionnement des versements' },
  'affiliates.portal.faq_earn_question': { en: 'What do I earn?', fr: 'Combien est-ce que je gagne?' },
  'affiliates.portal.faq_earn_answer': {
    en: "A share of each order you refer, based on your partner tier. It's calculated on the order total after discounts, without taxes or shipping.",
    fr: 'Une part de chaque commande que vous recommandez, selon votre niveau partenaire. Elle est calculée sur le total de la commande après rabais, sans les taxes ni la livraison.',
  },
  'affiliates.portal.faq_earn_answer_rate': {
    en: '{rate} of each order you refer, calculated on the order total after discounts, without taxes or shipping.',
    fr: '{rate} de chaque commande que vous recommandez, calculé sur le total de la commande après rabais, sans les taxes ni la livraison.',
  },
  'affiliates.portal.faq_renewals_question': {
    en: 'Do renewals and subscriptions earn?',
    fr: 'Les renouvellements et les abonnements rapportent-ils?',
  },
  'affiliates.portal.faq_renewals_answer': {
    en: "No. A commission is earned once, when an order you referred is first paid. Renewals and later subscription payments don't earn; a free trial earns when it converts to a paid order.",
    fr: "Non. Une commission est gagnée une seule fois, au premier paiement d'une commande que vous avez recommandée. Les renouvellements et les paiements d'abonnement suivants ne rapportent rien; un essai gratuit rapporte lorsqu'il devient une commande payée.",
  },
  'affiliates.portal.faq_hold_question': { en: 'Why is a commission pending?', fr: 'Pourquoi une commission est-elle en attente?' },
  'affiliates.portal.faq_hold_answer': {
    en: 'Each commission waits {days} days so refunds can be handled. A refunded order cancels its commission; a partial refund reduces it.',
    fr: 'Chaque commission attend {days} jours afin de permettre le traitement des remboursements. Une commande remboursée annule sa commission; un remboursement partiel la réduit.',
  },
  'affiliates.portal.faq_payout_question': { en: 'When am I paid?', fr: 'Quand est-ce que je reçois mes versements?' },
  'affiliates.portal.faq_payout_answer': {
    en: 'Once your cleared balance reaches {min}, it is sent automatically to your bank account through Stripe in the next daily payout run.',
    fr: 'Dès que votre solde confirmé atteint {min}, il est versé automatiquement dans votre compte bancaire par Stripe lors du prochain versement quotidien.',
  },
  'affiliates.portal.faq_payout_answer_manual': {
    en: 'Once your cleared balance reaches {min}, {site} sends it to you directly, by PayPal or Interac e-Transfer. Each payout then appears in your payout history.',
    fr: "Une fois que votre solde confirmé atteint {min}, {site} vous l'envoie directement, par PayPal ou virement Interac. Chaque versement apparaît ensuite dans votre historique des versements.",
  },
  'affiliates.portal.faq_payout_answer_mixed': {
    en: 'It depends on the order: “How you get paid” above says which commissions go through Stripe. Those go to your bank in the daily payout run once they reach {min}. {site} sends you the others directly, by PayPal or Interac e-Transfer, once they reach the same minimum.',
    fr: "Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions passent par Stripe. Celles-ci sont versées dans votre compte bancaire lors du versement quotidien, dès qu'elles atteignent {min}. {site} vous envoie les autres directement, par PayPal ou virement Interac, une fois ce même minimum atteint.",
  },
  // Every kind of order paid with PayPal Payouts (02037).
  'affiliates.portal.faq_payout_answer_paypal': {
    en: 'Once your cleared balance reaches {min}, the next daily payout run sends it to your PayPal account. If you chose Interac e-Transfer, {site} sends it by hand instead.',
    fr: "Dès que votre solde confirmé atteint {min}, le prochain versement quotidien l'envoie dans votre compte PayPal. Si vous avez choisi le virement Interac, {site} vous l'envoie plutôt manuellement.",
  },
  // Some kinds of order through Stripe Connect, the others with PayPal Payouts (02037).
  'affiliates.portal.faq_payout_answer_stripe_paypal': {
    en: 'It depends on the order: “How you get paid” above says which commissions go through Stripe and which go to PayPal. Each kind is sent in the daily payout run once it reaches {min}: to your bank through Stripe, or to your PayPal account. If you chose Interac e-Transfer, {site} sends the PayPal ones by hand instead.',
    fr: "Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions passent par Stripe et lesquelles vont à PayPal. Chacune est envoyée lors du versement quotidien dès qu'elle atteint {min} : dans votre compte bancaire par Stripe, ou dans votre compte PayPal. Si vous avez choisi le virement Interac, {site} vous envoie plutôt manuellement celles de PayPal.",
  },
  // Some kinds of order with PayPal Payouts, the others sent by hand (02037).
  'affiliates.portal.faq_payout_answer_paypal_manual': {
    en: 'It depends on the order: “How you get paid” above says which commissions go to PayPal. Those are sent to your PayPal account in the daily payout run once they reach {min}, or by hand if you chose Interac e-Transfer. {site} sends you the others directly, once they reach the same minimum.',
    fr: "Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions vont à PayPal. Celles-ci sont envoyées dans votre compte PayPal lors du versement quotidien dès qu'elles atteignent {min}, ou manuellement si vous avez choisi le virement Interac. {site} vous envoie les autres directement, une fois ce même minimum atteint.",
  },
  'affiliates.portal.faq_window_question': { en: 'How long does a referral last?', fr: 'Combien de temps dure une recommandation?' },
  'affiliates.portal.faq_window_answer': {
    en: "A visitor who arrives through your link is credited to you for {days} days, unless they later follow another partner's link.",
    fr: "Un visiteur arrivé par votre lien vous est attribué pendant {days} jours, sauf s'il suit ensuite le lien d'un autre partenaire.",
  },
  'affiliates.portal.faq_terms_question': { en: 'Where are the program rules?', fr: 'Où trouver les règles du programme?' },
  'affiliates.portal.faq_terms_link': { en: 'Read the partner terms', fr: 'Lire les conditions du programme partenaires' },
} as const satisfies AffiliatesCopyDictionary;

/** A key of the portal dictionary. */
export type AffiliatesPortalCopyKey = keyof typeof AFFILIATES_PORTAL_COPY;
