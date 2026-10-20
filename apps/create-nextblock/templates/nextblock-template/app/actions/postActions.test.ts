import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `revalidateAndLog` is reachable as an unauthenticated POST (it is bundled into the
 * public pages' action manifests), so the gate in front of `revalidatePath` is the whole
 * point: the on-demand revalidation secret or a staff session, and a site-relative path.
 */

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requestHeaders: {} as Record<string, string>,
  expectedSecret: 'expected-secret',
  user: null as { id: string } | null,
  role: null as string | null,
  getUser: vi.fn(),
  profileLookup: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => mocks.requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('../../lib/app-secrets', () => ({
  resolveRevalidateSecret: () => mocks.expectedSecret,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        mocks.getUser();
        return { data: { user: mocks.user }, error: null };
      },
    },
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              mocks.profileLookup();
              return { data: mocks.role ? { role: mocks.role } : null, error: null };
            },
          }),
        }),
      };
    },
  }),
}));

vi.mock('@nextblock-cms/utils', () => ({
  buildPublishedAtOrFilter: () => 'published_at.is.null',
}));
vi.mock('../../lib/media/resolveMediaUrl', () => ({ resolveMediaUrl: () => null }));
vi.mock('../../lib/posts/readTime', () => ({ estimateReadTimeMinutesFromBlocks: () => 1 }));

import { revalidateAndLog } from './postActions';

describe('revalidateAndLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.requestHeaders = {};
    mocks.expectedSecret = 'expected-secret';
    mocks.user = null;
    mocks.role = null;
  });

  it('refuses an anonymous caller before touching the cache', async () => {
    const result = await revalidateAndLog('/');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('accepts the on-demand revalidation secret', async () => {
    mocks.requestHeaders = { 'x-revalidate-secret': 'expected-secret' };

    const result = await revalidateAndLog('/article/hello');

    expect(result).toEqual({ success: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/article/hello');
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    mocks.requestHeaders = { 'x-revalidate-secret': 'expected-secret-' };

    const result = await revalidateAndLog('/');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('never matches an empty header against an unconfigured secret', async () => {
    mocks.expectedSecret = '';
    mocks.requestHeaders = { 'x-revalidate-secret': '' };

    const result = await revalidateAndLog('/');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'WRITER'])('accepts a signed-in %s', async (role) => {
    mocks.user = { id: 'staff-1' };
    mocks.role = role;

    const result = await revalidateAndLog('/product/kettle');

    expect(result).toEqual({ success: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/kettle');
  });

  it('refuses a signed-in customer', async () => {
    mocks.user = { id: 'customer-1' };
    mocks.role = 'USER';

    const result = await revalidateAndLog('/');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    '//evil.com',
    'https://evil.com/',
    '/\\evil.com',
    '/%2F%2Fevil.com',
    '/path\nwith-control',
    'article/hello',
    '',
  ])('refuses the non-site-relative path %j even with the secret', async (path) => {
    mocks.requestHeaders = { 'x-revalidate-secret': 'expected-secret' };

    const result = await revalidateAndLog(path);

    expect(result.success).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('refuses a non-string path', async () => {
    mocks.requestHeaders = { 'x-revalidate-secret': 'expected-secret' };

    const result = await revalidateAndLog({ toString: () => '/' } as never);

    expect(result.success).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
