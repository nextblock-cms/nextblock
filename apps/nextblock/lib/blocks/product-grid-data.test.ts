import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The shop grid (product_grid block, /shop) maps each product's first media row to `image_url`.
 * Migration 02032 gives the Affiliates license products the bundled images/affiliates-square.webp,
 * which the app serves from /images; joining it to NEXT_PUBLIC_R2_BASE_URL by hand showed a broken
 * cover. Without a media base the grid keeps its Supabase Storage fallback for bucket keys.
 */

vi.mock('@nextblock-cms/ecommerce/server', () => ({ getProducts: vi.fn() }));
vi.mock('@nextblock-cms/db/server', () => ({ getSsgSupabaseClient: vi.fn() }));

import { mapProductRowToUiProduct } from './product-grid-data';

function productRow(filePath: string | null) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'NextBlock Affiliates',
    slug: 'nextblock-affiliates',
    sku: 'NB-AFFILIATES',
    price: 20000,
    language_id: 1,
    product_media: filePath ? [{ media: { file_path: filePath } }] : [],
    product_variants: [],
    product_categories: [],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mapProductRowToUiProduct image_url', () => {
  it('serves a bundled cover from /images with NEXT_PUBLIC_R2_BASE_URL set', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', 'https://media.example.com');

    expect(mapProductRowToUiProduct(productRow('images/affiliates-square.webp')).image_url).toBe(
      '/images/affiliates-square.webp'
    );
    expect(mapProductRowToUiProduct(productRow('uploads/products/t-shirt.webp')).image_url).toBe(
      'https://media.example.com/uploads/products/t-shirt.webp'
    );
  });

  it('keeps the Supabase Storage fallback for a bucket key when no media base is set', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abc.supabase.co');

    expect(mapProductRowToUiProduct(productRow('uploads/products/t-shirt.webp')).image_url).toBe(
      'https://abc.supabase.co/storage/v1/object/public/media/uploads/products/t-shirt.webp'
    );
    expect(mapProductRowToUiProduct(productRow('images/affiliates-square.webp')).image_url).toBe(
      '/images/affiliates-square.webp'
    );
  });

  it('has no image_url without media', () => {
    expect(mapProductRowToUiProduct(productRow(null)).image_url).toBeUndefined();
  });
});
