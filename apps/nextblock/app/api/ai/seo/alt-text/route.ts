import { NextResponse } from 'next/server';

import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';

import { generateCortexAiAltText } from '@nextblock-cms/cortex';
import {
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
} from '@nextblock-cms/cortex';

import { enforceCortexAiRequestQuota } from '../../../../../lib/cortex-ai/request-quota';
import { z } from '../../../../../lib/zod-config';

export const dynamic = 'force-dynamic';

type SupabaseServerClient = ReturnType<typeof createClient>;

/**
 * The request contract for the alt-text endpoint.
 *
 * `z.strictObject` rather than `z.object`, for the same reason the rest of the
 * Cortex surface uses it: an unknown key is almost always a caller that has drifted
 * from the contract — a stale client still sending `mediaId`, or a hand-rolled
 * fetch that guessed at the field names — and silently discarding it produces a
 * generation that ignores half of what the caller asked for. Rejecting loudly at
 * the boundary turns that into a 400 the developer can actually read.
 *
 * `maxLength` is validated only for shape (a positive integer), not for range. The
 * engine in `ai-vision.ts` deliberately CLAMPS an out-of-range budget into its own
 * 20..1000 bounds instead of throwing, precisely so that a careless call site
 * cannot break a media upload flow; duplicating those bounds here would both
 * contradict that decision and leave two copies of the same numbers free to drift
 * apart.
 */
const altTextRequestSchema = z.strictObject({
  context: z.string().max(2000).optional(),
  imageUrl: z.string().min(1),
  maxLength: z.number().int().positive().optional(),
});

async function requireCmsWriterAccess(supabase: SupabaseServerClient) {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile || !['ADMIN', 'WRITER'].includes(profile.role)) {
    return null;
  }

  // The role rides along because the request quota that follows is per role.
  return { role: profile.role, userId: user.id };
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Return a human-readable reason the supplied image URL cannot be sent to a vision
 * model, or `null` when it is usable.
 *
 * This duplicates a check that `generateCortexAiAltText` also performs, and it does
 * so deliberately. The engine's copy throws, which would surface here as a 500 —
 * the status code that means "the server broke" — when the truth is that the caller
 * sent an unusable value and needs a 400 telling them exactly that. Running the
 * check first gives the common mistake the right status and an actionable message,
 * while the engine keeps its own guard for every other call site.
 *
 * The mistake being guarded against is concrete rather than hypothetical:
 * `resolveMediaUrl()` returns a bare `/${objectKey}` whenever no R2 base URL is
 * configured, so an install that has not finished its media setup hands every
 * caller a site-relative path. Because the Cortex OpenRouter provider is created
 * without `supportedUrls`, the AI SDK does not forward a link to the model — it
 * downloads the image server-side and inlines it as base64 — so a relative path
 * would fail inside the SDK's own fetch, once per model in the fallback chain, with
 * an error that never mentions the actual problem.
 *
 * The scheme test is strict rather than allowlist-based: any absolute URL is
 * acceptable as long as it is http or https, but `file:`, `data:`, and `blob:` are
 * refused. Those are the schemes that would either read the server's own disk or
 * push an unbounded inline payload through every model in the fallback chain.
 */
function describeUnusableImageUrl(imageUrl: string): string | null {
  const trimmed = imageUrl.trim();

  if (!trimmed) {
    return 'An image URL is required to generate alt text.';
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return `Alt text generation needs an absolute http(s) image URL, but received "${trimmed}". A storage key or site-relative path has to be resolved to a publicly fetchable URL first, because the model provider downloads the image server-side rather than following the link.`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Alt text generation needs an http(s) image URL, but received the "${parsed.protocol}" scheme.`;
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = createClient();
    const access = await requireCmsWriterAccess(supabase);

    if (!access) {
      return jsonError('You do not have permission to generate image alt text.', 403);
    }

    // Per-user hourly cap (writer-openrouter-cost-abuse): one request-log row per call,
    // 429 past the role's cap. Runs before anything that can reach a model.
    const quotaResponse = await enforceCortexAiRequestQuota({
      role: access.role,
      route: 'ai/seo/alt-text',
      userId: access.userId,
    });

    if (quotaResponse) {
      return quotaResponse;
    }

    // The same package gate as every other /api/ai/* route (docs/08 follow-up #6).
    // Alt-text generation is a paid Cortex AI feature that burns either the
    // operator's own OpenRouter credit or the shared house key, so an install
    // without an active `cortex-ai` activation must not reach a model at all. The
    // package id is `cortex-ai`; `ai` is not a package id anywhere in this system.
    const isCortexAiActive = await verifyPackageOnline('cortex-ai');

    if (!isCortexAiActive) {
      return jsonError('NextBlock Cortex AI is not active for this workspace.', 403);
    }

    const body = await request.json().catch(() => null);
    const parsedRequest = altTextRequestSchema.safeParse(body);

    if (!parsedRequest.success) {
      return jsonError('Invalid Cortex AI alt text request.', 400);
    }

    const unusableImageUrlReason = describeUnusableImageUrl(parsedRequest.data.imageUrl);

    if (unusableImageUrlReason) {
      return jsonError(unusableImageUrlReason, 400);
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

    // `generateCortexAiAltText` takes a requested model id rather than a whole
    // stored selection, because its vision routing policy has to decide for itself
    // whether an id is plausibly multimodal before it will route an image to it.
    // The header is still parsed through `safeParseCortexAiModelSelection` so that
    // a malformed value is discarded rather than forwarded as a bogus id, and the
    // id is only honoured alongside the sandbox key so that a caller-supplied model
    // choice can never be applied to the operator's own credential.
    const result = await generateCortexAiAltText({
      apiKey: sandboxKey || undefined,
      context: parsedRequest.data.context,
      imageUrl: parsedRequest.data.imageUrl,
      maxLength: parsedRequest.data.maxLength,
      modelId: sandboxKey && modelSelection ? modelSelection.modelId : undefined,
    });

    return NextResponse.json(
      {
        altText: result.altText,
        credentialSource: result.credentialSource,
        modelId: result.modelId,
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
        '[Cortex AI] Failed to generate alt text after model attempts:',
        JSON.stringify((error as { attempts: unknown }).attempts, null, 2)
      );
    }

    console.error('[Cortex AI] Failed to generate alt text:', error);
    return jsonError(
      summarizeCortexAiRoutingError(error, 'Failed to generate image alt text.'),
      500
    );
  }
}
