import { NextResponse } from 'next/server';

import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';

import { generateCortexAiSeoMetadata } from '@nextblock-cms/cortex';
import {
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
} from '@nextblock-cms/cortex';

import { getCmsActor, isCmsStaffRole } from '../../../../../lib/auth/cms-actor';
import { enforceCortexAiRequestQuota } from '../../../../../lib/cortex-ai/request-quota';
import { z } from '../../../../../lib/zod-config';

export const dynamic = 'force-dynamic';

/**
 * How much page copy this endpoint will accept in one request.
 *
 * The engine truncates the content to `CORTEX_AI_SEO_METADATA_CONTENT_BUDGET`
 * (6000 characters) before it ever reaches a model, so anything beyond that is
 * discarded rather than summarised. This ceiling is therefore not a content rule —
 * it is a request-body bound, set far above the engine's budget so that a genuinely
 * long post is never rejected with a confusing 400, but low enough that a runaway
 * client cannot push megabytes of HTML through the JSON parser on every keystroke
 * of an editor that generates metadata as you type.
 */
const SEO_METADATA_CONTENT_REQUEST_LIMIT = 200_000;

/**
 * The request contract for the metadata endpoint.
 *
 * Strict, for the reason every Cortex request schema is strict: an unrecognised key
 * means the caller and this route disagree about the contract, and the failure mode
 * of quietly dropping it is a generation that ignored the focus keyword or the
 * locale the caller thought it had supplied. A 400 naming the mismatch is far
 * cheaper to debug than metadata that is merely subtly wrong.
 *
 * Only `content` is required. Everything else is a hint the engine folds into the
 * prompt when present and omits entirely when absent, which is why each optional
 * field is bounded but never given a minimum beyond one character — an empty string
 * from a form field that the user left blank should not fail the whole request, and
 * the engine's own `?.trim() || null` normalisation already treats blank as absent.
 */
const seoMetadataRequestSchema = z.strictObject({
  content: z.string().min(1).max(SEO_METADATA_CONTENT_REQUEST_LIMIT),
  focusKeyword: z.string().max(200).optional(),
  locale: z.string().max(64).optional(),
  siteTitle: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
});

const PERMISSION_MESSAGE = 'You do not have permission to generate SEO metadata.';
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

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    // ADMIN or WRITER past their enrolled second factor, before the quota, the package check or
    // the body: a route handler never passes the CMS layout's 2FA redirect, and until 2026-11-14 a
    // cookie-client role read let a staff password alone (the first factor) spend the request
    // quota (recorded with the service role) and the operator's model key. The actor's role rides
    // along because the quota is per role.
    const actor = await getCmsActor();
    if (!actor) {
      // getCmsActor() is null without a session and while an enrolled second factor is pending.
      // The refusal stands either way; this only picks the answer.
      return (await hasSignedInUser())
        ? jsonError(SECOND_FACTOR_MESSAGE, 403)
        : jsonError(PERMISSION_MESSAGE, 401);
    }
    if (!isCmsStaffRole(actor.role)) {
      return jsonError(PERMISSION_MESSAGE, 403);
    }

    // Per-user hourly cap (writer-openrouter-cost-abuse): one request-log row per call,
    // 429 past the role's cap. Runs before anything that can reach a model.
    const quotaResponse = await enforceCortexAiRequestQuota({
      role: actor.role,
      route: 'ai/seo/metadata',
      userId: actor.userId,
    });

    if (quotaResponse) {
      return quotaResponse;
    }

    // The same package gate as every other /api/ai/* route (docs/08 follow-up #6).
    // Metadata generation is a paid Cortex AI feature that burns either the
    // operator's own OpenRouter credit or the shared house key, so an install
    // without an active `cortex-ai` activation must not reach a model at all. The
    // package id is `cortex-ai`; `ai` is not a package id anywhere in this system.
    const isCortexAiActive = await verifyPackageOnline('cortex-ai');

    if (!isCortexAiActive) {
      return jsonError('NextBlock Cortex AI is not active for this workspace.', 403);
    }

    const body = await request.json().catch(() => null);
    const parsedRequest = seoMetadataRequestSchema.safeParse(body);

    if (!parsedRequest.success) {
      return jsonError('Invalid Cortex AI SEO metadata request.', 400);
    }

    // Sandbox installs have no server-side OpenRouter credential at all: the demo
    // visitor pastes their own key into the browser, it lives in localStorage under
    // `cortex_ai_sandbox_openrouter_api_key`, and it rides along on these headers.
    // The env guard matters as much as the headers do — outside a sandbox the
    // server must never accept a caller-supplied credential, because that would let
    // any authenticated writer redirect generation through a key the operator never
    // chose.
    const sandboxKey =
      process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'
        ? request.headers.get('x-sandbox-openrouter-key')
        : null;
    const sandboxModelRaw =
      process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'
        ? request.headers.get('x-sandbox-openrouter-model')
        : null;

    let modelSelection = null;
    if (sandboxModelRaw) {
      try {
        modelSelection = safeParseCortexAiModelSelection(JSON.parse(sandboxModelRaw));
      } catch {
        // Ignore malformed sandbox model headers.
      }
    }

    // `generateCortexAiSeoMetadata` accepts a requested model id rather than a
    // whole stored selection; the header is still parsed through
    // `safeParseCortexAiModelSelection` so that a malformed value is discarded
    // instead of being forwarded as a bogus id. Note that the ordinary text routing
    // policy will IGNORE the requested id whenever the credential came from the
    // environment, which is exactly the intended behaviour here: a model choice is
    // only ever honoured when it arrives with the key that will pay for it.
    const result = await generateCortexAiSeoMetadata({
      apiKey: sandboxKey || undefined,
      content: parsedRequest.data.content,
      focusKeyword: parsedRequest.data.focusKeyword,
      locale: parsedRequest.data.locale,
      modelId: sandboxKey && modelSelection ? modelSelection.modelId : undefined,
      siteTitle: parsedRequest.data.siteTitle,
      title: parsedRequest.data.title,
    });

    return NextResponse.json(
      {
        credentialSource: result.credentialSource,
        metaDescription: result.metaDescription,
        metaTitle: result.metaTitle,
        modelId: result.modelId,
        ogDescription: result.ogDescription,
        ogTitle: result.ogTitle,
      },
      {
        headers: {
          'x-cortex-ai-credential-source': result.credentialSource,
          'x-cortex-ai-model': result.modelId,
        },
      }
    );
  } catch (error) {
    // A CortexAiRoutingError is recognised STRUCTURALLY rather than with
    // `instanceof`. The class is defined in @nextblock-cms/cortex, which resolves to
    // library source inside this monorepo but to a published package in a
    // standalone install; when both shapes end up in one bundle the two class
    // identities are not the same object and `instanceof` silently returns false,
    // swallowing the per-model attempt log that is the only useful diagnostic for a
    // routing failure.
    if (error && typeof error === 'object' && 'attempts' in error) {
      console.error(
        '[Cortex AI] Failed to generate SEO metadata after model attempts:',
        JSON.stringify((error as { attempts: unknown }).attempts, null, 2)
      );
    }

    console.error('[Cortex AI] Failed to generate SEO metadata:', error);
    return jsonError(
      summarizeCortexAiRoutingError(error, 'Failed to generate SEO metadata.'),
      500
    );
  }
}
