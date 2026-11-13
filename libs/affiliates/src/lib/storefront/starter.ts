/**
 * The starter storefront a new partner gets at signup (`create_affiliate_account` stores it as the
 * first `draft_content`), with its page title and meta description. English or Québec French.
 * The documents are already in sanitized form: `sanitizeStorefrontDoc()` returns them unchanged.
 */
import { cleanStorefrontText, truncateStorefrontText } from './text';
import type { StorefrontDoc } from './types';

export interface StorefrontStarterInput {
  /** `en`, `fr`, `fr-CA`, …; anything that does not start with `fr` builds the English version. */
  locale: string | null | undefined;
  /** The partner's display name (cleaned, collapsed and cut to 80 characters here). */
  displayName: string | null | undefined;
}

const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 120;
const META_MIN_LENGTH = 70;
const META_MAX_LENGTH = 160;

function isFrench(locale: unknown): boolean {
  return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('fr');
}

function starterName(displayName: unknown): string {
  if (typeof displayName !== 'string') return '';
  const window = displayName.length > MAX_NAME_LENGTH * 8 ? displayName.slice(0, MAX_NAME_LENGTH * 8) : displayName;
  const cleaned = cleanStorefrontText(window, { singleLine: true }).text.replace(/\s+/g, ' ').trim();
  return truncateStorefrontText(cleaned, MAX_NAME_LENGTH).trimEnd();
}

function paragraph(text: string): StorefrontDoc['content'][number] {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/**
 * The starter document: a welcome heading, an intro that discloses the commission, a callout tip
 * about `/promote`, an empty three-column product grid and a closing line.
 */
export function buildStorefrontStarterDoc(input: StorefrontStarterInput): StorefrontDoc {
  const name = starterName(input?.displayName);
  if (isFrench(input?.locale)) {
    return {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            {
              type: 'text',
              text: name ? `Bienvenue dans la sélection de ${name}` : 'Bienvenue dans ma sélection',
            },
          ],
        },
        paragraph(
          "Voici les produits que j'utilise, que j'adore et que je recommande. Quand vous magasinez à partir de cette page, je reçois une petite commission, sans frais supplémentaires pour vous.",
        ),
        {
          type: 'storefrontCallout',
          attrs: { tone: 'tip' },
          content: [
            {
              type: 'text',
              text: 'Utilisez /promote pour ajouter des produits de la boutique, puis remplacez ce texte par votre propre histoire.',
            },
          ],
        },
        {
          type: 'affiliateProductGrid',
          attrs: { productIds: [], title: 'Mes produits préférés', columns: 3 },
        },
        paragraph('Merci de soutenir mon travail, et bon magasinage!'),
      ],
    };
  }
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: name ? `Welcome to ${name}'s picks` : 'Welcome to my picks' }],
      },
      paragraph(
        'These are the products I use, love and recommend. When you shop through this page, I earn a small commission at no extra cost to you.',
      ),
      {
        type: 'storefrontCallout',
        attrs: { tone: 'tip' },
        content: [
          {
            type: 'text',
            text: 'Use /promote to add products from the store, then replace this text with your own story.',
          },
        ],
      },
      {
        type: 'affiliateProductGrid',
        attrs: { productIds: [], title: 'My favorite products', columns: 3 },
      },
      paragraph('Thanks for supporting my work, and happy shopping!'),
    ],
  };
}

/** The starter page title (≤ 120 characters, the `affiliate_pages.title` CHECK). */
export function buildStorefrontStarterTitle(input: StorefrontStarterInput): string {
  const name = starterName(input?.displayName);
  const title = isFrench(input?.locale)
    ? name
      ? `La sélection de ${name}`
      : 'Ma sélection'
    : name
      ? `${name}'s picks`
      : 'My picks';
  return truncateStorefrontText(title, MAX_TITLE_LENGTH).trimEnd();
}

/** The starter meta description: 70 to 160 characters for any display name. */
export function buildStorefrontStarterMetaDescription(input: StorefrontStarterInput): string {
  const name = starterName(input?.displayName);
  const french = isFrench(input?.locale);
  const candidates = name
    ? french
      ? [
          `Découvrez les produits préférés de ${name}, choisis avec soin et recommandés personnellement. Magasinez la sélection en toute confiance.`,
          `Découvrez les produits préférés de ${name}, choisis avec soin et recommandés personnellement.`,
          `Les produits préférés de ${name}, choisis avec soin et recommandés personnellement.`,
        ]
      : [
          `Discover ${name}'s favorite products, hand-picked and personally recommended. Shop the picks with confidence.`,
          `Discover ${name}'s favorite products, hand-picked and personally recommended.`,
          `${name}'s favorite products, hand-picked and personally recommended.`,
        ]
    : french
      ? [
          'Découvrez mes produits préférés, choisis avec soin et recommandés personnellement. Magasinez la sélection en toute confiance.',
        ]
      : ['Discover my favorite products, hand-picked and personally recommended. Shop the picks with confidence.'];
  for (const candidate of candidates) {
    if (candidate.length >= META_MIN_LENGTH && candidate.length <= META_MAX_LENGTH) return candidate;
  }
  const fallback = candidates[candidates.length - 1] ?? '';
  return `${truncateStorefrontText(fallback, META_MAX_LENGTH - 1).trimEnd()}…`;
}
