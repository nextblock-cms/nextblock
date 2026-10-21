"use server";

import "server-only";

import { createClient } from "./supabase/server";
import { encodedRedirect } from "@nextblock-cms/utils/server";
import { insertMediaRecord, type MediaRecordResult, type MediaUploadPayload } from "./media-record";

export type { ImageVariant, MediaRecordResult, MediaUploadPayload } from "./media-record";

/**
 * Process-wide key under which the app publishes its CMS second-factor check
 * (apps/nextblock/lib/auth/second-factor-gate.ts). This lib cannot import the app.
 */
const SECOND_FACTOR_GATE_KEY = Symbol.for('nextblock.cms.secondFactorGate');

type SessionClient = ReturnType<typeof createClient>;

/**
 * Has this session passed the account's second factor (or is none enrolled)? With the
 * app's gate registered its decision is final; without it, fail closed: an enrolled
 * account passes only as a TOTP session already at aal2 (as require-ecom-role.ts does).
 */
async function secondFactorSatisfied(supabase: SessionClient, userId: string): Promise<boolean> {
  const gate = (globalThis as Record<symbol, unknown>)[SECOND_FACTOR_GATE_KEY];
  if (typeof gate === 'function') {
    return Boolean(await (gate as () => Promise<boolean>)());
  }

  const { data: settings } = await supabase
    .from('user_security_settings')
    .select('mfa_enabled, mfa_type')
    .eq('user_id', userId)
    .maybeSingle();
  if (!settings?.mfa_enabled || !settings?.mfa_type) return true;
  if (settings.mfa_type === 'totp') {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return aal?.currentLevel === 'aal2';
  }
  return false;
}

/**
 * Record an upload as the signed-in ADMIN or WRITER.
 *
 * A server action is a public POST endpoint, so the uploader is always the cookie
 * session's user, never anything in the payload. Until 2026-10-21 the payload could name
 * one (`actorUserId`, for the MCP server) and the session cross-check ran only when a
 * session existed, so a cookieless POST naming an admin's id recorded media as that admin
 * with the service role. Server routes without a session use `recordMediaUploadAsActor`
 * (`@nextblock-cms/db/server`), which is not a server action.
 */
export async function recordMediaUpload(
  payload: MediaUploadPayload,
  returnJustData?: boolean
): Promise<MediaRecordResult | void> {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    if (returnJustData) return { error: "User not authenticated for media record." };
    return encodedRedirect("error", "/cms/media", "User not authenticated for media record.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["ADMIN", "WRITER"].includes(profile.role) || !(await secondFactorSatisfied(supabase, user.id))) {
    if (returnJustData) return { error: "Forbidden: Insufficient permissions to record media." };
    return encodedRedirect("error", "/cms/media", "Forbidden: Insufficient permissions to record media.");
  }

  const result = await insertMediaRecord(supabase, user.id, payload);

  if ("error" in result) {
    if (returnJustData) return result;
    return encodedRedirect("error", "/cms/media", result.error);
  }

  if (returnJustData) {
    return result;
  }
  encodedRedirect("success", "/cms/media", "Media recorded successfully.");
}
