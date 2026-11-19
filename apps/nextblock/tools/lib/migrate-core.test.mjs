import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations as applySetupMigrations, emptyHistoryRefusal as setupEmptyHistoryRefusal } from '../../lib/setup/schema-apply.ts';
import {
  applyMigrations,
  collectMigrations,
  describeBackend,
  emptyHistoryRefusal,
  GRANTS_SQL,
  loadEnvFiles,
  readAppliedVersions,
  runSql,
} from './migrate-core.mjs';

// applyMigrations reaches Postgres through `await import('postgres')` (lib/setup/schema-apply.ts through
// a static import): this stand-in records each statement instead of connecting (the Management API
// backend runs on a stubbed fetch below, which answers from the same state). It answers from
// `database`: a history holding 02001, the tracking table and public.site_settings present and no
// generation marker, unless a test sets otherwise (database.reset() puts that back).
const postgresStatements = vi.hoisted(() => []);
const database = vi.hoisted(() => {
  const DEFAULTS = { versions: ['02001'], tracked: true, siteSettings: true, generation: null };
  const state = { ...DEFAULTS };
  return {
    state,
    reset: () => Object.assign(state, DEFAULTS),
    /** The rows a statement reads from the stand-in database; none for anything else. */
    answer(text) {
      if (text.includes('select version from supabase_migrations.schema_migrations')) return state.versions.map((version) => ({ version }));
      if (text.includes("to_regclass('public.site_settings')")) return [{ t: state.siteSettings ? 'site_settings' : null }];
      if (text.includes("to_regclass('supabase_migrations.schema_migrations')")) return [{ t: state.tracked ? 'supabase_migrations.schema_migrations' : null }];
      if (text.includes("where key = 'migration_baseline_generation'")) return state.generation === null ? [] : [{ generation: String(state.generation) }];
      return [];
    },
  };
});
vi.mock('postgres', () => ({
  default: () => {
    const db = (strings) => {
      const text = strings.join('$');
      postgresStatements.push(text);
      return Promise.resolve(database.answer(text));
    };
    db.unsafe = async (sql) => {
      postgresStatements.push(sql);
      return database.answer(sql);
    };
    db.end = async () => undefined;
    return db;
  },
}));
// schema-apply.ts falls back to this bundle where no migration folder is on disk; the tests below run
// in the monorepo, where it reads libs/db's folder like the build hook, so they need none of its 2.8 MB.
vi.mock('../../lib/setup/migrations-bundle', () => ({ MIGRATIONS_BUNDLE: [] }));

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
 * (It reads schema-apply.ts as written; the tests further down import it, with its migrations
 * bundle mocked, to run it.)
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
      // 02043: the atomic product draft publish and the History content it records (anon only).
      'publish_product_draft(uuid, bigint, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb)',
      'product_revision_content(uuid)',
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
    // 29 tables of 02027 + profile_cards + the four partner tables of 02030 + product_stock_publishes of 02047
    expect(GRANTS_SQL.match(/revoke select on table public\.\w+ from anon/g)).toHaveLength(35);
    expect(GRANTS_SQL.indexOf('grant select on all tables in schema public to anon')).toBeLessThan(
      GRANTS_SQL.indexOf('revoke select on table public.orders from anon'),
    );
  });

  it('keeps the 02030 affiliates revokes after its blanket grants', () => {
    // anon reads no partner table but the tier ladder; authenticated writes no account or ledger row
    for (const table of ['affiliate_profiles', 'affiliate_pages', 'affiliate_commissions', 'affiliate_payouts']) {
      expect(GRANTS_SQL).toContain(`revoke select on table public.${table} from anon;`);
      expect(GRANTS_SQL).toContain(`revoke insert, update, delete on table public.${table} from authenticated;`);
    }
    expect(GRANTS_SQL).not.toContain('on table public.affiliate_tiers from');
    // the self-service columns come back only after the table-level UPDATE is gone
    for (const [table, columns] of [
      ['affiliate_profiles', 'display_name, bio, social_links, preferred_locale'],
      ['affiliate_pages', 'title, meta_description, draft_content, featured_product_ids'],
    ]) {
      const grant = `grant update (${columns}) on table public.${table} to authenticated;`;
      expect(GRANTS_SQL).toContain(grant);
      expect(GRANTS_SQL.indexOf(`revoke insert, update, delete on table public.${table} from authenticated;`)).toBeLessThan(
        GRANTS_SQL.indexOf(grant),
      );
    }
    // service role only: the click log and the payout-run claims
    for (const table of ['affiliate_click_events', 'affiliate_payout_runs']) {
      expect(GRANTS_SQL).toContain(`revoke all on table public.${table} from public, anon, authenticated;`);
    }
    // every service-role RPC, by its exact argument types, behind a guard naming the same signature
    for (const fn of [
      'create_affiliate_account(uuid, text, text, text, text, text, jsonb, text)',
      'promote_cleared_affiliate_commissions()',
      'claim_affiliate_payout(uuid, text, bigint, text)',
      'complete_affiliate_payout(uuid, text)',
      'fail_affiliate_payout(uuid, text)',
      'prepare_affiliate_payout_retry(uuid, bigint)',
      'release_affiliate_payout(uuid)',
      'claim_affiliate_payout_run(date, text)',
      'finish_affiliate_payout_run(date, jsonb)',
      'claim_affiliate_commission_notifications(integer)',
      'apply_affiliate_refund(public.affiliate_gateway, uuid, bigint, bigint, boolean)',
      'set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean)',
      'reconcile_affiliate_commissions(integer)',
    ]) {
      expect(GRANTS_SQL).toContain(`if to_regprocedure('public.${fn}') is not null then`);
      expect(GRANTS_SQL).toContain(`revoke execute on function public.${fn} from public, anon, authenticated;`);
    }
    // a retired signature is not revoked by name: 02030 drops the (uuid) overload of the retry
    expect(GRANTS_SQL).not.toContain('prepare_affiliate_payout_retry(uuid)');
    // the four anonymous storefront RPCs keep the blanket EXECUTE grant
    for (const fn of ['get_affiliate_storefront', 'list_affiliate_storefronts', 'get_affiliate_referral_window', 'record_affiliate_click']) {
      expect(GRANTS_SQL).not.toContain(`function public.${fn}(`);
    }
    expect(GRANTS_SQL.indexOf('grant all on all tables in schema public to authenticated')).toBeLessThan(
      GRANTS_SQL.indexOf('revoke insert, update, delete on table public.affiliate_commissions from authenticated'),
    );
  });

  it('keeps the 02035 tier-move RPC service-role only after its blanket grants', () => {
    // change_affiliate_partner_tier (the CMS "Change tier"), by its exact argument types, behind a
    // guard naming the same signature; nothing else of 02035 needs a new pass entry: its trigger
    // function lives in `private` (no blanket grant reaches it), its columns ride the table grants,
    // and the set_affiliate_commission_dispute it redefines keeps 02030's signature, already revoked
    const fn = 'change_affiliate_partner_tier(uuid, uuid, boolean)';
    const guard = `if to_regprocedure('public.${fn}') is not null then`;
    const revoke = `revoke execute on function public.${fn} from public, anon, authenticated;`;
    expect(GRANTS_SQL).toContain(guard);
    expect(GRANTS_SQL).toContain(revoke);
    expect(GRANTS_SQL.indexOf(guard)).toBeLessThan(GRANTS_SQL.indexOf(revoke));
    expect(GRANTS_SQL.indexOf('grant execute on all functions in schema public')).toBeLessThan(GRANTS_SQL.indexOf(revoke));
    // no other overload is revoked by name, and the trigger function is not touched here
    expect(GRANTS_SQL.match(/change_affiliate_partner_tier\(/g)).toHaveLength(2);
    expect(GRANTS_SQL).not.toContain('affiliate_snapshot_order_rate');
    const dispute = 'set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean)';
    expect(GRANTS_SQL.indexOf('grant execute on all functions in schema public')).toBeLessThan(
      GRANTS_SQL.indexOf(`revoke execute on function public.${dispute} from public, anon, authenticated;`),
    );
    expect(GRANTS_SQL).not.toContain('affiliate_disputed_at');
    // affiliate_profiles keeps exactly its four self-service UPDATE columns: tier_changed_at is not one
    expect(GRANTS_SQL).toContain('grant update (display_name, bio, social_links, preferred_locale) on table public.affiliate_profiles to authenticated;');
    expect(GRANTS_SQL).not.toContain('tier_changed_at');
  });

  it('keeps the 02036 manual payout RPCs service-role only after its blanket grants', () => {
    // The five-argument claim (p_gateways) and the manual payout lifecycle of the CMS "Pay
    // manually" (prepare, record, cancel), by their exact argument types, behind guards naming the
    // same signatures, after the blanket EXECUTE grant.
    for (const fn of [
      'claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[])',
      'claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[])',
      'record_manual_affiliate_payout(uuid, text, text, text, uuid)',
      'cancel_manual_affiliate_payout(uuid)',
    ]) {
      const guard = `if to_regprocedure('public.${fn}') is not null then`;
      const revoke = `revoke execute on function public.${fn} from public, anon, authenticated;`;
      expect(GRANTS_SQL).toContain(guard);
      expect(GRANTS_SQL).toContain(revoke);
      expect(GRANTS_SQL.indexOf(guard)).toBeLessThan(GRANTS_SQL.indexOf(revoke));
      expect(GRANTS_SQL.indexOf('grant execute on all functions in schema public')).toBeLessThan(GRANTS_SQL.indexOf(revoke));
    }
    // The four-argument claim 02036 drops stays listed (guarded) for a database that has not run
    // 02036 yet, and 02030's revoke of it must survive the pass: two claim signatures in all.
    expect(GRANTS_SQL.match(/revoke execute on function public\.claim_affiliate_payout\(/g)).toHaveLength(2);
    // One signature each (guard + revoke): no stale overload of the record is kept.
    expect(GRANTS_SQL.match(/record_manual_affiliate_payout\(/g)).toHaveLength(2);
    expect(GRANTS_SQL.match(/claim_manual_affiliate_payout\(/g)).toHaveLength(2);
    expect(GRANTS_SQL.match(/cancel_manual_affiliate_payout\(/g)).toHaveLength(2);
    // payout_email is written by the server only: no column grant brings it to authenticated
    expect(GRANTS_SQL).toContain('grant update (display_name, bio, social_links, preferred_locale) on table public.affiliate_profiles to authenticated;');
    expect(GRANTS_SQL).not.toContain('payout_email');
  });

  it('keeps the 02037 PayPal payout RPCs service-role only after its blanket grants', () => {
    // The PayPal payout lifecycle of the daily run and the CMS PayPal payouts screen (claim, batch
    // ids, item notes, complete, fail, the admin release), by their exact argument types, behind
    // guards naming the same signatures, after the blanket EXECUTE grant: one signature each (guard +
    // revoke).
    for (const fn of [
      'claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text)',
      'record_paypal_affiliate_payout_batch(uuid[], text, text)',
      'note_paypal_affiliate_payout_item(uuid, text, text, bigint)',
      'complete_paypal_affiliate_payout(uuid, text, text, bigint, text)',
      'fail_paypal_affiliate_payout(uuid, text, text)',
      'release_paypal_affiliate_payout(uuid)',
    ]) {
      const guard = `if to_regprocedure('public.${fn}') is not null then`;
      const revoke = `revoke execute on function public.${fn} from public, anon, authenticated;`;
      expect(GRANTS_SQL).toContain(guard);
      expect(GRANTS_SQL).toContain(revoke);
      expect(GRANTS_SQL.indexOf(guard)).toBeLessThan(GRANTS_SQL.indexOf(revoke));
      expect(GRANTS_SQL.indexOf('grant execute on all functions in schema public')).toBeLessThan(GRANTS_SQL.indexOf(revoke));
      const name = fn.slice(0, fn.indexOf('('));
      expect(GRANTS_SQL.match(new RegExp(`${name}\\(`, 'g'))).toHaveLength(2);
    }
    // payout_email_kind, the PayPal payout columns and the PayPal credentials row get no grant to take back
    expect(GRANTS_SQL).not.toContain('paypal_receiver');
    expect(GRANTS_SQL).not.toContain('affiliates_paypal_secret');
  });

  it('keeps the 02045 media usage lookup service-role only after its blanket grants', () => {
    // media_usage reads every content table (drafts, revisions, partner pages, site settings) as
    // the service role: the media library calls it after its own staff check, and no API role may.
    const fn = 'media_usage(jsonb)';
    const guard = `if to_regprocedure('public.${fn}') is not null then`;
    const revoke = `revoke execute on function public.${fn} from public, anon, authenticated;`;
    expect(GRANTS_SQL).toContain(guard);
    expect(GRANTS_SQL).toContain(revoke);
    expect(GRANTS_SQL.indexOf(guard)).toBeLessThan(GRANTS_SQL.indexOf(revoke));
    expect(GRANTS_SQL.indexOf('grant execute on all functions in schema public')).toBeLessThan(GRANTS_SQL.indexOf(revoke));
    expect(GRANTS_SQL.match(/media_usage\(/g)).toHaveLength(2);
  });
});

describe('applyMigrations with no file to apply', () => {
  // `npm run update` runs the grant pass alone when nothing is pending by calling applyMigrations([])
  // (update.mjs reapplyDatabaseGrants), and since 0.23.6 an updater runs its schema step on the engine
  // of the release it updates to. So every release's applyMigrations runs GRANTS_SQL after its loop on
  // both backends, an empty list included: skipping the pass when nothing was applied would leave the
  // grants of an update that applied a release's migrations with the previous engine to the build hook.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    postgresStatements.length = 0;
    database.reset();
  });

  it('runs the grant pass over the Management API', async () => {
    vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'stub-token');
    vi.stubEnv('SUPABASE_PROJECT_ID', 'stubref');
    const queries = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      const { query } = JSON.parse(init.body);
      queries.push(query);
      return new Response(JSON.stringify(database.answer(query)), { status: 200 });
    });

    expect(await applyMigrations([])).toEqual({ ok: true, applied: 0, backend: 'management-api' });
    expect(queries.slice(-2)).toEqual([GRANTS_SQL, "notify pgrst, 'reload schema';"]);
  });

  it('runs the grant pass over a direct Postgres connection', async () => {
    vi.stubEnv('SUPABASE_ACCESS_TOKEN', '');
    vi.stubEnv('POSTGRES_URL', 'postgres://nextblock:stub@127.0.0.1:9/nextblock');

    expect(await applyMigrations([])).toEqual({ ok: true, applied: 0, backend: 'postgres' });
    expect(postgresStatements.slice(-2)).toEqual([GRANTS_SQL, "notify pgrst, 'reload schema';"]);
  });
});

/**
 * Every module a source loads, as written: the specifier of each static import and re-export, each
 * import(), and each call of require or of a function createRequire made (bound to a name, or called
 * at once); null where the specifier is not a string literal.
 */
function moduleSpecifiersOf(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const requires = new Set(['require']);
  const isCreateRequire = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createRequire';
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifiers.push(literal(node.moduleSpecifier));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequire(node.initializer)) requires.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requires.has(callee.text)) || isCreateRequire(callee)) {
        specifiers.push(literal(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

/** A specifier Node resolves without this file's location: a builtin (`node:`) or a package name. */
const isBuiltinOrPackage = (specifier) =>
  typeof specifier === 'string' && (specifier.startsWith('node:') || /^(?:@[\w.-]+\/)?\w[\w.-]*(?:\/[\w.-]+)*$/.test(specifier));

/** Every string in a source that names a path beside it (`./`, `../`) or a file URL, whatever uses it. */
function relativeLiteralsOf(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /^(?:\.\.?\/|file:)/.test(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the engine contract an earlier updater relies on', () => {
  // npm run update imports this file a second time once its code update has replaced it (update.mjs
  // loadUpdatedMigrationEngine), so every updater runs the NEXT release's engine with the calls, the
  // arguments and the result reads it was written for (update.test.mjs pins the names it calls). That
  // import re-reads migrate-core.mjs alone: a module it imports by a relative path resolves to the copy
  // the first import loaded, the previous release's. GRANTS_SQL moved into a sibling would then run the
  // old revoke list while the updater says it re-applied the revokes this version lists.
  const projects = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    postgresStatements.length = 0;
    database.reset();
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A standalone project whose supabase/migrations holds 02001 and 02002. */
  function makeProject() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-engine-contract-'));
    projects.push(root);
    const dir = path.join(root, 'supabase', 'migrations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    writeFileSync(path.join(dir, '02001_first.sql'), 'select 1;\n');
    writeFileSync(path.join(dir, '02002_second.sql'), 'select 2;\n');
    return { root, dir };
  }

  /**
   * Points the engine at `kind`: the Management API on a stubbed fetch (answering `status`), Postgres
   * on the stand-in above, or no backend. Returns the list of statements that backend receives. fetch
   * is stubbed in every case, so nothing leaves the machine.
   */
  function useBackend(kind, status = 200) {
    vi.stubEnv('SUPABASE_ACCESS_TOKEN', kind === 'management-api' ? 'stub-token' : '');
    vi.stubEnv('SUPABASE_PROJECT_ID', kind === 'management-api' ? 'stubref' : '');
    vi.stubEnv('POSTGRES_URL', kind === 'postgres' ? 'postgres://nextblock:stub@127.0.0.1:9/nextblock' : '');
    vi.stubEnv('DATABASE_URL', '');
    const queries = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      const { query } = JSON.parse(init.body);
      queries.push(query);
      if (status !== 200) return new Response('{"message":"refused by the stub"}', { status });
      const rows = query.startsWith('select version from') ? [{ version: '02001' }] : query.includes('to_regclass(') ? [{ t: 'present' }] : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    return kind === 'postgres' ? postgresStatements : queries;
  }

  it('imports no relative module, statically or dynamically, and no module but the ones it lists', () => {
    const core = read('./migrate-core.mjs');
    // A package both copies import is served from Node's module cache across the reload, like a sibling:
    // GRANTS_SQL moved into @nextblock-cms/db would bring the old revoke list back the same way. So the
    // engine imports exactly these, and a new one is a decision this list records.
    const ENGINE_MODULES = ['dotenv', 'node:fs', 'node:fs/promises', 'node:module', 'node:path', 'postgres'];
    /** Why `source` could load a module the reload would serve from the first import's cache. */
    const reloadProblems = (source) => {
      const specifiers = moduleSpecifiersOf(source, 'migrate-core.mjs');
      const problems = specifiers.filter((specifier) => !isBuiltinOrPackage(specifier)).map((specifier) => `loads ${specifier}`);
      // A string naming a file beside it, whatever loads it: a require bound by assignment or reached
      // through the module object, which moduleSpecifiersOf does not follow.
      problems.push(...relativeLiteralsOf(source, 'migrate-core.mjs').map((text) => `names ${text}`));
      const modules = [...new Set(specifiers.filter((specifier) => typeof specifier === 'string'))].sort();
      if (modules.join(' ') !== ENGINE_MODULES.join(' ')) problems.push(`imports ${modules.join(', ')}`);
      return problems;
    };
    expect(reloadProblems(core)).toEqual([]);
    // Each way an edit could bring a sibling or a package in, added to the real file, is caught.
    for (const [name, line] of Object.entries({
      'a static import of a sibling': "import { API_ROLE_REVOKE_SQL } from './grants.mjs';",
      'a re-export from a sibling': "export { GRANTS_SQL } from './grants.mjs';",
      'a re-export of everything in a sibling': "export * from './grants.mjs';",
      'a side-effect import from the parent folder': "import '../grants.mjs';",
      'a dynamic import of a sibling': "const grants = await import('./grants.mjs');",
      'a dynamic import of a computed path': 'const grants = await import(GRANTS_FILE);',
      'a dynamic import of a template literal': "const grants = await import(`./${'grants'}.mjs`);",
      'a file URL': "const grants = await import('file:///srv/nextblock/tools/lib/grants.mjs');",
      'a dynamic import of a resolved sibling': "const grants = await import(import.meta.resolve('./grants.mjs'));",
      'a require createRequire made, called at once': "const grants = createRequire(import.meta.url)('./grants.cjs');",
      'a require createRequire made, under a name': "const load = createRequire(import.meta.url);\nconst grants = load('./grants.cjs');",
      'a require createRequire made under another import name':
        "import { createRequire as makeRequire } from 'node:module';\nconst grants = makeRequire(import.meta.url)('./grants.cjs');",
      'a require createRequire made through the module object':
        "import nodeModule from 'node:module';\nconst grants = nodeModule.createRequire(import.meta.url)('./grants.cjs');",
      'a require createRequire made, assigned later': "let load;\nload = createRequire(import.meta.url);\nconst grants = load('./grants.cjs');",
      'a package import': "import { GRANTS_SQL as SHARED_GRANTS_SQL } from '@nextblock-cms/db/grants';",
      'a dynamic import of a package': "const shared = await import('@nextblock-cms/db');",
    })) {
      expect(reloadProblems(`${core}\n${line}\n`).length, name).toBeGreaterThan(0);
    }
  });

  it('loadEnvFiles(root) loads .env.local, then .env, from the root it is given, and keeps a variable already set', async () => {
    // The updater calls it with the project root, the reload a second time: the second call overrides nothing.
    const { root } = makeProject();
    writeFileSync(path.join(root, '.env.local'), 'NB_ENGINE_CONTRACT_A=from .env.local\n');
    writeFileSync(path.join(root, '.env'), 'NB_ENGINE_CONTRACT_A=from .env\nNB_ENGINE_CONTRACT_B=from .env\nNB_ENGINE_CONTRACT_SET=from .env\n');
    vi.stubEnv('NB_ENGINE_CONTRACT_A', undefined);
    vi.stubEnv('NB_ENGINE_CONTRACT_B', undefined);
    vi.stubEnv('NB_ENGINE_CONTRACT_SET', 'set before the call');

    await loadEnvFiles(root);
    expect(process.env.NB_ENGINE_CONTRACT_A).toBe('from .env.local');
    expect(process.env.NB_ENGINE_CONTRACT_B).toBe('from .env');
    expect(process.env.NB_ENGINE_CONTRACT_SET).toBe('set before the call');
  });

  it('describeBackend() answers { kind, detail } for each backend', () => {
    // The updater stops at kind 'none' and prints the detail.
    useBackend('none');
    expect(describeBackend()).toMatchObject({ kind: 'none', detail: expect.any(String) });
    useBackend('postgres');
    expect(describeBackend()).toMatchObject({ kind: 'postgres', detail: '127.0.0.1:9' });
    useBackend('management-api');
    expect(describeBackend()).toMatchObject({ kind: 'management-api', detail: expect.stringContaining('stubref') });
  });

  it('collectMigrations(root) answers { files: [{ version, name, dir }], sources: [{ label, contributed }] } from the root it is given', () => {
    // The updater counts and names the files, hands them back to applyMigrations, and prints each
    // source's contribution.
    const { root, dir } = makeProject();
    const { files, sources } = collectMigrations(root);
    expect(files.filter((file) => file.dir === dir)).toEqual([
      expect.objectContaining({ version: '02001', name: '02001_first.sql', dir }),
      expect.objectContaining({ version: '02002', name: '02002_second.sql', dir }),
    ]);
    expect(sources).toContainEqual(expect.objectContaining({ label: 'project', dir, contributed: 2 }));
    for (const source of sources) expect(source).toMatchObject({ label: expect.any(String), contributed: expect.any(Number) });
  });

  for (const backend of ['management-api', 'postgres']) {
    it(`readAppliedVersions(), applyMigrations(files, { onApplied }) and runSql(sql) keep their arguments and results on ${backend}`, async () => {
      const received = useBackend(backend);
      // The updater reads ok and error, and spreads and probes versions as a Set.
      const applied = await readAppliedVersions();
      expect(applied).toMatchObject({ ok: true });
      expect(applied.versions).toBeInstanceOf(Set);
      expect([...applied.versions]).toEqual(['02001']);

      // It hands collectMigrations' files in, prints each one onApplied reports, then reads ok, applied and error.
      const { root, dir } = makeProject();
      const files = collectMigrations(root).files.filter((file) => file.dir === dir);
      const reported = [];
      expect(await applyMigrations(files, { onApplied: (file) => reported.push(file) })).toMatchObject({ ok: true, applied: 1 });
      expect(reported).toHaveLength(1);
      expect(reported[0]).toBe(files[1]);
      expect(received.filter((sql) => sql.includes('select 2;') && sql.includes("values ('02002', '02002_second.sql')"))).toHaveLength(1);
      expect(received.slice(-2)).toEqual([GRANTS_SQL, "notify pgrst, 'reload schema';"]);

      // The update alert: one statement, and ok.
      expect(await runSql('select 42;')).toMatchObject({ ok: true });
      expect(received.at(-1)).toBe('select 42;');
    });
  }

  it('answers a call that fails with ok: false and the error the updater prints', async () => {
    useBackend('management-api', 400);
    const { root, dir } = makeProject();
    const files = collectMigrations(root).files.filter((file) => file.dir === dir);
    const refused = expect.stringContaining('Supabase Management API 400');

    expect(await readAppliedVersions()).toMatchObject({ ok: false, error: refused });
    expect(await applyMigrations(files, { onApplied: () => expect.unreachable('nothing was applied') })).toMatchObject({ ok: false, applied: 0, error: refused });
    expect(await runSql('select 42;')).toMatchObject({ ok: false, error: refused });
  });
});

// The migration folder, found from this file as collectMigrations finds it (the monorepo's libs/db
// from here and from the CLI template's copy of this file); schema-apply.ts finds the same folder from
// the working directory. GENERATION is its squash generation, CATCHUP its GG000.
const folder = collectMigrations(here).files;
const GENERATION = Math.max(...folder.map((file) => Number.parseInt(file.version.slice(0, 2), 10)));
const CATCHUP = folder.find((file) => file.version === `${String(GENERATION).padStart(2, '0')}000`)?.name;
// Generation 1's first and last files, as a standalone project made before the generation-2 squash
// still holds them in supabase/migrations: the update only ever adds to that folder.
const RETIRED_FILES = ['00000000000000_baseline_schema.sql', '00000000000042_how_nextblock_works_css_diagram.sql'];

/** The statements that change the database: everything an applier sends but its reads. */
const writesIn = (statements) => statements.filter((sql) => !/^\s*select\b/i.test(sql));
/** The versions the statements record, in order: one per migration applied. */
const recordedIn = (statements) =>
  statements.flatMap((sql) => [...sql.matchAll(/insert into supabase_migrations\.schema_migrations \(version, name\) values \('(\d+)'/g)].map((match) => match[1]));

/**
 * Runs `apply` against the stand-in database in `state`, over `kind` (the Management API on a stubbed
 * fetch, or Postgres on the stand-in), and returns its result with the statements that backend received.
 */
async function runApplier(kind, state, apply) {
  database.reset();
  Object.assign(database.state, state);
  postgresStatements.length = 0;
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', kind === 'management-api' ? 'stub-token' : '');
  vi.stubEnv('SUPABASE_PROJECT_ID', kind === 'management-api' ? 'stubref' : '');
  vi.stubEnv('POSTGRES_URL', kind === 'postgres' ? 'postgres://nextblock:stub@127.0.0.1:9/nextblock' : '');
  vi.stubEnv('DATABASE_URL', '');
  const queries = [];
  vi.stubGlobal('fetch', async (_url, init) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return new Response(JSON.stringify(database.answer(query)), { status: 200 });
  });
  const result = await apply();
  return { result, statements: [...(kind === 'postgres' ? postgresStatements : queries)] };
}

// Each case replays the whole real folder through both appliers: about 0.2 s alone, past vitest's 5 s
// default in a loaded full run (2026-11-19, 48 files), and a case that times out keeps applying into the
// next case's stand-in database. The folder only grows, so the cases get room.
describe('both appliers over an empty migration history', { timeout: 30_000 }, () => {
  // tools/lib/migrate-core.mjs (the build hook and npm run update) and lib/setup/schema-apply.ts (/setup)
  // apply every file supabase_migrations.schema_migrations does not record. Over an empty history on a
  // database with content that never crossed the last squash, that replays the retired generation: the
  // catch-up decides what to replay from the recorded versions (docs/04 → "How a squash crosses live
  // databases"), which is why `npm run db:migrate` refuses the baseline over an empty history. Until
  // 2026-11-19 both appliers applied it. They refuse it now, before they write anything, and still replay
  // every file over an empty database and over one born at, or crossed to, the folder's generation.
  // Each case runs on both appliers and both backends, against the stand-in database and the real folder.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    postgresStatements.length = 0;
    database.reset();
  });

  it('reads the real folder', () => {
    expect(GENERATION).toBeGreaterThanOrEqual(2);
    expect(CATCHUP).toBe(`${String(GENERATION).padStart(2, '0')}000_catchup_gen${GENERATION - 1}.sql`);
    expect(folder.length).toBeGreaterThan(5);
  });

  const EVERY_FILE = 'every file';
  const CASES = [
    { name: 'an empty database', state: { versions: [], tracked: false, siteSettings: false }, applies: EVERY_FILE },
    { name: `a database at generation ${GENERATION} (born there, or crossed) whose history was emptied`, state: { versions: [], generation: GENERATION }, applies: EVERY_FILE },
    { name: 'recorded versions over a dropped public schema (the self-heal)', state: { versions: ['02001'], siteSettings: false }, applies: EVERY_FILE },
    {
      name: 'a recorded history on a database whose marker is unset (production after the squash reconcile)',
      state: { versions: folder.slice(0, -1).map((file) => file.version), generation: null },
      applies: 'the last file',
    },
    { name: 'a database that never crossed, its history emptied', state: { versions: [], generation: null }, refused: 'unset' },
    { name: `a database behind generation ${GENERATION} (marker ${GENERATION - 1})`, state: { versions: [], generation: GENERATION - 1 }, refused: String(GENERATION - 1) },
    { name: 'a database with content and no tracking table (a dump of the public schema alone)', state: { versions: [], tracked: false, generation: null }, refused: 'unset' },
  ];

  for (const backend of ['management-api', 'postgres']) {
    for (const { name, state, applies, refused } of CASES) {
      it(`${refused ? 'refuses' : 'applies'} ${name}, alike in both appliers, on ${backend}`, async () => {
        const core = await runApplier(backend, state, () => applyMigrations(folder));
        const setup = await runApplier(backend, state, () => applySetupMigrations());
        for (const [label, { result, statements }] of [['migrate-core.mjs', core], ['schema-apply.ts', setup]]) {
          if (refused) {
            expect(result, label).toMatchObject({ ok: false, applied: 0 });
            expect(result.refusal, label).toEqual({ generation: GENERATION, baselineGeneration: state.generation, catchup: CATCHUP, retired: [], message: result.error });
            expect(result.error, label).toContain(`It never crossed squash generation ${GENERATION} (site_settings.migration_baseline_generation is ${refused}), and ${CATCHUP}`);
            // Nothing written: no tracking table, no history row, no migration, no grant pass.
            expect(writesIn(statements), label).toEqual([]);
          } else {
            const expected = applies === EVERY_FILE ? folder : folder.slice(-1);
            expect(result, label).toMatchObject({ ok: true, applied: expected.length });
            expect(result.refusal, label).toBeUndefined();
            expect(recordedIn(statements), label).toEqual(expected.map((file) => file.version));
            expect(statements.slice(-2), label).toEqual([GRANTS_SQL, "notify pgrst, 'reload schema';"]);
          }
        }
        // The same answer, and the same files in the same order (only migrate-core.mjs names its backend).
        expect({ ...setup.result, backend: undefined }).toEqual({ ...core.result, backend: undefined });
        expect(recordedIn(setup.statements)).toEqual(recordedIn(core.statements));
      });
    }
  }

  for (const backend of ['management-api', 'postgres']) {
    it(`readAppliedVersions answers the refusal applyMigrations would, before anything is applied, on ${backend}`, async () => {
      const NEVER_CROSSED = { versions: [], generation: null };
      const applying = await runApplier(backend, NEVER_CROSSED, () => applyMigrations(folder));
      const read = await runApplier(backend, NEVER_CROSSED, () => readAppliedVersions(folder));
      // ok false with the message as the error: an updater that predates the refusal reads only those, and stops.
      expect(read.result).toEqual({ ok: false, versions: new Set(), error: applying.result.error, refusal: applying.result.refusal });
      expect(writesIn(read.statements)).toEqual([]);
      // Such an updater passes no files: the engine judges the ones it finds from the working directory.
      const unnamed = await runApplier(backend, NEVER_CROSSED, () => readAppliedVersions());
      expect(unnamed.result).toMatchObject({ ok: false, refusal: { generation: GENERATION, baselineGeneration: null, catchup: CATCHUP } });
      // A database at the folder's generation, and an empty one, read as an empty history, which replays.
      for (const state of [{ versions: [], generation: GENERATION }, { versions: [], tracked: false, siteSettings: false }]) {
        expect((await runApplier(backend, state, () => readAppliedVersions(folder))).result).toEqual({ ok: true, versions: new Set() });
      }
      // A recorded history reads as before, whatever the marker.
      expect((await runApplier(backend, { versions: ['02001'], generation: null }, () => readAppliedVersions(folder))).result).toEqual({
        ok: true,
        versions: new Set(['02001']),
      });
    });

    it(`refuses a retired generation's files over an empty history, even at generation ${GENERATION}, on ${backend}`, async () => {
      const retired = RETIRED_FILES.map((name) => ({ version: name.split('_')[0], name, dir: folder[0].dir }));
      const files = [...retired, ...folder];
      const AT_GENERATION = { versions: [], generation: GENERATION };
      const refused = await runApplier(backend, AT_GENERATION, () => applyMigrations(files));
      expect(refused.result).toMatchObject({
        ok: false,
        applied: 0,
        refusal: { generation: GENERATION, baselineGeneration: GENERATION, catchup: CATCHUP, retired: RETIRED_FILES },
      });
      expect(refused.result.error).toContain(`2 file(s) from a retired squash generation (${RETIRED_FILES[0]} … ${RETIRED_FILES[1]}) would run again as written.`);
      expect(refused.result.error).toContain(
        `This database crossed generation ${GENERATION} already, so nothing needs those files any more: remove them from supabase/migrations, or restore the history, and try again`,
      );
      expect(refused.result.error).not.toContain('never crossed');
      expect(writesIn(refused.statements)).toEqual([]);
      const read = await runApplier(backend, AT_GENERATION, () => readAppliedVersions(files));
      expect(read.result).toEqual({ ok: false, versions: new Set(), error: refused.result.error, refusal: refused.result.refusal });
      // A history that records them is not the guard's to judge: recorded files are skipped, the rest applied.
      const recorded = await runApplier(backend, { versions: files.slice(0, -1).map((file) => file.version), generation: GENERATION }, () => applyMigrations(files));
      expect(recorded.result).toMatchObject({ ok: true, applied: 1 });
    });
  }
});

describe('emptyHistoryRefusal, alike in both appliers', () => {
  const names = folder.map((file) => file.name);
  // The next squash's folder, as GG000 to GG004 plus a forward migration would name it.
  const NEXT = ['03000_catchup_gen2.sql', '03001_baseline_schema.sql', '03005_next_forward_migration.sql'];
  const OWN = '20251201093000_my_own_table.sql'; // a project's own migration, numbered by `supabase migration new`

  it('answers every input the same way, message included', () => {
    const INPUTS = [
      [names, null],
      [names, GENERATION - 1],
      [names, GENERATION],
      [names, GENERATION + 1],
      [[...RETIRED_FILES, ...names], null],
      [[...RETIRED_FILES, ...names], GENERATION],
      [[RETIRED_FILES[0], ...names], GENERATION],
      [[...names, OWN], GENERATION],
      [[...names, OWN], null],
      [RETIRED_FILES, null],
      [[], null],
      [NEXT, 2],
      [NEXT, 3],
      [['02001_baseline_schema.sql'], null],
    ];
    for (const [list, generation] of INPUTS) {
      expect(setupEmptyHistoryRefusal(list, generation), `${list.length} file(s), marker ${generation}`).toEqual(emptyHistoryRefusal(list, generation));
    }
  });

  it("refuses a database behind the folder's generation and a list with a retired file, and nothing else", () => {
    // At or past the folder's generation, holding its files or a project's own: every file replays.
    expect(emptyHistoryRefusal(names, GENERATION)).toBeNull();
    expect(emptyHistoryRefusal(names, GENERATION + 1)).toBeNull();
    expect(emptyHistoryRefusal([...names, OWN], GENERATION)).toBeNull();
    expect(emptyHistoryRefusal(NEXT, 3)).toBeNull();
    // No GGNNN file, so no generation to hold the marker to.
    expect(emptyHistoryRefusal(RETIRED_FILES, null)).toBeNull();
    expect(emptyHistoryRefusal([], null)).toBeNull();

    expect(emptyHistoryRefusal(names, null)).toEqual({
      generation: GENERATION,
      baselineGeneration: null,
      catchup: CATCHUP,
      retired: [],
      message:
        'The migration history (supabase_migrations.schema_migrations) is empty, but this database already holds NextBlock content (public.site_settings). ' +
        `It never crossed squash generation ${GENERATION} (site_settings.migration_baseline_generation is unset), and ${CATCHUP} decides what to replay ` +
        `from the recorded versions: with none recorded, it would run every generation-${GENERATION - 1} migration again over that content. ` +
        'Restore supabase_migrations.schema_migrations from a backup of this database (a dump of the public schema alone leaves it out: copy it from ' +
        'the database the dump came from), then try again (docs/13-STAYING-UP-TO-DATE.md, "The contract every applier honours").',
    });
    // Both reasons at once: restoring the history is the remedy, as the marker says the database never crossed.
    const both = emptyHistoryRefusal([...RETIRED_FILES, ...names], null);
    expect(both.retired).toEqual(RETIRED_FILES);
    expect(both.message).toContain(`2 file(s) from a retired squash generation (${RETIRED_FILES[0]} … ${RETIRED_FILES[1]}) would also run again as written.`);
    expect(both.message).toContain('Restore supabase_migrations.schema_migrations from a backup of this database');
    expect(both.message).not.toContain('remove them');
    // One retired file is named alone.
    expect(emptyHistoryRefusal([RETIRED_FILES[0], ...names], GENERATION).message).toContain(
      `1 file(s) from a retired squash generation (${RETIRED_FILES[0]}) would run again as written.`,
    );
    // The next squash: a database at generation 2 is behind a generation-3 folder, whose catch-up replays generation 2.
    expect(emptyHistoryRefusal(NEXT, 2).message).toContain(
      'It never crossed squash generation 3 (site_settings.migration_baseline_generation is 2), and 03000_catchup_gen2.sql decides what to ' +
        'replay from the recorded versions: with none recorded, it would run every generation-2 migration again over that content.',
    );
    // A list without its catch-up still says which one decides.
    expect(emptyHistoryRefusal(['02001_baseline_schema.sql'], null)).toMatchObject({
      catchup: null,
      message: expect.stringContaining('and the generation-2 catch-up decides what to replay'),
    });
  });

  it('reads the generation marker with the same query in both appliers', () => {
    const core = read('./migrate-core.mjs');
    const setup = read('../../lib/setup/schema-apply.ts');
    const query = constantsOf(core, 'migrate-core.mjs')('BASELINE_GENERATION_SQL');
    expect(query).toContain("where key = 'migration_baseline_generation'");
    expect(constantsOf(setup, 'schema-apply.ts')('BASELINE_GENERATION_SQL')).toBe(query);
  });
});

describe('the build hook when the engine refuses an empty history', () => {
  // tools/build-migrate.mjs runs before every production build and must never fail one. This runs the
  // real file beside an engine whose applyMigrations answers emptyHistoryRefusal's refusal.
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('logs the refusal and what it changed (nothing), and exits 0, so the build goes on', () => {
    // As emptyHistoryRefusal words it (tested above); the hook prints whatever message the engine gives.
    const message =
      'The migration history (supabase_migrations.schema_migrations) is empty, but this database already holds NextBlock content ' +
      '(public.site_settings). Restore supabase_migrations.schema_migrations from a backup of this database, then try again.';
    const refusal = { generation: GENERATION, baselineGeneration: null, catchup: CATCHUP, retired: [], message };
    const root = mkdtempSync(path.join(os.tmpdir(), 'nb-build-migrate-'));
    roots.push(root);
    mkdirSync(path.join(root, 'tools', 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    writeFileSync(path.join(root, 'tools', 'build-migrate.mjs'), read('../build-migrate.mjs'));
    const files = folder.map(({ version, name }) => ({ version, name, dir: '.' }));
    writeFileSync(
      path.join(root, 'tools', 'lib', 'migrate-core.mjs'),
      [
        'export async function loadEnvFiles() {}',
        "export function describeBackend() { return { kind: 'postgres', detail: 'stub' }; }",
        `export function collectMigrations() { return { files: ${JSON.stringify(files)}, sources: [] }; }`,
        `export async function applyMigrations() { return ${JSON.stringify({ ok: false, applied: 0, backend: 'postgres', error: refusal.message, refusal })}; }`,
        '',
      ].join('\n'),
    );
    const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => KEEP.has(key.toUpperCase())));
    const run = spawnSync(process.execPath, [path.join(root, 'tools', 'build-migrate.mjs')], {
      cwd: root,
      env: { ...env, NEXTBLOCK_BUILD_MIGRATE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`[build-migrate] WARNING: migrations not applied. ${refusal.message}`);
    expect(run.stdout).toContain('[build-migrate] Continuing the build; the database was not changed.');
    expect(run.stdout).not.toContain('apply later with "npm run update"');
  }, 60_000);
});
