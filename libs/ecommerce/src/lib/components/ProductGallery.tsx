'use client';

import { cn, useTranslations } from '@nextblock-cms/utils';
import { useState } from 'react';

import { translateOrFallback } from '../invoice-ui';

interface ProductGalleryProps {
  images?: { url: string; alt?: string; width?: number; height?: number }[];
  className?: string;
}

export const ProductGallery = ({ images = [], className }: ProductGalleryProps) => {
  const { t } = useTranslations();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Fallback if no images provided
  if (!images.length) {
    return (
      <div className={cn("relative aspect-square w-full overflow-hidden rounded-lg bg-secondary", className)}>
        <div className="flex h-full items-center justify-center text-muted-foreground">
          {translateOrFallback(t, 'ecommerce.no_image', 'No image')}
        </div>
      </div>
    );
  }

  // Clamp instead of resetting in an effect. Switching to a variant with fewer images used
  // to read `images[selectedIndex]` as undefined during the render BEFORE the reset effect
  // ran, and the product page crashed.
  const activeIndex = selectedIndex < images.length ? selectedIndex : 0;
  const active = images[activeIndex];

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="relative aspect-square w-full overflow-hidden rounded-lg border bg-white">
        {/* The main product image is the page's LCP element. */}
        <img
          src={active.url}
          alt={active.alt ?? ''}
          width={active.width ?? 1000}
          height={active.height ?? 1000}
          fetchPriority="high"
          decoding="async"
          className="h-full w-full object-cover object-center"
        />
      </div>

      {images.length > 1 && (
        // p-1: `overflow-x-auto` also clips vertically, which cut off the selection ring.
        <div className="flex gap-4 overflow-x-auto p-1 pb-2">
          {images.map((image, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setSelectedIndex(index)}
              aria-current={activeIndex === index ? 'true' : undefined}
              aria-label={translateOrFallback(t, 'ecommerce.gallery_show_image', 'Show image {index} of {total}')
                .replace('{index}', String(index + 1))
                .replace('{total}', String(images.length))}
              className={cn(
                "relative aspect-square w-20 flex-shrink-0 overflow-hidden rounded-md border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                activeIndex === index ? "ring-2 ring-primary" : "ring-1 ring-transparent hover:ring-primary/50"
              )}
            >
              {/* Named by the button's aria-label; every thumbnail used to repeat the same alt. */}
              <img
                src={image.url}
                alt=""
                width={80}
                height={80}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover object-center"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
