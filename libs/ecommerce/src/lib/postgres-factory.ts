import type postgres from 'postgres';

/**
 * The postgres (porsager/postgres) factory, from either build of this library.
 *
 * postgres 4 is an ES module only. The ES build (`*.es.js`) imports its default export, the factory.
 * The CommonJS build (`*.cjs`) loads it with require(), which Node answers with the module namespace,
 * and Rolldown's interop (`__toESM(require("postgres"), 1)`) then hands that namespace over as the
 * default import, so the factory is its `default` there. postgres 3 was CommonJS and handed over the
 * factory itself, so nothing noticed until 4: the monorepo never runs `dist/`.
 */
export function resolvePostgresFactory(imported: unknown): typeof postgres {
  if (typeof imported === 'function') {
    return imported as typeof postgres;
  }
  const nested = imported !== null && typeof imported === 'object' ? (imported as { default?: unknown }).default : undefined;
  if (typeof nested === 'function') {
    return nested as typeof postgres;
  }
  throw new Error('The postgres driver did not load: its default export is not a function');
}
