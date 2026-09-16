import { z } from './zod-config';

/**
 * The block vocabulary Cortex AI can write, and the schemas that guard it.
 *
 * Two validators exist for the same JSONB, on purpose:
 *
 *   1. The app's own `validateBlockContent` (apps/nextblock/lib/blocks/blockRegistry.ts)
 *      holds the authoritative Zod schemas. Both the dashboard chat route and the MCP
 *      route inject it into the tool context, so every block Cortex writes through a
 *      typed tool is checked against the exact schema the editor and renderer use.
 *   2. `fallbackBlockSchemas` below mirrors those schemas for the cases where the app
 *      is not around: unit tests, the CLI verifier, a future headless runner. libs/*
 *      cannot import from the app, so the mirror is restated here; keep it in sync
 *      when a block type gains a field.
 *
 * This module is deliberately free of tool-execution concerns so that the generic
 * database tools (`execute_database_mutation` on `blocks`) can reuse the same
 * validation the typed content tools apply, instead of writing unvalidated JSONB.
 */

export const availableCortexAiBlockTypes = [
  'text',
  'heading',
  'image',
  'button',
  'posts_grid',
  'video_embed',
  'section',
  'form',
  'testimonial',
  'product_grid',
  'featured_product',
  'cart',
  'checkout',
  'product_details',
] as const;

export type BlockType = (typeof availableCortexAiBlockTypes)[number];

export type BlockValidationResult = {
  errors: string[];
  isValid: boolean;
  warnings: string[];
};

export type BlockContentValidator = (
  blockType: BlockType,
  content: Record<string, any>
) => BlockValidationResult;

/** The slice of a tool context the validators care about. */
export type BlockValidationContext = {
  validateBlockContent?: BlockContentValidator;
};

export const cortexAiBlockTypeSchema = z.enum(availableCortexAiBlockTypes);
const gradientSchema = z.object({
  direction: z.string().optional(),
  stops: z.array(z.object({ color: z.string(), position: z.number() })),
  type: z.enum(['linear', 'radial']),
});
const backgroundSchema = z.object({
  gradient: gradientSchema.optional(),
  image: z
    .object({
      alt_text: z.string().optional(),
      blur_data_url: z.string().optional(),
      external_url: z.string().optional(),
      height: z.number().optional(),
      media_id: z.string().optional(),
      object_key: z.string().optional(),
      overlay: z
        .object({
          gradient: gradientSchema,
          type: z.literal('gradient'),
        })
        .optional(),
      position: z.enum(['center', 'top', 'bottom', 'left', 'right']),
      quality: z.number().nullable().optional(),
      size: z.enum(['cover', 'contain']),
      width: z.number().optional(),
    })
    .optional(),
  min_height: z.string().optional(),
  solid_color: z.string().optional(),
  theme: z.enum(['primary', 'secondary', 'muted', 'accent', 'destructive']).optional(),
  type: z.enum(['none', 'theme', 'solid', 'gradient', 'image']),
});
// A nested block is a built-in type or a custom block definition slug; the slug
// pattern mirrors the custom_block_definitions_slug_check constraint.
export const customBlockSlugPatternSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const blockInColumnSchema = z.object({
  block_type: z.union([cortexAiBlockTypeSchema, customBlockSlugPatternSchema]),
  content: z.record(z.string(), z.any()),
  temp_id: z.string().optional(),
});
// One carousel slide: a full section body of its own (background + columns).
const sectionSlideSchema = z.object({
  background: backgroundSchema,
  column_blocks: z.array(z.array(blockInColumnSchema)),
});
export const sectionBlockFallbackSchema = z.object({
  // Slider settings mirror the editor's "Enable Slider (Carousel layout)" panel:
  // `autoplay` rotates the slides every `timeframe` SECONDS (5 when omitted).
  autoplay: z.boolean().optional(),
  background: backgroundSchema,
  column_blocks: z.array(z.array(blockInColumnSchema)),
  column_gap: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
  container_type: z.enum(['full-width', 'container', 'container-sm', 'container-lg', 'container-xl']),
  // The editor's "Hero Section (Prioritized image loading)" checkbox: the section's
  // background image (and the first slide's images) load with priority, and the
  // normalizer centres its content vertically.
  is_hero: z.boolean().optional(),
  padding: z.object({
    bottom: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
    top: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
  }),
  responsive_columns: z.object({
    desktop: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    mobile: z.union([z.literal(1), z.literal(2)]),
    tablet: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  // With `slider: true` and a non-empty `slides` list the renderer shows a carousel
  // of those slides and ignores the top-level `column_blocks` and `background`.
  slider: z.boolean().optional(),
  slides: z.array(sectionSlideSchema).optional(),
  timeframe: z.number().optional(),
  vertical_alignment: z.enum(['start', 'center', 'end', 'stretch']).optional(),
});
export const fallbackBlockSchemas: Record<BlockType, z.ZodTypeAny> = {
  button: z.object({
    position: z.enum(['left', 'center', 'right']).optional(),
    size: z.enum(['default', 'sm', 'lg', 'full']).optional(),
    text: z.string(),
    url: z.string(),
    variant: z.enum(['default', 'outline', 'secondary', 'ghost', 'link']).optional(),
  }),
  cart: z.object({}),
  checkout: z.object({}),
  featured_product: z.object({
    imagePosition: z.enum(['left', 'right']).default('left'),
    productId: z.string().min(1),
    showBackground: z.boolean().default(false),
  }),
  form: z.object({
    fields: z.array(
      z.object({
        field_type: z.enum(['text', 'email', 'textarea', 'select', 'radio', 'checkbox']),
        is_required: z.boolean(),
        label: z.string(),
        options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        placeholder: z.string().optional(),
        temp_id: z.string(),
      })
    ),
    // Opaque handle into form_endpoints, which holds the destination server-side.
    form_key: z.string().optional(),
    // Legacy. Migration 27 moved every address out of block content; kept optional so
    // an older payload still validates, and stripped before the block reaches a browser.
    recipient_email: z.string().email().optional(),
    submit_button_text: z.string(),
    success_message: z.string(),
  }),
  heading: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
    // Mirrors TextColorSchema in apps/nextblock/lib/blocks/blockRegistry.ts —
    // a theme token, or a literal CSS colour from the block editor's picker.
    // libs/* cannot import from the app, so the union is restated here.
    textColor: z
      .union([
        z.enum(['foreground', 'primary', 'secondary', 'accent', 'muted', 'destructive', 'background']),
        z
          .string()
          .regex(
            /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]+\)|hsla?\([^)]+\))$/i,
            'Must be a hex, rgb(a) or hsl(a) colour',
          ),
      ])
      .optional()
      .describe('Prefer a theme token so the heading adapts to dark mode; use a CSS colour only when the brand requires an exact value'),
    text_content: z.string(),
  }),
  image: z.object({
    alt_text: z.string().optional(),
    caption: z.string().optional(),
    external_url: z.string().nullable().optional(),
    height: z.number().nullable().optional(),
    media_id: z.string().nullable().optional(),
    object_key: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
  }),
  posts_grid: z.object({
    columns: z.number().min(1).max(6),
    postsPerPage: z.number().min(1).max(50),
    showPagination: z.boolean(),
    title: z.string().optional(),
  }),
  product_details: z.object({}),
  product_grid: z.object({
    categoryId: z.string().optional(),
    categoryIds: z.array(z.string()).max(20).optional(),
    // 0 = unlimited (every match on one page).
    limit: z.number().min(0).max(48).default(6),
    productIds: z.array(z.string()).max(24).optional(),
    showPagination: z.boolean().default(false),
    title: z.string().optional(),
    type: z.enum(['latest', 'category', 'manual']).default('latest'),
  }),
  section: sectionBlockFallbackSchema,
  testimonial: z.object({
    author_name: z.string().min(1),
    author_title: z.string().optional(),
    image_url: z.string().url().optional().or(z.literal('')),
    quote: z.string().min(1),
  }),
  text: z.object({
    html_content: z.string(),
  }),
  video_embed: z.object({
    autoplay: z.boolean().optional(),
    controls: z.boolean().optional(),
    title: z.string().optional(),
    url: z.string(),
  }),
};
export function isValidBlockType(blockType: string): blockType is BlockType {
  return (availableCortexAiBlockTypes as readonly string[]).includes(blockType);
}

function getRuntimeBlockContentValidator(context?: BlockValidationContext) {
  return typeof context?.validateBlockContent === 'function'
    ? context.validateBlockContent
    : null;
}

export function validateCortexBlockContent(
  blockType: BlockType,
  content: Record<string, unknown>,
  context?: BlockValidationContext
): BlockValidationResult {
  const runtimeValidator = getRuntimeBlockContentValidator(context);

  if (runtimeValidator) {
    return runtimeValidator(blockType, content);
  }

  const result = fallbackBlockSchemas[blockType].safeParse(content);

  if (result.success) {
    return { errors: [], isValid: true, warnings: [] };
  }

  return {
    errors: result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
    isValid: false,
    warnings: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Custom block instances                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A block whose `block_type` is a `custom_block_definitions.slug` rather than a
 * built-in type. Its `content` is the flat `{ field_key: value }` map the
 * DynamicLayoutEngine renders from the definition's `fields`.
 *
 * Only the pieces of the definition the validator needs; the row carries more.
 */
export type CustomBlockDefinitionLike = {
  fields?: unknown;
  name?: string | null;
  slug: string;
};

type CustomBlockFieldLike = {
  key: string;
  max_length?: number;
  min_length?: number;
  multiple?: boolean;
  required?: boolean;
  type: 'db_relation' | 'image_r2' | 'rich-text' | 'text';
};

export function readCustomBlockFields(definition: CustomBlockDefinitionLike): CustomBlockFieldLike[] {
  if (!Array.isArray(definition.fields)) {
    return [];
  }

  return definition.fields.filter(
    (field): field is CustomBlockFieldLike =>
      Boolean(field) &&
      typeof field === 'object' &&
      typeof (field as CustomBlockFieldLike).key === 'string' &&
      typeof (field as CustomBlockFieldLike).type === 'string'
  );
}

function isEmptyCustomBlockValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Validate the `{ field_key: value }` content of a custom block instance against
 * its definition. Mirrors what the block editor lets an author save:
 *
 *   text / rich-text  -> string (rich-text is HTML), honouring min/max length
 *   image_r2          -> null or { object_key, url, ... } as the uploader stores it
 *   db_relation       -> null, an id, or an array of ids when `multiple`
 *
 * Unknown keys are rejected rather than stripped, so a model that guesses a field
 * name gets an error naming the real keys instead of silently losing its copy.
 */
export function validateCustomBlockInstanceContent(
  definition: CustomBlockDefinitionLike,
  content: unknown
): BlockValidationResult {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return {
      errors: ['content must be a JSON object of { field_key: value } pairs.'],
      isValid: false,
      warnings: [],
    };
  }

  const fields = readCustomBlockFields(definition);
  const knownKeys = new Set(fields.map((field) => field.key));
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(content as Record<string, unknown>)) {
    if (!knownKeys.has(key)) {
      errors.push(
        `Unknown field "${key}" for custom block "${definition.slug}". Known fields: ${
          [...knownKeys].join(', ') || '(none)'
        }.`
      );
    }
  }

  for (const field of fields) {
    const value = (content as Record<string, unknown>)[field.key];

    if (isEmptyCustomBlockValue(value)) {
      if (field.required) {
        errors.push(`Field "${field.key}" is required.`);
      }
      continue;
    }

    if (field.type === 'text' || field.type === 'rich-text') {
      if (typeof value !== 'string') {
        errors.push(`Field "${field.key}" must be a string${field.type === 'rich-text' ? ' of HTML' : ''}.`);
        continue;
      }

      if (typeof field.max_length === 'number' && value.length > field.max_length) {
        errors.push(`Field "${field.key}" exceeds its ${field.max_length}-character limit.`);
      }

      if (typeof field.min_length === 'number' && value.length < field.min_length) {
        errors.push(`Field "${field.key}" is shorter than its ${field.min_length}-character minimum.`);
      }

      continue;
    }

    if (field.type === 'image_r2') {
      const image = value as Record<string, unknown>;

      if (
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof image['object_key'] !== 'string' ||
        typeof image['url'] !== 'string'
      ) {
        errors.push(
          `Field "${field.key}" must be an uploaded image object with object_key and url (upload it with upload_media first) or null.`
        );
      }

      continue;
    }

    if (field.type === 'db_relation') {
      const isId = (candidate: unknown) => typeof candidate === 'string' || typeof candidate === 'number';

      if (field.multiple) {
        if (!Array.isArray(value) || !value.every(isId)) {
          errors.push(`Field "${field.key}" must be an array of related record ids.`);
        }
      } else if (!isId(value)) {
        errors.push(`Field "${field.key}" must be a single related record id.`);
      }

      continue;
    }

    warnings.push(`Field "${field.key}" has an unrecognised type "${String(field.type)}"; it was not validated.`);
  }

  return { errors, isValid: errors.length === 0, warnings };
}

/** Load the custom block definitions a `block_type` slug may resolve to. */
export async function loadCustomBlockDefinitions(supabase: {
  from: (table: string) => any;
}): Promise<CustomBlockDefinitionLike[]> {
  const { data, error } = await supabase
    .from('custom_block_definitions')
    .select('slug, name, fields');

  if (error) {
    throw new Error(
      `Could not read the custom block definitions: ${
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: unknown }).message)
          : String(error)
      }`
    );
  }

  return (Array.isArray(data) ? data : []).filter(
    (row): row is CustomBlockDefinitionLike => Boolean(row) && typeof row.slug === 'string'
  );
}
