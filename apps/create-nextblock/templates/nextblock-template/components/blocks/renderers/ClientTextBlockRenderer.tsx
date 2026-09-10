import React from "react";
import Image from "next/image";
import parse, {
  HTMLReactParserOptions,
  Element,
  attributesToProps,
} from 'html-react-parser';
import AlertWidgetRenderer from "./inline/AlertWidgetRenderer";
import CtaWidgetRenderer from "./inline/CtaWidgetRenderer";
import type { TextBlockContent } from "./TextBlockRenderer";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";
import { SimpleTiptapRenderer } from "@nextblock-cms/ecommerce/components/SimpleTiptapRenderer";
import { replaceYouTubeIframe } from "../../media/youtube-embed-replace";
import { rewriteYouTubeHostsInHtml } from "../../../lib/media/youtube";

interface ClientTextBlockRendererProps {
  content: TextBlockContent;
  languageId: number;
  visualEditAttributes?: VisualEditAttributes;
  renderContext?: 'prose' | 'section';
}

function normalizeHtmlEncodingArtifacts(html: string): string {
  return html
    .replaceAll("âœ“", "&#10003;")
    .replaceAll("âœ”", "&#10003;");
}

function normalizeImageAttributes(attribs: Record<string, string>) {
  if (attribs['fetchpriority']) {
    attribs.fetchPriority = attribs['fetchpriority'];
    delete attribs['fetchpriority'];
  }

  if (!attribs.loading) {
    attribs.loading = 'lazy';
  }

  if (!attribs.decoding) {
    attribs.decoding = 'async';
  }

  if (attribs.loading === 'lazy' && attribs.fetchPriority === 'high') {
    delete attribs.fetchPriority;
  }
}

type CmsImageMetadata = {
  src: `/images/${string}`;
  width: number;
  height: number;
  sizes: string;
  priority?: boolean;
  /**
   * Serve the bundled file as-is instead of through the image optimizer.
   *
   * The optimizer re-encodes at `quality` 60 and prefers AVIF, which is the right
   * trade for photos but smears the fine text and 1px strokes of a rendered
   * diagram, and its `sizes`-driven variant is then upscaled to the figure width.
   * A diagram that is already an optimized webp at 2x the widest figure is
   * sharper and not much heavier served untouched.
   */
  unoptimized?: boolean;
};

type HtmlImageProps = {
  alt?: unknown;
  className?: string;
  id?: string;
  sizes?: unknown;
  style?: React.CSSProperties;
  title?: string;
};

const inlineImageSizes =
  '(max-width: 768px) calc(100vw - 2rem), (max-width: 1280px) 42vw, 512px';
const nbCoverImageSizes =
  '(max-width: 768px) calc(100vw - 2rem), (max-width: 1280px) 38vw, 438px';
const contentImageSizes =
  '(max-width: 768px) calc(100vw - 2rem), (max-width: 1280px) 75vw, 768px';

const knownCmsImages: Record<string, CmsImageMetadata> = {
  'images/NBcover.webp': {
    src: '/images/NBcover.webp',
    width: 1024,
    height: 572,
    sizes: nbCoverImageSizes,
    priority: true,
  },
  'images/cap.webp': {
    src: '/images/cap.webp',
    width: 960,
    height: 960,
    sizes: inlineImageSizes,
  },
  'images/commerce-plan.webp': {
    src: '/images/commerce-plan.webp',
    width: 1024,
    height: 559,
    sizes: contentImageSizes,
  },
  'images/commerce-square.webp': {
    src: '/images/commerce-square.webp',
    width: 2048,
    height: 2048,
    sizes: inlineImageSizes,
  },
  'images/cortex-ai-square.webp': {
    src: '/images/cortex-ai-square.webp',
    width: 2048,
    height: 2048,
    sizes: inlineImageSizes,
  },
  'images/commerce-wide.webp': {
    src: '/images/commerce-wide.webp',
    width: 1024,
    height: 434,
    sizes: contentImageSizes,
  },
  'images/developer.webp': {
    src: '/images/developer.webp',
    width: 1024,
    height: 1024,
    sizes: '(max-width: 768px) calc(100vw - 2rem), 400px',
  },
  'images/extensibility.webp': {
    src: '/images/extensibility.webp',
    width: 1024,
    height: 559,
    sizes: contentImageSizes,
  },
  'images/goals.webp': {
    src: '/images/goals.webp',
    width: 1008,
    height: 1024,
    sizes: inlineImageSizes,
  },
  'images/included.webp': {
    src: '/images/included.webp',
    width: 1024,
    height: 559,
    sizes: contentImageSizes,
  },
  'images/metadata_image.webp': {
    src: '/images/metadata_image.webp',
    width: 1200,
    height: 634,
    sizes: contentImageSizes,
  },
  'images/nextblock-logo-small.webp': {
    src: '/images/nextblock-logo-small.webp',
    width: 1162,
    height: 1164,
    sizes: '128px',
  },
  'images/nx-graph.webp': {
    src: '/images/nx-graph.webp',
    width: 541,
    height: 670,
    sizes: contentImageSizes,
  },
  'images/pants.webp': {
    src: '/images/pants.webp',
    width: 740,
    height: 717,
    sizes: inlineImageSizes,
  },
  'images/programmer-upscaled.webp': {
    src: '/images/programmer-upscaled.webp',
    width: 8192,
    height: 2632,
    sizes: '(max-width: 768px) calc(100vw - 2rem), (max-width: 1280px) 75vw, 1200px',
  },
  'images/t-shirt.webp': {
    src: '/images/t-shirt.webp',
    width: 740,
    height: 717,
    sizes: inlineImageSizes,
  },
};

function normalizeImagePath(src: string) {
  try {
    return new URL(src, 'https://nextblock.local').pathname.replace(/^\/+/, '');
  } catch {
    return src.replace(/^\/+/, '');
  }
}

function getKnownCmsImage(src: string | undefined) {
  if (!src) return null;

  const imagePath = normalizeImagePath(src);
  const directMatch = knownCmsImages[imagePath];

  if (directMatch) {
    return directMatch;
  }

  const entry = Object.entries(knownCmsImages).find(([knownPath]) =>
    imagePath.endsWith(knownPath)
  );

  return entry?.[1] ?? null;
}

function renderOptimizedCmsImage(attribs: Record<string, string>) {
  const image = getKnownCmsImage(attribs.src);

  if (!image) {
    normalizeImageAttributes(attribs);
    return undefined;
  }

  const props = attributesToProps(attribs) as HtmlImageProps;
  const alt = typeof props.alt === 'string' ? props.alt : '';
  const sizes = typeof props.sizes === 'string' ? props.sizes : image.sizes;
  const priority = image.priority === true;

  return (
    <Image
      src={image.src}
      alt={alt}
      width={image.width}
      height={image.height}
      sizes={sizes}
      quality={60}
      unoptimized={image.unoptimized === true}
      priority={priority}
      fetchPriority={priority ? 'high' : undefined}
      loading={priority ? undefined : 'lazy'}
      decoding="async"
      className={props.className}
      style={props.style}
      title={props.title}
      id={props.id}
    />
  );
}

const ClientTextBlockRenderer: React.FC<ClientTextBlockRendererProps> = ({
  content,
  languageId,
  visualEditAttributes,
  renderContext = 'prose',
}) => {
  void languageId;
  const normalizedHtml = normalizeHtmlEncodingArtifacts(content.html_content || "");
  const wrapperClassName =
    renderContext === 'section'
      ? 'w-full min-w-0'
      : 'my-4 prose dark:prose-invert container mx-auto';
  const options: HTMLReactParserOptions = {
    replace: (domNode) => {
      if (domNode instanceof Element && domNode.attribs) {
        // Clean up event handlers (like onclick) to prevent React warnings and XSS
        for (const key of Object.keys(domNode.attribs)) {
          if (key.toLowerCase().startsWith('on')) {
            delete domNode.attribs[key];
          }
        }

        // Swap YouTube iframes for a click-to-play facade so no youtube.com
        // resource loads before user interaction (Lighthouse `inspector-issues`).
        const youTubeFacade = replaceYouTubeIframe(domNode);
        if (youTubeFacade) return youTubeFacade;

        if (domNode.name === 'img') {
          return renderOptimizedCmsImage(domNode.attribs);
        } else if (domNode.attribs['fetchpriority']) {
          domNode.attribs.fetchPriority = domNode.attribs['fetchpriority'];
          delete domNode.attribs['fetchpriority'];
        }

        if (domNode.attribs['data-alert-widget'] !== undefined) {
          const {
            'data-type': type,
            'data-title': title,
            'data-message': message,
            'data-align': align,
            'data-size': size,
            'data-text-align': textAlign,
          } = domNode.attribs;
          return (
            <AlertWidgetRenderer
              type={type as any}
              title={title}
              message={message}
              align={align as any}
              size={size as any}
              textAlign={textAlign as any}
            />
          );
        }

        if (domNode.attribs['data-cta-widget'] !== undefined) {
          const {
            'data-text': text,
            'data-url': url,
            'data-style': style,
            'data-size': size,
            'data-text-align': textAlign,
          } = domNode.attribs;
          return (
            <CtaWidgetRenderer
              text={text}
              url={url}
              style={style as any}
              size={size as any}
              textAlign={textAlign as any}
            />
          );
        }
      }
    },
  };

  const isJson = normalizedHtml.trim().startsWith('{') || normalizedHtml.trim().startsWith('[');

  if (isJson) {
    try {
      JSON.parse(normalizedHtml);
      return (
        <div
          className={wrapperClassName}
          {...visualEditAttributes}
        >
          <SimpleTiptapRenderer content={rewriteYouTubeHostsInHtml(normalizedHtml)} />
        </div>
      );
    } catch {
      // Fallback to parse as HTML
    }
  }

  return (
    <div
      className={wrapperClassName}
      {...visualEditAttributes}
    >
      {parse(normalizedHtml, options)}
    </div>
  );
};

export default ClientTextBlockRenderer;
