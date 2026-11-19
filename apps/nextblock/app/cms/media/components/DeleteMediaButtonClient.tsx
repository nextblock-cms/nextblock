// app/cms/media/components/DeleteMediaButtonClient.tsx
"use client";

import React, { useState, useTransition } from 'react';
import { DropdownMenuItem } from "@nextblock-cms/ui";
import { Trash2 } from "lucide-react";
import { toast } from 'sonner';
import type { Database } from "@nextblock-cms/db";
import { deleteMediaItem, getMediaUsage, type DeleteMediaItemResult } from "../actions";
import { ConfirmationModal } from '../../components/ConfirmationModal';
import MediaUsageList from './MediaUsageList';
import { isMediaUnused, type MediaUsage } from '../../../../lib/media/media-usage-format';

type Media = Database['public']['Tables']['media']['Row'];

interface DeleteMediaButtonClientProps {
  mediaItem: Media;
}

type UsageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; usage: MediaUsage }
  | { status: 'error'; error: string };

/**
 * Deletes one media item. The confirmation first says where the file is used (getMediaUsage:
 * public.media_usage, 02045): the button reads "Delete anyway" when something still uses it or the
 * check failed, and stays disabled until the check answers. Then the action answers `{ error }` or
 * `{ success }`, shown in a toast, and the library re-renders in place (folder and search kept):
 * until the 0.23.4 follow-up a refused delete redirected to the unfiltered library, which shows no
 * message at all.
 */
export default function DeleteMediaButtonClient({ mediaItem }: DeleteMediaButtonClientProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [usageState, setUsageState] = useState<UsageState>({ status: 'idle' });

  const loadUsage = async () => {
    setUsageState({ status: 'loading' });
    try {
      const result = await getMediaUsage([mediaItem.id]);
      if (result.error !== undefined) {
        setUsageState({ status: 'error', error: result.error });
        return;
      }
      const usage = result.usage[mediaItem.id.toLowerCase()];
      setUsageState(
        usage
          ? { status: 'ready', usage }
          : { status: 'error', error: 'This file is no longer in the media library.' }
      );
    } catch (error) {
      setUsageState({
        status: 'error',
        error: error instanceof Error && error.message ? error.message : 'Where this file is used could not be checked.',
      });
    }
  };

  const handleDelete = () => {
    startTransition(async () => {
      let result: DeleteMediaItemResult;
      try {
        result = await deleteMediaItem(mediaItem.id, mediaItem.object_key);
      } catch (error) {
        result = {
          error: error instanceof Error && error.message ? error.message : 'The media item could not be deleted.',
        };
      }
      setIsModalOpen(false);
      if (result.error) {
        toast.error(`${mediaItem.file_name} was not deleted: ${result.error}`);
      } else {
        toast.success(`Deleted ${mediaItem.file_name}.`);
      }
    });
  };

  const handleSelect = (event: Event) => {
    event.preventDefault();
    setIsModalOpen(true);
    void loadUsage();
  };

  const unused = usageState.status === 'ready' && isMediaUnused(usageState.usage);

  return (
    <>
      <DropdownMenuItem
        className="text-red-600 hover:!text-red-600 hover:!bg-red-50 dark:hover:!bg-red-700/20 cursor-pointer"
        onSelect={handleSelect}
        disabled={isPending}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {isPending ? 'Deleting...' : 'Delete'}
      </DropdownMenuItem>
      <ConfirmationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleDelete}
        title="Are you sure?"
        description="This will permanently delete the media file. This action cannot be undone."
        confirmText={isPending ? 'Deleting...' : unused ? 'Delete' : 'Delete anyway'}
        confirmDisabled={isPending || usageState.status === 'loading' || usageState.status === 'idle'}
      >
        <div className="rounded-md border p-3" aria-live="polite">
          {usageState.status === 'ready' ? (
            <MediaUsageList usage={usageState.usage} />
          ) : usageState.status === 'error' ? (
            <p className="text-sm text-destructive">{usageState.error}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Checking where this file is used…</p>
          )}
        </div>
      </ConfirmationModal>
    </>
  );
}
