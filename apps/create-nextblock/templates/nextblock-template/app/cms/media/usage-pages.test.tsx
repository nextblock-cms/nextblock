import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The media library's "Unused" view (/cms/media?usage=unused) and the media edit page's "Where this
 * file is used". Both read public.media_usage (02045) with the service role (findMediaUsage), so
 * each checks the actor itself first: a page renders beside the CMS layout, not behind its
 * second-factor redirect. A failed lookup lists nothing as unused. The pages are called directly and
 * the element they return inspected.
 */

const mocks = vi.hoisted(() => ({
  /** getCmsActor(): null for a session whose enrolled second factor is still pending. */
  actor: { userId: 'u1', role: 'ADMIN' } as { userId: string; role: string } | null,
  /** The profile role a cookie-client read sees, second factor or not. */
  profileRole: 'ADMIN',
  rows: [] as Array<Record<string, unknown>>,
  findMediaUsage: vi.fn(),
}));

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) => {
      const answer = () => {
        if (table === 'profiles') return { data: { role: mocks.profileRole }, error: null };
        return { data: mocks.rows, error: null };
      };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'in', 'ilike', 'or']) chain[method] = () => chain;
      chain.single = async () => (table === 'media' ? { data: mocks.rows[0] ?? null, error: null } : answer());
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  };
}

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({ createClient: () => makeSupabase() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('next/link', () => ({ default: Stub }));
vi.mock('@nextblock-cms/ui', () => ({ Button: Stub }));
vi.mock('../../../lib/auth/cms-actor', () => ({
  getCmsActor: async () => mocks.actor,
  isCmsStaffRole: (role: string) => role === 'ADMIN' || role === 'WRITER',
}));
vi.mock('../../../lib/media/media-usage', () => ({ findMediaUsage: mocks.findMediaUsage }));
vi.mock('../../../lib/media/resolveMediaUrl', () => ({ getPublicMediaBaseUrl: () => '' }));
vi.mock('./components/MediaUploadForm', () => ({ default: function MediaUploadForm() { return null; } }));
vi.mock('./components/FolderNavigator', () => ({ default: function FolderNavigator() { return null; } }));
vi.mock('./components/MediaGridClient', () => ({ default: function MediaGridClient() { return null; } }));
vi.mock('./components/MediaEditForm', () => ({ default: function MediaEditForm() { return null; } }));
vi.mock('./actions', () => ({ updateMediaItem: vi.fn() }));

import CmsMediaLibraryPage from './page';
import EditMediaPage from './[id]/edit/page';
import MediaGridClient from './components/MediaGridClient';
import MediaUsageList from './components/MediaUsageList';

const USED = 'a1111111-1111-4111-8111-11111111111a';
const UNUSED = 'b2222222-2222-4222-8222-22222222222b';
const HISTORY = 'c3333333-3333-4333-8333-33333333333c';

const row = (id: string) => ({ id, file_name: `${id.slice(0, 4)}.webp`, object_key: `uploads/${id}.webp`, variants: [] });
const entry = (byKind: Record<string, number>, sites: unknown[] = []) => ({
  total: Object.values(byKind).reduce((sum, n) => sum + n, 0),
  byKind,
  sites,
});

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children as ReactNode, type);
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement(node)) return '';
  return textOf((node.props as { children?: ReactNode }).children);
}

async function gridProps(searchParams: Record<string, string>) {
  const tree = await CmsMediaLibraryPage({ searchParams: Promise.resolve(searchParams) });
  const grid = findElement(tree, MediaGridClient);
  if (!grid) throw new Error('no MediaGridClient');
  return grid.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor = { userId: 'u1', role: 'ADMIN' };
  mocks.profileRole = 'ADMIN';
  mocks.rows = [row(USED), row(UNUSED), row(HISTORY)];
  mocks.findMediaUsage.mockResolvedValue(
    new Map([
      [USED, entry({ block: 1 })],
      [UNUSED, entry({})],
      [HISTORY, entry({ page_revision: 2 })],
    ])
  );
});

describe('/cms/media?usage=unused', () => {
  it('lists only what nothing uses, revision-only files noted, from one lookup of the listed rows', async () => {
    const props = await gridProps({ usage: 'unused' });

    expect(mocks.findMediaUsage).toHaveBeenCalledTimes(1);
    expect(mocks.findMediaUsage).toHaveBeenCalledWith(mocks.rows);
    expect((props.initialMediaItems as Array<{ id: string }>).map((item) => item.id)).toEqual([UNUSED, HISTORY]);
    expect(props.unusedView).toEqual({ historyOnlyIds: [HISTORY] });
    expect(props.usageError).toBeNull();
  });

  it('lists nothing as unused when the lookup fails, and says why', async () => {
    mocks.findMediaUsage.mockRejectedValue(new Error('Where this media is used could not be checked: timeout'));

    const props = await gridProps({ usage: 'unused' });

    expect(props.initialMediaItems).toEqual([]);
    expect(props.unusedView).toBeNull();
    expect(props.usageError).toBe('Where this media is used could not be checked: timeout');
  });

  it('runs no lookup for a session whose second factor is pending, or a non-staff role', async () => {
    mocks.actor = null;
    const pending = await gridProps({ usage: 'unused' });
    mocks.actor = { userId: 'u2', role: 'USER' };
    const customer = await gridProps({ usage: 'unused' });

    expect(mocks.findMediaUsage).not.toHaveBeenCalled();
    for (const props of [pending, customer]) {
      expect(props.initialMediaItems).toEqual([]);
      expect(props.usageError).toBe('Complete two-factor verification to list unused files.');
    }
  });

  it('lists every file, with no lookup, without the filter', async () => {
    const props = await gridProps({});

    expect(mocks.findMediaUsage).not.toHaveBeenCalled();
    expect(props.initialMediaItems).toEqual(mocks.rows);
    expect(props.unusedView).toBeNull();
  });
});

describe('/cms/media/[id]/edit "Where this file is used"', () => {
  async function renderEditPage() {
    return EditMediaPage({ params: Promise.resolve({ id: USED }) });
  }

  it('lists where the file is used', async () => {
    mocks.rows = [row(USED)];
    const usage = entry({ block: 1 }, [{ kind: 'block', recordId: '41', parentType: 'page', parentId: '7', label: 'Home', language: 'en' }]);
    mocks.findMediaUsage.mockResolvedValue(new Map([[USED, usage]]));

    const tree = await renderEditPage();

    expect(mocks.findMediaUsage).toHaveBeenCalledWith([mocks.rows[0]]);
    expect(findElement(tree, MediaUsageList)?.props.usage).toEqual(usage);
  });

  it("withholds a partner storefront's handle from a WRITER", async () => {
    mocks.actor = { userId: 'u1', role: 'WRITER' };
    mocks.profileRole = 'WRITER';
    mocks.rows = [row(USED)];
    mocks.findMediaUsage.mockResolvedValue(
      new Map([[USED, entry({ partner_page: 1 }, [{ kind: 'partner_page', recordId: 'pp-1', parentType: null, parentId: null, label: 'jane', language: null }])]])
    );

    const tree = await renderEditPage();

    const usage = findElement(tree, MediaUsageList)?.props.usage as { sites: Array<{ label: string | null }> };
    expect(usage.sites.map((site) => site.label)).toEqual([null]);
  });

  it('says why when the check cannot run: no lookup for a pending second factor, the error for a failed one', async () => {
    mocks.rows = [row(USED)];
    mocks.actor = null;
    const pending = await renderEditPage();
    expect(mocks.findMediaUsage).not.toHaveBeenCalled();
    expect(findElement(pending, MediaUsageList)).toBeNull();
    expect(textOf(pending)).toContain('Complete two-factor verification to see where this file is used.');

    mocks.actor = { userId: 'u1', role: 'ADMIN' };
    mocks.findMediaUsage.mockRejectedValue(new Error('Where this media is used could not be checked: timeout'));
    const failed = await renderEditPage();
    expect(textOf(failed)).toContain('could not be checked: timeout');
  });
});
