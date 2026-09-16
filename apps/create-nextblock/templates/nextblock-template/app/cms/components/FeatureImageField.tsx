"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Separator,
  Spinner,
} from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";

import { resolveMediaUrl } from "../../../lib/media/resolveMediaUrl";
import { getMediaItems } from "../media/actions";
import MediaImage from "../media/components/MediaImage";
import MediaUploadForm from "../media/components/MediaUploadForm";

type Media = Database["public"]["Tables"]["media"]["Row"];

interface FeatureImageFieldProps {
  /**
   * What this image will actually do, shown under the label.
   *
   * It differs by content type — on a page the feature image is a full-width title
   * banner above the blocks, on a post the article's hero — and editors could not
   * tell from the field alone, which is how home pages ended up with a banner
   * stacked over their hero. The caller supplies the copy because only it knows
   * which one it is.
   */
  description?: ReactNode;
  initialImageId?: string | null;
  initialImageUrl?: string | null;
  /**
   * Reports a selection or a removal to the parent form.
   *
   * The resolved URL is handed over alongside the id because this field has already
   * computed it for its own thumbnail, and the parent otherwise has no way to learn it
   * until the server round-trips the new `feature_image_id` back into
   * `initialImageUrl`. `PageForm` and `PostForm` use it to keep their share-card preview
   * honest the instant an image is picked; the id remains the only persisted half.
   */
  onImageIdChange?: (imageId: string | null, imageUrl: string | null) => void;
  uploadFolder: string;
}

export default function FeatureImageField({
  description,
  initialImageId,
  initialImageUrl,
  onImageIdChange,
  uploadFolder,
}: FeatureImageFieldProps) {
  const [selectedFeatureImage, setSelectedFeatureImage] = useState<{
    id: string | null;
    url: string | null;
  }>({
    id: initialImageId || null,
    url: initialImageUrl || null,
  });
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mediaItems, setMediaItems] = useState<Media[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaPage, setMediaPage] = useState(1);
  const [hasMoreMedia, setHasMoreMedia] = useState(true);

  useEffect(() => {
    setSelectedFeatureImage({
      id: initialImageId || null,
      url: initialImageUrl || null,
    });
  }, [initialImageId, initialImageUrl]);

  const loadMedia = useCallback(
    async (pageToLoad = 1, append = false) => {
      setMediaLoading(true);
      setMediaError(null);

      try {
        const result = await getMediaItems(pageToLoad, 20);
        if (result.error) {
          setMediaError(result.error);
          if (!append) setMediaItems([]);
        } else if (result.data) {
          setMediaItems((prev) =>
            append ? [...prev, ...(result.data || [])] : result.data || []
          );
          setHasMoreMedia(result.hasMore !== undefined ? result.hasMore : false);
          setMediaPage(pageToLoad);
        }
      } catch {
        setMediaError("An unexpected error occurred while fetching media.");
        if (!append) setMediaItems([]);
      } finally {
        setMediaLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (isModalOpen) {
      setMediaPage(1);
      setHasMoreMedia(true);
      loadMedia(1, false);
    }
  }, [isModalOpen, loadMedia]);

  const handleImageSelectInModal = (image: Media) => {
    const imageUrl = resolveMediaUrl(image.file_path || image.object_key);

    if (!imageUrl) {
      setMediaError("Selected image is missing a valid path.");
      return;
    }

    setSelectedFeatureImage({ id: image.id, url: imageUrl });
    onImageIdChange?.(image.id, imageUrl);
    setIsModalOpen(false);
  };

  const handleRemoveImage = () => {
    setSelectedFeatureImage({ id: null, url: null });
    onImageIdChange?.(null, null);
  };

  const handleImageSelectKeyDown = (event: KeyboardEvent<HTMLDivElement>, image: Media) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    handleImageSelectInModal(image);
  };

  return (
    <div>
      <Label htmlFor="feature_image_id">Feature Image</Label>
      {description ? <div className="mt-1 text-xs text-muted-foreground">{description}</div> : null}
      <Input type="hidden" id="feature_image_id" name="feature_image_id" value={selectedFeatureImage.id || ""} />
      <div className="mt-2">
        {selectedFeatureImage.url && (
          <div className="mb-4">
            <Image
              src={selectedFeatureImage.url}
              alt="Selected feature image"
              width={200}
              height={200}
              className="rounded-md object-cover"
            />
            <Button
              type="button"
              variant="link"
              className="mt-2 px-0 text-red-600"
              onClick={handleRemoveImage}
            >
              Remove Image
            </Button>
          </div>
        )}
        <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline">
              {selectedFeatureImage.id ? "Change Feature Image" : "Select Feature Image"}
            </Button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[90vw]">
            <DialogHeader>
              <DialogTitle>Select Feature Image</DialogTitle>
            </DialogHeader>
            <div className="p-1">
              <MediaUploadForm
                compact
                returnJustData={true}
                defaultFolder={uploadFolder}
                onUploadSuccess={(newlyUploadedMedia) => {
                  setMediaItems((prevItems) => [
                    newlyUploadedMedia,
                    ...prevItems.filter((item) => item.id !== newlyUploadedMedia.id),
                  ]);
                  handleImageSelectInModal(newlyUploadedMedia);
                }}
              />
            </div>
            <Separator className="my-4" />
            <div className="flex-grow overflow-y-auto py-4" id="media-modal-scroll-area">
              {mediaLoading && mediaItems.length === 0 && (
                <p className="text-center text-muted-foreground">Loading media...</p>
              )}
              {mediaError && <p className="text-center text-red-600">{mediaError}</p>}
              {!mediaLoading && !mediaError && mediaItems.length === 0 && (
                <p className="text-center text-muted-foreground">No media items found. Try uploading some first.</p>
              )}

              {mediaItems.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(0,150px))] gap-3">
                  {mediaItems.map((item) => {
                    const imageUrl = resolveMediaUrl(item.file_path || item.object_key);

                    if (!item.file_type?.startsWith("image/") || !imageUrl) {
                      return null;
                    }

                    return (
                      <div
                        key={item.id}
                        className="group relative aspect-square cursor-pointer overflow-hidden rounded-lg border bg-muted/20 shadow-sm transition-all hover:ring-2 hover:ring-primary"
                        onClick={() => handleImageSelectInModal(item)}
                        onKeyDown={(event) => handleImageSelectKeyDown(event, item)}
                        tabIndex={0}
                        role="button"
                        aria-label={`Select ${item.file_name}`}
                      >
                        <MediaImage
                          src={imageUrl}
                          alt={item.description || item.file_name}
                          width={item.width || 300}
                          height={item.height || 300}
                          blurDataURL={item.blur_data_url}
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/60 via-black/10 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                          <p className="truncate text-xs text-white" title={item.file_name}>
                            {item.file_name}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!mediaLoading && hasMoreMedia && mediaItems.length > 0 && (
                <div className="mt-6 text-center">
                  <Button type="button" onClick={() => loadMedia(mediaPage + 1, true)} variant="outline" disabled={mediaLoading}>
                    {mediaLoading ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" /> Loading...
                      </>
                    ) : (
                      "Load More"
                    )}
                  </Button>
                </div>
              )}
            </div>
            <DialogFooter className="mt-auto border-t pt-4">
              <DialogClose asChild>
                <Button type="button" variant="outline" onClick={() => setMediaError(null)}>
                  Cancel
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
