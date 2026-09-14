import { describe, expect, it } from 'vitest';

import { evaluateFreemiusLicenseClaim, parseFreemiusTimestamp } from './freemius-license-claim';

const NOW = new Date('2026-09-14T15:00:00Z');

const request = {
  email: 'Owner@Example.com',
  kind: 'trial' as const,
  licenseId: '9001',
  productId: '28609',
  userId: '42',
};

const license = {
  activated: 0,
  created: '2026-09-14 14:50:00',
  expiration: '2026-10-14 14:50:00',
  id: 9001,
  is_cancelled: false,
  plan_id: 47122,
  plugin_id: 28609,
  secret_key: 'sk_test_key',
  user_id: 42,
};

const user = { email: 'owner@example.com', id: 42 };

describe('evaluateFreemiusLicenseClaim', () => {
  it('accepts the buyer claiming their own fresh, unactivated license', () => {
    expect(evaluateFreemiusLicenseClaim({ license, now: NOW, request, user })).toEqual({ ok: true });
  });

  it('refuses a license that is not the one asked for, or belongs to another product', () => {
    expect(evaluateFreemiusLicenseClaim({ license: null, now: NOW, request, user })).toEqual({
      ok: false,
      reason: 'license_not_found',
    });
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, id: 9002 }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'license_not_found' });
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, plugin_id: 24851 }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'product_mismatch' });
  });

  it('checks freshness before any identity detail, so an old license reveals nothing', () => {
    const old = { ...license, created: '2026-09-14 13:00:00', plugin_id: 24851, user_id: 7 };

    expect(evaluateFreemiusLicenseClaim({ license: old, now: NOW, request, user })).toEqual({
      ok: false,
      reason: 'too_old',
    });
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, created: '2026-09-14 13:00:00' }, maxAgeMinutes: 180, now: NOW, request, user })
    ).toEqual({ ok: true });
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, created: null }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'too_old' });
  });

  it('binds the claim to the buyer account and email, and requires a user id', () => {
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, user_id: 7 }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'user_mismatch' });
    expect(
      evaluateFreemiusLicenseClaim({ license, now: NOW, request: { ...request, userId: '' }, user })
    ).toEqual({ ok: false, reason: 'user_mismatch' });
    expect(
      evaluateFreemiusLicenseClaim({ license, now: NOW, request, user: { email: 'someone@else.com', id: 42 } })
    ).toEqual({ ok: false, reason: 'email_mismatch' });
    expect(evaluateFreemiusLicenseClaim({ license, now: NOW, request, user: null })).toEqual({
      ok: false,
      reason: 'email_mismatch',
    });
  });

  it('refuses a second claim once the license has an activation', () => {
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, activated: 1 }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'already_activated' });
  });

  it('refuses cancelled licenses and licenses without a key', () => {
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, is_cancelled: true }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'cancelled' });
    expect(
      evaluateFreemiusLicenseClaim({ license: { ...license, secret_key: undefined }, now: NOW, request, user })
    ).toEqual({ ok: false, reason: 'no_key' });
  });
});

describe('parseFreemiusTimestamp', () => {
  it('reads zone-less Freemius timestamps as UTC and keeps explicit zones', () => {
    expect(parseFreemiusTimestamp('2026-09-14 14:50:00')).toBe(Date.parse('2026-09-14T14:50:00Z'));
    expect(parseFreemiusTimestamp('2026-09-14T14:50:00+02:00')).toBe(Date.parse('2026-09-14T14:50:00+02:00'));
    expect(parseFreemiusTimestamp('')).toBeNull();
    expect(parseFreemiusTimestamp('not a date')).toBeNull();
  });
});
