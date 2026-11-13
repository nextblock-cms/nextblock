/**
 * Copy of the affiliate lifecycle emails and CMS alerts (SPEC §9). Internal: not seeded into the
 * `translations` table (emails are rendered server-side from these strings only).
 *
 * - Partner emails: English and Québec French (courriel, a space before ":" and "%"; the renderer
 *   turns that space into a no-break space).
 * - Admin emails and CMS alerts: English only, like every other CMS screen.
 *
 * Placeholders are `{name}`, each at most once per string. `{rate}` is already formatted with its
 * percent sign (`50%`, `50 %`), `{amount}` and `{date}` are formatted by the app per locale.
 */
import type { AffiliatesCopyEntry } from '../i18n/types';

export const AFFILIATE_PARTNER_EMAIL_COPY = {
  'common.greeting_named': { en: 'Hi {name},', fr: 'Bonjour {name},' },
  'common.greeting': { en: 'Hi there,', fr: 'Bonjour,' },
  'common.button_fallback': {
    en: 'If the button does not work, copy this address into your browser:',
    fr: 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
  },
  'common.signature': { en: 'The {siteName} team', fr: 'L’équipe {siteName}' },
  'common.footer': {
    en: 'You are receiving this email because you are a partner of {siteName}.',
    fr: 'Vous recevez ce courriel parce que vous êtes partenaire de {siteName}.',
  },
  'common.store_fallback': { en: 'our store', fr: 'notre boutique' },

  'page_published.subject': { en: 'Your storefront is live on {siteName}', fr: 'Votre vitrine est en ligne sur {siteName}' },
  'page_published.preheader': {
    en: 'Share your link: every order placed through it earns you a commission.',
    fr: 'Partagez votre lien : chaque commande passée par ce lien vous rapporte une commission.',
  },
  'page_published.heading': { en: 'Your storefront is live!', fr: 'Votre vitrine est en ligne!' },
  'page_published.body': {
    en: 'Good news: we reviewed your storefront and it is now published. Share your link with your audience; every order placed through it earns you a commission.',
    fr: 'Bonne nouvelle : nous avons révisé votre vitrine et elle est maintenant publiée. Partagez votre lien avec votre communauté; chaque commande passée par ce lien vous rapporte une commission.',
  },
  'page_published.cta': { en: 'View your storefront', fr: 'Voir votre vitrine' },
  'page_published.portal_hint': {
    en: 'You can edit your page at any time from your partner portal; changes are reviewed before they go live.',
    fr: 'Vous pouvez modifier votre page en tout temps depuis votre portail partenaire; les changements sont révisés avant leur mise en ligne.',
  },
  'page_published.share_heading': { en: 'Share your storefront', fr: 'Partagez votre vitrine' },
  'page_published.share_text': { en: 'My favorite picks from {siteName}', fr: 'Mes coups de cœur chez {siteName}' },
  'page_published.share_x': { en: 'Share on X', fr: 'Partager sur X' },
  'page_published.share_facebook': { en: 'Share on Facebook', fr: 'Partager sur Facebook' },
  'page_published.share_linkedin': { en: 'Share on LinkedIn', fr: 'Partager sur LinkedIn' },
  'page_published.share_pinterest': { en: 'Pin on Pinterest', fr: 'Épingler sur Pinterest' },
  'page_published.share_email': { en: 'Send by email', fr: 'Envoyer par courriel' },

  'changes_requested.subject': { en: 'Changes requested on your storefront', fr: 'Modifications demandées pour votre vitrine' },
  'changes_requested.preheader': {
    en: 'Your storefront needs a few changes before it can be published.',
    fr: 'Votre vitrine a besoin de quelques modifications avant d’être publiée.',
  },
  'changes_requested.heading': { en: 'A few changes before we publish', fr: 'Quelques modifications avant la publication' },
  'changes_requested.body': {
    en: 'We reviewed your storefront and it needs a few changes before it can go live.',
    fr: 'Nous avons révisé votre vitrine et elle a besoin de quelques modifications avant sa mise en ligne.',
  },
  'changes_requested.note_label': { en: 'Note from our team', fr: 'Note de notre équipe' },
  'changes_requested.no_note': {
    en: 'Open your storefront in the partner portal to see what needs to change.',
    fr: 'Ouvrez votre vitrine dans le portail partenaire pour voir ce qui doit changer.',
  },
  'changes_requested.next_step': {
    en: 'Update your page, then submit it for review again.',
    fr: 'Mettez votre page à jour, puis soumettez-la de nouveau pour révision.',
  },
  'changes_requested.cta': { en: 'Edit your storefront', fr: 'Modifier votre vitrine' },

  'commission_earned.subject': { en: 'You just earned a commission', fr: 'Vous venez de gagner une commission' },
  'commission_earned.subject_amount': { en: 'You just earned {amount}', fr: 'Vous venez de gagner {amount}' },
  'commission_earned.heading': { en: 'You just earned a commission', fr: 'Vous venez de gagner une commission' },
  'commission_earned.line_full': {
    en: 'You just earned {rate} ({amount}) — it clears on {date}.',
    fr: 'Vous venez de gagner {rate} ({amount}) — la commission sera confirmée le {date}.',
  },
  'commission_earned.line_rate': { en: 'You just earned {rate} ({amount}).', fr: 'Vous venez de gagner {rate} ({amount}).' },
  'commission_earned.line_date': {
    en: 'You just earned {amount} — it clears on {date}.',
    fr: 'Vous venez de gagner {amount} — la commission sera confirmée le {date}.',
  },
  'commission_earned.line_amount': { en: 'You just earned {amount}.', fr: 'Vous venez de gagner {amount}.' },
  'commission_earned.line_generic': {
    en: 'You just earned a commission on an order placed through your storefront.',
    fr: 'Vous venez de gagner une commission sur une commande passée par votre vitrine.',
  },
  'commission_earned.explain': {
    en: 'Commissions are held during the refund window, then paid out automatically to your bank account through Stripe.',
    fr: 'Les commissions sont retenues pendant la période de remboursement, puis versées automatiquement dans votre compte bancaire par Stripe.',
  },
  // A commission the program pays outside Stripe (affiliates_settings.payoutMethods, 02036).
  'commission_earned.explain_manual': {
    en: 'Commissions are held during the refund window, then paid to you directly (by PayPal, Interac e-Transfer or bank transfer) and recorded in your partner portal.',
    fr: 'Les commissions sont retenues pendant la période de remboursement, puis vous sont versées directement (par PayPal, virement Interac ou virement bancaire) et inscrites dans votre portail partenaire.',
  },
  'commission_earned.cta': { en: 'View your earnings', fr: 'Voir vos gains' },

  'payout_sent.subject': { en: 'Your payout is on its way', fr: 'Votre versement est en route' },
  'payout_sent.subject_amount': { en: 'Your payout of {amount} is on its way', fr: 'Votre versement de {amount} est en route' },
  'payout_sent.heading': { en: 'Your payout is on its way', fr: 'Votre versement est en route' },
  'payout_sent.line': {
    en: 'Your automated payout has been sent to your bank via Stripe.',
    fr: 'Votre versement automatique a été envoyé à votre banque par Stripe.',
  },
  'payout_sent.line_amount': {
    en: 'Your automated payout of {amount} has been sent to your bank via Stripe.',
    fr: 'Votre versement automatique de {amount} a été envoyé à votre banque par Stripe.',
  },
  'payout_sent.timing': {
    en: 'Funds usually reach your account within a few business days, depending on your bank.',
    fr: 'Les fonds arrivent habituellement dans votre compte en quelques jours ouvrables, selon votre banque.',
  },
  'payout_sent.amount_label': { en: 'Amount', fr: 'Montant' },
  'payout_sent.transfer_label': { en: 'Stripe transfer', fr: 'Virement Stripe' },
  'payout_sent.cta': { en: 'View your payouts', fr: 'Voir vos versements' },
  // A payout the operator sent outside Stripe (PayPal, Interac e-Transfer, Wise, a bank) and
  // recorded in the CMS (02036). `{channel}` is one of the payout_sent.channel_* phrases below.
  'payout_sent.manual_subject': { en: 'We sent you {amount}', fr: 'Nous vous avons envoyé {amount}' },
  'payout_sent.manual_subject_generic': { en: 'We sent your payout', fr: 'Nous avons envoyé votre versement' },
  'payout_sent.manual_heading': { en: 'Your payout was sent', fr: 'Votre versement a été envoyé' },
  'payout_sent.manual_line': {
    en: 'We sent you {amount} by {channel}. Reference: {reference}.',
    fr: 'Nous vous avons envoyé {amount} par {channel}. Référence : {reference}.',
  },
  'payout_sent.manual_line_no_reference': { en: 'We sent you {amount} by {channel}.', fr: 'Nous vous avons envoyé {amount} par {channel}.' },
  'payout_sent.manual_line_generic': { en: 'We sent your payout by {channel}.', fr: 'Nous avons envoyé votre versement par {channel}.' },
  'payout_sent.manual_timing': {
    en: 'Depending on the service, the money can take a few business days to reach you. Contact us if it has not arrived by then.',
    fr: 'Selon le service, l’argent peut prendre quelques jours ouvrables à vous parvenir. Communiquez avec nous s’il n’est pas arrivé d’ici là.',
  },
  'payout_sent.reference_label': { en: 'Reference', fr: 'Référence' },
  'payout_sent.note_label': { en: 'Note from our team', fr: 'Note de notre équipe' },
  'payout_sent.channel_paypal': { en: 'PayPal', fr: 'PayPal' },
  'payout_sent.channel_interac': { en: 'Interac e-Transfer', fr: 'virement Interac' },
  'payout_sent.channel_wise': { en: 'Wise', fr: 'Wise' },
  'payout_sent.channel_bank_transfer': { en: 'bank transfer', fr: 'virement bancaire' },
  'payout_sent.channel_other': { en: 'another payment method', fr: 'un autre mode de paiement' },
  // A payout PayPal paid into the partner's PayPal account (02037, automatic PayPal Payouts): sent only
  // once PayPal reports the item SUCCESS, so the money is there. The reference is PayPal's transaction id.
  'payout_sent.paypal_subject': { en: 'We sent you {amount} by PayPal', fr: 'Nous vous avons envoyé {amount} par PayPal' },
  'payout_sent.paypal_subject_generic': { en: 'We sent your payout by PayPal', fr: 'Nous avons envoyé votre versement par PayPal' },
  'payout_sent.paypal_heading': { en: 'Your PayPal payout arrived', fr: 'Votre versement PayPal est arrivé' },
  'payout_sent.paypal_line': { en: 'We sent you {amount} by PayPal.', fr: 'Nous vous avons envoyé {amount} par PayPal.' },
  'payout_sent.paypal_line_generic': { en: 'We sent your payout by PayPal.', fr: 'Nous avons envoyé votre versement par PayPal.' },
  'payout_sent.paypal_timing': {
    en: 'The money is in your PayPal account now.',
    fr: 'L’argent est maintenant dans votre compte PayPal.',
  },
  'payout_sent.paypal_transaction_label': { en: 'PayPal transaction', fr: 'Transaction PayPal' },

  // A PayPal payout that waits for the partner to claim it (02037: the item is UNCLAIMED, usually an
  // address without a confirmed PayPal account). PayPal emails its own claim link and returns the
  // money after 30 days; the payout then fails and its commissions go back to the balance. A new
  // payout email changes the next payout, not this one.
  'paypal_unclaimed.subject': {
    en: 'Your PayPal payment of {amount} is waiting',
    fr: 'Votre paiement PayPal de {amount} vous attend',
  },
  'paypal_unclaimed.subject_generic': { en: 'Your PayPal payment is waiting', fr: 'Votre paiement PayPal vous attend' },
  'paypal_unclaimed.heading': { en: 'Claim your PayPal payment', fr: 'Réclamez votre paiement PayPal' },
  'paypal_unclaimed.line': {
    en: 'Your PayPal payment of {amount} is waiting: claim it from the email PayPal sent to {email}, or update your payout email in the portal.',
    fr: 'Votre paiement PayPal de {amount} vous attend : réclamez-le à partir du courriel que PayPal a envoyé à {email}, ou modifiez votre courriel de versement dans le portail.',
  },
  'paypal_unclaimed.line_no_email': {
    en: 'Your PayPal payment of {amount} is waiting: claim it from the email PayPal sent you, or update your payout email in the portal.',
    fr: 'Votre paiement PayPal de {amount} vous attend : réclamez-le à partir du courriel que PayPal vous a envoyé, ou modifiez votre courriel de versement dans le portail.',
  },
  'paypal_unclaimed.line_generic': {
    en: 'Your PayPal payment is waiting: claim it from the email PayPal sent you, or update your payout email in the portal.',
    fr: 'Votre paiement PayPal vous attend : réclamez-le à partir du courriel que PayPal vous a envoyé, ou modifiez votre courriel de versement dans le portail.',
  },
  'paypal_unclaimed.explain': {
    en: 'PayPal keeps an unclaimed payment for 30 days, then returns it to us. A new payout email is used from your next payout: once this one comes back, the amount goes back to your balance and is sent to your new address.',
    fr: 'PayPal garde un paiement non réclamé pendant 30 jours, puis nous le retourne. Un nouveau courriel de versement s’applique à partir de votre prochain versement : une fois celui-ci retourné, le montant revient dans votre solde et est envoyé à votre nouvelle adresse.',
  },
  'paypal_unclaimed.cta': { en: 'Check your payout email', fr: 'Vérifier votre courriel de versement' },

  // The partner's side of a PayPal payout PayPal will not pay (02037: returned, refused for the
  // receiver, blocked, or cancelled before it was claimed). Its commissions are already back in the
  // balance. {reason} is one of the paypal_payout_failed.reason_* phrases, never PayPal's code.
  // `line` promises a retry: only for failures the run does try again. A failure caused by the address
  // (isAffiliatePayPalReceiverFailureReason: returned, blocked, refunded, reversed, cancelled, refused
  // for the receiver) stops PayPal at that address until the partner saves their payout email again,
  // and the store pays by hand meanwhile: `line_receiver` says so.
  'paypal_payout_failed.subject': {
    en: 'Your PayPal payout of {amount} could not be sent',
    fr: 'Votre versement PayPal de {amount} n’a pas pu être envoyé',
  },
  'paypal_payout_failed.subject_generic': { en: 'Your PayPal payout could not be sent', fr: 'Votre versement PayPal n’a pas pu être envoyé' },
  'paypal_payout_failed.heading': { en: 'Your PayPal payout could not be sent', fr: 'Votre versement PayPal n’a pas pu être envoyé' },
  'paypal_payout_failed.line': {
    en: 'Your PayPal payout of {amount} could not be sent: {reason}. Check your payout email in the portal; we’ll try again on the next run.',
    fr: 'Votre versement PayPal de {amount} n’a pas pu être envoyé : {reason}. Vérifiez votre courriel de versement dans le portail; nous réessaierons au prochain cycle de versement.',
  },
  'paypal_payout_failed.line_generic': {
    en: 'Your PayPal payout could not be sent: {reason}. Check your payout email in the portal; we’ll try again on the next run.',
    fr: 'Votre versement PayPal n’a pas pu être envoyé : {reason}. Vérifiez votre courriel de versement dans le portail; nous réessaierons au prochain cycle de versement.',
  },
  'paypal_payout_failed.line_receiver': {
    en: 'Your PayPal payout of {amount} was not paid: {reason}. In the portal, check that your payout email is the email of your PayPal account and save it again, or choose Interac e-Transfer. Until then, we pay you by hand.',
    fr: 'Votre versement PayPal de {amount} n’a pas été payé : {reason}. Dans le portail, vérifiez que votre courriel de versement est celui de votre compte PayPal et enregistrez-le de nouveau, ou choisissez le virement Interac. D’ici là, nous vous payons manuellement.',
  },
  'paypal_payout_failed.line_receiver_generic': {
    en: 'Your PayPal payout was not paid: {reason}. In the portal, check that your payout email is the email of your PayPal account and save it again, or choose Interac e-Transfer. Until then, we pay you by hand.',
    fr: 'Votre versement PayPal n’a pas été payé : {reason}. Dans le portail, vérifiez que votre courriel de versement est celui de votre compte PayPal et enregistrez-le de nouveau, ou choisissez le virement Interac. D’ici là, nous vous payons manuellement.',
  },
  'paypal_payout_failed.balance': { en: 'The amount is back in your balance.', fr: 'Le montant est de retour dans votre solde.' },
  'paypal_payout_failed.reason_unclaimed': { en: 'nobody claimed it within 30 days', fr: 'personne ne l’a réclamé dans les 30 jours' },
  'paypal_payout_failed.reason_unregistered': {
    en: 'this email has no PayPal account',
    fr: 'ce courriel n’est lié à aucun compte PayPal',
  },
  'paypal_payout_failed.reason_receiver': { en: 'PayPal could not pay this account', fr: 'PayPal n’a pas pu payer ce compte' },
  'paypal_payout_failed.reason_cancelled': {
    en: 'it was cancelled before it was claimed',
    fr: 'il a été annulé avant d’être réclamé',
  },
  'paypal_payout_failed.reason_blocked': { en: 'PayPal blocked it', fr: 'PayPal l’a bloqué' },
  'paypal_payout_failed.reason_generic': { en: 'PayPal could not complete it', fr: 'PayPal n’a pas pu le compléter' },
  'paypal_payout_failed.cta': { en: 'Check your payout email', fr: 'Vérifier votre courriel de versement' },

  // The account state uses the portal's own words (`affiliates.portal.suspended_*`): the account
  // is suspended, the storefront and referral links are paused.
  'partner_suspended.subject': {
    en: 'Your partner account on {siteName} is suspended',
    fr: 'Votre compte partenaire sur {siteName} est suspendu',
  },
  'partner_suspended.heading': { en: 'Your partner account is suspended', fr: 'Votre compte partenaire est suspendu' },
  'partner_suspended.body': {
    en: 'We suspended your partner account on {siteName}. Your storefront is offline and your referral links are paused: orders placed through them while your account is suspended do not earn commissions.',
    fr: 'Nous avons suspendu votre compte partenaire sur {siteName}. Votre vitrine est hors ligne et vos liens de recommandation sont en pause : les commandes passées par ces liens pendant la suspension ne vous rapportent pas de commission.',
  },
  'partner_suspended.body_unpublished': {
    en: 'We suspended your partner account on {siteName}. You can’t edit or submit your storefront while your account is suspended.',
    fr: 'Nous avons suspendu votre compte partenaire sur {siteName}. Vous ne pouvez pas modifier ni soumettre votre vitrine pendant la suspension.',
  },
  'partner_suspended.balance': {
    en: 'The commissions you already earned stay in your balance, and payouts resume once your account is reactivated.',
    fr: 'Les commissions que vous avez déjà gagnées restent dans votre solde, et les versements reprendront à la réactivation de votre compte.',
  },
  'partner_suspended.reason_label': { en: 'Reason given', fr: 'Motif indiqué' },
  'partner_suspended.contact': {
    en: 'Contact us if you have questions.',
    fr: 'Communiquez avec nous si vous avez des questions.',
  },
  'partner_suspended.cta': { en: 'Open your partner portal', fr: 'Ouvrir votre portail partenaire' },

  'partner_reactivated.subject': {
    en: 'Your partner account on {siteName} is active again',
    fr: 'Votre compte partenaire sur {siteName} est de nouveau actif',
  },
  'partner_reactivated.heading': { en: 'Your partner account is active again', fr: 'Votre compte partenaire est de nouveau actif' },
  'partner_reactivated.body': {
    en: 'Good news: we reactivated your partner account on {siteName}. Your storefront is back online and your referral links earn commissions again.',
    fr: 'Bonne nouvelle : nous avons réactivé votre compte partenaire sur {siteName}. Votre vitrine est de nouveau en ligne et vos liens de recommandation vous rapportent de nouveau des commissions.',
  },
  'partner_reactivated.body_unpublished': {
    en: 'Good news: we reactivated your partner account on {siteName}. You can edit your storefront again and submit it for review.',
    fr: 'Bonne nouvelle : nous avons réactivé votre compte partenaire sur {siteName}. Vous pouvez de nouveau modifier votre vitrine et la soumettre pour révision.',
  },
  // What reconcile_affiliate_commissions (02030) really credits at the next payout run: orders
  // attributed before the suspension and paid during it, at most 120 days old. An order placed
  // during the suspension is attributed to nobody (partner_suspended.body says so).
  'partner_reactivated.balance': {
    en: 'Payouts resume. Orders placed through your links before the suspension and paid while it lasted earn their commission at the next payout run (orders up to 120 days old).',
    fr: 'Les versements reprennent. Les commandes passées par vos liens avant la suspension et payées pendant celle-ci vous rapportent leur commission au prochain cycle de versement (commandes de 120 jours ou moins).',
  },
  'partner_reactivated.cta': { en: 'Open your partner portal', fr: 'Ouvrir votre portail partenaire' },

  // Sent only when the admin ticks "Email the partner" on a tier move that went through. The rate
  // is stored on each order when it is paid (02035): the new one applies to orders paid from the
  // move on (not from the start of that day: an order paid that morning keeps the old rate), and
  // commissions already recorded keep the rate they were recorded at. "After this change" matches
  // the terms clause and stays true whenever the email is read.
  'tier_changed.subject': {
    en: 'Your partner tier on {siteName} changed',
    fr: 'Votre niveau de partenaire sur {siteName} a changé',
  },
  'tier_changed.heading': { en: 'Your partner tier changed', fr: 'Votre niveau de partenaire a changé' },
  'tier_changed.body': {
    en: 'We moved your partner account on {siteName} to the {tier} tier.',
    fr: 'Nous avons placé votre compte partenaire sur {siteName} au niveau {tier}.',
  },
  'tier_changed.body_generic': {
    en: 'We moved your partner account on {siteName} to another tier.',
    fr: 'Nous avons placé votre compte partenaire sur {siteName} à un autre niveau.',
  },
  'tier_changed.rate': { en: 'Your commission rate is now {rate}.', fr: 'Votre taux de commission est maintenant de {rate}.' },
  'tier_changed.applies': {
    en: 'The new rate applies to orders paid after this change. Commissions already recorded keep their rate.',
    fr: 'Le nouveau taux s’applique aux commandes payées après ce changement. Les commissions déjà inscrites conservent leur taux.',
  },
  'tier_changed.cta': { en: 'Open your partner portal', fr: 'Ouvrir votre portail partenaire' },
} as const satisfies Record<string, AffiliatesCopyEntry>;

export const AFFILIATE_ADMIN_EMAIL_COPY = {
  'common.button_fallback': 'If the button does not work, copy this address into your browser:',
  'common.footer':
    'You are receiving this email because you manage the affiliate program of {siteName}. Choose who receives these emails in CMS > Affiliates > Settings.',
  'common.partner_fallback': 'A partner',
  'common.store_fallback': 'your store',
  'label.partner': 'Partner',
  'label.handle': 'Handle',
  'label.storefront': 'Storefront',
  'label.tier': 'Tier',
  'label.spots': 'Spots left in this tier',
  'label.amount': 'Amount',
  'label.reason': 'Reason',
  'label.order': 'Order',
  'label.transfer': 'Stripe transfer',

  'signed_up.subject': 'New partner signup: {name}',
  'signed_up.heading': 'A new partner joined',
  'signed_up.body': '{name} signed up for the affiliate program.',
  'signed_up.tier_full': 'This tier is now full: new partners join the next default tier.',
  'signed_up.cta': 'Open affiliates',

  'profile_completed.subject': 'Partner profile completed: {name}',
  'profile_completed.heading': 'A partner completed their profile',
  // Neutral on purpose (02036): with commissions paid by hand the payouts step is a payout email, not Stripe.
  'profile_completed.body': '{name} added their bio and profile details. Their next step is setting up their payouts.',
  'profile_completed.cta': 'Open affiliates',

  'payout_configured.subject': 'Partner connected payouts: {name}',
  'payout_configured.heading': 'A partner connected Stripe payouts',
  'payout_configured.body': '{name} finished Stripe Connect onboarding and can now receive automated payouts.',
  'payout_configured.cta': 'Open affiliates',

  'page_submitted.subject': 'Storefront waiting for review: {name}',
  'page_submitted.heading': 'A storefront is waiting for review',
  'page_submitted.body': '{name} submitted their storefront for approval. Review the changes, then approve and publish it or request changes.',
  'page_submitted.cta': 'Review storefronts',

  'payout_failed.subject': 'Affiliate payout failed: {name}',
  'payout_failed.heading': 'An affiliate payout failed',
  'payout_failed.body': 'An automated payout to {name} failed.',
  'payout_failed.body_amount': 'The automated payout of {amount} to {name} failed.',
  // No retry promise: a low-balance failure is mailed only once its automatic retries are used up.
  'payout_failed.advice':
    'If the Stripe balance was too low, keep a minimum balance in Stripe or switch your Stripe payouts to manual (Stripe Dashboard > Settings > Payouts): Freemius sales never add money to your Stripe balance. For any other reason, check the partner’s Connect account. Once the cause is fixed, retry or release the payout from the payouts screen.',
  'payout_failed.cta': 'Review payouts',
  // A PayPal payout (02037) PayPal will not pay: failing it already handed its commissions back.
  'payout_failed.advice_paypal':
    'PayPal did not pay it, so its commissions went back to the cleared balance: the next payout run pays them again, unless the cause stays. Check the reason on the PayPal payouts screen. If the partner’s PayPal email is wrong, ask them to correct it in their partner portal, or pay them under Pay manually.',

  'refund_after_payout.subject': 'Refund after an affiliate payout: {name}',
  'refund_after_payout.heading': 'Refund after an affiliate payout',
  'refund_after_payout.body':
    'An order was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.',
  'refund_after_payout.body_order':
    'Order {order} was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.',
  // The commission was paid by a payout recorded by hand (02036): there is no Stripe transfer to
  // reverse, and nothing in the ledger deducts a refund from a later payout (it would record an
  // amount that was never sent). The database's own alert says the same
  // (private.affiliate_alert_refund_after_payout).
  'refund_after_payout.body_manual':
    'An order was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.',
  'refund_after_payout.body_order_manual':
    'Order {order} was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.',
  // Its manual payout is prepared (PROCESSING) but not recorded: the money may not have left yet.
  'refund_after_payout.body_manual_prepared':
    'An order was refunded after its commission was paid or queued. Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.',
  'refund_after_payout.body_order_manual_prepared':
    'Order {order} was refunded after its commission was paid or queued. Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.',
  // Its PayPal payout (02037) is still with PayPal (PROCESSING). A completed one gets the manual
  // advice above (recover the amount): PayPal cannot take a payout back. The database's own alert
  // says the same (private.affiliate_alert_refund_after_payout, 02037).
  'refund_after_payout.body_paypal_in_flight':
    'An order was refunded after its commission was paid or queued. Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.',
  'refund_after_payout.body_order_paypal_in_flight':
    'Order {order} was refunded after its commission was paid or queued. Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.',
  'refund_after_payout.cta': 'Review payouts',

  'alert.signed_up.title': 'New partner signed up',
  'alert.signed_up.message': '{name} joined the affiliate program.',
  'alert.signed_up.message_tier': '{name} joined the affiliate program on the {tier} tier.',
  'alert.signed_up.spots_one': '1 spot left in that tier.',
  'alert.signed_up.spots_other': '{spots} spots left in that tier.',
  'alert.signed_up.spots_none': 'That tier is now full.',
  'alert.profile_completed.title': 'Partner profile completed',
  'alert.profile_completed.message': '{name} completed their partner profile.',
  'alert.payout_configured.title': 'Partner payouts connected',
  'alert.payout_configured.message': '{name} connected Stripe payouts.',
  'alert.page_submitted.title': 'Storefront waiting for review',
  'alert.page_submitted.message': '{name} submitted their storefront for approval.',
  'alert.payout_failed.title': 'Affiliate payout failed',
  'alert.payout_failed.message': 'The payout to {name} failed.',
  'alert.payout_failed.message_amount': 'The payout of {amount} to {name} failed.',
  'alert.payout_failed.reason': 'Reason: {reason}',
  'alert.refund_after_payout.title': 'Refund after an affiliate payout',
  'alert.refund_after_payout.message':
    'An order was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.',
  'alert.refund_after_payout.message_order':
    'Order {order} was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.',
  'alert.refund_after_payout.message_manual':
    'An order was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.',
  'alert.refund_after_payout.message_order_manual':
    'Order {order} was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.',
  'alert.refund_after_payout.message_manual_prepared':
    'An order was refunded after its commission was paid or queued. Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.',
  'alert.refund_after_payout.message_order_manual_prepared':
    'Order {order} was refunded after its commission was paid or queued. Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.',
  'alert.refund_after_payout.message_paypal_in_flight':
    'An order was refunded after its commission was paid or queued. Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.',
  'alert.refund_after_payout.message_order_paypal_in_flight':
    'Order {order} was refunded after its commission was paid or queued. Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.',
  'alert.label.partners': 'View partners',
  'alert.label.approvals': 'Review storefronts',
  'alert.label.payouts': 'Review payouts',
} as const satisfies Record<string, string>;

export type AffiliatePartnerEmailCopyKey = keyof typeof AFFILIATE_PARTNER_EMAIL_COPY;
export type AffiliateAdminEmailCopyKey = keyof typeof AFFILIATE_ADMIN_EMAIL_COPY;
