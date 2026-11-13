import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site scripts run with the CSP nonce on every route. On the public sandbox
 * (NEXT_PUBLIC_IS_SANDBOX === 'true') the demo admin login is published, so every write action
 * refuses there, after the admin check (a non-admin still gets the admin refusal) and before any
 * row is read or written. The renderer refuses too (components/SiteScripts.test.tsx).
 */

const REFUSAL = 'Site scripts and tag managers are turned off in the sandbox: they would run for every visitor.';

const mocks = vi.hoisted(() => ({
  access: 'admin' as 'admin' | 'forbidden' | 'signed-out',
  /** Every table call the service-role client received, as `<table>.<method>`. */
  calls: [] as string[],
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const SCRIPT_ROW = {
  id: 'script-1',
  name: 'Chat widget',
  description: null,
  code: 'console.log(1);',
  src: null,
  placement: 'body_end',
  load_strategy: 'default',
  is_active: true,
  sort_order: 0,
};

const REVISION_ROW = {
  id: 'revision-1',
  script_id: 'script-1',
  script_name: 'Chat widget',
  revision_type: 'update',
  actor_user_id: 'admin-1',
  source: 'cms',
  summary: null,
  snapshot: { ...SCRIPT_ROW, id: undefined },
  created_at: '2026-11-01T12:00:00.000Z',
};

/** A service-role stand-in that logs every call and answers each read with the row its table holds. */
function serviceClient() {
  return {
    from(table: string) {
      const result = () => ({
        data: table === 'site_script_revisions' ? REVISION_ROW : SCRIPT_ROW,
        error: null,
      });
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'delete', 'upsert']) {
        chain[method] = () => {
          mocks.calls.push(`${table}.${method}`);
          return chain;
        };
      }
      for (const method of ['eq', 'in', 'order', 'limit']) chain[method] = () => chain;
      chain['single'] = async () => result();
      chain['maybeSingle'] = async () => result();
      chain['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('../../../../lib/auth/cms-actor', () => ({
  requireCmsAdmin: async () => {
    if (mocks.access === 'signed-out') throw new Error('Unauthorized');
    if (mocks.access === 'forbidden') throw new Error('Forbidden');
    return { supabase: serviceClient(), userId: 'admin-1' };
  },
}));
vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: () => serviceClient(),
  // The real predicate (a dependency-free module): only the exact string 'true' is the sandbox.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: mocks.revalidateTag }));

import {
  createSiteScript,
  deleteSiteScript,
  revertSiteScript,
  setSiteScriptActive,
  updateSiteScript,
} from './actions';
import { SITE_SCRIPTS_SANDBOX_MESSAGE } from './sandbox-lock';

const INPUT = { name: 'Chat widget', code: 'console.log(1);', is_active: true };

/** Every exported writer, with the table write it makes off the sandbox. */
const WRITERS = [
  { name: 'createSiteScript', run: () => createSiteScript(INPUT), write: 'site_scripts.insert' },
  { name: 'updateSiteScript', run: () => updateSiteScript('script-1', INPUT), write: 'site_scripts.update' },
  { name: 'setSiteScriptActive', run: () => setSiteScriptActive('script-1', false), write: 'site_scripts.update' },
  { name: 'deleteSiteScript', run: () => deleteSiteScript('script-1'), write: 'site_scripts.delete' },
  { name: 'revertSiteScript', run: () => revertSiteScript('revision-1'), write: 'site_scripts.update' },
] as const;

beforeEach(() => {
  mocks.access = 'admin';
  mocks.calls = [];
  mocks.revalidatePath.mockClear();
  mocks.revalidateTag.mockClear();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('site scripts actions on the sandbox', () => {
  it('share one refusal sentence with the settings screens', () => {
    expect(SITE_SCRIPTS_SANDBOX_MESSAGE).toBe(REFUSAL);
  });

  it.each(WRITERS)('$name refuses an admin before reading or writing any row', async ({ run }) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(run()).resolves.toEqual({ ok: false, error: REFUSAL });
    expect(mocks.calls).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('$name still gives a non-admin the admin refusal', async ({ run }) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    mocks.access = 'forbidden';
    await expect(run()).resolves.toEqual({ ok: false, error: 'Only administrators can manage site scripts.' });
    mocks.access = 'signed-out';
    await expect(run()).resolves.toEqual({ ok: false, error: 'You must be logged in to manage site scripts.' });
    expect(mocks.calls).toEqual([]);
  });
});

describe('site scripts actions off the sandbox', () => {
  it.each(['', 'false', 'TRUE', '1'])('write as before when NEXT_PUBLIC_IS_SANDBOX=%j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    for (const writer of WRITERS) {
      mocks.calls = [];
      const result = await writer.run();
      expect(result, writer.name).toMatchObject({ ok: true });
      expect(mocks.calls, writer.name).toContain(writer.write);
      // Every change is logged.
      expect(mocks.calls, writer.name).toContain('site_script_revisions.insert');
    }
    expect(mocks.revalidateTag).toHaveBeenCalledWith('public-layout-site-scripts', 'max');
  });
});
