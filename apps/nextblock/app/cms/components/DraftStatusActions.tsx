"use client";

import React, { useEffect, useId, useState } from "react";
import { Button } from "@nextblock-cms/ui";
import { toast } from "react-hot-toast";
import { useRouter } from "next/navigation";
import { CloudLightning, Trash2, Loader2 } from "lucide-react";
import {
  publishVisualEditingDraft,
  discardVisualEditingDraft,
  publishVisualEditingProductDraft,
  discardVisualEditingProductDraft,
} from "../../actions/visualEditingActions";
import {
  NO_CONTENT_DRAFT_ERROR,
  NO_PRODUCT_DRAFT_ERROR,
  PRODUCT_PUBLISH_ADMIN_ONLY_NOTE,
} from "../../../lib/visual-editing/product-draft-meta";

type DraftStatusActionsProps =
  | {
      parentId: string | number;
      parentType: "page" | "post";
      hasDraft: boolean;
    }
  | {
      parentId: string | number;
      parentType: "product";
      hasDraft: boolean;
      /**
       * Server-derived: the caller is an ADMIN past the second factor, the only role that may publish
       * a product draft (publishProductVisualEditingDraft checks it again). Anyone else gets Publish
       * disabled with a note; Discard stays. Required, so no product toolbar forgets it.
       */
      canPublish: boolean;
      /**
       * How many autosaves (and drafts the server reported after reporting none) the edit page's
       * latched draft flag has seen (ProductDraftFlagProvider): one after the bar settled brings it
       * back for the new draft, since `hasDraft` never turns off.
       */
      draftSaveCount?: number;
    };

export default function DraftStatusActions(props: DraftStatusActionsProps) {
  const { parentId, parentType, hasDraft } = props;
  const router = useRouter();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  // The draft went live (or was discarded) here: the bar leaves even before the page reloads, so it
  // never offers a draft that is gone while a publish warning waits on screen. It comes back for the
  // next draft. A page or post's `hasDraft` turns false (the refresh after the publish) and true again
  // (a later block edit). A product's flag only latches on, so a later autosave or server-reported
  // draft (draftSaveCount) brings it back: a publish warning that skipped the title says to edit it again, and that edit
  // needs a Publish (a settled bar stayed hidden until a reload).
  const draftSaveCount = props.parentType === "product" ? props.draftSaveCount ?? 0 : 0;
  const [settledAtSaveCount, setSettledAtSaveCount] = useState<number | null>(null);
  const isSettled = settledAtSaveCount !== null && settledAtSaveCount === draftSaveCount;
  const settle = () => setSettledAtSaveCount(draftSaveCount);
  const publishNoteId = useId();
  const isPublishBlocked = props.parentType === "product" && !props.canPublish;

  useEffect(() => {
    if (!hasDraft) {
      setSettledAtSaveCount(null);
    }
  }, [hasDraft]);

  if (!hasDraft || isSettled) {
    return null;
  }

  /**
   * After a publish or discard the page reloads 800 ms later (a publish with a warning waits for the
   * editor instead: showWarningUntilReload): the product edit page's draft flag
   * (ProductDraftFlagProvider) only ever latches on, so without the reload this bar would keep
   * offering a draft that is gone. A product skips router.refresh(): the action's own revalidatePath
   * already makes Next re-render this page in the action's response, which resets ProductForm to the
   * new values, and ProductForm remounts its variations editor on that reset, so the editor never
   * hands back the variants it held before. Pages and posts refresh first (a page or post discard
   * revalidates nothing), then reload too.
   */
  const reloadAfterDraftChange = () => {
    if (parentType !== "product") {
      router.refresh();
    }
    setTimeout(() => {
      window.location.reload();
    }, 800);
  };

  /**
   * A publish that went live with a warning keeps it on screen until the editor reloads the page from
   * the toast: the automatic reload 800 ms later cut the toast short, and the warning (fields a
   * pre-0.23.4 draft could not publish, description blocks that may show twice, history not recorded,
   * a draft row left behind) is often the only sign of what the publish skipped. As in the visibility
   * dialog, which keeps the same warning until it is closed.
   */
  const showWarningUntilReload = (warning: string, toastId: string) => {
    if (parentType !== "product") {
      router.refresh();
    }
    // A Dismiss button too: the toast never expires, and top right it can sit over an open block
    // editor's Save and Cancel buttons.
    toast.error(
      (shown) => (
        <span className="flex flex-col items-start gap-2">
          <span>{warning}</span>
          <span className="flex items-center gap-3">
            <button
              type="button"
              className="text-xs font-medium underline underline-offset-2"
              onClick={() => {
                toast.dismiss(shown.id);
                window.location.reload();
              }}
            >
              Reload page
            </button>
            <button
              type="button"
              className="text-xs font-medium underline underline-offset-2"
              onClick={() => toast.dismiss(shown.id)}
            >
              Dismiss
            </button>
          </span>
        </span>
      ),
      { id: toastId, duration: Infinity }
    );
  };

  const handlePublish = async () => {
    if (isPublishBlocked) {
      return;
    }
    setIsPublishing(true);
    const toastId = toast.loading("Publishing changes live...");
    try {
      let res;
      if (parentType === "product") {
        res = await publishVisualEditingProductDraft(String(parentId));
      } else {
        res = await publishVisualEditingDraft(
          parentType as "page" | "post",
          Number(parentId)
        );
      }

      const error = res && "error" in res ? res.error : undefined;
      // "Published, but failed to remove ... draft" is not a failure: the edits are live, and only
      // the draft row stayed. It shows as a success with that warning. The bar stays, since that
      // draft row still exists (Publish again, or Discard, clears it).
      const isPublishedWithError = Boolean(error && error.startsWith("Published, but"));
      const draftRowRemains = Boolean(error && error.startsWith("Published, but failed to remove"));
      const warning = isPublishedWithError ? error : res && "success" in res ? res.warning : undefined;

      if (error === NO_PRODUCT_DRAFT_ERROR || error === NO_CONTENT_DRAFT_ERROR) {
        // The draft is already gone (published or discarded in another tab, or deleted by a revision
        // restore) while this bar still offered it: nothing to publish, and the page catches up.
        settle();
        toast.success("There was no draft left to publish: the page now shows what is live.", { id: toastId });
        reloadAfterDraftChange();
      } else if (error && !isPublishedWithError) {
        toast.error(`Publish failed: ${error}`, { id: toastId });
      } else if (warning) {
        // The content IS live, with a caveat. Say so plainly rather than claiming an unqualified
        // success, and keep it on screen.
        if (!draftRowRemains) {
          settle();
        }
        showWarningUntilReload(warning, toastId);
      } else {
        settle();
        toast.success("Changes published live successfully!", { id: toastId });
        reloadAfterDraftChange();
      }
    } catch (err: any) {
      toast.error(`Error publishing: ${err.message || err}`, { id: toastId });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscard = async () => {
    if (!window.confirm("Are you sure you want to discard all draft changes? This action cannot be undone.")) {
      return;
    }
    setIsDiscarding(true);
    const toastId = toast.loading("Discarding draft changes...");
    try {
      let res;
      if (parentType === "product") {
        res = await discardVisualEditingProductDraft(String(parentId));
      } else {
        res = await discardVisualEditingDraft(
          parentType as "page" | "post",
          Number(parentId)
        );
      }

      if (res && "error" in res && res.error) {
        toast.error(`Discard failed: ${res.error}`, { id: toastId });
      } else {
        settle();
        toast.success("Draft changes discarded successfully.", { id: toastId });
        reloadAfterDraftChange();
      }
    } catch (err: any) {
      toast.error(`Error discarding: ${err.message || err}`, { id: toastId });
    } finally {
      setIsDiscarding(false);
    }
  };

  return (
    <div
      data-nextblock-draft-toolbar
      className="fixed bottom-6 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-3.5 rounded-full border border-amber-500/30 bg-background/95 px-4 py-2 text-sm shadow-xl backdrop-blur-md transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-bottom-5"
    >
      <div className="flex items-center gap-2 px-1">
        <div className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
        </div>
        <span className="font-semibold text-amber-800 dark:text-amber-300 text-[11px] uppercase tracking-wider select-none">
          Unpublished Draft
        </span>
      </div>
      <div className="h-4 w-[1px] bg-border" />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full border-amber-500/20 text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 hover:text-amber-900 dark:hover:text-amber-200 px-3.5 text-xs"
          onClick={handleDiscard}
          disabled={isDiscarding || isPublishing}
        >
          {isDiscarding ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          )}
          Discard
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-8 rounded-full bg-amber-600 hover:bg-amber-500 text-white border-0 shadow-md shadow-amber-600/10 px-4 text-xs font-medium"
          onClick={handlePublish}
          disabled={isPublishBlocked || isDiscarding || isPublishing}
          aria-describedby={isPublishBlocked ? publishNoteId : undefined}
        >
          {isPublishing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudLightning className="mr-1.5 h-3.5 w-3.5" />
          )}
          Publish
        </Button>
        {isPublishBlocked ? (
          <span id={publishNoteId} className="max-w-[16rem] text-[11px] leading-tight text-muted-foreground">
            {PRODUCT_PUBLISH_ADMIN_ONLY_NOTE}
          </span>
        ) : null}
      </div>
    </div>
  );
}
