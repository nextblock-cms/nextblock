import 'server-only';

import { randomBytes } from 'node:crypto';

import { hasAllowedObjectKeyExtension, isSafeObjectKey } from '../storage/upload-policy';

/**
 * Object keys of partner uploads (avatars and storefront images). Pure, and free of sharp and the
 * storage clients, so the CMS review (./avatar-cleanup.ts) can check a key without loading the
 * image pipeline. ./uploads.ts re-exports everything here for the upload route.
 */

export type AffiliateUploadKind = 'avatar' | 'image';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_PATTERN = /^[0-9a-f]{8}$/;
const KEY_CHARACTERS = /^[a-z0-9/._-]+$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYYMMDDHHmmss` in UTC. */
export function formatAffiliateUploadTimestamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** `affiliates/avatars/<id>/` or `affiliates/pages/<id>/`, or null for anything but a uuid. */
export function affiliateUploadPrefix(kind: AffiliateUploadKind, affiliateId: string): string | null {
  const id = typeof affiliateId === 'string' ? affiliateId.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(id)) return null;
  return kind === 'avatar' ? `affiliates/avatars/${id}/` : `affiliates/pages/${id}/`;
}

/**
 * The object key for a new upload: `<prefix><UTC timestamp>-<8 hex nonce>.jpg`. Null unless every
 * part is well formed and the key passes the media library's key policy (and, for avatars, the
 * `affiliate_profiles.avatar_object_key` CHECK of 02030).
 */
export function buildAffiliateUploadKey(
  kind: AffiliateUploadKind,
  affiliateId: string,
  now: Date = new Date(),
  nonce: string = randomBytes(4).toString('hex'),
): string | null {
  const prefix = affiliateUploadPrefix(kind, affiliateId);
  if (!prefix || !NONCE_PATTERN.test(nonce) || Number.isNaN(now.getTime())) return null;
  const key = `${prefix}${formatAffiliateUploadTimestamp(now)}-${nonce}.jpg`;
  if (!KEY_CHARACTERS.test(key) || key.includes('..') || key.includes('//')) return null;
  if (!isSafeObjectKey(key) || !hasAllowedObjectKeyExtension(key)) return null;
  return key;
}

/** True when `key` is one of this affiliate's own avatar objects (safe to delete on replace). */
export function isOwnAffiliateAvatarKey(key: unknown, affiliateId: string): key is string {
  const prefix = affiliateUploadPrefix('avatar', affiliateId);
  return (
    typeof key === 'string' &&
    prefix !== null &&
    key.startsWith(prefix) &&
    key.length > prefix.length &&
    !key.slice(prefix.length).includes('/') &&
    isSafeObjectKey(key)
  );
}
