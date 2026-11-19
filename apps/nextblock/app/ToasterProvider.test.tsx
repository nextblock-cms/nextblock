// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ToasterProvider } from './ToasterProvider';

/**
 * A sonner toast is clickable over an open Radix modal. The modal sets `pointer-events: none` on
 * <body>, and sonner's toasts set no pointer-events of their own (its stylesheet gives `none` only to
 * a hidden toast), so a toast shown over the block editor or a confirmation inherited `none` and its
 * close and action buttons did nothing. Every sonner toast now carries `pointer-events-auto`, as
 * react-hot-toast's toasts set `pointer-events: auto` themselves.
 */

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // sonner reads the color scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe('ToasterProvider', () => {
  it('gives every sonner toast pointer-events-auto, so a modal on <body> cannot make it inert', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };
    await act(async () => root.render(<ToasterProvider />));

    await act(async () => {
      toast.error('Not deleted');
    });

    await vi.waitFor(() => expect(document.querySelector('[data-sonner-toast]')).not.toBeNull());
    const toastElement = document.querySelector<HTMLElement>('[data-sonner-toast]');
    expect(toastElement?.classList.contains('pointer-events-auto')).toBe(true);
    // Its close button is inside it, so it inherits the same.
    expect(toastElement?.querySelector('[data-close-button]')).not.toBeNull();
  });
});
