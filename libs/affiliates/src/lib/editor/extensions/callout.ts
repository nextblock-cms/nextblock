'use client';

/**
 * `storefrontCallout`: a tinted tip / note / highlight box holding inline text. Pure Tiptap (no
 * React), so `getSchema()` works in node tests; the box is plain `renderHTML` output, styled with
 * the same literal tone classes as the public `StorefrontRenderer`.
 */
import { Node, isNodeActive, mergeAttributes } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

import { STOREFRONT_CALLOUT_TONES, STOREFRONT_NODE_NAMES, type StorefrontCalloutTone } from '../../storefront/types';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    storefrontCallout: {
      /** Turns the current text block into a callout. */
      setStorefrontCallout: (attributes?: { tone?: StorefrontCalloutTone }) => ReturnType;
      /** Callout ⇄ paragraph. */
      toggleStorefrontCallout: (attributes?: { tone?: StorefrontCalloutTone }) => ReturnType;
      /** Changes the tone of the callout(s) in the selection. */
      setStorefrontCalloutTone: (tone: StorefrontCalloutTone) => ReturnType;
    };
  }
}

/** Literal tone classes (Tailwind only generates classes it finds verbatim in the source). */
const CALLOUT_TONE_CLASSES: Readonly<Record<StorefrontCalloutTone, string>> = {
  info: 'my-6 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-foreground',
  tip: 'my-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-foreground',
  highlight: 'my-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-foreground',
};

/** True for `info` | `tip` | `highlight`. */
export function isStorefrontCalloutTone(value: unknown): value is StorefrontCalloutTone {
  return typeof value === 'string' && (STOREFRONT_CALLOUT_TONES as readonly string[]).includes(value);
}

/** A valid tone, `info` for anything else. */
export function readStorefrontCalloutTone(value: unknown): StorefrontCalloutTone {
  return isStorefrontCalloutTone(value) ? value : 'info';
}

export const StorefrontCallout = Node.create({
  name: STOREFRONT_NODE_NAMES.callout,
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: 'info',
        // ProseMirror runs this in `node.check()` (the editor's content check): a stored tone
        // outside the enum is refused instead of being rendered.
        validate: (value: unknown) => {
          if (!isStorefrontCalloutTone(value)) throw new RangeError('storefrontCallout.tone must be info, tip or highlight');
        },
        parseHTML: (element: HTMLElement) => readStorefrontCalloutTone(element.getAttribute('data-tone')),
        // Rendered by the node's renderHTML below (the tone also picks the classes).
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-storefront-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const tone = readStorefrontCalloutTone(node.attrs['tone']);
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        'data-storefront-callout': '',
        'data-tone': tone,
        role: 'note',
        class: CALLOUT_TONE_CLASSES[tone],
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setStorefrontCallout:
        (attributes) =>
        ({ commands }) =>
          commands.setNode(this.name, { tone: readStorefrontCalloutTone(attributes?.tone) }),
      // Any callout counts as "on" (Tiptap's toggleNode compares attributes, so a tip callout would
      // be re-toned to info instead of being turned off).
      toggleStorefrontCallout:
        (attributes) =>
        ({ commands, state }) =>
          isNodeActive(state, this.name)
            ? commands.setNode('paragraph')
            : commands.setNode(this.name, { tone: readStorefrontCalloutTone(attributes?.tone) }),
      setStorefrontCalloutTone:
        (tone) =>
        ({ commands }) =>
          isStorefrontCalloutTone(tone) ? commands.updateAttributes(this.name, { tone }) : false,
    };
  },

  // Its keyboard behaviour (Backspace at the start and Enter in an empty callout turn it back into
  // a paragraph) lives in the kit's high-priority guard extension, so it runs before the core
  // Backspace (which would merge the callout into the block above) without moving this node ahead
  // of `paragraph` in the schema (the first block type is the default one).
});

/** True when the cursor is in a callout: at its start, or (with `requireEmpty`) in an empty one. */
export function isAtStorefrontCalloutBoundary(state: EditorState, requireEmpty: boolean): boolean {
  const { empty, $from } = state.selection;
  if (!empty || $from.parent.type.name !== STOREFRONT_NODE_NAMES.callout) return false;
  return requireEmpty ? $from.parent.content.size === 0 : $from.parentOffset === 0;
}
