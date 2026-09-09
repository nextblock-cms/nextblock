/**
 * Barrel for the SEO engine.
 *
 * Everything reachable from here is pure and dependency-free — no Zod, no React,
 * no Supabase, no DOM — so the same module graph loads in the browser, in a Node
 * script and inside the Next.js proxy. Import from `@nextblock-cms/utils/seo`
 * rather than from the package root when you need that guarantee, because the
 * root barrel also re-exports React-flavoured helpers.
 */

export * from './audit';
export * from './document';
export * from './headings';
export * from './keywords';
export * from './page-document';
export * from './readability';
export * from './redirects';
export * from './robots';
export * from './types';

