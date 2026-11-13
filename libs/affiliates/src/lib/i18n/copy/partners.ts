import type { AffiliatesCopyDictionary } from '../types';

/**
 * `/partners` copy, split by where it renders so a client island ships only its own strings:
 * the server-rendered landing sections ({@link AFFILIATES_PARTNERS_LANDING_COPY}), the revenue
 * calculator island ({@link AFFILIATES_PARTNERS_CALCULATOR_COPY}) and the signup island plus the
 * signup action's messages ({@link AFFILIATES_PARTNERS_SIGNUP_COPY}). {@link AFFILIATES_PARTNERS_COPY}
 * is the area dictionary (all three).
 *
 * The page is graded by the SEO engine (`partners-seo.test.tsx`): short sentences and plain words
 * keep Flesch Reading Ease at 50 or more in both languages, so keep new copy that way.
 */

/** Metadata, hero, launch offer, tier ladder, how it works, benefits and FAQ (server-rendered). */
export const AFFILIATES_PARTNERS_LANDING_COPY = {
  // Metadata (title: at most 60 characters; description: 70 to 160, after interpolation)
  'affiliates.partners.meta_title': {
    en: 'Partner Program: Earn up to {rate}% Commission',
    fr: "Programme de partenaires : jusqu'à {rate} % de commission",
  },
  'affiliates.partners.meta_title_no_rate': {
    en: 'Partner Program: Earn on Every Sale You Refer',
    fr: 'Programme de partenaires : gagnez sur chaque vente',
  },
  // The payout wording on this page holds whatever affiliates_settings.payoutMethods says (02036:
  // a store may pay some commissions by hand, outside Stripe): never "through Stripe" or
  // "automatic". Changed by migration 02036, like every payout line below.
  'affiliates.partners.meta_description': {
    en: 'Join our free partner program. Earn up to {rate}% on every sale you refer, get your own storefront and get paid once your commissions clear.',
    fr: "Inscrivez-vous gratuitement à notre programme de partenaires. Gagnez jusqu'à {rate} % sur chaque vente recommandée et recevez vos versements.",
  },
  'affiliates.partners.meta_description_no_rate': {
    en: 'Join our free partner program. Earn a commission on every sale you refer, get your own storefront and get paid once your commissions clear.',
    fr: 'Inscrivez-vous gratuitement à notre programme de partenaires. Touchez une commission sur chaque vente recommandée et recevez vos versements.',
  },

  // Hero. The badge above the title reads offer_eyebrow while the launch offer is what a signup
  // gets, hero_badge_open while signups are open, and the plain eyebrow while they are paused.
  'affiliates.partners.hero_eyebrow': { en: 'Partner program', fr: 'Programme de partenaires' },
  'affiliates.partners.hero_badge_open': {
    en: 'Now open: our partner program',
    fr: 'Maintenant ouvert : notre programme de partenaires',
  },
  'affiliates.partners.hero_title': {
    en: 'Earn up to {rate}% on every sale you refer',
    fr: "Gagnez jusqu'à {rate} % sur chaque vente que vous recommandez",
  },
  'affiliates.partners.hero_title_no_rate': {
    en: 'Earn a commission on every sale you refer',
    fr: 'Touchez une commission sur chaque vente que vous recommandez',
  },
  'affiliates.partners.hero_subtitle': {
    en: 'Share the products you love from your own storefront. We track each sale and pay your commissions.',
    fr: 'Partagez les produits que vous aimez dans votre propre vitrine. Nous suivons chaque vente et nous vous versons vos commissions.',
  },
  'affiliates.partners.hero_cta_signup': { en: 'Claim your storefront', fr: 'Réservez votre vitrine' },
  'affiliates.partners.hero_cta_how': { en: 'See how it works', fr: 'Voir comment ça marche' },
  // The three checks under the buttons. The third is benefit_payouts_title while automatic payouts
  // are on, else hero_point_payouts_stripe (payouts then wait for the store to send them; the key
  // keeps its name, its text no longer names Stripe since 02036).
  'affiliates.partners.hero_point_free': { en: 'Free to join', fr: 'Inscription gratuite' },
  'affiliates.partners.hero_point_no_fees': { en: 'No monthly fees', fr: 'Aucuns frais mensuels' },
  'affiliates.partners.hero_point_payouts_stripe': { en: 'Payouts sent by our team', fr: 'Versements envoyés par notre équipe' },

  // The hero's example card: {sales} sales a month of {price} at the offered rate. The figures are
  // the calculator's starting point, so the two always agree.
  'affiliates.partners.hero_visual_title': { en: 'Example month', fr: 'Un mois type' },
  'affiliates.partners.hero_visual_rate': { en: 'At {rate}% commission', fr: 'Avec une commission de {rate} %' },
  'affiliates.partners.hero_visual_per_month': { en: 'a month', fr: 'par mois' },
  'affiliates.partners.hero_visual_amount': { en: '{amount} a month', fr: '{amount} par mois' },
  'affiliates.partners.hero_visual_formula': {
    en: '{sales} sales of {price} each month',
    fr: '{sales} ventes de {price} chaque mois',
  },
  'affiliates.partners.hero_visual_chart': { en: 'Example over six months', fr: 'Exemple sur six mois' },
  'affiliates.partners.hero_visual_sale_generic': { en: 'Referred sale', fr: 'Vente recommandée' },
  'affiliates.partners.hero_visual_note': { en: 'An example, not a promise.', fr: 'Un exemple, pas une promesse.' },
  // _one for 0 or 1 spot taken (French writes both in the singular), the other form from 2 up.
  'affiliates.partners.hero_spots_taken_one': {
    en: '{taken} of {cap} spots taken',
    fr: '{taken} place prise sur {cap}',
  },
  'affiliates.partners.hero_spots_taken': {
    en: '{taken} of {cap} spots taken',
    fr: '{taken} places prises sur {cap}',
  },

  // Launch offer badge: eyebrow, then claim + range + spots joined with spaces. {tier} is the promo
  // tier's current localized name (admins rename tiers), so it is never pluralized.
  'affiliates.partners.offer_eyebrow': { en: 'Limited time launch offer', fr: 'Offre de lancement à durée limitée' },
  'affiliates.partners.offer_claim': { en: 'Claim {rate}% Revenue Share', fr: 'Obtenez {rate} % de partage des revenus' },
  'affiliates.partners.offer_range': { en: '(Normally {min}%–{max}%)', fr: '(normalement de {min} % à {max} %)' },
  'affiliates.partners.offer_range_single': { en: '(Normally {rate}%)', fr: '(normalement {rate} %)' },
  'affiliates.partners.offer_spots_many': {
    en: '— Only {spots} {tier} Spots Left!',
    fr: '— il ne reste que {spots} places au niveau {tier}!',
  },
  'affiliates.partners.offer_spots_one': {
    en: '— Only 1 {tier} Spot Left!',
    fr: "— il ne reste qu'une place au niveau {tier}!",
  },
  'affiliates.partners.offer_spots_unlimited': {
    en: '— For a Limited Time Only!',
    fr: '— pour une durée limitée seulement!',
  },

  // Tier ladder
  'affiliates.partners.ladder_title': { en: 'Grow with our partner tiers', fr: 'Progressez avec nos niveaux de partenaire' },
  'affiliates.partners.ladder_intro': {
    en: 'Every partner earns a share of each sale. Higher tiers earn a bigger share.',
    fr: 'Chaque partenaire touche une part de chaque vente. Les niveaux supérieurs touchent une plus grande part.',
  },
  'affiliates.partners.ladder_offer_label': { en: 'Your rate if you join today', fr: "Votre taux si vous vous inscrivez aujourd'hui" },
  'affiliates.partners.ladder_track_offer': {
    en: 'The launch offer is locked on the {tier} tier at {rate}%.',
    fr: "L'offre de lancement est verrouillée sur le niveau {tier}, à {rate} %.",
  },
  'affiliates.partners.ladder_track_standard': {
    en: 'New partners start on the {tier} tier at {rate}%.',
    fr: 'Les nouveaux partenaires commencent au niveau {tier}, à {rate} %.',
  },
  'affiliates.partners.ladder_cookie': { en: '{days}-day referral window', fr: 'Fenêtre de recommandation de {days} jours' },
  // A tier's goal (affiliate_tiers.goal, edited under CMS -> Affiliates -> Tiers) and the note under
  // the ladder: goals are guidance, and an admin moves partners up by hand.
  'affiliates.partners.ladder_goal_label': { en: 'Goal', fr: 'Objectif' },
  'affiliates.partners.ladder_goal_note': {
    en: "Goals are a guide, not a promise. Our team decides each move to a higher tier, and the new rate applies to sales after the move. Refunded orders don't count.",
    fr: "Les objectifs sont un repère, pas une promesse. Notre équipe décide de chaque passage à un niveau supérieur, et le nouveau taux s'applique aux ventes suivantes. Les commandes remboursées ne comptent pas.",
  },
  'affiliates.partners.ladder_empty': {
    en: 'New partner tiers are coming soon. Check back shortly.',
    fr: 'De nouveaux niveaux de partenaire arrivent bientôt. Revenez sous peu.',
  },

  // How it works (the four onboarding steps)
  'affiliates.partners.how_title': { en: 'How it works', fr: 'Comment ça marche' },
  'affiliates.partners.how_intro': {
    en: 'Four simple steps take you from sign-up to your first payout.',
    fr: "Quatre étapes simples vous mènent de l'inscription à votre premier versement.",
  },
  'affiliates.partners.how_step_label': { en: 'Step {number}', fr: 'Étape {number}' },
  'affiliates.partners.how_step_account_title': { en: 'Create your account', fr: 'Créez votre compte' },
  'affiliates.partners.how_step_account_body': {
    en: 'Claim your handle and get your own storefront address in about a minute.',
    fr: 'Réservez votre identifiant et obtenez votre adresse de vitrine en une minute environ.',
  },
  'affiliates.partners.how_step_profile_title': { en: 'Complete your profile', fr: 'Complétez votre profil' },
  'affiliates.partners.how_step_profile_body': {
    en: 'Add a short bio and a photo, so shoppers know who you are.',
    fr: 'Ajoutez une courte bio et une photo, pour que les clients sachent qui vous êtes.',
  },
  'affiliates.partners.how_step_payouts_title': { en: 'Set up your payouts', fr: 'Configurez vos versements' },
  'affiliates.partners.how_step_payouts_body': {
    en: 'Tell us once where to send your money. After that, your payouts come to you.',
    fr: 'Dites-nous une seule fois où envoyer votre argent. Ensuite, vos versements viennent à vous.',
  },
  'affiliates.partners.how_step_storefront_title': { en: 'Publish your storefront', fr: 'Publiez votre vitrine' },
  'affiliates.partners.how_step_storefront_body': {
    en: 'Pick your favorite products, then send your page to our team for a quick review.',
    fr: 'Choisissez vos produits préférés, puis envoyez votre page à notre équipe pour une révision rapide.',
  },

  // Benefits
  'affiliates.partners.benefits_title': { en: 'Why partners love it', fr: 'Pourquoi nos partenaires adorent le programme' },
  'affiliates.partners.benefit_cookie_title': {
    en: 'A {days}-day window for every click',
    fr: 'Une fenêtre de {days} jours pour chaque clic',
  },
  'affiliates.partners.benefit_cookie_body': {
    en: 'When a shopper clicks your link, each order they place in the next {days} days counts for you.',
    fr: 'Quand un client clique sur votre lien, chaque commande passée dans les {days} jours suivants compte pour vous.',
  },
  'affiliates.partners.benefit_refund_title': { en: 'A fair refund window', fr: 'Une période de remboursement équitable' },
  'affiliates.partners.benefit_refund_body': {
    en: 'Each commission clears after {days} days, once the refund window is over. Then it is yours to keep.',
    fr: 'Chaque commission est confirmée après {days} jours, une fois la période de remboursement terminée. Elle est alors à vous.',
  },
  'affiliates.partners.benefit_payouts_title': { en: 'Payouts come to you', fr: 'Les versements viennent à vous' },
  'affiliates.partners.benefit_payouts_body': {
    en: 'Once your cleared balance reaches the minimum, we send your money. You never need to ask for a payout.',
    fr: "Une fois que votre solde confirmé atteint le minimum, nous vous envoyons votre argent. Vous n'avez jamais à demander un versement.",
  },
  'affiliates.partners.benefit_copilot_title': { en: 'An AI writing helper', fr: 'Un assistant de rédaction IA' },
  'affiliates.partners.benefit_copilot_body': {
    en: 'Our AI copilot helps you write your bio and build your page in minutes.',
    fr: 'Notre copilote IA vous aide à écrire votre bio et à bâtir votre page en quelques minutes.',
  },
  'affiliates.partners.benefit_approval_title': { en: 'Reviewed by our team', fr: 'Révisé par notre équipe' },
  'affiliates.partners.benefit_approval_body': {
    en: 'We check every storefront before it goes live, so shoppers can trust what they see.',
    fr: "Nous vérifions chaque vitrine avant sa mise en ligne, pour que les clients puissent s'y fier.",
  },
  'affiliates.partners.benefit_storefront_title': { en: 'Your own storefront page', fr: 'Votre propre page vitrine' },
  'affiliates.partners.benefit_storefront_body': {
    en: 'Get a page with your name, your photo and your favorite products. Share one link everywhere.',
    fr: 'Obtenez une page à votre nom, avec votre photo et vos produits préférés. Partagez un seul lien partout.',
  },

  // The closing call to action, above the FAQ, shown while signups are open. cta_title carries the
  // launch offer's rate (what a signup gets); without an offer, cta_title_up_to carries the best rate
  // a partner can reach, like the h1. {tier}: the promo tier while it is the signup tier.
  'affiliates.partners.cta_title': {
    en: 'Ready to earn {rate}% on every sale?',
    fr: 'Envie de gagner {rate} % sur chaque vente?',
  },
  'affiliates.partners.cta_title_up_to': {
    en: 'Ready to earn up to {rate}% on every sale?',
    fr: "Envie de gagner jusqu'à {rate} % sur chaque vente?",
  },
  'affiliates.partners.cta_title_no_rate': { en: 'Ready to earn on every sale?', fr: 'Envie de gagner sur chaque vente?' },
  'affiliates.partners.cta_body_offer': {
    en: 'Join today to get the {tier} rate while spots last.',
    fr: "Inscrivez-vous aujourd'hui pour obtenir le taux {tier} pendant qu'il reste des places.",
  },
  'affiliates.partners.cta_body_offer_unlimited': {
    en: 'Join today to get the {tier} rate while the offer lasts.',
    fr: "Inscrivez-vous aujourd'hui pour obtenir le taux {tier} pendant que l'offre dure.",
  },
  'affiliates.partners.cta_body': {
    en: 'It takes about a minute, and joining is free.',
    fr: "Ça prend environ une minute, et l'inscription est gratuite.",
  },

  // FAQ
  'affiliates.partners.faq_title': { en: 'Frequently asked questions', fr: 'Questions fréquentes' },
  'affiliates.partners.faq_cost_question': { en: 'Does it cost anything to join?', fr: "L'inscription est-elle payante?" },
  'affiliates.partners.faq_cost_answer': {
    en: 'No. Joining is free, and there are no monthly fees. You only need an account and a way to receive your payouts.',
    fr: "Non. L'inscription est gratuite et il n'y a aucuns frais mensuels. Il vous faut seulement un compte et un moyen de recevoir vos versements.",
  },
  'affiliates.partners.faq_commission_question': {
    en: 'How are commissions calculated?',
    fr: 'Comment les commissions sont-elles calculées?',
  },
  'affiliates.partners.faq_commission_answer': {
    en: "You earn your tier's rate on the first payment of each order you refer. We use the order total after discounts, without tax or shipping. Renewals and later subscription payments do not earn a commission. A free trial earns once it turns into a paid order.",
    fr: "Vous touchez le taux de votre niveau sur le premier paiement de chaque commande recommandée. Nous utilisons le total de la commande après les rabais, sans les taxes ni la livraison. Les renouvellements et les paiements d'abonnement suivants ne donnent pas de commission. Un essai gratuit en donne une quand il devient une commande payée.",
  },
  'affiliates.partners.faq_payouts_question': { en: 'When do I get paid?', fr: 'Quand suis-je payé?' },
  'affiliates.partners.faq_payouts_answer': {
    en: 'Each commission waits {days} days in case of a refund. Then it clears. We send your payout once your cleared balance reaches the minimum. Your partner portal shows how you get paid.',
    fr: 'Chaque commission attend {days} jours en cas de remboursement. Elle est ensuite confirmée. Nous envoyons votre versement une fois que votre solde confirmé atteint le minimum. Votre portail partenaire indique comment vous êtes payé.',
  },
  'affiliates.partners.faq_cookie_question': {
    en: 'How long does the referral cookie last?',
    fr: 'Combien de temps dure le témoin de recommandation?',
  },
  'affiliates.partners.faq_cookie_answer': {
    en: "It lasts {days} days. If a shopper buys within that time, the sale is yours. If they click another partner's link later, the newest link wins.",
    fr: "Il dure {days} jours. Si le client achète pendant cette période, la vente est à vous. S'il clique plus tard sur le lien d'un autre partenaire, le lien le plus récent l'emporte.",
  },
  'affiliates.partners.faq_approval_question': { en: 'How does approval work?', fr: "Comment fonctionne l'approbation?" },
  'affiliates.partners.faq_approval_answer': {
    en: 'Build your page, then send it for review. Our team reads it, then publishes it or asks for changes. You get an email either way.',
    fr: 'Bâtissez votre page, puis envoyez-la pour révision. Notre équipe la lit, puis la publie ou demande des changements. Vous recevez un courriel dans les deux cas.',
  },
  'affiliates.partners.faq_refund_question': {
    en: 'What happens if an order is refunded?',
    fr: 'Que se passe-t-il si une commande est remboursée?',
  },
  'affiliates.partners.faq_refund_answer': {
    en: 'The commission for that order is cancelled. A partial refund lowers it by the same share.',
    fr: 'La commission de cette commande est annulée. Un remboursement partiel la réduit dans la même proportion.',
  },
} as const satisfies AffiliatesCopyDictionary;

/** The revenue calculator island. */
export const AFFILIATES_PARTNERS_CALCULATOR_COPY = {
  'affiliates.partners.calculator_title': { en: 'Estimate your earnings', fr: 'Estimez vos revenus' },
  // New keys rather than new text under the old ones (calculator_intro, calculator_summary…): a
  // database that already ran an earlier 02031 would keep the old row, and an old row that differs
  // from the dictionary reads as an operator override (affiliate-translation-rows.ts).
  'affiliates.partners.calculator_intro_monthly': {
    en: 'Move the sliders to see what you could earn each month and each year.',
    fr: 'Déplacez les curseurs pour voir ce que vous pourriez gagner chaque mois et chaque année.',
  },
  'affiliates.partners.calculator_intro_products': {
    en: 'Pick a product, then move the sliders to see what you could earn.',
    fr: 'Choisissez un produit, puis déplacez les curseurs pour voir ce que vous pourriez gagner.',
  },
  // The product picker: up to three of the store's products (highest price first) and their sum.
  'affiliates.partners.calculator_products_label': { en: 'What your referrals buy', fr: 'Ce que vos clients achètent' },
  'affiliates.partners.calculator_product_price_year': { en: '{price} a year', fr: '{price} par année' },
  'affiliates.partners.calculator_product_price_month': { en: '{price} a month', fr: '{price} par mois' },
  'affiliates.partners.calculator_product_price_year_month': {
    en: '{price} a year or {monthly} a month',
    fr: '{price} par année ou {monthly} par mois',
  },
  'affiliates.partners.calculator_product_earn': { en: 'You earn {amount} a sale', fr: 'Vous gagnez {amount} par vente' },
  'affiliates.partners.calculator_product_earn_yearly': {
    en: 'You earn {amount} a yearly sale',
    fr: 'Vous gagnez {amount} par vente annuelle',
  },
  'affiliates.partners.calculator_product_bundle': { en: 'All {count} together', fr: 'Les {count} ensemble' },
  'affiliates.partners.calculator_product_bundle_two': { en: 'Both together', fr: 'Les deux ensemble' },
  // Only an order's first payment earns: a monthly plan pays one month's commission, never more.
  'affiliates.partners.calculator_products_note_yearly': {
    en: 'We use yearly prices. You earn on the first payment only, so a monthly plan earns on its first month.',
    fr: 'Nous utilisons les prix annuels. Vous touchez une commission sur le premier paiement seulement : un forfait mensuel rapporte donc sur son premier mois.',
  },
  'affiliates.partners.calculator_products_note_monthly': {
    en: 'You earn on the first payment only, so a monthly plan earns on its first month.',
    fr: 'Vous touchez une commission sur le premier paiement seulement : un forfait mensuel rapporte donc sur son premier mois.',
  },
  'affiliates.partners.calculator_monthly_label': { en: 'Your monthly income at {rate}%', fr: 'Votre revenu mensuel à {rate} %' },
  'affiliates.partners.calculator_referrals_label': { en: 'Sales you refer each month', fr: 'Ventes recommandées chaque mois' },
  'affiliates.partners.calculator_referrals_value_one': { en: '1 sale per month', fr: '1 vente par mois' },
  'affiliates.partners.calculator_referrals_value_other': { en: '{count} sales per month', fr: '{count} ventes par mois' },
  'affiliates.partners.calculator_aov_label': { en: 'Average order value', fr: "Valeur moyenne d'une commande" },
  'affiliates.partners.calculator_aov_value': { en: '{amount} per order', fr: '{amount} par commande' },
  'affiliates.partners.calculator_compare_label': { en: 'Your yearly income at {rate}%', fr: 'Votre revenu annuel à {rate} %' },
  'affiliates.partners.calculator_base_label': { en: 'At the standard {rate}% rate', fr: 'Au taux standard de {rate} %' },
  // Nothing locks a rate (an admin can change a tier's rate), so the label says "get", as the
  // French always did. A new key: an older seeded row would read as an override.
  'affiliates.partners.calculator_bonus_label_now': {
    en: 'Extra you get by joining now',
    fr: 'Le surplus que vous obtenez en vous inscrivant maintenant',
  },
  'affiliates.partners.calculator_summary_monthly': {
    en: 'At {compare_rate}%, you could earn {monthly} a month, or {compare} a year. At {base_rate}%, you would earn {base} a year. That is {bonus} more.',
    fr: "À {compare_rate} %, vous pourriez gagner {monthly} par mois, soit {compare} par année. À {base_rate} %, vous gagneriez {base} par année. C'est {bonus} de plus.",
  },
  'affiliates.partners.calculator_summary_single_monthly': {
    en: 'At {rate}%, you could earn {monthly} a month, or {amount} a year.',
    fr: 'À {rate} %, vous pourriez gagner {monthly} par mois, soit {amount} par année.',
  },
  'affiliates.partners.calculator_note': {
    en: 'Estimates only. Your real earnings depend on the sales you refer.',
    fr: 'Estimation seulement. Vos revenus réels dépendent des ventes que vous recommandez.',
  },
} as const satisfies AffiliatesCopyDictionary;

/** The signup island, its states, and the messages the signup action returns. */
export const AFFILIATES_PARTNERS_SIGNUP_COPY = {
  'affiliates.partners.signup_title': { en: 'Claim your storefront', fr: 'Réservez votre vitrine' },
  'affiliates.partners.signup_intro': {
    en: 'It takes about a minute. You can finish your profile later.',
    fr: 'Ça prend environ une minute. Vous pourrez compléter votre profil plus tard.',
  },
  'affiliates.partners.signup_tier_note': {
    en: 'You will start on the {tier} tier at {rate}%.',
    fr: 'Vous commencerez au niveau {tier}, à {rate} %.',
  },
  'affiliates.partners.signup_have_account': { en: 'Already have an account?', fr: 'Vous avez déjà un compte?' },
  'affiliates.partners.signup_sign_in_first': { en: 'Sign in first', fr: "Connectez-vous d'abord" },
  'affiliates.partners.signup_closed': {
    en: 'Sign-ups are paused while we prepare new spots. Please check back soon.',
    fr: 'Les inscriptions sont en pause pendant que nous préparons de nouvelles places. Revenez bientôt.',
  },

  // Fields
  'affiliates.partners.signup_handle_label': { en: 'Your handle', fr: 'Votre identifiant' },
  'affiliates.partners.signup_handle_hint': {
    en: 'Use 3 to 32 lowercase letters, numbers or hyphens.',
    fr: "Utilisez de 3 à 32 lettres minuscules, chiffres ou traits d'union.",
  },
  'affiliates.partners.signup_handle_preview': { en: 'Your storefront address: {url}', fr: 'Adresse de votre vitrine : {url}' },
  'affiliates.partners.signup_handle_checking': { en: 'Checking availability…', fr: 'Vérification de la disponibilité…' },
  'affiliates.partners.signup_handle_available': {
    en: 'Good news: this handle is available.',
    fr: 'Bonne nouvelle : cet identifiant est disponible.',
  },
  'affiliates.partners.signup_handle_taken': {
    en: 'This handle is already taken. Try another one.',
    fr: 'Cet identifiant est déjà utilisé. Essayez-en un autre.',
  },
  'affiliates.partners.signup_handle_reserved': {
    en: 'This handle is reserved. Try another one.',
    fr: 'Cet identifiant est réservé. Essayez-en un autre.',
  },
  'affiliates.partners.signup_handle_invalid': {
    en: 'Use 3 to 32 lowercase letters, numbers or hyphens, starting and ending with a letter or number.',
    fr: "Utilisez de 3 à 32 lettres minuscules, chiffres ou traits d'union, en commençant et en terminant par une lettre ou un chiffre.",
  },
  'affiliates.partners.signup_handle_unknown': {
    en: "We couldn't check this handle right now. You can still send the form.",
    fr: 'Impossible de vérifier cet identifiant pour le moment. Vous pouvez quand même envoyer le formulaire.',
  },
  'affiliates.partners.signup_name_label': { en: 'Display name', fr: 'Nom affiché' },
  'affiliates.partners.signup_name_hint': { en: 'Shown at the top of your storefront.', fr: 'Affiché en haut de votre vitrine.' },
  'affiliates.partners.signup_email_label': { en: 'Email', fr: 'Courriel' },
  'affiliates.partners.signup_password_label': { en: 'Password', fr: 'Mot de passe' },
  'affiliates.partners.signup_password_hint': { en: 'At least 8 characters.', fr: 'Au moins 8 caractères.' },
  // {terms} is where the form renders the terms link (signup_terms_link); without it, the link follows the text.
  // A new key rather than new text under signup_terms_label (seeded without {terms} by an earlier 02031): an
  // older seeded row that differs from the dictionary reads as an operator override (affiliate-translation-rows.ts).
  'affiliates.partners.signup_terms_accept': {
    en: "I accept the {terms}. I will tell my audience that I earn a commission, and I won't buy through my own links.",
    fr: "J'accepte les {terms}. Je dirai à mon public que je touche une commission, et je n'achèterai pas avec mes propres liens.",
  },
  'affiliates.partners.signup_terms_link': { en: 'partner terms', fr: 'conditions du programme partenaires' },
  'affiliates.partners.signup_terms_new_tab': { en: '(opens in a new tab)', fr: "(s'ouvre dans un nouvel onglet)" },
  'affiliates.partners.signup_submit': { en: 'Create my partner account', fr: 'Créer mon compte partenaire' },
  'affiliates.partners.signup_submitting': { en: 'Creating your account…', fr: 'Création de votre compte…' },

  // Signed-in visitors
  'affiliates.partners.signup_signed_in_as': { en: 'You are signed in as {email}.', fr: 'Session ouverte avec {email}.' },
  'affiliates.partners.signup_upgrade_intro': {
    en: 'Claim a handle to turn this account into a partner account.',
    fr: 'Réservez un identifiant pour transformer ce compte en compte partenaire.',
  },
  'affiliates.partners.signup_upgrade_submit': { en: 'Become a partner', fr: 'Devenir partenaire' },
  'affiliates.partners.signup_partner_title': { en: 'You are already a partner', fr: 'Vous êtes déjà partenaire' },
  'affiliates.partners.signup_partner_body': {
    en: 'Your storefront, payouts and stats are waiting in your partner portal.',
    fr: 'Votre vitrine, vos versements et vos statistiques vous attendent dans votre portail partenaire.',
  },
  'affiliates.partners.signup_open_portal': { en: 'Open my partner portal', fr: 'Ouvrir mon portail partenaire' },
  'affiliates.partners.signup_staff_title': {
    en: 'Staff accounts cannot join',
    fr: 'Les comptes du personnel ne peuvent pas adhérer',
  },
  'affiliates.partners.signup_staff_body': {
    en: 'Sign out, then create a separate account to join the partner program.',
    fr: 'Déconnectez-vous, puis créez un compte distinct pour adhérer au programme de partenaires.',
  },

  // Outcomes
  'affiliates.partners.signup_check_email_title': { en: 'Check your email', fr: 'Vérifiez vos courriels' },
  'affiliates.partners.signup_check_email_body': {
    en: 'We sent you a link to confirm your address. Open it to finish setting up your storefront.',
    fr: 'Nous vous avons envoyé un lien pour confirmer votre adresse. Ouvrez-le pour terminer la création de votre vitrine.',
  },
  'affiliates.partners.signup_ready_title': { en: 'Your partner account is ready', fr: 'Votre compte partenaire est prêt' },
  'affiliates.partners.signup_ready_body': {
    en: 'Sign in to open your partner portal.',
    fr: 'Connectez-vous pour ouvrir votre portail partenaire.',
  },
  'affiliates.partners.signup_sign_in': { en: 'Sign in', fr: 'Se connecter' },

  // Errors returned by the signup action (the shared ones live in affiliates.common.error_*)
  'affiliates.partners.signup_error_captcha': {
    en: "We couldn't confirm that you're a person. Please try again.",
    fr: "Nous n'avons pas pu confirmer que vous êtes une personne. Veuillez réessayer.",
  },
  'affiliates.partners.signup_error_throttled': {
    en: 'Too many partner accounts were created from your network. Please try again in an hour.',
    fr: 'Trop de comptes partenaires ont été créés à partir de votre réseau. Veuillez réessayer dans une heure.',
  },
  'affiliates.partners.signup_error_account_exists': {
    en: 'An account already uses this email. Sign in first, then come back to claim your handle.',
    fr: "Un compte utilise déjà ce courriel. Connectez-vous d'abord, puis revenez réserver votre identifiant.",
  },
  'affiliates.partners.signup_error_factor_pending': {
    en: 'Finish signing in with your second factor, then try again.',
    fr: 'Terminez la connexion avec votre deuxième facteur, puis réessayez.',
  },
  'affiliates.partners.signup_error_terms': {
    en: 'Please accept the partner terms.',
    fr: 'Veuillez accepter les conditions du programme.',
  },
  'affiliates.partners.signup_error_email': { en: 'Enter a valid email address.', fr: 'Entrez une adresse courriel valide.' },
  'affiliates.partners.signup_error_password': {
    en: 'Use a password of at least 8 characters.',
    fr: "Utilisez un mot de passe d'au moins 8 caractères.",
  },
  'affiliates.partners.signup_error_name': {
    en: 'Enter a display name of up to 80 characters.',
    fr: "Entrez un nom affiché d'au plus 80 caractères.",
  },
} as const satisfies AffiliatesCopyDictionary;

/** Keys: `affiliates.partners.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file). */
export const AFFILIATES_PARTNERS_COPY = {
  ...AFFILIATES_PARTNERS_LANDING_COPY,
  ...AFFILIATES_PARTNERS_CALCULATOR_COPY,
  ...AFFILIATES_PARTNERS_SIGNUP_COPY,
} as const satisfies AffiliatesCopyDictionary;
