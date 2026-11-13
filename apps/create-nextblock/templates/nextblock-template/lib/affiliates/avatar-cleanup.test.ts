import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approval deletes the avatar of the snapshot it replaces (the upload route keeps that one,
 * since the live storefront shows it until then): only the partner's own avatar objects, never
 * the avatar the new snapshot names, a seeded `images/` key or another partner's object.
 */

const storage = vi.hoisted(() => ({ deleteObject: vi.fn<(key: string) => Promise<void>>() }));

// Loaded on demand by ./avatar-cleanup (the real module pulls in sharp and the storage clients).
vi.mock('./uploads', () => ({ deleteAffiliateUploadObject: storage.deleteObject }));

import { deleteSupersededAffiliateAvatar, supersededAffiliateAvatarKey } from './avatar-cleanup';

const AFFILIATE = '0f8a1c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b';
const OLD = `affiliates/avatars/${AFFILIATE}/20260101000000-aaaaaaaa.jpg`;
const NEW = `affiliates/avatars/${AFFILIATE}/20261020000000-bbbbbbbb.jpg`;

describe('supersededAffiliateAvatarKey', () => {
  it('names the previous snapshot avatar when the new snapshot uses another one', () => {
    expect(supersededAffiliateAvatarKey({ affiliateId: AFFILIATE, previousPublishedKey: OLD, keepKeys: [NEW] })).toBe(OLD);
    // The partner removed their avatar: the old one is still shown nowhere after the approval.
    expect(supersededAffiliateAvatarKey({ affiliateId: AFFILIATE, previousPublishedKey: OLD, keepKeys: [null] })).toBe(OLD);
  });

  it('keeps an avatar that is still in use, or that is not this partner’s own object', () => {
    const cases: Array<[string | null | undefined, Array<string | null>]> = [
      [OLD, [OLD]],
      [OLD, [null, ` ${OLD} `]],
      [null, [NEW]],
      [undefined, [NEW]],
      ['', [NEW]],
      ['images/seeded-avatar.webp', [NEW]],
      ['affiliates/avatars/99999999-9999-4999-8999-999999999999/x.jpg', [NEW]],
      [`affiliates/pages/${AFFILIATE}/20260101000000-aaaaaaaa.jpg`, [NEW]],
      [`affiliates/avatars/${AFFILIATE}/../x.jpg`, [NEW]],
    ];
    for (const [previousPublishedKey, keepKeys] of cases) {
      expect(supersededAffiliateAvatarKey({ affiliateId: AFFILIATE, previousPublishedKey, keepKeys }), String(previousPublishedKey)).toBeNull();
    }
  });
});

describe('deleteSupersededAffiliateAvatar', () => {
  beforeEach(() => {
    storage.deleteObject.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storage.deleteObject.mockReset();
  });

  it('deletes the superseded object, and nothing when there is none', async () => {
    expect(await deleteSupersededAffiliateAvatar({ affiliateId: AFFILIATE, previousPublishedKey: OLD, keepKeys: [NEW] })).toBe(true);
    expect(storage.deleteObject).toHaveBeenCalledExactlyOnceWith(OLD);

    storage.deleteObject.mockClear();
    expect(await deleteSupersededAffiliateAvatar({ affiliateId: AFFILIATE, previousPublishedKey: OLD, keepKeys: [OLD] })).toBe(false);
    expect(await deleteSupersededAffiliateAvatar({ affiliateId: AFFILIATE, previousPublishedKey: 'images/a.webp', keepKeys: [NEW] })).toBe(false);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('never throws: a storage failure is logged and reported as false', async () => {
    storage.deleteObject.mockRejectedValue(new Error('AccessDenied'));
    await expect(deleteSupersededAffiliateAvatar({ affiliateId: AFFILIATE, previousPublishedKey: OLD, keepKeys: [NEW] })).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith('[affiliates] Superseded avatar cleanup failed:', 'AccessDenied');
  });
});
