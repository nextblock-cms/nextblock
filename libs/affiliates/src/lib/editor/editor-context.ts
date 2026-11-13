'use client';

/**
 * What the storefront editor shares with its node views and its slash menu. Tiptap renders React
 * node views as portals inside `EditorContent`, so they read this context like any child.
 */
import { createContext, useContext } from 'react';

import type { StorefrontProductStore } from './product-store';

export interface StorefrontEditorContextValue {
  /** Opens the product picker for the grid at `pos`. */
  openProductPicker: (pos: number) => void;
  productStore: StorefrontProductStore;
  maxProductsPerGrid: number;
  editable: boolean;
}

export const StorefrontEditorContext = createContext<StorefrontEditorContextValue | null>(null);

/** The surrounding `StorefrontEditor`, or null (a grid node view rendered by another host). */
export function useStorefrontEditorContext(): StorefrontEditorContextValue | null {
  return useContext(StorefrontEditorContext);
}
