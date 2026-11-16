import { NextResponse } from 'next/server';

import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';

import {
  generateEditorHtmlFragment,
  generateEditorBlocksRequestSchema,
} from '@nextblock-cms/cortex';
import {
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
} from '@nextblock-cms/cortex';

import { getCmsActor, isCmsStaffRole } from '../../../../lib/auth/cms-actor';
import { enforceCortexAiRequestQuota } from '../../../../lib/cortex-ai/request-quota';

export const dynamic = 'force-dynamic';

const PERMISSION_MESSAGE = 'You do not have permission to generate editor blocks.';
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
    // along because the quota is per role (WRITER 60/h, ADMIN 300/h).
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
      route: 'ai/generate-blocks',
      userId: actor.userId,
    });

    if (quotaResponse) {
      return quotaResponse;
    }

    // The same package gate the three sibling AI routes already have (docs/08 follow-up
    // #6). Block generation spends the operator's OpenRouter credit or the shared house
    // key, so an install without an active `cortex-ai` activation must not reach a model.
    const isCortexAiActive = await verifyPackageOnline('cortex-ai');

    if (!isCortexAiActive) {
      return jsonError('NextBlock Cortex AI is not active for this workspace.', 403);
    }

    const body = await request.json().catch(() => null);
    const parsedRequest = generateEditorBlocksRequestSchema.safeParse(body);

    if (!parsedRequest.success) {
      return jsonError('Invalid Cortex AI block generation request.', 400);
    }

    const sandboxKey = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? request.headers.get('x-sandbox-openrouter-key') : null;
    const sandboxModelRaw = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' ? request.headers.get('x-sandbox-openrouter-model') : null;
    
    let modelSelection = null;
    if (sandboxModelRaw) {
      try {
        modelSelection = safeParseCortexAiModelSelection(JSON.parse(sandboxModelRaw));
      } catch {
        // Ignore parse errors from headers
      }
    }

    const result = await generateEditorHtmlFragment({
      ...parsedRequest.data,
      apiKey: sandboxKey || undefined,
      modelSelection: sandboxKey && modelSelection ? modelSelection : undefined,
    });

    return NextResponse.json({
      credentialSource: result.credentialSource,
      html: result.html,
      modelId: result.modelId,
    }, {
      headers: {
        'x-cortex-ai-credential-source': result.credentialSource,
        'x-cortex-ai-model': result.modelId,
      },
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'attempts' in error) {
      console.error(
        '[Cortex AI] Failed to generate editor HTML after model attempts:',
        JSON.stringify((error as { attempts: unknown }).attempts, null, 2)
      );
    }
    console.error('[Cortex AI] Failed to generate editor HTML:', error);
    return jsonError(
      summarizeCortexAiRoutingError(error, 'Failed to generate editor HTML.'),
      500
    );
  }
}
