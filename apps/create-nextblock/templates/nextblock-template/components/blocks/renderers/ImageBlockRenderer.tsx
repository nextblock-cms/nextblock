import React from "react";
import Image from "next/image";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";
import { StockPhotoCredit, isStockPhotoCreditCaption, type StockPhotoAttribution } from "./StockPhotoCredit";

export type ImageBlockContent = {
    media_id: string | null;
    object_key: string | null;
    external_url?: string | null;
    attribution?: StockPhotoAttribution | null;
    alt_text: string | null;
    caption: string | null;
    width: number | null;
    height: number | null;
    blur_data_url: string | null;
};

function isRenderableExternalImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

const R2_BASE_URL = process.env.NEXT_PUBLIC_R2_BASE_URL || "";

interface ImageBlockRendererProps {
  content: ImageBlockContent;
  languageId: number;
  priority?: boolean;
  visualEditAttributes?: VisualEditAttributes;
}

const ImageBlockRenderer: React.FC<ImageBlockRendererProps> = ({
  content,
  languageId,
  priority = false,
  visualEditAttributes,
}) => {
  void languageId;

  // External URL (e.g. a stock photo the AI inserted). Rendered with a plain
  // <img> so it works for any allowlisted https host without Next image
  // remotePatterns config. The caption/figure structure matches the R2 path.
  if (isRenderableExternalImageUrl(content.external_url)) {
    const hasDimensions =
      typeof content.width === "number" &&
      typeof content.height === "number" &&
      content.width > 0 &&
      content.height > 0;

    // Don't render a caption that merely repeats the attribution credit — the
    // StockPhotoCredit below already renders "Photo by … on {Provider}". (Stock
    // photos historically stored the credit string in `caption` too, which showed
    // the same line twice.)
    const captionText = content.caption?.trim() ?? "";
    const showCaption =
      captionText.length > 0 && !isStockPhotoCreditCaption(captionText, content.attribution);

    return (
      <div className="w-full" {...visualEditAttributes}>
        <figure className="my-6 text-center mx-auto max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={content.external_url as string}
            alt={content.alt_text || ""}
            {...(hasDimensions
              ? { width: content.width as number, height: content.height as number }
              : {})}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            decoding="async"
            className="rounded-md border max-w-full h-auto mx-auto"
          />
          {showCaption && (
            <figcaption className="text-sm text-muted-foreground mt-2">
              {content.caption}
            </figcaption>
          )}
          {content.attribution && (
            <StockPhotoCredit
              attribution={content.attribution}
              className="mt-1 block text-xs text-muted-foreground"
            />
          )}
        </figure>
      </div>
    );
  }

  // The two notes below are for whoever is editing the page. `visualEditAttributes` only
  // exists while visual editing is on; public visitors get nothing instead of a grey box
  // saying "object_key missing".
  if ((!content.media_id || !content.object_key) && !visualEditAttributes) {
    return null;
  }

  if (!content.media_id || !content.object_key) {
    return (
      <div
        className="my-4 p-4 border rounded text-center text-muted-foreground italic"
        {...visualEditAttributes}
      >
        (Image block: Media not selected or object_key missing)
      </div>
    );
  }
  
  const hasValidDimensions =
    typeof content.width === "number" &&
    typeof content.height === "number" &&
    content.width > 0 &&
    content.height > 0;

  if (!hasValidDimensions && !visualEditAttributes) {
    return null;
  }

  if (
    typeof content.width !== "number" ||
    typeof content.height !== "number" ||
    content.width <= 0 ||
    content.height <= 0
  ) {
    return (
      <div
        className="my-4 p-4 border rounded text-center text-muted-foreground italic"
        {...visualEditAttributes}
      >
        (Image block: Image dimensions are missing or invalid)
      </div>
    );
  }

  const displayImageUrl = `${R2_BASE_URL}/${content.object_key}`;
  
  return (
    <div className="w-full" {...visualEditAttributes}>
      <figure
        className="my-6 text-center mx-auto max-w-full"
        // Removed inline style: style={{ width: content.width }}
      >
        <Image
          src={displayImageUrl}
          alt={content.alt_text || ""}
          width={content.width}
          height={content.height}
          sizes="(max-width: 768px) 100vw, (max-width: 1280px) 75vw, 66vw"
          className="rounded-md border"
          placeholder={content.blur_data_url ? "blur" : "empty"}
          blurDataURL={content.blur_data_url || undefined}
          priority={priority}
          quality={60}
        />
        {content.caption && (
          <figcaption className="text-sm text-muted-foreground mt-2">
            {content.caption}
          </figcaption>
        )}
      </figure>
    </div>
  );
};

export default ImageBlockRenderer;
