import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { GRANTS_SQL } from './migrate-core.mjs';

// The build-time hook (this directory) and the /setup wizard (lib/setup/schema-apply.ts)
// both finish an apply with GRANTS_SQL: blanket grants on `public` for the API roles, then
// the revokes those grants would otherwise undo. Until 2026-10-20 the hook had the grants
// without the revokes, so every production deploy re-granted anon/authenticated EXECUTE on
// the SECURITY DEFINER trigger functions that 02013 revokes and the Supabase Security
// Advisor flagged them again (migration 02024 repairs the databases that were re-granted).
// This test fails when the two copies drift, the same way fallback-overrides.test.js pins
// the scaffold overrides. It compares the final GRANTS_SQL strings in full: comparing the
// pieces let a copy drop `+ API_ROLE_REVOKE_SQL`, reorder it, or keep a dead copy of it.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.resolve(here, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * A static evaluator for a module's top-level string constants: string and template literals,
 * `+`, parentheses and references to other top-level constants. Anything else throws, so a
 * GRANTS_SQL built some other way fails the test instead of being half-compared.
 * (schema-apply.ts imports 'server-only' and the migrations bundle, so it cannot be imported.)
 */
function constantsOf(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const initializers = new Map();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  const values = new Map();
  const evaluate = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return evaluate(node.left) + evaluate(node.right);
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => evaluate(s.expression) + s.literal.text).join('');
    if (ts.isIdentifier(node)) return valueOf(node.text);
    throw new Error(`${fileName}: cannot evaluate \`${node.getText(file)}\` statically`);
  };
  const valueOf = (name) => {
    if (!values.has(name)) {
      if (!initializers.has(name)) throw new Error(`${fileName}: no top-level constant ${name}`);
      values.set(name, evaluate(initializers.get(name)));
    }
    return values.get(name);
  };
  return valueOf;
}

/** The callees that receive GRANTS_SQL (`run`, `db.unsafe`), in source order. */
function grantPassCalls(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.some((a) => ts.isIdentifier(a) && a.text === 'GRANTS_SQL')) {
      calls.push(node.expression.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

describe('migrate-core post-apply grant pass', () => {
  const core = read('./migrate-core.mjs');
  const setup = read('../../lib/setup/schema-apply.ts');

  it('evaluates GRANTS_SQL statically exactly as Node does', () => {
    expect(constantsOf(core, 'migrate-core.mjs')('GRANTS_SQL')).toBe(GRANTS_SQL);
  });

  it('schema-apply.ts builds the same GRANTS_SQL, byte for byte', () => {
    expect(constantsOf(setup, 'schema-apply.ts')('GRANTS_SQL')).toBe(GRANTS_SQL);
  });

  it('schema-apply.ts runs GRANTS_SQL where migrate-core.mjs does', () => {
    const calls = grantPassCalls(core, 'migrate-core.mjs');
    expect(calls).toEqual(['run', 'db.unsafe']);
    expect(grantPassCalls(setup, 'schema-apply.ts')).toEqual(calls);
  });

  it('fails on the drifts the 2026-10-21 review proved the old piecewise comparison missed', () => {
    const mutations = {
      'API_ROLE_REVOKE_SQL dropped from the concatenation': (s) =>
        s.replace('TRIGGER_FUNCTION_REVOKE_SQL +\n  API_ROLE_REVOKE_SQL;', 'TRIGGER_FUNCTION_REVOKE_SQL;'),
      'revokes concatenated before the blanket grants': (s) =>
        s.replace(
          /const GRANTS_SQL =\n([^]*?)\+\n {2}TRIGGER_FUNCTION_REVOKE_SQL \+\n {2}API_ROLE_REVOKE_SQL;/,
          'const GRANTS_SQL =\n  TRIGGER_FUNCTION_REVOKE_SQL + API_ROLE_REVOKE_SQL +\n$1;',
        ),
      'a dead copy of the revoke list kept beside the real one': (s) =>
        s
          .replace('const API_ROLE_REVOKE_SQL = `do $nb_api$', 'const API_ROLE_REVOKE_SQL_UNUSED = `do $nb_api$')
          .replace('TRIGGER_FUNCTION_REVOKE_SQL +\n  API_ROLE_REVOKE_SQL;', "TRIGGER_FUNCTION_REVOKE_SQL +\n  '';"),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const mutated = mutate(setup);
      expect(mutated, name).not.toBe(setup);
      expect(constantsOf(mutated, 'schema-apply.ts')('GRANTS_SQL'), name).not.toBe(GRANTS_SQL);
    }
    const otherConstant = setup.replace('await run(GRANTS_SQL);', 'await run(TRIGGER_FUNCTION_REVOKE_SQL);');
    expect(otherConstant).not.toBe(setup);
    expect(grantPassCalls(otherConstant, 'schema-apply.ts')).not.toEqual(grantPassCalls(core, 'migrate-core.mjs'));
  });

  it('runs the revokes after the blanket grants', () => {
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

  it('keeps the 02025 grant hardening after its blanket grants', () => {
    // anon read-only at the grant level, tables and sequences
    expect(GRANTS_SQL).toContain(
      'revoke insert, update, delete, references, trigger on all tables in schema public from anon',
    );
    expect(GRANTS_SQL).toContain('revoke usage, update on all sequences in schema public from anon');
    // cortex_request_log stays service-role only (02022), which the blanket grants used to undo
    expect(GRANTS_SQL).toContain(
      'revoke all on table public.cortex_request_log from public, anon, authenticated',
    );
    // profiles.role is pinned by column grants: table-level writes go, every other column comes back
    expect(GRANTS_SQL).toContain(
      'revoke insert, update, delete, references, trigger on table public.profiles from public, anon, authenticated',
    );
    expect(GRANTS_SQL).toContain("filter (where a.attname <> 'role')");
    expect(GRANTS_SQL).toContain("filter (where a.attname not in ('id', 'role'))");
    expect(GRANTS_SQL.indexOf('on table public.profiles from public')).toBeLessThan(
      GRANTS_SQL.indexOf('grant update (%s) on table public.profiles to authenticated'),
    );
  });

  it('keeps the 02026 authenticated write revokes after its blanket grants', () => {
    expect(GRANTS_SQL).toContain('revoke references, trigger on all tables in schema public from authenticated');
    // a sample per privilege set: written only by the service role, no authenticated policy
    for (const [table, privileges] of [
      ['user_security_settings', 'insert, update, delete'],
      ['package_activations', 'insert, update, delete'],
      ['message_threads', 'insert, delete'],
      ['site_script_revisions', 'update, delete'],
      ['user_trusted_devices', 'insert, update'],
    ]) {
      expect(GRANTS_SQL).toContain(`revoke ${privileges} on table public.${table} from authenticated`);
    }
    expect(GRANTS_SQL.indexOf('grant all on all tables in schema public to authenticated')).toBeLessThan(
      GRANTS_SQL.indexOf('revoke insert, update, delete on table public.user_security_settings from authenticated'),
    );
  });

  it('keeps the 02027 SELECT revokes after its blanket grants', () => {
    // a sample: no policy lets anon read these; the public site reads none of them
    for (const table of ['orders', 'profiles', 'coupons', 'mcp_access_tokens', 'page_revisions', 'content_drafts']) {
      expect(GRANTS_SQL).toContain(`revoke select on table public.${table} from anon;`);
    }
    // service-role-only for both API roles
    for (const table of ['email_2fa_challenges', 'ucp_cart_sessions']) {
      expect(GRANTS_SQL).toContain(`revoke select on table public.${table} from anon, authenticated;`);
    }
    expect(GRANTS_SQL).toContain('revoke select on table public.profile_cards from anon;');
    expect(GRANTS_SQL).toContain('revoke insert, update, delete on table public.profile_cards from authenticated;');
    expect(GRANTS_SQL.match(/revoke select on table public\.\w+ from anon/g)).toHaveLength(30);
    expect(GRANTS_SQL.indexOf('grant select on all tables in schema public to anon')).toBeLessThan(
      GRANTS_SQL.indexOf('revoke select on table public.orders from anon'),
    );
  });
});
