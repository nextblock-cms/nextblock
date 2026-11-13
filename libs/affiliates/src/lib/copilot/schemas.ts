/**
 * Input schemas of the three copilot tools (SPEC §8). Strict-mode friendly on purpose: flat
 * objects, every property required (empty values instead of optional ones), no unions, enums
 * only, extra keys rejected. Models fail at nested editor JSON, so a section is a flat list of
 * typed blocks that `retailerSectionToStorefrontBlocks()` turns into storefront nodes.
 *
 * Every description is a literal: the tool list must be byte-identical across requests.
 */
import { z } from '../zod-config';

export const RETAILER_SECTION_BLOCK_KINDS = [
  'heading',
  'paragraph',
  'bullet_list',
  'callout',
  'image',
  'product_grid',
] as const;

export const RETAILER_SECTION_BLOCK_TONES = ['info', 'tip', 'highlight', 'none'] as const;

export const retailerBioToolInputSchema = z.strictObject({
  bio: z
    .string()
    .min(80)
    .max(1200)
    .describe(
      "The partner's public bio, 80 to 1200 characters of plain text in the first person: who they are, why they recommend these products, and a natural disclosure that they earn a commission on purchases made through their page. No markdown, no HTML, no prices or discounts, no medical, health or income claims."
    ),
  meta_description: z
    .string()
    .min(70)
    .max(160)
    .describe(
      "The SEO meta description of the partner's storefront page: one plain-text sentence of 70 to 160 characters that says whose picks these are and what a visitor will find."
    ),
});

export const retailerSectionBlockInputSchema = z.strictObject({
  kind: z
    .enum(RETAILER_SECTION_BLOCK_KINDS)
    .describe(
      'heading: a sub-heading (text). paragraph: prose (text; a blank line starts a new paragraph). bullet_list: a list (items). callout: a highlighted tip or note (text and tone). image: one stock photo found with image_query (text is its alt text). product_grid: store products by id (product_ids; text is an optional grid title).'
    ),
  text: z
    .string()
    .max(1200)
    .describe(
      'The text of a heading, paragraph or callout, the alt text of an image, or the optional title of a product grid; "" when unused. Paragraphs and callouts may use **bold**, *italic* and [label](https://example.com) links, and nothing else.'
    ),
  items: z
    .array(z.string().max(300))
    .max(8)
    .describe('bullet_list only: up to 8 list items in plain text (**bold**, *italic* and links allowed). [] for every other kind.'),
  tone: z
    .enum(RETAILER_SECTION_BLOCK_TONES)
    .describe('callout only: info, tip or highlight. none for every other kind.'),
  image_query: z
    .string()
    .max(120)
    .describe(
      'image only: a short English search for a free stock photo, for example "cozy reading nook with plants". Never a URL. "" for every other kind.'
    ),
  product_ids: z
    .array(z.string().max(64))
    .max(8)
    .describe(
      'product_grid only: up to 8 product ids copied exactly from the store catalog in your instructions. Never invent an id. [] for every other kind.'
    ),
});

export const retailerSectionToolInputSchema = z.strictObject({
  section_title: z
    .string()
    .min(2)
    .max(120)
    .describe('The heading that opens the new section, 2 to 120 characters of plain text.'),
  blocks: z
    .array(retailerSectionBlockInputSchema)
    .min(1)
    .max(12)
    .describe(
      'The blocks of the section in reading order (1 to 12). Every block lists every field: fill the fields its kind uses and leave the others empty ("" or [], tone none).'
    ),
});

export const retailerRewriteToolInputSchema = z.strictObject({
  rewritten_text: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "The improved copy that replaces the partner's selected text: plain text, the same meaning and facts, in the language of the selection unless the partner asked for another one. No invented prices, discounts or claims."
    ),
});

export type RetailerSectionBlockKind = (typeof RETAILER_SECTION_BLOCK_KINDS)[number];
export type RetailerSectionBlockTone = (typeof RETAILER_SECTION_BLOCK_TONES)[number];
export type RetailerBioToolInput = z.infer<typeof retailerBioToolInputSchema>;
export type RetailerSectionBlockInput = z.infer<typeof retailerSectionBlockInputSchema>;
export type RetailerSectionToolInput = z.infer<typeof retailerSectionToolInputSchema>;
export type RetailerRewriteToolInput = z.infer<typeof retailerRewriteToolInputSchema>;
