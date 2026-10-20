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
import { enforceCortexAiRequestQuota } from '../../../../../lib/cortex-ai/request-quota';
import {
  safeParseCortexAiModelSelection,
  summarizeCortexAiRoutingError,
} from '@nextblock-cms/cortex';

export const dynamic = 'force-dynamic';

const DYNAMIC_LAYOUT_ENGINE_CACHE_TAG = 'dynamic-layout-engine';

type SupabaseServerClient = ReturnType<typeof createClient>;

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
    const supabase = createClient();
    const access = await requireCmsWriterAccess(supabase);

    if (!access) {
      return jsonError('You do not have permission to build Cortex widgets.', 403);
    }

    // Per-user hourly cap (writer-openrouter-cost-abuse): one request-log row per call,
    // 429 past the role's cap. Runs before anything that can reach a model.
    const quotaResponse = await enforceCortexAiRequestQuota({
      role: access.role,
      route: 'ai/cortex/build-widget',
      userId: access.userId,
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
