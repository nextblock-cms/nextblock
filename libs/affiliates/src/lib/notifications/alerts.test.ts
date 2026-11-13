import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
} from '../core/constants';
import type { AffiliateAdminLifecycleEvent, AffiliateEmailData } from '../core/types';
import { buildAffiliateSystemAlert } from './alerts';

const ADMIN_EVENTS = Object.keys(AFFILIATE_ALERT_TYPES) as AffiliateAdminLifecycleEvent[];

function data(overrides: Partial<AffiliateEmailData> = {}): AffiliateEmailData {
  return {
    locale: 'en',
    siteName: 'Maple Shop',
    siteUrl: 'https://maple.shop',
    recipientName: null,
    handle: 'jane-doe',
    displayName: 'Jane Doe',
    storefrontUrl: 'https://maple.shop/partners/jane-doe',
    portalUrl: 'https://maple.shop/portal/retailer',
    cmsUrl: 'https://maple.shop/cms/affiliates',
    tierName: 'Founding Ambassador',
    spotsRemaining: 3,
    amountLabel: '$25.00',
    reason: 'balance_insufficient',
    orderId: 'b9d0c3a4-1234-4abc-8def-0123456789ab',
    transferId: 'tr_123',
    ...overrides,
  };
}

const EXPECTED_ACTION_URL: Record<AffiliateAdminLifecycleEvent, string> = {
  SIGNED_UP: AFFILIATE_CMS_PATH,
  PROFILE_COMPLETED: AFFILIATE_CMS_PATH,
  PAYOUT_CONFIGURED: AFFILIATE_CMS_PATH,
  PAGE_SUBMITTED: AFFILIATE_CMS_APPROVALS_PATH,
  PAYOUT_FAILED: AFFILIATE_CMS_PAYOUTS_PATH,
  REFUND_AFTER_PAYOUT: AFFILIATE_CMS_PAYOUTS_PATH,
};

describe('buildAffiliateSystemAlert', () => {
  for (const event of ADMIN_EVENTS) {
    it(`builds the ${event} alert with a CMS action`, () => {
      const alert = buildAffiliateSystemAlert(event, data());
      expect(alert.alert_type).toBe(AFFILIATE_ALERT_TYPES[event]);
      expect(alert.title.trim()).not.toBe('');
      expect(alert.message.trim()).not.toBe('');
      expect(alert.title).not.toMatch(/[\r\n]/);
      expect(alert.message).not.toMatch(/[\r\n]/);
      expect(alert.metadata.action_url).toBe(EXPECTED_ACTION_URL[event]);
      expect(alert.metadata.action_url.startsWith('/cms/affiliates')).toBe(true);
      expect(alert.metadata.action_url).not.toContain('//');
      expect(alert.metadata.action_label.trim()).not.toBe('');
      expect(alert.metadata.action_label.length).toBeLessThanOrEqual(60);
    });
  }

  it('describes a signup with its tier and the spots left', () => {
    expect(buildAffiliateSystemAlert('SIGNED_UP', data()).message).toBe(
      'Jane Doe joined the affiliate program on the Founding Ambassador tier. 3 spots left in that tier.'
    );
    expect(buildAffiliateSystemAlert('SIGNED_UP', data({ spotsRemaining: 1 })).message).toContain('1 spot left in that tier.');
    expect(buildAffiliateSystemAlert('SIGNED_UP', data({ spotsRemaining: 0 })).message).toContain('That tier is now full.');
    expect(buildAffiliateSystemAlert('SIGNED_UP', data({ spotsRemaining: null, tierName: null })).message).toBe(
      'Jane Doe joined the affiliate program.'
    );
    expect(buildAffiliateSystemAlert('SIGNED_UP', data()).metadata).toMatchObject({
      handle: 'jane-doe',
      display_name: 'Jane Doe',
      tier_name: 'Founding Ambassador',
      spots_remaining: 3,
    });
  });

  it('matches the database copy for a refund after payout (02030)', () => {
    const alert = buildAffiliateSystemAlert('REFUND_AFTER_PAYOUT', data());
    expect(alert.title).toBe('Refund after an affiliate payout');
    expect(alert.message).toBe(
      'Order b9d0c3a4-1234-4abc-8def-0123456789ab was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.'
    );
    expect(alert.metadata).toMatchObject({ action_url: '/cms/affiliates/payouts', action_label: 'Review payouts' });
    expect(alert.metadata).not.toHaveProperty('payout_method');
  });

  it('tells the admin to recover the amount after a refund of a commission paid by hand (02036), never to deduct it', () => {
    const alert = buildAffiliateSystemAlert('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', transferId: null }));
    expect(alert.message).toBe(
      'Order b9d0c3a4-1234-4abc-8def-0123456789ab was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.'
    );
    expect(alert.metadata).toMatchObject({ payout_method: 'manual', action_url: '/cms/affiliates/payouts' });
    expect(alert.metadata).not.toHaveProperty('payout_status');
    expect(buildAffiliateSystemAlert('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', orderId: null })).message).toBe(
      'An order was refunded after its commission was paid or queued. Recover the amount from the partner, for example by asking them to send it back.'
    );
    expect(alert.message).not.toMatch(/deduct/i);
  });

  it('asks to cancel and prepare again when the manual payout is only prepared (02036)', () => {
    const alert = buildAffiliateSystemAlert('REFUND_AFTER_PAYOUT', data({ payoutMethod: 'manual', payoutPrepared: true, transferId: null }));
    expect(alert.message).toBe(
      'Order b9d0c3a4-1234-4abc-8def-0123456789ab was refunded after its commission was paid or queued. Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.'
    );
    expect(alert.metadata).toMatchObject({ payout_method: 'manual', payout_status: 'PROCESSING' });
    // "prepared" means nothing for a Stripe payout
    expect(buildAffiliateSystemAlert('REFUND_AFTER_PAYOUT', data({ payoutPrepared: true })).message).toContain('Reverse the transfer in Stripe');
  });

  it('gives the amount and reason of a failed payout', () => {
    const alert = buildAffiliateSystemAlert('PAYOUT_FAILED', data());
    expect(alert.message).toBe('The payout of $25.00 to Jane Doe failed. Reason: balance_insufficient');
    expect(alert.metadata).toMatchObject({ amount_label: '$25.00', reason: 'balance_insufficient', transfer_id: 'tr_123' });
  });

  it('keeps hostile values on one line and never lets them choose the action URL', () => {
    const alert = buildAffiliateSystemAlert(
      'PAGE_SUBMITTED',
      data({ displayName: 'Jane\r\nInjected line', cmsUrl: 'https://evil.example/', handle: null })
    );
    expect(alert.message).toBe('Jane Injected line submitted their storefront for approval.');
    expect(alert.metadata.action_url).toBe(AFFILIATE_CMS_APPROVALS_PATH);
    expect(alert.metadata).not.toHaveProperty('handle');
    expect(buildAffiliateSystemAlert('PROFILE_COMPLETED', data({ displayName: null, handle: null })).message).toBe(
      'A partner completed their partner profile.'
    );
  });

  it('refuses a partner event', () => {
    expect(() => buildAffiliateSystemAlert('PAGE_PUBLISHED' as AffiliateAdminLifecycleEvent, data())).toThrow(TypeError);
    expect(() => buildAffiliateSystemAlert('toString' as AffiliateAdminLifecycleEvent, data())).toThrow(TypeError);
  });
});
