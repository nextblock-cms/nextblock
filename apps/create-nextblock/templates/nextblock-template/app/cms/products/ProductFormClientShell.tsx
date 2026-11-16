'use client';

import React from 'react';
import { ProductForm } from '@nextblock-cms/ecommerce';
import MediaPickerDialog from '../media/components/MediaPickerDialog';
import DraftStatusActions from '../components/DraftStatusActions';
import { usePageSeo } from '../../../lib/seo/page-audit-context';
import { useProductDraftFlag } from './ProductDraftFlagProvider';

type ProductFormProps = React.ComponentProps<typeof ProductForm>;
type ProductUpdateAction = NonNullable<ProductFormProps['updateAction']>;

type ProductFormClientShellProps = ProductFormProps & {
  /** Present only in edit mode; drives the "Unpublished Draft" toolbar. */
  productId?: string;
  /** Draft existence as computed on the server for the current render. */
  serverHasDraft?: boolean;
  /**
   * Computed on the server (the edit page: the caller is an ADMIN past the second factor). Anyone
   * else sees the toolbar's Publish disabled with a note; Discard stays. publishProductVisualEditingDraft
   * checks again, so this only spares a refused round trip.
   */
  canPublishProduct?: boolean;
};

const productFormSkeletonRows = ['details', 'description', 'media', 'inventory'];

export default function ProductFormClientShell({
  productId,
  serverHasDraft = false,
  canPublishProduct = false,
  updateAction,
  ...props
}: ProductFormClientShellProps) {
  const [isMounted, setIsMounted] = React.useState(false);
  const pageSeo = usePageSeo();

  const handleSeoChange = React.useCallback(
    (values: { title?: string | null; meta_title?: string | null; meta_description?: string | null }) => {
      if (pageSeo) {
        if (values.title !== undefined) {
          pageSeo.setDocumentTitle(values.title || null);
        }
        pageSeo.setMeta({
          metaTitle: values.meta_title || null,
          metaDescription: values.meta_description || null,
        });
      }
    },
    [pageSeo]
  );

  // The draft toolbar is gated on the server-computed `hasDraft`, but the form
  // autosave writes a draft WITHOUT revalidating the route, so the flag is latched
  // on the client: on the edit page it is the page's shared flag, which the
  // visibility control reads too (ProductDraftFlagProvider).
  const { hasDraft, draftSaveCount, markDraftSaved } = useProductDraftFlag(serverHasDraft);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  // Reveal the toolbar as soon as a form autosave succeeds. The autosave already
  // upserted a product_drafts row, so a draft now exists.
  const wrappedUpdateAction = React.useCallback(
    async (data: Parameters<ProductUpdateAction>[0]) => {
      const result = await updateAction!(data);
      markDraftSaved();
      return result;
    },
    [markDraftSaved, updateAction]
  );

  return (
    <>
      {productId ? (
        <DraftStatusActions
          parentId={productId}
          parentType="product"
          hasDraft={hasDraft}
          canPublish={canPublishProduct}
          draftSaveCount={draftSaveCount}
        />
      ) : null}
      {isMounted ? (
        <ProductForm
          {...props}
          hasOpenDraft={hasDraft}
          onSeoChange={handleSeoChange}
          updateAction={updateAction ? wrappedUpdateAction : undefined}
          mediaPickerNode={
            <MediaPickerDialog
              triggerLabel="+ Add Image"
              triggerVariant="outline"
              defaultFolder="uploads/products/"
            />
          }
        />
      ) : (
        <ProductFormShellSkeleton />
      )}
    </>
  );
}

function ProductFormShellSkeleton() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <div className="space-y-3">
        <div className="h-8 w-56 rounded-md bg-muted" />
        <div className="h-4 w-80 max-w-full rounded-md bg-muted/70" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-24 rounded-lg border bg-muted/30" />
        <div className="h-24 rounded-lg border bg-muted/30" />
      </div>

      {productFormSkeletonRows.map((row) => (
        <div key={row} className="rounded-lg border p-4">
          <div className="mb-4 h-5 w-40 rounded-md bg-muted" />
          <div className="h-32 rounded-md bg-muted/30" />
        </div>
      ))}
    </div>
  );
}
