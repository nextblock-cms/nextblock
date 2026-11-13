import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The coupons screen on the public sandbox: syncCouponToFreemius sends nothing to Freemius there
 * (freemius-coupons.test.ts), so the card says so in place of the sync explanation. Off the
 * sandbox it renders exactly as before.
 */

/** A client that answers the screen's three list reads (coupons, products, currencies). */
function fakeServiceClient() {
  const rows: Record<string, unknown[]> = {
    coupons: [],
    products: [],
    currencies: [{ code: 'USD', is_default: true }],
  };
  return {
    from(table: string) {
      const query = {
        select: () => query,
        order: () => query,
        or: () => query,
        eq: () => query,
        then: <T,>(resolve: (value: { data: unknown[]; error: null }) => T, reject?: (reason: unknown) => T) =>
          Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject),
      };
      return query;
    },
  };
}

vi.mock('@nextblock-cms/db/server', async () => {
  // The real predicate (a dependency-free module): the env stub drives the note.
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../../../../db/src/lib/config-resolve'
  );
  return {
    createClient: () => ({}),
    getServiceRoleSupabaseClient: () => fakeServiceClient(),
    isSandboxEnvironment,
  };
});
vi.mock('./actions', () => ({
  createCouponAction: vi.fn(),
  deleteCouponAction: vi.fn(),
  syncCouponAction: vi.fn(),
  toggleCouponActiveAction: vi.fn(),
}));
vi.mock('./CreateCouponDialog', () => ({ CreateCouponDialog: () => null }));

import { CouponsPage } from './CouponsPage';

const SYNC_EXPLANATION =
  '<div class="text-sm text-muted-foreground">Freemius sync runs when a coupon is created, updated, toggled, or manually resynced.</div>';
const SANDBOX_NOTE =
  '<div class="text-sm text-muted-foreground">Coupons aren&#x27;t sent to Freemius in the sandbox: its checkout is simulated.</div>';

async function render(): Promise<string> {
  return renderToStaticMarkup(await CouponsPage({ searchParams: {} }));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CouponsPage Freemius note', () => {
  it('on the sandbox says coupons are not sent to Freemius, in place of the sync explanation', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    const markup = await render();

    expect(markup).toContain(SANDBOX_NOTE);
    expect(markup).not.toContain('Freemius sync runs when');
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'with NEXT_PUBLIC_IS_SANDBOX=%j explains the Freemius sync as before',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

      const markup = await render();

      expect(markup).toContain(SYNC_EXPLANATION);
      expect(markup).not.toContain('sent to Freemius in the sandbox');
    }
  );
});
