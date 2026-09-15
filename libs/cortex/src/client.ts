/**
 * The browser-safe surface of the Cortex lib.
 *
 * The main barrel (`@nextblock-cms/cortex`) transitively imports `next/headers` and
 * `server-only` modules, so a client component that imports a runtime value from it
 * breaks the production build ("You're importing a module that depends on
 * next/headers"). Types are erased and may come from the main barrel; VALUES a client
 * component needs must be re-exported here, and only from modules with no server
 * imports (ai-model-registry and site-brief depend on zod alone).
 */
export {
  createCortexAiStoredModelSelection,
  type CortexAiStoredModelSelection,
} from './lib/ai-model-registry';
export {
  formatCortexSiteBriefForPrompt,
  isCortexSiteBriefComplete,
  type CortexSiteBrief,
} from './lib/site-brief';
