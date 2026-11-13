import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  refuse: null as string | null,
  listCalls: 0,
  users: [] as Array<{ id: string; email: string; created_at: string; last_sign_in_at: string | null }>,
  profiles: [] as Array<{ id: string; role: string; full_name: string | null; avatar_url: string | null }>,
}));

vi.mock('../../../lib/auth/cms-actor', () => ({
  requireCmsAdmin: async () => {
    if (state.refuse) throw new Error(state.refuse);
    return {
      userId: 'admin-1',
      supabase: {
        auth: {
          admin: {
            listUsers: async () => {
              state.listCalls += 1;
              return { data: { users: state.users }, error: null };
            },
          },
        },
        from: () => ({ select: async () => ({ data: state.profiles, error: null }) }),
      },
    };
  },
}));

vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Avatar: Pass,
    AvatarFallback: Pass,
    AvatarImage: () => null,
    Badge: ({ children, variant }: { children?: ReactNode; variant?: string }) => <span data-variant={variant}>{children}</span>,
    Button: Pass,
    DropdownMenu: Pass,
    DropdownMenuButtonTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Pass,
    DropdownMenuSeparator: () => <hr />,
    Table: Pass,
    TableBody: Pass,
    TableCell: Pass,
    TableHead: Pass,
    TableHeader: Pass,
    TableRow: Pass,
  };
});
vi.mock('./components/DeleteUserButton', () => ({ DeleteUserButtonClient: () => <span>delete</span> }));
// The real sandbox predicate (exactly 'true'), without the rest of the server barrel.
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<typeof import('../../../../../libs/db/src/lib/config-resolve')>(
    '../../../../../libs/db/src/lib/config-resolve'
  );
  return { isSandboxEnvironment };
});

import CmsUsersListPage from './page';
import { USERS_LOCKED_IN_SANDBOX, USERS_SANDBOX_NOTE_ID } from './sandbox-lock';

async function render() {
  return renderToStaticMarkup(await CmsUsersListPage());
}

describe('/cms/users list', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    state.refuse = null;
    state.listCalls = 0;
    state.users = [
      { id: 'u-partner', email: 'partner@example.com', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: null },
      { id: 'u-admin', email: 'admin@example.com', created_at: '2026-09-01T00:00:00Z', last_sign_in_at: null },
      { id: 'u-customer', email: 'customer@example.com', created_at: '2026-09-02T00:00:00Z', last_sign_in_at: null },
    ];
    state.profiles = [
      { id: 'u-partner', role: 'RTL', full_name: 'Jane Partner', avatar_url: null },
      { id: 'u-admin', role: 'ADMIN', full_name: 'Ada Admin', avatar_url: null },
      { id: 'u-customer', role: 'USER', full_name: 'Cam Customer', avatar_url: null },
    ];
  });

  it('badges a partner account as PARTNER (RTL)', async () => {
    const html = await render();
    expect(html).toContain('<span data-variant="default">PARTNER (RTL)</span>');
    expect(html).toContain('<span data-variant="destructive">ADMIN</span>');
    expect(html).toContain('<span data-variant="outline">USER</span>');
  });

  it.each([
    ['Unauthorized', 'Access Denied. Not authenticated.'],
    ['Forbidden', 'Access Denied. Admin privileges required.'],
  ])('refuses (%s) before listing any account', async (thrown, message) => {
    state.refuse = thrown;
    const html = await render();
    expect(html).toContain(message);
    expect(state.listCalls).toBe(0);
  });

  // 2026-11-03: the public sandbox shares every account with every visitor, so the actions refuse
  // every change there; each row's disabled Delete item points at this note (aria-describedby).
  it('on the sandbox, shows the note the Delete items point at, and still lists every account', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await render();
    expect(html).toContain(`<p id="${USERS_SANDBOX_NOTE_ID}"`);
    expect(html).toContain(USERS_LOCKED_IN_SANDBOX.replace(/'/g, '&#x27;'));
    expect(html).toContain('partner@example.com');
    expect(state.listCalls).toBe(1);
  });

  it.each(['false', 'TRUE', '1'])('off the sandbox (%j), renders exactly what it renders with the variable unset', async (value) => {
    const unset = await render();
    expect(unset).not.toContain(USERS_SANDBOX_NOTE_ID);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    expect(await render()).toBe(unset);
  });
});
