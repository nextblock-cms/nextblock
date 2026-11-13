import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiteBriefFormValues } from '../../../../../lib/cortex-ai/site-brief-form';

/**
 * saveSiteBriefFromFormAction (the wizard's site-brief step). The sandbox's demo admin login is
 * public (2026-11-03) and its database is shared by every visitor, so the action answers the
 * sandbox before the admin check, the service-role client, the brief read or the save. Off the
 * sandbox it validates the answers (the real form schema) and saves them as the site brief.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  readCortexSiteBrief: vi.fn(),
  executeSaveSiteBrief: vi.fn(),
}));

const SERVICE_CLIENT = { marker: 'service-role' };

vi.mock('@nextblock-cms/db/server', async () => ({
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('../require-admin', () => ({ requireAdminSupabaseClient: mocks.requireAdmin }));
vi.mock('@nextblock-cms/cortex', () => ({
  executeSaveSiteBrief: mocks.executeSaveSiteBrief,
  readCortexSiteBrief: mocks.readCortexSiteBrief,
}));

import { saveSiteBriefFromFormAction } from './brief-actions';

const ANSWERS: SiteBriefFormValues = {
  business_name: 'Visitor Bakery',
  description: 'Sourdough and pastries, baked every morning.',
  goals: ['contact'],
  site_type: 'multi-page',
  pages: ['about', 'contact'],
  languages: ['en', 'fr'],
  primary_language: 'en',
  brand: { color_mode: 'auto', color_scheme: 'light', logo: 'later' },
  contact: { social: [] },
  keep_existing_content: false,
  sells_online: false,
};

const SAVED_BRIEF = { business_name: 'Visitor Bakery', status: 'draft' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.requireAdmin.mockReset().mockResolvedValue({ supabase: SERVICE_CLIENT, userId: 'admin-1' });
  mocks.getServiceRoleSupabaseClient.mockReset().mockReturnValue(SERVICE_CLIENT);
  mocks.readCortexSiteBrief.mockReset().mockResolvedValue(null);
  mocks.executeSaveSiteBrief.mockReset().mockResolvedValue({ brief: SAVED_BRIEF });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('saveSiteBriefFromFormAction', () => {
  it('answers the sandbox before the admin check, the service-role client or the save', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await saveSiteBriefFromFormAction(ANSWERS)).toEqual({
      message: 'The shared sandbox cannot save a site brief. Tell Cortex about your site in the chat instead.',
      success: false,
    });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.readCortexSiteBrief).not.toHaveBeenCalled();
    expect(mocks.executeSaveSiteBrief).not.toHaveBeenCalled();
  });

  it('saves the brief anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.executeSaveSiteBrief.mockClear();

      expect(await saveSiteBriefFromFormAction(ANSWERS), value).toEqual({ brief: SAVED_BRIEF, success: true });

      expect(mocks.executeSaveSiteBrief, value).toHaveBeenCalledTimes(1);
      expect(mocks.executeSaveSiteBrief, value).toHaveBeenCalledWith(
        { brief: expect.objectContaining({ business_name: 'Visitor Bakery', status: 'draft' }), mode: 'replace' },
        { supabase: SERVICE_CLIENT }
      );
    }
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(4);
  });
});
