import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { readRetailerPortalAccount } from '../../../../lib/affiliates/portal-data';
import { requireRetailer } from '../../../../lib/affiliates/retailer-actor';
import {
  AFFILIATE_UPLOAD_LIMITS,
  AFFILIATE_UPLOAD_MAX_BODY_BYTES,
  AffiliateUploadError,
  affiliateUploadMaxBytes,
  affiliateUploadPrefix,
  buildAffiliateUploadKey,
  consumeAffiliateUploadAllowance,
  countAffiliateUploadObjects,
  deleteAffiliateUploadObject,
  isAffiliateUploadKind,
  isAffiliateUploadStorageConfigured,
  isOwnAffiliateAvatarKey,
  isSameOriginUploadRequest,
  parseAffiliateUploadForm,
  processAffiliateUploadImage,
  putAffiliateUploadObject,
  readAffiliateUploadBody,
  resolveAffiliateUploadUrl,
} from '../../../../lib/affiliates/uploads';

/**
 * `POST /api/affiliates/upload`: a partner's avatar (`kind=avatar`) or storefront image
 * (`kind=image`), multipart with a `file` field.
 *
 * Not under /cms, so the proxy gates nothing here: `requireRetailer()` runs first (session,
 * second factor, RTL role, package, not suspended), then a same-origin check, the per-affiliate
 * throttle, the byte cap, magic-byte sniffing, a sharp decode and a JPEG re-encode
 * (lib/affiliates/uploads.ts). Keys are built on the server from the affiliate id. An avatar
 * replaces `affiliate_profiles.avatar_object_key` (service role) and the previous avatar is
 * deleted only when it is one of this affiliate's own avatar objects and not the one the
 * approved storefront still shows (`published_profile`, deleted by the approval that replaces
 * it). Errors are fixed codes; nothing from storage, sharp or the database is echoed.
 */

// Buffers the body, runs sharp and talks to S3 / Supabase Storage with the server's credentials.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UploadErrorBody = { ok: false; error: string };

function respond(body: Record<string, unknown>, status: number, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } });
}

function refuse(error: string, status: number, extraHeaders: Record<string, string> = {}) {
  return respond({ ok: false, error } satisfies UploadErrorBody, status, extraHeaders);
}

function accessRefusal(error: unknown) {
  switch (error instanceof Error ? error.message : '') {
    case 'Unauthorized':
      return refuse('unauthorized', 401);
    case 'Forbidden':
      return refuse('forbidden', 403);
    case 'Suspended':
      return refuse('suspended', 403);
    case 'PackageInactive':
      return refuse('package_inactive', 403);
    default:
      return refuse('storage_unavailable', 503);
  }
}

function logUploadFailure(stage: string, error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  console.error(`[affiliates] Upload ${stage} failed:`, message);
}

export async function POST(request: NextRequest) {
  let auth: Awaited<ReturnType<typeof requireRetailer>>;
  try {
    auth = await requireRetailer();
  } catch (error) {
    return accessRefusal(error);
  }

  if (!isSameOriginUploadRequest(request.headers, request.url)) return refuse('forbidden', 403);

  const account = readRetailerPortalAccount(auth.actor);
  if (!account) return refuse('forbidden', 403);
  const { profile, page } = account;
  // The reviewer approves the profile and page as submitted: nothing changes while in review.
  if (page?.approval_status === 'PENDING_REVIEW') return refuse('pending_review', 409);

  if (!consumeAffiliateUploadAllowance(profile.id)) {
    return refuse('rate_limited', 429, { 'Retry-After': '3600' });
  }
  if (!isAffiliateUploadStorageConfigured()) return refuse('storage_unavailable', 503);

  try {
    const body = await readAffiliateUploadBody(request, AFFILIATE_UPLOAD_MAX_BODY_BYTES);
    if (!body || body.byteLength === 0) return refuse('invalid_request', 400);

    const form = await parseAffiliateUploadForm(request.headers.get('content-type'), body);
    const kind = form.get('kind');
    const file = form.get('file');
    if (!isAffiliateUploadKind(kind) || !(file instanceof Blob) || file.size === 0) {
      return refuse('invalid_request', 400);
    }
    if (file.size > affiliateUploadMaxBytes(kind)) return refuse('too_large', 413);

    const prefix = affiliateUploadPrefix(kind, profile.id);
    if (!prefix) return refuse('forbidden', 403);

    if (kind === 'image') {
      // Storage-backed limits, shared by every server instance.
      const stored = await countAffiliateUploadObjects(prefix);
      if (stored.total >= AFFILIATE_UPLOAD_LIMITS.maxPageImages) return refuse('image_limit', 409);
      if (stored.lastHour >= AFFILIATE_UPLOAD_LIMITS.uploadsPerHour) {
        return refuse('rate_limited', 429, { 'Retry-After': '3600' });
      }
    }

    const processed = await processAffiliateUploadImage(new Uint8Array(await file.arrayBuffer()), kind);

    const key = buildAffiliateUploadKey(kind, profile.id);
    const src = key ? resolveAffiliateUploadUrl(key) : null;
    if (!key || !src) return refuse('storage_unavailable', 503);

    await putAffiliateUploadObject(key, processed.data, processed.contentType);

    if (kind === 'avatar') {
      const db = auth.supabase as unknown as SupabaseClient<any>;
      const { data, error } = await db
        .from('affiliate_profiles')
        .update({ avatar_object_key: key })
        .eq('id', profile.id)
        .eq('user_id', auth.actor.userId)
        .select('id')
        .maybeSingle();
      if (error || !data) {
        logUploadFailure('avatar save', error ?? 'no row');
        await deleteAffiliateUploadObject(key).catch((cleanupError) => logUploadFailure('orphan cleanup', cleanupError));
        return refuse('upload_failed', 500);
      }

      // The live storefront (its header and Open Graph card) renders the approved snapshot's
      // avatar until the next approval, which deletes it then (lib/affiliates/avatar-cleanup.ts).
      const previous = profile.avatar_object_key;
      const approvedAvatarKey = page?.published_profile?.avatar_object_key ?? null;
      if (previous && previous !== key && previous !== approvedAvatarKey && isOwnAffiliateAvatarKey(previous, profile.id)) {
        await deleteAffiliateUploadObject(previous).catch((cleanupError) =>
          logUploadFailure('previous avatar cleanup', cleanupError),
        );
      }
    }

    return respond({ ok: true, src, width: processed.width, height: processed.height, objectKey: key }, 200);
  } catch (error) {
    if (error instanceof AffiliateUploadError) return refuse(error.code, error.status);
    logUploadFailure('request', error);
    return refuse('upload_failed', 500);
  }
}
