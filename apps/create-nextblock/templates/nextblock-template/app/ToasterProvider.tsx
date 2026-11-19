"use client";

import { Toaster } from "react-hot-toast";
import { Toaster as SonnerToaster } from "sonner";

/**
 * sonner's toasts set no pointer-events of their own (its stylesheet gives `none` only to a hidden
 * toast), so while a Radix modal is open, which sets `pointer-events: none` on <body>, they inherited
 * it: their close and action buttons could not be clicked over an open dialog (the block editor,
 * a confirmation). react-hot-toast's toasts set `pointer-events: auto` themselves. The class sits in
 * Tailwind's utilities layer, so sonner's unlayered rule still lets clicks through a hidden toast.
 * BlockEditorModal's isToastInteraction keeps a click on either from counting as outside the editor.
 */
const SONNER_TOAST_CLASS_NAME = "pointer-events-auto";

// Two toast libraries are in use across the app: react-hot-toast in most of the CMS,
// and sonner in ~19 files (the commerce components, the settings pages, the new
// inbox). Only react-hot-toast was ever mounted, so every sonner toast — including
// "added to cart" — was silently discarded. Mount both rather than rewrite the call
// sites, and keep the two visually aligned.
export function ToasterProvider() {
  return (
    <>
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{ className: SONNER_TOAST_CLASS_NAME }}
    />
    <Toaster
      position="top-right"
      toastOptions={{
        style: { fontSize: 14 },
        success: { iconTheme: { primary: '#16a34a', secondary: 'white' } },
        error: { iconTheme: { primary: '#dc2626', secondary: 'white' } },
      }}
    />
    </>
  );
}
