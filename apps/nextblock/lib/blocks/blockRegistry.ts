import { z } from '../zod-config';
import { TestimonialBlockConfig, TestimonialBlockContent } from '../../components/blocks/TestimonialBlock';
import { ProductGridBlockSchema, ProductGridBlockContent, FeaturedProductBlockSchema, FeaturedProductBlockContent, CartBlockSchema, CartBlockContent, CheckoutBlockSchema, CheckoutBlockContent, ProductDetailsBlockSchema, ProductDetailsBlockContent } from './ecommerce-block-schemas';
import { availableBlockTypes, type BlockType } from './blockTypes';
import { isCustomCssColor, TEXT_COLOR_TOKENS } from './blockColors';
export { availableBlockTypes, type BlockType } from './blockTypes';

/**
 * Block Registry System
 *
 * This module provides the central registry for all block types in the CMS.
 * It serves as the single source of truth for block definitions, including
 * their initial content, editor components, renderer components, and Zod schemas.
 */

// --- Zod Schemas & Inferred Types ---

export const TextBlockSchema = z.object({
  html_content: z.string().describe('Raw HTML content for the text block'),
});
export type TextBlockContent = z.infer<typeof TextBlockSchema>;

/**
 * A text colour is either a theme token (keeps following the theme and dark
 * mode) or a literal CSS colour from the colour picker. Existing rows only ever
 * hold tokens, so widening the union is backward compatible.
 * See `./blockColors` for the token -> class mapping used at render time.
 */
export const TextColorSchema = z
  .union([
    z.enum(TEXT_COLOR_TOKENS),
    z
      .string()
      .refine(isCustomCssColor, 'Must be a hex, rgb(a), hsl(a) or named CSS colour'),
  ])
  .describe(
    `A theme token (${TEXT_COLOR_TOKENS.join(', ')}) or a custom CSS colour such as "#FF8800", "rgba(255,136,0,0.8)" or "hsl(28, 100%, 50%)"`,
  );

export const HeadingBlockSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).describe('Heading level (1-6)'),
  text_content: z.string().describe('The text content of the heading'),
  textAlign: z.enum(['left', 'center', 'right', 'justify']).optional().describe('Text alignment'),
  textColor: TextColorSchema.optional().describe('Color of the heading text'),
});
export type HeadingBlockContent = z.infer<typeof HeadingBlockSchema>;

// Stock-photo attribution (required for Unsplash: photographer + Unsplash must be
// credited and linked). Optional; set when an external_url is a stock photo. Field
// names match the search_stock_photos result so the agent can copy them verbatim.
// All fields are nullable + optional: the search_stock_photos result carries
// explicit nulls for missing values (e.g. Pexels has no downloadLocation, and
// utmSource is null until the Unsplash app name is set), and the agent copies the
// object verbatim — so the schema must accept null, not just undefined.
export const ImageAttributionSchema = z.object({
  provider: z.string().nullable().optional().describe('e.g. "unsplash" or "pexels"'),
  photographer: z.string().nullable().optional(),
  photographerUrl: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional().describe('Link to the photo on the provider'),
  downloadLocation: z.string().nullable().optional().describe('Unsplash download-trigger endpoint'),
  utmSource: z.string().nullable().optional().describe('Unsplash app name for attribution utm_source'),
});
export type ImageAttribution = z.infer<typeof ImageAttributionSchema>;

export const ImageBlockSchema = z.object({
  media_id: z.string().nullable().optional().describe('UUID of the media item'),
  object_key: z.string().nullable().optional().describe('The actual R2 object key'),
  external_url: z
    .string()
    .nullable()
    .optional()
    .describe('Direct external image URL (e.g. a stock photo). Rendered as-is; media_id/object_key are not required when this is set.'),
  attribution: ImageAttributionSchema.optional().describe('Stock-photo credit (required for Unsplash).'),
  alt_text: z.string().optional().describe('Alternative text'),
  caption: z.string().optional().describe('Optional caption'),
  width: z.number().nullable().optional().describe('Image width'),
  height: z.number().nullable().optional().describe('Image height'),
  blur_data_url: z.string().nullable().optional().describe('Base64 blur placeholder'),
});
export type ImageBlockContent = z.infer<typeof ImageBlockSchema>;

export const ButtonBlockSchema = z.object({
  text: z.string().describe('The text displayed on the button'),
  url: z.string().describe('The URL the button links to'),
  variant: z.enum(['default', 'outline', 'secondary', 'ghost', 'link']).optional().describe('Visual style variant'),
  size: z.enum(['default', 'sm', 'lg', 'full']).optional().describe('Size of the button'),
  position: z.enum(['left', 'center', 'right']).optional().describe('Button alignment'),
});
export type ButtonBlockContent = z.infer<typeof ButtonBlockSchema>;

export const PostsGridBlockSchema = z.object({
  postsPerPage: z.number().min(1).max(50).describe('Number of posts per page'),
  columns: z.number().min(1).max(6).describe('Number of columns'),
  showPagination: z.boolean().describe('Whether to show pagination'),
  title: z.string().optional().describe('Optional title'),
});
export type PostsGridBlockContent = z.infer<typeof PostsGridBlockSchema>;

export const VideoEmbedBlockSchema = z.object({
  url: z.string().describe('The video URL'),
  title: z.string().optional().describe('Optional title'),
  autoplay: z.boolean().optional().describe('Autoplay'),
  controls: z.boolean().optional().describe('Show controls'),
});
export type VideoEmbedBlockContent = z.infer<typeof VideoEmbedBlockSchema>;

// Section helpers
const GradientSchema = z.object({
  type: z.enum(['linear', 'radial']),
  direction: z.string().optional(),
  stops: z.array(z.object({ color: z.string(), position: z.number() })),
});
export type Gradient = z.infer<typeof GradientSchema>;

const BackgroundSchema = z.object({
  type: z.enum(['none', 'theme', 'solid', 'gradient', 'image']),
  theme: z.enum(['primary', 'secondary', 'muted', 'accent', 'destructive']).optional(),
  solid_color: z.string().optional(),
  min_height: z.string().optional(),
  gradient: GradientSchema.optional(),
  image: z.object({
    media_id: z.string().optional(),
    object_key: z.string().optional(),
    external_url: z.string().optional(),
    attribution: ImageAttributionSchema.optional(),
    alt_text: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    blur_data_url: z.string().optional(),
    size: z.enum(['cover', 'contain']),
    position: z.enum(['center', 'top', 'bottom', 'left', 'right']),
    quality: z.number().nullable().optional(),
    overlay: z.object({
      type: z.literal('gradient'),
      gradient: GradientSchema,
    }).optional(),
  }).optional(),
});

// A nested block is a built-in type or a custom block definition slug: the
// SectionBlockRenderer resolves a non-built-in block_type through
// custom_block_definitions, so the schema must admit those slugs too (pattern
// mirrors the custom_block_definitions_slug_check constraint).
const BlockInColumnSchema = z.object({
  block_type: z.union([z.enum(availableBlockTypes), z.string().regex(/^[a-z][a-z0-9-]*$/)]),
  content: z.record(z.string(), z.any()),
  temp_id: z.string().optional(),
});

const SlideSchema = z.object({
  background: BackgroundSchema,
  column_blocks: z.array(z.array(BlockInColumnSchema)),
});

export const SectionBlockSchema = z.object({
  container_type: z.enum(['full-width', 'container', 'container-sm', 'container-lg', 'container-xl']),
  background: BackgroundSchema,
  responsive_columns: z.object({
    mobile: z.union([z.literal(1), z.literal(2)]),
    tablet: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    desktop: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
  column_gap: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
  padding: z.object({
    top: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
    bottom: z.enum(['none', 'sm', 'md', 'lg', 'xl']),
  }),
  vertical_alignment: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  column_blocks: z.array(z.array(BlockInColumnSchema)),
  is_hero: z.boolean().optional(),
  slider: z.boolean().optional(),
  autoplay: z.boolean().optional(),
  timeframe: z.number().optional(),
  slides: z.array(SlideSchema).optional(),
});
export type SectionBlockContent = z.infer<typeof SectionBlockSchema>;



// Form helpers
export const FormFieldOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type FormFieldOption = z.infer<typeof FormFieldOptionSchema>;

export const FormFieldSchema = z.object({
  temp_id: z.string(),
  // `tel`, `url` and `number` exist so the browser can offer the right keyboard, autofill and
  // validation; they used to be plain text fields. Keep in sync with
  // libs/cortex/src/lib/block-content-schemas.ts (the MCP side validates the same shape).
  field_type: z.enum(['text', 'email', 'tel', 'url', 'number', 'textarea', 'select', 'radio', 'checkbox']),
  label: z.string(),
  placeholder: z.string().optional(),
  is_required: z.boolean(),
  options: z.array(FormFieldOptionSchema).optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const FormBlockSchema = z.object({
  // Opaque handle into `form_endpoints`, which holds the destination address and the
  // field manifest server-side. Safe to serialize: it grants nothing.
  form_key: z.string().optional(),
  // Legacy only. Migration 27 moved every stored address into form_endpoints and
  // deleted this key; it stays optional so an un-migrated import still validates,
  // and the renderer strips it before the content reaches the browser.
  recipient_email: z.string().email().optional(),
  submit_button_text: z.string(),
  success_message: z.string(),
  fields: z.array(FormFieldSchema),
  botProtectionProvider: z.enum(['none', 'turnstile', 'recaptcha']).optional().default('none'),
  botProtectionSiteKey: z.string().optional(),
});
export type FormBlockContent = z.infer<typeof FormBlockSchema>;

/**
 * Enhanced block definition interface with generic type parameter
 * Links the TypeScript interface to the block definition for better type safety
 */
export interface BlockDefinition<T = any> {
  /** The unique identifier for the block type */
  type: BlockType;
  /** User-friendly display name for the block */
  label: string;
  /** Optional icon for the block, using lucide-react icon names or component */
  icon?: string | any;
  /** Default content structure for new blocks of this type */
  initialContent: T;
  /** Filename of the editor component (assumed to be in app/cms/blocks/editors/) */
  editorComponentFilename?: string;
  /** Filename of the renderer component (assumed to be in components/blocks/renderers/) */
  rendererComponentFilename?: string;
  /** Direct React component for rendering (overrides filename if present) */
  RendererComponent?: React.ComponentType<any>;
  /** Direct React component for editing (overrides filename if present) */
  EditorComponent?: React.ComponentType<any>;
  /** Optional filename for specific preview components */
  previewComponentFilename?: string;
  /**
   * Zod schema defining the content properties, types, and constraints.
   * Used for validation, documentation, and potential runtime type checking.
   */
  schema: z.ZodType<T>;
  /**
   * JSDoc-style comments providing additional context about the block type,
   * its use cases, and any special considerations.
   */
  documentation?: {
    description?: string;
    examples?: string[];
    useCases?: string[];
    notes?: string[];
  };
}

/**
 * Central registry of all available block types and their configurations
 *
 * This registry contains the complete definition for each block type,
 * including their initial content values and structured content schemas.
 * This serves as the single source of truth for all block-related information,
 * eliminating the need to modify utils/supabase/types.ts when adding new block types.
 */
export const blockRegistry: Record<BlockType, BlockDefinition> = {
  text: {
    type: "text",
    label: "Rich Text Block",
    icon: "FileText",
    initialContent: { html_content: "" } as TextBlockContent,
    editorComponentFilename: "TextBlockEditor.tsx",
    rendererComponentFilename: "TextBlockRenderer.tsx",
    schema: TextBlockSchema,
    documentation: {
      description: 'A rich text block that supports HTML content with WYSIWYG editing',
      examples: [
        '<p>Simple paragraph text</p>',
        '<h2>Heading with <strong>bold text</strong></h2>',
        '<ul><li>List item 1</li><li>List item 2</li></ul>',
      ],
      useCases: [
        'Article content and body text',
        'Rich formatted content with links and styling',
        'Lists, quotes, and other structured text',
      ],
      notes: [
        'Content is sanitized before rendering to prevent XSS attacks',
        'Supports most HTML tags commonly used in content',
      ],
    },
  },
  
  heading: {
    type: "heading",
    label: "Heading",
    icon: "Heading",
    initialContent: { level: 1, text_content: "New Heading", textAlign: 'left', textColor: undefined } as HeadingBlockContent,
    editorComponentFilename: "HeadingBlockEditor.tsx",
    rendererComponentFilename: "HeadingBlockRenderer.tsx",
    schema: HeadingBlockSchema,
    documentation: {
      description: 'A semantic heading block with configurable hierarchy levels',
      examples: [
        '{ level: 1, text_content: "Main Page Title" }',
        '{ level: 2, text_content: "Section Heading" }',
        '{ level: 3, text_content: "Subsection Title" }',
      ],
      useCases: [
        'Page and section titles',
        'Content hierarchy and structure',
        'SEO-friendly heading organization',
      ],
      notes: [
        'Choose heading levels based on content hierarchy, not visual appearance',
        'Avoid skipping heading levels (e.g., h1 to h3 without h2)',
      ],
    },
  },
  
  image: {
    type: "image",
    label: "Image",
    icon: "Image",
    initialContent: { media_id: null, alt_text: "", caption: "" } as ImageBlockContent,
    editorComponentFilename: "ImageBlockEditor.tsx",
    rendererComponentFilename: "ImageBlockRenderer.tsx",
    schema: ImageBlockSchema,
    documentation: {
      description: 'An image block with support for captions, alt text, and responsive sizing',
      examples: [
        '{ media_id: "uuid-123", alt_text: "Product photo", caption: "Our latest product" }',
        '{ media_id: "uuid-456", alt_text: "Team photo", width: 800, height: 600 }',
      ],
      useCases: [
        'Article illustrations and photos',
        'Product images and galleries',
        'Decorative and informational graphics',
      ],
      notes: [
        'Always provide alt_text for accessibility compliance',
        'Images are automatically optimized and served from CDN',
        'Dimensions are used for layout optimization and preventing content shifts',
      ],
    },
  },
  
  button: {
    type: "button",
    label: "Button",
    icon: "SquareMousePointer",
    initialContent: { text: "Click Me", url: "#", variant: "default", size: "default", position: "left" } as ButtonBlockContent,
    editorComponentFilename: "ButtonBlockEditor.tsx",
    rendererComponentFilename: "ButtonBlockRenderer.tsx",
    schema: ButtonBlockSchema,
    documentation: {
      description: 'A customizable button/link component with multiple style variants',
      examples: [
        '{ text: "Learn More", url: "/about", variant: "default", size: "lg" }',
        '{ text: "Contact Us", url: "/contact", variant: "outline" }',
        '{ text: "Download", url: "/files/doc.pdf", variant: "secondary" }',
      ],
      useCases: [
        'Call-to-action buttons',
        'Navigation links with button styling',
        'Download and external links',
      ],
      notes: [
        'External URLs automatically open in new tabs',
        'Button styles follow the design system theme',
        'Use appropriate variants based on button importance and context',
      ],
    },
  },
  
  posts_grid: {
    type: "posts_grid",
    label: "Posts Grid",
    icon: "LayoutGrid",
    initialContent: { postsPerPage: 12, columns: 3, showPagination: true, title: "Recent Posts" } as PostsGridBlockContent,
    editorComponentFilename: "PostsGridBlockEditor.tsx",
    rendererComponentFilename: "PostsGridBlockRenderer.tsx",
    schema: PostsGridBlockSchema,
    documentation: {
      description: 'A responsive grid layout for displaying blog posts with pagination',
      examples: [
        '{ postsPerPage: 6, columns: 2, showPagination: true, title: "Latest News" }',
        '{ postsPerPage: 9, columns: 3, showPagination: false, title: "Featured Articles" }',
      ],
      useCases: [
        'Blog post listings and archives',
        'Featured content sections',
        'News and article showcases',
      ],
      notes: [
        'Grid automatically adapts to smaller screens',
        'Posts are filtered by current language',
        'Pagination improves performance for large post collections',
      ],
    },
  },
  
  video_embed: {
    type: "video_embed",
    label: "Video Embed",
    icon: "SquarePlay",
    initialContent: {
      url: "",
      title: "",
      autoplay: false,
      controls: true
    } as VideoEmbedBlockContent,
    editorComponentFilename: "VideoEmbedBlockEditor.tsx",
    rendererComponentFilename: "VideoEmbedBlockRenderer.tsx",
    schema: VideoEmbedBlockSchema,
    documentation: {
      description: 'Embeds videos from popular platforms with customizable playback options',
      examples: [
        '{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Rick Roll", controls: true }',
        '{ url: "https://vimeo.com/123456789", autoplay: false, controls: true }',
      ],
      useCases: [
        'Tutorial and educational videos',
        'Product demonstrations',
        'Marketing and promotional content',
      ],
      notes: [
        'Supports YouTube, Vimeo, and other major video platforms',
        'Autoplay may be restricted by browser policies',
        'Videos are responsive and adapt to container width',
      ],
    },
  },
  
  section: {
    type: "section",
    label: "Section Layout",
    icon: "Columns3",
    initialContent: {
      container_type: "container",
      background: { type: "none" },
      responsive_columns: { mobile: 1, tablet: 2, desktop: 3 },
      column_gap: "md",
      vertical_alignment: "start",
      padding: { top: "md", bottom: "md" },
      column_blocks: [
        [{ block_type: "text", content: { html_content: "<p>Column 1</p>" } }],
        [{ block_type: "text", content: { html_content: "<p>Column 2</p>" } }],
        [{ block_type: "text", content: { html_content: "<p>Column 3</p>" } }]
      ],
      is_hero: false,
      slider: false,
      autoplay: false,
      timeframe: 5,
      slides: []
    } as SectionBlockContent,
    editorComponentFilename: "SectionBlockEditor.tsx",
    rendererComponentFilename: "SectionBlockRenderer.tsx",
    schema: SectionBlockSchema,
    documentation: {
      description: 'A flexible section layout with responsive columns and background options',
      examples: [
        '{ container_type: "container", responsive_columns: { mobile: 1, tablet: 2, desktop: 3 } }',
        '{ background: { type: "gradient" }, column_blocks: [...] }',
        '{ container_type: "full-width", background: { type: "image" } }',
      ],
      useCases: [
        'Feature sections with multiple content blocks',
        'Comparison layouts and product showcases',
        'Hero sections with structured content',
        'Multi-column article layouts',
      ],
      notes: [
        'Blocks within sections can be edited inline',
        'Supports full drag-and-drop between columns and sections',
        'Background images are managed through existing media system',
        'Responsive breakpoints follow Tailwind CSS conventions',
      ],
    },
  },

  
  form: {
    type: "form",
    label: "Form",
    icon: "NotebookPen",
    initialContent: {
      submit_button_text: "Submit",
      success_message: "Thank you for your submission!",
      fields: [],
      botProtectionProvider: "none",
      botProtectionSiteKey: "",
    } as FormBlockContent,
    editorComponentFilename: "FormBlockEditor.tsx",
    rendererComponentFilename: "FormBlockRenderer.tsx",
    schema: FormBlockSchema,
    documentation: {
      description: 'Creates an interactive form that can be submitted to a specified email address.',
      useCases: [
        'Contact forms',
        'Lead generation forms',
        'Simple surveys',
      ],
      notes: [
        'Submissions are stored as message threads and appear in CMS → Messages.',
        'The destination address lives server-side in form_endpoints, keyed by form_key — it is never sent to the browser.',
        'Email notification is best-effort: a stored submission is the record even when SMTP is unconfigured.',
      ],
    },
  },
  
  "testimonial": {
    ...TestimonialBlockConfig,
    // Adapt SDK config to BlockDefinition requirements
    editorComponentFilename: 'TestimonialBlockEditor', // Placeholder, not used if EditorComponent is present
    rendererComponentFilename: 'TestimonialBlockRenderer', // Placeholder
    documentation: {
      description: 'Display a user testimonial with a quote, author, and optional image.',
      useCases: ['Social proof', 'Customer reviews'],
    }
  } as BlockDefinition<TestimonialBlockContent>,

  "product_grid": {
    type: "product_grid",
    label: "Product Grid",
    icon: "ShoppingBag", // Lucide icon
    initialContent: { type: 'latest', limit: 6, showPagination: false } as ProductGridBlockContent,
    editorComponentFilename: "ProductGridBlockEditor.tsx", // Assuming standard naming
    rendererComponentFilename: "ProductGridBlockRenderer.tsx", // Assuming mapping to ProductGridBlock.tsx handled by renderer map not shown here, or we need to ensure the renderer map uses the file we created. The prompt implies creating the file in `lib/blocks` serves as the component. I will assume the system maps it.
    schema: ProductGridBlockSchema,
    documentation: {
        description: 'Displays a grid of products: the latest ones, everything in one or more categories, or a hand-picked list.',
        useCases: ['Homepage featured products', 'Category pages', 'Curated collections']
    }
  },

  "featured_product": {
    type: "featured_product",
    label: "Featured Product",
    icon: "Star",
    initialContent: { productId: '', showBackground: false } as FeaturedProductBlockContent,
    editorComponentFilename: "FeaturedProductBlockEditor.tsx",
    rendererComponentFilename: "FeaturedProductBlockRenderer.tsx", 
    schema: FeaturedProductBlockSchema,
    documentation: {
        description: 'Highlights a specific product with a detailed view.',
        useCases: ['Product spotlight', 'Special offers']
    }
  },

  "cart": {
    type: "cart",
    label: "Cart",
    icon: "ShoppingCart",
    initialContent: {} as CartBlockContent,
    editorComponentFilename: "CartBlockEditor.tsx",
    rendererComponentFilename: "CartBlockRenderer.tsx",
    schema: CartBlockSchema,
    documentation: {
        description: 'Displays the shopping cart.',
        useCases: ['Cart page']
    }
  },

  "checkout": {
    type: "checkout",
    label: "Checkout",
    icon: "CreditCard",
    initialContent: {} as CheckoutBlockContent,
    editorComponentFilename: "CheckoutBlockEditor.tsx",
    rendererComponentFilename: "CheckoutBlockRenderer.tsx",
    schema: CheckoutBlockSchema,
    documentation: {
        description: 'Displays the checkout form.',
        useCases: ['Checkout page']
    }
  },

  "product_details": {
    type: "product_details",
    label: "Product Details",
    icon: "Tag",
    initialContent: {} as ProductDetailsBlockContent,
    editorComponentFilename: "ProductDetailsBlockEditor.tsx",
    rendererComponentFilename: "ProductDetailsBlockRenderer.tsx",
    schema: ProductDetailsBlockSchema,
    documentation: {
        description: 'Displays product details (Title, Price, Add to Cart) using context.',
        useCases: ['Product Template Page']
    }
  },
};


/**
 * Get the block definition for a specific block type
 * 
 * @param blockType - The type of block to get the definition for
 * @returns The block definition or undefined if not found
 */
export function getBlockDefinition(blockType: string): BlockDefinition | undefined {
  if (blockType in blockRegistry) {
    return blockRegistry[blockType as BlockType];
  }
  return undefined;
}

/**
 * Whether a block type has anything for an author to configure.
 *
 * `cart`, `checkout` and `product_details` are context-driven: they declare an
 * empty schema and ship no editor file at all, so opening an editor for them
 * would show an empty dialog (and fail on the missing module). Used to decide
 * whether adding a block should jump straight into its editor.
 *
 * @param blockType - The block type or custom-block slug
 * @returns true when the block exposes editable fields
 */
export function blockHasEditableContent(blockType: string): boolean {
  const definition = getBlockDefinition(blockType);
  // Custom blocks are not in the registry; they always render a field editor.
  if (!definition) return true;
  const shape = (definition.schema as unknown as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return true;
  return Object.keys(shape).length > 0;
}

/**
 * Get the initial content for a specific block type
 *
 * @param blockType - The type of block to get initial content for
 * @returns The initial content object or undefined if block type not found
 */
export function getInitialContent(blockType: string): object | undefined {
  if (blockType in blockRegistry) {
    return blockRegistry[blockType as BlockType]?.initialContent;
  }
  return {};
}

/**
 * Get the label for a specific block type
 * 
 * @param blockType - The type of block to get the label for
 * @returns The user-friendly label or undefined if block type not found
 */
export function getBlockLabel(blockType: string): string | undefined {
  if (blockType in blockRegistry) {
    return blockRegistry[blockType as BlockType]?.label;
  }
  return blockType
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Check if a block type is valid/registered
 * 
 * @param blockType - The block type to validate
 * @returns True if the block type exists in the registry
 */
export function isValidBlockType(blockType: string): boolean {
  return blockType in blockRegistry || /^[a-z0-9_-]+$/.test(blockType);
}

/**
 * Get the Zod schema for a specific block type
 * 
 * @param blockType - The type of block to get the schema for
 * @returns The Zod schema object or undefined if not found
 */
export function getBlockSchema(blockType: string): z.ZodType<any> | undefined {
  if (blockType in blockRegistry) {
    return blockRegistry[blockType as BlockType]?.schema;
  }
  return z.record(z.string(), z.any());
}

/**
 * Get documentation for a specific block type
 * 
 * @param blockType - The type of block to get documentation for
 * @returns The documentation object or undefined if not found
 */
export function getBlockDocumentation(blockType: string): BlockDefinition['documentation'] | undefined {
  if (blockType in blockRegistry) {
    return blockRegistry[blockType as BlockType]?.documentation;
  }
  return {
    description: "Custom user-defined block layout component",
  };
}

/**
 * Generate a union type for all block content types
 * This creates a discriminated union based on block type
 * 
 * @returns A TypeScript union type for all block content
 */
export type AllBlockContent =
  | ({ type: "text" } & TextBlockContent)
  | ({ type: "heading" } & HeadingBlockContent)
  | ({ type: "image" } & ImageBlockContent)
  | ({ type: "button" } & ButtonBlockContent)
  | ({ type: "posts_grid" } & PostsGridBlockContent)
  | ({ type: "section" } & SectionBlockContent)

  | ({ type: "video_embed" } & VideoEmbedBlockContent)
  | ({ type: "form" } & FormBlockContent)
  | ({ type: "testimonial" } & TestimonialBlockContent)
  | ({ type: "product_grid" } & ProductGridBlockContent)
  | ({ type: "featured_product" } & FeaturedProductBlockContent)
  | ({ type: "cart" } & CartBlockContent)
  | ({ type: "checkout" } & CheckoutBlockContent)
  | ({ type: "product_details" } & ProductDetailsBlockContent);

/**
* Validate block content against its schema
 * Performs runtime validation based on the Zod schema definitions
 * 
 * @param blockType - The type of block to validate
 * @param content - The content to validate
 * @returns An object with validation results
 */
export function validateBlockContent(
  blockType: BlockType, 
  content: Record<string, any>
): { 
  isValid: boolean; 
  errors: string[]; 
  warnings: string[]; 
} {
  const schema = getBlockSchema(blockType);
  if (!schema) {
    return { isValid: false, errors: ['Block type not found in registry'], warnings: [] };
  }

  const result = schema.safeParse(content);

  if (result.success) {
    return { isValid: true, errors: [], warnings: [] };
  } else {
    // Format Zod errors
    const errors = result.error.issues.map(e => {
      const path = e.path.join('.');
      return path ? `${path}: ${e.message}` : e.message;
    });
    return { isValid: false, errors, warnings: [] };
  }
}

/**
 * Generate default content for a block type based on its schema
 * This is more comprehensive than initialContent as it includes all properties with defaults
 * 
 * @param blockType - The type of block
 * @returns Complete default content object
 */
export function generateDefaultContent(blockType: BlockType): Record<string, any> {
  // For Zod, initialContent is the best source of defaults as defined in the registry.
  // Zod schemas don't easily expose default values without parsing.
  // We return initialContent which is required to be valid against the schema.
  return getInitialContent(blockType) as Record<string, any> || {};
}





