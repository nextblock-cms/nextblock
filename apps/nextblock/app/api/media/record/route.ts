import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@nextblock-cms/db/server';
import type { Database } from '@nextblock-cms/db';
import {
  hasAllowedObjectKeyExtension,
  isSafeObjectKey,
} from '../../../../lib/storage/upload-policy';

type Media = Database['public']['Tables']['media']['Row'];

type ImageVariant = {
  objectKey: string;
  url?: string;
  width?: number;
  height?: number;
  fileType?: string;
  sizeBytes?: number;
  variantLabel?: string;
};

type RecordMediaPayload = {
  fileName?: string;
  description?: string | null;
  r2OriginalKey?: string;
  r2Variants?: ImageVariant[];
  originalImageDetails?: ImageVariant | null;
  blurDataUrl?: string | null;
  blurDataURL?: string | null;
};

function deriveAltFromFilename(name: string) {
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.substring(0, lastDot) : name;
  const spaced = base.replace(/[-+_\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function buildFallbackVariant(payload: RecordMediaPayload): Required<ImageVariant> {
  return {
    objectKey: payload.r2OriginalKey || '',
    url: '',
    width: 0,
    height: 0,
    fileType: 'application/octet-stream',
    sizeBytes: 0,
    variantLabel: 'fallback_original',
  };
}

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as RecordMediaPayload;

    if (!payload.fileName || !payload.r2OriginalKey) {
      return NextResponse.json(
        { error: 'Missing required media payload fields.' },
        { status: 400 }
      );
    }

    const supabase = createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'User not authenticated.' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions to record media.' },
        { status: 403 }
      );
    }

    const variants = payload.r2Variants || [];
    let primaryVariant =
      variants.find((variant) => variant.variantLabel === 'original_avif') ||
      variants.find((variant) => variant.variantLabel === 'xlarge_avif') ||
      variants[0] ||
      payload.originalImageDetails ||
      buildFallbackVariant(payload);

    if (!primaryVariant.objectKey) {
      primaryVariant = buildFallbackVariant(payload);
    }

    const originalVariant = payload.originalImageDetails;
    const allVariantsToStore = [
      ...(originalVariant && originalVariant.objectKey !== primaryVariant.objectKey
        ? [originalVariant]
        : []),
      ...variants,
    ].filter(
      (variant, index, self) =>
        Boolean(variant?.objectKey) &&
        index === self.findIndex((entry) => entry.objectKey === variant.objectKey)
    );

    const computedDescription =
      payload.description ??
      ((primaryVariant.fileType?.startsWith('image/') ||
        originalVariant?.fileType?.startsWith('image/'))
        ? deriveAltFromFilename(payload.fileName)
        : null);

    const objectKey = primaryVariant.objectKey.replace(/^\/+/, '');
    const folderMatch = objectKey.match(/^(.*\/)?.*$/);
    const folder = folderMatch && folderMatch[1] ? folderMatch[1] : null;

    // Harden: every object key recorded here is client-supplied. The upload routes mint safe
    // keys ending in an allowed media/document extension, but this endpoint trusts whatever the
    // caller sends, so re-apply the shared upload policy (isSafeObjectKey + the extension
    // allowlist): refuse a traversal/absolute/odd key, or one pointing at a non-media object
    // (e.g. `.html` / `.js` / extension-less), before it reaches the media table.
    const recordedKeys = [objectKey, ...allVariantsToStore.map((variant) => variant.objectKey)];
    for (const key of recordedKeys) {
      if (!isSafeObjectKey(key) || !hasAllowedObjectKeyExtension(key)) {
        return NextResponse.json({ error: 'Invalid object key.' }, { status: 400 });
      }
    }

    const mediaData: Omit<Media, 'id' | 'created_at' | 'updated_at'> & {
      uploader_id: string;
    } = {
      uploader_id: user.id,
      file_name: payload.fileName,
      object_key: objectKey,
      file_path: objectKey,
      folder,
      file_type: primaryVariant.fileType || 'application/octet-stream',
      size_bytes: primaryVariant.sizeBytes || 0,
      description: computedDescription,
      width: primaryVariant.width || 0,
      height: primaryVariant.height || 0,
      variants: allVariantsToStore as any,
      blur_data_url: payload.blurDataUrl ?? payload.blurDataURL ?? null,
    };

    const { data: newMedia, error } = await supabase
      .from('media')
      .insert(mediaData)
      .select()
      .single();

    if (error) {
      console.error('Error recording media upload:', error);
      return NextResponse.json(
        { error: `Failed to record media: ${error.message}` },
        { status: 500 }
      );
    }

    revalidatePath('/cms/media');

    return NextResponse.json(
      { success: true, data: newMedia as Media },
      { status: 201 }
    );
  } catch (error) {
    console.error('Unexpected error recording media upload:', error);
    return NextResponse.json(
      { error: 'Unexpected error while recording media.' },
      { status: 500 }
    );
  }
}
