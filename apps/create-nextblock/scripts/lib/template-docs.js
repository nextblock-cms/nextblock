import { relative } from 'node:path';

/**
 * Top-level folders of the repo's `docs/` that never ship in the CLI template (and so never reach
 * a scaffolded project or `npm run update`): `prompts/` holds the internal build prompts features
 * were specified with, not documentation for the people running a NextBlock site.
 */
export const TEMPLATE_DOCS_EXCLUDED_DIRS = Object.freeze(['prompts']);

/**
 * The copy filter of the template's docs sync: whether `src`, a path inside `docsRoot`, ships.
 * False for an excluded top-level folder and everything in it, and for any `node_modules`.
 */
export function shouldSyncTemplateDoc(src, docsRoot) {
  const rel = relative(docsRoot, src);
  if (!rel) return true;

  const segments = rel.split(/[\\/]+/);
  if (segments[0] === '..') return false;
  if (segments.includes('node_modules')) return false;

  return !TEMPLATE_DOCS_EXCLUDED_DIRS.includes(segments[0]);
}
