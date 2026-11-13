'use client';

/**
 * The storefront slash menu items (type `/` at the start of a line or after a space). Pure: the
 * React menu renders what `getStorefrontSlashItems()` returns. A query matches an item's English
 * and French titles and its keywords whatever the interface language, so `/promote`, `/products`
 * and `/produits` all find the product grid.
 */
import { AFFILIATES_EDITOR_COPY, type AffiliatesEditorCopyKey } from '../../i18n/copy/editor';
import { createAffiliatesCopy } from '../../i18n/copy-runtime';
import type { AffiliatesCopyTranslate } from '../../i18n/types';

export const STOREFRONT_SLASH_ITEM_IDS = [
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'quote',
  'divider',
  'callout',
  'image',
  'products',
] as const;

export type StorefrontSlashItemId = (typeof STOREFRONT_SLASH_ITEM_IDS)[number];

/** A slash menu entry, localized. */
export interface StorefrontSlashItem {
  id: StorefrontSlashItemId;
  title: string;
  description: string;
}

export interface StorefrontSlashItemsOptions {
  /** What follows the `/` (case, accents and surrounding spaces are ignored). */
  query?: string | null;
  /** Shows the Image item (only when the editor can upload images). */
  imageUpload?: boolean;
  /** Localized titles; default English. */
  translate?: AffiliatesCopyTranslate;
}

interface SlashItemDefinition {
  id: StorefrontSlashItemId;
  titleKey: AffiliatesEditorCopyKey;
  descriptionKey: AffiliatesEditorCopyKey;
  keywords: readonly string[];
  requiresImageUpload?: boolean;
}

const DEFINITIONS: readonly SlashItemDefinition[] = [
  {
    id: 'heading2',
    titleKey: 'affiliates.editor.heading_2',
    descriptionKey: 'affiliates.editor.slash_heading_2_description',
    keywords: ['h2', 'heading', 'title', 'titre', 'section'],
  },
  {
    id: 'heading3',
    titleKey: 'affiliates.editor.heading_3',
    descriptionKey: 'affiliates.editor.slash_heading_3_description',
    keywords: ['h3', 'heading', 'subheading', 'title', 'titre', 'sous-titre'],
  },
  {
    id: 'bulletList',
    titleKey: 'affiliates.editor.bullet_list',
    descriptionKey: 'affiliates.editor.slash_bullet_list_description',
    keywords: ['list', 'bullets', 'ul', 'liste', 'puces'],
  },
  {
    id: 'orderedList',
    titleKey: 'affiliates.editor.ordered_list',
    descriptionKey: 'affiliates.editor.slash_ordered_list_description',
    keywords: ['list', 'numbers', 'ol', 'steps', 'liste', 'numeros', 'etapes'],
  },
  {
    id: 'quote',
    titleKey: 'affiliates.editor.quote',
    descriptionKey: 'affiliates.editor.slash_quote_description',
    keywords: ['quote', 'blockquote', 'testimonial', 'citation', 'temoignage'],
  },
  {
    id: 'divider',
    titleKey: 'affiliates.editor.divider',
    descriptionKey: 'affiliates.editor.slash_divider_description',
    keywords: ['divider', 'separator', 'line', 'hr', 'separateur', 'ligne'],
  },
  {
    id: 'callout',
    titleKey: 'affiliates.editor.callout',
    descriptionKey: 'affiliates.editor.slash_callout_description',
    keywords: ['callout', 'tip', 'note', 'highlight', 'encadre', 'astuce'],
  },
  {
    id: 'image',
    titleKey: 'affiliates.editor.slash_image_title',
    descriptionKey: 'affiliates.editor.slash_image_description',
    keywords: ['image', 'photo', 'picture', 'upload', 'televerser'],
    requiresImageUpload: true,
  },
  {
    id: 'products',
    titleKey: 'affiliates.editor.slash_products_title',
    descriptionKey: 'affiliates.editor.slash_products_description',
    keywords: ['promote', 'products', 'product', 'produits', 'produit', 'promouvoir', 'shop', 'boutique', 'grid', 'grille'],
  },
];

const ENGLISH = createAffiliatesCopy({ locale: 'en', dictionary: AFFILIATES_EDITOR_COPY });

/** Lowercase, accents removed, trimmed. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function haystacks(definition: SlashItemDefinition, translate: AffiliatesCopyTranslate): string[] {
  const entry = AFFILIATES_EDITOR_COPY[definition.titleKey];
  return [translate(definition.titleKey), entry.en, entry.fr, ...definition.keywords].map(fold);
}

/**
 * The items for a query, best matches first (an item whose title or keyword starts with the
 * query ranks above one that only contains it), in menu order otherwise.
 */
export function getStorefrontSlashItems(options: StorefrontSlashItemsOptions = {}): StorefrontSlashItem[] {
  const translate = options.translate ?? ENGLISH;
  const query = fold(String(options.query ?? '').slice(0, 64));
  const available = DEFINITIONS.filter((definition) => !definition.requiresImageUpload || options.imageUpload === true);

  const ranked: Array<{ definition: SlashItemDefinition; rank: number }> = [];
  for (const definition of available) {
    if (query === '') {
      ranked.push({ definition, rank: 0 });
      continue;
    }
    const values = haystacks(definition, translate);
    if (values.some((value) => value.startsWith(query) || value.split(/[\s-]+/).some((word) => word.startsWith(query)))) {
      ranked.push({ definition, rank: 0 });
    } else if (values.some((value) => value.includes(query))) {
      ranked.push({ definition, rank: 1 });
    }
  }

  return ranked
    .sort((a, b) => a.rank - b.rank)
    .map(({ definition }) => ({
      id: definition.id,
      title: translate(definition.titleKey),
      description: translate(definition.descriptionKey),
    }));
}
