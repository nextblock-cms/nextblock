import { describe, expect, it } from 'vitest';
import { formatAffiliateMoney } from '@nextblock-cms/affiliates';

import { formatPartnersMoney, formatPartnersWholeMoney } from './partners-money';

/**
 * The `/partners` money formats: the cents form is exactly what the rest of the shop shows
 * (`formatAffiliateMoney`), and both forms convert minor units with the app's own factor, never
 * Intl's fraction digits (which differ for ISK, IQD, KWD, BHD…).
 */
describe('partners money', () => {
  it('matches formatAffiliateMoney exactly in the cents form', () => {
    for (const [amount, currency, locale] of [
      [360_000, 'USD', 'en'],
      [360_000, 'CAD', 'fr'],
      [1_500, 'JPY', 'en'],
      [25_000, 'KWD', 'en'],
      [100_000, 'ISK', 'fr'],
    ] as const) {
      expect(formatPartnersMoney(amount, currency, locale)).toBe(formatAffiliateMoney(amount, currency, locale));
    }
  });

  it('drops the cents of a whole amount, and keeps them otherwise', () => {
    expect(formatPartnersWholeMoney(125_000, 'USD', 'en')).toBe('$1,250');
    expect(formatPartnersWholeMoney(12_550, 'USD', 'en')).toBe('$125.50');
    expect(formatPartnersWholeMoney(125_000, 'USD', 'fr').replace(/\s/g, ' ')).toBe('1 250 $ US');
  });

  it('uses the app minor-unit factor: ISK and KWD read the same amount as the cents form', () => {
    // Intl separates a currency code with a no-break space: compare with plain spaces.
    const plain = (text: string) => text.replace(/\s/g, ' ');
    // 25,000 minor units of KWD is 250.000 everywhere else in the shop: the whole form must say 250.
    expect(plain(formatPartnersWholeMoney(25_000, 'KWD', 'en'))).toBe('KWD 250');
    // ISK is not in the app's zero-decimal list: 100,000 minor units is ISK 1,000.
    expect(plain(formatPartnersWholeMoney(100_000, 'ISK', 'en'))).toBe('ISK 1,000');
    // A true zero-decimal currency: 1,500 minor units is ¥1,500.
    expect(formatPartnersWholeMoney(1_500, 'JPY', 'en')).toBe('¥1,500');
  });
});
