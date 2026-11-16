'use client';

import React from 'react';

/**
 * The product edit page's draft flag, shared by the editor shell (its draft bar and ProductForm) and
 * the top bar's visibility control. The form's autosave writes a draft WITHOUT revalidating the route
 * (revalidating would re-init the form and loop the autosave: see updateProductAction), so the server
 * render's `hasDraft` stays false until the page loads again. The shell latches the flag on once an
 * autosave succeeds, and the visibility dialog reads the same flag: with the server's alone, it never
 * offered "Publish your unpublished edits" for an autosaved draft, and the older live version went
 * public in its place.
 */
type ProductDraftFlag = {
  hasDraft: boolean;
  /**
   * Autosaves since the page loaded, and drafts the server reported after reporting none (a
   * description-block edit): the draft bar comes back for a draft saved after it settled.
   */
  draftSaveCount: number;
  markDraftSaved: () => void;
};

const ProductDraftFlagContext = React.createContext<ProductDraftFlag | null>(null);

/**
 * On when the server reports a draft (block edits in BlockEditorArea call router.refresh(), which
 * re-runs the page) or a save says one exists. Only ever latches ON, until the page loads again.
 * Publish and discard reload the page 800 ms later; a publish that returns a warning (or an error
 * starting "Published, but") reloads only from its toast's "Reload page" button, and a product
 * revision restore reloads too. Until then the visibility control treats NO_PRODUCT_DRAFT_ERROR as
 * nothing to publish, and the draft bar hides until the next autosave or server-reported draft
 * (draftSaveCount).
 */
function useLatchedDraftFlag(serverHasDraft: boolean): ProductDraftFlag {
  const [hasDraft, setHasDraft] = React.useState(serverHasDraft);
  const [draftSaveCount, setDraftSaveCount] = React.useState(0);
  const previousServerHasDraft = React.useRef(serverHasDraft);

  React.useEffect(() => {
    if (serverHasDraft) {
      setHasDraft(true);
      // A draft the server reports again after reporting none (a publish re-rendered the page, then a
      // description-block edit created a new draft and refreshed it) counts as a save too, so the
      // draft bar comes back for it: block edits never call markDraftSaved.
      if (!previousServerHasDraft.current) {
        setDraftSaveCount((count) => count + 1);
      }
    }
    previousServerHasDraft.current = serverHasDraft;
  }, [serverHasDraft]);

  const markDraftSaved = React.useCallback(() => {
    setHasDraft(true);
    setDraftSaveCount((count) => count + 1);
  }, []);
  return React.useMemo(
    () => ({ hasDraft, draftSaveCount, markDraftSaved }),
    [hasDraft, draftSaveCount, markDraftSaved]
  );
}

export function ProductDraftFlagProvider({
  serverHasDraft,
  children,
}: {
  serverHasDraft: boolean;
  children: React.ReactNode;
}) {
  const flag = useLatchedDraftFlag(serverHasDraft);
  return <ProductDraftFlagContext.Provider value={flag}>{children}</ProductDraftFlagContext.Provider>;
}

/** The page's shared flag inside the provider; outside one (the new-product page), a latch of the caller's own. */
export function useProductDraftFlag(serverHasDraft: boolean): ProductDraftFlag {
  const shared = React.useContext(ProductDraftFlagContext);
  const own = useLatchedDraftFlag(serverHasDraft);
  return shared ?? own;
}

/** Whether the provider's flag is on: false outside one (the page and post editors have none). */
export function useSharedProductDraftFlag(): boolean {
  return React.useContext(ProductDraftFlagContext)?.hasDraft === true;
}
