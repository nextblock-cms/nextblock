import { describe, expect, it } from 'vitest';

import {
  computeTrialExpiry,
  evaluateTrialEligibility,
  formatFreemiusTimestamp,
  pickTrialPricing,
} from './freemius-trial-provision';

describe('formatFreemiusTimestamp', () => {
  it('renders the UTC "YYYY-MM-DD HH:mm:ss" form Freemius expects', () => {
    expect(formatFreemiusTimestamp(new Date('2026-09-17T15:04:05.678Z'))).toBe('2026-09-17 15:04:05');
  });
});

describe('computeTrialExpiry', () => {
  it('adds the trial days and falls back to 30 for nonsense', () => {
    const now = new Date('2026-09-17T00:00:00Z');

    expect(computeTrialExpiry(now, 30).toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(computeTrialExpiry(now, 7.9).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(computeTrialExpiry(now, 0).toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(computeTrialExpiry(now, Number.NaN).toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });
});

describe('pickTrialPricing', () => {
  it('prefers the visible tier with the smallest site quota', () => {
    expect(
      pickTrialPricing([
        { id: '3', licenses: null },
        { id: '2', licenses: 5 },
        { id: '1', licenses: 1 },
        { id: '0', licenses: 1, is_hidden: true },
      ])
    ).toEqual({ id: '1', licenses: 1 });
  });

  it('falls back to hidden tiers when nothing is visible and to null when nothing has an id', () => {
    expect(pickTrialPricing([{ id: 9, licenses: 3, is_hidden: true }])).toEqual({ id: 9, licenses: 3, is_hidden: true });
    expect(pickTrialPricing([{ licenses: 1 }])).toBeNull();
    expect(pickTrialPricing([])).toBeNull();
  });
});

describe('evaluateTrialEligibility', () => {
  it('refuses when the email already holds a license for the product, whatever its state', () => {
    expect(
      evaluateTrialEligibility({ existingLicenses: [{ id: 1, plugin_id: 28609 }], productId: '28609' })
    ).toEqual({ ok: false, reason: 'already_licensed' });
    expect(
      evaluateTrialEligibility({ existingLicenses: [{ id: 1, plugin_id: null }], productId: '28609' })
    ).toEqual({ ok: false, reason: 'already_licensed' });
  });

  it('allows a first trial, including for someone who only owns another product', () => {
    expect(evaluateTrialEligibility({ existingLicenses: [], productId: '28609' })).toEqual({ ok: true });
    expect(
      evaluateTrialEligibility({ existingLicenses: [{ id: 1, plugin_id: '24851' }], productId: '28609' })
    ).toEqual({ ok: true });
  });
});
