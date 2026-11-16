import { NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';

import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';

import { generateCortexWidgetDefinition } from '@nextblock-cms/cortex';
import {
  cortexWidgetBuildRequestSchema,
} from '@nextblock-cms/cortex';
import {
  CortexWidgetRegistryInsertError,
  insertCortexWidgetDefinition,
} from '@nextblock-cms/cortex';
import {
  CUSTOM_BLOCK_DEFINITIONS_CACHE_TAG,
  getCustomBlockDefinitionCacheTag,
} from '../../../../../lib/custom-block-definitions';
import { getCmsActor, isCmsStaffRole } from '../../../../../lib/auth/cms-actor';
import { enforceCortexAiRequestQuota } from '../../../../../lib/cortex-ai/request-quota';
import {
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
} from '@nextblock-cms/cortex';

export const dynamic = 'force-dynamic';

const DYNAMIC_LAYOUT_ENGINE_CACHE_TAG = 'dynamic-layout-engine';

const PERMISSION_MESSAGE = 'You do not have permission to build Cortex widgets.';
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

function getDynamicLayoutDefinitionCacheTag(idOrSlug: string) {
  return `${DYNAMIC_LAYOUT_ENGINE_CACHE_TAG}:definition:${idOrSlug}`;
}

function revalidateCortexWidgetDefinition(definition: { id: string; slug: string }) {
  revalidateTag(CUSTOM_BLOCK_DEFINITIONS_CACHE_TAG, 'max');
  revalidateTag(getCustomBlockDefinitionCacheTag(definition.id), 'max');
  revalidateTag(getCustomBlockDefinitionCacheTag(definition.slug), 'max');
  revalidateTag(DYNAMIC_LAYOUT_ENGINE_CACHE_TAG, 'max');
  revalidateTag(getDynamicLayoutDefinitionCacheTag(definition.id), 'max');
  revalidateTag(getDynamicLayoutDefinitionCacheTag(definition.slug), 'max');
  revalidatePath('/cms/blocks');
  revalidatePath('/cms/custom-blocks');
}

export async function POST(request: Request) {
  try {
    // ADMIN or WRITER past their enrolled second factor, before the quota, the package check or
    // the body: a route handler never passes the CMS layout's 2FA redirect, and until 2026-11-14 a
    // cookie-client role read let a staff password alone (the first factor) spend the request
    // quota (recorded with the service role) and the operator's model key, and register a widget.
    // The actor's role rides along because the quota is per role.
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

    // The widget definition is written with the cookie client below, so the policies on
    // custom_block_definitions apply as well.
    const supabase = createClient();

    // Per-user hourly cap (writer-openrouter-cost-abuse): one request-log row per call,
    // 429 past the role's cap. Runs before anything that can reach a model.
    const quotaResponse = await enforceCortexAiRequestQuota({
      role: actor.role,
      route: 'ai/cortex/build-widget',
      userId: actor.userId,
    });

    if (quotaResponse) {
      return quotaResponse;
    }

    const isCortexAiActive = await verifyPackageOnline('cortex-ai');

    if (!isCortexAiActive) {
      return jsonError('NextBlock Cortex AI is not active for this workspace.', 403);
    }

    const body = await request.json().catch(() => null);
    const parsedRequest = cortexWidgetBuildRequestSchema.safeParse(body);

    if (!parsedRequest.success) {
      return jsonError('Invalid Cortex widget build request.', 400);
    }

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

    const generation = await generateCortexWidgetDefinition({
      ...parsedRequest.data,
      apiKey: sandboxKey || undefined,
      modelSelection: sandboxKey && modelSelection ? modelSelection : undefined,
    });
    const definition = await insertCortexWidgetDefinition(supabase, generation.definition);

    revalidateCortexWidgetDefinition(definition);

    return NextResponse.json(
      {
        attempts: generation.attempts,
        credentialSource: generation.credentialSource,
        definition,
        modelId: generation.modelId,
        success: true,
      },
      {
        headers: {
          'x-cortex-ai-credential-source': generation.credentialSource,
          'x-cortex-ai-model': generation.modelId,
        },
      }
    );
  } catch (error) {
    if (error instanceof CortexWidgetRegistryInsertError) {
      return jsonError(error.message, error.status);
    }

    if (error && typeof error === 'object' && 'attempts' in error) {
      console.error(
        '[Cortex AI] Failed to build widget after model attempts:',
        JSON.stringify((error as { attempts: unknown }).attempts, null, 2)
      );
    }

    console.error('[Cortex AI] Failed to build widget:', error);
    return jsonError(
      summarizeCortexAiRoutingError(error, 'Failed to build Cortex widget.'),
      500
    );
  }
}
