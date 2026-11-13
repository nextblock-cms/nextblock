'use client';

/**
 * The storefront image node: `@tiptap/extension-image` (block, no base64, no resize handles)
 * extended with the stock photo `credit` attribute, so Unsplash / Pexels attribution survives
 * editing. Every way an image can enter the editor is checked against the allowed image origins:
 * pasted or dropped `<img>` elements from other hosts are dropped at parse time, and the Markdown
 * `![alt](src)` input rule is removed (it would accept any address).
 */
import Image, { type ImageOptions } from '@tiptap/extension-image';

import { STOREFRONT_LIMITS } from '../../storefront/limits';
import { sanitizeStorefrontImageCredit } from '../../storefront/sanitize';
import { cleanStorefrontText, truncateStorefrontText } from '../../storefront/text';
import type { StorefrontImageCredit } from '../../storefront/types';
import { normalizeStorefrontImageSrc } from '../../storefront/urls';

export interface StorefrontImageOptions extends ImageOptions {
  /** Exact https origins images may load from (`/images/…` paths always pass); a getter reads them live. */
  allowedImageOrigins: readonly string[] | (() => readonly string[]);
}

const MAX_CREDIT_ATTRIBUTE_LENGTH = 4000;

function resolveOrigins(value: StorefrontImageOptions['allowedImageOrigins'] | undefined): readonly string[] {
  try {
    const origins = typeof value === 'function' ? value() : value;
    return Array.isArray(origins) ? origins : [];
  } catch {
    return [];
  }
}

function readLine(value: string | null, max: number): string | null {
  if (value === null) return null;
  const window = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const text = truncateStorefrontText(cleanStorefrontText(window, { singleLine: true }).text.trim(), max).trimEnd();
  return text === '' ? null : text;
}

function readDimension(value: string | null): number | null {
  if (value === null || !/^\s*\d{1,4}\s*$/.test(value)) return null;
  const size = Number(value.trim());
  return size >= 1 && size <= STOREFRONT_LIMITS.maxImageDimension ? size : null;
}

function readCredit(value: string | null): StorefrontImageCredit | null {
  if (!value || value.length > MAX_CREDIT_ATTRIBUTE_LENGTH) return null;
  try {
    return sanitizeStorefrontImageCredit(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export const StorefrontImage = Image.extend<StorefrontImageOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as ImageOptions),
      inline: false,
      allowBase64: false,
      resize: false,
      allowedImageOrigins: [],
    };
  },

  addAttributes() {
    const origins = () => resolveOrigins(this.options.allowedImageOrigins);

    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeStorefrontImageSrc(element.getAttribute('src'), origins()),
      },
      alt: {
        default: null,
        parseHTML: (element: HTMLElement) => readLine(element.getAttribute('alt'), STOREFRONT_LIMITS.maxAltLength),
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => readLine(element.getAttribute('title'), STOREFRONT_LIMITS.maxImageTitleLength),
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => readDimension(element.getAttribute('width')),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => readDimension(element.getAttribute('height')),
      },
      credit: {
        default: null,
        parseHTML: (element: HTMLElement) => readCredit(element.getAttribute('data-credit')),
        renderHTML: (attributes: Record<string, unknown>) => {
          const credit = sanitizeStorefrontImageCredit(attributes['credit']);
          return credit === null ? {} : { 'data-credit': JSON.stringify(credit) };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        // Only images on an allowed host (or a site `/images/…` path) are kept; others are dropped.
        getAttrs: (node: HTMLElement | string) =>
          typeof node !== 'string' &&
          normalizeStorefrontImageSrc(node.getAttribute('src'), resolveOrigins(this.options.allowedImageOrigins)) !== null
            ? null
            : false,
      },
    ];
  },

  addInputRules() {
    return [];
  },
});
