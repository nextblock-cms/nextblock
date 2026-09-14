// app/cms/settings/seo/actions.ts
'use server';

import { revalidatePath } from 'next/cache';

import {
  normalizeRedirectPath,
  normalizeRobotsSettings,
  validateRedirectRule,
  type RedirectRule,
  type RobotsSettings,
} from '@nextblock-cms/utils/seo';

import type { SettingsActionResult } from '../../../../lib/cms/action-result';
import { isSchemaMissingError, CMS_REDIRECTS_TABLE } from '../../../../lib/seo/redirect-store';
import { z } from '../../../../lib/zod-config';
import { toRedirectRules, type CmsRedirect, type RedirectInput } from './mappers';
import { requireAdminSupabaseClient } from './require-admin';

const SEO_SETTINGS_PATH = '/cms/settings/seo';

/** The `site_settings` row robots directives live in, seeded by migration 00000000000030. */
const ROBOTS_SETTINGS_KEY = 'seo_robots_settings';

/** Every column the admin list needs; the proxy deliberately selects fewer. */
const REDIRECT_ADMIN_COLUMNS =
  'id, source_path, destination_path, status_code, is_active, created_at, updated_at';

/**
 * Which caches a change here has to reach.
 *
 * The neighbouring settings actions invalidate a *tagged* public read — `updateTag`
 * in logos/languages/extra-translations, `revalidateTag(tag, 'max')` in
 * site-scripts and themes — because each of those feeds a cached component in the
 * public layout. Nothing on this screen has such a tag, and inventing one would only
 * name a cache that no reader consults: `/robots.txt` is a plain route handler
 * addressed by path, and redirects are read by `proxy.ts`, which keeps its own
 * module-level TTL cache that Next's tag system cannot see at all. So path
 * revalidation is the matching call here, not a shortfall.
 *
 * The practical consequence, worth knowing before someone reports it as a bug: a
 * redirect saved here becomes live once the proxy's own cache window lapses, not
 * instantly. Robots changes are instant, because `/robots.txt` really is a Next
 * route and `revalidateRobotsFile` below evicts it.
 */
function revalidateSeoSettings() {
  revalidatePath(SEO_SETTINGS_PATH);
}

/** Additionally evicts the public file, so the operator's change is visible at once. */
function revalidateRobotsFile() {
  revalidateSeoSettings();
  revalidatePath('/robots.txt');
}

/**
 * The admin gate, converted from a throw into a value.
 *
 * Every mutation below is invoked directly from a client component, and Next replaces
 * the message of an uncaught Server Action error with a generic string in production
 * builds — so "you do not have permission" would reach the operator as "An error
 * occurred in the Server Components render", which tells them nothing and invites a
 * support ticket. The shared helper throws because a Server Component wants it to;
 * this wrapper is where that throw becomes `SettingsActionResult` data.
 */
async function requireAdminOrMessage(): Promise<
  { error: null; supabase: Awaited<ReturnType<typeof requireAdminSupabaseClient>>['supabase'] } | { error: string; supabase: null }
> {
  try {
    const { supabase } = await requireAdminSupabaseClient();

    return { error: null, supabase };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'You do not have permission to manage SEO settings.',
      supabase: null,
    };
  }
}

/**
 * Turns a PostgREST failure into something an operator can act on.
 *
 * The two cases worth naming are the ones that will actually happen. A missing table
 * means the install has pulled this code but not yet run its migrations — a steady
 * state that can last days, and one whose raw message ("Could not find the table
 * 'public.cms_redirects' in the schema cache") reads like a bug in NextBlock rather
 * than a step the operator has not taken. A unique violation means the source path is
 * already claimed, which the application already checks; seeing it here means two
 * admins saved the same path at the same instant, and the database won the race.
 */
function describeDatabaseError(
  error: { code?: string | null; message?: string | null } | null,
  fallback: string
): string {
  if (!error) {
    return fallback;
  }

  if (isSchemaMissingError(error)) {
    return 'The redirects table does not exist yet. Run `npm run db:migrate` to apply the pending migrations, then reload this page.';
  }

  if (error.code === '23505') {
    return 'Another redirect already handles that source path. Reload the page to see it.';
  }

  return `${fallback} ${error.message ?? ''}`.trim();
}

/**
 * The rule set every validation runs against, including paused rules.
 *
 * Paused rules count deliberately: `validateRedirectRule` uses this list for both the
 * duplicate check and the loop walk, and excluding a paused rule would let an operator
 * save a second rule for the same source, then re-enable the first and end up with two
 * rules fighting over one path.
 */
async function loadRedirectRules(
  supabase: NonNullable<Awaited<ReturnType<typeof requireAdminOrMessage>>['supabase']>
): Promise<RedirectRule[]> {
  const { data } = await supabase.from(CMS_REDIRECTS_TABLE).select(REDIRECT_ADMIN_COLUMNS);

  return toRedirectRules((data ?? []) as CmsRedirect[]);
}

/**
 * Shape and bounds only.
 *
 * The interesting rules — blank source, a full URL in the source box, a self-redirect,
 * a duplicate, a cycle — belong to `validateRedirectRule` in the pure engine, which the
 * browser runs too, so the operator sees the same sentence before and after saving.
 * Zod's job here is narrower: reject a payload that is not the right *kind* of thing,
 * which is what stops a hand-rolled fetch to this action from writing a 500-kilobyte
 * path or a status code the table's CHECK constraint would reject as an opaque error.
 */
const redirectInputSchema = z.object({
  destinationPath: z.string().max(2048),
  isActive: z.boolean(),
  sourcePath: z.string().max(2048),
  statusCode: z.union([z.literal(301), z.literal(302)]),
});

const redirectIdSchema = z.string().uuid();

/**
 * The robots payload, bounded so a malicious or buggy client cannot park an unbounded
 * blob in a row that is read on every `/robots.txt` request. Everything semantic is
 * left to `normalizeRobotsSettings`, which never throws and always returns a complete
 * object — the property that keeps a garbage settings row from turning robots.txt into
 * a 500, which some crawlers read as "the whole site is disallowed".
 */
const robotsSettingsSchema = z.object({
  customRules: z.string().max(20000),
  isIndexingEnabled: z.boolean(),
  sitemapEnabled: z.boolean(),
  userAgentRules: z
    .array(
      z.object({
        allow: z.array(z.string().max(2048)).max(200),
        disallow: z.array(z.string().max(2048)).max(200),
        userAgent: z.string().max(200),
      })
    )
    .max(50),
});

/**
 * Every redirect rule, active or not, ordered the way an operator reads them.
 *
 * Ordered by `source_path` rather than by creation date because this list is used as a
 * lookup ("is /old-pricing already handled?") far more often than as a history, and an
 * alphabetical list answers that question by eye.
 *
 * Throws for a non-admin — it is called only by the Server Component below, which is
 * itself gated, so a throw here lands on the error boundary rather than in front of a
 * user. A *read* failure is different and does not throw: an install that has not run
 * its migrations yet would otherwise get an error page instead of the screen that
 * explains what to do, so the failure is logged and reported as an empty list.
 */
export async function getRedirects(): Promise<CmsRedirect[]> {
  const { supabase } = await requireAdminSupabaseClient();

  const { data, error } = await supabase
    .from(CMS_REDIRECTS_TABLE)
    .select(REDIRECT_ADMIN_COLUMNS)
    .order('source_path');

  if (error) {
    console.error('SEO settings: could not read redirects —', describeDatabaseError(error, 'Read failed.'));
    return [];
  }

  return (data ?? []) as CmsRedirect[];
}

/**
 * The stored robots directives, in canonical form.
 *
 * The raw jsonb goes through `normalizeRobotsSettings` on the way out, which is what
 * makes a missing row, a row left as SQL `null`, and a row an older release wrote in a
 * different shape all resolve to the same complete object instead of throwing. The
 * migration seeds this key, but an install that predates it — or one whose row was
 * edited by hand — must still be able to open this screen.
 */
export async function getRobotsSettings(): Promise<RobotsSettings> {
  const { supabase } = await requireAdminSupabaseClient();

  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', ROBOTS_SETTINGS_KEY)
    .maybeSingle();

  if (error) {
    console.error('SEO settings: could not read robots settings —', error.message);
  }

  return normalizeRobotsSettings((data as { value?: unknown } | null)?.value);
}

export async function createRedirect(input: RedirectInput): Promise<SettingsActionResult> {
  const { error: authError, supabase } = await requireAdminOrMessage();
  if (authError !== null) {
    return { ok: false, error: authError };
  }

  const parsed = redirectInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'That redirect could not be read. Check the paths and try again.' };
  }

  // Normalising before validating is what makes the admin screen and the proxy agree:
  // both compare `normalizeRedirectPath` output, so a rule that looks unique here
  // cannot turn out to collide at request time.
  //
  // The destination goes through the same function, and must. It was previously only
  // trimmed, on the assumption that normalising would corrupt an off-site https://
  // target — but `normalizeRedirectPath` passes an absolute URL through untouched
  // apart from folding its scheme to lowercase, and that fold is precisely what is
  // needed here: the table's CHECK is `destination_path ~ '^https://'`, a
  // case-SENSITIVE match, so a destination typed as `HTTPS://example.com` passes
  // validation and is then rejected by Postgres with a raw constraint-violation
  // message the operator cannot act on.
  const sourcePath = normalizeRedirectPath(parsed.data.sourcePath);
  const destinationPath = normalizeRedirectPath(parsed.data.destinationPath);

  const existingRules = await loadRedirectRules(supabase);
  const validation = validateRedirectRule({ destinationPath, sourcePath }, existingRules);
  if (!validation.ok) {
    // Surfaced verbatim: every string in the engine is written to be read by the
    // operator who typed the offending value, and paraphrasing it here would make the
    // browser's live warning and the server's refusal disagree about the same rule.
    return { ok: false, error: validation.error };
  }

  const { error } = await supabase.from(CMS_REDIRECTS_TABLE).insert({
    destination_path: destinationPath,
    is_active: parsed.data.isActive,
    source_path: sourcePath,
    status_code: parsed.data.statusCode,
  });

  if (error) {
    return { ok: false, error: describeDatabaseError(error, 'Failed to create the redirect.') };
  }

  revalidateSeoSettings();
  return { ok: true, message: `Redirect saved. ${sourcePath} now points to ${destinationPath}.` };
}

export async function updateRedirect(
  id: string,
  input: RedirectInput
): Promise<SettingsActionResult> {
  const { error: authError, supabase } = await requireAdminOrMessage();
  if (authError !== null) {
    return { ok: false, error: authError };
  }

  const parsedId = redirectIdSchema.safeParse(id);
  if (!parsedId.success) {
    return { ok: false, error: 'That redirect no longer exists. Reload the page and try again.' };
  }

  const parsed = redirectInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'That redirect could not be read. Check the paths and try again.' };
  }

  // Both sides normalised, for the reasons spelled out in `createRedirect` — an
  // edit that only changed a destination's scheme casing would otherwise fail the
  // table CHECK with a raw Postgres error.
  const sourcePath = normalizeRedirectPath(parsed.data.sourcePath);
  const destinationPath = normalizeRedirectPath(parsed.data.destinationPath);

  const existingRules = await loadRedirectRules(supabase);
  // Passing the id is how editing in place works: the rule being edited is excluded
  // from both the duplicate check and the loop walk, so a rule is allowed to keep its
  // own source path.
  const validation = validateRedirectRule(
    { destinationPath, id: parsedId.data, sourcePath },
    existingRules
  );
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const { error } = await supabase
    .from(CMS_REDIRECTS_TABLE)
    .update({
      destination_path: destinationPath,
      is_active: parsed.data.isActive,
      source_path: sourcePath,
      status_code: parsed.data.statusCode,
    })
    .eq('id', parsedId.data);

  if (error) {
    return { ok: false, error: describeDatabaseError(error, 'Failed to update the redirect.') };
  }

  revalidateSeoSettings();
  return { ok: true, message: 'Redirect updated.' };
}

export async function deleteRedirect(id: string): Promise<SettingsActionResult> {
  const { error: authError, supabase } = await requireAdminOrMessage();
  if (authError !== null) {
    return { ok: false, error: authError };
  }

  const parsedId = redirectIdSchema.safeParse(id);
  if (!parsedId.success) {
    return { ok: false, error: 'That redirect no longer exists. Reload the page and try again.' };
  }

  const { error } = await supabase.from(CMS_REDIRECTS_TABLE).delete().eq('id', parsedId.data);

  if (error) {
    return { ok: false, error: describeDatabaseError(error, 'Failed to delete the redirect.') };
  }

  revalidateSeoSettings();
  return {
    ok: true,
    message: 'Redirect deleted. Visitors asking for that path will get a 404 again.',
  };
}

/**
 * Pauses or resumes one rule.
 *
 * Re-validating on the way *back on* is not redundant. The duplicate and loop checks
 * deliberately count paused rules, so a rule that was valid when it was saved is still
 * valid when it is resumed — but rows that predate this screen (an import, a direct SQL
 * insert) were never checked at all, and resuming one is exactly when a conflict would
 * first reach a visitor. Switching a rule *off* is never blocked: turning something off
 * cannot make the site worse, and refusing to would leave an operator stuck with a rule
 * they can neither fix nor stop.
 */
export async function toggleRedirect(id: string, isActive: boolean): Promise<SettingsActionResult> {
  const { error: authError, supabase } = await requireAdminOrMessage();
  if (authError !== null) {
    return { ok: false, error: authError };
  }

  const parsedId = redirectIdSchema.safeParse(id);
  if (!parsedId.success) {
    return { ok: false, error: 'That redirect no longer exists. Reload the page and try again.' };
  }

  if (isActive) {
    const existingRules = await loadRedirectRules(supabase);
    const target = existingRules.find((rule) => rule.id === parsedId.data);

    if (!target) {
      return { ok: false, error: 'That redirect no longer exists. Reload the page and try again.' };
    }

    const validation = validateRedirectRule(
      { destinationPath: target.destinationPath, id: target.id, sourcePath: target.sourcePath },
      existingRules
    );
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
  }

  const { error } = await supabase
    .from(CMS_REDIRECTS_TABLE)
    .update({ is_active: isActive })
    .eq('id', parsedId.data);

  if (error) {
    return { ok: false, error: describeDatabaseError(error, 'Failed to change the redirect.') };
  }

  revalidateSeoSettings();
  return { ok: true, message: isActive ? 'Redirect enabled.' : 'Redirect paused.' };
}

/**
 * Replaces the stored robots directives wholesale.
 *
 * The payload is normalised before it is written, not only after it is read, so the row
 * on disk is already canonical: paths gain their leading slash, blank entries are
 * dropped, and a rule with no user agent — which would render a `User-agent:` line
 * applying to nobody and silently orphan every directive under it — is removed. Writing
 * the canonical form means the file an operator previewed is the file that gets served,
 * and it means anything else reading this row later (an export, an MCP tool, the
 * `app/robots.txt/route.ts` handler) does not have to repeat the cleanup.
 */
export async function saveRobotsSettings(settings: RobotsSettings): Promise<SettingsActionResult> {
  const { error: authError, supabase } = await requireAdminOrMessage();
  if (authError !== null) {
    return { ok: false, error: authError };
  }

  const parsed = robotsSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Those robots settings could not be read. Shorten any very long rule list and try again.',
    };
  }

  const normalized = normalizeRobotsSettings(parsed.data);

  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: ROBOTS_SETTINGS_KEY, value: normalized });

  if (error) {
    return {
      ok: false,
      error: describeDatabaseError(error, 'Failed to save the robots settings.'),
    };
  }

  revalidateRobotsFile();
  return {
    ok: true,
    message: normalized.isIndexingEnabled
      ? 'Robots settings saved.'
      : 'Robots settings saved. Search engines are now asked not to index this site.',
  };
}
