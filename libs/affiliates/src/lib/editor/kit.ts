'use client';

/**
 * The restricted storefront editor kit. The schema it builds holds exactly the storefront node
 * and mark allowlist (`storefront/types.ts`) and nothing else: no code, no raw HTML nodes, no
 * styles, classes or event attributes. React node views and the slash menu UI are passed in by
 * the client (`StorefrontEditor`), so this module and the node definitions stay pure Tiptap and
 * `getSchema(createStorefrontEditorExtensions({ allowedImageOrigins: [] }))` works in node tests.
 */
import { Extension, type Editor, type Extensions, type NodeViewRenderer } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { createAffiliatesCopy } from '../i18n/copy-runtime';
import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import type { AffiliatesCopyTranslate } from '../i18n/types';
import { STOREFRONT_NODE_NAMES } from '../storefront/types';
import { STOREFRONT_DEFAULT_LINK_REL, sanitizeStorefrontHref } from '../storefront/urls';
import { STOREFRONT_EDITOR_MAX_LIST_NESTING, storefrontListNestingAt } from './commands';
import { isAtStorefrontCalloutBoundary, StorefrontCallout } from './extensions/callout';
import { StorefrontImage } from './extensions/image';
import { AffiliateProductGrid } from './extensions/product-grid';
import { StorefrontSlashCommand, type StorefrontSlashRender } from './extensions/slash-command';
import { StorefrontStarterKit } from './extensions/starter-kit';

/** Link protocols the editor accepts (site paths are accepted too). */
export const STOREFRONT_EDITOR_LINK_PROTOCOLS = ['http', 'https', 'mailto'] as const;

export interface StorefrontEditorKitOptions {
  /** Exact https origins images may come from (`/images/…` paths always pass); a getter is read live. */
  allowedImageOrigins: readonly string[] | (() => readonly string[]);
  /** Localized copy for placeholders and slash items (default English). */
  translate?: AffiliatesCopyTranslate;
  /** Whether the slash menu offers Image (read on every query). Default: never. */
  isImageUploadEnabled?: () => boolean;
  /** The slash Image item ran: open the file picker (client). */
  onImageRequest?: (editor: Editor) => void;
  /** A grid was inserted from the slash menu: open its product picker (client). */
  onProductGridInserted?: (editor: Editor, pos: number) => void;
  /** React slash menu renderer (client). Without one the plugin runs headless. */
  slashMenuRender?: StorefrontSlashRender;
  /** React node view of the product grid (client). */
  productGridNodeView?: NodeViewRenderer;
}

const ENGLISH = createAffiliatesCopy({ locale: 'en', dictionary: AFFILIATES_EDITOR_COPY });

/** True when the editor may store `url` as a link: the storefront allowlist, after Tiptap's own check. */
export function isStorefrontEditorLinkAllowed(url: string, defaultValidate?: (url: string) => boolean): boolean {
  if (typeof url !== 'string' || sanitizeStorefrontHref(url) === null) return false;
  return defaultValidate ? defaultValidate(url) : true;
}

/** Placeholder copy key for an empty node. */
function placeholderKeyFor(node: ProseMirrorNode): string {
  if (node.type.name === 'heading') return 'affiliates.editor.placeholder_heading';
  if (node.type.name === STOREFRONT_NODE_NAMES.callout) return 'affiliates.editor.placeholder_callout';
  return 'affiliates.editor.placeholder';
}

/**
 * Keyboard rules that must run before StarterKit's and the core keymap (high priority; an
 * extension, so the schema's node order is untouched):
 * - Tab does not indent a list item past the second level (the sanitizer would flatten it into
 *   paragraphs on the next save);
 * - Backspace at the start of a callout, or Enter in an empty one, turns it back into a paragraph
 *   (instead of merging it into the block above, or stacking empty callouts).
 */
const StorefrontEditorGuards = Extension.create({
  name: 'storefrontEditorGuards',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Tab: () => storefrontListNestingAt(this.editor.state.selection.$from) >= STOREFRONT_EDITOR_MAX_LIST_NESTING,
      Backspace: () =>
        isAtStorefrontCalloutBoundary(this.editor.state, false) ? this.editor.commands.setNode('paragraph') : false,
      Enter: () =>
        isAtStorefrontCalloutBoundary(this.editor.state, true) ? this.editor.commands.setNode('paragraph') : false,
    };
  },
});

/** The storefront editor extensions (one StarterKit; no duplicate extension names). */
export function createStorefrontEditorExtensions(options: StorefrontEditorKitOptions): Extensions {
  const translate: AffiliatesCopyTranslate = (key, values) => (options.translate ?? ENGLISH)(key, values);

  return [
    StorefrontStarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      code: false,
      // A trailing paragraph would be appended on the first click into a page that ends with a
      // grid or an image: a change nobody made, saved as a new draft. Insert commands add a
      // paragraph after an inserted block instead.
      trailingNode: false,
      dropcursor: { width: 2 },
      undoRedo: { depth: 100 },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: [...STOREFRONT_EDITOR_LINK_PROTOCOLS],
        isAllowedUri: (url, ctx) => isStorefrontEditorLinkAllowed(url, ctx.defaultValidate),
        HTMLAttributes: { rel: STOREFRONT_DEFAULT_LINK_REL, target: null, class: null },
      },
    }),
    StorefrontImage.configure({
      inline: false,
      allowBase64: false,
      allowedImageOrigins: options.allowedImageOrigins,
    }),
    Placeholder.configure({
      placeholder: ({ node }) => translate(placeholderKeyFor(node)),
      showOnlyCurrent: true,
      includeChildren: false,
    }),
    StorefrontCallout,
    AffiliateProductGrid.configure({ nodeView: options.productGridNodeView ?? null }),
    StorefrontSlashCommand.configure({
      translate,
      isImageUploadEnabled: options.isImageUploadEnabled ?? (() => false),
      onImageRequest: options.onImageRequest ?? null,
      onProductGridInserted: options.onProductGridInserted ?? null,
      render: options.slashMenuRender ?? null,
    }),
    StorefrontEditorGuards,
  ];
}
