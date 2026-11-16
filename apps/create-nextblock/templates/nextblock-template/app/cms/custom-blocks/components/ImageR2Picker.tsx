'use client';

import { useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, UploadCloud, X } from 'lucide-react';
import { Button, Input, Label } from '@nextblock-cms/ui';

import { presignedPutFetchHeaders } from '../../../../lib/storage/presigned-put-client';

export type ImageR2Value = {
  alt?: string;
  file_name?: string;
  file_type?: string;
  height?: number;
  object_key: string;
  size_bytes?: number;
  url: string;
  width?: number;
};

export type ImageR2PickerProps = {
  accept?: string[];
  disabled?: boolean;
  folder?: string;
  maxBytes?: number;
  onChange: (value: ImageR2Value | null) => void;
  value?: ImageR2Value | null;
};

type PresignedUploadResponse = {
  error?: string;
  headers?: Record<string, string>;
  objectKey?: string;
  publicUrl?: string;
  uploadUrl?: string;
};

const DEFAULT_ACCEPT = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function deriveAltText(filename: string) {
  const base = filename.replace(/\.[^.]+$/, '');
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readImageDimensions(file: File) {
  return new Promise<{ height?: number; width?: number }>((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new window.Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ height: image.naturalHeight || undefined, width: image.naturalWidth || undefined });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({});
    };
    image.src = objectUrl;
  });
}

export function ImageR2Picker({
  accept = DEFAULT_ACCEPT,
  disabled = false,
  folder = 'custom-blocks',
  maxBytes = DEFAULT_MAX_BYTES,
  onChange,
  value,
}: ImageR2PickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFile(file: File | null) {
    if (!file) {
      return;
    }

    setError(null);

    if (!accept.includes(file.type)) {
      setError('Select an AVIF, GIF, JPEG, PNG, or WebP image.');
      return;
    }

    if (file.size > maxBytes) {
      setError(`Images are limited to ${Math.round(maxBytes / (1024 * 1024))} MB.`);
      return;
    }

    setIsUploading(true);
    try {
      const dimensions = await readImageDimensions(file);
      const presignedResponse = await fetch('/api/media/r2-presigned', {
        body: JSON.stringify({
          contentType: file.type,
          filename: file.name,
          folder,
          size: file.size,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const presignedPayload = (await presignedResponse.json()) as PresignedUploadResponse;

      if (!presignedResponse.ok || !presignedPayload.uploadUrl || !presignedPayload.objectKey) {
        throw new Error(presignedPayload.error || 'Could not prepare the upload.');
      }

      // The URL is signed for this file's size and type: send exactly the returned headers
      // (the browser sets Content-Length from the body itself).
      const uploadResponse = await fetch(presignedPayload.uploadUrl, {
        body: file,
        headers: presignedPutFetchHeaders(presignedPayload.headers, file),
        method: 'PUT',
      });

      if (!uploadResponse.ok) {
        throw new Error('The image upload did not complete.');
      }

      onChange({
        alt: value?.alt || deriveAltText(file.name),
        file_name: file.name,
        file_type: file.type,
        height: dimensions.height,
        object_key: presignedPayload.objectKey,
        size_bytes: file.size,
        url: presignedPayload.publicUrl || `/${presignedPayload.objectKey}`,
        width: dimensions.width,
      });
    } catch (uploadError) {
      console.error('[ImageR2Picker] Upload failed:', uploadError);
      setError(uploadError instanceof Error ? uploadError.message : 'The upload failed.');
    } finally {
      setIsUploading(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        accept={accept.join(',')}
        className="sr-only"
        disabled={disabled || isUploading}
        onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
        type="file"
      />

      <div className="flex items-center gap-3">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {value?.url ? (
            // Plain img (not next/image): the source can be any R2/external host
            // and must never crash the editor on an unconfigured next/image host.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={value.alt || value.file_name || 'Uploaded image'}
              className="h-full w-full object-cover"
              src={value.url}
            />
          ) : (
            <ImageIcon className="h-7 w-7 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || isUploading}
              onClick={() => inputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="mr-2 h-4 w-4" />
              )}
              Upload
            </Button>
            {value ? (
              <Button
                disabled={disabled || isUploading}
                onClick={() => onChange(null)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X className="mr-2 h-4 w-4" />
                Clear
              </Button>
            ) : null}
          </div>

          <p className="truncate text-xs text-muted-foreground">
            {value?.object_key || 'No R2 image selected'}
          </p>
        </div>
      </div>

      {value ? (
        <div className="space-y-1">
          <Label htmlFor="image-r2-alt">Alt text</Label>
          <Input
            disabled={disabled || isUploading}
            id="image-r2-alt"
            onChange={(event) => onChange({ ...value, alt: event.target.value })}
            placeholder="Describe the image"
            value={value.alt ?? ''}
          />
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
