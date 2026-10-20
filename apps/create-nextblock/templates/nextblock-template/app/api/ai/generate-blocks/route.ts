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

import { enforceCortexAiRequestQuota } from '../../../../lib/cortex-ai/request-quota';

export const dynamic = 'force-dynamic';

/**
 * ADMIN or WRITER from the cookie session. Returns the role as well as the id because the
 * request quota that follows is per role (WRITER 60/h, ADMIN 300/h).
 */
async function requireCmsEditorAccess() {
  const supabase = createClient();
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

  if (profileError || !profile || (profile.role !== 'ADMIN' && profile.role !== 'WRITER')) {
    return null;
  }

  return { role: profile.role, userId: user.id };
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const access = await requireCmsEditorAccess();

    if (!access) {
      return jsonError('You do not have permission to generate editor blocks.', 403);
    }

    // Per-user hourly cap (writer-openrouter-cost-abuse): one request-log row per call,
    // 429 past the role's cap. Runs before anything that can reach a model.
    const quotaResponse = await enforceCortexAiRequestQuota({
      role: access.role,
      route: 'ai/generate-blocks',
      userId: access.userId,
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
