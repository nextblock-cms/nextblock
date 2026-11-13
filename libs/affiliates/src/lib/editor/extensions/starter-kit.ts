'use client';

/**
 * StarterKit narrowed to the storefront document shape (`storefront/types.ts`), so the editor can
 * only hold what `sanitizeStorefrontDoc()` keeps: a quote holds paragraphs, a list item holds a
 * paragraph followed by paragraphs or nested lists. Without this, an image dragged into a list or
 * a heading pasted into a quote would show in the editor and vanish on the next save.
 *
 * The link mark stays StarterKit's own (configure it through `.configure({ link })`, never add
 * `@tiptap/extension-link` a second time). Its `target`, `rel`, `class` and `title` attributes are
 * pinned to their defaults when HTML is pasted, so pasted markup never brings classes or targets
 * along, and its `href` is stored in the canonical form `sanitizeStorefrontHref()` returns.
 */
import type { AnyExtension, Mark, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { STOREFRONT_DEFAULT_LINK_REL, sanitizeStorefrontHref } from '../../storefront/urls';

/** Content expressions that mirror the sanitizer's output shape. */
export const STOREFRONT_EDITOR_CONTENT_RULES = {
  blockquote: 'paragraph+',
  listItem: 'paragraph (paragraph | bulletList | orderedList)*',
} as const;

function restrictExtension(extension: AnyExtension): AnyExtension {
  switch (extension.name) {
    case 'blockquote':
      return (extension as Node).extend({ content: STOREFRONT_EDITOR_CONTENT_RULES.blockquote });
    case 'listItem':
      return (extension as Node).extend({ content: STOREFRONT_EDITOR_CONTENT_RULES.listItem });
    case 'link':
      return (extension as Mark).extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            href: {
              default: null,
              parseHTML: (element: HTMLElement) => sanitizeStorefrontHref(element.getAttribute('href')),
            },
            target: { default: null, parseHTML: () => null },
            rel: { default: STOREFRONT_DEFAULT_LINK_REL, parseHTML: () => STOREFRONT_DEFAULT_LINK_REL },
            class: { default: null, parseHTML: () => null },
            title: { default: null, parseHTML: () => null },
          };
        },
      });
    default:
      return extension;
  }
}

/** StarterKit with the storefront content rules. Configure it like StarterKit. */
export const StorefrontStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map(restrictExtension);
  },
});
