// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

import {
  PartnerRevenueCalculator,
  type PartnerRevenueCalculatorProduct,
  type PartnerRevenueCalculatorProps,
} from './PartnerRevenueCalculator';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

const BASE_PROPS: PartnerRevenueCalculatorProps = {
  currency: 'USD',
  compareRate: 50,
  compareRateLabel: '50',
  baseRate: 10,
  baseRateLabel: '10',
  referrals: { min: 1, max: 100, step: 1, initial: 10 },
  averageOrderValue: { min: 1_000, max: 50_000, step: 500, initial: 6_000 },
};

function withCopy(ui: ReactElement, locale = 'en') {
  return <AffiliatesCopyProvider locale={locale}>{ui}</AffiliatesCopyProvider>;
}

async function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  return container;
}

function slide(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PartnerRevenueCalculator', () => {
  it('compares the offered rate with the standard one, per year, in the store currency', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} />));
    // 10 sales x $60.00 x 50% = $300.00 a month = $3,600.00 a year; at 10%: $720.00; bonus $2,880.00.
    expect(html).toContain('Your yearly income at 50%');
    expect(html).toContain('$3,600.00');
    expect(html).toContain('At the standard 10% rate');
    expect(html).toContain('$720.00');
    expect(html).toContain('$2,880.00');
    expect(html).toContain('aria-valuetext="10 sales per month"');
    expect(html).toContain('aria-valuetext="$60.00 per order"');
    expect(html).toContain('min="1" max="100" step="1"');
  });

  it('shows one figure when there is no better rate to compare', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} baseRate={null} baseRateLabel={null} />));
    expect(html).toContain('$3,600.00');
    expect(html).not.toContain('At the standard');
    expect(html).not.toContain('Extra you lock in');
  });

  it('formats French amounts the Canadian way', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} currency="CAD" />, 'fr'));
    // The copy runtime keeps the French "%" on its rate's line with a no-break space.
    expect(html).toContain('Votre revenu annuel à 50\u00a0%');
    // fr-CA groups digits and separates the symbol with (narrow) no-break spaces: `\s` covers both.
    expect(html.replace(/\s/g, ' ')).toContain('3 600,00 $');
  });

  it('recomputes on every move and announces the result once the visitor stops', async () => {
    const container = await render(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} />));
    const [referrals] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    if (!referrals) throw new Error('no slider');
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('');

    await act(async () => slide(referrals, '20'));
    expect(referrals.getAttribute('aria-valuetext')).toBe('20 sales per month');
    expect(container.textContent).toContain('$7,200.00');
    expect(live?.textContent).toBe('');

    await act(async () => {
      await sleep(800);
    });
    expect(live?.textContent).toBe(
      'At 50%, you could earn $600.00 a month, or $7,200.00 a year. At 10%, you would earn $1,440.00 a year. That is $5,760.00 more.'
    );
  });

  it('keeps out-of-range values inside the slider bounds', async () => {
    const container = await render(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} />));
    const [referrals] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    if (!referrals) throw new Error('no slider');
    await act(async () => slide(referrals, '5000'));
    expect(referrals.getAttribute('aria-valuetext')).toBe('100 sales per month');
  });

  it('leads with the monthly income, the yearly one beside it', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} />));
    // 10 sales x $60.00 x 50% = $300.00 a month.
    expect(html).toContain('Your monthly income at 50%');
    expect(html).toContain('$300.00');
    expect(html.indexOf('Your monthly income at 50%')).toBeLessThan(html.indexOf('Your yearly income at 50%'));
  });
});

describe('PartnerRevenueCalculator: the product picker', () => {
  const PRODUCTS: PartnerRevenueCalculatorProduct[] = [
    { id: 'commerce', title: 'Commerce Pro', orderValueMinor: 25_000, monthlyMinor: 2_500, billing: 'year' },
    { id: 'cortex', title: 'Cortex AI', orderValueMinor: 25_000, monthlyMinor: null, billing: 'year' },
    { id: 'affiliates', title: 'Affiliates', orderValueMinor: 20_000, monthlyMinor: 2_000, billing: 'year' },
  ];
  const PICKER_PROPS: PartnerRevenueCalculatorProps = {
    ...BASE_PROPS,
    averageOrderValue: { min: 1_000, max: 70_000, step: 100, initial: 25_000 },
    products: PRODUCTS,
  };

  function radios(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  }

  it('lists each product with its yearly (and monthly) price and what one sale pays, then all of them together', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
    expect(html).toContain('What your referrals buy');
    expect(html).toContain('$250 a year or $25 a month');
    expect(html).toContain('$250 a year');
    expect(html).toContain('$200 a year or $20 a month');
    expect(html).toContain('All 3 together');
    expect(html).toContain('$700');
    // A yearly license says what a yearly sale pays (its monthly plan earns one month only).
    expect(html).toContain('You earn $125 a yearly sale');
    expect(html).toContain('You earn $350 a sale');
    expect(html).toContain('We use yearly prices. You earn on the first payment only, so a monthly plan earns on its first month.');
    expect(html).toContain('Extra you get by joining now');
    expect(html).not.toContain('lock in');
    // 10 sales x $250.00 x 50% = $1,250.00 a month, $15,000.00 a year.
    expect(html).toContain('$1,250.00');
    expect(html).toContain('$15,000.00');
  });

  it('starts on the product the slider starts at, and a pick moves the order value to its price', async () => {
    const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
    const [commerce, cortex, affiliates, all] = radios(container);
    if (!commerce || !cortex || !affiliates || !all) throw new Error('missing options');
    // Two products share a price: only the first one is picked.
    expect(commerce.checked).toBe(true);
    expect(cortex.checked).toBe(false);

    await act(async () => {
      cortex.click();
    });
    expect(cortex.checked).toBe(true);
    expect(commerce.checked).toBe(false);

    await act(async () => {
      all.click();
      await sleep(750);
    });
    expect(all.checked).toBe(true);
    const aov = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[1];
    expect(aov?.getAttribute('aria-valuetext')).toBe('$700.00 per order');
    // 10 x $700.00 x 50% = $3,500.00 a month.
    expect(container.textContent).toContain('$3,500.00');
  });

  it('drops the pick when the visitor drags the order value', async () => {
    const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
    const aov = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[1];
    if (!aov) throw new Error('no slider');
    await act(async () => slide(aov, '30000'));
    expect(radios(container).some((radio) => radio.checked)).toBe(false);
    expect(aov.getAttribute('aria-valuetext')).toBe('$300.00 per order');
  });

  it('changes at once with prefers-reduced-motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
      const affiliates = radios(container)[2];
      if (!affiliates) throw new Error('missing option');
      await act(async () => {
        affiliates.click();
      });
      const aov = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[1];
      expect(aov?.getAttribute('aria-valuetext')).toBe('$200.00 per order');
    } finally {
      window.matchMedia = original;
    }
  });

  describe('the first-view sweep', () => {
    type ObserverCallback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    let report: ObserverCallback | null = null;
    const originalObserver = globalThis.IntersectionObserver;

    beforeEach(() => {
      report = null;
      globalThis.IntersectionObserver = class {
        constructor(callback: ObserverCallback) {
          report = callback;
        }
        observe() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
        unobserve() {
          return undefined;
        }
        takeRecords() {
          return [];
        }
      } as unknown as typeof IntersectionObserver;
    });

    afterEach(() => {
      globalThis.IntersectionObserver = originalObserver;
    });

    function sliders(container: HTMLElement) {
      const [referrals, aov] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
      if (!referrals || !aov) throw new Error('no sliders');
      return { referrals, aov };
    }

    async function armOffScreen() {
      await act(async () => {
        report?.([{ isIntersecting: false, boundingClientRect: { top: window.innerHeight + 500 } as DOMRectReadOnly }]);
      });
    }

    it('drops to the minimum off screen, then sweeps up to the starting values once in view', async () => {
      const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
      await armOffScreen();
      expect(sliders(container).referrals.getAttribute('aria-valuetext')).toBe('1 sale per month');
      await act(async () => {
        report?.([{ isIntersecting: true, boundingClientRect: { top: 200 } as DOMRectReadOnly }]);
        await sleep(1_600);
      });
      expect(sliders(container).referrals.getAttribute('aria-valuetext')).toBe('10 sales per month');
      expect(sliders(container).aov.getAttribute('aria-valuetext')).toBe('$250.00 per order');
      // The automatic sweep never speaks: only a visitor's change is announced.
      expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('');
    });

    it('never leaves the hidden minimum behind when the visitor acts before the sweep starts', async () => {
      const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
      await armOffScreen();
      const affiliates = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2];
      await act(async () => {
        affiliates?.click();
        await sleep(750);
      });
      // The pick sets the order value; the sales count is the starting one, not the hidden 1.
      expect(sliders(container).aov.getAttribute('aria-valuetext')).toBe('$200.00 per order');
      expect(sliders(container).referrals.getAttribute('aria-valuetext')).toBe('10 sales per month');
    });

    it('a slider moved while armed restores the other slider to its starting value', async () => {
      const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
      await armOffScreen();
      await act(async () => slide(sliders(container).referrals, '20'));
      expect(sliders(container).referrals.getAttribute('aria-valuetext')).toBe('20 sales per month');
      expect(sliders(container).aov.getAttribute('aria-valuetext')).toBe('$250.00 per order');
    });

    it('leaves the figures alone when the calculator is already on screen', async () => {
      const container = await render(withCopy(<PartnerRevenueCalculator {...PICKER_PROPS} />));
      await act(async () => {
        report?.([{ isIntersecting: true, boundingClientRect: { top: 100 } as DOMRectReadOnly }]);
      });
      expect(sliders(container).referrals.getAttribute('aria-valuetext')).toBe('10 sales per month');
    });
  });

  it('shows no picker for a store with no product to show', () => {
    const html = renderToStaticMarkup(withCopy(<PartnerRevenueCalculator {...BASE_PROPS} products={[]} />));
    expect(html).not.toContain('What your referrals buy');
    expect(html).not.toContain('type="radio"');
  });

  it('says "Both together" for two products, and warns a monthly-only catalog that only the first month earns', () => {
    const monthly: PartnerRevenueCalculatorProduct[] = [
      { id: 'a', title: 'Plan A', orderValueMinor: 2_500, monthlyMinor: null, billing: 'month' },
      { id: 'b', title: 'Plan B', orderValueMinor: 1_500, monthlyMinor: null, billing: 'month' },
    ];
    const html = renderToStaticMarkup(
      withCopy(<PartnerRevenueCalculator {...BASE_PROPS} averageOrderValue={{ min: 1_000, max: 50_000, step: 100, initial: 2_500 }} products={monthly} />)
    );
    expect(html).toContain('Both together');
    expect(html).not.toContain('All 2 together');
    expect(html).toContain('$25 a month');
    expect(html).toContain('You earn on the first payment only, so a monthly plan earns on its first month.');
    expect(html).not.toContain('We use yearly prices');
  });
});
