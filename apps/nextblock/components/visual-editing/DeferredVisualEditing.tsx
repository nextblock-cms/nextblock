'use client';

import dynamic from 'next/dynamic';

// Defer the visual-editing toolbar (and its heavy editor graph: BlockEditorModal,
// the per-block editors, and editor.css) out of the public bundle. The layout only
// renders this in draft/visual-editing mode, but a *static* import would still ship
// the entire editor graph to every public page. Loading it via next/dynamic with
// ssr:false keeps it out of the public homepage's render-blocking CSS and JS, and
// pulls it in client-side only when visual editing is actually active.
const NextblockVisualEditing = dynamic(
  () =>
    import('./NextblockVisualEditing').then(
      (module) => module.NextblockVisualEditing
    ),
  { ssr: false }
);

export interface DeferredVisualEditingProps {
  /**
   * Computed on the server: the root layout's currentUserCanPublishProductDrafts() (an ADMIN past
   * the second factor, the check publishProductVisualEditingDraft opens with), asked only while the
   * visual editor is on. The toolbar disables Publish on a product for anyone else, an ADMIN whose
   * second factor is still pending included: the profile's role alone left it enabled for them, and
   * publish refused every click. Publish checks again on the server; this only spares the round trip.
   */
  canPublishProducts: boolean;
  /**
   * Also from the root layout: the profile says ADMIN but the check above said no, so the second
   * factor is pending (or the check failed). It only picks the note beside the disabled Publish:
   * "Complete two-factor verification to publish product changes." instead of the admin-only one.
   */
  secondFactorPending: boolean;
}

export function DeferredVisualEditing({ canPublishProducts, secondFactorPending }: DeferredVisualEditingProps) {
  return <NextblockVisualEditing canPublishProducts={canPublishProducts} secondFactorPending={secondFactorPending} />;
}
