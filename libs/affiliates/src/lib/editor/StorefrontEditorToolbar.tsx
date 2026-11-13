'use client';

/**
 * The storefront editor toolbar: a WAI-ARIA toolbar (one Tab stop; ← → Home End move between
 * buttons), toggle buttons expose `aria-pressed`, every button has an `aria-label`, and pointer
 * presses keep the editor's selection (no blur). Active states come from `useEditorState` in the
 * parent, so the toolbar re-renders only when they change.
 */
import { cn } from '@nextblock-cms/utils';
import type { Editor } from '@tiptap/core';
import {
  Bold,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Lightbulb,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Redo2,
  ShoppingBag,
  Strikethrough,
  TextQuote,
  Type,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useRef, useState, type KeyboardEvent } from 'react';

import type { AffiliatesCopyTranslate } from '../i18n/types';
import type { StorefrontCalloutTone } from '../storefront/types';
import { toggleStorefrontQuote } from './commands';

/** The active formatting at the selection, as `StorefrontEditor` reads it with `useEditorState`. */
export interface StorefrontEditorToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  link: boolean;
  heading2: boolean;
  heading3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  callout: boolean;
  calloutTone: StorefrontCalloutTone;
  imageSelected: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface StorefrontEditorToolbarProps {
  editor: Editor;
  state: StorefrontEditorToolbarState;
  t: AffiliatesCopyTranslate;
  onLink: () => void;
  onAddProducts: () => void;
  /** Omitted when the editor cannot upload images. */
  onAddImage?: () => void;
  onImageDescription: () => void;
  uploading?: boolean;
}

interface ToolbarItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  busy?: boolean;
  shortcut?: { keys: string; display: string };
  /** Starts a new visual group. */
  group?: 'tone';
  separatorBefore?: boolean;
}

const BUTTON_BASE =
  'inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ring-offset-background disabled:pointer-events-none disabled:opacity-40';
const BUTTON_PRESSED = 'bg-accent text-accent-foreground';
const BUTTON_IDLE = 'text-muted-foreground hover:bg-accent hover:text-accent-foreground';

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

function shortcut(key: string, mac: boolean, shift = false): { keys: string; display: string } {
  const upper = key.toUpperCase();
  return {
    keys: shift ? `Control+Shift+${upper} Meta+Shift+${upper}` : `Control+${upper} Meta+${upper}`,
    display: mac ? `${shift ? '⇧' : ''}⌘${upper}` : `Ctrl+${shift ? 'Shift+' : ''}${upper}`,
  };
}

export function StorefrontEditorToolbar({
  editor,
  state,
  t,
  onLink,
  onAddProducts,
  onAddImage,
  onImageDescription,
  uploading = false,
}: StorefrontEditorToolbarProps) {
  const mac = isMacPlatform();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const run = (command: () => boolean) => () => {
    if (!editor.isDestroyed) command();
  };

  const items: ToolbarItem[] = [
    {
      key: 'bold',
      label: t('affiliates.editor.bold'),
      icon: Bold,
      pressed: state.bold,
      shortcut: shortcut('b', mac),
      onClick: run(() => editor.chain().focus().toggleBold().run()),
    },
    {
      key: 'italic',
      label: t('affiliates.editor.italic'),
      icon: Italic,
      pressed: state.italic,
      shortcut: shortcut('i', mac),
      onClick: run(() => editor.chain().focus().toggleItalic().run()),
    },
    {
      key: 'underline',
      label: t('affiliates.editor.underline'),
      icon: Underline,
      pressed: state.underline,
      shortcut: shortcut('u', mac),
      onClick: run(() => editor.chain().focus().toggleUnderline().run()),
    },
    {
      key: 'strike',
      label: t('affiliates.editor.strike'),
      icon: Strikethrough,
      pressed: state.strike,
      shortcut: shortcut('s', mac, true),
      onClick: run(() => editor.chain().focus().toggleStrike().run()),
    },
    {
      key: 'link',
      label: t('affiliates.editor.link'),
      icon: LinkIcon,
      pressed: state.link,
      shortcut: shortcut('k', mac),
      onClick: onLink,
    },
    {
      key: 'heading2',
      label: t('affiliates.editor.heading_2'),
      icon: Heading2,
      pressed: state.heading2,
      separatorBefore: true,
      onClick: run(() => editor.chain().focus().toggleHeading({ level: 2 }).run()),
    },
    {
      key: 'heading3',
      label: t('affiliates.editor.heading_3'),
      icon: Heading3,
      pressed: state.heading3,
      onClick: run(() => editor.chain().focus().toggleHeading({ level: 3 }).run()),
    },
    {
      key: 'bulletList',
      label: t('affiliates.editor.bullet_list'),
      icon: List,
      pressed: state.bulletList,
      separatorBefore: true,
      onClick: run(() => editor.chain().focus().toggleBulletList().run()),
    },
    {
      key: 'orderedList',
      label: t('affiliates.editor.ordered_list'),
      icon: ListOrdered,
      pressed: state.orderedList,
      onClick: run(() => editor.chain().focus().toggleOrderedList().run()),
    },
    {
      key: 'quote',
      label: t('affiliates.editor.quote'),
      icon: TextQuote,
      pressed: state.blockquote,
      onClick: run(() => toggleStorefrontQuote(editor)),
    },
    {
      key: 'callout',
      label: t('affiliates.editor.callout'),
      icon: Lightbulb,
      pressed: state.callout,
      onClick: run(() => editor.chain().focus().toggleStorefrontCallout({ tone: 'info' }).run()),
    },
  ];

  if (state.callout) {
    const tones: Array<{ tone: StorefrontCalloutTone; label: string }> = [
      { tone: 'info', label: t('affiliates.editor.callout_tone_info') },
      { tone: 'tip', label: t('affiliates.editor.callout_tone_tip') },
      { tone: 'highlight', label: t('affiliates.editor.callout_tone_highlight') },
    ];
    for (const { tone, label } of tones) {
      items.push({
        key: `tone-${tone}`,
        label,
        icon: Type,
        group: 'tone',
        pressed: state.calloutTone === tone,
        onClick: run(() => editor.chain().focus().setStorefrontCalloutTone(tone).run()),
      });
    }
  }

  items.push({
    key: 'products',
    label: t('affiliates.editor.add_products'),
    icon: ShoppingBag,
    separatorBefore: true,
    onClick: onAddProducts,
  });
  if (onAddImage) {
    items.push({
      key: 'image',
      label: t('affiliates.editor.add_image'),
      icon: ImagePlus,
      disabled: uploading,
      busy: uploading,
      onClick: onAddImage,
    });
  }
  if (state.imageSelected) {
    items.push({
      key: 'imageDescription',
      label: t('affiliates.editor.image_description'),
      icon: Type,
      onClick: onImageDescription,
    });
  }
  items.push(
    {
      key: 'undo',
      label: t('affiliates.editor.undo'),
      icon: Undo2,
      disabled: !state.canUndo,
      separatorBefore: true,
      shortcut: shortcut('z', mac),
      onClick: run(() => editor.chain().focus().undo().run()),
    },
    {
      key: 'redo',
      label: t('affiliates.editor.redo'),
      icon: Redo2,
      disabled: !state.canRedo,
      shortcut: shortcut('z', mac, true),
      onClick: run(() => editor.chain().focus().redo().run()),
    }
  );

  const focusable = items.filter((item) => !item.disabled).map((item) => item.key);
  const tabStop = activeKey !== null && focusable.includes(activeKey) ? activeKey : (focusable[0] ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (focusable.length === 0) return;
    const current = (event.target as HTMLElement).dataset['toolbarKey'];
    const index = current ? focusable.indexOf(current) : -1;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % focusable.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + focusable.length) % focusable.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = focusable.length - 1;
    else return;
    event.preventDefault();
    const key = focusable[next];
    if (key === undefined) return;
    setActiveKey(key);
    buttons.current.get(key)?.focus();
  };

  const renderButton = (item: ToolbarItem) => {
    const Icon = item.busy ? Loader2 : item.icon;
    const title = item.shortcut ? `${item.label} (${item.shortcut.display})` : item.label;
    const isToneButton = item.group === 'tone';
    return (
      <button
        key={item.key}
        ref={(element) => {
          if (element) buttons.current.set(item.key, element);
          else buttons.current.delete(item.key);
        }}
        type="button"
        data-toolbar-key={item.key}
        tabIndex={item.key === tabStop ? 0 : -1}
        aria-label={item.label}
        title={title}
        aria-pressed={item.pressed === undefined ? undefined : item.pressed}
        aria-keyshortcuts={item.shortcut?.keys}
        aria-busy={item.busy ? true : undefined}
        disabled={item.disabled}
        // Keep the editor focused and its selection intact on pointer presses.
        onMouseDown={(event) => event.preventDefault()}
        onFocus={() => setActiveKey(item.key)}
        onClick={item.onClick}
        className={cn(BUTTON_BASE, item.pressed ? BUTTON_PRESSED : BUTTON_IDLE, isToneButton ? 'h-8 px-2 text-xs' : '')}
      >
        {isToneButton ? <span>{item.label}</span> : <Icon aria-hidden="true" className={cn('h-4 w-4', item.busy ? 'animate-spin' : '')} />}
      </button>
    );
  };

  const toneItems = items.filter((item) => item.group === 'tone');
  const firstToneIndex = items.findIndex((item) => item.group === 'tone');

  return (
    <div
      role="toolbar"
      aria-label={t('affiliates.editor.toolbar_label')}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex flex-wrap items-center gap-1 rounded-t-lg border-b border-border bg-muted/40 px-2 py-1.5"
    >
      {items.map((item, index) => {
        if (item.group === 'tone') {
          if (index !== firstToneIndex) return null;
          return (
            <div
              key="tone-group"
              role="group"
              aria-label={t('affiliates.editor.callout_style')}
              className="flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
            >
              {toneItems.map(renderButton)}
            </div>
          );
        }
        return (
          <Fragment key={item.key}>
            {item.separatorBefore && index > 0 ? (
              <span role="separator" aria-orientation="vertical" className="mx-1 h-6 w-px bg-border" />
            ) : null}
            {renderButton(item)}
          </Fragment>
        );
      })}
    </div>
  );
}
