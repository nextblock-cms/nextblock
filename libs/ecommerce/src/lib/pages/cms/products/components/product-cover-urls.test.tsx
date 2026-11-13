import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS products list and the product editor show a product's media rows. Migration 02032 gives
 * the Affiliates license products the bundled images/affiliates-square.webp: a file the app serves
 * from /images, not an object in the bucket. With NEXT_PUBLIC_R2_BASE_URL set, both screens joined
 * that key to the base by hand and showed a broken image (nextblock.dev, 0.23.1).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <span role="img" aria-label={alt} data-src={src} />,
}));

import { ProductMediaManager } from './ProductMediaManager';
import { ProductsBulkTable } from './ProductsBulkTable';

const BASE = 'https://media.example.com';
const BUNDLED_COVER = 'images/affiliates-square.webp';
const STORED_COVER = 'uploads/products/t-shirt.webp';

const imageSources = (html: string) => [...html.matchAll(/data-src="([^"]*)"/g)].map((match) => match[1]);

function productRow(id: string, title: string, key: string) {
  return {
    id,
    title,
    sku: `SKU-${id}`,
    slug: title.toLowerCase(),
    price: 2000,
    status: 'draft',
    language_id: 1,
    product_media: [{ media: { file_path: key, object_key: key } }],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('product covers with NEXT_PUBLIC_R2_BASE_URL set', () => {
  it('the products list shows a bundled cover from /images and a stored one from the media base', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);
    const bulkResult = async () => ({ success: true });

    const html = renderToStaticMarkup(
      <ProductsBulkTable
        products={[productRow('1', 'Affiliates', BUNDLED_COVER), productRow('2', 'T-shirt', STORED_COVER)]}
        languageLabels={{ '1': 'English' }}
        defaultCurrencyCode="USD"
        deleteProductAction={async () => undefined}
        bulkDeleteProductsAction={bulkResult}
        bulkDraftProductsAction={bulkResult}
      />
    );

    expect(imageSources(html)).toEqual(['/images/affiliates-square.webp', `${BASE}/uploads/products/t-shirt.webp`]);
  });

  it('the product editor shows the same covers', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', BASE);

    const html = renderToStaticMarkup(
      <ProductMediaManager
        initialMedia={[
          { id: 'pm-1', media_id: 'm-1', file_path: BUNDLED_COVER, alt: 'Affiliates cover', sort_order: 0 },
          { id: 'pm-2', media_id: 'm-2', file_path: STORED_COVER, alt: 'T-shirt', sort_order: 1 },
        ]}
        onUpdate={() => undefined}
      />
    );

    expect(imageSources(html)).toEqual(['/images/affiliates-square.webp', `${BASE}/uploads/products/t-shirt.webp`]);
  });
});
