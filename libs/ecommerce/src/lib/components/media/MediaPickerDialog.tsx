"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Database } from "@nextblock-cms/db";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Button,
  Input,
  Separator,
} from "@nextblock-cms/ui";
import { Search, CheckCircle } from "lucide-react";
import Image from "next/image";
import { resolveMediaUrl } from "@nextblock-cms/utils/media-url";
import MediaUploadForm from "./MediaUploadForm";

type Media = Database["public"]["Tables"]["media"]["Row"];

const MEDIA_REQUEST_TIMEOUT_MS = 8000;
const MEDIA_LIBRARY_LIMIT = 50;

/** The preview URL of an image row: bundled keys from the app's /images, the rest from the bucket. */
function resolveMediaPreviewSrc(media: Media) {
  return resolveMediaUrl(media.file_path || media.object_key);
}

interface MediaPickerDialogProps {
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "destructive" | "ghost";
  onSelect?: (media: Media) => void;
  accept?: (m: Media) => boolean; // filter, e.g. only images
  title?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean;
  defaultFolder?: string; // optional folder to pre-populate upload
}

export default function MediaPickerDialog({
  triggerLabel = "Select from Library",
  triggerVariant = "outline",
  onSelect,
  accept,
  title = "Select or Upload Media",
  open,
  onOpenChange,
  hideTrigger,
  defaultFolder,
}: MediaPickerDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = typeof open === "boolean";
  const isOpen = isControlled ? (open as boolean) : internalOpen;
  const setIsOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<Media[]>([]);
  const requestIdRef = useRef(0);

  const fetchLibrary = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const controller = new AbortController();
      timeoutId = setTimeout(
        () => controller.abort(new Error("Media library request timed out.")),
        MEDIA_REQUEST_TIMEOUT_MS
      );

      const params = new URLSearchParams({
        limit: MEDIA_LIBRARY_LIMIT.toString(),
      });

      if (searchTerm.trim()) {
        params.set("q", searchTerm.trim());
      }

      const response = await fetch(`/api/media/library?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const payload = (await response.json()) as {
        items?: Media[];
        error?: string;
      };

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!response.ok) {
        console.error("Error fetching media library:", payload.error);
        setLoadError(payload.error || "We couldn't load the media library. Please retry.");
      } else {
        setItems(payload.items || []);
      }
    } catch (error: any) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      console.error("Error fetching media library:", error);

      if (error?.name === "AbortError" || error?.message === "Media library request timed out.") {
        setLoadError("The media library took too long to respond. Please retry.");
      } else {
        setLoadError("We couldn't load the media library. Please retry.");
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [searchTerm]);

  useEffect(() => {
    if (isOpen) fetchLibrary();
  }, [isOpen, fetchLibrary]);

  const filtered = useMemo(() => {
    return accept ? items.filter(accept) : items;
  }, [items, accept]);

  const handleSelect = (media: Media) => {
    if (onSelect) {
      onSelect(media);
    }
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button type="button" variant={triggerVariant} size="sm">
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[650px] md:max-w-[800px] lg:max-w-[1000px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="p-1">
          <MediaUploadForm
            returnJustData={true}
            defaultFolder={defaultFolder}
            onUploadSuccess={(newMedia) => {
              setItems((prev) => [newMedia, ...prev.filter((m) => m.id !== newMedia.id)]);
              handleSelect(newMedia);
            }}
          />
        </div>

        <Separator className="my-4" />

        <div className="flex flex-col flex-grow overflow-hidden">
          <h3 className="text-lg font-medium mb-3 text-center">Or Select from Library</h3>
          <div className="relative mb-2">
            <Input
              type="search"
              placeholder="Search library..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </div>
          {isLoading && filtered.length === 0 ? (
            <div className="flex-grow flex items-center justify-center">
              <p>Loading media...</p>
            </div>
          ) : loadError && filtered.length === 0 ? (
            <div className="flex-grow flex flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">{loadError}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void fetchLibrary()}>
                Retry
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex-grow flex items-center justify-center">
              <p>No media found.</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 overflow-y-auto min-h-0 pr-2 pb-2">
              {filtered.map((media: Media) => {
                const previewSrc = media.file_type?.startsWith("image/") ? resolveMediaPreviewSrc(media) : null;
                return (
                <button
                  key={media.id}
                  type="button"
                  className="relative aspect-square border rounded-md overflow-hidden group focus:outline-none focus:ring-2 focus:ring-primary min-w-0 w-1/3 sm:w-1/4 md:w-1/5 lg:w-1/6"
                  onClick={() => handleSelect(media)}
                >
                  {previewSrc ? (
                    <>
                      <Image
                        src={previewSrc}
                        alt={media.description || media.file_name || "Media library image"}
                        fill
                        className="absolute inset-0 w-full h-full object-cover"
                        placeholder={media.blur_data_url ? "blur" : "empty"}
                        blurDataURL={media.blur_data_url || undefined}
                        sizes="(max-width: 639px) 33vw, (max-width: 767px) 25vw, (max-width: 1023px) 20vw, 17vw"
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity flex items-center justify-center">
                        <CheckCircle className="h-8 w-8 text-white" />
                      </div>
                    </>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground p-1 text-center">
                      Preview unavailable
                    </div>
                  )}
                  <p className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs p-1 truncate text-center">
                    {media.file_name}
                  </p>
                </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
