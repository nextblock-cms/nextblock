// Client-only entry: the restricted storefront Tiptap editor. Import it statically from a 'use client'
// component (useEditor runs with immediatelyRender: false, so SSR is safe); a dynamic import would make
// Nx treat the whole lib as lazy-loaded and fail enforce-module-boundaries on every static import.
export * from './lib/editor';
