import type { ComponentType } from "react";

type PublicBlockRendererLoader = () => Promise<{
  default: ComponentType<any>;
}>;

// These server-side imports defer the renderers' server work only. They do not split client
// code: every client component reachable from here ships in the entry chunks of every page
// that renders blocks. The renderers therefore draw their client components through
// components/commerce/LazyCommerceClients.tsx (tools/scripts/commerce-chunking.test.ts).
const ecommerceBlockRendererLoaders: Record<string, PublicBlockRendererLoader> = {
  product_grid: () => import("./renderers/ProductGridBlockRenderer"),
  featured_product: () => import("./renderers/FeaturedProductBlockRenderer"),
  cart: () => import("./renderers/CartBlockRenderer"),
  checkout: () => import("./renderers/CheckoutBlockRenderer"),
  product_details: () => import("./renderers/ProductDetailsBlockRenderer"),
};

export function loadEcommerceBlockRenderer(blockType: string) {
  const loader = ecommerceBlockRendererLoaders[blockType];

  if (!loader) {
    return Promise.reject(new Error(`Unsupported ecommerce block type: ${blockType}`));
  }

  return loader();
}
