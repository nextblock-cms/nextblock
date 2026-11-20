import { createRequire } from 'node:module';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { resolvePostgresFactory } from './postgres-factory';

/**
 * order-inventory.ts's SQL fallback connects through resolvePostgresFactory, so both builds of this
 * library find the factory: the ES build imports it as the default export, while the CommonJS build's
 * require() of postgres 4 (an ES module) gets the module namespace, which Rolldown's node-mode interop
 * then passes on as the default import.
 */
describe('resolvePostgresFactory', () => {
  it('takes the factory the ES build imports', () => {
    expect(typeof postgres).toBe('function');
    expect(resolvePostgresFactory(postgres)).toBe(postgres);
  });

  it("finds the factory in the namespace a CommonJS require('postgres') returns", () => {
    const required: unknown = createRequire(import.meta.url)('postgres');
    // What the .cjs build's `__toESM(require("postgres"), 1).default` holds with postgres 4.
    expect(typeof required).toBe('object');
    expect(resolvePostgresFactory(required)).toBe((required as { default: unknown }).default);
    expect(typeof resolvePostgresFactory(required)).toBe('function');
  });

  it('refuses anything else instead of calling it', () => {
    for (const value of [undefined, null, {}, { default: {} }, 'postgres', 1]) {
      expect(() => resolvePostgresFactory(value)).toThrow('The postgres driver did not load');
    }
  });
});
