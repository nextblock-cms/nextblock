// app/cms/settings/site-scripts/actions.ts
'use server';

import 'server-only';

import { createClient } from '@nextblock-cms/db/server';
import { revalidatePath, revalidateTag } from 'next/cache';

import type { Json } from '@nextblock-cms/db';
import { requireCmsAdmin, type ServiceRoleClient } from '../../../../lib/auth/cms-actor';
import type { SettingsActionResult } from '../../../../lib/cms/action-result';
import {
  isSiteScriptLoadStrategy,
  isSiteScriptPlacement,
  SITE_SCRIPT_COLUMNS,
  type SiteScript,
} from '../../../../lib/site-scripts/types';
import {
  buildSiteScriptSnapshot,
  SITE_SCRIPT_REVISION_COLUMNS,
  type SiteScriptRevision,
  type SiteScriptRevisionType,
} from '../../../../lib/site-scripts/revisions';

type SupabaseLike = ServiceRoleClient;

/**
 * Append one row to the audit log.
 *
 * Never throws and never blocks the change it describes: by the time this runs the
 * script has already been written, so failing here would report an error for an edit
 * that actually happened. A missing log line is surfaced in the server log instead.
 */
async function recordRevision(
  supabase: SupabaseLike,
  input: {
    actorUserId: string | null;
    revisionType: SiteScriptRevisionType;
    scriptId: string | null;
    snapshot: Parameters<typeof buildSiteScriptSnapshot>[0];
    summary?: string;
  }
): Promise<void> {
  const snapshot = buildSiteScriptSnapshot(input.snapshot);

  try {
    const { error } = await supabase.from('site_script_revisions').insert({
      actor_user_id: input.actorUserId,
      revision_type: input.revisionType,
      script_id: input.scriptId,
      script_name: snapshot.name,
      snapshot: snapshot as unknown as Json,
      source: 'cms',
      summary: input.summary ?? null,
    });

    if (error) {
      console.error('Site scripts: revision not recorded —', error.message);
    }
  } catch (error) {
    console.error('Site scripts: revision not recorded —', error);
  }
}

/** Read the current row so an update or delete can be logged with its prior state. */
async function readScript(supabase: SupabaseLike, id: string) {
  const { data } = await supabase.from('site_scripts').select(SITE_SCRIPT_COLUMNS).eq('id', id).maybeSingle();

  return data as SiteScript | null;
}

/**
 * Site scripts run arbitrary JavaScript on every page, /cms included, so unlike most content
 * these are ADMIN-only — a WRITER who can publish a page must not also be able to ship code
 * to every visitor.
 *
 * Writes go through the service-role client after this check: migration 02028 puts the ADMIN
 * write policies of site_scripts and site_script_revisions behind public.is_admin_mfa(), which
 * an admin on a "remember this device" session (aal1) or on the email second factor (never
 * aal2) does not pass over PostgREST. requireCmsAdmin() is the authorization boundary: it reads
 * the caller's own role and refuses a session whose second factor is still pending.
 */
async function requireAdmin(): Promise<
  { supabase: SupabaseLike; userId: string; error: null } | { supabase: null; userId: null; error: string }
> {
  try {
    const { supabase, userId } = await requireCmsAdmin();
    return { supabase, userId, error: null };
  } catch (error) {
    return {
      supabase: null,
      userId: null,
      error:
        error instanceof Error && error.message === 'Forbidden'
          ? 'Only administrators can manage site scripts.'
          : 'You must be logged in to manage site scripts.',
    };
  }
}

function revalidateSiteScripts() {
  revalidateTag('public-layout-site-scripts', 'max');
  revalidatePath('/', 'layout');
  revalidatePath('/cms/settings/site-scripts');
}

export async function getSiteScripts(): Promise<SiteScript[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('site_scripts')
    .select(SITE_SCRIPT_COLUMNS)
    .order('sort_order');

  if (error || !data) return [];

  return data as SiteScript[];
}

export interface SiteScriptInput {
  name: string;
  description?: string | null;
  code?: string;
  src?: string | null;
  placement?: string;
  load_strategy?: string;
  is_active?: boolean;
  sort_order?: number;
}

/** Normalise and validate, mirroring the table's CHECK constraints. */
function buildPayload(input: SiteScriptInput): Record<string, unknown> | { error: string } {
  const name = (input.name || '').trim();

  if (!name) {
    return { error: 'A name is required.' };
  }

  const src = (input.src || '').trim();

  if (src && !/^https:\/\//i.test(src)) {
    return { error: 'An external script URL must start with https://.' };
  }

  const code = input.code ?? '';

  if (!src && !code.trim()) {
    return { error: 'Add some JavaScript, or an external script URL.' };
  }

  const placement = isSiteScriptPlacement(input.placement) ? input.placement : 'body_end';
  const loadStrategy = isSiteScriptLoadStrategy(input.load_strategy) ? input.load_strategy : 'default';

  return {
    code,
    description: (input.description || '').trim() || null,
    is_active: Boolean(input.is_active),
    load_strategy: loadStrategy,
    name,
    placement,
    sort_order: Number.isFinite(input.sort_order) ? Number(input.sort_order) : 0,
    src: src || null,
  };
}

export async function createSiteScript(input: SiteScriptInput): Promise<SettingsActionResult> {
  const auth = await requireAdmin();
  if (auth.error !== null) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  const payload = buildPayload(input);
  if ('error' in payload) return { ok: false, error: payload.error as string };

  const { data, error } = await supabase
    .from('site_scripts')
    .insert(payload as never)
    .select('id')
    .single();

  if (error) {
    return { ok: false, error: `Failed to create the script: ${error.message}` };
  }

  await recordRevision(supabase, {
    actorUserId: userId,
    revisionType: 'create',
    scriptId: (data as { id: string } | null)?.id ?? null,
    snapshot: payload,
  });

  revalidateSiteScripts();
  return { ok: true, message: 'Script created.' };
}

export async function updateSiteScript(
  id: string,
  input: SiteScriptInput
): Promise<SettingsActionResult> {
  const auth = await requireAdmin();
  if (auth.error !== null) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  const payload = buildPayload(input);
  if ('error' in payload) return { ok: false, error: payload.error as string };

  // Snapshot the PRIOR state: reverting means going back to what it was before
  // this edit, so that is the state worth keeping.
  const previous = await readScript(supabase, id);

  const { error } = await supabase.from('site_scripts').update(payload as never).eq('id', id);

  if (error) {
    return { ok: false, error: `Failed to update the script: ${error.message}` };
  }

  if (previous) {
    await recordRevision(supabase, {
      actorUserId: userId,
      revisionType: 'update',
      scriptId: id,
      snapshot: previous,
      summary: `Edited “${previous.name}”`,
    });
  }

  revalidateSiteScripts();
  return { ok: true, message: 'Script updated.' };
}

export async function setSiteScriptActive(
  id: string,
  isActive: boolean
): Promise<SettingsActionResult> {
  const auth = await requireAdmin();
  if (auth.error !== null) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  const previous = await readScript(supabase, id);

  const { error } = await supabase.from('site_scripts').update({ is_active: isActive }).eq('id', id);

  if (error) {
    return { ok: false, error: `Failed to change the script state: ${error.message}` };
  }

  if (previous) {
    await recordRevision(supabase, {
      actorUserId: userId,
      revisionType: 'update',
      scriptId: id,
      snapshot: previous,
      summary: `${isActive ? 'Enabled' : 'Disabled'} “${previous.name}”`,
    });
  }

  revalidateSiteScripts();
  return { ok: true, message: isActive ? 'Script enabled.' : 'Script disabled.' };
}

export async function deleteSiteScript(id: string): Promise<SettingsActionResult> {
  const auth = await requireAdmin();
  if (auth.error !== null) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  // Read before deleting: the snapshot is what makes the delete undoable.
  const previous = await readScript(supabase, id);

  const { error } = await supabase.from('site_scripts').delete().eq('id', id);

  if (error) {
    return { ok: false, error: `Failed to delete the script: ${error.message}` };
  }

  if (previous) {
    await recordRevision(supabase, {
      actorUserId: userId,
      revisionType: 'delete',
      scriptId: id,
      snapshot: previous,
      summary: `Deleted “${previous.name}”`,
    });
  }

  revalidateSiteScripts();
  return { ok: true, message: 'Script deleted. You can restore it from the history.' };
}

export async function getSiteScriptRevisions(limit = 100): Promise<SiteScriptRevision[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('site_script_revisions')
    .select(SITE_SCRIPT_REVISION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data as unknown as SiteScriptRevision[];
}

/**
 * Restore a script to a logged revision.
 *
 * Works for a deleted script too: the row is recreated from the snapshot. The
 * restore itself is logged as a 'revert' revision rather than removing history, so
 * the audit trail stays append-only and the restore is itself undoable.
 */
export async function revertSiteScript(revisionId: string): Promise<SettingsActionResult> {
  const auth = await requireAdmin();
  if (auth.error !== null) return { ok: false, error: auth.error };
  const { supabase, userId } = auth;

  const { data: revisionRow, error: revisionError } = await supabase
    .from('site_script_revisions')
    .select(SITE_SCRIPT_REVISION_COLUMNS)
    .eq('id', revisionId)
    .maybeSingle();

  if (revisionError || !revisionRow) {
    return { ok: false, error: 'That revision no longer exists.' };
  }

  const revision = revisionRow as unknown as SiteScriptRevision;
  const snapshot = buildSiteScriptSnapshot(revision.snapshot as unknown as Record<string, unknown>);

  const existing = revision.script_id ? await readScript(supabase, revision.script_id) : null;

  if (existing) {
    const { error } = await supabase
      .from('site_scripts')
      .update(snapshot as never)
      .eq('id', revision.script_id as string);

    if (error) {
      return { ok: false, error: `Failed to restore the script: ${error.message}` };
    }
  } else {
    const { error } = await supabase.from('site_scripts').insert(snapshot as never);

    if (error) {
      return { ok: false, error: `Failed to recreate the script: ${error.message}` };
    }
  }

  await recordRevision(supabase, {
    actorUserId: userId,
    revisionType: 'revert',
    scriptId: revision.script_id,
    snapshot,
    summary: `Restored “${snapshot.name}” to the version from ${new Date(
      revision.created_at
    ).toISOString()}`,
  });

  revalidateSiteScripts();
  return { ok: true, message: existing ? 'Script restored.' : 'Script recreated from history.' };
}
