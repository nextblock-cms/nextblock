import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@nextblock-cms/db/server';
import type { Database } from '@nextblock-cms/db';
import { getCmsActor, isCmsStaffRole } from '../../../../lib/auth/cms-actor';
import {
  isAcceptableClientObjectKey,
  isPartnerUploadKey,
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

const SECOND_FACTOR_MESSAGE = 'Complete two-factor verification, then try again.';

/** True when the request carries a signed-in user (to word a refusal; never to grant anything). */
async function hasSignedInUser(): Promise<boolean> {
  try {
    const {
      data: { user },
    } = await createClient().auth.getUser();
    return Boolean(user);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    // Staff (ADMIN / WRITER) past their enrolled second factor, before the body is read, like the
    // other staff upload routes: a route handler never passes the CMS layout's 2FA redirect, and
    // until 2026-11-14 a cookie-client role read let a staff password alone (the first factor)
    // record media rows. The row is still written with the cookie client below, so
    // media_insert_policy applies as well.
    const actor = await getCmsActor();
    if (!actor) {
      // getCmsActor() is null without a session and while an enrolled second factor is pending.
      // The refusal stands either way; this only picks the answer.
      return (await hasSignedInUser())
        ? NextResponse.json({ error: SECOND_FACTOR_MESSAGE }, { status: 403 })
        : NextResponse.json({ error: 'User not authenticated.' }, { status: 401 });
    }
    if (!isCmsStaffRole(actor.role)) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions to record media.' },
        { status: 403 }
      );
    }

    const payload = (await request.json()) as RecordMediaPayload;

    if (!payload.fileName || !payload.r2OriginalKey) {
      return NextResponse.json(
        { error: 'Missing required media payload fields.' },
        { status: 400 }
      );
    }

    // The uploaded original's key is client-supplied too, and meets the same policy as every key
    // recorded below, whether or not it ends up on the row (it is the primary only when no variant
    // names one); leading slashes go first, as they do for the primary. Until 2026-11-14 only the
    // partner check further down saw it when a variant was the primary, so
    // `uploads/<folder>/victim.png?.png` was accepted next to valid variants.
    const originalKey: unknown = payload.r2OriginalKey;
    if (
      !isAcceptableClientObjectKey(
        typeof originalKey === 'string' ? originalKey.replace(/^\/+/, '') : originalKey,
        { requireAllowedExtension: true }
      )
    ) {
      return NextResponse.json({ error: 'Invalid object key.' }, { status: 400 });
    }

    const supabase = createClient();

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
    // caller sends, so re-apply the shared policy for a key a client hands back
    // (isAcceptableClientObjectKey): refuse a traversal/absolute/odd key, one with a character the
    // upload routes never mint (any '%': storage may decode '%61ffiliates/pages/...' into a
    // partner's prefix), a partner upload, or one pointing at a non-media object (e.g. `.html` /
    // `.js` / extension-less), before it reaches the media table.
    const recordedKeys = [objectKey, ...allVariantsToStore.map((variant) => variant.objectKey)];
    for (const key of recordedKeys) {
      if (!isAcceptableClientObjectKey(key, { requireAllowedExtension: true })) {
        return NextResponse.json({ error: 'Invalid object key.' }, { status: 400 });
      }
    }

    // Partner uploads (affiliates/avatars/… and affiliates/pages/…, PARTNER_UPLOAD_NAMESPACES in
    // lib/storage/upload-policy)
    // never become media rows, whichever field names them, recorded or not: the /cms/media delete
    // and move remove the objects their row lists, so a "decoy" row naming a partner's avatar would
    // let a WRITER delete it (the 2026-10-21 decoy-row hole, for keys outside the media library).
    const namedKeys = [
      payload.r2OriginalKey,
      payload.originalImageDetails?.objectKey,
      ...recordedKeys,
      ...variants.map((variant) => variant?.objectKey),
    ];
    if (namedKeys.some(isPartnerUploadKey)) {
      return NextResponse.json({ error: 'Invalid object key.' }, { status: 400 });
    }

    const mediaData: Omit<Media, 'id' | 'created_at' | 'updated_at'> & {
      uploader_id: string;
    } = {
      uploader_id: actor.userId,
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
