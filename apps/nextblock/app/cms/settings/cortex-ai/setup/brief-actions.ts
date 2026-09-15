'use server';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { executeSaveSiteBrief, readCortexSiteBrief, type CortexSiteBrief } from '@nextblock-cms/cortex';

import {
  siteBriefFormSchema,
  siteBriefFormToBrief,
  type SiteBriefFormValues,
} from '../../../../../lib/cortex-ai/site-brief-form';
import { requireAdminSupabaseClient } from '../require-admin';

/**
 * Persist the site-brief FORM (the wizard's discovery step) as the Cortex site brief.
 *
 * Lives apart from `./actions.ts` on purpose: that file revalidates the CMS layout
 * after every save, and a revalidation here would re-render the wizard route in the
 * middle of the flow. Nothing reads the brief through a cached render anyway — the
 * chat route reads it fresh on every request — so no revalidatePath is needed.
 */
export type SaveSiteBriefFromFormResult =
  | { success: true; brief: CortexSiteBrief }
  | { success: false; message: string; fieldErrors?: Record<string, string> };

export async function saveSiteBriefFromFormAction(
  values: SiteBriefFormValues
): Promise<SaveSiteBriefFromFormResult> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return {
      message: 'The shared sandbox cannot save a site brief. Tell Cortex about your site in the chat instead.',
      success: false,
    };
  }

  try {
    await requireAdminSupabaseClient();
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'You do not have permission to save the site brief.',
      success: false,
    };
  }

  const parsed = siteBriefFormSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }

    return {
      fieldErrors,
      message: 'Some answers need a second look.',
      success: false,
    };
  }

  try {
    const supabase = getServiceRoleSupabaseClient();
    // "Replace" is what the form means for every field it can show, but a brief that
    // a chat interview (or a finished build) wrote carries fields the form has no
    // input for; those are carried over from the saved brief, not silently dropped.
    const existing = await readCortexSiteBrief(supabase);
    const result = await executeSaveSiteBrief(
      { brief: siteBriefFormToBrief(parsed.data, existing), mode: 'replace' },
      { supabase }
    );

    return { brief: result.brief, success: true };
  } catch (error) {
    console.error('[Cortex AI] Could not save the site brief from the form:', error);
    return {
      message: error instanceof Error ? error.message : 'Could not save the site brief.',
      success: false,
    };
  }
}
