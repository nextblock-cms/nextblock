import { describe, expect, it } from 'vitest';
import { NEXTBLOCK_PACKAGES } from '@nextblock-cms/utils/nextblock-packages';

import { findAddonBaseProduct, findCartAddonGaps, getProductAddonBases } from './product-addons';

/**
 * The Affiliates license is an add-on for Commerce Pro: the storefront tells a buyer wherever it can
 * be bought (2026-11-19). Products are recognized by their Freemius product id, so only the vendor
 * store's license products are add-ons; any other store's products never are.
 */

const AFFILIATES = NEXTBLOCK_PACKAGES.affiliates.fm_product_id;
const COMMERCE = NEXTBLOCK_PACKAGES.ecommerce.fm_product_id;
const CORTEX = NEXTBLOCK_PACKAGES['cortex-ai'].fm_product_id;

const line = (id: string, freemius_product_id?: string | null, title = `Product ${id}`) => ({ id, title, freemius_product_id });

describe('getProductAddonBases', () => {
  it('names Commerce Pro for the Affiliates license, by its Freemius product id', () => {
    expect(getProductAddonBases({ freemius_product_id: AFFILIATES })).toEqual([
      { freemiusProductId: COMMERCE, name: 'NextBlock™ Commerce Pro', shortName: 'Commerce Pro' },
    ]);
  });

  it('finds nothing for Commerce Pro, Cortex AI, another store’s Freemius product or a product without one', () => {
    for (const product of [
      { freemius_product_id: COMMERCE },
      { freemius_product_id: CORTEX },
      { freemius_product_id: '12345' },
      { freemius_product_id: null },
      {},
      null,
      undefined,
    ]) {
      expect(getProductAddonBases(product)).toEqual([]);
    }
  });
});

describe('findCartAddonGaps', () => {
  it('names the Affiliates line while Commerce Pro is not in the cart', () => {
    expect(findCartAddonGaps([line('aff', AFFILIATES, 'Affiliates License'), line('mug', undefined)])).toEqual([
      {
        addon: { id: 'aff', title: 'Affiliates License' },
        base: { freemiusProductId: COMMERCE, name: 'NextBlock™ Commerce Pro', shortName: 'Commerce Pro' },
      },
    ]);
  });

  it('finds no gap once Commerce Pro is in the cart too (in any order, its id padded or not)', () => {
    expect(findCartAddonGaps([line('aff', AFFILIATES), line('com', COMMERCE)])).toEqual([]);
    expect(findCartAddonGaps([line('com', ` ${COMMERCE} `), line('aff', AFFILIATES)])).toEqual([]);
  });

  it('finds none in a cart without an add-on, or an empty one', () => {
    expect(findCartAddonGaps([line('com', COMMERCE), line('cortex', CORTEX), line('mug', null)])).toEqual([]);
    expect(findCartAddonGaps([])).toEqual([]);
  });
});

describe('findAddonBaseProduct', () => {
  it('picks the loaded store product that sells the required package', () => {
    const [base] = getProductAddonBases({ freemius_product_id: AFFILIATES });
    const commerce = { id: 'p-commerce', freemius_product_id: COMMERCE };
    expect(findAddonBaseProduct(base, [{ id: 'p-cortex', freemius_product_id: CORTEX }, commerce])).toBe(commerce);
    expect(findAddonBaseProduct(base, [{ id: 'p-cortex', freemius_product_id: CORTEX }])).toBeUndefined();
    expect(findAddonBaseProduct(base, undefined)).toBeUndefined();
  });
});
