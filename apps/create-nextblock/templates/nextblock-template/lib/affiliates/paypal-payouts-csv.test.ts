import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS,
  affiliatePayPalPayoutNote,
  buildAffiliatePayPalPayoutsCsv,
  escapeAffiliateCsvCell,
  formatAffiliatePayPalAmount,
  isAffiliatePayPalRecipientSafe,
  neutralizeAffiliateCsvFormula,
} from './paypal-payouts-csv';

/**
 * The PayPal Payouts upload file (02036): PayPal's web upload columns with no header row, and no
 * cell a spreadsheet would run as a formula.
 */

describe('spreadsheet safety', () => {
  it('neutralizes every cell that starts with a formula character, after any leading spaces', () => {
    for (const value of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd', '  =cmd', '=HYPERLINK("http://x")']) {
      expect(neutralizeAffiliateCsvFormula(value), JSON.stringify(value)).toBe(`'${value}`);
    }
    for (const value of ['jane@paypal.example', 'Maple Shop', '12.50', 'a=b', 'x-y', '']) {
      expect(neutralizeAffiliateCsvFormula(value), value).toBe(value);
    }
  });

  it('quotes a cell holding a comma, a quote or a line break, doubling inner quotes', () => {
    expect(escapeAffiliateCsvCell('Maple, Inc.')).toBe('"Maple, Inc."');
    expect(escapeAffiliateCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeAffiliateCsvCell('two\nlines')).toBe('"two\nlines"');
    expect(escapeAffiliateCsvCell('=1,2')).toBe(`"'=1,2"`);
    expect(escapeAffiliateCsvCell('plain')).toBe('plain');
  });
});

describe('amounts and notes', () => {
  it('writes major units with a dot, a comma for EUR and BRL, and no decimals for zero-decimal currencies', () => {
    expect(formatAffiliatePayPalAmount(12_345, 'USD')).toBe('123.45');
    expect(formatAffiliatePayPalAmount(100_50, 'CAD')).toBe('100.50');
    expect(formatAffiliatePayPalAmount(10_050, 'EUR')).toBe('100,50');
    expect(formatAffiliatePayPalAmount(10_050, 'brl')).toBe('100,50');
    expect(formatAffiliatePayPalAmount(1500, 'JPY')).toBe('1500');
    expect(formatAffiliatePayPalAmount(-5, 'USD')).toBe('0.00');
  });

  it('says what the money is for in the partner language, plainly and under 400 characters', () => {
    expect(affiliatePayPalPayoutNote('Maple Shop', 1, 'en')).toBe('Maple Shop partner commissions (1 order)');
    expect(affiliatePayPalPayoutNote('Maple   Shop ', 3, 'fr')).toBe('Commissions de partenaire Maple Shop (3 commandes)');
    expect(affiliatePayPalPayoutNote('x'.repeat(500), 2, 'en')).toHaveLength(400);
  });
});

describe('buildAffiliatePayPalPayoutsCsv', () => {
  const row = { email: 'jane@paypal.example', amountCents: 3000, commissionCount: 2, handle: 'jane', locale: 'en' };

  it("follows PayPal's upload format: no header, six columns, CRLF, one currency", () => {
    const { csv, count, truncated } = buildAffiliatePayPalPayoutsCsv(
      [row, { ...row, email: 'max@paypal.example', amountCents: 1999, commissionCount: 1, handle: 'max-the-longest-handle-allowed-here', locale: 'fr' }],
      { currency: 'cad', siteName: 'Maple Shop' }
    );
    expect(count).toBe(2);
    expect(truncated).toBe(false);
    expect(csv).toBe(
      'jane@paypal.example,30.00,CAD,jane,Maple Shop partner commissions (2 orders),PAYPAL\r\n' +
        'max@paypal.example,19.99,CAD,max-the-longest-handle-allowed,Commissions de partenaire Maple Shop (1 commande),PAYPAL\r\n'
    );
    for (const line of csv.trim().split('\r\n')) expect(line.split(',')).toHaveLength(6);
  });

  it('skips rows without an email or a positive amount, neutralizes a hostile site name, and stops at 5,000 rows', () => {
    const { csv } = buildAffiliatePayPalPayoutsCsv([{ ...row, email: '' }, { ...row, amountCents: 0 }, row], {
      currency: 'USD',
      siteName: '=cmd|"/c calc"!A1',
    });
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1);
    expect(csv).toContain(`"'=cmd|""/c calc""!A1 partner commissions (2 orders)"`);

    const many = Array.from({ length: AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS + 3 }, (_, index) => ({ ...row, email: `p${index}@paypal.example` }));
    const capped = buildAffiliatePayPalPayoutsCsv(many, { currency: 'USD', siteName: 'Maple Shop' });
    expect(capped.count).toBe(AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS);
    expect(capped.truncated).toBe(true);
    expect(buildAffiliatePayPalPayoutsCsv([], { currency: 'USD', siteName: 'Maple Shop' })).toEqual({ csv: '', count: 0, truncated: false, skipped: [] });
  });
});

describe('the recipient is never rewritten', () => {
  const row = { email: 'jane@paypal.example', amountCents: 3000, commissionCount: 2, handle: 'jane', locale: 'en' };

  it('takes an email only when escaping would leave it exactly as typed', () => {
    for (const email of ['jane@paypal.example', 'x+paypal@example.com', 'jean-luc@example.com', "o'brien@example.com"]) {
      expect(isAffiliatePayPalRecipientSafe(email), email).toBe(true);
    }
    // An apostrophe in front (formula) or quotes around (a comma) would make PayPal pay a different address.
    for (const email of ['+x@example.com', '-x@example.com', '=x@example.com', '@x@example.com', 'a,b@example.com', 'a"b@example.com', '', '  ', 'a b@example.com']) {
      expect(isAffiliatePayPalRecipientSafe(email), email).toBe(false);
    }
  });

  it('leaves a row whose email would need escaping out of the file and reports its handle', () => {
    const file = buildAffiliatePayPalPayoutsCsv(
      [
        { ...row, email: '+x@example.com', handle: 'plus' },
        { ...row, email: '-x@example.com', handle: 'minus' },
        row,
      ],
      { currency: 'USD', siteName: 'Maple Shop' }
    );
    expect(file.count).toBe(1);
    expect(file.skipped).toEqual(['plus', 'minus']);
    expect(file.csv).toBe('jane@paypal.example,30.00,USD,jane,Maple Shop partner commissions (2 orders),PAYPAL\r\n');
    expect(file.csv).not.toContain("'+x@example.com");
    expect(file.csv).not.toContain("'-x@example.com");
  });
});
