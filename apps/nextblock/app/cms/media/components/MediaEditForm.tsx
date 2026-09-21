// app/cms/media/components/MediaEditForm.tsx
"use client";

import React, { useState, useTransition, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@nextblock-cms/ui';
import { Spinner, Alert, AlertDescription } from '@nextblock-cms/ui';
import { Input } from '@nextblock-cms/ui';
import { Label } from '@nextblock-cms/ui';
import { Textarea } from '@nextblock-cms/ui';
import type { Database } from '@nextblock-cms/db';
import { useAuth } from '../../../../context/AuthContext';
import { useHotkeys } from '../../../../hooks/use-hotkeys';
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';

type Media = Database['public']['Tables']['media']['Row'];
import { FileText, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useCortexAiActive } from '../../components/CortexAiActiveContext';
import { buildCortexAiRequestHeaders } from '../../../../lib/cortex-ai/sandbox-headers';
import {
  buildAltTextContext,
  toAbsoluteImageUrl,
  UNRESOLVABLE_IMAGE_URL_MESSAGE,
} from '../../../../lib/cortex-ai/alt-text-request';
// The label the upload pipeline gives the untouched original file among a row's
// `variants`. It currently lives in the email module because email was the first consumer
// that needed the non-AVIF original; the constant itself is about the media pipeline, not
// about email, so importing it here is reuse rather than a layering violation — and it is
// far better than a second copy of the string drifting away from the pipeline that writes it.
import { ORIGINAL_UPLOAD_VARIANT_LABEL } from '../../../../lib/email/branding-format';

/** The `variants` JSONB rows the upload pipeline writes (camelCase keys). */
interface MediaVariantRecord {
  fileType?: string | null;
  objectKey?: string | null;
  variantLabel?: string | null;
}

/**
 * Choose which stored rendition of this media row to hand the vision model.
 *
 * `media.object_key` points at an AVIF derivative — that is what the pipeline produces and
 * what the site renders, because AVIF is small. It is the wrong thing to send to a vision
 * API: the mainstream image-understanding endpoints accept JPEG, PNG, GIF and WebP, and
 * simply reject AVIF. So the mid-size derivatives (`medium_avif`, `large_avif`), which
 * would otherwise be the ideal choice on download size, are unusable for this call.
 *
 * That leaves the `original_uploaded` variant: the untouched file the operator actually
 * uploaded, in whatever format their camera or design tool produced. The tradeoff is real
 * and worth naming — it can be several megabytes where a mid-size AVIF would have been a
 * few dozen kilobytes, so this call is heavier than it looks. It is accepted here because
 * a heavy call that works beats a cheap one that returns "unsupported image format", and
 * because alt text is generated once per asset, by hand, not on a hot path.
 *
 * When no original was kept (the seeded default assets have no variants) we fall back to
 * the preview URL the form already computed, and let the route decide.
 */
function pickAltTextSourceObjectKey(media: Media): string | null {
  // `variants` is typed as the generic `Json`, so the cast goes through `unknown`: the
  // shape is a runtime contract with the upload pipeline, not something the generated
  // Supabase types can express, and every field is re-checked below before it is used.
  const variants = Array.isArray(media.variants)
    ? (media.variants as unknown as MediaVariantRecord[])
    : [];

  const original = variants.find(
    (variant) =>
      variant &&
      typeof variant === 'object' &&
      variant.variantLabel === ORIGINAL_UPLOAD_VARIANT_LABEL &&
      typeof variant.objectKey === 'string' &&
      variant.objectKey.length > 0
  );

  return original?.objectKey ?? null;
}

interface MediaEditFormProps {
  mediaItem: Media;
  // The formAction will be updateMediaItem bound with the mediaItem.id
  formAction: (formData: FormData) => Promise<{ error?: string; success?: boolean; media?: Media } | void>;
}

export default function MediaEditForm({ mediaItem, formAction }: MediaEditFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { user, isLoading: authLoading, isAdmin, isWriter } = useAuth();

  const [fileName, setFileName] = useState(mediaItem.file_name);
  const [description, setDescription] = useState(mediaItem.description || "");
  const [formMessage, setFormMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  // Cortex AI is premium; hide the affordance entirely when the package is not activated
  // rather than letting the operator click into a 403.
  const isCortexAiActive = useCortexAiActive();
  const [isGeneratingAltText, setIsGeneratingAltText] = useState(false);
  const [altTextError, setAltTextError] = useState<string | null>(null);

  useEffect(() => {
    const successMessage = searchParams.get('success');
    const errorMessage = searchParams.get('error');
    if (successMessage) {
      setFormMessage({ type: 'success', text: successMessage });
    } else if (errorMessage) {
      setFormMessage({ type: 'error', text: errorMessage });
    }
  }, [searchParams]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormMessage(null);
    const formData = new FormData(event.currentTarget);
    // Ensure current values are on the formData if not explicitly set by controlled inputs
    formData.set('file_name', fileName);
    formData.set('description', description);


    startTransition(async () => {
      const result = await formAction(formData);
      if (result?.error) {
        setFormMessage({ type: 'error', text: result.error });
      } else if (result?.success) {
        setFormMessage({ type: 'success', text: "Media item updated successfully!" });
        // Optionally, update local state if the server returns the updated media item
        if (result.media) {
            setFileName(result.media.file_name);
            setDescription(result.media.description || "");
        }
        router.refresh(); // Refresh server components on the page
      }
    });
  };

  // Hooks must run on every render, so they sit above the early returns below: calling
  // them only after `authLoading` settles changes the hook count between renders, which
  // React rejects ("Rendered more hooks than during the previous render").
  const formRef = React.useRef<HTMLFormElement>(null);
  useHotkeys('ctrl+s', () => formRef.current?.requestSubmit());

  if (authLoading) {
    return <div>Loading form...</div>;
  }
  if (!user || (!isAdmin && !isWriter)) {
    return <div>Access Denied. You do not have permission to edit media.</div>;
  }
  const previewUrl = resolveMediaUrl(mediaItem.file_path || mediaItem.object_key);
  const isImage = Boolean(mediaItem.file_type?.startsWith("image/"));

  /**
   * Draft this asset's alt text with Cortex AI.
   *
   * `media.description` IS the alt text in this schema — there is no `alt_text` column, and
   * every consumer (the image block, the feature-image renderer, the media picker) already
   * reads `description` as alt. So the generated string is written into the existing
   * `description` state and nothing else changes: persistence still runs through the same
   * `updateMediaItem(mediaId, { description })` submit path as a hand-typed value, and the
   * operator still has to press Save. Generating is a draft, not a write.
   *
   * The URL handed to the route must be absolute http(s), because the route does not
   * receive image bytes — it receives a URL the AI SDK then downloads server-side.
   * `resolveMediaUrl()` returns a relative `/${objectKey}` whenever `NEXT_PUBLIC_R2_BASE_URL`
   * is unset, which is the default for the native Supabase-storage backend, so on a stock
   * install every asset would fail this call without the origin fix-up below.
   */
  const handleGenerateAltText = async () => {
    if (!isImage || isGeneratingAltText) {
      return;
    }

    const sourceObjectKey = pickAltTextSourceObjectKey(mediaItem);
    const imageUrl = toAbsoluteImageUrl(
      sourceObjectKey ? resolveMediaUrl(sourceObjectKey) : previewUrl
    );

    if (!imageUrl) {
      setAltTextError(UNRESOLVABLE_IMAGE_URL_MESSAGE);
      return;
    }

    setAltTextError(null);
    setIsGeneratingAltText(true);

    try {
      // The filename is the only context this screen has, and it is often genuinely
      // informative ("2026-harvest-crew.jpg"); passing it costs nothing and sometimes
      // rescues a description that would otherwise be generically correct and useless.
      const context = buildAltTextContext(
        `Media library asset named “${mediaItem.file_name}”.`
      );

      const response = await fetch('/api/ai/seo/alt-text', {
        // The route's body schema is a `z.strictObject` of optionals, so an absent field
        // must be omitted rather than sent as null — a null would fail validation outright.
        body: JSON.stringify({
          ...(context ? { context } : {}),
          imageUrl,
        }),
        headers: buildCortexAiRequestHeaders(),
        method: 'POST',
      });

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (!response.ok || !payload) {
        const message =
          payload && typeof payload['error'] === 'string'
            ? (payload['error'] as string)
            : 'Cortex AI could not describe this image.';
        throw new Error(message);
      }

      const generated = typeof payload['altText'] === 'string' ? payload['altText'].trim() : '';
      if (!generated) {
        throw new Error('Cortex AI returned an empty description.');
      }

      setDescription(generated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Cortex AI could not describe this image.';
      setAltTextError(message);
      toast.error(message);
    } finally {
      setIsGeneratingAltText(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="md:col-span-1 space-y-4">
        <h2 className="text-lg font-semibold">Media Preview</h2>
        {mediaItem.file_type?.startsWith("image/") && previewUrl ? (
          <Image
            src={previewUrl}
            alt={description || fileName}
            width={400}
            height={400}
            className="rounded-lg border object-contain aspect-square w-full max-w-sm mx-auto"
          />
        ) : (
          <div className="aspect-square w-full max-w-sm mx-auto bg-muted rounded-lg flex flex-col items-center justify-center p-4 text-center">
            <FileText className="h-16 w-16 text-muted-foreground mb-2" /> {/* Using FileText as a generic icon */}
            <p className="text-sm text-muted-foreground">No preview available for this file type.</p>
            <p className="text-xs text-muted-foreground mt-1">({mediaItem.file_type})</p>
          </div>
        )}
        <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Object Key:</strong> <span className="font-mono break-all">{mediaItem.object_key}</span></p>
            <p><strong>File Type:</strong> {mediaItem.file_type}</p>
            <p><strong>Size:</strong> {typeof mediaItem.size_bytes === 'number' ? (mediaItem.size_bytes / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown'}</p>
            <p><strong>Uploaded:</strong> {new Date(mediaItem.created_at).toLocaleString()}</p>
        </div>
      </div>

      <form ref={formRef} onSubmit={handleSubmit} className="md:col-span-2 space-y-6">
        {formMessage && (
          <Alert variant={formMessage.type === 'success' ? 'success' : 'destructive'} className="mb-4">
             <AlertDescription>{formMessage.text}</AlertDescription>
          </Alert>
        )}
        <div>
          <Label htmlFor="file_name">Display Name</Label>
          <Input
            id="file_name"
            name="file_name"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            required
            className="mt-1"
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="description">Description (Alt Text for Images)</Label>
            {/* Only for images, and only on a premium install: a non-activated Cortex AI
                must never render a button that cannot do anything. */}
            {isCortexAiActive && isImage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px]"
                onClick={handleGenerateAltText}
                disabled={isGeneratingAltText}
                title="Describe this image with Cortex AI"
              >
                {isGeneratingAltText ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-amber-500" />
                )}
                {isGeneratingAltText ? "Generating…" : "Generate with AI"}
              </Button>
            )}
          </div>
          <Textarea
            id="description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1"
            rows={4}
            placeholder="e.g., A vibrant sunset over a mountain range"
          />
          {altTextError && <p className="text-xs text-red-500 mt-1">{altTextError}</p>}
          {isCortexAiActive && isImage && (
            <p className="text-xs text-muted-foreground mt-1">
              Generated text lands in this field as a draft — review it, then press
              “Update Media Info” to save.
            </p>
          )}
        </div>

        <div className="flex justify-end space-x-3 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/cms/media")}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending || authLoading}>
            {isPending ? (
            <>
              <Spinner className="mr-2 h-4 w-4" /> Saving...
            </>
          ) : (
            "Update Media Info"
          )}
          </Button>
        </div>
      </form>
    </div>
  );
}
