'use client';

/**
 * Client-side lazy boundaries for what the commerce block renderers draw.
 *
 * Every page that renders blocks (`/`, `/[slug]`, `/article/[slug]`, `/product/[slug]`)
 * reaches the commerce renderers through BlockRenderer's server-side `import()`. Next does
 * not code-split a Client Component that a Server Component imports, dynamically or not:
 * Turbopack adds every client module reachable from a page's server graph to that page's
 * entry chunks, which the page then loads up front. Imported directly, these components put
 * the product layout, the checkout, the reviews section and the Supabase browser client it
 * uses on every blog post and landing page.
 *
 * `next/dynamic` in a Client Component does split: each import below is its own chunk,
 * fetched only by a page that renders the block. SSR still renders the markup, and
 * next/dynamic preloads the chunk from the server render (PreloadChunks), so a page that
 * does render one gets its code in parallel with the entry chunks.
 *
 * Render these from the commerce renderers instead of the components themselves. Keep
 * this file free of static imports other than next/dynamic: one would put that component
 * back into every route's entry chunks. Every `import()` names an app module; the library's
 * components go through the one-line re-exports in `./lazy`. An `import()` of a library makes
 * Nx treat that whole library as lazy-loaded in this project, and
 * `@nx/enforce-module-boundaries` then refuses every static import of it, the server modules'
 * deep imports included. The monorepo's tools/scripts/commerce-chunking.test.ts enforces all
 * three rules.
 */
import dynamic from 'next/dynamic';

export const LazyFeaturedProduct = dynamic(() => import('./lazy/FeaturedProduct'));

export const LazyProductGridClient = dynamic(() => import('../blocks/ProductGridClient'));

export const LazyCart = dynamic(() => import('./lazy/Cart'));

export const LazyCheckoutWithCustomer = dynamic(() => import('./CheckoutWithCustomer'));

export const LazyProductDetailsLayout = dynamic(() => import('./lazy/ProductDetailsLayout'));

export const LazyProductReviewsSection = dynamic(() => import('../ProductReviewsSection'));

export const LazyContactSellerSection = dynamic(() => import('../ContactSellerSection'));
