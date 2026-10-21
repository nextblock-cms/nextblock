/**
 * Runs once when a Next.js server instance starts, before it handles requests.
 *
 * Registers the CMS second-factor check for the ecommerce lib's role helpers, so a server
 * action reached on a cold instance (before any page has loaded lib/auth/cms-actor.ts) still
 * enforces 2FA. A failure here must never stop the server: without the gate those helpers fail
 * closed for any account with a second factor enrolled.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { registerSecondFactorGate } = await import('./lib/auth/second-factor-gate');
    registerSecondFactorGate();
  } catch (error) {
    console.error('[instrumentation] Could not register the CMS second-factor gate:', error);
  }
}
