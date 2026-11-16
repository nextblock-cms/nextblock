import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The promotions actions hand CSV work to lib/promotions/server.ts, which reads and writes products
 * with the service role; an applied sale import also pushes each Freemius product's sale coupon
 * (SALE<SKU>, up to 100% off) through the developer key pair, which reaches every product of the
 * Freemius account. Until 2026-11-13 they authorized through a local assertAdmin() that read the
 * role only, so an ADMIN password without the second factor could run them (a server action never
 * meets the CMS layout's 2FA redirect). Each action now starts with requireCmsAdmin(); the import
 * lib is a spy here, and it is the only way these actions reach Freemius or the service role.
 */

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  twoFactorStatus: 'satisfied' as string,
  serviceClientCreated: vi.fn(),
  applyPromotionsImport: vi.fn(),
  dryRunPromotionsImport: vi.fn(),
  exportPromotionsCsv: vi.fn(),
  getPromotionsTemplateCsv: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
        }),
      }),
    }),
  }),
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientCreated();
    return {};
  },
}));
// The second factor is driven per test; its own logic is covered by lib/auth/cms-actor.test.ts.
vi.mock('../../../lib/auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactorStatus, userId: mocks.user?.id ?? null, mfaType: null }),
}));
vi.mock('../../../lib/promotions/server', () => ({
  applyPromotionsImport: mocks.applyPromotionsImport,
  dryRunPromotionsImport: mocks.dryRunPromotionsImport,
  exportPromotionsCsv: mocks.exportPromotionsCsv,
  getPromotionsTemplateCsv: mocks.getPromotionsTemplateCsv,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  applyPromotionsImportAction,
  dryRunPromotionsImportAction,
  exportPromotionsAction,
  getPromotionsTemplateAction,
} from './actions';

const CSV = 'sku,sale_price\nPRO,0\n';
const SUMMARY = { errors: [], warnings: [], preview: [], applied: 1, skipped: 0 };

const ACTIONS: ReadonlyArray<readonly [string, () => Promise<{ success: boolean; error?: string }>]> = [
  ['getPromotionsTemplateAction', () => getPromotionsTemplateAction('sale')],
  ['exportPromotionsAction', () => exportPromotionsAction('sale')],
  ['dryRunPromotionsImportAction', () => dryRunPromotionsImportAction({ kind: 'sale', content: CSV })],
  ['applyPromotionsImportAction', () => applyPromotionsImportAction({ kind: 'sale', content: CSV })],
];

function expectNothingPrivilegedRan() {
  expect(mocks.applyPromotionsImport).not.toHaveBeenCalled();
  expect(mocks.dryRunPromotionsImport).not.toHaveBeenCalled();
  expect(mocks.exportPromotionsCsv).not.toHaveBeenCalled();
  expect(mocks.getPromotionsTemplateCsv).not.toHaveBeenCalled();
  expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.twoFactorStatus = 'satisfied';
  mocks.applyPromotionsImport.mockResolvedValue(SUMMARY);
  mocks.dryRunPromotionsImport.mockResolvedValue(SUMMARY);
  mocks.exportPromotionsCsv.mockResolvedValue('sku\nPRO\n');
  mocks.getPromotionsTemplateCsv.mockReturnValue('sku\n');
});

describe('promotions actions authorize through requireCmsAdmin() before anything else', () => {
  for (const status of ['totp_required', 'email_required']) {
    it.each(ACTIONS)(
      `%s refuses an ADMIN whose second factor is still pending (${status}), before the import lib or Freemius`,
      async (_name, run) => {
        mocks.twoFactorStatus = status;

        await expect(run()).resolves.toEqual({ success: false, error: 'Unauthorized' });
        expectNothingPrivilegedRan();
      }
    );
  }

  it.each(ACTIONS)('%s refuses a WRITER with Forbidden', async (_name, run) => {
    mocks.role = 'WRITER';

    await expect(run()).resolves.toEqual({ success: false, error: 'Forbidden' });
    expectNothingPrivilegedRan();
  });

  it.each(ACTIONS)('%s refuses an anonymous caller', async (_name, run) => {
    mocks.user = null;
    mocks.role = null;

    await expect(run()).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expectNothingPrivilegedRan();
  });
});

describe('an ADMIN who passed the second factor keeps the existing behaviour', () => {
  it('applies the import, then revalidates the promotions and products screens', async () => {
    await expect(applyPromotionsImportAction({ kind: 'sale', content: CSV })).resolves.toEqual({
      success: true,
      summary: SUMMARY,
    });
    expect(mocks.applyPromotionsImport).toHaveBeenCalledWith('sale', CSV);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/promotions');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/products');
  });

  it('validates, exports and builds the template', async () => {
    await expect(dryRunPromotionsImportAction({ kind: 'price_change', content: CSV })).resolves.toEqual({
      success: true,
      summary: SUMMARY,
    });
    expect(mocks.dryRunPromotionsImport).toHaveBeenCalledWith('price_change', CSV);

    await expect(exportPromotionsAction('sale')).resolves.toMatchObject({ success: true, content: 'sku\nPRO\n' });
    await expect(getPromotionsTemplateAction('price_change')).resolves.toMatchObject({
      success: true,
      fileName: 'nextblock-price-changes-import-template.csv',
      content: 'sku\n',
    });
  });
});
