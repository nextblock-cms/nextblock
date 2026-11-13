/**
 * The public sandbox (`NEXT_PUBLIC_IS_SANDBOX === 'true'`) publishes its admin login, so every
 * visitor is the admin. A script saved there would run with the CSP nonce for every later visitor,
 * /cms and the partner portal included, and could read the OpenRouter key a visitor keeps in
 * localStorage. `components/SiteScripts.tsx` and `components/privacy/ConsentGatedAnalytics.tsx`
 * render nothing on the sandbox, which also covers rows written by Cortex or over PostgREST. The
 * site-scripts and Google Analytics actions refuse with this sentence, and both settings screens
 * show it as a note.
 *
 * A plain module with no imports: the server actions and the client screens both read it (a
 * `'use server'` file may export only async functions).
 */
export const SITE_SCRIPTS_SANDBOX_MESSAGE =
  'Site scripts and tag managers are turned off in the sandbox: they would run for every visitor.';
