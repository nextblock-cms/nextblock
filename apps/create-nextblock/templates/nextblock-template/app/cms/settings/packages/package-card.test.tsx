import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils';

/**
 * A package without a Freemius product (`fm_product_id: ''`, as Affiliates was until product 43273
 * existed) must never offer a trial or a checkout: the overlay would open for product '' and fail.
 * Nor can a license key activate it (activateLicenseKeyWithFreemius skips a package without a
 * Freemius product), so its card must not invite one: it points at the activation guide. No
 * package is in that state today, so these tests build one.
 */

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), deactivatePackage: vi.fn() }));

vi.mock('../../../actions/package-actions', () => ({ deactivatePackage: mocks.deactivatePackage }));
vi.mock('./PackageCheckoutDialog', () => ({
  PackageCheckoutDialog: (props: unknown) => {
    mocks.dialog(props);
    return null;
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { PackageCard } from './package-card';

const UNSOLD = { ...NEXTBLOCK_PACKAGES.affiliates, fm_product_id: '', fm_plan_id: '' } as unknown as typeof NEXTBLOCK_PACKAGES.affiliates;

describe('PackageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the free trial and mounts the checkout dialog for a package the dashboard sells', () => {
    const html = renderToStaticMarkup(<PackageCard isActive={false} pkg={NEXTBLOCK_PACKAGES['cortex-ai']} />);

    expect(html).toContain('Start free 30-day trial');
    expect(html).toContain('Or purchase on nextblock.dev');
    expect(mocks.dialog).toHaveBeenCalledTimes(1);
  });

  it('offers no trial, checkout or license-key activation for a package without a Freemius product', () => {
    const html = renderToStaticMarkup(<PackageCard isActive={false} pkg={UNSOLD} />);

    expect(html).toContain('NextBlock Affiliates &amp; Creator Storefronts');
    expect(html).not.toContain('Start free');
    expect(html).not.toContain('Buy license');
    expect(html).not.toContain('no credit card required');
    expect(html).toContain('Not sold in the dashboard yet');
    expect(html).not.toContain('Paste its license key');
    expect(html).toContain('A license key cannot activate it until it goes on sale');
    expect(html).toContain(
      'href="https://github.com/nextblock-cms/nextblock/blob/master/docs/15-AFFILIATES-AND-STOREFRONTS.md"'
    );
    expect(html).toContain('rel="noopener noreferrer"');
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  // 2026-10-29: Affiliates is a Commerce Pro add-on; the card must never sell it on its own.
  const COMMERCE = { id: 'ecommerce', name: NEXTBLOCK_PACKAGES.ecommerce.name };

  it('names the add-on base on every Affiliates card', () => {
    const html = renderToStaticMarkup(<PackageCard isActive={false} pkg={NEXTBLOCK_PACKAGES.affiliates} />);
    expect(html).toContain('Add-on for Commerce Pro.');
    expect(html).not.toContain('Requires Commerce Pro');
  });

  it('asks for Commerce Pro first while it is not active', () => {
    const html = renderToStaticMarkup(
      <PackageCard isActive={false} missingRequirements={[COMMERCE]} pkg={NEXTBLOCK_PACKAGES.affiliates} />
    );
    expect(html).toContain('Requires Commerce Pro. Activate Commerce Pro first.');
    expect(html).not.toContain('Start free');
  });

  it('offers no trial or checkout for the add-on until its base is active', () => {
    const blocked = renderToStaticMarkup(
      <PackageCard isActive={false} missingRequirements={[COMMERCE]} pkg={NEXTBLOCK_PACKAGES.affiliates} />
    );
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Requires Commerce Pro<\/button>/);
    expect(blocked).not.toContain('Start free');
    expect(mocks.dialog).not.toHaveBeenCalled();

    const open = renderToStaticMarkup(
      <PackageCard isActive={false} missingRequirements={[]} pkg={NEXTBLOCK_PACKAGES.affiliates} />
    );
    expect(open).toContain('Start free 30-day trial');
    expect(open).toContain('$200/year or $20/month');
    expect(mocks.dialog).toHaveBeenCalledTimes(1);
  });

  it('shows an active add-on as paused while its base is off', () => {
    const html = renderToStaticMarkup(
      <PackageCard isActive licenseKey="key-9999" missingRequirements={[COMMERCE]} pkg={NEXTBLOCK_PACKAGES.affiliates} />
    );
    expect(html).toContain('Paused');
    expect(html).toContain('Paused until Commerce Pro is active: nothing runs, and its data is kept.');
    expect(html).toContain('Deactivate License');
  });

  it('still shows the license and the deactivate button once such a package is active', () => {
    const html = renderToStaticMarkup(<PackageCard isActive licenseKey="sandbox-affiliates-1234" pkg={UNSOLD} />);

    expect(html).toContain('Active');
    expect(html).toContain('•••• 1234');
    expect(html).toContain('Deactivate License');
    expect(html).not.toContain('Not sold in the dashboard yet');
    expect(mocks.dialog).not.toHaveBeenCalled();
  });
});
