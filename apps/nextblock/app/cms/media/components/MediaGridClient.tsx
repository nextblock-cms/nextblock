"use client";

import React, { useState, useTransition, useEffect } from "react";
import type { Database } from "@nextblock-cms/db";
import { Button } from "@nextblock-cms/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@nextblock-cms/ui";
import { Progress } from "@nextblock-cms/ui";

type Media = Database['public']['Tables']['media']['Row'];
import { Checkbox } from "@nextblock-cms/ui";
import { Trash2, Edit3, MoreHorizontal, FileText, Image as ImageIconLucideHost, AlertCircle } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@nextblock-cms/ui";
import MediaImage from "./MediaImage";
import DeleteMediaButtonClient from "./DeleteMediaButtonClient"; // For single item deletion
import MediaUsageList from "./MediaUsageList";
import { deleteMultipleMediaItems, deleteUnusedMediaItems, getMediaUsage, moveSingleMediaItem } from "../actions"; // Server actions for bulk ops
import { resolveMediaUrl } from "../../../../lib/media/resolveMediaUrl";
import { isMediaUnused, type MediaUsage } from "../../../../lib/media/media-usage-format";
import { ConfirmationModal } from "../../components/ConfirmationModal";

interface MediaGridClientProps {
  initialMediaItems: Media[];
  r2BaseUrl: string;
  /**
   * The library's "Unused" view (?usage=unused): the page listed only the items nothing uses
   * (public.media_usage, 02045); `historyOnlyIds` are named by revisions alone.
   */
  unusedView?: { historyOnlyIds: string[] } | null;
  /** The "Unused" view's lookup failed: nothing is listed, and this says why. */
  usageError?: string | null;
}

interface MessageState {
  type: "success" | "error";
  text: string;
}

/** The bulk delete confirmation's usage check (getMediaUsage on the selected items). */
type BulkUsageState =
  | { status: "loading" }
  | { status: "ready"; usage: Record<string, MediaUsage> }
  | { status: "error"; error: string };

/** "Delete unused" takes at most this many ids a call (the action's own limit). */
const DELETE_UNUSED_BATCH = 500;

export default function MediaGridClient({ initialMediaItems, r2BaseUrl, unusedView = null, usageError = null }: MediaGridClientProps) {
  const [selectedItems, setSelectedItems] = useState<Array<{ id: string; objectKey: string }>>([]);
  const [mediaItems, setMediaItems] = useState<Media[]>(initialMediaItems);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveFolder, setMoveFolder] = useState<string>("");
  const [isMoving, setIsMoving] = useState(false);
  const [moveProgress, setMoveProgress] = useState(0);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkUsage, setBulkUsage] = useState<BulkUsageState>({ status: "loading" });
  const [cleanupOpen, setCleanupOpen] = useState(false);

  useEffect(() => {
    setMediaItems(initialMediaItems);
  }, [initialMediaItems]);

  const fileName = (id: string) => mediaItems.find((item) => item.id === id)?.file_name ?? id;

  /** Takes the deleted items out of the grid and the selection (the revalidation re-renders it too). */
  const dropItems = (ids: readonly string[]) => {
    const gone = new Set(ids.map((id) => id.toLowerCase()));
    setMediaItems((prev) => prev.filter((item) => !gone.has(item.id.toLowerCase())));
    setSelectedItems((prev) => prev.filter((item) => !gone.has(item.id.toLowerCase())));
  };

  const handleSelectionChange = (itemId: string, objectKey: string, checked: boolean) => {
    setSelectedItems((prevSelected) => {
      if (checked) {
        return [...prevSelected, { id: itemId, objectKey }];
      } else {
        return prevSelected.filter((item) => item.id !== itemId);
      }
    });
  };

  /** Opens the bulk delete confirmation and asks where the selected files are used. */
  const handleBulkDelete = async () => {
    if (selectedItems.length === 0) {
      setMessage({ type: "error", text: "No items selected for deletion." });
      return;
    }

    setMessage(null);
    setBulkDialogOpen(true);
    setBulkUsage({ status: "loading" });
    try {
      const result = await getMediaUsage(selectedItems.map((item) => item.id));
      setBulkUsage(
        result.error !== undefined ? { status: "error", error: result.error } : { status: "ready", usage: result.usage }
      );
    } catch (error) {
      setBulkUsage({
        status: "error",
        error: error instanceof Error && error.message ? error.message : "Where these files are used could not be checked.",
      });
    }
  };

  /** "Delete all": every selected file, used or not (the editor saw where). */
  const deleteAllSelected = () => {
    const toDelete = selectedItems;
    startTransition(async () => {
      const result = await deleteMultipleMediaItems(toDelete);
      setBulkDialogOpen(false);
      if (result.error) {
        setMessage({ type: "error", text: result.error });
      } else if (result.success) {
        setMessage({ type: "success", text: result.success });
        // The page revalidates too; take the selection out of the grid at once.
        dropItems(toDelete.map((item) => item.id));
      }
    });
  };

  /** "Delete only the unused": the server checks again and deletes what nothing uses. */
  const deleteUnusedSelected = () => {
    const ids = selectedItems.map((item) => item.id);
    startTransition(async () => {
      const result = await deleteUnusedMediaItems(ids);
      setBulkDialogOpen(false);
      if (result.error !== undefined) {
        setMessage({ type: "error", text: result.error });
      } else {
        setMessage({ type: "success", text: result.success });
        dropItems(result.deletedIds);
      }
    });
  };

  /** The "Unused" view's "Delete all unused": every listed item, in batches the action accepts. */
  const deleteAllListedUnused = () => {
    const ids = mediaItems.map((item) => item.id);
    startTransition(async () => {
      const deleted: string[] = [];
      const notes: string[] = [];
      let failure: string | null = null;
      for (let start = 0; start < ids.length; start += DELETE_UNUSED_BATCH) {
        const result = await deleteUnusedMediaItems(ids.slice(start, start + DELETE_UNUSED_BATCH));
        if (result.error !== undefined) {
          failure = result.error;
          break;
        }
        deleted.push(...result.deletedIds);
        notes.push(result.success);
      }
      setCleanupOpen(false);
      dropItems(deleted);
      if (failure) {
        setMessage({ type: "error", text: deleted.length > 0 ? `Deleted ${deleted.length} file(s), then stopped: ${failure}` : failure });
      } else {
        setMessage({ type: "success", text: notes.join(" ") || "Nothing to delete." });
      }
    });
  };

  const selectedUsage = bulkUsage.status === "ready" ? bulkUsage.usage : null;
  const usedSelected = selectedUsage
    ? selectedItems.filter((item) => {
        const entry = selectedUsage[item.id.toLowerCase()];
        return entry !== undefined && !isMediaUnused(entry);
      })
    : [];
  const unusedSelectedCount = selectedUsage
    ? selectedItems.filter((item) => {
        const entry = selectedUsage[item.id.toLowerCase()];
        return entry !== undefined && isMediaUnused(entry);
      }).length
    : 0;
  const historyOnlyCount = unusedView ? unusedView.historyOnlyIds.length : 0;

  const beginBulkMove = () => {
    if (selectedItems.length === 0) {
      setMessage({ type: "error", text: "No items selected for move." });
      return;
    }
    setMoveFolder("");
    setMoveDialogOpen(true);
  };

  const confirmBulkMove = async () => {
    const dest = moveFolder.trim();
    if (!dest) {
      setMoveError("Please enter a destination folder.");
      return;
    }
    setMoveError(null);
    setIsMoving(true);
    setMoveProgress(0);
    try {
      const total = selectedItems.length;
      let moved = 0;
      let hadError = false;
      for (const item of selectedItems) {
        const res = await moveSingleMediaItem(item, dest);
        if ((res as any)?.error) {
          // Accumulate errors but keep going
          hadError = true;
          setMoveError((prev) => (prev ? prev + " | " : "") + (res as any).error);
        } else {
          // Update local list
          setMediaItems((prev) => prev.map((m) => {
            if (m.id !== item.id) return m;
            const filename = m.object_key.substring(m.object_key.lastIndexOf('/') + 1);
            const folder = ensureFolderSlash(dest);
            return { ...m, object_key: `${folder}${filename}`, folder } as any;
          }));
        }
        moved += 1;
        setMoveProgress(Math.round((moved / total) * 100));
      }
      if (!hadError) setMessage({ type: "success", text: `Moved ${selectedItems.length} item(s).` });
      setSelectedItems([]);
      setMoveDialogOpen(false);
    } finally {
      setIsMoving(false);
    }
  };

  const ensureFolderSlash = (f: string) => (f.endsWith('/') ? f : `${f}/`);

  const isSelected = (itemId: string) => {
    return selectedItems.some((item) => item.id === itemId);
  };

  return (
    <div className="space-y-6">
      {selectedItems.length > 0 && (
        <div className="flex flex-col gap-3 p-4 border rounded-lg bg-card">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{selectedItems.length} item(s) selected</p>
            <div className="flex items-center gap-2">
              <Button onClick={beginBulkMove} disabled={isPending}>
                Move Selected
              </Button>
              <Button
                variant="destructive"
                onClick={handleBulkDelete}
                disabled={isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {isPending ? "Deleting..." : "Delete Selected"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={moveDialogOpen} onOpenChange={(open) => { if (!isMoving) setMoveDialogOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {selectedItems.length} item(s)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <input
              type="text"
              value={moveFolder}
              onChange={(e) => setMoveFolder(e.target.value)}
              placeholder="Destination folder e.g. uploads/images/"
              className="w-full border rounded-md px-3 h-9"
              disabled={isMoving}
            />
            {isMoving && (
              <div className="space-y-2">
                <Progress value={moveProgress} />
                <p className="text-xs text-muted-foreground">Moving... {moveProgress}%</p>
              </div>
            )}
            {moveError && <p className="text-sm text-red-600">{moveError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)} disabled={isMoving}>Cancel</Button>
            <Button onClick={confirmBulkMove} disabled={isMoving || selectedItems.length === 0}>Start Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDialogOpen} onOpenChange={(open) => { if (!isPending) setBulkDialogOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedItems.length} file(s)?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm" aria-live="polite" data-bulk-delete-usage>
            <p className="text-muted-foreground">Deleting is permanent: the files are removed from storage too.</p>
            {bulkUsage.status === "loading" ? (
              <p className="text-muted-foreground">Checking where the selected files are used…</p>
            ) : bulkUsage.status === "error" ? (
              <p className="text-destructive">{bulkUsage.error}</p>
            ) : (
              <>
                {usedSelected.length > 0 ? (
                  <div className="space-y-3">
                    <p className="font-medium">
                      {usedSelected.length} of {selectedItems.length} {usedSelected.length === 1 ? "is" : "are"} used:
                    </p>
                    <ul className="max-h-72 space-y-3 overflow-y-auto pe-1">
                      {usedSelected.map((item) => (
                        <li key={item.id} className="rounded-md border p-2">
                          <p className="mb-1 font-medium break-all">{fileName(item.id)}</p>
                          <MediaUsageList usage={bulkUsage.usage[item.id.toLowerCase()]} maxItems={3} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p>
                  {unusedSelectedCount === selectedItems.length
                    ? "Nothing in this site uses any of them."
                    : `${unusedSelectedCount} ${unusedSelectedCount === 1 ? "is" : "are"} not used anywhere in this site.`}
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={isPending}>Cancel</Button>
            <Button
              variant="secondary"
              onClick={deleteUnusedSelected}
              disabled={isPending || bulkUsage.status !== "ready" || unusedSelectedCount === 0}
            >
              Delete only the unused ({unusedSelectedCount})
            </Button>
            <Button variant="destructive" onClick={deleteAllSelected} disabled={isPending || bulkUsage.status === "loading"}>
              {isPending ? "Deleting..." : `Delete all ${selectedItems.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {usageError ? (
        <div role="alert" className="p-4 rounded-md text-sm bg-red-100 border border-red-200 text-red-700">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 mr-2 shrink-0" />
            {usageError} Nothing is listed as unused until the check works again.
          </div>
        </div>
      ) : null}

      {unusedView && mediaItems.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between" data-unused-banner>
          <p>
            {mediaItems.length} {mediaItems.length === 1 ? "file is" : "files are"} not used anywhere in this site (pages,
            posts, products, drafts, settings, logos and partner storefronts).
            {(() => {
              const listed = new Set(mediaItems.map((item) => item.id.toLowerCase()));
              const historyOnly = unusedView.historyOnlyIds.filter((id) => listed.has(id.toLowerCase())).length;
              return historyOnly > 0
                ? ` ${historyOnly} of them ${historyOnly === 1 ? "appears" : "appear"} only in revision history.`
                : null;
            })()}
          </p>
          <Button variant="destructive" onClick={() => setCleanupOpen(true)} disabled={isPending} className="shrink-0">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete all {mediaItems.length} unused
          </Button>
        </div>
      ) : null}

      <ConfirmationModal
        isOpen={cleanupOpen}
        onClose={() => { if (!isPending) setCleanupOpen(false); }}
        onConfirm={deleteAllListedUnused}
        title={`Delete ${mediaItems.length} unused file(s)?`}
        description="Each file is checked again before it is deleted, and one that is in use by then is kept. Deleting is permanent: the files are removed from storage too."
        confirmText={isPending ? "Deleting..." : "Delete"}
        confirmDisabled={isPending}
      >
        {historyOnlyCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            Restoring a revision that shows one of these files would show a missing image.
          </p>
        ) : null}
      </ConfirmationModal>

      {message && (
        <div
          className={`p-4 rounded-md text-sm ${
            message.type === "success"
              ? "bg-green-100 border border-green-200 text-green-700"
              : "bg-red-100 border border-red-200 text-red-700"
          }`}
        >
          <div className="flex items-center">
            {message.type === 'error' && <AlertCircle className="h-5 w-5 mr-2" />}
            {message.text}
          </div>
        </div>
      )}

      {mediaItems.length === 0 && selectedItems.length === 0 ? (
         <div className="text-center py-10 border rounded-lg mt-6">
           <ImageIconLucideHost className="mx-auto h-12 w-12 text-muted-foreground" />
           <h3 className="mt-2 text-sm font-medium text-foreground">
             {unusedView ? "Nothing to clean up" : usageError ? "Unused files could not be listed" : "No media found"}
           </h3>
           <p className="mt-1 text-sm text-muted-foreground">
             {unusedView
               ? "Every file here is used somewhere in this site."
               : usageError
                 ? "Try again in a moment."
                 : "Upload some files to get started."}
           </p>
         </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 mt-6">
          {mediaItems.map((item) => {
            const imageUrl = resolveMediaUrl(item.file_path || item.object_key, r2BaseUrl);

            return (
              <div
                key={item.id}
                className={`group relative border rounded-lg overflow-hidden shadow-sm aspect-square bg-muted/20 transition-all
                  ${isSelected(item.id) ? "ring-2 ring-primary ring-offset-2" : ""}`}
              >
                <div className="absolute top-2 left-2 z-10">
                  <Checkbox
                    id={`select-${item.id}`}
                    checked={isSelected(item.id)}
                    onCheckedChange={(checked) => {
                      handleSelectionChange(item.id, item.object_key, !!checked);
                    }}
                    aria-label={`Select ${item.file_name}`}
                    className="bg-white/70 hover:bg-white border-slate-400 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                  />
                </div>

                {item.file_type?.startsWith("image/") && imageUrl ? (
                  <MediaImage
                    src={imageUrl}
                    alt={item.description || item.file_name}
                    width={item.width || 500} // Default width if null
                    height={item.height || 500} // Default height if null
                    blurDataURL={item.blur_data_url || undefined}
                    className="h-full w-full object-contain transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="h-full w-full bg-muted flex flex-col items-center justify-center p-2">
                    <FileText className="h-12 w-12 text-muted-foreground mb-2" />
                    <p className="text-xs text-center text-muted-foreground truncate w-full" title={item.file_name}>
                      {item.file_name}
                    </p>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                  <div className="text-xs text-black truncate pt-1 ps-5" title={item.file_name}>{item.file_name}</div>
                  <div className="self-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="secondary" size="icon" className="text-white bg-black/40 hover:bg-black/60 h-7 w-7 rounded-full">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                              <Link href={`/cms/media/${item.id}/edit`} className="flex items-center cursor-pointer">
                                  <Edit3 className="mr-2 h-4 w-4" /> Edit Details
                              </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DeleteMediaButtonClient mediaItem={item} />
                        </DropdownMenuContent>
                      </DropdownMenu>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
