import type { AffiliatesCopyDictionary } from '../types';

/**
 * The built-in partner terms (`/partners/terms`, `/partenaires/conditions`): one key per heading,
 * paragraph or list item, in the order the page renders them.
 *
 * Every clause describes what the code does (docs/15 is the reference: attribution, the amount,
 * refunds and disputes, payouts). When a rule of the program changes, change the clause and move
 * `AFFILIATE_TERMS_VERSION` (core/constants.ts), which the page shows as "Last updated". No numbers
 * in the text: rates, referral windows, holds, the minimum payout and the schedule come from the live
 * settings in the page's "Program details" table. `{company}` is the legal name from CMS → Settings
 * → Privacy (else the site title) and `{email}` the privacy contact address; the page leaves the
 * contact section out when there is no address. The privacy policy link is rendered by the page.
 *
 * A starting template, not legal advice: the CMS says so next to the fields that replace these
 * terms with the operator's own page. Short sentences and plain words, like the landing page.
 */
export const AFFILIATES_TERMS_COPY = {
  // Metadata
  'affiliates.terms.meta_title': { en: 'Partner program terms', fr: 'Conditions du programme partenaires' },
  // Payouts are not always made through Stripe since 02036 (manual payouts), which changed it.
  'affiliates.terms.meta_description': {
    en: 'How our partner program works: commissions, the hold period, refunds, payouts, your duties and how to leave.',
    fr: 'Le fonctionnement de notre programme partenaires : commissions, retenue, remboursements, versements, vos obligations et votre départ.',
  },

  // Header
  'affiliates.terms.title': { en: 'Partner program terms', fr: 'Conditions du programme partenaires' },
  'affiliates.terms.last_updated': { en: 'Last updated: {date}', fr: 'Dernière mise à jour : {date}' },
  'affiliates.terms.intro': {
    en: 'These terms explain how our partner program works and what we expect from you. By creating a partner account, you accept them.',
    fr: 'Ces conditions expliquent le fonctionnement de notre programme partenaires et ce que nous attendons de vous. En créant un compte partenaire, vous les acceptez.',
  },
  'affiliates.terms.operator': {
    en: 'The program is run by {company} (“we” or “us”).',
    fr: 'Le programme est géré par {company} (« nous »).',
  },

  // Joining
  'affiliates.terms.joining_title': { en: 'Joining the program', fr: 'Adhésion au programme' },
  'affiliates.terms.joining_free': { en: 'Joining is free.', fr: "L'adhésion est gratuite." },
  'affiliates.terms.joining_review': {
    en: 'We review every storefront before it goes live.',
    fr: 'Nous révisons chaque vitrine avant sa mise en ligne.',
  },
  'affiliates.terms.joining_changes': {
    en: 'When you change your page or your profile, we review the changes before they go live. Until then, the approved version stays online.',
    fr: "Quand vous modifiez votre page ou votre profil, nous révisons les changements avant leur mise en ligne. D'ici là, la version approuvée reste en ligne.",
  },
  'affiliates.terms.joining_refuse': {
    en: 'We may refuse a storefront, ask for changes, or take it offline.',
    fr: 'Nous pouvons refuser une vitrine, demander des changements ou la retirer du site.',
  },

  // Earning
  'affiliates.terms.earning_title': { en: 'How you earn', fr: 'Comment vous gagnez des commissions' },
  'affiliates.terms.earning_start': {
    en: 'You start earning once your first storefront is approved.',
    fr: 'Vous commencez à gagner des commissions dès que votre première vitrine est approuvée.',
  },
  'affiliates.terms.earning_referral': {
    en: "An order counts for you when the shopper came through your referral link or your storefront, within your tier's referral window.",
    fr: 'Une commande compte pour vous quand le client est arrivé par votre lien de recommandation ou votre vitrine, pendant la période de recommandation de votre niveau.',
  },
  'affiliates.terms.earning_one_partner': {
    en: 'Only one partner earns per order. A product added to the cart from a storefront comes first. Otherwise, the last referral link the shopper followed counts.',
    fr: "Un seul partenaire touche une commission par commande. Un produit ajouté au panier depuis une vitrine a priorité. Sinon, c'est le dernier lien de recommandation suivi par le client qui compte.",
  },
  'affiliates.terms.earning_consent': {
    en: 'If the shopper declined marketing cookies, the order earns no commission.',
    fr: 'Si le client a refusé les témoins marketing, la commande ne donne aucune commission.',
  },
  'affiliates.terms.earning_self': {
    en: 'Orders placed with your own account or your own email address never earn a commission.',
    fr: 'Les commandes passées avec votre propre compte ou votre propre adresse courriel ne donnent jamais de commission.',
  },
  'affiliates.terms.earning_base': {
    en: "Your commission is your tier's rate on the order total after discounts, without taxes or shipping.",
    fr: 'Votre commission est le taux de votre niveau appliqué au total de la commande après les rabais, sans les taxes ni la livraison.',
  },
  'affiliates.terms.earning_first_payment': {
    en: "You earn once per order, when it is first paid. Renewals and later subscription payments don't earn a commission.",
    fr: "Vous gagnez une seule commission par commande, à son premier paiement. Les renouvellements et les paiements d'abonnement suivants ne donnent pas de commission.",
  },
  'affiliates.terms.earning_currency': {
    en: "Commissions are recorded in the store's currency. An order in another currency is converted at the rate saved with the order.",
    fr: 'Les commissions sont inscrites dans la devise de la boutique. Une commande dans une autre devise est convertie au taux enregistré avec la commande.',
  },
  'affiliates.terms.earning_tiers': {
    en: 'We decide which tier you are in, and we may move you to another tier.',
    fr: 'Nous décidons de votre niveau, et nous pouvons vous faire passer à un autre niveau.',
  },
  // 02035: the tier's rate is stored on the order when it is paid (a move or a rate edit never
  // reaches an order paid before it, however late its commission is recorded).
  'affiliates.terms.earning_rate_changes': {
    en: 'A rate change applies only to orders paid after the change.',
    fr: "Un changement de taux s'applique seulement aux commandes payées après ce changement.",
  },

  // Hold period
  'affiliates.terms.hold_title': { en: 'Hold period', fr: 'Période de retenue' },
  'affiliates.terms.hold_body': {
    en: "Each commission waits for your tier's hold period before it clears. The hold protects the store against refunds.",
    fr: "Chaque commission attend la fin de la période de retenue de votre niveau avant d'être confirmée. Cette retenue protège la boutique contre les remboursements.",
  },
  'affiliates.terms.hold_dispute': {
    en: 'A commission stays on hold while a payment dispute about its order is open.',
    fr: "Une commission reste en attente tant qu'un litige de paiement sur sa commande est ouvert.",
  },

  // Refunds and disputes
  'affiliates.terms.refunds_title': { en: 'Refunds and disputes', fr: 'Remboursements et litiges' },
  'affiliates.terms.refunds_full': {
    en: 'If an order is fully refunded or cancelled, its commission is cancelled.',
    fr: 'Si une commande est remboursée en entier ou annulée, sa commission est annulée.',
  },
  'affiliates.terms.refunds_partial': {
    en: 'A partial refund lowers the commission by the same share.',
    fr: 'Un remboursement partiel réduit la commission dans la même proportion.',
  },
  'affiliates.terms.refunds_dispute': {
    en: 'If the store loses a payment dispute, the commission is cancelled.',
    fr: 'Si la boutique perd un litige de paiement, la commission est annulée.',
  },
  // The ledger has no clawback: a refund after a payout raises an alert, and the operator recovers
  // the amount (a Stripe transfer reversal; after a manual or PayPal payout, which cannot be taken
  // back, by asking the partner to send it back, or a deduction from a later payout). 02037 added the
  // request to send it back.
  'affiliates.terms.refunds_after_payout': {
    en: 'If a refund or a lost dispute comes after we paid you, we may take that amount back: by reversing the Stripe transfer, by asking you to send it back, or by deducting it from a later payout.',
    fr: "Si un remboursement ou un litige perdu survient après votre versement, nous pouvons reprendre ce montant : en annulant le virement Stripe, en vous demandant de nous le renvoyer ou en le déduisant d'un versement suivant.",
  },

  // Payouts. Since 02036 the operator picks, per sale gateway, Stripe Connect or payouts sent by hand
  // (affiliates_settings.payoutMethods), and since 02037 automatic PayPal Payouts (to a partner whose
  // payout email is a PayPal account; one who chose Interac e-Transfer is paid by hand); the Program
  // details table shows which one applies. payouts_stripe, payouts_direct and payouts_schedule were
  // reworded by 02037.
  'affiliates.terms.payouts_title': { en: 'Payouts', fr: 'Versements' },
  'affiliates.terms.payouts_stripe': {
    en: 'Depending on the sale, we pay you into a Stripe account in your name (Stripe Connect Express), into your PayPal account with PayPal Payouts, or we send the money to you directly, for example by PayPal or Interac e-Transfer.',
    fr: "Selon la vente, nous vous payons dans un compte Stripe à votre nom (Stripe Connect Express), dans votre compte PayPal avec PayPal Payouts, ou nous vous envoyons l'argent directement, par exemple par PayPal ou virement Interac.",
  },
  'affiliates.terms.payouts_setup': {
    en: 'For payouts through Stripe, finish the Stripe setup in your partner portal. Your Stripe account must be in a country where we can pay you.',
    fr: 'Pour les versements par Stripe, terminez la configuration Stripe dans votre portail partenaire. Votre compte Stripe doit être situé dans un pays où nous pouvons vous payer.',
  },
  'affiliates.terms.payouts_direct': {
    en: 'For payouts by PayPal or sent directly, add your payout email in your partner portal and choose PayPal or Interac e-Transfer. We send the money to that address, so keep it up to date.',
    fr: "Pour les versements par PayPal ou envoyés directement, ajoutez votre courriel de versement dans votre portail partenaire et choisissez PayPal ou le virement Interac. Nous envoyons l'argent à cette adresse : gardez-la à jour.",
  },
  // What PayPal does with a payout nobody claims (it returns it after a while; the ledger then hands the
  // commissions back), and how Interac e-Transfers are sent. No numbers: see the file comment.
  'affiliates.terms.payouts_paypal': {
    en: 'For payouts by PayPal, use the email of your PayPal account. A payout sent to an address without a confirmed PayPal account waits to be claimed for a limited time; then PayPal returns it, and the amount goes back to your balance.',
    fr: "Pour les versements par PayPal, utilisez le courriel de votre compte PayPal. Un versement envoyé à une adresse sans compte PayPal confirmé attend d'être réclamé pendant un temps limité; PayPal le retourne ensuite, et le montant revient dans votre solde.",
  },
  'affiliates.terms.payouts_interac': {
    en: 'If you choose Interac e-Transfer, we send your payouts by hand.',
    fr: 'Si vous choisissez le virement Interac, nous envoyons vos versements manuellement.',
  },
  'affiliates.terms.payouts_currency': {
    en: "Payouts are sent in the store's currency.",
    fr: 'Les versements sont envoyés dans la devise de la boutique.',
  },
  'affiliates.terms.payouts_minimum': {
    en: 'We send a payout once your cleared commissions reach the minimum payout.',
    fr: 'Nous envoyons un versement dès que vos commissions confirmées atteignent le versement minimum.',
  },
  'affiliates.terms.payouts_schedule': {
    en: 'Payouts follow our schedule. A payout can be late, for example if a payment service is unavailable or our Stripe or PayPal balance is too low.',
    fr: 'Les versements suivent notre calendrier. Un versement peut être retardé, par exemple si un service de paiement est indisponible ou si notre solde Stripe ou PayPal est insuffisant.',
  },
  'affiliates.terms.payouts_stripe_agreement': {
    en: "Your Stripe account is covered by Stripe's own agreement with you.",
    fr: "Votre compte Stripe est soumis à l'entente que Stripe conclut avec vous.",
  },
  'affiliates.terms.payouts_paypal_agreement': {
    en: "Your PayPal account is covered by PayPal's own agreement with you.",
    fr: "Votre compte PayPal est soumis à l'entente que PayPal conclut avec vous.",
  },

  // Taxes
  'affiliates.terms.taxes_title': { en: 'Taxes', fr: 'Impôts et taxes' },
  'affiliates.terms.taxes_body': {
    en: "We don't deduct taxes from your payouts. You are responsible for reporting your earnings and paying your own taxes.",
    fr: 'Nous ne retenons aucun impôt sur vos versements. Vous devez déclarer vos revenus et payer vos propres impôts et taxes.',
  },

  // How you promote the store
  'affiliates.terms.rules_title': { en: 'How you promote the store', fr: 'Promouvoir la boutique' },
  'affiliates.terms.rules_disclosure': {
    en: 'Tell your audience that you earn a commission, everywhere you promote the store. Your storefront already shows this notice.',
    fr: 'Dites à votre public que vous touchez une commission, partout où vous faites la promotion de la boutique. Votre vitrine affiche déjà cet avis.',
  },
  'affiliates.terms.rules_forbidden_intro': { en: 'These are not allowed:', fr: 'Ces pratiques sont interdites :' },
  'affiliates.terms.rules_forbidden_self': {
    en: 'Buying through your own links or your own storefront.',
    fr: 'Acheter avec vos propres liens ou votre propre vitrine.',
  },
  'affiliates.terms.rules_forbidden_spam': {
    en: "Spam, or messages people didn't ask for.",
    fr: "Le pourriel, ou les messages que les gens n'ont pas demandés.",
  },
  'affiliates.terms.rules_forbidden_claims': {
    en: 'False or misleading claims about the store, its products or its prices.',
    fr: 'Les affirmations fausses ou trompeuses sur la boutique, ses produits ou ses prix.',
  },
  'affiliates.terms.rules_forbidden_cookies': {
    en: "Cookie stuffing: setting a referral cookie for someone who didn't choose to follow your link.",
    fr: "Le bourrage de témoins : placer un témoin de recommandation chez quelqu'un qui n'a pas choisi de suivre votre lien.",
  },
  'affiliates.terms.rules_forbidden_impersonation': {
    en: 'Pretending to be the store, or to speak for it.',
    fr: 'Se faire passer pour la boutique, ou parler en son nom.',
  },
  'affiliates.terms.rules_breach': {
    en: 'If you break these rules, we may suspend your partner account.',
    fr: 'Si vous enfreignez ces règles, nous pouvons suspendre votre compte partenaire.',
  },

  // Your storefront content
  'affiliates.terms.content_title': { en: 'Your storefront content', fr: 'Le contenu de votre vitrine' },
  'affiliates.terms.content_ownership': {
    en: 'You keep the rights to what you write and upload.',
    fr: 'Vous conservez vos droits sur ce que vous écrivez et téléversez.',
  },
  'affiliates.terms.content_licence': {
    en: 'You allow us to store, show, copy and adapt it, for example to resize your images, so we can run and promote your storefront.',
    fr: "Vous nous permettez de le conserver, de l'afficher, de le copier et de l'adapter, par exemple pour redimensionner vos images, afin d'exploiter et de promouvoir votre vitrine.",
  },
  'affiliates.terms.content_responsibility': {
    en: 'You are responsible for your content, including text the storefront assistant drafts for you. Only use text and images you have the right to use.',
    fr: "Vous êtes responsable de votre contenu, y compris le texte que l'assistant de vitrine rédige pour vous. Utilisez seulement des textes et des images que vous avez le droit d'utiliser.",
  },

  // Suspension and leaving. "Suspended" is the partner-facing word (portal notice, PARTNER_SUSPENDED
  // email, account status); "Pause" is only the CMS button. The key names keep `pause_`.
  'affiliates.terms.pause_title': { en: 'Suspension and leaving', fr: 'Suspension et départ' },
  'affiliates.terms.pause_body': {
    en: 'We may suspend your partner account, for example while we look into a problem.',
    fr: 'Nous pouvons suspendre votre compte partenaire, par exemple pendant que nous examinons un problème.',
  },
  'affiliates.terms.pause_effects': {
    en: 'While your account is suspended, your storefront is offline, you earn no new commissions and no payouts are sent.',
    fr: "Pendant la suspension, votre vitrine est hors ligne, vous ne gagnez aucune nouvelle commission et aucun versement n'est envoyé.",
  },
  // Suspension never voids a commission: recorded ones keep clearing, and claim_affiliate_payout (02030)
  // pays an ACTIVE partner only, so payouts resume on reactivation. The PARTNER_SUSPENDED email says the same.
  'affiliates.terms.pause_balance': {
    en: 'The commissions you already earned stay in your balance, and payouts resume once we reactivate your account.',
    fr: 'Les commissions que vous avez déjà gagnées restent dans votre solde, et les versements reprennent à la réactivation de votre compte.',
  },
  'affiliates.terms.pause_records': {
    en: 'Your records are kept, and you can still sign in to see them.',
    fr: 'Votre historique est conservé, et vous pouvez toujours vous connecter pour le consulter.',
  },
  'affiliates.terms.leave_body': {
    en: "To leave the program, contact us. You can't delete your partner account yourself.",
    fr: 'Pour quitter le programme, communiquez avec nous. Vous ne pouvez pas supprimer vous-même votre compte partenaire.',
  },
  'affiliates.terms.leave_records': {
    en: 'We keep the records of your commissions and payouts.',
    fr: "Nous conservons l'historique de vos commissions et de vos versements.",
  },

  // Changes to these terms
  'affiliates.terms.changes_title': { en: 'Changes to these terms', fr: 'Modifications de ces conditions' },
  'affiliates.terms.changes_body': {
    en: 'We may update these terms. When we do, we change the date at the top of this page.',
    fr: 'Nous pouvons mettre à jour ces conditions. Nous changeons alors la date en haut de cette page.',
  },
  'affiliates.terms.changes_accept': {
    en: 'If you keep taking part after an update, the new terms apply to you.',
    fr: "Si vous continuez à participer après une mise à jour, les nouvelles conditions s'appliquent à vous.",
  },

  // Governing law
  'affiliates.terms.law_title': { en: 'Governing law', fr: 'Droit applicable' },
  'affiliates.terms.law_body': {
    en: 'These terms are governed by the laws of the place where {company} is established.',
    fr: 'Ces conditions sont régies par les lois du lieu où {company} a son établissement.',
  },

  // Privacy (the page renders the policy link)
  'affiliates.terms.privacy_title': { en: 'Privacy', fr: 'Confidentialité' },
  'affiliates.terms.privacy_body': {
    en: 'Our privacy policy explains how we handle your personal information.',
    fr: 'Notre politique de confidentialité explique comment nous traitons vos renseignements personnels.',
  },
  // What startAffiliateConnectOnboarding sends (connect-service.ts → buildAffiliateExpressAccountParams):
  // the email, the country, and business_profile.url, the storefront address (even before approval).
  'affiliates.terms.privacy_stripe': {
    en: 'If you set up payouts through Stripe, we share your email address, your country and your storefront address with Stripe.',
    fr: "Si vous configurez des versements par Stripe, nous transmettons à Stripe votre adresse courriel, votre pays et l'adresse de votre vitrine.",
  },
  // What the CMS PayPal payouts file holds (lib/affiliates/paypal-payouts-csv.ts, 02036): the payout
  // email, the amount and the handle (as PayPal's customer ID).
  'affiliates.terms.privacy_direct': {
    en: 'To send you a payout directly, we give your payout email, the amount and your handle to the payment service we use, such as PayPal.',
    fr: 'Pour vous envoyer un versement directement, nous transmettons votre courriel de versement, le montant et votre identifiant au service de paiement que nous utilisons, comme PayPal.',
  },
  'affiliates.terms.privacy_link': { en: 'Read our privacy policy', fr: 'Lire notre politique de confidentialité' },

  // Contact (left out when there is no contact address)
  'affiliates.terms.contact_title': { en: 'Contact', fr: 'Nous joindre' },
  'affiliates.terms.contact_body': {
    en: 'Questions about these terms? Write to us at {email}.',
    fr: 'Des questions sur ces conditions? Écrivez-nous à {email}.',
  },

  // Program details (live settings)
  'affiliates.terms.details_title': { en: 'Program details', fr: 'Détails du programme' },
  'affiliates.terms.details_intro': {
    en: 'These details come from our current settings. They can change at any time.',
    fr: 'Ces détails proviennent de nos paramètres actuels. Ils peuvent changer en tout temps.',
  },
  'affiliates.terms.details_tiers_caption': {
    en: 'Commission, referral window and hold period of each tier',
    fr: 'Commission, période de recommandation et période de retenue de chaque niveau',
  },
  'affiliates.terms.details_tier': { en: 'Tier', fr: 'Niveau' },
  'affiliates.terms.details_commission': { en: 'Commission', fr: 'Commission' },
  'affiliates.terms.details_window': { en: 'Referral window', fr: 'Période de recommandation' },
  'affiliates.terms.details_hold': { en: 'Hold period', fr: 'Période de retenue' },
  'affiliates.terms.details_rate': { en: '{rate}%', fr: '{rate} %' },
  // The page picks _one or _other with Intl.PluralRules (French: 0 and 1 are singular).
  'affiliates.terms.details_days_one': { en: '{count} day', fr: '{count} jour' },
  'affiliates.terms.details_days_other': { en: '{count} days', fr: '{count} jours' },
  'affiliates.terms.details_no_tiers': {
    en: 'No tier is open right now.',
    fr: "Aucun niveau n'est offert pour le moment.",
  },
  'affiliates.terms.details_currency': { en: 'Currency', fr: 'Devise' },
  'affiliates.terms.details_minimum_payout': { en: 'Minimum payout', fr: 'Versement minimum' },
  'affiliates.terms.details_payout_method': { en: 'Payout method', fr: 'Mode de versement' },
  'affiliates.terms.details_payout_method_stripe': {
    en: 'Transfer to your Stripe account (Stripe Connect Express)',
    fr: 'Virement à votre compte Stripe (Stripe Connect Express)',
  },
  // affiliates_settings.payoutMethods (02036): one method for every sale, or one row per sale type.
  'affiliates.terms.details_payout_method_manual': {
    en: 'Sent directly by us, for example by PayPal or Interac e-Transfer',
    fr: 'Envoyé directement par nous, par exemple par PayPal ou virement Interac',
  },
  // 02037: automatic PayPal Payouts (by hand to a partner who chose Interac e-Transfer).
  'affiliates.terms.details_payout_method_paypal': {
    en: 'Sent to your PayPal account by PayPal Payouts, or by Interac e-Transfer if you choose it',
    fr: 'Envoyé à votre compte PayPal par PayPal Payouts, ou par virement Interac si vous le choisissez',
  },
  'affiliates.terms.details_payout_method_stripe_orders': {
    en: 'Payout method, orders paid through Stripe',
    fr: 'Mode de versement, commandes payées par Stripe',
  },
  'affiliates.terms.details_payout_method_freemius_orders': {
    en: 'Payout method, orders paid through Freemius',
    fr: 'Mode de versement, commandes payées par Freemius',
  },
  'affiliates.terms.details_schedule': { en: 'Payout schedule', fr: 'Calendrier des versements' },
  'affiliates.terms.details_schedule_daily': { en: 'Automatic, every day', fr: 'Automatique, chaque jour' },
  'affiliates.terms.details_schedule_manual': { en: 'When we run them', fr: 'Quand nous les lançons' },
  // Every sale paid by hand, or some through Stripe (its daily switch) and the others by hand.
  'affiliates.terms.details_schedule_direct': { en: 'When we send them', fr: 'Quand nous les envoyons' },
  'affiliates.terms.details_schedule_mixed_daily': {
    en: 'Stripe transfers: automatic, every day. Direct payouts: when we send them.',
    fr: 'Virements Stripe : automatiques, chaque jour. Versements directs : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_mixed_manual': {
    en: 'Stripe transfers: when we run them. Direct payouts: when we send them.',
    fr: 'Virements Stripe : quand nous les lançons. Versements directs : quand nous les envoyons.',
  },
  // 02037: PayPal Payouts follow the same daily switch as Stripe transfers; a partner who chose
  // Interac e-Transfer, and every sale routed to "manually", is paid when we send it. _daily while
  // automatic payouts are on, _manual while they are off.
  'affiliates.terms.details_schedule_paypal_daily': {
    en: 'PayPal payouts: automatic, every day. Interac e-Transfers: when we send them.',
    fr: 'Versements PayPal : automatiques, chaque jour. Virements Interac : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_paypal_manual': {
    en: 'PayPal payouts: when we run them. Interac e-Transfers: when we send them.',
    fr: 'Versements PayPal : quand nous les lançons. Virements Interac : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_stripe_paypal_daily': {
    en: 'Stripe transfers and PayPal payouts: automatic, every day. Interac e-Transfers: when we send them.',
    fr: 'Virements Stripe et versements PayPal : automatiques, chaque jour. Virements Interac : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_stripe_paypal_manual': {
    en: 'Stripe transfers and PayPal payouts: when we run them. Interac e-Transfers: when we send them.',
    fr: 'Virements Stripe et versements PayPal : quand nous les lançons. Virements Interac : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_paypal_direct_daily': {
    en: 'PayPal payouts: automatic, every day. Direct payouts: when we send them.',
    fr: 'Versements PayPal : automatiques, chaque jour. Versements directs : quand nous les envoyons.',
  },
  'affiliates.terms.details_schedule_paypal_direct_manual': {
    en: 'PayPal payouts: when we run them. Direct payouts: when we send them.',
    fr: 'Versements PayPal : quand nous les lançons. Versements directs : quand nous les envoyons.',
  },
} as const satisfies AffiliatesCopyDictionary;
