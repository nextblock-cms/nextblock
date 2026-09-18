import React from 'react';
import { cn } from '@nextblock-cms/utils';

import { toNoCookieEmbedSrc } from './SimpleTiptapRenderer';

const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

/**
 * `products.short_description` is authored as plain text (the visual editor's textarea, the
 * Cortex tools, the seed), but older rows carry HTML, some with an embed. The product page
 * used to render it as HTML and the featured-product block as text, so the same row showed
 * raw tags in one place and a working embed in the other.
 */
export const isHtmlShortDescription = (value: string): boolean => HTML_TAG_PATTERN.test(value);

interface ShortDescriptionProps {
  value: string | null | undefined;
  className?: string;
}

/**
 * Renders a product's short description the same way everywhere: HTML when the text contains
 * markup (embeds rewritten to the no-cookie host), otherwise as escaped text that keeps its
 * line breaks. Staff-authored either way; no user input reaches this field.
 */
export function ShortDescription({ value, className }: ShortDescriptionProps) {
  const text = value?.trim();
  if (!text) return null;

  if (isHtmlShortDescription(text)) {
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: toNoCookieEmbedSrc(text) ?? text }}
      />
    );
  }

  return <p className={cn('whitespace-pre-line', className)}>{text}</p>;
}
