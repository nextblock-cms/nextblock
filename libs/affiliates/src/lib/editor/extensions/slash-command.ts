'use client';

/**
 * The storefront slash command: its own `@tiptap/suggestion` plugin (key `storefrontSlash`, so it
 * never collides with another suggestion plugin on the page). Pure: the React menu is passed in as
 * `render` on the client; without one the plugin still tracks the query (node tests).
 */
import { shift, size } from '@floating-ui/dom';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

import { createAffiliatesCopy } from '../../i18n/copy-runtime';
import { AFFILIATES_EDITOR_COPY } from '../../i18n/copy/editor';
import type { AffiliatesCopyTranslate } from '../../i18n/types';
import { STOREFRONT_NODE_NAMES } from '../../storefront/types';
import { insertStorefrontBlocks, insertStorefrontProductGrid, toggleStorefrontQuote } from '../commands';
import { getStorefrontSlashItems, type StorefrontSlashItem, type StorefrontSlashItemId } from './slash-items';

export const STOREFRONT_SLASH_PLUGIN_KEY = new PluginKey('storefrontSlash');

/** CSS variable the menu reads for its height, so it never runs off a short (phone) viewport. */
export const STOREFRONT_SLASH_MAX_HEIGHT_VAR = '--storefront-slash-max-height';

/** Keeps the menu inside the viewport: shifted along the edge, its height capped to the room left. */
const SLASH_MENU_MIDDLEWARE = [
  shift({ padding: 8 }),
  size({
    padding: 8,
    apply({ availableHeight, elements }) {
      const height = Math.max(120, Math.min(320, Math.floor(availableHeight)));
      elements.floating.style.setProperty(STOREFRONT_SLASH_MAX_HEIGHT_VAR, `${height}px`);
    },
  }),
];

/** The suggestion renderer (the client passes the React menu). */
export type StorefrontSlashRender = NonNullable<SuggestionOptions<StorefrontSlashItem, StorefrontSlashItem>['render']>;

export interface StorefrontSlashHooks {
  /** Called after the Image item removed the query: open the file picker. */
  onImageRequest?: ((editor: Editor) => void) | null;
  /** Called with the position of a grid the Products item inserted: open its product picker. */
  onProductGridInserted?: ((editor: Editor, pos: number) => void) | null;
}

export interface StorefrontSlashCommandOptions extends StorefrontSlashHooks {
  /** Localized item titles (default English). */
  translate: AffiliatesCopyTranslate;
  /** Whether the Image item is offered (read on every query). */
  isImageUploadEnabled: () => boolean;
  render: StorefrontSlashRender | null;
}

const ENGLISH = createAffiliatesCopy({ locale: 'en', dictionary: AFFILIATES_EDITOR_COPY });

/** Runs a slash item: removes the `/query` text (`range`) and applies the block. */
export function runStorefrontSlashItem(
  editor: Editor,
  range: Range,
  id: StorefrontSlashItemId,
  hooks: StorefrontSlashHooks = {}
): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  switch (id) {
    case 'heading2':
      return editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
    case 'heading3':
      return editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
    case 'bulletList':
      return editor.chain().focus().deleteRange(range).toggleBulletList().run();
    case 'orderedList':
      return editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    case 'quote':
      return toggleStorefrontQuote(editor, range);
    case 'callout':
      return editor.chain().focus().deleteRange(range).setStorefrontCallout({ tone: 'info' }).run();
    case 'divider': {
      editor.chain().focus().deleteRange(range).run();
      return insertStorefrontBlocks(editor, [{ type: 'horizontalRule' }]) !== null;
    }
    case 'image': {
      editor.chain().focus().deleteRange(range).run();
      hooks.onImageRequest?.(editor);
      return true;
    }
    case 'products': {
      const pos = insertStorefrontProductGrid(editor, { range });
      if (pos === null) return false;
      const node = editor.state.doc.nodeAt(pos);
      if (node?.type.name === STOREFRONT_NODE_NAMES.productGrid) hooks.onProductGridInserted?.(editor, pos);
      return true;
    }
    default:
      return false;
  }
}

export const StorefrontSlashCommand = Extension.create<StorefrontSlashCommandOptions>({
  name: 'storefrontSlashCommand',

  addOptions() {
    return {
      translate: ENGLISH,
      isImageUploadEnabled: () => false,
      onImageRequest: null,
      onProductGridInserted: null,
      render: null,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      Suggestion<StorefrontSlashItem, StorefrontSlashItem>({
        pluginKey: STOREFRONT_SLASH_PLUGIN_KEY,
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        allowedPrefixes: [' ', '\u00a0'],
        startOfLine: false,
        decorationClass: 'storefront-slash-query',
        floatingUi: { strategy: 'fixed', middleware: SLASH_MENU_MIDDLEWARE },
        // Only in paragraphs (top level, list items, quotes), and never in a read-only editor.
        allow: ({ editor, state, range }) =>
          editor.isEditable && state.doc.resolve(range.from).parent.type.name === 'paragraph',
        items: ({ query }) =>
          getStorefrontSlashItems({
            query,
            imageUpload: options.isImageUploadEnabled(),
            translate: options.translate,
          }),
        command: ({ editor, range, props }) => {
          runStorefrontSlashItem(editor, range, props.id, {
            onImageRequest: options.onImageRequest,
            onProductGridInserted: options.onProductGridInserted,
          });
        },
        ...(options.render ? { render: options.render } : {}),
      }),
    ];
  },
});
