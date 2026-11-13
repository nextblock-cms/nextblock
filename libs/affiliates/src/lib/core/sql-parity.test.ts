import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCurrencyMinorUnitFactor } from '@nextblock-cms/utils';
import { describe, expect, it } from 'vitest';

import { AFFILIATES_COMMON_COPY } from '../i18n/copy/common';
import { AFFILIATE_ADMIN_EMAIL_COPY } from '../notifications/copy';
import {
  AFFILIATE_MANUAL_PAYOUT_CANCEL_STATUSES,
  AFFILIATE_MANUAL_PAYOUT_CLAIM_STATUSES,
  AFFILIATE_MANUAL_PAYOUT_RECORD_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_BATCH_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_CLAIM_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_COMPLETE_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_FAIL_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES,
  AFFILIATE_PAYPAL_PAYOUT_RELEASE_STATUSES,
} from '../payouts/rpc';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_BADGE_COLORS,
  AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH,
  AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH,
  AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH,
  AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS,
  AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH,
  AFFILIATE_PAYPAL_SETTINGS_KEY,
  AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS,
} from './constants';
import { isAffiliatePayPalReceiverFailureReason } from './payout-methods';
import { AFFILIATE_HANDLE_PATTERN } from './handle';
import {
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_GATEWAYS,
  AFFILIATE_MANUAL_PAYOUT_CHANNELS,
  AFFILIATE_ONBOARDING_STEPS,
  AFFILIATE_PAGE_STATUSES,
  AFFILIATE_PAYOUT_EMAIL_KINDS,
  AFFILIATE_PAYOUT_METHODS,
  AFFILIATE_PAYOUT_STATUSES,
  AFFILIATE_STATUSES,
} from './statuses';

/**
 * The hand-written contract (core/types.ts, constants, handle regex, money and email mirrors)
 * against migration 02030, so a change on either side fails here instead of in production.
 * Function bodies are read at their LATEST definition across 02030 and every later migration
 * (02035 redefines affiliate_record_commission, set_affiliate_commission_dispute and
 * affiliate_profile_guard): a rule must hold on
 * the code that runs, not on a definition a later file replaced.
 */
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/src/supabase/migrations');
const SCHEMA_FILE = '02030_affiliates_schema.sql';
const MIGRATION = path.join(MIGRATIONS_DIR, SCHEMA_FILE);
const readSql = (file: string) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
const sql = existsSync(MIGRATION) ? readSql(SCHEMA_FILE) : '';
/** 02030 and every later migration of the folder, in apply order. */
const LEDGER_FILES = sql
  ? readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{5}_[a-z0-9_]+\.sql$/.test(file) && file >= SCHEMA_FILE)
      .sort()
  : [];
const LEDGER_SOURCES = LEDGER_FILES.map((file) => ({ file, sql: readSql(file) }));
const RATE_AT_PAYMENT_FILE = '02035_affiliate_tier_rate_at_payment.sql';
const rateAtPayment = LEDGER_SOURCES.find((source) => source.file === RATE_AT_PAYMENT_FILE)?.sql ?? '';
const MANUAL_PAYOUTS_FILE = '02036_affiliate_manual_payouts.sql';
const manualPayouts = LEDGER_SOURCES.find((source) => source.file === MANUAL_PAYOUTS_FILE)?.sql ?? '';
const PAYPAL_PAYOUTS_FILE = '02037_affiliate_paypal_payouts.sql';
const paypalPayouts = LEDGER_SOURCES.find((source) => source.file === PAYPAL_PAYOUTS_FILE)?.sql ?? '';

/** The last match of `pattern` across 02030 and every later migration (null when none matches). */
function latestMatch(pattern: RegExp): RegExpMatchArray | null {
  let latest: RegExpMatchArray | null = null;
  for (const source of LEDGER_SOURCES) latest = source.sql.match(pattern) ?? latest;
  return latest;
}

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((match) => match[1] as string);
}

function enumValues(typeName: string): string[] {
  const match = sql.match(new RegExp(`CREATE TYPE public\\.${typeName} AS ENUM \\(([^)]*)\\)`, 'i'));
  return match ? quotedList(match[1] as string) : [];
}

/** One function of `source`, from its CREATE to the `$$;` that closes its body ('' when missing). */
function functionSqlIn(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf('$$;', source.indexOf('$$', start) + 2);
  return end < 0 ? '' : source.slice(start, end + 3);
}

/** The latest definition of a function across 02030 and every later migration ('' when missing). */
function functionSql(name: string): string {
  let latest = '';
  for (const source of LEDGER_SOURCES) latest = functionSqlIn(source.sql, name) || latest;
  return latest;
}

/** The columns a guard compares as `NEW.x IS DISTINCT FROM OLD.x` inside its first IF. */
function protectedColumns(guard: string): string[] {
  const first = guard.slice(guard.indexOf('IF TG_OP'), guard.indexOf('THEN'));
  return [...first.matchAll(/NEW\.([a-z_]+) IS DISTINCT FROM OLD\.\1/g)].map((match) => match[1] as string);
}

/** The statements (text between semicolons) of a function that contain `needle`. */
function statementsWith(fn: string, needle: string): string[] {
  return fn.split(';').filter((statement) => statement.includes(needle));
}

describe.skipIf(!sql)('02030_affiliates_schema.sql parity', () => {
  it('uses the handle regex of AFFILIATE_HANDLE_PATTERN in the profiles CHECK', () => {
    expect(sql).toContain(`handle ~ '${AFFILIATE_HANDLE_PATTERN.source}'`);
  });

  it('declares the enum types with the values of core/statuses.ts, in order', () => {
    expect(enumValues('affiliate_onboarding_step')).toEqual([...AFFILIATE_ONBOARDING_STEPS]);
    expect(enumValues('affiliate_status')).toEqual([...AFFILIATE_STATUSES]);
    expect(enumValues('affiliate_page_status')).toEqual([...AFFILIATE_PAGE_STATUSES]);
    expect(enumValues('affiliate_gateway')).toEqual([...AFFILIATE_GATEWAYS]);
    expect(enumValues('affiliate_commission_status')).toEqual([...AFFILIATE_COMMISSION_STATUSES]);
    expect(enumValues('affiliate_payout_status')).toEqual([...AFFILIATE_PAYOUT_STATUSES]);
  });

  it('allows exactly the badge colours of AFFILIATE_BADGE_COLORS', () => {
    const match = sql.match(/badge_color IN \(([^)]*)\)/);
    expect(match ? quotedList(match[1] as string) : null).toEqual([...AFFILIATE_BADGE_COLORS]);
  });

  it('lets system_alerts hold every AFFILIATE_ALERT_TYPES value', () => {
    const match = sql.match(/system_alerts_alert_type_check CHECK \(alert_type = ANY \(ARRAY\[([^\]]*)\]/);
    const allowed = match ? quotedList(match[1] as string) : [];
    for (const type of Object.values(AFFILIATE_ALERT_TYPES)) {
      expect(allowed, type).toContain(type);
    }
  });

  it('uses the zero-decimal currency list of @nextblock-cms/utils', () => {
    const match = sql.match(/affiliate_currency_factor\(p_code text\)[\s\S]*?ARRAY\[([^\]]*)\]/);
    const zeroDecimal = match ? quotedList(match[1] as string) : [];
    expect(zeroDecimal.length).toBeGreaterThan(0);
    for (const code of zeroDecimal) expect(getCurrencyMinorUnitFactor(code), code).toBe(1);
    for (const code of ['USD', 'EUR', 'CAD', 'GBP', 'BHD']) {
      expect(zeroDecimal, code).not.toContain(code);
      expect(getCurrencyMinorUnitFactor(code), code).toBe(100);
    }
  });

  it('seeds the four tiers whose names the common copy carries', () => {
    const insert = sql.match(/INSERT INTO public\.affiliate_tiers[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/);
    expect(insert).not.toBeNull();
    const rows = [...(insert?.[1] ?? '').matchAll(/\('([^']+)',\s*'\{"fr":\s*"([^"]+)"\}'::jsonb,\s*'([^']+)',\s*([\d.]+),\s*(\d+),\s*(true|false),\s*(true|false),\s*(NULL|\d+),\s*'([^']+)'\)/g)].map(
      ([, name, fr, slug, rate, sort, isDefault, isPromo, cap, badge]) => ({ name, fr, slug, rate: Number(rate), sort: Number(sort), isDefault, isPromo, cap, badge })
    );

    expect(rows).toEqual([
      { name: 'Starter Partner', fr: 'Partenaire Départ', slug: 'starter-partner', rate: 10, sort: 1, isDefault: 'false', isPromo: 'false', cap: 'NULL', badge: 'slate' },
      { name: 'Growth Partner', fr: 'Partenaire Croissance', slug: 'growth-partner', rate: 20, sort: 2, isDefault: 'false', isPromo: 'false', cap: 'NULL', badge: 'sky' },
      { name: 'Elite Partner', fr: 'Partenaire Élite', slug: 'elite-partner', rate: 35, sort: 3, isDefault: 'false', isPromo: 'false', cap: 'NULL', badge: 'violet' },
      { name: 'Founding Ambassador', fr: 'Ambassadeur fondateur', slug: 'founding-ambassador', rate: 50, sort: 4, isDefault: 'true', isPromo: 'true', cap: '50', badge: 'amber' },
    ]);

    const copy = AFFILIATES_COMMON_COPY as Record<string, { en: string; fr: string } | undefined>;
    for (const row of rows) {
      expect(copy[`affiliates.common.tier_name_${row.slug.replace(/-/g, '_')}`], row.slug).toEqual({ en: row.name, fr: row.fr });
    }
  });

  it('keeps the commission formulas the TS mirrors (money.ts), in the definition that runs', () => {
    const record = functionSql('private.affiliate_record_commission');
    expect(record).toMatch(/v_net_minor::numeric \/ private\.affiliate_currency_factor\(v_order_currency\)\)\s*\/ v_rate\s*\* private\.affiliate_currency_factor\(v_base_currency\)/);
    // round(net_base × rate / 100), the rate being the one stored on the order at payment (02035)
    expect(record).toContain('round(v_net_base::numeric * v_commission_pct / 100)');
    expect(record).toContain('v_commission_pct := coalesce(v_order.affiliate_commission_rate, v_tier.commission_percentage);');
  });

  it('defines the email normalizer normalizeAffiliateEmail mirrors (email.ts)', () => {
    const fn = sql.match(/FUNCTION private\.affiliate_normalize_email\(p_email text\)[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain("IN ('gmail.com', 'googlemail.com')");
    expect(fn).toContain("strpos(v_local, '+')");
    expect(fn).toContain("strpos(reverse(v_email), '@')");
    expect(fn).toContain("RETURN v_local || '@' || v_domain;");
  });
});

/**
 * Ledger rules of the 2026-10-27 review that live only in SQL. tools/scripts/security-verify.sql
 * (sections 35-38, 37b) proves the behaviour on a local replay; these keep each rule on every
 * statement it has to be on, so an edit that drops one from a single statement fails here.
 */
describe.skipIf(!sql)('02030_affiliates_schema.sql ledger rules', () => {
  it('pays a sale only with a transfer of its own key mode (finding C)', () => {
    const claim = functionSql('public.claim_affiliate_payout');
    // the lock, the void loop, the sum and the attaching UPDATE
    const cleared = statementsWith(claim, "c.status = 'CLEARED'::public.affiliate_commission_status");
    expect(cleared).toHaveLength(4);
    for (const statement of cleared) {
      expect(statement).toContain('c.livemode = v_profile.stripe_connect_livemode');
      expect(statement).toContain('c.disputed_at IS NULL');
    }
    expect(claim).toContain('OR v_profile.stripe_connect_livemode IS NULL THEN');
    expect(claim).toMatch(
      /INSERT INTO public\.affiliate_payouts \([^)]*\blivemode\b[^)]*\)\s*VALUES \([^;]*v_profile\.stripe_connect_livemode/
    );

    const record = functionSql('private.affiliate_record_commission');
    expect(record).toContain('o.affiliate_livemode');
    expect(record).toContain('coalesce(v_order.affiliate_livemode, true)');

    expect(functionSql('public.prepare_affiliate_payout_retry')).toContain(
      'v_profile.stripe_connect_livemode IS DISTINCT FROM v_current.livemode'
    );
  });

  it('holds a commission an open dispute flags out of promote and retry (finding L)', () => {
    const promote = functionSql('public.promote_cleared_affiliate_commissions');
    // the partner list, the lock, the void loop and the promoting UPDATE
    const candidates = statementsWith(promote, "c.status = 'PENDING_CLEARANCE'::public.affiliate_commission_status");
    expect(candidates).toHaveLength(4);
    for (const statement of candidates) expect(statement).toContain('c.disputed_at IS NULL');

    expect(functionSql('public.prepare_affiliate_payout_retry')).toMatch(
      /SET payout_id = NULL\s+WHERE c\.payout_id = p_payout_id\s+AND \(c\.status = 'VOIDED_REFUND'::public\.affiliate_commission_status OR c\.disputed_at IS NOT NULL\)/
    );

    const dispute = functionSql('public.set_affiliate_commission_dispute');
    expect(dispute).toContain('(p_gateway public.affiliate_gateway, p_order_id uuid, p_open boolean)');
    expect(new Set([...dispute.matchAll(/RETURN '([a-z_]+)'/g)].map((match) => match[1]))).toEqual(
      new Set(['none', 'released', 'held'])
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('hands a retry below the minimum back and never completes such a payout (finding Z)', () => {
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.prepare_affiliate_payout_retry(uuid);');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(sql.indexOf('CREATE OR REPLACE FUNCTION public.prepare_affiliate_payout_retry('));

    const retry = functionSql('public.prepare_affiliate_payout_retry');
    expect(retry).toContain('prepare_affiliate_payout_retry(p_payout_id uuid, p_min_amount bigint DEFAULT 0)');
    expect(retry).toContain('v_amount < GREATEST(coalesce(p_min_amount, 0), 0)');
    expect(retry).toContain("ELSE 'below_minimum' END");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.prepare_affiliate_payout_retry(uuid, bigint) FROM PUBLIC, anon, authenticated;');

    expect(functionSql('public.complete_affiliate_payout')).toContain("NOT IN ('released', 'nothing_to_pay', 'below_minimum')");
  });

  it('measures every refund with one share rule and keeps an early one on the order (findings I and Y)', () => {
    expect(functionSql('private.affiliate_refund_share')).toContain('LANGUAGE sql IMMUTABLE');
    for (const fn of ['public.apply_affiliate_refund', 'private.affiliate_record_commission']) {
      expect(functionSql(fn), fn).toContain('private.affiliate_refund_share(');
    }

    const apply = functionSql('public.apply_affiliate_refund');
    expect(apply).not.toContain('/ p_order_total_minor');
    expect(apply).toMatch(/SET affiliate_refunded_minor = p_refunded_minor,\s+affiliate_refund_total_minor = p_order_total_minor/);
    // the order row before the profile: the orders triggers hold it while they record or void
    expect(apply).toMatch(/FROM public\.orders o\s+WHERE o\.id = p_order_id\s+FOR UPDATE/);
    expect(apply.indexOf('FROM public.orders o')).toBeLessThan(apply.indexOf('FROM public.affiliate_profiles p'));

    expect(functionSql('private.affiliate_record_commission')).toContain('v_order.affiliate_refunded_minor');
  });

  it('locks the profile Approve snapshots while the page is PENDING_REVIEW (finding A)', () => {
    const guard = functionSql('private.affiliate_profile_guard');
    expect(guard).toContain("RAISE EXCEPTION 'affiliate_profile_pending_review'");
    expect(guard).toContain("USING ERRCODE = '55000'");
    expect(guard).toContain("pg.approval_status = 'PENDING_REVIEW'::public.affiliate_page_status");
    for (const column of ['display_name', 'bio', 'social_links']) {
      expect(guard, column).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
  });
});

/**
 * 02035: a tier move (or a rate edit) applies only to orders paid from then on. The rate and hold
 * are copied onto the order at payment, the commission is recorded at that rate whenever it is
 * recorded, and the hold counts from the payment, so a dispute that opens before a late commission
 * exists is kept on the order and holds that commission from the start. tools/scripts/security-verify.sql
 * section 39 proves the behaviour on a local replay; these pin the SQL that carries each rule.
 */
describe.skipIf(!sql || !rateAtPayment)(`${RATE_AT_PAYMENT_FILE} rules`, () => {
  it('keeps a dispute that opens before the commission on the order, and records that commission held (finding L)', () => {
    // A late commission (reconcile after a pause) whose hold, counted from the payment, has passed
    // would otherwise be promoted, claimed and transferred in the run that records it.
    const dispute = functionSql('public.set_affiliate_commission_dispute');
    expect(functionSqlIn(rateAtPayment, 'public.set_affiliate_commission_dispute')).toBe(dispute);
    for (const line of [
      'CREATE OR REPLACE FUNCTION public.set_affiliate_commission_dispute(p_gateway public.affiliate_gateway, p_order_id uuid, p_open boolean)',
      'RETURNS text',
      'LANGUAGE plpgsql SECURITY INVOKER',
      "SET search_path TO ''",
      "IF v_commission.status NOT IN ('PENDING_CLEARANCE', 'CLEARED') THEN",
      'UPDATE public.affiliate_commissions c SET disputed_at = now() WHERE c.id = v_commission.id;',
      'UPDATE public.affiliate_commissions c SET disputed_at = NULL WHERE c.id = v_commission.id;',
    ]) {
      expect(functionSqlIn(sql, 'public.set_affiliate_commission_dispute'), line).toContain(line);
      expect(dispute, line).toContain(line);
    }
    // the order row first (as apply_affiliate_refund takes it), then the profile, then the
    // commission re-read under the profile lock: reconcile records while holding that lock
    expect(dispute).toMatch(/FROM public\.orders o\s+WHERE o\.id = p_order_id\s+FOR UPDATE;/);
    const orderLock = dispute.indexOf('FROM public.orders o');
    const profileLock = dispute.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/);
    const commissionLock = dispute.search(/FROM public\.affiliate_commissions c\s+WHERE c\.order_id = p_order_id AND c\.gateway = p_gateway\s+FOR UPDATE;/);
    expect(orderLock).toBeGreaterThan(-1);
    expect(profileLock).toBeGreaterThan(orderLock);
    expect(commissionLock).toBeGreaterThan(profileLock);
    // no commission yet: an attributed order keeps the dispute (first date kept) and a close clears it
    const pending = dispute.slice(dispute.indexOf('IF NOT FOUND THEN'), dispute.indexOf('IF NOT p_open THEN'));
    expect(pending).toContain('v_order.affiliate_id IS DISTINCT FROM v_affiliate');
    expect(pending).toMatch(/IF v_order\.affiliate_disputed_at IS NULL THEN\s+UPDATE public\.orders o SET affiliate_disputed_at = now\(\) WHERE o\.id = p_order_id;/);
    expect(pending).toContain('UPDATE public.orders o SET affiliate_disputed_at = NULL WHERE o.id = p_order_id;');
    // a close lifts the order's mark too, once the commission exists
    expect(dispute.slice(dispute.indexOf('IF NOT p_open THEN'))).toContain(
      'UPDATE public.orders o SET affiliate_disputed_at = NULL WHERE o.id = p_order_id;'
    );
    // the answers stay 02030's (dispute.ts maps exactly these)
    expect(new Set([...dispute.matchAll(/RETURN '([a-z_]+)'/g)].map((match) => match[1]))).toEqual(new Set(['none', 'released', 'held']));
    for (const statement of [
      'REVOKE ALL ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) TO service_role;',
    ]) {
      expect(sql).toContain(statement);
      expect(rateAtPayment).toContain(statement);
    }

    // the recorder starts such a commission held (a voided one holds nothing)
    const record = functionSql('private.affiliate_record_commission');
    expect(record).toContain('o.affiliate_disputed_at');
    expect(record).toMatch(/currency, livemode, status, clears_at, voided_at, void_reason, disputed_at\s*\)\s*VALUES/);
    expect(record).toContain('CASE WHEN v_voided THEN NULL ELSE v_order.affiliate_disputed_at END');
    expect(rateAtPayment).toContain('ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_disputed_at timestamptz NULL;');
  });

  it('records the rate and hold stored on the order, counting the hold from the payment', () => {
    const record = functionSql('private.affiliate_record_commission');
    expect(functionSqlIn(rateAtPayment, 'private.affiliate_record_commission')).toBe(record);
    expect(record).toContain('o.affiliate_commission_rate, o.affiliate_clearance_hold_days');
    expect(record).toContain('v_hold_days := coalesce(v_order.affiliate_clearance_hold_days, v_tier.clearance_hold_days);');
    expect(record).toContain('coalesce(v_order.paid_at, now()) + make_interval(days => v_hold_days)');
    // the snapshot is what the ledger row records, never the tier read at recording
    expect(record).toMatch(/v_net_base,\s+v_commission_pct,\s+v_commission,/);
    expect(record).not.toContain('v_tier.commission_percentage / 100');
    expect(record).not.toContain('now() + make_interval(days => v_tier.clearance_hold_days)');
  });

  it("keeps every other rule and 02030's signature, security and grants on the recorder", () => {
    const before = functionSqlIn(sql, 'private.affiliate_record_commission');
    const after = functionSql('private.affiliate_record_commission');
    for (const line of [
      'CREATE OR REPLACE FUNCTION private.affiliate_record_commission(p_order_id uuid)',
      'RETURNS uuid',
      'LANGUAGE plpgsql SECURITY DEFINER',
      "SET search_path TO ''",
      "v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL",
      'v_order.user_id = v_profile.user_id',
      'v_partner_email = v_buyer_email',
      "v_order.status NOT IN ('paid', 'shipped')",
      'ON CONFLICT ON CONSTRAINT affiliate_commissions_order_gateway_key DO NOTHING',
      'v_voided := v_refunded >= v_commission;',
      'FOR UPDATE;',
    ]) {
      expect(before, line).toContain(line);
      expect(after, line).toContain(line);
    }
    for (const statement of [
      'REVOKE ALL ON FUNCTION private.affiliate_record_commission(uuid) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION private.affiliate_record_commission(uuid) TO service_role;',
    ]) {
      expect(sql).toContain(statement);
      expect(rateAtPayment).toContain(statement);
    }
  });

  it('copies the rate and hold onto an attributed order when it is first paid, and never fails the write', () => {
    const snapshot = functionSqlIn(rateAtPayment, 'private.affiliate_snapshot_order_rate');
    expect(snapshot).toContain('RETURNS trigger');
    expect(snapshot).toContain('LANGUAGE plpgsql SECURITY DEFINER');
    expect(snapshot).toContain("SET search_path TO ''");
    expect(snapshot).toMatch(/IF TG_OP = 'UPDATE' THEN\s+IF OLD\.paid_at IS NOT NULL THEN\s+RETURN NEW;/);
    expect(snapshot).toContain('IF NEW.affiliate_commission_rate IS NOT NULL AND NEW.affiliate_clearance_hold_days IS NOT NULL THEN');
    // the ledger's lock order: the order row (held by the write), then the profile, then the tier
    expect(snapshot).toMatch(/FROM public\.affiliate_profiles p\s+WHERE p\.id = NEW\.affiliate_id\s+FOR UPDATE;/);
    expect(snapshot.indexOf('FROM public.affiliate_profiles p')).toBeLessThan(snapshot.indexOf('FROM public.affiliate_tiers t'));
    expect(snapshot).toContain('EXCEPTION WHEN OTHERS THEN');
    // a paused partner's order keeps the rate of its payment too: no status check
    expect(snapshot).not.toMatch(/\bstatus\b/);
    expect(rateAtPayment).toMatch(
      /CREATE TRIGGER affiliate_snapshot_order_rate\s+BEFORE INSERT OR UPDATE OF paid_at ON public\.orders\s+FOR EACH ROW/
    );
    expect(rateAtPayment.indexOf('DROP TRIGGER IF EXISTS affiliate_snapshot_order_rate ON public.orders;')).toBeLessThan(
      rateAtPayment.indexOf('CREATE TRIGGER affiliate_snapshot_order_rate')
    );
    expect(rateAtPayment).toContain('REVOKE ALL ON FUNCTION private.affiliate_snapshot_order_rate() FROM PUBLIC, anon, authenticated;');
  });

  it('stamps tier_changed_at on every tier move and keeps it, with every 02030 column, from a partner session', () => {
    const before = protectedColumns(functionSqlIn(sql, 'private.affiliate_profile_guard'));
    const atThisFile = protectedColumns(functionSqlIn(rateAtPayment, 'private.affiliate_profile_guard'));
    const guard = functionSql('private.affiliate_profile_guard');
    const after = protectedColumns(guard);
    expect(before.length).toBeGreaterThan(20);
    expect(atThisFile.filter((column) => !before.includes(column))).toEqual(['tier_changed_at']);
    // A later definition (02036 adds payout_email) keeps every column of this one.
    expect(after).toEqual(expect.arrayContaining([...before, 'tier_changed_at']));
    expect(guard).toMatch(/IF TG_OP = 'UPDATE' AND NEW\.tier_id IS DISTINCT FROM OLD\.tier_id THEN\s+NEW\.tier_changed_at := now\(\);/);
    // the stamp comes after the session checks, which judge NEW as the statement wrote it
    expect(guard.indexOf("RAISE EXCEPTION 'affiliate_profile_pending_review'")).toBeLessThan(guard.indexOf('NEW.tier_changed_at := now()'));
  });

  it('moves a partner through one service-role RPC that locks, re-checks and never reads the status', () => {
    const move = functionSqlIn(rateAtPayment, 'public.change_affiliate_partner_tier');
    expect(move).toContain('(p_affiliate_id uuid, p_tier_id uuid, p_allow_over_cap boolean DEFAULT false)');
    expect(move).toContain('LANGUAGE plpgsql SECURITY INVOKER');
    expect(move).toContain("SET search_path TO ''");
    expect(new Set([...move.matchAll(/RETURN '([a-z_]+)'/g)].map((match) => match[1]))).toEqual(
      new Set(['not_found', 'unchanged', 'tier_not_found', 'tier_inactive', 'tier_full', 'moved'])
    );
    // the profile first, then both tier rows in create_affiliate_account()'s order, then the write
    const profileLock = move.search(/FROM public\.affiliate_profiles p\s+WHERE p\.id = p_affiliate_id\s+FOR UPDATE;/);
    const tierLock = move.search(/WHERE t\.id IN \(v_profile\.tier_id, p_tier_id\)[\s\S]*?FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(tierLock).toBeGreaterThan(profileLock);
    expect(move.indexOf('SET tier_id = p_tier_id')).toBeGreaterThan(tierLock);
    expect(move).toContain('NOT coalesce(p_allow_over_cap, false)');
    expect(move).not.toMatch(/\bstatus\b/);
    expect(rateAtPayment).toContain(
      'REVOKE ALL ON FUNCTION public.change_affiliate_partner_tier(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;'
    );
    expect(rateAtPayment).toContain('GRANT EXECUTE ON FUNCTION public.change_affiliate_partner_tier(uuid, uuid, boolean) TO service_role;');
  });
});

/**
 * 02036: commissions paid outside Stripe. The claim takes only the gateways the program pays through
 * Stripe; a manual payout is claimed (prepared) from live-mode commissions under the claim's locks
 * BEFORE any money is sent, then recorded or cancelled, and the Stripe RPCs can never touch it; the
 * partner's payout address is server-written and formula-safe; and a refund after a manual payout
 * asks the admin to recover the amount (or to cancel a payout only prepared).
 * tools/scripts/security-verify.sql section 40 proves the behaviour on a local replay; these pin the
 * SQL that carries each rule.
 */
describe.skipIf(!sql || !manualPayouts)(`${MANUAL_PAYOUTS_FILE} rules`, () => {
  /** A function's body from RETURNS on, with the lines that mention `needle` removed. */
  const bodyWithout = (fn: string, needle: string) =>
    fn
      .slice(fn.indexOf('RETURNS'))
      .split('\n')
      .filter((line) => !line.includes(needle))
      .join('\n');

  it("claims only the gateways in p_gateways, on each of the claim's four commission statements, and is otherwise 02030's", () => {
    const claim = functionSql('public.claim_affiliate_payout');
    expect(functionSqlIn(manualPayouts, 'public.claim_affiliate_payout')).toBe(claim);
    expect(claim).toContain('p_trigger text, p_gateways public.affiliate_gateway[] DEFAULT NULL)');
    const filter = 'AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways))';
    const cleared = statementsWith(claim, "c.status = 'CLEARED'::public.affiliate_commission_status");
    expect(cleared).toHaveLength(4);
    for (const statement of cleared) expect(statement).toContain(filter);
    // Nothing else changed: 02030's body (security, search_path, key mode, dispute, minimum, insert).
    const withoutFilter = (fn: string) =>
      fn.slice(fn.indexOf('RETURNS')).replace(/\n[ \t]*AND \(p_gateways IS NULL OR c\.gateway = ANY \(p_gateways\)\)/g, '');
    expect(withoutFilter(claim)).toBe(withoutFilter(functionSqlIn(sql, 'public.claim_affiliate_payout')));
    // The four-argument function is dropped before the new one exists (one overload: no PGRST203).
    const drop = manualPayouts.indexOf('DROP FUNCTION IF EXISTS public.claim_affiliate_payout(uuid, text, bigint, text);');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(manualPayouts.indexOf('CREATE OR REPLACE FUNCTION public.claim_affiliate_payout('));
    for (const statement of [
      'REVOKE ALL ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[]) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[]) TO service_role;',
    ]) {
      expect(manualPayouts).toContain(statement);
    }
  });

  /** The `'status', '…'` answers a jsonb-returning function can give. */
  const answersOf = (fn: string) => new Set([...fn.matchAll(/'status', '([a-z_]+)'/g)].map((match) => match[1]));

  it('prepares a manual payout BEFORE any money is sent: live-mode commissions under the claim lock order, one per partner and currency', () => {
    const claim = functionSqlIn(manualPayouts, 'public.claim_manual_affiliate_payout');
    expect(claim).toContain(
      '(\n    p_affiliate_id uuid, p_currency text, p_min_amount bigint DEFAULT 0, p_gateways public.affiliate_gateway[] DEFAULT NULL)'
    );
    for (const line of ['RETURNS jsonb', 'LANGUAGE plpgsql SECURITY INVOKER', "SET search_path TO ''"]) expect(claim, line).toContain(line);
    // the answers the TypeScript wrapper maps (payouts/rpc.ts), and no other
    expect(answersOf(claim)).toEqual(new Set(AFFILIATE_MANUAL_PAYOUT_CLAIM_STATUSES));
    // the claim's commission rules on every statement, live mode only (a test-mode sale is never paid with real money)
    const cleared = statementsWith(claim, "c.status = 'CLEARED'::public.affiliate_commission_status");
    expect(cleared).toHaveLength(4);
    for (const statement of cleared) {
      for (const rule of [
        'c.payout_id IS NULL',
        'c.currency = v_currency',
        'c.livemode = true',
        'c.disputed_at IS NULL',
        '(p_gateways IS NULL OR c.gateway = ANY (p_gateways))',
      ]) {
        expect(statement, rule).toContain(rule);
      }
    }
    // lock order: the profile, then its commissions; refunded and cancelled orders are voided as the claim does
    const profileLock = claim.search(/FROM public\.affiliate_profiles p\s+WHERE p\.id = p_affiliate_id\s+FOR UPDATE;/);
    const commissionLock = claim.search(/PERFORM 1 FROM public\.affiliate_commissions c[\s\S]*?FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(commissionLock).toBeGreaterThan(profileLock);
    expect(claim).toContain("AND o.status IN ('refunded', 'cancelled')");
    expect(claim.indexOf('PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);')).toBeGreaterThan(commissionLock);
    // paused or never approved partners are not paid; one prepared payout per partner and currency, read under the profile lock
    expect(claim).toContain("IF v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL THEN");
    expect(claim.indexOf("AND po.status = 'PROCESSING'::public.affiliate_payout_status")).toBeGreaterThan(profileLock);
    expect(claim.indexOf("'already_prepared'")).toBeLessThan(commissionLock);
    expect(claim).toContain('IF v_amount < GREATEST(coalesce(p_min_amount, 0), 0) THEN');
    // a PROCESSING manual payout with no Stripe field, its commissions attached and still CLEARED (nothing PAID yet)
    expect(claim).toMatch(/NULL, true, 'PROCESSING'::public\.affiliate_payout_status, 1, now\(\),\s+'admin', 'manual'/);
    expect(claim).toContain('SET payout_id = v_payout_id');
    expect(claim).not.toMatch(/\bstripe_transfer_id\b|'PAID'|total_paid_cents/);
    for (const statement of [
      'REVOKE ALL ON FUNCTION public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[]) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[]) TO service_role;',
    ]) {
      expect(manualPayouts).toContain(statement);
    }
  });

  it('records exactly a prepared payout once the money left, as complete_affiliate_payout does, with no amount or eligibility check', () => {
    const record = functionSqlIn(manualPayouts, 'public.record_manual_affiliate_payout');
    expect(record).toContain('(\n    p_payout_id uuid, p_channel text, p_reference text, p_note text, p_recorded_by uuid)');
    for (const line of ['RETURNS jsonb', 'LANGUAGE plpgsql SECURITY INVOKER', "SET search_path TO ''"]) expect(record, line).toContain(line);
    expect(answersOf(record)).toEqual(new Set(AFFILIATE_MANUAL_PAYOUT_RECORD_STATUSES));
    // complete_affiliate_payout's lock order: the profile, the payout's commissions, the payout
    const profileLock = record.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/);
    const commissionLock = record.search(/FROM public\.affiliate_commissions c WHERE c\.payout_id = p_payout_id FOR UPDATE;/);
    const payoutLock = record.search(/WHERE po\.id = p_payout_id AND po\.method = 'manual'\s+FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(commissionLock).toBeGreaterThan(profileLock);
    expect(payoutLock).toBeGreaterThan(commissionLock);
    // only a manual payout still PROCESSING; the reference unique per partner (case ignored), checked under the lock
    expect(record).toContain("IF v_payout.status <> 'PROCESSING' THEN");
    expect(record.indexOf('lower(po.external_reference) = lower(v_reference)')).toBeGreaterThan(payoutLock);
    // the amount is the one prepared: no re-sum, no expected amount, no partner status
    expect(record).not.toMatch(/p_expected_amount_cents|sum\(|v_profile|first_published_at/);
    // COMPLETED with the channel, reference, note and recorder; its commissions PAID; total_paid_cents up by its amount
    expect(record).toMatch(
      /SET status = 'COMPLETED'::public\.affiliate_payout_status, paid_at = now\(\), manual_channel = v_channel,\s+external_reference = v_reference, note = v_note, recorded_by = p_recorded_by/
    );
    expect(record).toMatch(/SET status = 'PAID'::public\.affiliate_commission_status, paid_at = now\(\)\s+WHERE c\.payout_id = p_payout_id/);
    expect(record).toContain('UPDATE public.affiliate_profiles SET total_paid_cents = total_paid_cents + v_payout.amount_cents WHERE id = v_affiliate;');
    expect(record).not.toMatch(/\bstripe_transfer_id\b/);
    for (const statement of [
      'REVOKE ALL ON FUNCTION public.record_manual_affiliate_payout(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.record_manual_affiliate_payout(uuid, text, text, text, uuid) TO service_role;',
    ]) {
      expect(manualPayouts).toContain(statement);
    }
    // the first 02036 draft recorded whatever was owed when the admin clicked: no such overload exists
    expect(manualPayouts).not.toContain('p_expected_amount_cents');
  });

  it('cancels a prepared payout by applying its pending refund work, handing the rest back and deleting the row', () => {
    const cancel = functionSqlIn(manualPayouts, 'public.cancel_manual_affiliate_payout');
    expect(cancel).toContain('cancel_manual_affiliate_payout(p_payout_id uuid)');
    for (const line of ['RETURNS jsonb', 'LANGUAGE plpgsql SECURITY INVOKER', "SET search_path TO ''"]) expect(cancel, line).toContain(line);
    expect(answersOf(cancel)).toEqual(new Set(AFFILIATE_MANUAL_PAYOUT_CANCEL_STATUSES));
    const profileLock = cancel.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/);
    const pending = cancel.indexOf('PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);');
    const detach = cancel.indexOf('UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;');
    const remove = cancel.indexOf('DELETE FROM public.affiliate_payouts po WHERE po.id = p_payout_id;');
    expect(profileLock).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(profileLock);
    expect(detach).toBeGreaterThan(pending);
    expect(remove).toBeGreaterThan(detach);
    expect(cancel).toContain("IF v_status <> 'PROCESSING' THEN");
    expect(manualPayouts).toContain('REVOKE ALL ON FUNCTION public.cancel_manual_affiliate_payout(uuid) FROM PUBLIC, anon, authenticated;');
    expect(manualPayouts).toContain('GRANT EXECUTE ON FUNCTION public.cancel_manual_affiliate_payout(uuid) TO service_role;');
  });

  it('constrains payout rows with the methods, channels and lengths the lib uses, and keeps the Stripe RPCs off manual payouts', () => {
    // 02036 added the method CHECK; a later file (02037: 'paypal') replaces it by name. The latest
    // definition is the one the lib's list must match.
    const methods = latestMatch(/affiliate_payouts_method_check CHECK \(method IN \(([^)]*)\)\)/);
    expect(methods ? quotedList(methods[1] as string) : null).toEqual([...AFFILIATE_PAYOUT_METHODS]);
    expect(manualPayouts).toContain("affiliate_payouts_method_check CHECK (method IN ('stripe_connect', 'manual'))");
    const channels = manualPayouts.match(/manual_channel IS NULL OR manual_channel IN \(([^)]*)\)/);
    expect(channels ? quotedList(channels[1] as string) : null).toEqual([...AFFILIATE_MANUAL_PAYOUT_CHANNELS]);
    for (const rule of [
      "CHECK (method <> 'stripe_connect' OR stripe_destination_account IS NOT NULL)",
      // prepared or recorded, never FAILED: fail_affiliate_payout() and release_affiliate_payout() cannot apply
      "OR status IN ('PROCESSING'::public.affiliate_payout_status, 'COMPLETED'::public.affiliate_payout_status));",
      // no Stripe field: complete_affiliate_payout() and prepare_affiliate_payout_retry() cannot apply
      "method <> 'manual' OR (stripe_destination_account IS NULL AND stripe_transfer_id IS NULL)",
      "OR (manual_channel IS NOT NULL AND external_reference IS NOT NULL AND paid_at IS NOT NULL)",
      `CHECK (external_reference IS NULL OR char_length(external_reference) <= ${AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH})`,
      `CHECK (note IS NULL OR char_length(note) <= ${AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH})`,
      'FOREIGN KEY (recorded_by) REFERENCES auth.users (id) ON DELETE SET NULL',
      'ALTER TABLE public.affiliate_payouts ALTER COLUMN stripe_destination_account DROP NOT NULL;',
      `char_length(payout_email) <= ${AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH}`,
      // a spreadsheet reads a leading = + - @ as a formula; the PayPal file never rewrites the recipient
      "AND payout_email !~ '^[=+@-]'",
    ]) {
      expect(manualPayouts, rule).toContain(rule);
    }
    expect(manualPayouts).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_manual_reference_key\s+ON public\.affiliate_payouts \(affiliate_id, lower\(external_reference\)\)\s+WHERE method = 'manual' AND external_reference IS NOT NULL;/
    );
    expect(manualPayouts).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_manual_prepared_key\s+ON public\.affiliate_payouts \(affiliate_id, currency\)\s+WHERE method = 'manual' AND status = 'PROCESSING'::public\.affiliate_payout_status;/
    );
    // the Stripe RPCs write exactly what those constraints refuse on a manual row
    expect(functionSql('public.complete_affiliate_payout')).toContain('stripe_transfer_id = v_transfer');
    expect(functionSql('public.prepare_affiliate_payout_retry')).toContain('stripe_destination_account = v_profile.stripe_connect_account_id');
    expect(functionSql('public.fail_affiliate_payout')).toContain("SET status = 'FAILED'::public.affiliate_payout_status");
    // the new columns ride the table grants: this file grants no table privilege
    expect(manualPayouts).not.toMatch(/GRANT [A-Z, ]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]* ON (?:TABLE )?public\./);
  });

  it("keeps payout_email from a partner session (the profile guard), with every column of 02035's guard", () => {
    const atRateFile = functionSqlIn(rateAtPayment, 'private.affiliate_profile_guard');
    // 02036's own definition (a later file, 02037, adds payout_email_kind to it)
    const guard = functionSqlIn(manualPayouts, 'private.affiliate_profile_guard');
    const before = protectedColumns(atRateFile);
    const after = protectedColumns(guard);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.filter((column) => !before.includes(column))).toEqual(['payout_email']);
    // the rest of the guard is 02035's
    expect(bodyWithout(guard, 'payout_email')).toBe(bodyWithout(atRateFile, 'payout_email'));
    // the guard that runs keeps every column of this one
    expect(protectedColumns(functionSql('private.affiliate_profile_guard'))).toEqual(expect.arrayContaining(after));
    expect(manualPayouts).toContain('REVOKE ALL ON FUNCTION private.affiliate_profile_guard() FROM PUBLIC, anon, authenticated;');
  });

  it("asks the admin to recover a refund after a manual payout (or to cancel one only prepared), in the CMS copy's words, and keeps the Stripe advice otherwise", () => {
    const alert = functionSql('private.affiliate_alert_refund_after_payout');
    // 02036 defined it; 02037 adds the PayPal branches and keeps every rule checked here
    expect(functionSqlIn(manualPayouts, 'private.affiliate_alert_refund_after_payout')).not.toBe('');
    for (const line of [
      'LANGUAGE plpgsql SECURITY DEFINER',
      "SET search_path TO ''",
      'SELECT po.method, po.status::text INTO v_method, v_status',
      "'payout_status', v_status",
    ]) {
      expect(alert, line).toContain(line);
    }
    const preparedAdvice =
      'Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.';
    const manualAdvice = 'Recover the amount from the partner, for example by asking them to send it back.';
    const stripeAdvice = 'Reverse the transfer in Stripe if needed.';
    expect(alert).toContain(`WHEN v_manual AND v_status = 'PROCESSING' THEN '${preparedAdvice}'`);
    expect(alert).toContain(`WHEN v_manual THEN '${manualAdvice}'`);
    expect(alert).toContain(`ELSE '${stripeAdvice}'`);
    // nothing in the ledger deducts a refund from a later payout: no advice says so
    expect(alert).not.toContain('deduct');
    expect(alert).toContain("format('Order %s was refunded after its commission was paid or queued. %s'");
    // the email and alert copy say what the database's own alert says
    expect(AFFILIATE_ADMIN_EMAIL_COPY['alert.refund_after_payout.message_order_manual_prepared']).toBe(
      `Order {order} was refunded after its commission was paid or queued. ${preparedAdvice}`
    );
    expect(AFFILIATE_ADMIN_EMAIL_COPY['alert.refund_after_payout.message_order_manual']).toBe(
      `Order {order} was refunded after its commission was paid or queued. ${manualAdvice}`
    );
    expect(AFFILIATE_ADMIN_EMAIL_COPY['alert.refund_after_payout.message_order']).toBe(
      `Order {order} was refunded after its commission was paid or queued. ${stripeAdvice}`
    );
    for (const value of Object.values(AFFILIATE_ADMIN_EMAIL_COPY)) expect(value).not.toMatch(/deduct/i);
    expect(manualPayouts).toContain(
      'REVOKE ALL ON FUNCTION private.affiliate_alert_refund_after_payout(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;'
    );
  });
});

/**
 * 02037: commissions paid from the operator's PayPal balance. A PayPal payout is claimed under the
 * claim's locks BEFORE PayPal is asked to send anything, from commissions of the PayPal gateways and
 * of the PayPal environment's mode only, to the partner's PayPal payout email; PayPal's answer then
 * completes it exactly once or fails it and hands its commissions back. The partner's payout email
 * kind is server-written, and the CMS-saved PayPal credentials are service-role only.
 * tools/scripts/security-verify.sql section 41 proves the behaviour on a local replay; these pin the
 * SQL that carries each rule.
 */
describe.skipIf(!sql || !paypalPayouts)(`${PAYPAL_PAYOUTS_FILE} rules`, () => {
  /** The `'status', '…'` answers a jsonb-returning function can give. */
  const answersOf = (fn: string) => new Set([...fn.matchAll(/'status', '([a-z_]+)'/g)].map((match) => match[1]));
  const securityLines = ['RETURNS jsonb', 'LANGUAGE plpgsql SECURITY INVOKER', "SET search_path TO ''"];

  it('claims a PayPal payout under the claim lock order, from the PayPal gateways and the environment mode only, to a PayPal email', () => {
    const claim = functionSqlIn(paypalPayouts, 'public.claim_paypal_affiliate_payout');
    expect(claim).toContain(
      "(\n    p_affiliate_id uuid, p_currency text, p_min_amount bigint, p_gateways public.affiliate_gateway[], p_livemode boolean,\n    p_trigger text DEFAULT 'cron')"
    );
    for (const line of securityLines) expect(claim, line).toContain(line);
    // the answers the TypeScript wrapper maps (payouts/rpc.ts), and no other
    expect(answersOf(claim)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_CLAIM_STATUSES));
    // the claim's commission rules on every statement: the gateways given (required) and the mode given
    const cleared = statementsWith(claim, "c.status = 'CLEARED'::public.affiliate_commission_status");
    expect(cleared).toHaveLength(4);
    for (const statement of cleared) {
      for (const rule of ['c.payout_id IS NULL', 'c.currency = v_currency', 'c.livemode = p_livemode', 'c.disputed_at IS NULL', 'c.gateway = ANY (p_gateways)']) {
        expect(statement, rule).toContain(rule);
      }
    }
    expect(claim).toContain('p_gateways IS NULL OR cardinality(p_gateways) = 0');
    // lock order: the profile, then its commissions; refunded and cancelled orders voided as the claim does
    const profileLock = claim.search(/FROM public\.affiliate_profiles p\s+WHERE p\.id = p_affiliate_id\s+FOR UPDATE;/);
    const commissionLock = claim.search(/PERFORM 1 FROM public\.affiliate_commissions c[\s\S]*?FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(commissionLock).toBeGreaterThan(profileLock);
    expect(claim.indexOf('PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);')).toBeGreaterThan(commissionLock);
    // paused or never approved partners are not paid; a PayPal email (kind paypal, PayPal's receiver limit)
    expect(claim).toContain("IF v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL THEN");
    expect(claim).toContain("v_profile.payout_email_kind IS DISTINCT FROM 'paypal'");
    expect(claim).toContain(`char_length(v_receiver) > ${AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH}`);
    // one in flight per partner, currency and mode, read under the profile lock, before the commission lock
    expect(claim.indexOf("'already_in_flight'")).toBeGreaterThan(profileLock);
    expect(claim.indexOf("'already_in_flight'")).toBeLessThan(commissionLock);
    expect(claim).toContain('AND po.livemode = p_livemode');
    expect(claim).toContain('IF v_amount < GREATEST(coalesce(p_min_amount, 0), 0) THEN');
    // a PROCESSING PayPal payout with no Stripe field and the receiver snapshot; nothing PAID yet
    expect(claim).toMatch(/NULL, p_livemode, 'PROCESSING'::public\.affiliate_payout_status, 1, now\(\),\s+v_trigger, 'paypal', v_receiver/);
    expect(claim).not.toMatch(/\bstripe_transfer_id\b|'PAID'|total_paid_cents/);
  });

  it('saves batch ids without overwriting, notes items, completes exactly once and fails by handing the commissions back', () => {
    const batch = functionSqlIn(paypalPayouts, 'public.record_paypal_affiliate_payout_batch');
    const note = functionSqlIn(paypalPayouts, 'public.note_paypal_affiliate_payout_item');
    const complete = functionSqlIn(paypalPayouts, 'public.complete_paypal_affiliate_payout');
    const fail = functionSqlIn(paypalPayouts, 'public.fail_paypal_affiliate_payout');
    for (const fn of [batch, note, complete, fail]) for (const line of securityLines) expect(fn, line).toContain(line);
    expect(answersOf(batch)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_BATCH_STATUSES));
    expect(answersOf(note)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES));
    expect(answersOf(complete)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_COMPLETE_STATUSES));
    expect(answersOf(fail)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_FAIL_STATUSES));
    // a sender id or a batch id is never replaced by another
    expect(batch).toContain('AND (po.paypal_sender_batch_id IS NULL OR po.paypal_sender_batch_id = v_sender)');
    expect(batch).toContain('AND (v_batch IS NULL OR po.paypal_batch_id IS NULL OR po.paypal_batch_id = v_batch)');
    expect(note).toContain('AND (v_item IS NULL OR po.paypal_item_id IS NULL OR po.paypal_item_id = v_item)');
    // complete_affiliate_payout's lock order, PROCESSING only, then COMPLETED / PAID / total_paid_cents
    const profileLock = complete.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/);
    const commissionLock = complete.search(/FROM public\.affiliate_commissions c WHERE c\.payout_id = p_payout_id FOR UPDATE;/);
    const payoutLock = complete.search(/WHERE po\.id = p_payout_id AND po\.method = 'paypal'\s+FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(commissionLock).toBeGreaterThan(profileLock);
    expect(payoutLock).toBeGreaterThan(commissionLock);
    expect(complete).toContain("IF v_payout.status <> 'PROCESSING' THEN");
    expect(complete).toMatch(/SET status = 'PAID'::public\.affiliate_commission_status, paid_at = now\(\)\s+WHERE c\.payout_id = p_payout_id/);
    expect(complete).toContain('UPDATE public.affiliate_profiles SET total_paid_cents = total_paid_cents + v_payout.amount_cents WHERE id = v_affiliate;');
    expect(complete).not.toMatch(/\bstripe_transfer_id\b/);
    // the failure applies the pending refund work (A8), then hands every commission left back
    const pending = fail.indexOf('PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);');
    const handBack = fail.indexOf('UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;');
    expect(fail.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/)).toBeLessThan(pending);
    expect(pending).toBeGreaterThan(-1);
    expect(handBack).toBeGreaterThan(pending);
    expect(fail).toContain("SET status = 'FAILED'::public.affiliate_payout_status, failure_reason = v_reason");
    expect(fail).not.toMatch(/'PAID'|total_paid_cents/);
    for (const signature of [
      'public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text)',
      'public.record_paypal_affiliate_payout_batch(uuid[], text, text)',
      'public.note_paypal_affiliate_payout_item(uuid, text, text, bigint)',
      'public.complete_paypal_affiliate_payout(uuid, text, text, bigint, text)',
      'public.fail_paypal_affiliate_payout(uuid, text, text)',
    ]) {
      expect(paypalPayouts).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(paypalPayouts).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
  });

  it('constrains PayPal payout rows, adds the payout email kind to the profile guard and keeps the credentials row service-role only', () => {
    const methods = paypalPayouts.match(/affiliate_payouts_method_check CHECK \(method IN \(([^)]*)\)\)/);
    expect(methods ? quotedList(methods[1] as string) : null).toEqual([...AFFILIATE_PAYOUT_METHODS]);
    expect(paypalPayouts.indexOf('DROP CONSTRAINT IF EXISTS affiliate_payouts_method_check')).toBeLessThan(
      paypalPayouts.indexOf('ADD CONSTRAINT affiliate_payouts_method_check')
    );
    const kinds = paypalPayouts.match(/payout_email_kind IN \(([^)]*)\)/);
    expect(kinds ? quotedList(kinds[1] as string) : null).toEqual([...AFFILIATE_PAYOUT_EMAIL_KINDS]);
    expect(paypalPayouts).toContain("ADD COLUMN IF NOT EXISTS payout_email_kind text NOT NULL DEFAULT 'paypal'");
    for (const rule of [
      // no Stripe or manual field on a PayPal payout: complete_affiliate_payout() and prepare_affiliate_payout_retry() cannot apply
      'OR (paypal_receiver IS NOT NULL AND stripe_destination_account IS NULL AND stripe_transfer_id IS NULL',
      'OR (paypal_item_id IS NOT NULL AND paypal_transaction_id IS NOT NULL AND paid_at IS NOT NULL)',
      `char_length(paypal_receiver) <= ${AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH}`,
      "paypal_batch_id ~ '^[A-Za-z0-9_-]{1,128}$'",
    ]) {
      expect(paypalPayouts, rule).toContain(rule);
    }
    expect(paypalPayouts).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_paypal_in_flight_key\s+ON public\.affiliate_payouts \(affiliate_id, currency, livemode\)\s+WHERE method = 'paypal' AND status = 'PROCESSING'::public\.affiliate_payout_status;/
    );
    // the guard: 02036's columns plus payout_email_kind and payout_email_saved_at, and nothing else changed
    const before = functionSqlIn(manualPayouts, 'private.affiliate_profile_guard');
    const guard = functionSql('private.affiliate_profile_guard');
    expect(functionSqlIn(paypalPayouts, 'private.affiliate_profile_guard')).toBe(guard);
    expect(protectedColumns(guard).filter((column) => !protectedColumns(before).includes(column))).toEqual([
      'payout_email_kind',
      'payout_email_saved_at',
    ]);
    expect(
      guard
        .split('\n')
        .filter((line) => !line.includes('payout_email_kind') && !line.includes('payout_email_saved_at'))
        .join('\n')
    ).toBe(before);
    expect(paypalPayouts).toContain('ADD COLUMN IF NOT EXISTS payout_email_saved_at timestamptz NULL');
    expect(paypalPayouts).toContain('REVOKE ALL ON FUNCTION private.affiliate_profile_guard() FROM PUBLIC, anon, authenticated;');
    // the CMS-saved credentials: a RESTRICTIVE policy keeps every API role away from the key
    expect(paypalPayouts).toContain(
      `AS RESTRICTIVE\n  FOR ALL TO anon, authenticated\n  USING (key <> '${AFFILIATE_PAYPAL_SETTINGS_KEY}')\n  WITH CHECK (key <> '${AFFILIATE_PAYPAL_SETTINGS_KEY}');`
    );
    // the new columns ride the table grants: this file grants no table privilege
    expect(paypalPayouts).not.toMatch(/GRANT [A-Z, ]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]* ON (?:TABLE )?public\./);
  });

  it("gives a refund after a PayPal payout the PayPal advice, in the admin copy's words", () => {
    const alert = functionSql('private.affiliate_alert_refund_after_payout');
    expect(functionSqlIn(paypalPayouts, 'private.affiliate_alert_refund_after_payout')).toBe(alert);
    const inFlight =
      'Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.';
    const recovery = 'Recover the amount from the partner, for example by asking them to send it back.';
    expect(alert).toContain(`WHEN v_paypal AND v_status = 'PROCESSING' THEN '${inFlight}'`);
    expect(alert).toContain(`WHEN v_paypal THEN '${recovery}'`);
    expect(alert).toContain("'payout_method', CASE WHEN v_manual THEN 'manual' WHEN v_paypal THEN 'paypal' ELSE 'stripe_connect' END");
    expect(AFFILIATE_ADMIN_EMAIL_COPY['alert.refund_after_payout.message_order_paypal_in_flight']).toBe(
      `Order {order} was refunded after its commission was paid or queued. ${inFlight}`
    );
    expect(AFFILIATE_ADMIN_EMAIL_COPY['refund_after_payout.body_order_paypal_in_flight']).toBe(
      `Order {order} was refunded after its commission was paid or queued. ${inFlight}`
    );
    expect(paypalPayouts).toContain(
      'REVOKE ALL ON FUNCTION private.affiliate_alert_refund_after_payout(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;'
    );
  });

  it("lets a PayPal payout fail (02036's manual status CHECK scoped to manual payouts) only with a paypal_ reason, so the Stripe RPCs raise on it", () => {
    // the CHECK that runs is the latest definition: manual payouts only (a PayPal payout must be able to fail)
    const manualStatus = latestMatch(/ADD CONSTRAINT affiliate_payouts_manual_status_check CHECK \(\s*method ([^\n]+)\n\s*OR status IN/);
    expect(manualStatus?.[1]?.trim()).toBe("<> 'manual'");
    expect(paypalPayouts.indexOf('DROP CONSTRAINT IF EXISTS affiliate_payouts_manual_status_check')).toBeGreaterThan(-1);
    expect(paypalPayouts.indexOf('DROP CONSTRAINT IF EXISTS affiliate_payouts_manual_status_check')).toBeLessThan(
      paypalPayouts.indexOf('ADD CONSTRAINT affiliate_payouts_manual_status_check')
    );
    // a FAILED PayPal payout carries a paypal_ reason: the Stripe RPCs write 'released', 'nothing_to_pay', a Stripe code
    expect(paypalPayouts).toContain(
      "method <> 'paypal' OR status <> 'FAILED'::public.affiliate_payout_status\n        OR coalesce(failure_reason, '') ~ '^paypal_');"
    );
    expect(functionSql('public.release_affiliate_payout')).toContain("SET failure_reason = 'released'");
    expect(functionSql('public.prepare_affiliate_payout_retry')).toContain("CASE WHEN v_amount <= 0 THEN 'nothing_to_pay' ELSE 'below_minimum' END");
    // the PayPal RPCs always write a paypal_ reason
    const fail = functionSqlIn(paypalPayouts, 'public.fail_paypal_affiliate_payout');
    expect(fail).toContain("IF v_reason !~ '^paypal_' THEN");
    expect(fail).toContain("v_reason := left('paypal_failed:' || v_reason, 500);");
    expect(functionSqlIn(paypalPayouts, 'public.release_paypal_affiliate_payout')).toContain("failure_reason = 'paypal_released_by_admin'");
    // the receiver failures of the app's rule are paypal_ reasons
    expect(isAffiliatePayPalReceiverFailureReason('paypal_returned')).toBe(true);
    expect(isAffiliatePayPalReceiverFailureReason('paypal_released_by_admin')).toBe(false);
  });

  it('stamps every send of a batch, and releases a payout only when PayPal cannot be paying it, under the payout lock', () => {
    const batch = functionSqlIn(paypalPayouts, 'public.record_paypal_affiliate_payout_batch');
    expect(batch).toContain('last_attempt_at = CASE WHEN v_batch IS NULL THEN now() ELSE po.last_attempt_at END');
    expect(batch).toContain(
      'attempt_count = CASE WHEN v_batch IS NULL AND po.paypal_sender_batch_id = v_sender THEN po.attempt_count + 1 ELSE po.attempt_count END'
    );
    const release = functionSqlIn(paypalPayouts, 'public.release_paypal_affiliate_payout');
    for (const line of securityLines) expect(release, line).toContain(line);
    expect(answersOf(release)).toEqual(new Set(AFFILIATE_PAYPAL_PAYOUT_RELEASE_STATUSES));
    // the claim's lock order, then the rule read under the payout lock
    const profileLock = release.search(/FROM public\.affiliate_profiles p WHERE p\.id = v_affiliate FOR UPDATE;/);
    const commissionLock = release.search(/FROM public\.affiliate_commissions c WHERE c\.payout_id = p_payout_id FOR UPDATE;/);
    const payoutLock = release.search(/WHERE po\.id = p_payout_id AND po\.method = 'paypal'\s+FOR UPDATE;/);
    expect(profileLock).toBeGreaterThan(-1);
    expect(commissionLock).toBeGreaterThan(profileLock);
    expect(payoutLock).toBeGreaterThan(commissionLock);
    expect(release.indexOf("'held_by_paypal'")).toBeGreaterThan(payoutLock);
    expect(release.indexOf("'too_recent'")).toBeGreaterThan(payoutLock);
    // the windows are the lib's constants
    const hours = `${AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS} ${AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS === 1 ? 'hour' : 'hours'}`;
    expect(release).toContain(`v_payout.paypal_batch_id IS NULL AND v_payout.last_attempt_at > now() - interval '${hours}'`);
    expect(release).toContain(
      `v_payout.paypal_batch_id IS NOT NULL AND v_payout.last_attempt_at > now() - interval '${AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS} days'`
    );
    expect(release).toContain("coalesce(v_payout.paypal_item_status, '') IN ('SUCCESS', 'PENDING', 'ONHOLD', 'UNCLAIMED')");
    // then fail_paypal_affiliate_payout's work: the refund work, the hand-back, FAILED
    const pending = release.indexOf('PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);');
    const handBack = release.indexOf('UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;');
    expect(pending).toBeGreaterThan(release.indexOf("'too_recent'"));
    expect(handBack).toBeGreaterThan(pending);
    expect(release).not.toMatch(/'PAID'|total_paid_cents/);
    expect(paypalPayouts).toContain('REVOKE ALL ON FUNCTION public.release_paypal_affiliate_payout(uuid) FROM PUBLIC, anon, authenticated;');
    expect(paypalPayouts).toContain('GRANT EXECUTE ON FUNCTION public.release_paypal_affiliate_payout(uuid) TO service_role;');
  });
});
