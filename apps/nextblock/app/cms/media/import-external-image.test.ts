import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-21: `importExternalImageToMedia` is a server action that accepted `actorUserId`
 * and cross-checked it against the session only when a session existed, so a cookieless
 * POST naming an admin's id imported (and recorded media) as that admin. It now takes the
 * importer from `requireCmsStaff()` and nothing else.
 */

const mocks = vi.hoisted(() => ({
  importAsActor: vi.fn(async (input: { actorUserId: string }) => ({ error: `imported as ${input.actorUserId}` })),
  staff: null as null | { userId: string } | Error,
}));

vi.mock('../../../lib/auth/cms-actor', () => ({
  requireCmsStaff: async () => {
    if (!mocks.staff || mocks.staff instanceof Error) throw mocks.staff ?? new Error('Unauthorized');
    return { role: 'WRITER', supabase: {}, userId: mocks.staff.userId };
  },
}));

vi.mock('../../../lib/media/external-image-import', () => ({
  importExternalImageAsActor: mocks.importAsActor,
}));

import { importExternalImageToMedia } from './import-external-image';

beforeEach(() => {
  mocks.importAsActor.mockClear();
  mocks.staff = null;
});

describe('importExternalImageToMedia', () => {
  it('refuses a cookieless POST that names an admin as the actor', async () => {
    const forged = { actorUserId: 'admin-1', url: 'https://images.example.test/a.png' };

    await expect(importExternalImageToMedia(forged)).resolves.toEqual({
      error: 'You must be signed in to import an image.',
    });
    expect(mocks.importAsActor).not.toHaveBeenCalled();
  });

  it('refuses a signed-in account without a CMS role', async () => {
    mocks.staff = new Error('Forbidden');

    await expect(importExternalImageToMedia({ url: 'https://images.example.test/a.png' })).resolves.toEqual({
      error: 'You do not have permission to import media.',
    });
    expect(mocks.importAsActor).not.toHaveBeenCalled();
  });

  it('imports as the session user, ignoring any actor in the arguments', async () => {
    mocks.staff = { userId: 'writer-1' };

    await importExternalImageToMedia({
      actorUserId: 'admin-1',
      altText: 'Hero',
      url: 'https://images.example.test/a.png',
    } as Parameters<typeof importExternalImageToMedia>[0]);

    expect(mocks.importAsActor).toHaveBeenCalledWith({
      actorUserId: 'writer-1',
      altText: 'Hero',
      fileName: undefined,
      url: 'https://images.example.test/a.png',
    });
  });
});
