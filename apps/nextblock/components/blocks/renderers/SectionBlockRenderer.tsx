// components/blocks/renderers/SectionBlockRenderer.tsx
import React from "react";
import Image from "next/image";
import type { SectionBlockContent } from "../../../lib/blocks/blockRegistry";
import { buildVisualEditAttributes } from "../../../lib/visual-editing/edit-info";
import type {
  VisualEditAttributes,
  VisualEditingDocumentContext,
} from "../../../lib/visual-editing/types";
import { getPublicBlockRendererLoader } from "../publicRendererLoaders";
import SectionSlider from "./SectionSlider";
import { getCachedCustomBlockDefinitionBySlug } from "../../../lib/custom-block-definitions";
import { CachedDynamicLayoutEngine } from "../../renderers/CachedDynamicLayoutEngine";
import { resolveBlockRelations } from "../../../lib/resolve-block-relations";

// Static imports for core block renderers for LCP/performance optimization
import TextBlockRenderer from "./TextBlockRenderer";
import HeadingBlockRenderer from "./HeadingBlockRenderer";
import ImageBlockRenderer from "./ImageBlockRenderer";
import ButtonBlockRenderer from "./ButtonBlockRenderer";
import { StockPhotoCredit } from "./StockPhotoCredit";

const R2_BASE_URL = process.env.NEXT_PUBLIC_R2_BASE_URL || "";
const BACKGROUND_COMPOSITING_CLASSES =
  "isolate transform-gpu [backface-visibility:hidden] [transform-style:preserve-3d]";

/**
 * GPU-layer promotion is only worth paying for on sections with a background IMAGE
 * (it keeps the `inset-[-1px]` image layer seam-free while scrolling). Applied to
 * every section it promoted eighteen full-width layers on the home page, and the
 * compositor spent ~390 ms drawing the first frame in Lighthouse's trace, delaying
 * the first contentful paint well past the moment the hero was parsed and laid out.
 * Plain `isolate` keeps the stacking context the background layers rely on.
 */
function sectionCompositingClasses(hasBackgroundImage: boolean) {
  return hasBackgroundImage ? BACKGROUND_COMPOSITING_CLASSES : "isolate";
}
const ABSOLUTE_BACKGROUND_CLASSES =
  "pointer-events-none absolute inset-[-1px] -z-10 transform-gpu [backface-visibility:hidden] [transform-style:preserve-3d]";
const ECOMMERCE_BLOCK_TYPES = new Set([
  "product_grid",
  "featured_product",
  "cart",
  "checkout",
  "product_details",
]);

function loadEcommerceBlockRenderer(blockType: string) {
  return import("../ecommerceRendererLoaders").then((module) =>
    module.loadEcommerceBlockRenderer(blockType)
  );
}

type SectionBackgroundImage = NonNullable<
  NonNullable<SectionBlockContent["background"]>["image"]
>;

// Renders a section's background image. External https URLs (e.g. AI-inserted
// stock photos) use a plain <img> so any allowlisted host works without Next
// image remotePatterns config; stored R2 media keeps the optimized next/image
// path. Returns null when neither a URL nor an object key is present.
function renderBackgroundImageElement(image: SectionBackgroundImage, priority: boolean) {
  const externalUrl =
    typeof image.external_url === "string" && /^https?:\/\//i.test(image.external_url.trim())
      ? image.external_url.trim()
      : null;
  const objectFit: "cover" | "contain" = image.size === "contain" ? "contain" : "cover";
  const objectPosition = image.position || "center";

  if (externalUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={externalUrl}
        alt={image.alt_text || ""}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        className="absolute inset-0 h-full w-full"
        style={{ objectFit, objectPosition }}
      />
    );
  }

  if (!image.object_key) {
    return null;
  }

  return (
    <Image
      src={`${R2_BASE_URL}/${image.object_key}`}
      alt={image.alt_text || ""}
      fill
      priority={priority}
      fetchPriority={priority ? "high" : "auto"}
      placeholder={image.blur_data_url ? "blur" : "empty"}
      blurDataURL={image.blur_data_url || undefined}
      quality={image.quality || 80}
      sizes="100vw"
      style={{ objectFit, objectPosition }}
    />
  );
}

interface SectionBlockRendererProps {
  content: SectionBlockContent;
  languageId: number;
  visualEditAttributes?: VisualEditAttributes;
  visualEditing?: VisualEditingDocumentContext;
  parentBlockId?: number;
  parentBlockIndex?: number;
  blockType?: "section";
  botProtectionPublic?: BotProtectionPublicSettings;
  scriptNonce?: string;
}

type BotProtectionPublicSettings = {
  provider: 'none' | 'turnstile' | 'recaptcha';
  siteKey: string;
};

// Container class mapping
const containerClasses = {
  'full-width': 'w-full',
  'container': 'container mx-auto px-4',
  'container-sm': 'container mx-auto px-4 max-w-screen-sm',
  'container-lg': 'container mx-auto px-4 max-w-screen-lg',
  'container-xl': 'container mx-auto px-4 max-w-screen-xl'
};

// Column grid classes
const columnClasses = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4'
};

// Gap classes
const gapClasses = {
  none: 'gap-0',
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
  xl: 'gap-8'
};

// Padding classes
const paddingClasses = {
  none: '',
  sm: 'py-2',
  md: 'py-4',
  lg: 'py-8',
  xl: 'py-12'
};

// Vertical alignment classes
const verticalAlignmentClasses = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch'
};

function formatMinHeight(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return `${trimmed}px`;
  }
  return trimmed;
}

function formatStopPosition(position: number) {
  return Number.isInteger(position) ? String(position) : position.toFixed(1);
}

function formatGradientStops(stops: Array<{ color: string; position: number }>) {
  return stops
    .map((stop, index) => {
      const previous = stops[index - 1];
      const next = stops[index + 1];
      let position = stop.position;

      if (next && next.position === stop.position && stop.position > 0) {
        position = stop.position - 0.1;
      } else if (previous && previous.position === stop.position && stop.position < 100) {
        position = stop.position + 0.1;
      }

      return `${stop.color} ${formatStopPosition(position)}%`;
    })
    .join(', ');
}

// Background style generator (handles solid, theme and gradients; image handled in JSX)
function generateBackgroundStyles(background: SectionBlockContent['background']) {
  const styles: React.CSSProperties = {};
  let className = '';

  switch (background.type) {
    case 'theme': {
      // Theme-based backgrounds using CSS classes
      const themeClasses = {
        primary: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        muted: 'bg-muted text-muted-foreground',
        accent: 'bg-accent text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground'
      };
      className = background.theme ? themeClasses[background.theme] || '' : '';
      break;
    }
    
    case 'solid':
      styles.backgroundColor = background.solid_color;
      break;
    
    case 'gradient':
      if (background.gradient) {
        const { type, direction, stops } = background.gradient;
        const gradientStops = formatGradientStops(stops);
        styles.background = `${type}-gradient(${direction || 'to right'}, ${gradientStops})`;
      }
      break;
    
    case 'image':
      // Handled via absolute next/image in the render tree for LCP & sizing optimization
      break;
    
    default:
      break;
  }

  return { styles, className };
}

function generateGradientOverlayStyle(gradient: any): React.CSSProperties {
  const { type, direction, stops } = gradient;
  const gradientStops = formatGradientStops(stops);
  return {
    background: `${type}-gradient(${direction || 'to right'}, ${gradientStops})`,
  };
}

interface NestedBlockRendererProps {
  block: SectionBlockContent['column_blocks'][0][0];
  languageId: number;
  parentBlockId?: number;
  parentBlockIndex?: number;
  visualEditing?: VisualEditingDocumentContext;
  visualEditAttributes?: VisualEditAttributes;
  botProtectionPublic?: BotProtectionPublicSettings;
  scriptNonce?: string;
  priority?: boolean;
}

/**
 * A form nested inside a section has no `blocks` row of its own — it lives in the
 * section's jsonb — so the same strip the top-level renderer performs has to happen
 * here too. See BlockRenderer.stripServerOnlyContent for why.
 */
function stripServerOnlyContent(blockType: string, content: unknown): unknown {
  if (blockType !== 'form' || !content || typeof content !== 'object') return content;
  if (!('recipient_email' in (content as Record<string, unknown>))) return content;
  const { recipient_email: _dropped, ...safe } = content as Record<string, unknown>;
  return safe;
}

async function renderNestedBlock({
  block,
  languageId,
  parentBlockId,
  parentBlockIndex,
  visualEditing,
  visualEditAttributes,
  botProtectionPublic,
  scriptNonce,
  priority = false,
}: NestedBlockRendererProps) {
  // Statically resolve core block types first to avoid dynamic imports overhead
  if (block.block_type === 'text') {
    return (
      <TextBlockRenderer
        content={block.content as any}
        languageId={languageId}
        visualEditAttributes={visualEditAttributes}
        renderContext="section"
        // Hero copy routinely carries the demo video; its poster is the LCP element.
        priority={priority}
      />
    );
  }

  if (block.block_type === 'heading') {
    return (
      <HeadingBlockRenderer
        content={block.content as any}
        languageId={languageId}
        visualEditAttributes={visualEditAttributes}
      />
    );
  }

  if (block.block_type === 'button') {
    return (
      <ButtonBlockRenderer
        content={block.content as any}
        languageId={languageId}
        visualEditAttributes={visualEditAttributes}
      />
    );
  }

  if (block.block_type === 'image') {
    return (
      <ImageBlockRenderer
        content={block.content as any}
        languageId={languageId}
        priority={priority}
        visualEditAttributes={visualEditAttributes}
      />
    );
  }

  // Fallback to dynamic loader for custom/other block types
  const rendererLoader = getPublicBlockRendererLoader(block.block_type);

  if (!rendererLoader) {
    if (ECOMMERCE_BLOCK_TYPES.has(block.block_type)) {
      const { default: EcommerceRendererComponent } = await loadEcommerceBlockRenderer(
        block.block_type
      );

      return (
        <EcommerceRendererComponent
          content={block.content}
          languageId={languageId}
          visualEditAttributes={visualEditAttributes}
        />
      );
    }

    // Custom block definitions are data-rendered the same way as at the top
    // level. A custom block's block_type is the definition slug.
    const definition = await getCachedCustomBlockDefinitionBySlug(block.block_type);
    if (definition) {
      const resolvedBlock = (await resolveBlockRelations({
        data: block.content as Record<string, any>,
        fields: definition.fields,
      })) as any;

      return (
        <div {...visualEditAttributes}>
          <CachedDynamicLayoutEngine
            definition={definition}
            layoutSchema={definition.layout_schema}
            fields={definition.fields}
            data={{
              ...(resolvedBlock.data || {}),
              resolved_relations: resolvedBlock.resolved_relations || {},
            }}
          />
        </div>
      );
    }

    // Unknown type with no matching definition: keep the diagnostic out of the
    // public-facing page (only show it inside the live editor).
    if (!visualEditing?.enabled) {
      return null;
    }

    return (
      <div
        className="p-2 border rounded bg-destructive/10 text-destructive text-sm"
        {...visualEditAttributes}
      >
        <strong>Unsupported block type:</strong> {block.block_type}
      </div>
    );
  }

  const { default: RendererComponent } = await rendererLoader();

  // Handle different prop requirements for different renderers
  if (block.block_type === 'posts_grid') {
    return (
      <RendererComponent
        content={block.content}
        languageId={languageId}
        block={{ ...block, id: 0, language_id: languageId, order: 0, created_at: '', updated_at: '' }}
        visualEditAttributes={visualEditAttributes}
      />
    );
  }

  return (
    <RendererComponent
      content={stripServerOnlyContent(block.block_type, block.content)}
      languageId={languageId}
      visualEditAttributes={visualEditAttributes}
      visualEditing={visualEditing}
      parentBlockId={parentBlockId}
      parentBlockIndex={parentBlockIndex}
      botProtectionPublic={botProtectionPublic}
      scriptNonce={scriptNonce}
      // Hero sections also carry LCP-eligible media in dynamically loaded
      // renderers (e.g. video_embed's poster frame), not just nested images.
      priority={priority}
    />
  );
}

export default async function SectionBlockRenderer({
  content,
  languageId,
  visualEditAttributes,
  visualEditing,
  parentBlockId,
  parentBlockIndex,
  blockType,
  botProtectionPublic,
  scriptNonce,
}: SectionBlockRendererProps) {
  const isHero = content.is_hero === true;

  // Build CSS classes
  const containerClass = containerClasses[content.container_type] || containerClasses.container;
  const gridClass = columnClasses[content.responsive_columns.desktop] || columnClasses[3];
  const gapClass = gapClasses[content.column_gap] || gapClasses.md;
  const paddingTopClass = paddingClasses[content.padding.top] || paddingClasses.md;
  const paddingBottomClass = paddingClasses[content.padding.bottom] || paddingClasses.md;
  const alignmentClass = content.vertical_alignment ? verticalAlignmentClasses[content.vertical_alignment] : 'items-start';

  // --- Render Slide-based Carousel Section ---
  if (content.slider && content.slides && content.slides.length > 0) {
    const renderedSlides = await Promise.all(
      content.slides.map(async (slide, slideIndex) => {
        const isFirstSlide = slideIndex === 0;
        // Priority loading for the first slide of a hero carousel
        const slidePriority = isHero && isFirstSlide;

        const slideBackground = slide.background || { type: "none" };
        const { styles: slideBgStyles, className: slideBgClassName } = generateBackgroundStyles(slideBackground);

        const renderedColumns = await Promise.all(
          slide.column_blocks.map(async (columnBlocks, columnIndex) => {
            const blocks = Array.isArray(columnBlocks) ? columnBlocks : [];
            const renderedBlocks = await Promise.all(
              blocks.map(async (block, blockIndex) => ({
                key: `${block.block_type}-${columnIndex}-${blockIndex}`,
                node: await renderNestedBlock({
                  block,
                  languageId,
                  parentBlockId,
                  parentBlockIndex,
                  visualEditing,
                  botProtectionPublic,
                  scriptNonce,
                  priority: slidePriority, // Pass down priority
                  visualEditAttributes:
                    typeof parentBlockId === "number" && typeof parentBlockIndex === "number"
                      ? buildVisualEditAttributes(visualEditing, {
                          kind: "nested",
                          parentBlockId,
                          parentBlockIndex,
                          parentBlockType: "section",
                          columnIndex,
                          blockIndex,
                          blockType: block.block_type,
                        })
                      : undefined,
                }),
              }))
            );

            return { columnIndex, renderedBlocks };
          })
        );

        return (
          <div
            key={`slide-${slideIndex}`}
            className={`relative w-full flex items-center ${sectionCompositingClasses(slideBackground.type === 'image')} ${paddingTopClass} ${paddingBottomClass} ${slideBgClassName}`}
            style={{
              ...slideBgStyles,
              minHeight: formatMinHeight(slideBackground.min_height) || '400px'
            }}
          >
            {/* Background image Layer for slide */}
            {slideBackground.type === 'image' && slideBackground.image && (
              <div className={ABSOLUTE_BACKGROUND_CLASSES}>
                {renderBackgroundImageElement(slideBackground.image, slidePriority)}
                {slideBackground.image.overlay && slideBackground.image.overlay.gradient && (
                  <div 
                    className="absolute inset-0 transform-gpu [backface-visibility:hidden]"
                    style={generateGradientOverlayStyle(slideBackground.image.overlay.gradient)}
                  />
                )}
              </div>
            )}

            <div className={`${containerClass} w-full`}>
              <div className={`grid ${gridClass} ${gapClass} ${alignmentClass}`}>
                {renderedColumns.map(({ columnIndex, renderedBlocks }) => (
                  <div key={`column-${columnIndex}`} className="min-h-0 space-y-4">
                    {renderedBlocks.map(({ key, node }) => (
                      <React.Fragment key={key}>{node}</React.Fragment>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })
    );

    const hasSlideImage = content.slides.some((slide) => slide.background?.type === 'image');

    // Determine the slider's container min-height from configured slides
    let sliderMinHeight = '400px';
    if (content.slides && content.slides.length > 0) {
      const configuredHeight = content.slides
        .map(s => s.background?.min_height)
        .find(Boolean);
      if (configuredHeight) {
        sliderMinHeight = formatMinHeight(configuredHeight) || '400px';
      }
    }

    return (
      <section
        className={`relative w-full overflow-hidden ${sectionCompositingClasses(hasSlideImage)}`}
        {...visualEditAttributes}
      >
        <SectionSlider
          autoplay={content.autoplay}
          timeframe={content.timeframe}
          minHeight={sliderMinHeight}
        >
          {renderedSlides}
        </SectionSlider>
      </section>
    );
  }

  // --- Render Standard Single Layout Section ---
  const { styles, className: backgroundClassName } = generateBackgroundStyles(content.background);

  const renderedColumns = await Promise.all(
    content.column_blocks.map(async (columnBlocks, columnIndex) => {
      const blocks = Array.isArray(columnBlocks) ? columnBlocks : [];
      const renderedBlocks = await Promise.all(
        blocks.map(async (block, blockIndex) => ({
          key: `${block.block_type}-${columnIndex}-${blockIndex}`,
          node: await renderNestedBlock({
            block,
            languageId,
            parentBlockId,
            parentBlockIndex,
            visualEditing,
            botProtectionPublic,
            scriptNonce,
            priority: isHero, // Pass priority down to nested image blocks
            visualEditAttributes:
              typeof parentBlockId === "number" && typeof parentBlockIndex === "number"
                ? buildVisualEditAttributes(visualEditing, {
                    kind: "nested",
                    parentBlockId,
                    parentBlockIndex,
                    parentBlockType: "section",
                    columnIndex,
                    blockIndex,
                    blockType: block.block_type,
                  })
                : undefined,
          }),
        }))
      );

      return { columnIndex, renderedBlocks };
    })
  );

  return (
    <section
      className={`relative w-full ${sectionCompositingClasses(content.background?.type === 'image')} ${paddingTopClass} ${paddingBottomClass} ${backgroundClassName}`.trim()}
      style={{
        ...styles,
        minHeight: formatMinHeight(content.background?.min_height)
      }}
      {...visualEditAttributes}
    >
      {/* Background image Layer */}
      {content.background?.type === 'image' && content.background.image?.attribution && (
        <StockPhotoCredit
          attribution={content.background.image.attribution}
          className="pointer-events-auto absolute bottom-1 right-2 z-10 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm [&_a]:text-white"
        />
      )}
      {content.background?.type === 'image' && content.background.image && (
        <div className={ABSOLUTE_BACKGROUND_CLASSES}>
          {renderBackgroundImageElement(content.background.image, isHero)}
          {content.background.image.overlay && content.background.image.overlay.gradient && (
            <div 
              className="absolute inset-0 transform-gpu [backface-visibility:hidden]"
              style={generateGradientOverlayStyle(content.background.image.overlay.gradient)}
            />
          )}
        </div>
      )}

      <div className={containerClass}>
        <div className={`grid ${gridClass} ${gapClass} ${alignmentClass}`}>
          {renderedColumns.map(({ columnIndex, renderedBlocks }) => (
            <div key={`column-${columnIndex}`} className="min-h-0 space-y-4">
              {renderedBlocks.map(({ key, node }) => (
                <React.Fragment key={key}>{node}</React.Fragment>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
