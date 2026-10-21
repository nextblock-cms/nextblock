import 'server-only';

/**
 * The CMS second-factor check, published on a process-wide key for code that cannot import
 * this app: the ecommerce lib's role helpers (`libs/ecommerce/src/lib/server-actions/
 * require-ecom-role.ts`), which hand out the service-role client for payments, coupons, taxes,
 * shipping and orders. Registered when lib/auth/cms-actor.ts loads and at server start by
 * instrumentation.ts. Without it the lib fails closed for any account with a factor enrolled.
 *
 * Keep this module a leaf (no static imports): twoFactor.ts reaches cms-actor.ts through
 * config/email-settings.ts, and cms-actor.ts registers this gate while it loads, so a static
 * import here formed a cycle that left SECOND_FACTOR_GATE_KEY uninitialised whenever this
 * module was the entry point (instrumentation: "Cannot access … before initialization").
 */
export const SECOND_FACTOR_GATE_KEY = Symbol.for('nextblock.cms.secondFactorGate');

/** True when the signed-in session has passed its second factor, or none is enrolled. */
export async function secondFactorGate(): Promise<boolean> {
  const { evaluateTwoFactor } = await import('./twoFactor');
  const result = await evaluateTwoFactor();
  return result.status === 'satisfied' || result.status === 'not_required';
}

export function registerSecondFactorGate() {
  (globalThis as Record<symbol, unknown>)[SECOND_FACTOR_GATE_KEY] = secondFactorGate;
}
