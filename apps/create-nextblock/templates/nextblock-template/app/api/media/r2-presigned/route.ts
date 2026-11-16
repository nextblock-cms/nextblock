import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@nextblock-cms/db/server';

import { getCmsActor, isCmsStaffRole } from '../../../../lib/auth/cms-actor';
import {
  createR2PresignedUpload,
  R2PresignedUploadError,
  validateR2PresignedUploadPayload,
} from '../../../../lib/custom-block-r2-upload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    // Staff (ADMIN / WRITER) past their enrolled second factor, before anything is read or signed:
    // the URL this hands out is a bearer token for a key in the deployment's bucket, and a route
    // handler never passes the CMS layout's 2FA redirect. Until 2026-11-14 the role came from a
    // cookie-client read, so a password alone (the first factor) was enough.
    const actor = await getCmsActor();
    if (!actor) {
      // getCmsActor() is null without a session and while an enrolled second factor is pending.
      // The refusal stands either way; this only picks the answer.
      return (await hasSignedInUser())
        ? NextResponse.json({ error: SECOND_FACTOR_MESSAGE }, { status: 403 })
        : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isCmsStaffRole(actor.role)) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions' },
        { status: 403 }
      );
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
    }
    // Requires the declared size (10 MB at most), which the upload URL is then signed for, and
    // refuses a folder inside the partner upload namespaces.
    const payload = validateR2PresignedUploadPayload(body);
    const upload = await createR2PresignedUpload(payload, { userId: actor.userId });

    return NextResponse.json(upload, { status: 200 });
  } catch (error) {
    if (error instanceof R2PresignedUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('[R2 Presigned Upload] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Failed to generate upload URL.' },
      { status: 500 }
    );
  }
}
