import type { AffiliatesCopyDictionary } from '../types';

/**
 * Keys: `affiliates.storefront.<snake_name>`. Seeded EN + FR by migration 02031 (generated from this file).
 * The public storefront `/partners/<handle>`: metadata fallbacks, the partner header, the affiliate
 * disclosure, product sections, photo credits and the Open Graph card.
 */
export const AFFILIATES_STOREFRONT_COPY = {
  // Metadata fallbacks (the approved page title and meta description win)
  'affiliates.storefront.meta_title_fallback': { en: "{name}'s picks", fr: 'La sélection de {name}' },
  'affiliates.storefront.meta_description_fallback': {
    en: "Shop {name}'s favorite products, hand-picked and personally recommended. Every pick is chosen with care.",
    fr: 'Magasinez les produits préférés de {name}, choisis avec soin et recommandés personnellement.',
  },
  'affiliates.storefront.not_found_title': { en: 'Storefront not found', fr: 'Vitrine introuvable' },

  // Partner header
  'affiliates.storefront.tier_label': { en: 'Partner tier', fr: 'Niveau de partenaire' },
  'affiliates.storefront.disclosure': {
    en: '{name} earns a commission on purchases made through this page, at no extra cost to you.',
    fr: '{name} touche une commission sur les achats faits à partir de cette page, sans frais supplémentaires pour vous.',
  },
  'affiliates.storefront.social_nav_label': { en: '{name} on social media', fr: '{name} sur les réseaux sociaux' },
  'affiliates.storefront.social_website': { en: 'Website', fr: 'Site Web' },
  'affiliates.storefront.opens_new_tab': { en: '(opens in a new tab)', fr: "(s'ouvre dans un nouvel onglet)" },

  // Products
  'affiliates.storefront.products_title': { en: 'Products', fr: 'Produits' },
  'affiliates.storefront.featured_title': { en: 'Featured products', fr: 'Produits en vedette' },

  // Images (the renderer links both names)
  'affiliates.storefront.photo_credit': { en: 'Photo: {photographer} / {provider}', fr: 'Photo : {photographer} / {provider}' },

  // Join prompt at the bottom of every storefront
  'affiliates.storefront.join_cta_text': { en: 'Want a storefront like this one?', fr: 'Vous voulez une vitrine comme celle-ci?' },
  'affiliates.storefront.join_cta_link': { en: 'Join the partner program', fr: 'Joignez-vous au programme de partenaires' },

  // Open Graph card
  'affiliates.storefront.og_tagline': { en: 'Shop my picks', fr: 'Magasinez ma sélection' },
} as const satisfies AffiliatesCopyDictionary;
