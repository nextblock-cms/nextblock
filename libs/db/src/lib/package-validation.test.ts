import { describe, expect, it } from 'vitest';

import {
  PACKAGE_RENEWAL_GRACE_MS,
  isPackageActivationRowValid,
  isTrialActivation,
  resolvePackageActivationExpiry,
} from './package-validation';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOUR = 60 * 60_000;

const at = (time: number) => new Date(time).toISOString();

describe('resolvePackageActivationExpiry', () => {
  it('takes the earliest date the row knows', () => {
    expect(
      resolvePackageActivationExpiry({
        expiration: '2027-03-01 00:00:00',
        nextblock: { expiration: '2027-01-01 00:00:00', trial_ends_at: '2027-02-01 00:00:00' },
      })
    ).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('is null without a date, and for anything that is not an object', () => {
    expect(resolvePackageActivationExpiry({ nextblock: { expiration: null, trial_ends_at: null } })).toBeNull();
    expect(resolvePackageActivationExpiry(null)).toBeNull();
    expect(resolvePackageActivationExpiry('2027-01-01')).toBeNull();
  });
});

describe('isTrialActivation', () => {
  it('reads the provenance flag only', () => {
    expect(isTrialActivation({ nextblock: { is_trial: true } })).toBe(true);
    expect(isTrialActivation({ nextblock: { is_trial: false } })).toBe(false);
    expect(isTrialActivation({ is_trial: true })).toBe(false);
    expect(isTrialActivation(null)).toBe(false);
  });
});

describe('isPackageActivationRowValid', () => {
  it('counts an active row with no known expiry', () => {
    expect(isPackageActivationRowValid({ meta: {}, status: 'active' }, NOW)).toBe(true);
    expect(isPackageActivationRowValid({ status: 'active' }, NOW)).toBe(true);
  });

  it('never counts a row that is not active, whatever its dates say', () => {
    expect(isPackageActivationRowValid({ meta: {}, status: 'expired' }, NOW)).toBe(false);
    expect(
      isPackageActivationRowValid({ meta: { nextblock: { expiration: at(NOW + HOUR) } }, status: 'expired' }, NOW)
    ).toBe(false);
  });

  it('carries a paid license through its renewal grace, and no further', () => {
    const meta = { nextblock: { expiration: at(NOW) } };

    expect(isPackageActivationRowValid({ meta, status: 'active' }, NOW - HOUR)).toBe(true);
    expect(isPackageActivationRowValid({ meta, status: 'active' }, NOW + PACKAGE_RENEWAL_GRACE_MS - HOUR)).toBe(true);
    expect(isPackageActivationRowValid({ meta, status: 'active' }, NOW + PACKAGE_RENEWAL_GRACE_MS)).toBe(false);
  });

  it('ends a trial on its date', () => {
    const meta = { nextblock: { is_trial: true, trial_ends_at: at(NOW) } };

    expect(isPackageActivationRowValid({ meta, status: 'active' }, NOW - HOUR)).toBe(true);
    expect(isPackageActivationRowValid({ meta, status: 'active' }, NOW)).toBe(false);
  });
});
