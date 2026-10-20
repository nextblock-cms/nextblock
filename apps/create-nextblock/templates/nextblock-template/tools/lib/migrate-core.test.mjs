import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GRANTS_SQL } from './migrate-core.mjs';

// The build-time hook (this directory) and the /setup wizard (lib/setup/schema-apply.ts)
// both finish an apply with GRANTS_SQL: blanket grants on `public` for the API roles, then
// the revokes those grants would otherwise undo. Until 2026-10-20 the hook had the grants
// without the revokes, so every production deploy re-granted anon/authenticated EXECUTE on
// the SECURITY DEFINER trigger functions that 02013 revokes and the Supabase Security
// Advisor flagged them again (migration 02024 repairs the databases that were re-granted).
// This test fails when the two copies drift, the same way fallback-overrides.test.js pins
// the scaffold overrides.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.resolve(here, rel), 'utf8').replace(/\r\n/g, '\n');

/** The `do $tag$ … end $tag$;` block with the given dollar-quote tag, or null. */
function dollarBlock(source, tag) {
  // `[$]` is a literal dollar and `[^]` any character including newlines, so the pattern
  // needs no backslash escapes.
  const m = new RegExp(`do [$]${tag}[$][^]*?end [$]${tag}[$];`).exec(source);
  return m ? m[0] : null;
}

/** The quoted statements concatenated into GRANTS_SQL, in source order. */
function grantStatements(source) {
  const m = /GRANTS_SQL =\n([^]*?);\n/.exec(source);
  return m ? [...m[1].matchAll(/'([^']*;)'/g)].map((x) => x[1]) : null;
}

describe('migrate-core post-apply grant pass', () => {
  const core = read('./migrate-core.mjs');
  const setup = read('../../lib/setup/schema-apply.ts');

  it('carries the same trigger-function revoke as schema-apply.ts', () => {
    const block = dollarBlock(core, 'nb_trg');
    expect(block).not.toBeNull();
    expect(block).toBe(dollarBlock(setup, 'nb_trg'));
  });

  it('carries the same API-role revoke list as schema-apply.ts', () => {
    const block = dollarBlock(core, 'nb_api');
    expect(block).not.toBeNull();
    expect(block).toBe(dollarBlock(setup, 'nb_api'));
  });

  it('concatenates the same grant statements as schema-apply.ts, revokes last', () => {
    const statements = grantStatements(core);
    expect(statements).not.toBeNull();
    expect(statements).toHaveLength(5);
    expect(statements).toEqual(grantStatements(setup));

    const grantAll = GRANTS_SQL.indexOf('grant execute on all functions in schema public');
    const trigger = GRANTS_SQL.indexOf('do $nb_trg$');
    const api = GRANTS_SQL.indexOf('do $nb_api$');
    expect(grantAll).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(grantAll);
    expect(api).toBeGreaterThan(trigger);
  });

  it('takes EXECUTE back on every function a forward migration revokes from the API roles', () => {
    expect(GRANTS_SQL).toContain("t.typname = 'trigger'");
    for (const fn of [
      'generate_order_invoice_number()',
      'assign_order_invoice_metadata(uuid, timestamp with time zone)',
      'upsert_product_with_variants(jsonb)',
      'bump_email_2fa_attempts(uuid)',
      'redeem_coupon_atomically(uuid)',
    ]) {
      expect(GRANTS_SQL).toContain(`revoke execute on function public.${fn} from public, anon`);
    }
    expect(GRANTS_SQL).toContain(
      'revoke truncate on all tables in schema public from anon, authenticated',
    );
  });
});
