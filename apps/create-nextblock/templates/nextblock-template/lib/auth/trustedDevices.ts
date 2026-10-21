import 'server-only';

// Server-only trusted-device ("Remember this device") helpers.
//
// Trust is server-validated: the cookie holds only a random token, and a bypass
// is honoured ONLY when a non-expired user_trusted_devices row matches its
// SHA-256. Deleting the row instantly revokes trust, regardless of the cookie.
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getSecuritySettings } from '../privacy/settings';
import { randomToken, sha256Hex } from './crypto';
import {
  TRUSTED_DEVICE_COOKIE,
  clearCookie,
  getCookieValue,
  setSecureCookie,
} from './cookies';

export interface TrustedDeviceRow {
  id: string;
  browser_metadata: string | null;
  created_at: string;
  expires_at: string;
}

/** Mint a trusted-device token, persist its hash, and set the cookie. */
export async function issueTrustedDevice(
  userId: string,
  browserMetadata: string | null,
): Promise<void> {
  const { trusted_device_days } = await getSecuritySettings();
  const maxAgeSeconds = trusted_device_days * 24 * 60 * 60;
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();

  const svc = getServiceRoleSupabaseClient();
  const { error } = await svc.from('user_trusted_devices').insert({
    user_id: userId,
    device_hash: sha256Hex(token),
    browser_metadata: browserMetadata ? browserMetadata.slice(0, 500) : null,
    expires_at: expiresAt,
  });
  if (error) {
    console.error('Failed to persist trusted device:', error.message);
    return; // Non-fatal: the user simply isn't remembered.
  }
  await setSecureCookie(TRUSTED_DEVICE_COOKIE, token, maxAgeSeconds);
}

/** True when the current request carries a cookie matching a live trusted row. */
export async function hasValidTrustedDevice(userId: string): Promise<boolean> {
  const token = await getCookieValue(TRUSTED_DEVICE_COOKIE);
  if (!token) return false;
  const svc = getServiceRoleSupabaseClient();
  const { data } = await svc
    .from('user_trusted_devices')
    .select('id')
    .eq('user_id', userId)
    .eq('device_hash', sha256Hex(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return Boolean(data);
}

/** List the signed-in user's trusted devices (RLS scopes to their own rows). */
export async function listTrustedDevices(userId: string): Promise<TrustedDeviceRow[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from('user_trusted_devices')
    .select('id, browser_metadata, created_at, expires_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

/** Revoke one trusted device the user owns (RLS prevents touching others'). */
export async function revokeTrustedDevice(userId: string, id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase
    .from('user_trusted_devices')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    console.error('Failed to revoke trusted device:', error.message);
    throw new Error('Failed to revoke device.');
  }
}

/** Drop all of a user's trusted devices and the local cookie (e.g. on MFA disable). */
export async function revokeAllTrustedDevices(userId: string): Promise<void> {
  const svc = getServiceRoleSupabaseClient();
  await svc.from('user_trusted_devices').delete().eq('user_id', userId);
  await clearCookie(TRUSTED_DEVICE_COOKIE);
}
