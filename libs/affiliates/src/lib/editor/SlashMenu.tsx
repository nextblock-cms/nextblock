'use client';

/**
 * The slash menu UI: a listbox the keyboard drives from inside the editor (↑ ↓ to move, Enter or
 * Tab to insert, Escape to close). The editor stays focused; the active option is exposed with
 * `aria-activedescendant` on the editing surface and announced in a polite live region.
 */
import type { Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import { cn } from '@nextblock-cms/utils';
import {
  Heading2,
  Heading3,
  ImagePlus,
  Lightbulb,
  List,
  ListOrdered,
  Minus,
  ShoppingBag,
  TextQuote,
  type LucideIcon,
} from 'lucide-react';
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';

import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import { useAffiliatesCopy } from '../i18n/use-affiliates-copy';
import type { StorefrontSlashRender } from './extensions/slash-command';
import type { StorefrontSlashItem, StorefrontSlashItemId } from './extensions/slash-items';

const ITEM_ICONS: Readonly<Record<StorefrontSlashItemId, LucideIcon>> = {
  heading2: Heading2,
  heading3: Heading3,
  bulletList: List,
  orderedList: ListOrdered,
  quote: TextQuote,
  divider: Minus,
  callout: Lightbulb,
  image: ImagePlus,
  products: ShoppingBag,
};

export interface StorefrontSlashMenuProps {
  items: StorefrontSlashItem[];
  command: (item: StorefrontSlashItem) => void;
  editor: Editor;
}

export interface StorefrontSlashMenuHandle {
  /** Handles ↑ ↓ Enter Tab; returns true when the key was used. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const StorefrontSlashMenu = forwardRef<StorefrontSlashMenuHandle, StorefrontSlashMenuProps>(
  function StorefrontSlashMenu({ items, command, editor }, ref) {
    const { t } = useAffiliatesCopy(AFFILIATES_EDITOR_COPY);
    const listId = useId();
    const listRef = useRef<HTMLDivElement | null>(null);
    const [active, setActive] = useState(0);
    const itemsKey = items.map((item) => item.id).join(',');
    const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
    const optionId = (index: number) => `${listId}-option-${index}`;

    useEffect(() => {
      setActive(0);
    }, [itemsKey]);

    useEffect(() => {
      if (activeIndex < 0) return;
      const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
      option?.scrollIntoView?.({ block: 'nearest' });
    }, [activeIndex]);

    useEffect(() => {
      if (editor.isDestroyed) return undefined;
      const dom = editor.view.dom;
      dom.setAttribute('aria-controls', listId);
      dom.setAttribute('aria-expanded', 'true');
      if (activeIndex >= 0) dom.setAttribute('aria-activedescendant', `${listId}-option-${activeIndex}`);
      else dom.removeAttribute('aria-activedescendant');
      return () => {
        if (editor.isDestroyed) return;
        dom.removeAttribute('aria-controls');
        dom.removeAttribute('aria-expanded');
        dom.removeAttribute('aria-activedescendant');
      };
    }, [editor, listId, activeIndex]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          if (items.length === 0) return false;
          if (event.key === 'ArrowDown') {
            setActive((index) => (index + 1) % items.length);
            return true;
          }
          if (event.key === 'ArrowUp') {
            setActive((index) => (index - 1 + items.length) % items.length);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[activeIndex] ?? items[0];
            if (item) command(item);
            return true;
          }
          return false;
        },
      }),
      [items, activeIndex, command]
    );

    const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;

    return (
      <div className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t('affiliates.editor.slash_menu_label')}
          className="max-h-[var(--storefront-slash-max-height,20rem)] overflow-y-auto p-1"
        >
          {items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('affiliates.editor.slash_no_results')}</p>
          ) : (
            items.map((item, index) => {
              const Icon = ITEM_ICONS[item.id];
              const selected = index === activeIndex;
              return (
                <div
                  key={item.id}
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  // Keep the editor focused (and its selection) while the pointer picks an item.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => command(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      command(item);
                    }
                  }}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                  </span>
                </div>
              );
            })
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {activeItem
            ? t('affiliates.editor.slash_active_option', {
                title: activeItem.title,
                position: activeIndex + 1,
                count: items.length,
              })
            : t('affiliates.editor.slash_no_results')}
        </p>
      </div>
    );
  }
);

type SlashProps = SuggestionProps<StorefrontSlashItem, StorefrontSlashItem>;

function menuProps(props: SlashProps): StorefrontSlashMenuProps {
  return { items: props.items, command: props.command, editor: props.editor };
}

/** The suggestion renderer for `StorefrontSlashCommand`: mounts the menu, positioned by Tiptap. */
export function createStorefrontSlashMenuRender(): StorefrontSlashRender {
  return () => {
    let renderer: ReactRenderer<StorefrontSlashMenuHandle, StorefrontSlashMenuProps> | null = null;
    let unmount: (() => void) | null = null;

    return {
      onStart: (props: SlashProps) => {
        renderer = new ReactRenderer(StorefrontSlashMenu, {
          props: menuProps(props),
          editor: props.editor,
          className: 'z-50',
        });
        unmount = props.mount(renderer.element);
      },
      onUpdate: (props: SlashProps) => {
        renderer?.updateProps(menuProps(props));
      },
      onKeyDown: ({ event }) => (event.key === 'Escape' ? false : (renderer?.ref?.onKeyDown(event) ?? false)),
      onExit: () => {
        unmount?.();
        unmount = null;
        renderer?.destroy();
        renderer = null;
      },
    };
  };
}
