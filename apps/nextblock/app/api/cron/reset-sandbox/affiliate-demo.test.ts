import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// review.ts builds the approval snapshot and its fingerprint; its side-effect modules are not needed.
vi.mock('../../../../lib/affiliates/cache', () => ({
  evictAffiliateStorefrontCache: vi.fn(),
  evictAffiliateTiersCache: vi.fn(),
}));
vi.mock('../../../../lib/affiliates/notify', () => ({ scheduleAffiliateLifecycleNotification: vi.fn() }));
vi.mock('../../../../lib/affiliates/image-origins', () => ({ getStorefrontImageOrigins: () => [] }));
vi.mock('../../../../lib/affiliates/uploads', () => ({ deleteAffiliateUploadObject: vi.fn() }));
// The server entry without the copilot, payouts and Connect code: the repository, the alert
// templates and the payout retry rules.
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/repository/index.ts')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/notifications/index.ts')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../libs/affiliates/src/lib/payouts/payout-config.ts')),
}));

import {
  AFFILIATE_BANNER_ALERT_TYPES,
  AFFILIATE_HANDLE_PATTERN,
  collectStorefrontProductIds,
  computeAffiliateCommissionMinor,
  convertAffiliateAmountToBaseMinor,
  diffStorefrontBlocks,
  isReservedAffiliateHandle,
  sanitizeAffiliateSocialLinks,
  sanitizeStorefrontDoc,
  type AffiliatePublishedProfile,
  type StorefrontDoc,
} from '@nextblock-cms/affiliates';
import {
  AFFILIATE_PAYOUT_AUTO_RETRY_DELAY_MS,
  AFFILIATE_PAYOUT_MAX_ATTEMPTS,
  buildAffiliateSystemAlert,
  isAffiliatePayoutTransientFailureReason,
} from '@nextblock-cms/affiliates/server';
import { buildAffiliatePublishedProfile, fingerprintAffiliatePublishedProfile } from '../../../../lib/affiliates/review';
import { usableEmail } from '../../../../lib/email/placeholder-address';
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import {
  SANDBOX_AFFILIATE_DEMO_AVATAR_KEY,
  SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
  SANDBOX_AFFILIATE_DEMO_COPY,
  SANDBOX_AFFILIATE_DEMO_DESTINATION,
  SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
  SANDBOX_AFFILIATE_DEMO_EMAIL,
  SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID,
  SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES,
  SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION,
  SANDBOX_AFFILIATE_DEMO_FAILURE_REASON,
  SANDBOX_AFFILIATE_DEMO_FR_COPY,
  SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
  SANDBOX_AFFILIATE_DEMO_FR_DRAFT_PRODUCT_SKUS,
  SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION,
  SANDBOX_AFFILIATE_DEMO_FR_EMAIL,
  SANDBOX_AFFILIATE_DEMO_FR_HANDLE,
  SANDBOX_AFFILIATE_DEMO_FR_TIER_SLUG,
  SANDBOX_AFFILIATE_DEMO_FR_TOTAL_CLICKS,
  SANDBOX_AFFILIATE_DEMO_HANDLE,
  SANDBOX_AFFILIATE_DEMO_LIVEMODE,
  SANDBOX_AFFILIATE_DEMO_PASSWORD,
  SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID,
  SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES,
  SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS,
  SANDBOX_AFFILIATE_DEMO_TOTAL_CLICKS,
  SANDBOX_AFFILIATE_DEMO_TRANSFER_ID,
  buildSandboxAffiliateDemoDoc,
  buildSandboxAffiliateDemoFrAlerts,
  buildSandboxAffiliateDemoFrDoc,
  buildSandboxAffiliateDemoFrPublishedProfile,
  buildSandboxAffiliateDemoOrderLines,
  buildSandboxAffiliateDemoPayoutFailedAlert,
  buildSandboxAffiliateDemoPublishedProfile,
  planSandboxAffiliateDemoFailedPayout,
  planSandboxAffiliateDemoLedger,
  seedSandboxAffiliateDemo,
  type SandboxAffiliateDemoAuthAdmin,
  type SandboxAffiliateDemoOrder,
} from './affiliate-demo';

/* ------------------------------------------------------------------------------------------
 * A fake of the postgres.js tagged-template client, holding the rows this step touches. It
 * understands the statement shapes the module writes (INSERT ... ON CONFLICT DO UPDATE SET,
 * UPDATE ... SET ... WHERE, DELETE ... WHERE, a few SELECTs), and it enforces what migration
 * 02030 enforces on them: the CHECK constraints, unique keys and foreign keys, the profile and
 * page guards, the tier member_count trigger and the two orders triggers (it records which
 * branch of affiliate_on_order_change an update would take, and refuses to delete an order whose
 * live commission affiliate_on_order_delete would void). `begin()` rolls back on a throw, and its
 * transaction's `savepoint()` rolls back to the savepoint and rethrows.
 * ---------------------------------------------------------------------------------------- */

type Row = Record<string, any>;

const NOW = new Date('2026-10-27T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Step A's preserved users (tools/scripts/generate-sandbox-reset.ts); the first is the demo admin. */
const DEMO_ADMIN_ID = '63a8aa07-ef6e-4cc7-bafa-ece023c74366';
const OTHER_ADMIN_ID = 'e3a2c121-70a4-4239-a9df-f70ce717f5a1';
const GROWTH_TIER_ID = '7a000000-0000-4000-8000-000000000002';
const FOUNDING_TIER_ID = '7a000000-0000-4000-8000-000000000004';

const PRODUCTS = {
  teeEn: '5a000000-0000-4000-8000-000000000001',
  capEn: '5a000000-0000-4000-8000-000000000002',
  pantsEn: '5a000000-0000-4000-8000-000000000003',
  teeFr: '5a000000-0000-4000-8000-000000000011',
  capFr: '5a000000-0000-4000-8000-000000000012',
  pantsFr: '5a000000-0000-4000-8000-000000000013',
  commerceEn: '5a000000-0000-4000-8000-000000000021',
} as const;

/** The apparel prices of route.ts APPAREL_PRODUCT_SEEDS. */
const APPAREL_PRICES: Record<string, number> = { 'NB-STUDIO-TEE': 3200, 'NB-SIGNAL-CAP': 2600, 'NB-UTILITY-PANTS': 6800 };

const ALERT_TYPES = [
  'merge_conflict',
  'runtime_update_available',
  'affiliate_signed_up',
  'affiliate_profile_completed',
  'affiliate_payout_configured',
  'affiliate_page_submitted',
  'affiliate_payout_failed',
  'affiliate_refund_after_payout',
];

const JSON_TAG = '__fakeJson';

/** The branch of affiliate_on_order_change an orders UPDATE takes (02030). */
type OrderTriggerBranch = 'record' | 'void' | 'none';

interface FakeState {
  schemaReady: boolean;
  roleReady: boolean;
  authUsers: Row[];
  profiles: Row[];
  affiliate_tiers: Row[];
  currencies: Row[];
  languages: Row[];
  products: Row[];
  product_variants: Row[];
  orders: Row[];
  order_items: Row[];
  affiliate_profiles: Row[];
  affiliate_pages: Row[];
  affiliate_payouts: Row[];
  affiliate_commissions: Row[];
  system_alerts: Row[];
  /** order_invoice_number_seq. */
  invoiceSequence: number;
  /** Every firing of affiliate_on_order_change (an UPDATE that changed paid_at or status). */
  orderTriggerFirings: Array<{ orderId: string; branch: OrderTriggerBranch }>;
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function check(condition: unknown, constraint: string): void {
  if (!condition) throw pgError(`new row violates check constraint "${constraint}"`, '23514');
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function freshId(prefix: string, counter: { value: number }): string {
  counter.value += 1;
  return `${prefix}-0000-4000-8000-${counter.value.toString(16).padStart(12, '0')}`;
}

/** Top-level comma split (ignores commas inside parentheses and quotes). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The text between the parenthesis that opens at `start` and its match. */
function parenthesized(text: string, start: number): { inner: string; end: number } {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, index), end: index };
    }
  }
  throw new Error(`fake db: unbalanced parentheses in ${text}`);
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && JSON_TAG in (value as Row)) {
    return structuredClone((value as Row)[JSON_TAG]);
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return [...value];
  return value;
}

interface Scope {
  params: unknown[];
  /** The row being updated (bare column references read the old values). */
  old?: Row;
  /** ON CONFLICT ... EXCLUDED. */
  excluded?: Row;
  /** For the sequences. */
  state?: FakeState;
}

function evaluate(expression: string, scope: Scope): unknown {
  const expr = expression.trim();
  const param = /^\$(\d+)(?:::[\w[\]]+)?$/.exec(expr);
  if (param) return unwrap(scope.params[Number(param[1]) - 1]);
  if (expr === 'NULL') return null;
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'now()') return new Date(NOW.getTime());
  if (expr === 'public.generate_order_invoice_number()' && scope.state) {
    scope.state.invoiceSequence += 1;
    return `INV-${String(scope.state.invoiceSequence).padStart(6, '0')}`;
  }
  if (/^-?\d+$/.test(expr)) return Number(expr);
  const literal = /^'([^']*)'$/.exec(expr);
  if (literal) return literal[1];
  const excluded = /^EXCLUDED\.(\w+)$/.exec(expr);
  if (excluded && scope.excluded) return structuredClone(scope.excluded[excluded[1]]);
  if (/^\w+$/.test(expr) && scope.old && expr in scope.old) return structuredClone(scope.old[expr]);
  throw new Error(`fake db: unsupported expression ${expr}`);
}

function matchesWhere(row: Row, where: string, params: unknown[]): boolean {
  return where.split(' AND ').every((condition) => {
    const isNull = /^(\w+) IS NULL$/.exec(condition);
    if (isNull) return row[isNull[1]] === null || row[isNull[1]] === undefined;
    const isNotNull = /^(\w+) IS NOT NULL$/.exec(condition);
    if (isNotNull) return row[isNotNull[1]] !== null && row[isNotNull[1]] !== undefined;
    const any = /^(\w+) = ANY\((.+)\)$/.exec(condition);
    if (any) return (evaluate(any[2], { params }) as unknown[]).some((value) => same(row[any[1]], value));
    const jsonField = /^(\w+) ->> '(\w+)' = (.+)$/.exec(condition);
    if (jsonField) {
      const value = (row[jsonField[1]] as Row | null)?.[jsonField[2]];
      return typeof value === 'string' && value === evaluate(jsonField[3], { params });
    }
    const equals = /^(\w+) = (.+)$/.exec(condition);
    if (equals) return same(row[equals[1]], evaluate(equals[2], { params }));
    throw new Error(`fake db: unsupported condition ${condition}`);
  });
}

function returning(row: Row, clause: string | undefined): Row | null {
  if (!clause) return null;
  const out: Row = {};
  for (const item of splitTopLevel(clause)) {
    const match = /^(\w+)(?:::text)?(?: AS (\w+))?$/.exec(item);
    if (!match) throw new Error(`fake db: unsupported RETURNING ${item}`);
    out[match[2] ?? match[1]] = structuredClone(row[match[1]]);
  }
  return out;
}

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const AVATAR_RE = /^(affiliates\/avatars\/|images\/)[A-Za-z0-9._/-]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ROLES = ['ADMIN', 'WRITER', 'USER'];
const AFFILIATE_STATUSES = ['ACTIVE', 'SUSPENDED'];
const PAGE_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'CHANGES_REQUESTED'];
const COMMISSION_STATUSES = ['PENDING_CLEARANCE', 'CLEARED', 'PAID', 'VOIDED_REFUND'];
const PAYOUT_STATUSES = ['PROCESSING', 'COMPLETED', 'FAILED'];
const ORDER_STATUSES = ['pending', 'trial', 'paid', 'shipped', 'cancelled', 'refunded'];
/** The failure reasons after which a FAILED payout is closed (no Retry or Release; payouts/page.tsx). */
const CLOSED_FAILURE_REASONS = ['released', 'nothing_to_pay', 'below_minimum'];

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function defaults(table: string, state: FakeState, ids: { value: number }): Row {
  const now = new Date(NOW.getTime());
  switch (table) {
    case 'profiles':
      return { updated_at: null, full_name: null, avatar_url: null, website: null, phone: null, role: 'USER' };
    case 'affiliate_profiles':
      return {
        id: freshId('af000000', ids),
        bio: null,
        avatar_object_key: null,
        social_links: {},
        preferred_locale: 'en',
        onboarding_step: 'SIGNED_UP',
        status: 'ACTIVE',
        suspended_reason: null,
        stripe_connect_account_id: null,
        stripe_connect_livemode: null,
        stripe_connect_onboarding_complete: false,
        stripe_connect_details_submitted: false,
        stripe_connect_payouts_enabled: false,
        stripe_connect_checked_at: null,
        total_clicks: 0,
        last_click_at: null,
        total_earned_cents: 0,
        total_paid_cents: 0,
        profile_completed_at: null,
        payout_configured_at: null,
        page_submitted_at: null,
        first_published_at: null,
        signup_ip_masked: null,
        created_at: now,
        updated_at: now,
      };
    case 'affiliate_pages':
      return {
        id: freshId('a9000000', ids),
        title: '',
        meta_description: '',
        draft_content: { type: 'doc', content: [] },
        featured_product_ids: [],
        published_content: null,
        published_title: null,
        published_meta_description: null,
        published_profile: null,
        published_featured_product_ids: [],
        approval_status: 'DRAFT',
        admin_feedback_note: null,
        draft_version: 1,
        draft_updated_at: now,
        submitted_at: null,
        submitted_version: null,
        reviewed_at: null,
        reviewed_by: null,
        published_at: null,
        created_at: now,
        updated_at: now,
      };
    case 'affiliate_payouts':
      return {
        id: freshId('ad000000', ids),
        livemode: true,
        stripe_transfer_id: null,
        status: 'PROCESSING',
        attempt_count: 1,
        last_attempt_at: now,
        failure_reason: null,
        trigger: 'cron',
        paid_at: null,
        created_at: now,
        updated_at: now,
      };
    case 'orders':
      return {
        id: freshId('0e000000', ids),
        user_id: null,
        status: 'pending',
        total: 0,
        subtotal: null,
        shipping_total: null,
        tax_total: 0,
        discount_total: 0,
        currency: 'USD',
        exchange_rate_at_purchase: '1.0000000000',
        invoice_number: null,
        paid_at: null,
        created_at: now,
        customer_details: null,
        provider: 'stripe',
        inventory_deducted_at: null,
        affiliate_id: null,
        affiliate_source: null,
        affiliate_base_currency: null,
        affiliate_livemode: null,
      };
    case 'order_items':
      return { id: freshId('01000000', ids), product_id: null, variant_id: null };
    case 'system_alerts':
      return {
        id: freshId('5a1e0000', ids),
        metadata: {},
        is_resolved: false,
        resolved_at: null,
        created_at: now,
        updated_at: now,
      };
    case 'affiliate_commissions':
      return {
        id: freshId('ac000000', ids),
        order_id: null,
        exchange_rate_snapshot: 1,
        refunded_amount_cents: 0,
        refund_pending_cents: 0,
        void_requested_at: null,
        currency: 'USD',
        livemode: true,
        status: 'PENDING_CLEARANCE',
        clears_at: new Date(NOW.getTime() + 30 * DAY),
        cleared_at: null,
        paid_at: null,
        voided_at: null,
        void_reason: null,
        payout_id: null,
        stripe_transfer_id: null,
        notified_at: null,
        created_at: now,
        updated_at: now,
      };
    default:
      void state;
      throw new Error(`fake db: no INSERT support for ${table}`);
  }
}

/** BEFORE triggers of 02030 (sessions without auth.uid(), like this connection). */
function beforeWrite(table: string, row: Row, old: Row | null): void {
  if (table === 'affiliate_profiles') {
    row['handle'] = String(row['handle']).toLowerCase();
    row['onboarding_step'] = row['first_published_at']
      ? 'ACTIVE_PUBLISHED'
      : row['page_submitted_at']
        ? 'PAGE_SUBMITTED'
        : row['payout_configured_at']
          ? 'PAYOUT_CONFIGURED'
          : row['profile_completed_at']
            ? 'PROFILE_COMPLETED'
            : 'SIGNED_UP';
  }
  if (table === 'affiliate_pages' && old) {
    const draftChanged = ['title', 'meta_description', 'draft_content', 'featured_product_ids'].some(
      (column) => !same(row[column], old[column]),
    );
    if (draftChanged) {
      if (old['approval_status'] === 'PENDING_REVIEW') throw pgError('affiliate_page_pending_review', '55000');
      row['draft_version'] = Number(old['draft_version']) + 1;
      row['draft_updated_at'] = new Date(NOW.getTime());
      if (
        (old['approval_status'] === 'PUBLISHED' || old['approval_status'] === 'CHANGES_REQUESTED') &&
        row['approval_status'] === old['approval_status']
      ) {
        row['approval_status'] = 'DRAFT';
      }
    }
  }
  if (old && 'updated_at' in row && table !== 'profiles') row['updated_at'] = new Date(NOW.getTime());
}

function others(rows: Row[], row: Row): Row[] {
  return rows.filter((candidate) => candidate !== row && candidate['id'] !== row['id']);
}

/** CHECK, UNIQUE and FOREIGN KEY constraints of the touched tables. */
function constraints(table: string, row: Row, state: FakeState): void {
  switch (table) {
    case 'profiles': {
      const roles = state.roleReady ? [...ROLES, 'RTL'] : ROLES;
      if (!roles.includes(String(row['role']))) {
        throw pgError(`invalid input value for enum user_role: "${row['role']}"`, '22P02');
      }
      if (!state.authUsers.some((user) => user['id'] === row['id'])) throw pgError('profiles_id_fkey', '23503');
      return;
    }
    case 'affiliate_profiles': {
      check(HANDLE_RE.test(String(row['handle'])), 'affiliate_profiles_handle_check');
      const name = String(row['display_name'] ?? '').trim();
      check(name.length >= 1 && name.length <= 80, 'affiliate_profiles_display_name_check');
      check(row['bio'] === null || String(row['bio']).length <= 2000, 'affiliate_profiles_bio_check');
      const avatar = row['avatar_object_key'];
      check(
        avatar === null ||
          (String(avatar).length <= 512 && AVATAR_RE.test(String(avatar)) && !/(\.\.|\/\/)/.test(String(avatar))),
        'affiliate_profiles_avatar_object_key_check',
      );
      const links = row['social_links'];
      check(links && typeof links === 'object' && !Array.isArray(links) && byteLength(links) <= 4000, 'affiliate_profiles_social_links_check');
      check(/^[a-z]{2}$/.test(String(row['preferred_locale'])), 'affiliate_profiles_preferred_locale_check');
      check(AFFILIATE_STATUSES.includes(String(row['status'])), 'affiliate_status');
      check(
        row['stripe_connect_account_id'] === null || /^acct_[A-Za-z0-9]+$/.test(String(row['stripe_connect_account_id'])),
        'affiliate_profiles_stripe_connect_account_id_check',
      );
      if (others(state.affiliate_profiles, row).some((other) => other['user_id'] === row['user_id'])) {
        throw pgError('affiliate_profiles_user_id_key', '23505');
      }
      if (others(state.affiliate_profiles, row).some((other) => other['handle'] === row['handle'])) {
        throw pgError('affiliate_profiles_handle_key', '23505');
      }
      if (!state.authUsers.some((user) => user['id'] === row['user_id'])) throw pgError('affiliate_profiles_user_id_fkey', '23503');
      if (!state.affiliate_tiers.some((tier) => tier['id'] === row['tier_id'])) throw pgError('affiliate_profiles_tier_id_fkey', '23503');
      return;
    }
    case 'affiliate_pages': {
      check(String(row['title']).length <= 120, 'affiliate_pages_title_check');
      check(String(row['meta_description']).length <= 300, 'affiliate_pages_meta_description_check');
      const draft = row['draft_content'];
      check(draft && typeof draft === 'object' && !Array.isArray(draft) && byteLength(draft) <= 262144, 'affiliate_pages_draft_content_check');
      check(Array.isArray(row['featured_product_ids']) && row['featured_product_ids'].length <= 24, 'affiliate_pages_featured_product_ids_check');
      const published = row['published_content'];
      check(
        published === null || (typeof published === 'object' && !Array.isArray(published) && byteLength(published) <= 262144),
        'affiliate_pages_published_content_check',
      );
      check(row['published_title'] === null || String(row['published_title']).length <= 120, 'affiliate_pages_published_title_check');
      check(
        row['published_meta_description'] === null || String(row['published_meta_description']).length <= 300,
        'affiliate_pages_published_meta_description_check',
      );
      check(
        row['published_profile'] === null || (typeof row['published_profile'] === 'object' && !Array.isArray(row['published_profile'])),
        'affiliate_pages_published_profile_check',
      );
      check(
        Array.isArray(row['published_featured_product_ids']) && row['published_featured_product_ids'].length <= 24,
        'affiliate_pages_published_featured_product_ids_check',
      );
      check(PAGE_STATUSES.includes(String(row['approval_status'])), 'affiliate_page_status');
      if (others(state.affiliate_pages, row).some((other) => other['affiliate_id'] === row['affiliate_id'])) {
        throw pgError('affiliate_pages_affiliate_id_key', '23505');
      }
      if (others(state.affiliate_pages, row).some((other) => other['user_id'] === row['user_id'])) {
        throw pgError('affiliate_pages_user_id_key', '23505');
      }
      if (!state.affiliate_profiles.some((profile) => profile['id'] === row['affiliate_id'] && profile['user_id'] === row['user_id'])) {
        throw pgError('affiliate_pages_affiliate_owner_fkey', '23503');
      }
      if (row['reviewed_by'] !== null && !state.authUsers.some((user) => user['id'] === row['reviewed_by'])) {
        throw pgError('affiliate_pages_reviewed_by_fkey', '23503');
      }
      return;
    }
    case 'affiliate_payouts': {
      check(Number(row['amount_cents']) > 0, 'affiliate_payouts_amount_cents_check');
      check(CURRENCY_RE.test(String(row['currency'])), 'affiliate_payouts_currency_check');
      check(Number(row['attempt_count']) >= 1, 'affiliate_payouts_attempt_count_check');
      check(['cron', 'admin', 'auto'].includes(String(row['trigger'])), 'affiliate_payouts_trigger_check');
      check(PAYOUT_STATUSES.includes(String(row['status'])), 'affiliate_payout_status');
      check(typeof row['stripe_destination_account'] === 'string', 'affiliate_payouts_stripe_destination_account_not_null');
      check(typeof row['livemode'] === 'boolean', 'affiliate_payouts_livemode_not_null');
      check(
        row['failure_reason'] === null || String(row['failure_reason']).length <= 500,
        'affiliate_payouts_failure_reason_check',
      );
      if (
        row['stripe_transfer_id'] !== null &&
        others(state.affiliate_payouts, row).some((other) => other['stripe_transfer_id'] === row['stripe_transfer_id'])
      ) {
        throw pgError('affiliate_payouts_stripe_transfer_id_key', '23505');
      }
      if (!state.affiliate_profiles.some((profile) => profile['id'] === row['affiliate_id'])) {
        throw pgError('affiliate_payouts_affiliate_id_fkey', '23503');
      }
      return;
    }
    case 'affiliate_commissions': {
      check(CURRENCY_RE.test(String(row['order_currency'])), 'affiliate_commissions_order_currency_check');
      check(CURRENCY_RE.test(String(row['currency'])), 'affiliate_commissions_currency_check');
      check(Number(row['order_net_amount_minor']) >= 0, 'affiliate_commissions_order_net_amount_minor_check');
      check(Number(row['exchange_rate_snapshot']) > 0, 'affiliate_commissions_exchange_rate_snapshot_check');
      check(Number(row['net_order_amount_cents']) >= 0, 'affiliate_commissions_net_order_amount_cents_check');
      const rate = Number(row['commission_rate_snapshot']);
      check(rate >= 0 && rate <= 100, 'affiliate_commissions_commission_rate_snapshot_check');
      const amount = Number(row['commission_amount_cents']);
      check(amount >= 0, 'affiliate_commissions_commission_amount_cents_check');
      const refunded = Number(row['refunded_amount_cents']);
      check(refunded >= 0 && refunded <= amount, 'affiliate_commissions_refunded_amount_cents_check');
      const pending = Number(row['refund_pending_cents']);
      check(pending >= 0 && pending <= amount, 'affiliate_commissions_refund_pending_cents_check');
      check(['STRIPE', 'FREEMIUS'].includes(String(row['gateway'])), 'affiliate_gateway');
      check(COMMISSION_STATUSES.includes(String(row['status'])), 'affiliate_commission_status');
      check(typeof row['livemode'] === 'boolean', 'affiliate_commissions_livemode_not_null');
      if (
        row['order_id'] !== null &&
        others(state.affiliate_commissions, row).some(
          (other) => other['order_id'] === row['order_id'] && other['gateway'] === row['gateway'],
        )
      ) {
        throw pgError('affiliate_commissions_order_gateway_key', '23505');
      }
      if (!state.affiliate_profiles.some((profile) => profile['id'] === row['affiliate_id'])) {
        throw pgError('affiliate_commissions_affiliate_id_fkey', '23503');
      }
      if (row['order_id'] !== null && !state.orders.some((order) => order['id'] === row['order_id'])) {
        throw pgError('affiliate_commissions_order_id_fkey', '23503');
      }
      if (row['payout_id'] !== null && !state.affiliate_payouts.some((payout) => payout['id'] === row['payout_id'])) {
        throw pgError('affiliate_commissions_payout_id_fkey', '23503');
      }
      return;
    }
    case 'orders': {
      check(ORDER_STATUSES.includes(String(row['status'])), 'orders_status_check');
      check(['stripe', 'freemius'].includes(String(row['provider'])), 'orders_provider_check');
      check(Number.isInteger(row['total']), 'orders_total_not_null');
      check(Number(row['discount_total']) >= 0, 'orders_discount_total_check');
      check(Number(row['exchange_rate_at_purchase']) > 0, 'orders_exchange_rate_at_purchase_positive');
      check(
        row['affiliate_source'] === null || ['storefront', 'referral_link'].includes(String(row['affiliate_source'])),
        'orders_affiliate_source_check',
      );
      check(
        row['affiliate_base_currency'] === null || CURRENCY_RE.test(String(row['affiliate_base_currency'])),
        'orders_affiliate_base_currency_check',
      );
      check(row['affiliate_livemode'] == null || typeof row['affiliate_livemode'] === 'boolean', 'orders_affiliate_livemode_type');
      if (
        row['invoice_number'] != null &&
        others(state.orders, row).some((other) => other['invoice_number'] === row['invoice_number'])
      ) {
        throw pgError('idx_orders_invoice_number_unique', '23505');
      }
      if (row['affiliate_id'] !== null && !state.affiliate_profiles.some((profile) => profile['id'] === row['affiliate_id'])) {
        throw pgError('orders_affiliate_id_fkey', '23503');
      }
      if (row['user_id'] !== null && !state.authUsers.some((user) => user['id'] === row['user_id'])) {
        throw pgError('orders_user_id_fkey', '23503');
      }
      return;
    }
    case 'order_items': {
      check(Number.isInteger(row['quantity']), 'order_items_quantity_not_null');
      check(Number.isInteger(row['price_at_purchase']), 'order_items_price_at_purchase_not_null');
      if (!state.orders.some((order) => order['id'] === row['order_id'])) throw pgError('order_items_order_id_fkey', '23503');
      if (row['product_id'] !== null && !state.products.some((product) => product['id'] === row['product_id'])) {
        throw pgError('order_items_product_id_fkey', '23503');
      }
      if (row['variant_id'] !== null && !state.product_variants.some((variant) => variant['id'] === row['variant_id'])) {
        throw pgError('order_items_variant_id_fkey', '23503');
      }
      return;
    }
    case 'system_alerts': {
      check(ALERT_TYPES.includes(String(row['alert_type'])), 'system_alerts_alert_type_check');
      check(typeof row['title'] === 'string' && typeof row['message'] === 'string', 'system_alerts_text_not_null');
      check(row['metadata'] && typeof row['metadata'] === 'object' && !Array.isArray(row['metadata']), 'system_alerts_metadata_not_null');
      return;
    }
    default:
      throw new Error(`fake db: no constraints for ${table}`);
  }
}

/**
 * affiliate_on_order_change (AFTER UPDATE OF paid_at, status WHEN either changed): `record` when
 * paid_at goes from NULL to a value on an attributed order, `void` when the status becomes
 * refunded or cancelled, otherwise it runs and does nothing. An INSERT never fires it.
 */
function orderTriggerBranch(row: Row, old: Row): OrderTriggerBranch | null {
  const paidChanged = !same(old['paid_at'] ?? null, row['paid_at'] ?? null);
  const statusChanged = old['status'] !== row['status'];
  if (!paidChanged && !statusChanged) return null;
  if (old['paid_at'] == null && row['paid_at'] != null && row['affiliate_id'] != null) return 'record';
  if (statusChanged && ['refunded', 'cancelled'].includes(String(row['status']))) return 'void';
  return 'none';
}

/** AFTER triggers: the tier member_count (insert / tier change) and the orders trigger. */
function afterWrite(table: string, row: Row, old: Row | null, state: FakeState): void {
  if (table === 'orders') {
    const branch = old ? orderTriggerBranch(row, old) : null;
    if (branch) state.orderTriggerFirings.push({ orderId: String(row['id']), branch });
    return;
  }
  if (table !== 'affiliate_profiles') return;
  const bump = (tierId: unknown, delta: number) => {
    const tier = state.affiliate_tiers.find((candidate) => candidate['id'] === tierId);
    if (tier) tier['member_count'] = Math.max(Number(tier['member_count']) + delta, 0);
  };
  if (!old) bump(row['tier_id'], 1);
  else if (old['tier_id'] !== row['tier_id']) {
    bump(old['tier_id'], -1);
    bump(row['tier_id'], 1);
  }
}

function tableRows(state: FakeState, table: string): Row[] {
  const rows = (state as unknown as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) throw new Error(`fake db: unknown table ${table}`);
  return rows as Row[];
}

function runInsert(text: string, params: unknown[], state: FakeState, ids: { value: number }): Row[] {
  const head = /^INSERT INTO public\.(\w+) \(/.exec(text);
  if (!head) throw new Error(`fake db: bad INSERT ${text}`);
  const table = head[1];
  const columns = parenthesized(text, head[0].length - 1);
  const valuesAt = text.indexOf('VALUES (', columns.end);
  const values = parenthesized(text, valuesAt + 'VALUES '.length);
  const rest = text.slice(values.end + 1).trim();
  const conflict = /^ON CONFLICT \((\w+)\) DO UPDATE SET (.*?)(?: RETURNING (.*))?$/.exec(rest);
  const returningOnly = /^RETURNING (.*)$/.exec(rest);
  if (rest && !conflict && !returningOnly) throw new Error(`fake db: unsupported INSERT tail ${rest}`);

  const columnNames = splitTopLevel(columns.inner);
  const valueExpressions = splitTopLevel(values.inner);
  if (columnNames.length !== valueExpressions.length) throw new Error(`fake db: column/value count mismatch in ${text}`);

  const proposed: Row = { ...defaults(table, state, ids) };
  columnNames.forEach((column, index) => {
    proposed[column] = evaluate(valueExpressions[index] as string, { params, state });
  });

  const rows = tableRows(state, table);
  const key = conflict?.[1];
  const existing = key ? rows.find((row) => row[key] === proposed[key]) : undefined;

  let written: Row;
  if (existing && conflict) {
    const old = structuredClone(existing);
    const next: Row = { ...existing };
    for (const assignment of splitTopLevel(conflict[2] as string)) {
      const match = /^(\w+) = (.+)$/.exec(assignment);
      if (!match) throw new Error(`fake db: bad SET ${assignment}`);
      next[match[1] as string] = evaluate(match[2] as string, { params, old, excluded: proposed });
    }
    beforeWrite(table, next, old);
    constraints(table, next, state);
    Object.assign(existing, next);
    afterWrite(table, existing, old, state);
    written = existing;
  } else {
    // The primary key (the seed's own orders come with fixed ids).
    if (proposed['id'] !== undefined && rows.some((row) => row['id'] === proposed['id'])) throw pgError(`${table}_pkey`, '23505');
    beforeWrite(table, proposed, null);
    rows.push(proposed);
    try {
      constraints(table, proposed, state);
    } catch (error) {
      rows.pop();
      throw error;
    }
    afterWrite(table, proposed, null, state);
    written = proposed;
  }
  const out = returning(written, conflict?.[3] ?? returningOnly?.[1]);
  return out ? [out] : [];
}

function runUpdate(text: string, params: unknown[], state: FakeState): Row[] {
  const match = /^UPDATE public\.(\w+) SET (.*?) WHERE (.*?)(?: RETURNING (.*))?$/.exec(text);
  if (!match) throw new Error(`fake db: bad UPDATE ${text}`);
  const [, table, setClause, where, returningClause] = match as unknown as [string, string, string, string, string | undefined];
  const out: Row[] = [];
  for (const row of tableRows(state, table)) {
    if (!matchesWhere(row, where, params)) continue;
    const old = structuredClone(row);
    const next: Row = { ...row };
    for (const assignment of splitTopLevel(setClause)) {
      const set = /^(\w+) = (.+)$/.exec(assignment);
      if (!set) throw new Error(`fake db: bad SET ${assignment}`);
      next[set[1] as string] = evaluate(set[2] as string, { params, old, state });
    }
    beforeWrite(table, next, old);
    constraints(table, next, state);
    Object.assign(row, next);
    afterWrite(table, row, old, state);
    const returned = returning(row, returningClause);
    if (returned) out.push(returned);
  }
  return out;
}

function runDelete(text: string, params: unknown[], state: FakeState): Row[] {
  const match = /^DELETE FROM public\.(\w+) WHERE (.*)$/.exec(text);
  if (!match) throw new Error(`fake db: bad DELETE ${text}`);
  const [, table, where] = match as unknown as [string, string, string];
  const rows = tableRows(state, table);
  const removed = rows.filter((row) => matchesWhere(row, where, params));
  if (table === 'orders') {
    // affiliate_on_order_delete (BEFORE DELETE) would void the order's live commissions: the seed
    // must have replaced the ledger first, so there is never one to void.
    const live = state.affiliate_commissions.filter(
      (commission) => commission['status'] !== 'VOIDED_REFUND' && removed.some((order) => order['id'] === commission['order_id']),
    );
    if (live.length > 0) throw new Error('fake db: deleting an order whose live commission the delete trigger would void');
  }
  const kept = rows.filter((row) => !removed.includes(row));
  rows.splice(0, rows.length, ...kept);
  if (table === 'affiliate_payouts') {
    // affiliate_commissions_payout_id_fkey ... ON DELETE SET NULL
    for (const commission of state.affiliate_commissions) {
      if (removed.some((payout) => payout['id'] === commission['payout_id'])) commission['payout_id'] = null;
    }
  }
  if (table === 'orders') {
    // order_items_order_id_fkey ... ON DELETE CASCADE; affiliate_commissions_order_id_fkey ... ON DELETE SET NULL
    state.order_items = state.order_items.filter((item) => !removed.some((order) => order['id'] === item['order_id']));
    for (const commission of state.affiliate_commissions) {
      if (removed.some((order) => order['id'] === commission['order_id'])) commission['order_id'] = null;
    }
  }
  return [];
}

type SelectHandler = { pattern: RegExp; run: (params: unknown[], state: FakeState) => Row[] };

const SELECTS: SelectHandler[] = [
  {
    pattern: /^SELECT to_regclass\('public\.affiliate_profiles'\) IS NOT NULL AND .* AS schema_ready, EXISTS \(.*enumlabel = 'RTL'\) AS role_ready, EXISTS \(SELECT 1 FROM public\.profiles WHERE role = 'ADMIN'\) AS admin_exists$/,
    run: (_params, state) => [
      {
        schema_ready: state.schemaReady,
        role_ready: state.roleReady,
        admin_exists: state.profiles.some((profile) => profile['role'] === 'ADMIN'),
      },
    ],
  },
  {
    pattern: /^SELECT id::text AS id, lower\(email::text\) AS email FROM auth\.users WHERE lower\(email::text\) = ANY\(\$1::text\[\]\)$/,
    run: ([emails], state) =>
      state.authUsers
        .filter((user) => (emails as string[]).includes(String(user['email']).toLowerCase()))
        .map((user) => ({ id: user['id'], email: String(user['email']).toLowerCase() })),
  },
  {
    pattern: /^SELECT id::text AS id, commission_percentage::text AS commission_percentage FROM public\.affiliate_tiers WHERE slug = \$1 LIMIT 1$/,
    run: ([slug], state) =>
      state.affiliate_tiers
        .filter((tier) => tier['slug'] === slug)
        .slice(0, 1)
        .map((tier) => ({ id: tier['id'], commission_percentage: tier['commission_percentage'] })),
  },
  {
    // The second partner's tier, with the seat rule create_affiliate_account() applies (without its
    // row lock: the reset runs alone), plus the seat it already holds on a re-run.
    pattern: /^SELECT t\.id::text AS id, t\.name, \(t\.is_active AND \(t\.max_ambassadors_cap IS NULL OR t\.member_count < t\.max_ambassadors_cap OR EXISTS \(SELECT 1 FROM public\.affiliate_profiles p WHERE p\.tier_id = t\.id AND p\.user_id = \$1\)\)\) AS has_room FROM public\.affiliate_tiers t WHERE t\.slug = \$2 LIMIT 1$/,
    run: ([userId, slug], state) =>
      state.affiliate_tiers
        .filter((tier) => tier['slug'] === slug)
        .slice(0, 1)
        .map((tier) => ({
          id: tier['id'],
          name: tier['name'],
          has_room:
            tier['is_active'] === true &&
            (tier['max_ambassadors_cap'] === null ||
              Number(tier['member_count']) < Number(tier['max_ambassadors_cap']) ||
              state.affiliate_profiles.some((profile) => profile['tier_id'] === tier['id'] && profile['user_id'] === userId)),
        })),
  },
  {
    pattern: /^SELECT v\.id::text AS variant_id, v\.sku, v\.price AS variant_price, p\.id::text AS product_id, p\.price AS product_price FROM public\.product_variants v JOIN public\.products p ON p\.id = v\.product_id JOIN public\.languages l ON l\.id = p\.language_id WHERE l\.is_default AND p\.status = 'active' AND v\.sku = ANY\(\$1::text\[\]\) ORDER BY v\.sku, v\.id$/,
    run: ([skus], state) =>
      state.product_variants
        .flatMap((variant) => {
          const product = state.products.find((candidate) => candidate['id'] === variant['product_id']);
          const isDefault = state.languages.some((language) => language['id'] === product?.['language_id'] && language['is_default']);
          if (!product || product['status'] !== 'active' || !isDefault || !(skus as string[]).includes(String(variant['sku']))) return [];
          return [{ variant_id: variant['id'], sku: variant['sku'], variant_price: variant['price'], product_id: product['id'], product_price: product['price'] }];
        })
        .sort((a, b) => String(a.sku).localeCompare(String(b.sku)) || String(a.variant_id).localeCompare(String(b.variant_id))),
  },
  {
    pattern: /^SELECT upper\(code\) AS code FROM public\.currencies WHERE is_default ORDER BY updated_at DESC, created_at DESC, code LIMIT 1$/,
    run: (_params, state) =>
      state.currencies
        .filter((currency) => currency['is_default'])
        .slice(0, 1)
        .map((currency) => ({ code: String(currency['code']).toUpperCase() })),
  },
  {
    pattern: /^SELECT p\.id::text AS id, p\.sku FROM public\.products p JOIN public\.languages l ON l\.id = p\.language_id WHERE l\.is_default AND p\.status = 'active' AND p\.sku = ANY\(\$1::text\[\]\)$/,
    run: ([skus], state) =>
      state.products
        .filter(
          (product) =>
            product['status'] === 'active' &&
            (skus as string[]).includes(String(product['sku'])) &&
            state.languages.some((language) => language['id'] === product['language_id'] && language['is_default']),
        )
        .map((product) => ({ id: product['id'], sku: product['sku'] })),
  },
  {
    pattern: /^SELECT o\.id::text AS id, o\.total, o\.subtotal, o\.discount_total, o\.currency, o\.exchange_rate_at_purchase::text AS exchange_rate_at_purchase, o\.provider, o\.customer_details ->> 'email' AS buyer_email FROM public\.orders o WHERE o\.user_id = \$1 AND o\.status IN \('paid', 'shipped'\) AND o\.paid_at IS NOT NULL AND o\.affiliate_id IS NULL AND NOT EXISTS \(SELECT 1 FROM public\.affiliate_commissions c WHERE c\.order_id = o\.id\) ORDER BY o\.paid_at ASC, o\.id ASC LIMIT \$2 FOR UPDATE OF o$/,
    run: ([buyerId, limit], state) =>
      state.orders
        .filter(
          (order) =>
            order['user_id'] === buyerId &&
            ['paid', 'shipped'].includes(String(order['status'])) &&
            order['paid_at'] !== null &&
            order['affiliate_id'] === null &&
            !state.affiliate_commissions.some((commission) => commission['order_id'] === order['id']),
        )
        .sort((a, b) => a['paid_at'].getTime() - b['paid_at'].getTime() || String(a['id']).localeCompare(String(b['id'])))
        .slice(0, Number(limit))
        .map((order) => ({
          id: order['id'],
          total: order['total'],
          subtotal: order['subtotal'],
          discount_total: order['discount_total'],
          currency: order['currency'],
          exchange_rate_at_purchase: order['exchange_rate_at_purchase'],
          provider: order['provider'],
          buyer_email: order['customer_details']?.email ?? null,
        })),
  },
];

interface FakeDb {
  sql: any;
  statements: string[];
}

/** Which statement fails: by its text (`$n` placeholders), or by its text and parameters. */
type FailOn = RegExp | ((text: string, params: readonly unknown[]) => boolean);

/** postgres.js TransactionSql, as far as the seed uses it. */
interface FakeTransaction {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Row[]>;
  json(value: unknown): Row;
  savepoint(callback: (savepoint: FakeTransaction) => unknown): Promise<unknown>;
}

function createFakeDb(state: FakeState, options: { failOn?: FailOn; throwOnEverything?: boolean } = {}): FakeDb {
  const statements: string[] = [];
  const ids = { value: 0 };
  const { failOn } = options;

  const run = async (strings: TemplateStringsArray, ...params: unknown[]): Promise<Row[]> => {
    const text = strings
      .reduce((sql, part, index) => `${sql}${index > 0 ? `$${index}` : ''}${part}`, '')
      .replace(/\s+/g, ' ')
      .replace(/\( /g, '(')
      .replace(/ \)/g, ')')
      .trim();
    statements.push(text);
    if (options.throwOnEverything) throw pgError('connection terminated unexpectedly', '08006');
    if (failOn && (typeof failOn === 'function' ? failOn(text, params) : failOn.test(text))) {
      throw pgError('injected failure', 'XX000');
    }
    if (text.startsWith('INSERT INTO ')) return runInsert(text, params, state, ids);
    if (text.startsWith('UPDATE ')) return runUpdate(text, params, state);
    if (text.startsWith('DELETE FROM ')) return runDelete(text, params, state);
    const select = SELECTS.find((handler) => handler.pattern.test(text));
    if (!select) throw new Error(`fake db: unhandled statement: ${text}`);
    return select.run(params, state);
  };

  // The client a transaction hands its callback: the same statements, plus savepoints (a throw
  // rolls back to the savepoint and rethrows; the transaction goes on).
  const transaction: FakeTransaction = Object.assign((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, ...params), {
    json: (value: unknown) => ({ [JSON_TAG]: value }),
    savepoint: async (callback: (savepoint: FakeTransaction) => unknown) => {
      const snapshot = structuredClone(state);
      statements.push('SAVEPOINT');
      try {
        const result = await callback(transaction);
        statements.push('RELEASE SAVEPOINT');
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        statements.push('ROLLBACK TO SAVEPOINT');
        throw error;
      }
    },
  });

  const sql = Object.assign(run, {
    json: (value: unknown) => ({ [JSON_TAG]: value }),
    begin: async (callback: (transaction: unknown) => unknown) => {
      const snapshot = structuredClone(state);
      statements.push('BEGIN');
      try {
        const result = await callback(transaction);
        statements.push('COMMIT');
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        statements.push('ROLLBACK');
        throw error;
      }
    },
  });

  return { sql, statements };
}

interface FakeAuthAdmin {
  client: SandboxAffiliateDemoAuthAdmin;
  createUser: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
}

/** GoTrue's admin API; a created user gets handle_new_user()'s profile (USER while an ADMIN exists). */
function createFakeAuthAdmin(
  state: FakeState,
  options: { createError?: unknown; createErrorFor?: string } = {},
): FakeAuthAdmin {
  let created = 0;
  const createUser = vi.fn(async (attributes: { email: string; password: string; user_metadata: Row }) => {
    if (options.createError && (!options.createErrorFor || options.createErrorFor === attributes.email)) {
      return { data: { user: null }, error: options.createError };
    }
    created += 1;
    const id = `b0000000-0000-4000-8000-${created.toString(16).padStart(12, '0')}`;
    state.authUsers.push({ id, email: attributes.email, password: attributes.password });
    const adminExists = state.profiles.some((profile) => profile['role'] === 'ADMIN');
    state.profiles.push({
      id,
      updated_at: null,
      full_name: attributes.user_metadata['full_name'] ?? null,
      avatar_url: null,
      website: null,
      phone: null,
      role: adminExists ? 'USER' : 'ADMIN',
    });
    return { data: { user: { id } }, error: null };
  });
  const updateUserById = vi.fn(async (id: string, attributes: { password: string }) => {
    const user = state.authUsers.find((candidate) => candidate['id'] === id);
    if (!user) return { data: { user: null }, error: { message: 'User not found' } };
    user['password'] = attributes.password;
    return { data: { user: { id } }, error: null };
  });
  return {
    client: { auth: { admin: { createUser, updateUserById } } } as unknown as SandboxAffiliateDemoAuthAdmin,
    createUser,
    updateUserById,
  };
}

/** The demo store right after a reset: the seeded tiers, catalog and seedFakeStoreData's orders. */
function freshSandbox(): FakeState {
  const tier = (id: string, name: string, slug: string, rate: string, cap: number | null = null) => ({
    id,
    name,
    slug,
    commission_percentage: rate,
    is_active: true,
    max_ambassadors_cap: cap,
    member_count: 0,
  });
  const product = (id: string, sku: string | null, languageId: number) => ({
    id,
    sku,
    language_id: languageId,
    status: 'active',
    price: sku ? (APPAREL_PRICES[sku] ?? 20000) : 20000,
  });
  // route.ts upsertSeededCatalogProduct: an S, M and L variant per product and language, at the product price.
  const apparel: Array<[string, string]> = [
    [PRODUCTS.teeEn, 'NB-STUDIO-TEE'],
    [PRODUCTS.capEn, 'NB-SIGNAL-CAP'],
    [PRODUCTS.pantsEn, 'NB-UTILITY-PANTS'],
    [PRODUCTS.teeFr, 'NB-STUDIO-TEE'],
    [PRODUCTS.capFr, 'NB-SIGNAL-CAP'],
    [PRODUCTS.pantsFr, 'NB-UTILITY-PANTS'],
  ];
  const variants = apparel.flatMap(([productId, sku], productIndex) =>
    ['S', 'M', 'L'].map((size, sizeIndex) => ({
      id: `5b000000-0000-4000-8000-0000000000${productIndex}${sizeIndex}`,
      product_id: productId,
      sku: `${sku}-${size}`,
      price: APPAREL_PRICES[sku],
    })),
  );
  const totals = [3200, 5200, 6800, 6400, 2600];
  return {
    schemaReady: true,
    roleReady: true,
    authUsers: [
      { id: DEMO_ADMIN_ID, email: 'demo@nextblock.dev', password: 'password' },
      { id: OTHER_ADMIN_ID, email: 'owner@nextblock.dev', password: 'secret' },
    ],
    profiles: [
      { id: DEMO_ADMIN_ID, updated_at: null, full_name: 'Nextblock CMS', avatar_url: null, website: 'https://nextblock.dev', phone: null, role: 'ADMIN' },
      { id: OTHER_ADMIN_ID, updated_at: null, full_name: null, avatar_url: null, website: null, phone: null, role: 'ADMIN' },
    ],
    affiliate_tiers: [
      tier('7a000000-0000-4000-8000-000000000001', 'Starter Partner', 'starter-partner', '10.00'),
      tier(GROWTH_TIER_ID, 'Growth Partner', 'growth-partner', '20.00'),
      tier('7a000000-0000-4000-8000-000000000003', 'Elite Partner', 'elite-partner', '35.00'),
      tier(FOUNDING_TIER_ID, 'Founding Ambassador', 'founding-ambassador', '50.00', 50),
    ],
    currencies: [
      { code: 'USD', is_default: true },
      { code: 'CAD', is_default: false },
    ],
    languages: [
      { id: 1, code: 'en', is_default: true },
      { id: 2, code: 'fr', is_default: false },
    ],
    products: [
      product(PRODUCTS.teeEn, 'NB-STUDIO-TEE', 1),
      product(PRODUCTS.capEn, 'NB-SIGNAL-CAP', 1),
      product(PRODUCTS.pantsEn, 'NB-UTILITY-PANTS', 1),
      product(PRODUCTS.teeFr, 'NB-STUDIO-TEE', 2),
      product(PRODUCTS.capFr, 'NB-SIGNAL-CAP', 2),
      product(PRODUCTS.pantsFr, 'NB-UTILITY-PANTS', 2),
      product(PRODUCTS.commerceEn, null, 1),
    ],
    product_variants: variants,
    // seedFakeStoreData(): five paid orders by the demo admin, one every two hours.
    orders: totals.map((total, index) => ({
      id: `0d000000-0000-4000-8000-00000000000${index}`,
      user_id: DEMO_ADMIN_ID,
      status: 'paid',
      total,
      subtotal: total,
      discount_total: 0,
      currency: 'USD',
      exchange_rate_at_purchase: '1.0000000000',
      invoice_number: `INV-2024-${1000 + index}`,
      provider: 'stripe',
      paid_at: new Date(NOW.getTime() - index * 2 * HOUR),
      created_at: new Date(NOW.getTime() - index * 2 * HOUR),
      customer_details: { email: 'demo@nextblock.dev', name: 'Nextblock CMS' },
      affiliate_id: null,
      affiliate_source: null,
      affiliate_base_currency: null,
      affiliate_livemode: null,
    })),
    order_items: [],
    affiliate_profiles: [],
    affiliate_pages: [],
    affiliate_payouts: [],
    affiliate_commissions: [],
    system_alerts: [],
    invoiceSequence: 0,
    orderTriggerFirings: [],
  };
}

async function seed(
  state: FakeState,
  options: { failOn?: FailOn; createError?: unknown; createErrorFor?: string; throwOnEverything?: boolean } = {},
) {
  const db = createFakeDb(state, options);
  const auth = createFakeAuthAdmin(state, { createError: options.createError, createErrorFor: options.createErrorFor });
  const result = await seedSandboxAffiliateDemo(db.sql, auth.client, { siteUrl: 'https://cms.nextblock.dev', now: NOW });
  return { result, db, auth };
}

function partnerUser(state: FakeState): Row | undefined {
  return state.authUsers.find((user) => user['email'] === SANDBOX_AFFILIATE_DEMO_EMAIL);
}

function partnerProfile(state: FakeState): Row {
  const profile = state.affiliate_profiles.find((row) => row['handle'] === SANDBOX_AFFILIATE_DEMO_HANDLE);
  if (!profile) throw new Error('no demo partner profile');
  return profile;
}

function partnerPage(state: FakeState): Row {
  const page = state.affiliate_pages.find((row) => row['affiliate_id'] === partnerProfile(state)['id']);
  if (!page) throw new Error('no demo partner page');
  return page;
}

function frUser(state: FakeState): Row | undefined {
  return state.authUsers.find((user) => user['email'] === SANDBOX_AFFILIATE_DEMO_FR_EMAIL);
}

function frProfile(state: FakeState): Row | undefined {
  return state.affiliate_profiles.find((row) => row['handle'] === SANDBOX_AFFILIATE_DEMO_FR_HANDLE);
}

function frPage(state: FakeState): Row | undefined {
  const profile = frProfile(state);
  return profile ? state.affiliate_pages.find((row) => row['affiliate_id'] === profile['id']) : undefined;
}

function foundingTier(state: FakeState): Row {
  return state.affiliate_tiers.find((tier) => tier['id'] === FOUNDING_TIER_ID) as Row;
}

function growthTier(state: FakeState): Row {
  return state.affiliate_tiers.find((tier) => tier['id'] === GROWTH_TIER_ID) as Row;
}

function orderById(state: FakeState, id: string): Row | undefined {
  return state.orders.find((row) => row['id'] === id);
}

function itemsOf(state: FakeState, orderId: string): Row[] {
  return state.order_items.filter((row) => row['order_id'] === orderId);
}

/** No alert of the second partner's: only Studio Nova's payout-failed alert, naming its FAILED payout. */
function expectOnlyStudioNovaAlerts(state: FakeState) {
  const failed = state.affiliate_payouts.find((row) => row['status'] === 'FAILED') as Row;
  expect(
    state.system_alerts.map((row) => [row['alert_type'], row['metadata']['affiliate_id'], row['metadata']['payout_id']]),
  ).toEqual([['affiliate_payout_failed', partnerProfile(state)['id'], failed['id']]]);
}

/** Every ledger invariant the portal, the CMS and the 02030 functions rely on. */
function expectLedgerConsistent(state: FakeState) {
  const profile = partnerProfile(state);
  const commissions = state.affiliate_commissions.filter((row) => row['affiliate_id'] === profile['id']);
  const payouts = state.affiliate_payouts.filter((row) => row['affiliate_id'] === profile['id']);
  const payoutOf = (commission: Row) => payouts.find((row) => row['id'] === commission['payout_id']);

  const earned = commissions
    .filter((row) => row['status'] !== 'VOIDED_REFUND')
    .reduce((sum, row) => sum + Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents']), 0);
  const paidOut = payouts.filter((row) => row['status'] === 'COMPLETED').reduce((sum, row) => sum + Number(row['amount_cents']), 0);
  expect(Number(profile['total_earned_cents'])).toBe(earned);
  expect(Number(profile['total_paid_cents'])).toBe(paidOut);

  for (const payout of payouts) {
    const attached = commissions.filter((row) => row['payout_id'] === payout['id']);
    // A COMPLETED payout paid its commissions; a FAILED one that is not closed still holds them,
    // CLEARED (claim_affiliate_payout attaches only CLEARED commissions).
    if (payout['status'] === 'COMPLETED') {
      expect(attached.every((row) => row['status'] === 'PAID')).toBe(true);
      expect(payout['stripe_transfer_id']).not.toBeNull();
      expect(payout['paid_at']).not.toBeNull();
    } else {
      expect(payout['status']).toBe('FAILED');
      expect(CLOSED_FAILURE_REASONS).not.toContain(payout['failure_reason']);
      expect(attached.length).toBeGreaterThan(0);
      expect(attached.every((row) => row['status'] === 'CLEARED')).toBe(true);
      expect(payout['stripe_transfer_id']).toBeNull();
      expect(payout['paid_at']).toBeNull();
      expect(attached.every((row) => row['cleared_at'].getTime() <= payout['created_at'].getTime())).toBe(true);
    }
    expect(payout['livemode']).toBe(SANDBOX_AFFILIATE_DEMO_LIVEMODE);
    expect(attached.every((row) => row['livemode'] === payout['livemode'])).toBe(true);
    expect(attached.reduce((sum, row) => sum + Number(row['commission_amount_cents']), 0)).toBe(Number(payout['amount_cents']));
  }

  for (const commission of commissions) {
    const order = state.orders.find((row) => row['id'] === commission['order_id']) as Row;
    expect(order['affiliate_id']).toBe(profile['id']);
    expect(order['affiliate_base_currency']).toBe(commission['currency']);
    expect(order['affiliate_livemode']).toBe(commission['livemode']);
    expect(['paid', 'shipped']).toContain(order['status']);
    // The order was paid when the commission was earned (the trigger records it then).
    expect(order['paid_at']).toEqual(commission['created_at']);
    expect(order['created_at'].getTime()).toBeLessThanOrEqual(order['paid_at'].getTime());
    expect(order['invoice_number']).toEqual(expect.any(String));
    expect(order['user_id']).not.toBe(profile['user_id']);
    expect(Number(commission['commission_amount_cents'])).toBe(
      computeAffiliateCommissionMinor({
        netMinor: Number(commission['net_order_amount_cents']),
        ratePercent: Number(commission['commission_rate_snapshot']),
      }),
    );
    expect(commission['notified_at']).not.toBeNull();
    if (commission['status'] === 'PENDING_CLEARANCE') {
      expect(commission['clears_at'].getTime()).toBeGreaterThan(NOW.getTime());
      expect(commission['cleared_at']).toBeNull();
    } else {
      expect(commission['clears_at'].getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(commission['cleared_at']).not.toBeNull();
    }
    expect(commission['paid_at'] !== null).toBe(commission['status'] === 'PAID');
    // PAID on the COMPLETED payout; CLEARED either unattached or held by the FAILED payout; a
    // PENDING_CLEARANCE commission is never in a payout.
    if (commission['status'] === 'PAID') expect(payoutOf(commission)?.['status']).toBe('COMPLETED');
    else if (commission['status'] === 'CLEARED') {
      expect(commission['payout_id'] === null || payoutOf(commission)?.['status'] === 'FAILED').toBe(true);
    } else expect(commission['payout_id']).toBeNull();
    expect(commission['created_at'].getTime()).toBeLessThan(commission['clears_at'].getTime());
  }

  // No other order is attributed to the partner, except the unpaid one (no commission until it is paid).
  const attributed = state.orders.filter((row) => row['affiliate_id'] === profile['id']);
  const unpaid = attributed.filter((row) => row['paid_at'] === null);
  expect(unpaid.every((row) => row['status'] === 'pending' && row['invoice_number'] === null)).toBe(true);
  expect(attributed.filter((row) => row['paid_at'] !== null).map((row) => row['id']).sort()).toEqual(
    commissions.map((row) => row['order_id']).sort(),
  );
  // Attributed the way checkout records it, all in the ledger's key mode.
  for (const order of attributed) {
    expect(['storefront', 'referral_link']).toContain(order['affiliate_source']);
    expect(order['affiliate_livemode']).toBe(SANDBOX_AFFILIATE_DEMO_LIVEMODE);
    expect(order['affiliate_base_currency']).toBe('USD');
  }
  // Seeding never made the orders trigger record or void anything (the ledger is written directly).
  expect(state.orderTriggerFirings.filter((firing) => firing.branch !== 'none')).toEqual([]);
}

function gridsOf(doc: StorefrontDoc) {
  return doc.content.filter((block) => block.type === 'affiliateProductGrid');
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------------------------ */

describe('demo storefront document and copy', () => {
  it('is already in sanitized form, with and without products', () => {
    for (const ids of [[], [PRODUCTS.teeEn], [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn]]) {
      const doc = buildSandboxAffiliateDemoDoc(ids);
      const result = sanitizeStorefrontDoc(doc, { allowedImageOrigins: [], siteOrigin: 'https://cms.nextblock.dev' });
      expect(result.issues).toEqual([]);
      expect(result.changed).toBe(false);
      expect(result.doc).toEqual(doc);
    }
  });

  it('has a heading, an intro linking to /partners, a tip callout and one product grid', () => {
    const doc = buildSandboxAffiliateDemoDoc([PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn]);
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(doc.content[1]?.type).toBe('paragraph');
    expect(JSON.stringify(doc.content[1])).toContain('"href":"/partners"');
    expect(doc.content.some((block) => block.type === 'storefrontCallout' && block.attrs.tone === 'tip')).toBe(true);
    expect(gridsOf(doc)).toEqual([
      {
        type: 'affiliateProductGrid',
        attrs: { productIds: [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn], title: 'Our studio kit', columns: 3 },
      },
    ]);
    expect(collectStorefrontProductIds(doc)).toEqual([PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn]);
  });

  it('drops the grid and the picks section when there are no products', () => {
    const doc = buildSandboxAffiliateDemoDoc([]);
    expect(gridsOf(doc)).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain('Why we picked them');
    expect(doc.content.length).toBeGreaterThanOrEqual(4);
  });

  it('uses two columns for one or two products and de-duplicates ids', () => {
    const doc = buildSandboxAffiliateDemoDoc([PRODUCTS.capEn, PRODUCTS.capEn]);
    expect(gridsOf(doc)).toEqual([
      { type: 'affiliateProductGrid', attrs: { productIds: [PRODUCTS.capEn], title: 'Our studio kit', columns: 2 } },
    ]);
  });

  it('respects the 02030 CHECKs and the handle rules', () => {
    expect(AFFILIATE_HANDLE_PATTERN.test(SANDBOX_AFFILIATE_DEMO_HANDLE)).toBe(true);
    expect(isReservedAffiliateHandle(SANDBOX_AFFILIATE_DEMO_HANDLE)).toBe(false);
    expect(SANDBOX_AFFILIATE_DEMO_COPY.title.length).toBeLessThanOrEqual(120);
    expect(SANDBOX_AFFILIATE_DEMO_COPY.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(SANDBOX_AFFILIATE_DEMO_COPY.metaDescription.length).toBeLessThanOrEqual(160);
    expect(SANDBOX_AFFILIATE_DEMO_COPY.bio.length).toBeGreaterThanOrEqual(40);
    expect(SANDBOX_AFFILIATE_DEMO_COPY.bio.length).toBeLessThanOrEqual(2000);
    expect(AVATAR_RE.test(SANDBOX_AFFILIATE_DEMO_AVATAR_KEY)).toBe(true);
    expect(SANDBOX_AFFILIATE_DEMO_AVATAR_KEY).not.toMatch(/(\.\.|\/\/)/);
  });

  it('ships the avatar with the app and serves it from /images (the reset wipes the bucket)', () => {
    const file = path.join(REPO_ROOT, 'apps/nextblock/public', SANDBOX_AFFILIATE_DEMO_AVATAR_KEY);
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeLessThan(100 * 1024);
    expect(resolveMediaUrl(SANDBOX_AFFILIATE_DEMO_AVATAR_KEY, 'https://media.example.com')).toBe(
      `/${SANDBOX_AFFILIATE_DEMO_AVATAR_KEY}`,
    );
  });

  it('snapshots the same profile it stores (nothing reads as changed since publication)', () => {
    expect(buildSandboxAffiliateDemoPublishedProfile()).toEqual({
      display_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
      bio: SANDBOX_AFFILIATE_DEMO_COPY.bio,
      avatar_object_key: SANDBOX_AFFILIATE_DEMO_AVATAR_KEY,
      social_links: sanitizeAffiliateSocialLinks({ website: SANDBOX_AFFILIATE_DEMO_COPY.website }),
      // The storefront declares the demo's English copy (its preferred_locale is 'en').
      locale: 'en',
    });
  });
});

/** Every text node of a storefront document (headings, paragraphs, callouts, list items). */
function textsOf(doc: StorefrontDoc): string[] {
  const texts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Row;
    if (record['type'] === 'text' && typeof record['text'] === 'string') texts.push(record['text']);
    if (record['type'] === 'affiliateProductGrid' && typeof record['attrs']?.['title'] === 'string') texts.push(record['attrs']['title']);
    if (Array.isArray(record['content'])) record['content'].forEach(walk);
  };
  walk(doc);
  return texts;
}

/** The copy rules of the public site, for text that is not a dictionary string. */
function expectQuebecFrench(text: string) {
  expect(text).not.toContain('...');
  expect(text).not.toContain('\\');
  // eslint-disable-next-line no-control-regex
  expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  // No colon or percent sign: either would need a no-break space before it in Québec French.
  expect(text).not.toMatch(/[:%]/);
  // Québec usage, like the starter documents: no space before ! or ?.
  expect(text).not.toMatch(/\s[!?]/);
  expect(text.trim().length).toBeGreaterThan(0);
}

describe('second demo partner (Atelier Boréal) documents and copy', () => {
  const ALL = [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn];
  const DRAFT = [PRODUCTS.pantsEn, PRODUCTS.teeEn];

  it('builds both versions in sanitized form, with and without products', () => {
    for (const version of ['published', 'draft'] as const) {
      for (const ids of [[], [PRODUCTS.teeEn], ALL]) {
        const doc = buildSandboxAffiliateDemoFrDoc(version, ids);
        const result = sanitizeStorefrontDoc(doc, { allowedImageOrigins: [], siteOrigin: 'https://cms.nextblock.dev' });
        expect(result.issues).toEqual([]);
        expect(result.changed).toBe(false);
        expect(result.doc).toEqual(doc);
      }
    }
  });

  it('publishes a heading, an intro that discloses the commission and links to /partenaires, and the apparel grid', () => {
    const doc = buildSandboxAffiliateDemoFrDoc('published', ALL);
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(doc.content[1]?.type).toBe('paragraph');
    const intro = JSON.stringify(doc.content[1]);
    expect(intro).toContain('nous recevons une commission, sans frais supplémentaires pour vous');
    expect(intro).toContain('"href":"/partenaires"');
    expect(gridsOf(doc)).toEqual([
      { type: 'affiliateProductGrid', attrs: { productIds: ALL, title: "Notre trousse d'atelier", columns: 3 } },
    ]);
    expect(collectStorefrontProductIds(doc)).toEqual(ALL);
  });

  it('submits a draft the side-by-side review shows as a real change', () => {
    const published = buildSandboxAffiliateDemoFrDoc('published', ALL);
    const draft = buildSandboxAffiliateDemoFrDoc('draft', DRAFT);
    const diff = diffStorefrontBlocks(published, draft);
    // A new heading, the same intro, a changed grid, an added tip and picks section, the same closing line.
    expect(diff).toEqual({ statuses: ['changed', 'unchanged', 'changed', 'added', 'added', 'added', 'unchanged'], removedCount: 0 });
    expect(gridsOf(draft)).toEqual([
      { type: 'affiliateProductGrid', attrs: { productIds: DRAFT, title: "Notre trousse d'automne", columns: 2 } },
    ]);
    // Without products the draft still differs (a new heading and a tip).
    const bare = diffStorefrontBlocks(buildSandboxAffiliateDemoFrDoc('published', []), buildSandboxAffiliateDemoFrDoc('draft', []));
    expect(bare.statuses.filter((status) => status !== 'unchanged').length).toBeGreaterThanOrEqual(2);
    // Each call hands out its own nodes.
    expect(buildSandboxAffiliateDemoFrDoc('draft', DRAFT).content[1]).not.toBe(draft.content[1]);
  });

  it('writes Québec French within the 02030 CHECKs and the SEO limits', () => {
    const copy = SANDBOX_AFFILIATE_DEMO_FR_COPY;
    const texts = [
      ...textsOf(buildSandboxAffiliateDemoFrDoc('published', ALL)),
      ...textsOf(buildSandboxAffiliateDemoFrDoc('draft', DRAFT)),
      copy.publishedBio,
      copy.bio,
      copy.publishedTitle,
      copy.title,
      copy.publishedMetaDescription,
      copy.metaDescription,
    ];
    for (const text of texts.filter((value) => value.trim() !== '.')) expectQuebecFrench(text);
    for (const title of [copy.publishedTitle, copy.title]) expect(title.length).toBeLessThanOrEqual(60);
    for (const meta of [copy.publishedMetaDescription, copy.metaDescription]) {
      expect(meta.length).toBeGreaterThanOrEqual(70);
      expect(meta.length).toBeLessThanOrEqual(160);
    }
    for (const bio of [copy.publishedBio, copy.bio]) {
      expect(bio.length).toBeGreaterThanOrEqual(40);
      expect(bio.length).toBeLessThanOrEqual(2000);
    }
    expect(copy.bio).not.toBe(copy.publishedBio);
    expect(copy.title).not.toBe(copy.publishedTitle);
    expect(AFFILIATE_HANDLE_PATTERN.test(SANDBOX_AFFILIATE_DEMO_FR_HANDLE)).toBe(true);
    expect(isReservedAffiliateHandle(SANDBOX_AFFILIATE_DEMO_FR_HANDLE)).toBe(false);
    expect(SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME.length).toBeLessThanOrEqual(80);
  });

  it('snapshots the profile it had at the first approval, the way review.ts builds it', () => {
    const snapshot = buildSandboxAffiliateDemoFrPublishedProfile();
    const approved = buildAffiliatePublishedProfile({
      display_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
      bio: SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedBio,
      avatar_object_key: null,
      social_links: {},
      preferred_locale: 'fr',
    });
    expect(snapshot).toEqual(approved);
    expect(snapshot.locale).toBe('fr');
  });

  it('gives its login a reserved address that is never mailed nor advertised', () => {
    expect(usableEmail(SANDBOX_AFFILIATE_DEMO_FR_EMAIL)).toBeNull();
    const alert = readFileSync(path.join(REPO_ROOT, 'apps/nextblock/components/SandboxCredentialsAlert.tsx'), 'utf8');
    expect(alert).not.toContain(SANDBOX_AFFILIATE_DEMO_FR_EMAIL);
    expect(alert).not.toContain(SANDBOX_AFFILIATE_DEMO_FR_HANDLE);
    const generator = readFileSync(path.join(REPO_ROOT, 'tools/scripts/generate-sandbox-reset.ts'), 'utf8');
    expect(generator).not.toContain(SANDBOX_AFFILIATE_DEMO_FR_EMAIL);
  });

  it('builds its Activity feed alerts with the notifier template, already mailed', () => {
    const signedUpAt = new Date(NOW.getTime() - 18 * DAY);
    const submittedAt = new Date(NOW.getTime() - 4 * HOUR);
    const alerts = buildSandboxAffiliateDemoFrAlerts({
      affiliateId: 'af000000-0000-4000-8000-0000000000aa',
      pageId: 'a9000000-0000-4000-8000-0000000000bb',
      tierName: 'Growth Partner',
      siteUrl: 'https://cms.nextblock.dev',
      signedUpAt,
      submittedAt,
    });
    const template = (event: 'SIGNED_UP' | 'PAGE_SUBMITTED', tierName: string | null) =>
      buildAffiliateSystemAlert(event, {
        locale: 'en',
        siteName: 'NextBlock',
        siteUrl: 'https://cms.nextblock.dev',
        recipientName: null,
        handle: SANDBOX_AFFILIATE_DEMO_FR_HANDLE,
        displayName: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
        storefrontUrl: null,
        portalUrl: 'https://cms.nextblock.dev/portal/retailer',
        cmsUrl: 'https://cms.nextblock.dev/cms/affiliates',
        tierName,
      });
    const signedUp = template('SIGNED_UP', 'Growth Partner');
    const submitted = template('PAGE_SUBMITTED', null);
    expect(alerts).toEqual([
      {
        alert_type: 'affiliate_signed_up',
        title: signedUp.title,
        message: signedUp.message,
        metadata: {
          ...signedUp.metadata,
          affiliate_id: 'af000000-0000-4000-8000-0000000000aa',
          emailed_at: signedUpAt.toISOString(),
        },
        createdAt: signedUpAt,
      },
      {
        alert_type: 'affiliate_page_submitted',
        title: submitted.title,
        message: submitted.message,
        metadata: {
          ...submitted.metadata,
          affiliate_id: 'af000000-0000-4000-8000-0000000000aa',
          page_id: 'a9000000-0000-4000-8000-0000000000bb',
          emailed_at: submittedAt.toISOString(),
        },
        createdAt: submittedAt,
      },
    ]);
    expect(alerts[0]?.message).toBe('Atelier Boréal joined the affiliate program on the Growth Partner tier.');
    expect(alerts[0]?.metadata).toMatchObject({ action_url: '/cms/affiliates', tier_name: 'Growth Partner' });
    expect(alerts[0]?.metadata).not.toHaveProperty('spots_remaining');
    expect(alerts[1]?.metadata).toMatchObject({ action_url: '/cms/affiliates/approvals', action_label: 'Review storefronts' });
    // Admin alerts never carry a storefront link.
    expect(JSON.stringify(alerts)).not.toContain('/partners/');
  });
});

describe('planSandboxAffiliateDemoLedger', () => {
  const order = (id: string, overrides: Partial<SandboxAffiliateDemoOrder> = {}): SandboxAffiliateDemoOrder => ({
    id,
    total: 4000,
    subtotal: 4000,
    discount_total: 0,
    currency: 'USD',
    exchange_rate_at_purchase: '1.0000000000',
    provider: 'stripe',
    buyer_email: 'demo@nextblock.dev',
    ...overrides,
  });

  it('puts PAID, CLEARED and PENDING_CLEARANCE on the orders oldest first, with matching totals', () => {
    const ledger = planSandboxAffiliateDemoLedger({
      orders: [order('a', { subtotal: 2600 }), order('b', { subtotal: 6400 }), order('c', { subtotal: 6800 }), order('d')],
      ratePercent: 50,
      baseCurrency: 'USD',
      now: NOW,
    });
    expect(ledger.commissions.map((c) => [c.orderId, c.status, c.commissionMinor])).toEqual([
      ['a', 'PAID', 1300],
      ['b', 'CLEARED', 3200],
      ['c', 'PENDING_CLEARANCE', 3400],
    ]);
    expect(ledger.payout).toEqual({ amountMinor: 1300, createdAt: new Date(NOW.getTime() - 13 * DAY), paidAt: new Date(NOW.getTime() - 13 * DAY) });
    expect(ledger.totalEarnedMinor).toBe(7900);
    expect(ledger.totalPaidMinor).toBe(1300);

    const [paid, cleared, pending] = ledger.commissions;
    expect(pending?.clearsAt).toEqual(new Date(NOW.getTime() + 20 * DAY));
    expect(pending?.clearedAt).toBeNull();
    expect(cleared?.clearedAt).toEqual(new Date(NOW.getTime() - 3 * DAY));
    expect(paid?.paidAt).toEqual(new Date(NOW.getTime() - 13 * DAY));
    for (const commission of ledger.commissions) {
      // The founding tier's 30-day hold.
      expect(commission.clearsAt.getTime() - commission.createdAt.getTime()).toBe(30 * DAY);
    }
  });

  it('uses the SQL formula: net of discounts, converted to the base currency', () => {
    const ledger = planSandboxAffiliateDemoLedger({
      orders: [
        order('discounted', { subtotal: 5000, total: 6000, discount_total: 1000 }),
        order('cad', { subtotal: 6830, total: 6830, currency: 'CAD', exchange_rate_at_purchase: '1.3660000000' }),
        order('total-only', { subtotal: null, total: 2001 }),
      ],
      ratePercent: 35.5,
      baseCurrency: 'usd',
      now: NOW,
    });
    const cadNet = convertAffiliateAmountToBaseMinor({ amountMinor: 6830, fromCurrency: 'CAD', toCurrency: 'USD', exchangeRate: 1.366 });
    expect(ledger.currency).toBe('USD');
    expect(ledger.commissions.map((c) => [c.orderId, c.orderNetMinor, c.netBaseMinor, c.exchangeRateSnapshot])).toEqual([
      ['discounted', 4000, 4000, 1],
      ['cad', 6830, cadNet, 1.366],
      ['total-only', 2001, 2001, 1],
    ]);
    expect(ledger.commissions.map((c) => c.commissionMinor)).toEqual([
      computeAffiliateCommissionMinor({ netMinor: 4000, ratePercent: 35.5 }),
      computeAffiliateCommissionMinor({ netMinor: cadNet, ratePercent: 35.5 }),
      computeAffiliateCommissionMinor({ netMinor: 2001, ratePercent: 35.5 }),
    ]);
  });

  it("skips orders that earn nothing and the partner's own purchases", () => {
    const ledger = planSandboxAffiliateDemoLedger({
      orders: [
        order('free', { subtotal: 0, total: 0 }),
        order('fully-discounted', { subtotal: 1000, discount_total: 1500 }),
        order('no-rate', { currency: 'EUR', exchange_rate_at_purchase: null }),
        order('self', { buyer_email: ' Partner+demo@NextBlock.dev ' }),
        order('freemius', { provider: 'freemius' }),
      ],
      ratePercent: 50,
      baseCurrency: 'USD',
      now: NOW,
    });
    expect(ledger.commissions.map((c) => [c.orderId, c.gateway, c.status])).toEqual([['freemius', 'FREEMIUS', 'PAID']]);
  });

  it('keeps PAID and PENDING_CLEARANCE first when fewer orders qualify', () => {
    const two = planSandboxAffiliateDemoLedger({ orders: [order('a'), order('b')], ratePercent: 50, baseCurrency: 'USD', now: NOW });
    expect(two.commissions.map((c) => c.status)).toEqual(['PAID', 'PENDING_CLEARANCE']);
    expect(two.totalPaidMinor).toBe(2000);

    const none = planSandboxAffiliateDemoLedger({ orders: [], ratePercent: 50, baseCurrency: null, now: NOW });
    expect(none).toEqual({ currency: 'USD', commissions: [], payout: null, totalEarnedMinor: 0, totalPaidMinor: 0 });
  });
});

describe('the seed-owned orders and the failed payout', () => {
  const row = (sku: string, variantPrice: unknown, productPrice: unknown = 9900) => ({
    variant_id: `variant-${sku}`,
    sku,
    variant_price: variantPrice,
    product_id: `product-${sku}`,
    product_price: productPrice,
  });

  it('builds order lines from the default-language variants, falling back to the product price', () => {
    const lines = buildSandboxAffiliateDemoOrderLines(
      [
        { sku: 'NB-STUDIO-TEE-M', quantity: 1 },
        { sku: 'NB-SIGNAL-CAP-M', quantity: 2 },
        { sku: 'NB-MISSING-M', quantity: 1 },
        { sku: 'NB-FREE-M', quantity: 1 },
      ],
      [row('NB-STUDIO-TEE-M', 3200), row('NB-SIGNAL-CAP-M', 0, 2600), row('NB-FREE-M', 0, 0)],
    );
    expect(lines).toEqual([
      { productId: 'product-NB-STUDIO-TEE-M', variantId: 'variant-NB-STUDIO-TEE-M', sku: 'NB-STUDIO-TEE-M', quantity: 1, unitPriceMinor: 3200 },
      { productId: 'product-NB-SIGNAL-CAP-M', variantId: 'variant-NB-SIGNAL-CAP-M', sku: 'NB-SIGNAL-CAP-M', quantity: 2, unitPriceMinor: 2600 },
    ]);
    expect(buildSandboxAffiliateDemoOrderLines(SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES, [])).toEqual([]);
  });

  it('plans a FAILED payout holding one CLEARED commission, between the ledger dates', () => {
    const lines = buildSandboxAffiliateDemoOrderLines(SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES, [
      row('NB-STUDIO-TEE-M', 3200),
      row('NB-SIGNAL-CAP-M', 2600),
    ]);
    const plan = planSandboxAffiliateDemoFailedPayout({
      orderId: 'order-x',
      lines,
      buyerEmail: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
      ratePercent: 50,
      baseCurrency: 'usd',
      now: NOW,
    });
    expect(plan).not.toBeNull();
    const { commission, payout } = plan as NonNullable<typeof plan>;
    expect(commission).toMatchObject({
      orderId: 'order-x',
      status: 'CLEARED',
      gateway: 'STRIPE',
      orderCurrency: 'USD',
      orderNetMinor: 5800,
      netBaseMinor: 5800,
      ratePercent: 50,
      commissionMinor: 2900,
      paidAt: null,
    });
    // Earned 38 days ago, cleared after the 30-day hold, claimed 7 days ago (168 h), then retried
    // by the next four daily cycles (150, 126, 102 and 78 h ago).
    expect(commission.createdAt).toEqual(new Date(NOW.getTime() - 38 * DAY));
    expect(commission.clearsAt.getTime() - commission.createdAt.getTime()).toBe(30 * DAY);
    expect(commission.clearedAt).toEqual(commission.clearsAt);
    expect(payout).toEqual({
      amountMinor: 2900,
      createdAt: new Date(NOW.getTime() - 7 * DAY),
      lastAttemptAt: new Date(NOW.getTime() - 78 * HOUR),
      attemptCount: 5,
      failureReason: SANDBOX_AFFILIATE_DEMO_FAILURE_REASON,
    });
    expect(commission.clearsAt.getTime()).toBeLessThan(payout.createdAt.getTime());
    expect(CLOSED_FAILURE_REASONS).not.toContain(payout.failureReason);
  });

  it('gives the FAILED payout the history the retry rules produce: retries exhausted, Retry and Release left', () => {
    const lines = buildSandboxAffiliateDemoOrderLines(SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES, [
      row('NB-STUDIO-TEE-M', 3200),
      row('NB-SIGNAL-CAP-M', 2600),
    ]);
    const plan = planSandboxAffiliateDemoFailedPayout({
      orderId: 'order-x',
      lines,
      buyerEmail: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
      ratePercent: 50,
      baseCurrency: 'USD',
      now: NOW,
    });
    const { payout } = plan as NonNullable<typeof plan>;
    // A transient refusal: the daily cycle retries a FAILED payout whose last attempt is older than
    // the delay while attempt_count is below the cap. At the cap no retry is due any more, so the
    // payout waits for the admin's Retry or Release (and the last failure raised the alert).
    expect(isAffiliatePayoutTransientFailureReason(payout.failureReason)).toBe(true);
    expect(payout.attemptCount).toBe(AFFILIATE_PAYOUT_MAX_ATTEMPTS);
    // Each of the retries came at least the retry delay after the attempt before it.
    const retries = payout.attemptCount - 1;
    expect(payout.lastAttemptAt.getTime() - payout.createdAt.getTime()).toBeGreaterThanOrEqual(
      retries * AFFILIATE_PAYOUT_AUTO_RETRY_DELAY_MS,
    );
    expect(payout.lastAttemptAt.getTime()).toBeLessThan(NOW.getTime());
  });

  it('plans nothing without lines, at a zero rate or for the partner as buyer', () => {
    const lines = buildSandboxAffiliateDemoOrderLines([{ sku: 'NB-STUDIO-TEE-M', quantity: 1 }], [row('NB-STUDIO-TEE-M', 3200)]);
    const plan = (overrides: Partial<Parameters<typeof planSandboxAffiliateDemoFailedPayout>[0]>) =>
      planSandboxAffiliateDemoFailedPayout({
        orderId: 'order-x',
        lines,
        buyerEmail: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
        ratePercent: 50,
        baseCurrency: 'USD',
        now: NOW,
        ...overrides,
      });
    expect(plan({ lines: [] })).toBeNull();
    expect(plan({ ratePercent: 0 })).toBeNull();
    expect(plan({ buyerEmail: ' Partner+demo@NextBlock.dev ' })).toBeNull();
    expect(plan({})).not.toBeNull();
  });

  it('builds the payout-failed alert with the notifier template, already mailed', () => {
    const failedAt = new Date(NOW.getTime() - 78 * HOUR);
    const alert = buildSandboxAffiliateDemoPayoutFailedAlert({
      affiliateId: 'af000000-0000-4000-8000-0000000000aa',
      payoutId: 'ad000000-0000-4000-8000-0000000000cc',
      amountMinor: 2900,
      currency: 'USD',
      siteUrl: 'https://cms.nextblock.dev',
      failedAt,
    });
    // The email data lib/affiliates/notify.ts passes for PAYOUT_FAILED (payout-runner.ts onPayoutFailed).
    const template = buildAffiliateSystemAlert('PAYOUT_FAILED', {
      locale: 'en',
      siteName: 'NextBlock',
      siteUrl: 'https://cms.nextblock.dev',
      recipientName: null,
      handle: SANDBOX_AFFILIATE_DEMO_HANDLE,
      displayName: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
      storefrontUrl: null,
      portalUrl: 'https://cms.nextblock.dev/portal/retailer/payouts',
      cmsUrl: 'https://cms.nextblock.dev/cms/affiliates/payouts',
      amountLabel: '$29.00',
      reason: SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION,
    });
    expect(alert).toEqual({
      alert_type: 'affiliate_payout_failed',
      title: template.title,
      message: template.message,
      metadata: {
        ...template.metadata,
        affiliate_id: 'af000000-0000-4000-8000-0000000000aa',
        payout_id: 'ad000000-0000-4000-8000-0000000000cc',
        emailed_at: failedAt.toISOString(),
      },
      createdAt: failedAt,
    });
    expect(alert.title).toBe('Affiliate payout failed');
    expect(alert.message).toBe(
      'The payout of $29.00 to Studio Nova failed. Reason: The Stripe balance could not cover the transfer (balance_insufficient).',
    );
    // A CMS banner type, linking inside /cms/affiliates; admin alerts never link a storefront.
    expect(AFFILIATE_BANNER_ALERT_TYPES).toContain(alert.alert_type);
    expect(alert.metadata).toMatchObject({
      action_url: '/cms/affiliates/payouts',
      action_label: 'Review payouts',
      amount_label: '$29.00',
      reason: SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION,
    });
    expect(JSON.stringify(alert)).not.toContain('/partners/');
    // Worded the way payout-runner.ts describes the reason.
    const runner = readFileSync(path.join(REPO_ROOT, 'apps/nextblock/lib/affiliates/payout-runner.ts'), 'utf8');
    expect(runner).toContain(`'${SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION}'`);
  });
});

describe('seedSandboxAffiliateDemo', () => {
  it('seeds a published Founding Ambassador storefront with a consistent ledger', async () => {
    const state = freshSandbox();
    const { result, auth, db } = await seed(state);

    expect(result).toEqual({ handle: SANDBOX_AFFILIATE_DEMO_HANDLE, seeded: true });

    // The account: created once, confirmed, the published password, a partner role. (The second
    // createUser call is Atelier Boréal's, covered below.)
    expect(auth.createUser).toHaveBeenCalledTimes(2);
    expect(auth.createUser).toHaveBeenCalledWith({
      email: SANDBOX_AFFILIATE_DEMO_EMAIL,
      password: SANDBOX_AFFILIATE_DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME },
    });
    const user = partnerUser(state) as Row;
    expect(state.profiles.find((row) => row['id'] === user['id'])?.['role']).toBe('RTL');

    // The partner profile.
    const profile = partnerProfile(state);
    expect(profile).toMatchObject({
      user_id: user['id'],
      tier_id: FOUNDING_TIER_ID,
      display_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
      bio: SANDBOX_AFFILIATE_DEMO_COPY.bio,
      avatar_object_key: SANDBOX_AFFILIATE_DEMO_AVATAR_KEY,
      social_links: { website: 'https://nextblock.dev/' },
      preferred_locale: 'en',
      status: 'ACTIVE',
      onboarding_step: 'ACTIVE_PUBLISHED',
      stripe_connect_account_id: null,
      stripe_connect_onboarding_complete: false,
      payout_configured_at: null,
      total_clicks: SANDBOX_AFFILIATE_DEMO_TOTAL_CLICKS,
    });
    expect(profile['first_published_at']).not.toBeNull();
    expect(profile['profile_completed_at']).not.toBeNull();
    expect(profile['page_submitted_at']).not.toBeNull();
    expect(foundingTier(state)['member_count']).toBe(1);

    // The storefront: approved exactly as drafted.
    expect(state.affiliate_pages).toHaveLength(2);
    const page = partnerPage(state);
    expect(page).toMatchObject({
      affiliate_id: profile['id'],
      user_id: user['id'],
      title: SANDBOX_AFFILIATE_DEMO_COPY.title,
      meta_description: SANDBOX_AFFILIATE_DEMO_COPY.metaDescription,
      published_title: SANDBOX_AFFILIATE_DEMO_COPY.title,
      published_meta_description: SANDBOX_AFFILIATE_DEMO_COPY.metaDescription,
      approval_status: 'PUBLISHED',
      admin_feedback_note: null,
      draft_version: 1,
      submitted_version: 1,
      reviewed_by: DEMO_ADMIN_ID,
      featured_product_ids: [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn],
      published_featured_product_ids: [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn],
      published_profile: buildSandboxAffiliateDemoPublishedProfile(),
    });
    expect(page['published_content']).toEqual(page['draft_content']);
    // A coherent history: joined, approved the first time, last edited, submitted, approved.
    const times = [
      profile['created_at'],
      profile['first_published_at'],
      page['draft_updated_at'],
      page['submitted_at'],
      page['reviewed_at'],
    ].map((value: Date) => value.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(page['published_at']).toEqual(page['reviewed_at']);
    expect(page['published_at'].getTime()).toBeLessThan(NOW.getTime());
    const doc = page['published_content'] as StorefrontDoc;
    expect(sanitizeStorefrontDoc(doc, { allowedImageOrigins: [] }).changed).toBe(false);
    expect(gridsOf(doc)[0]?.attrs.productIds).toEqual([PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn]);

    // The ledger: the three oldest of seedFakeStoreData's orders, 50 % of each (and the failed
    // payout's commission on the seed's own order, below).
    const commissions = [...state.affiliate_commissions]
      .filter((row) => row['order_id'] !== SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID)
      .sort((a, b) => a['created_at'].getTime() - b['created_at'].getTime());
    expect(commissions.map((row) => [row['order_id'], row['status'], row['commission_amount_cents']])).toEqual([
      ['0d000000-0000-4000-8000-000000000004', 'PAID', 1300],
      ['0d000000-0000-4000-8000-000000000003', 'CLEARED', 3200],
      ['0d000000-0000-4000-8000-000000000002', 'PENDING_CLEARANCE', 3400],
    ]);
    expect(commissions.every((row) => row['currency'] === 'USD' && row['gateway'] === 'STRIPE')).toBe(true);
    expect(commissions.every((row) => Number(row['commission_rate_snapshot']) === 50)).toBe(true);
    expect(commissions.map((row) => row['payout_id'] === null)).toEqual([false, true, true]);

    expect(state.affiliate_payouts).toHaveLength(2);
    const completed = state.affiliate_payouts.find((row) => row['status'] === 'COMPLETED') as Row;
    expect(completed).toMatchObject({
      affiliate_id: profile['id'],
      amount_cents: 1300,
      currency: 'USD',
      status: 'COMPLETED',
      stripe_transfer_id: SANDBOX_AFFILIATE_DEMO_TRANSFER_ID,
      stripe_destination_account: SANDBOX_AFFILIATE_DEMO_DESTINATION,
      attempt_count: 1,
    });
    expect(commissions[0]).toMatchObject({
      payout_id: completed['id'],
      stripe_transfer_id: SANDBOX_AFFILIATE_DEMO_TRANSFER_ID,
    });

    // 7900 on seedFakeStoreData's orders plus the failed payout's 2900.
    expect(profile['total_earned_cents']).toBe(10800);
    expect(profile['total_paid_cents']).toBe(1300);
    expectLedgerConsistent(state);

    const attributed = state.orders.filter((row) => commissions.some((commission) => commission['order_id'] === row['id']));
    expect(attributed.map((row) => row['affiliate_source']).sort()).toEqual(['referral_link', 'storefront', 'storefront']);

    // One transaction, committed.
    expect(db.statements.filter((statement) => statement === 'BEGIN')).toHaveLength(1);
    expect(db.statements).toContain('COMMIT');
  });

  it("back-dates the ledger's orders to their commissions without firing the paid branch", async () => {
    const state = freshSandbox();
    const before = structuredClone(state.orders);

    await seed(state);

    const profile = partnerProfile(state);
    const commissions = state.affiliate_commissions.filter(
      (row) => row['affiliate_id'] === profile['id'] && row['order_id'] !== SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID,
    );
    expect(commissions).toHaveLength(3);
    for (const commission of commissions) {
      const order = orderById(state, commission['order_id']) as Row;
      const original = before.find((row) => row['id'] === order['id']) as Row;
      // 44, 33 and 10 days ago, like the ledger (the orders were 4 to 8 hours old).
      expect(order['paid_at']).toEqual(commission['created_at']);
      expect(order['created_at']).toEqual(new Date(commission['created_at'].getTime() - 3 * MINUTE));
      expect(original['paid_at'].getTime() - order['paid_at'].getTime()).toBeGreaterThan(9 * DAY);
      // Nothing else about the order moved.
      expect(order).toMatchObject({
        status: original['status'],
        total: original['total'],
        subtotal: original['subtotal'],
        invoice_number: original['invoice_number'],
        user_id: original['user_id'],
      });
    }
    expect(commissions.map((row) => Math.round((NOW.getTime() - row['created_at'].getTime()) / DAY)).sort((a, b) => a - b)).toEqual([
      10, 33, 44,
    ]);
    // affiliate_on_order_change fired once per back-dated order and took neither branch (02030:
    // it records only when paid_at was NULL, and voids only on a status change).
    expect(state.orderTriggerFirings).toEqual(commissions.map((row) => ({ orderId: row['order_id'], branch: 'none' })));
    // The two newest orders keep their dates and stay unattributed.
    for (const id of ['0d000000-0000-4000-8000-000000000000', '0d000000-0000-4000-8000-000000000001']) {
      expect(orderById(state, id)).toEqual(before.find((row) => row['id'] === id));
    }
  });

  it('seeds a FAILED payout with Retry and Release for the CLEARED commission it holds', async () => {
    const state = freshSandbox();
    await seed(state);

    const profile = partnerProfile(state);
    const failed = state.affiliate_payouts.find((row) => row['status'] === 'FAILED') as Row;
    expect(failed).toMatchObject({
      affiliate_id: profile['id'],
      amount_cents: 2900,
      currency: 'USD',
      stripe_destination_account: SANDBOX_AFFILIATE_DEMO_DESTINATION,
      stripe_transfer_id: null,
      livemode: SANDBOX_AFFILIATE_DEMO_LIVEMODE,
      attempt_count: 5,
      failure_reason: SANDBOX_AFFILIATE_DEMO_FAILURE_REASON,
      trigger: 'cron',
      paid_at: null,
      created_at: new Date(NOW.getTime() - 7 * DAY),
      last_attempt_at: new Date(NOW.getTime() - 78 * HOUR),
    });
    // Not closed: the payouts screen offers Retry and Release (both answer `sandbox` there). The
    // automatic retries are over: the cycle only retries below the cap.
    expect(CLOSED_FAILURE_REASONS).not.toContain(failed['failure_reason']);
    expect(failed['attempt_count']).toBe(AFFILIATE_PAYOUT_MAX_ATTEMPTS);

    // The alert the last retry raised (payout-runner.ts onPayoutFailed, retries exhausted): one,
    // unresolved, a CMS banner type, linking the payouts screen, naming this payout, already mailed.
    const alerts = state.system_alerts.filter((row) => row['alert_type'] === 'affiliate_payout_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      title: 'Affiliate payout failed',
      message: `The payout of $29.00 to ${SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME} failed. Reason: ${SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION}`,
      is_resolved: false,
      resolved_at: null,
      created_at: failed['last_attempt_at'],
      updated_at: failed['last_attempt_at'],
      metadata: {
        action_url: '/cms/affiliates/payouts',
        action_label: 'Review payouts',
        handle: SANDBOX_AFFILIATE_DEMO_HANDLE,
        display_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
        amount_label: '$29.00',
        reason: SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION,
        affiliate_id: profile['id'],
        payout_id: failed['id'],
        emailed_at: failed['last_attempt_at'].toISOString(),
      },
    });
    expect(AFFILIATE_BANNER_ALERT_TYPES).toContain(alerts[0]?.['alert_type']);
    expect(JSON.stringify(alerts)).not.toContain('/partners/');

    const held = state.affiliate_commissions.filter((row) => row['payout_id'] === failed['id']);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      affiliate_id: profile['id'],
      order_id: SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID,
      status: 'CLEARED',
      commission_amount_cents: 2900,
      net_order_amount_cents: 5800,
      paid_at: null,
      stripe_transfer_id: null,
      created_at: new Date(NOW.getTime() - 38 * DAY),
    });

    // The sale it was earned on: shipped, invoiced, its lines at the variant prices, in the demo admin's name.
    const order = orderById(state, SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID) as Row;
    expect(order).toMatchObject({
      user_id: DEMO_ADMIN_ID,
      status: 'shipped',
      total: 5800,
      subtotal: 5800,
      shipping_total: 0,
      tax_total: 0,
      discount_total: 0,
      currency: 'USD',
      provider: 'stripe',
      invoice_number: 'INV-000001',
      paid_at: new Date(NOW.getTime() - 38 * DAY),
      customer_details: { email: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL, name: 'Nextblock CMS' },
      affiliate_id: profile['id'],
      affiliate_source: 'referral_link',
      affiliate_base_currency: 'USD',
      affiliate_livemode: SANDBOX_AFFILIATE_DEMO_LIVEMODE,
    });
    expect(itemsOf(state, SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID).map((row) => [row['product_id'], row['quantity'], row['price_at_purchase']])).toEqual([
      [PRODUCTS.teeEn, 1, 3200],
      [PRODUCTS.capEn, 1, 2600],
    ]);
    for (const item of itemsOf(state, SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID)) {
      const variant = state.product_variants.find((row) => row['id'] === item['variant_id']) as Row;
      expect(variant['product_id']).toBe(item['product_id']);
      expect(variant['sku']).toMatch(/-M$/);
    }
    expectLedgerConsistent(state);
  });

  it('credits Studio Nova with an unpaid order whose payment would record the commission', async () => {
    const state = freshSandbox();
    const { db } = await seed(state);

    const profile = partnerProfile(state);
    const order = orderById(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID) as Row;
    expect(order).toMatchObject({
      user_id: DEMO_ADMIN_ID,
      status: 'pending',
      total: 6800,
      subtotal: 6800,
      discount_total: 0,
      currency: 'USD',
      provider: 'stripe',
      invoice_number: null,
      paid_at: null,
      inventory_deducted_at: null,
      created_at: new Date(NOW.getTime() - 25 * MINUTE),
      customer_details: { email: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL, name: 'Nextblock CMS' },
      // The way checkout records an attribution: partner, source, store base currency, key mode.
      affiliate_id: profile['id'],
      affiliate_source: 'storefront',
      affiliate_base_currency: 'USD',
      affiliate_livemode: SANDBOX_AFFILIATE_DEMO_LIVEMODE,
    });
    expect(itemsOf(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID)).toEqual([
      expect.objectContaining({ product_id: PRODUCTS.pantsEn, quantity: 1, price_at_purchase: 6800 }),
    ]);
    // No commission yet; inserting it fired nothing (an INSERT never fires the orders trigger).
    expect(state.affiliate_commissions.some((row) => row['order_id'] === order['id'])).toBe(false);
    expect(state.orderTriggerFirings.some((firing) => firing.orderId === order['id'])).toBe(false);
    expect(db.statements.filter((statement) => statement.startsWith('INSERT INTO public.orders '))).toHaveLength(2);
    expectLedgerConsistent(state);

    // What /cms/orders does on "Paid": the status, then assign_order_invoice_metadata() sets paid_at
    // from NULL, which is the transition the orders trigger records a commission on.
    const markPaid = createFakeDb(state);
    await markPaid.sql`UPDATE public.orders SET status = ${'paid'} WHERE id = ${order['id']}`;
    await markPaid.sql`UPDATE public.orders SET paid_at = ${NOW} WHERE id = ${order['id']}`;
    expect(state.orderTriggerFirings.slice(-2)).toEqual([
      { orderId: order['id'], branch: 'none' },
      { orderId: order['id'], branch: 'record' },
    ]);
  });

  it('is idempotent: a second run converges on the same rows', async () => {
    const state = freshSandbox();
    await seed(state);
    const first = structuredClone(state);

    const { result, auth } = await seed(state);

    expect(result.seeded).toBe(true);
    expect(auth.createUser).not.toHaveBeenCalled();
    const user = partnerUser(state) as Row;
    const fr = frUser(state) as Row;
    expect(auth.updateUserById).toHaveBeenCalledTimes(2);
    expect(auth.updateUserById).toHaveBeenCalledWith(user['id'], {
      password: SANDBOX_AFFILIATE_DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME },
    });
    // Atelier Boréal's password is drawn again: whatever was set in between no longer works.
    expect(auth.updateUserById).toHaveBeenCalledWith(fr['id'], {
      password: expect.any(String),
      email_confirm: true,
      user_metadata: { full_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME },
    });
    expect(fr['password']).not.toBe((first.authUsers.find((row) => row['id'] === fr['id']) as Row)['password']);

    expect(state.authUsers).toHaveLength(first.authUsers.length);
    expect(state.affiliate_profiles).toHaveLength(2);
    expect(state.affiliate_pages).toHaveLength(2);
    expect(state.affiliate_commissions).toHaveLength(4);
    expect(state.affiliate_payouts).toHaveLength(2);
    // Atelier Boréal's two and Studio Nova's payout-failed alert, replaced rather than added to.
    expect(state.system_alerts).toHaveLength(3);
    expect(state.order_items).toHaveLength(first.order_items.length);
    expect(foundingTier(state)['member_count']).toBe(1);
    expect(growthTier(state)['member_count']).toBe(1);

    const page = partnerPage(state);
    expect(page['approval_status']).toBe('PUBLISHED');
    expect(page['draft_version']).toBe(1);
    expect(page['submitted_version']).toBe(1);
    expect(page['draft_content']).toEqual(first.affiliate_pages.find((row) => row['id'] === page['id'])?.['draft_content']);

    const profile = partnerProfile(state);
    expect(profile['id']).toBe(first.affiliate_profiles.find((row) => row['handle'] === SANDBOX_AFFILIATE_DEMO_HANDLE)?.['id']);
    expect(profile['total_earned_cents']).toBe(10800);
    expect(profile['total_paid_cents']).toBe(1300);
    expect(state.orders.filter((row) => row['affiliate_id']).map((row) => row['id']).sort()).toEqual(
      first.orders.filter((row) => row['affiliate_id']).map((row) => row['id']).sort(),
    );
    // The same orders back-dated to the same dates, the seed's own orders rewritten under the same ids.
    for (const order of first.orders.filter((row) => row['affiliate_id'])) {
      expect(orderById(state, order['id'])).toMatchObject({ paid_at: order['paid_at'], created_at: order['created_at'] });
    }
    expect(state.orders.map((row) => row['id']).sort()).toEqual(first.orders.map((row) => row['id']).sort());
    // The second partner converges too: the same page id, version and review state.
    const frPageNow = frPage(state) as Row;
    const frPageFirst = first.affiliate_pages.find((row) => row['id'] === frPageNow['id']) as Row;
    expect(frPageNow).toMatchObject({
      approval_status: 'PENDING_REVIEW',
      draft_version: SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION,
      submitted_version: SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION,
      draft_content: frPageFirst['draft_content'],
      published_content: frPageFirst['published_content'],
      published_profile: frPageFirst['published_profile'],
    });
    expect(state.system_alerts.map((row) => [row['alert_type'], row['metadata']])).toEqual(
      first.system_alerts.map((row) => [row['alert_type'], row['metadata']]),
    );
    // The rerun replaced the payout-failed alert: one, naming the FAILED payout the rerun wrote.
    const failedNow = state.affiliate_payouts.find((row) => row['status'] === 'FAILED') as Row;
    const payoutAlerts = state.system_alerts.filter((row) => row['alert_type'] === 'affiliate_payout_failed');
    expect(payoutAlerts).toHaveLength(1);
    expect(payoutAlerts[0]?.['metadata']).toMatchObject({ affiliate_id: profile['id'], payout_id: failedNow['id'] });
    expectLedgerConsistent(state);
  });

  it('restores the demo after visitors changed the account between resets', async () => {
    const state = freshSandbox();
    await seed(state);
    const profile = partnerProfile(state);
    const page = partnerPage(state);

    // A visitor signed in as the partner: new password, edited and submitted the draft; an admin
    // suspended the partner and moved them to another tier.
    (partnerUser(state) as Row)['password'] = 'hijacked';
    Object.assign(page, {
      draft_content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spam' }] }] },
      featured_product_ids: [],
      draft_version: 2,
      approval_status: 'PENDING_REVIEW',
      submitted_version: 2,
    });
    const starterTier = state.affiliate_tiers.find((tier) => tier['slug'] === 'starter-partner') as Row;
    Object.assign(profile, { status: 'SUSPENDED', suspended_reason: 'Spam', tier_id: starterTier['id'] });
    // What the member_count trigger does for that tier move.
    foundingTier(state)['member_count'] -= 1;
    starterTier['member_count'] += 1;

    const { result } = await seed(state);

    expect(result.seeded).toBe(true);
    expect((partnerUser(state) as Row)['password']).toBe(SANDBOX_AFFILIATE_DEMO_PASSWORD);
    expect(partnerProfile(state)).toMatchObject({ status: 'ACTIVE', suspended_reason: null, tier_id: FOUNDING_TIER_ID });
    expect(foundingTier(state)['member_count']).toBe(1);
    // Withdrawn, rewritten (the guard bumps the version once) and re-approved at that version.
    expect(page['approval_status']).toBe('PUBLISHED');
    expect(page['draft_version']).toBe(3);
    expect(page['submitted_version']).toBe(3);
    expect(page['published_content']).toEqual(page['draft_content']);
    expect(gridsOf(page['draft_content'] as StorefrontDoc)).toHaveLength(1);
    expectLedgerConsistent(state);
  });

  it('seeds no product grid when the catalog has no apparel', async () => {
    const state = freshSandbox();
    state.products = state.products.filter((row) => !SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS.includes(row['sku']));
    state.product_variants = state.product_variants.filter((variant) =>
      state.products.some((product) => product['id'] === variant['product_id']),
    );

    const { result } = await seed(state);

    expect(result.seeded).toBe(true);
    const page = partnerPage(state);
    expect(gridsOf(page['published_content'] as StorefrontDoc)).toEqual([]);
    expect(page['featured_product_ids']).toEqual([]);
    expect(page['published_featured_product_ids']).toEqual([]);
    expect((page['published_content'] as StorefrontDoc).content.length).toBeGreaterThan(0);
    // Without the apparel variants there is no seed-owned order, so no failed payout either.
    expect(orderById(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID)).toBeUndefined();
    expect(orderById(state, SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID)).toBeUndefined();
    expect(state.affiliate_payouts.map((row) => row['status'])).toEqual(['COMPLETED']);
    expect(state.system_alerts.some((row) => row['alert_type'] === 'affiliate_payout_failed')).toBe(false);
    // The second partner's pages lose their grids but still differ.
    const fr = frPage(state) as Row;
    expect(gridsOf(fr['published_content'] as StorefrontDoc)).toEqual([]);
    expect(gridsOf(fr['draft_content'] as StorefrontDoc)).toEqual([]);
    expect(fr['draft_content']).not.toEqual(fr['published_content']);
    expectLedgerConsistent(state);
  });

  it('only uses default-language apparel for the grid', async () => {
    const state = freshSandbox();
    state.languages = [
      { id: 1, code: 'en', is_default: false },
      { id: 2, code: 'fr', is_default: true },
    ];

    await seed(state);

    expect(partnerPage(state)['featured_product_ids']).toEqual([PRODUCTS.teeFr, PRODUCTS.capFr, PRODUCTS.pantsFr]);
    expect((frPage(state) as Row)['published_featured_product_ids']).toEqual([PRODUCTS.teeFr, PRODUCTS.capFr, PRODUCTS.pantsFr]);
    expect(itemsOf(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID).map((row) => row['product_id'])).toEqual([PRODUCTS.pantsFr]);
  });

  it('seeds the storefront without a ledger when the demo admin (the buyer) is missing', async () => {
    const state = freshSandbox();
    state.authUsers = state.authUsers.filter((row) => row['id'] !== DEMO_ADMIN_ID);
    state.profiles = state.profiles.filter((row) => row['id'] !== DEMO_ADMIN_ID);
    state.orders = state.orders.map((row) => ({ ...row, user_id: null }));

    const { result } = await seed(state);

    expect(result.seeded).toBe(true);
    expect(state.affiliate_commissions).toEqual([]);
    expect(state.affiliate_payouts).toEqual([]);
    expect(state.order_items).toEqual([]);
    expect(state.system_alerts.some((row) => row['alert_type'] === 'affiliate_payout_failed')).toBe(false);
    expect(orderById(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID)).toBeUndefined();
    expect(partnerProfile(state)).toMatchObject({ total_earned_cents: 0, total_paid_cents: 0 });
    expect(partnerPage(state)['reviewed_by']).toBeNull();
    // The second partner is still in review, with nobody recorded as its reviewer.
    expect(frPage(state)).toMatchObject({ approval_status: 'PENDING_REVIEW', reviewed_by: null });
  });

  it("never touches Step A's preserved users", async () => {
    const state = freshSandbox();
    const preservedBefore = structuredClone(state.profiles.filter((row) => [DEMO_ADMIN_ID, OTHER_ADMIN_ID].includes(row['id'])));
    const { db, auth } = await seed(state);
    await seed(state);

    // The preserved users' auth rows and profiles are unchanged; only the partners' are written.
    expect(state.profiles.filter((row) => [DEMO_ADMIN_ID, OTHER_ADMIN_ID].includes(row['id']))).toEqual(preservedBefore);
    expect(state.authUsers.find((row) => row['id'] === DEMO_ADMIN_ID)?.['password']).toBe('password');
    const partnerIds = [(partnerUser(state) as Row)['id'], (frUser(state) as Row)['id']];
    for (const call of auth.updateUserById.mock.calls) expect(partnerIds).toContain(call[0]);
    const authStatements = db.statements.filter((statement) => /auth\.users/.test(statement));
    expect(authStatements.length).toBeGreaterThan(0);
    expect(authStatements.every((statement) => statement.startsWith('SELECT '))).toBe(true);
    expect(db.statements.some((statement) => /^(INSERT INTO|UPDATE|DELETE FROM) public\.profiles/.test(statement) && !statement.includes("'RTL'"))).toBe(false);
    // The preserved demo admin's orders are only ever attributed and back-dated, never deleted.
    const deletes = db.statements.filter((statement) => statement.startsWith('DELETE FROM public.orders'));
    expect(deletes).toEqual(['DELETE FROM public.orders WHERE id = ANY($1::uuid[])']);
    expect(state.orders.filter((row) => row['id'].startsWith('0d000000-'))).toHaveLength(5);

    // Step A (the reset SQL generator) still preserves exactly the two demo admins.
    const generator = readFileSync(path.join(REPO_ROOT, 'tools/scripts/generate-sandbox-reset.ts'), 'utf8');
    const stepA = /DELETE FROM auth\.users\s+WHERE id NOT IN \(([^)]*)\)/.exec(generator)?.[1] ?? '';
    expect(stepA.match(/'[0-9a-f-]{36}'/g)).toEqual([`'${DEMO_ADMIN_ID}'`, `'${OTHER_ADMIN_ID}'`]);
    expect(generator).not.toContain(SANDBOX_AFFILIATE_DEMO_EMAIL);
    expect(generator).not.toContain(SANDBOX_AFFILIATE_DEMO_HANDLE);
    expect(generator).not.toContain(SANDBOX_AFFILIATE_DEMO_FR_EMAIL);
    expect(generator).not.toContain(SANDBOX_AFFILIATE_DEMO_FR_HANDLE);
  });

  it('seeds Atelier Boréal: a published French storefront with an edit waiting for review', async () => {
    const state = freshSandbox();
    const { auth } = await seed(state);

    // The login: a reserved address, a random password, never the published one.
    expect(auth.createUser).toHaveBeenCalledWith({
      email: SANDBOX_AFFILIATE_DEMO_FR_EMAIL,
      password: expect.any(String),
      email_confirm: true,
      user_metadata: { full_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME },
    });
    const user = frUser(state) as Row;
    expect(user['password']).not.toBe(SANDBOX_AFFILIATE_DEMO_PASSWORD);
    expect(String(user['password']).length).toBeGreaterThanOrEqual(32);
    expect(state.profiles.find((row) => row['id'] === user['id'])).toMatchObject({
      role: 'RTL',
      full_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
      website: null,
    });

    const profile = frProfile(state) as Row;
    expect(profile).toMatchObject({
      user_id: user['id'],
      tier_id: GROWTH_TIER_ID,
      display_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
      bio: SANDBOX_AFFILIATE_DEMO_FR_COPY.bio,
      avatar_object_key: null,
      social_links: {},
      preferred_locale: 'fr',
      status: 'ACTIVE',
      onboarding_step: 'ACTIVE_PUBLISHED',
      stripe_connect_account_id: null,
      payout_configured_at: null,
      total_clicks: SANDBOX_AFFILIATE_DEMO_FR_TOTAL_CLICKS,
      total_earned_cents: 0,
      total_paid_cents: 0,
    });
    expect(growthTier(state)['slug']).toBe(SANDBOX_AFFILIATE_DEMO_FR_TIER_SLUG);
    expect(growthTier(state)['member_count']).toBe(1);
    expect(foundingTier(state)['member_count']).toBe(1);
    // No ledger and no order of its own.
    expect(state.affiliate_commissions.some((row) => row['affiliate_id'] === profile['id'])).toBe(false);
    expect(state.affiliate_payouts.some((row) => row['affiliate_id'] === profile['id'])).toBe(false);
    expect(state.orders.some((row) => row['affiliate_id'] === profile['id'])).toBe(false);

    const page = frPage(state) as Row;
    expect(page).toMatchObject({
      user_id: user['id'],
      title: SANDBOX_AFFILIATE_DEMO_FR_COPY.title,
      meta_description: SANDBOX_AFFILIATE_DEMO_FR_COPY.metaDescription,
      published_title: SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedTitle,
      published_meta_description: SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedMetaDescription,
      approval_status: 'PENDING_REVIEW',
      admin_feedback_note: null,
      draft_version: SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION,
      submitted_version: SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION,
      reviewed_by: DEMO_ADMIN_ID,
      featured_product_ids: [PRODUCTS.pantsEn, PRODUCTS.teeEn],
      published_featured_product_ids: [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn],
      published_profile: buildSandboxAffiliateDemoFrPublishedProfile(),
    });
    expect(SANDBOX_AFFILIATE_DEMO_FR_DRAFT_PRODUCT_SKUS).toEqual(['NB-UTILITY-PANTS', 'NB-STUDIO-TEE']);
    // The live version is the published document; the review compares it with a different draft.
    const published = page['published_content'] as StorefrontDoc;
    const draft = page['draft_content'] as StorefrontDoc;
    expect(published).toEqual(buildSandboxAffiliateDemoFrDoc('published', [PRODUCTS.teeEn, PRODUCTS.capEn, PRODUCTS.pantsEn]));
    expect(draft).toEqual(buildSandboxAffiliateDemoFrDoc('draft', [PRODUCTS.pantsEn, PRODUCTS.teeEn]));
    expect(diffStorefrontBlocks(published, draft).statuses).toContain('changed');
    expect(collectStorefrontProductIds(draft)).toEqual(page['featured_product_ids']);
    expect(collectStorefrontProductIds(published)).toEqual(page['published_featured_product_ids']);
    // A coherent history: joined, submitted and approved the first time, edited, submitted again.
    const times = [
      profile['created_at'],
      profile['page_submitted_at'],
      profile['first_published_at'],
      page['draft_updated_at'],
      page['submitted_at'],
    ].map((value: Date) => value.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(page['reviewed_at']).toEqual(profile['first_published_at']);
    expect(page['published_at']).toEqual(profile['first_published_at']);
    expect(page['submitted_at'].getTime()).toBeGreaterThan(page['reviewed_at'].getTime());
    expect(page['submitted_at'].getTime()).toBeLessThan(NOW.getTime());
  });

  it("keeps Atelier Boréal's snapshot rules: the live page shows the approved profile, Approve the reviewed one", async () => {
    const state = freshSandbox();
    await seed(state);
    const profile = frProfile(state) as Row;
    const page = frPage(state) as Row;

    // The storefront renders the snapshot approved 16 days ago, never the live profile.
    const live = page['published_profile'] as AffiliatePublishedProfile;
    expect(live.bio).toBe(SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedBio);
    expect(live.locale).toBe('fr');
    // The review screen builds the proposed snapshot from the profile as it is now (the edited bio):
    // a profile change to review, and the fingerprint Approve is pinned to.
    const proposed = buildAffiliatePublishedProfile(profile as Parameters<typeof buildAffiliatePublishedProfile>[0]);
    expect(proposed).toEqual({ ...live, bio: SANDBOX_AFFILIATE_DEMO_FR_COPY.bio });
    expect(fingerprintAffiliatePublishedProfile(proposed)).not.toBe(fingerprintAffiliatePublishedProfile(live));
    // Every field but the bio is as approved, and approving publishes exactly the reviewed snapshot.
    expect({ ...proposed, bio: live.bio }).toEqual(live);
    expect(fingerprintAffiliatePublishedProfile(buildSandboxAffiliateDemoFrPublishedProfile())).toBe(
      fingerprintAffiliatePublishedProfile(live),
    );
  });

  it("writes Atelier Boréal's Activity feed alerts, already mailed", async () => {
    const state = freshSandbox();
    await seed(state);
    const profile = frProfile(state) as Row;
    const page = frPage(state) as Row;

    // After Studio Nova's payout-failed alert (written before the second partner).
    expect(state.system_alerts.map((row) => row['alert_type'])).toEqual([
      'affiliate_payout_failed',
      'affiliate_signed_up',
      'affiliate_page_submitted',
    ]);
    const atelier = state.system_alerts.filter((row) => row['metadata']['affiliate_id'] === profile['id']);
    expect(atelier.map((row) => row['alert_type'])).toEqual(['affiliate_signed_up', 'affiliate_page_submitted']);
    const [signedUp, submitted] = atelier as [Row, Row];
    expect(signedUp).toMatchObject({
      title: 'New partner signed up',
      message: 'Atelier Boréal joined the affiliate program on the Growth Partner tier.',
      is_resolved: false,
      created_at: profile['created_at'],
      metadata: {
        affiliate_id: profile['id'],
        action_url: '/cms/affiliates',
        action_label: 'View partners',
        handle: SANDBOX_AFFILIATE_DEMO_FR_HANDLE,
        display_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
        tier_name: 'Growth Partner',
        emailed_at: profile['created_at'].toISOString(),
      },
    });
    expect(submitted).toMatchObject({
      title: 'Storefront waiting for review',
      message: 'Atelier Boréal submitted their storefront for approval.',
      is_resolved: false,
      created_at: page['submitted_at'],
      metadata: {
        affiliate_id: profile['id'],
        page_id: page['id'],
        action_url: '/cms/affiliates/approvals',
        action_label: 'Review storefronts',
        emailed_at: page['submitted_at'].toISOString(),
      },
    });
    expect(submitted['metadata']).not.toHaveProperty('tier_name');
  });

  it('seeds Studio Nova alone when the second account cannot be created', async () => {
    const state = freshSandbox();

    const { result } = await seed(state, {
      createError: { message: 'Email address is invalid' },
      createErrorFor: SANDBOX_AFFILIATE_DEMO_FR_EMAIL,
    });

    expect(result).toEqual({ handle: SANDBOX_AFFILIATE_DEMO_HANDLE, seeded: true });
    expect(frUser(state)).toBeUndefined();
    expect(frProfile(state)).toBeUndefined();
    expect(state.affiliate_pages).toHaveLength(1);
    // Only Studio Nova's payout-failed alert.
    expectOnlyStudioNovaAlerts(state);
    expect(partnerPage(state)['approval_status']).toBe('PUBLISHED');
    expect(orderById(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID)).toBeDefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[Sandbox Reset] Seeding Studio Nova without the second demo partner:',
      expect.stringContaining('Email address is invalid'),
    );
    expectLedgerConsistent(state);
  });

  it("still seeds Studio Nova when one of Atelier Boréal's own writes fails, rolling back only its rows", async () => {
    // Its alerts (the same statement text as Studio Nova's payout alert, so matched on the type),
    // and its review UPDATE (Studio Nova's publication copies the draft instead: no `= $1`).
    const atelierAlertInsert: FailOn = (text, params) =>
      /^INSERT INTO public\.system_alerts/.test(text) &&
      ['affiliate_signed_up', 'affiliate_page_submitted'].includes(String(params[0]));
    for (const failOn of [atelierAlertInsert, /^UPDATE public\.affiliate_pages SET published_content = \$1/]) {
      vi.mocked(console.warn).mockClear();
      const state = freshSandbox();

      const { result, db } = await seed(state, { failOn });

      expect(result).toEqual({ handle: SANDBOX_AFFILIATE_DEMO_HANDLE, seeded: true });
      // Back to the savepoint; the transaction itself committed.
      expect(db.statements).toContain('ROLLBACK TO SAVEPOINT');
      expect(db.statements).not.toContain('ROLLBACK');
      expect(db.statements).toContain('COMMIT');
      // Studio Nova: its partner role, profile, published page and whole ledger.
      expect(state.profiles.find((row) => row['id'] === partnerUser(state)?.['id'])?.['role']).toBe('RTL');
      expect(partnerProfile(state)).toMatchObject({
        status: 'ACTIVE',
        onboarding_step: 'ACTIVE_PUBLISHED',
        total_earned_cents: 10800,
        total_paid_cents: 1300,
      });
      expect(partnerPage(state)['approval_status']).toBe('PUBLISHED');
      expect(state.affiliate_commissions).toHaveLength(4);
      expect(state.affiliate_payouts.map((row) => row['status']).sort()).toEqual(['COMPLETED', 'FAILED']);
      expect(orderById(state, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID)).toBeDefined();
      expect(foundingTier(state)['member_count']).toBe(1);
      expectLedgerConsistent(state);
      // Atelier Boréal: no profile, page or alert, its seat free again, its account a plain customer.
      expect(frProfile(state)).toBeUndefined();
      expect(state.affiliate_pages).toHaveLength(1);
      expectOnlyStudioNovaAlerts(state);
      expect(growthTier(state)['member_count']).toBe(0);
      expect(state.profiles.find((row) => row['id'] === frUser(state)?.['id'])?.['role']).toBe('USER');
      expect(console.warn).toHaveBeenCalledWith(
        '[Sandbox Reset] Seeding Studio Nova without the second demo partner:',
        expect.stringContaining('injected failure'),
      );
    }
  });

  it('skips Atelier Boréal when its tier is missing, inactive or full', async () => {
    for (const change of [
      (tier: Row) => Object.assign(tier, { slug: 'renamed-tier' }),
      (tier: Row) => Object.assign(tier, { is_active: false }),
      (tier: Row) => Object.assign(tier, { max_ambassadors_cap: 3, member_count: 3 }),
    ]) {
      const state = freshSandbox();
      change(growthTier(state));

      const { result } = await seed(state);

      expect(result.seeded).toBe(true);
      expect(frProfile(state)).toBeUndefined();
      expectOnlyStudioNovaAlerts(state);
      // Its account stays a plain customer (the next reset deletes it).
      expect(state.profiles.find((row) => row['id'] === (frUser(state) as Row)['id'])?.['role']).toBe('USER');
      expectLedgerConsistent(state);
    }
  });

  it('keeps Atelier Boréal on a capped tier it already belongs to', async () => {
    const state = freshSandbox();
    await seed(state);
    Object.assign(growthTier(state), { max_ambassadors_cap: 1 });

    await seed(state);

    expect(frProfile(state)).toMatchObject({ tier_id: GROWTH_TIER_ID });
    expect(growthTier(state)['member_count']).toBe(1);
  });

  it("restores Atelier Boréal's review after an admin decided it between resets", async () => {
    for (const decision of ['approve', 'changes'] as const) {
      const state = freshSandbox();
      await seed(state);
      const page = frPage(state) as Row;
      const before = structuredClone(page);

      // The CMS: Approve publishes the draft (and resolves the submission alert); Request changes keeps the live version.
      if (decision === 'approve') {
        Object.assign(page, {
          published_content: page['draft_content'],
          published_title: page['title'],
          published_meta_description: page['meta_description'],
          published_featured_product_ids: page['featured_product_ids'],
          approval_status: 'PUBLISHED',
          reviewed_at: NOW,
          published_at: NOW,
        });
      } else {
        Object.assign(page, { approval_status: 'CHANGES_REQUESTED', admin_feedback_note: 'Ajoutez une photo.', reviewed_at: NOW });
      }
      for (const alert of state.system_alerts) Object.assign(alert, { is_resolved: true, resolved_at: NOW });

      const { result } = await seed(state);

      expect(result.seeded).toBe(true);
      expect(frPage(state)).toEqual({ ...before, updated_at: expect.any(Date) });
      // Every alert is back, unresolved (Studio Nova's payout-failed one included), and none doubled.
      expect(state.system_alerts.map((row) => [row['alert_type'], row['is_resolved']])).toEqual([
        ['affiliate_payout_failed', false],
        ['affiliate_signed_up', false],
        ['affiliate_page_submitted', false],
      ]);
    }
  });

  describe('failures return seeded: false and never throw', () => {
    it('skips without the Affiliates schema, before creating any account', async () => {
      const state = freshSandbox();
      state.schemaReady = false;

      const { result, auth, db } = await seed(state);

      expect(result).toEqual({ handle: SANDBOX_AFFILIATE_DEMO_HANDLE, seeded: false });
      expect(auth.createUser).not.toHaveBeenCalled();
      expect(db.statements).toHaveLength(1);
      expect(console.warn).toHaveBeenCalled();
    });

    it('skips before 02029 added the RTL role', async () => {
      const state = freshSandbox();
      state.roleReady = false;

      const { result, auth } = await seed(state);

      expect(result.seeded).toBe(false);
      expect(auth.createUser).not.toHaveBeenCalled();
    });

    it('skips while no ADMIN exists (the new account would become the first admin)', async () => {
      const state = freshSandbox();
      state.profiles = state.profiles.map((row) => ({ ...row, role: 'USER' }));

      const { result, auth } = await seed(state);

      expect(result.seeded).toBe(false);
      expect(auth.createUser).not.toHaveBeenCalled();
      expect(state.authUsers.some((row) => row['email'] === SANDBOX_AFFILIATE_DEMO_EMAIL)).toBe(false);
    });

    it('reports an auth admin failure', async () => {
      const state = freshSandbox();

      const { result, db } = await seed(state, { createError: { message: 'Database error creating new user' } });

      expect(result.seeded).toBe(false);
      expect(db.statements).not.toContain('BEGIN');
      expect(state.affiliate_profiles).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        '[Sandbox Reset] Failed to seed the demo partner storefront:',
        expect.stringContaining('Database error creating new user'),
      );
    });

    it('rolls the whole seed back when a write fails', async () => {
      const state = freshSandbox();
      const ordersBefore = structuredClone(state.orders);

      const { result, db } = await seed(state, { failOn: /^INSERT INTO public\.affiliate_commissions/ });

      expect(result.seeded).toBe(false);
      expect(db.statements).toContain('ROLLBACK');
      expect(state.affiliate_profiles).toEqual([]);
      expect(state.affiliate_pages).toEqual([]);
      expect(state.affiliate_payouts).toEqual([]);
      expect(state.affiliate_commissions).toEqual([]);
      expect(state.orders).toEqual(ordersBefore);
      expect(foundingTier(state)['member_count']).toBe(0);
      // The account outlives the rollback as a plain customer (the next reset deletes it).
      const user = partnerUser(state) as Row;
      expect(state.profiles.find((row) => row['id'] === user['id'])?.['role']).toBe('USER');
      expect(console.error).toHaveBeenCalledWith(
        '[Sandbox Reset] Failed to seed the demo partner storefront:',
        expect.stringContaining('injected failure'),
      );
    });

    it("rolls everything back when a write of Studio Nova's orders or FAILED payout fails (its totals depend on them)", async () => {
      const payoutAlertInsert: FailOn = (text, params) =>
        /^INSERT INTO public\.system_alerts/.test(text) && params[0] === 'affiliate_payout_failed';
      for (const failOn of [
        /^INSERT INTO public\.order_items/,
        /^INSERT INTO public\.affiliate_payouts .*'FAILED'/,
        // The FAILED payout's alert is written with it, outside the second partner's savepoint.
        payoutAlertInsert,
      ]) {
        const state = freshSandbox();
        const ordersBefore = structuredClone(state.orders);

        const { result, db } = await seed(state, { failOn });

        expect(result.seeded).toBe(false);
        expect(db.statements).toContain('ROLLBACK');
        expect(state.affiliate_profiles).toEqual([]);
        expect(state.affiliate_pages).toEqual([]);
        expect(state.affiliate_payouts).toEqual([]);
        expect(state.affiliate_commissions).toEqual([]);
        expect(state.system_alerts).toEqual([]);
        expect(state.order_items).toEqual([]);
        expect(state.orders).toEqual(ordersBefore);
        expect(growthTier(state)['member_count']).toBe(0);
      }
    });

    it('survives a broken connection', async () => {
      const { result } = await seed(freshSandbox(), { throwOnEverything: true });
      expect(result).toEqual({ handle: SANDBOX_AFFILIATE_DEMO_HANDLE, seeded: false });
    });
  });
});

describe('reset route wiring', () => {
  const route = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');

  it('activates the package and seeds the demo partner after seedFakeStoreData, behind the sandbox key', () => {
    const fakeStore = route.indexOf('await seedFakeStoreData(db, supabaseAdmin, demoAdminId);');
    const guard = route.indexOf('const affiliatesSandboxKey = process.env.FREEMIUS_AFFILIATES_SANDBOX_KEY;');
    const activation = route.indexOf('await activateSandboxPackage(db, AFFILIATES_PACKAGE_ID, affiliatesSandboxKey, siteUrl);');
    const demo = route.indexOf('await seedSandboxAffiliateDemo(db, supabaseAdmin, { siteUrl });');
    // Both demo storefronts: each partner's /partners/<handle> page is cached.
    const eviction = route.indexOf(
      "evictAffiliateStorefrontCache([SANDBOX_AFFILIATE_DEMO_HANDLE, SANDBOX_AFFILIATE_DEMO_FR_HANDLE], 'route');",
    );
    const tiers = route.indexOf("evictAffiliateTiersCache('route');");
    const end = route.indexOf('await db.end();');

    expect(fakeStore).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(fakeStore);
    expect(activation).toBeGreaterThan(guard);
    expect(demo).toBeGreaterThan(activation);
    expect(eviction).toBeGreaterThan(demo);
    expect(tiers).toBeGreaterThan(demo);
    expect(end).toBeGreaterThan(tiers);
    expect(route.match(/seedSandboxAffiliateDemo\(/g)).toHaveLength(1);
  });

  it('seeds the apparel SKUs the storefront looks up', () => {
    for (const sku of SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS) {
      expect(route).toContain(`baseSku: '${sku}'`);
    }
  });

  it('seeds the variants the seed-owned orders are made of (`<sku>-S|M|L`)', () => {
    expect(route).toContain("{ slug: 'medium', skuSuffix: 'M' }");
    expect(route).toMatch(/\$\{params\.baseSku\}-\$\{variant\.skuSuffix\}/);
    for (const { sku } of [...SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES, ...SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES]) {
      const base = sku.replace(/-[SML]$/, '');
      expect(SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS as readonly string[]).toContain(base);
      expect(route).toContain(`baseSku: '${base}'`);
    }
  });

  it("buys the seed's orders as the demo admin restoreDemoAdmin restores", () => {
    expect(route).toContain(`const DEMO_ADMIN_EMAIL = '${SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL}';`);
    expect(route).toContain("user_metadata: { full_name: 'Nextblock CMS' }");
  });

  it('matches the credentials the sign-in alert publishes', () => {
    const alert = readFileSync(path.join(REPO_ROOT, 'apps/nextblock/components/SandboxCredentialsAlert.tsx'), 'utf8');
    expect(alert).toContain(`'${SANDBOX_AFFILIATE_DEMO_EMAIL}'`);
    expect(alert).toContain(`'/partners/${SANDBOX_AFFILIATE_DEMO_HANDLE}'`);
    expect(SANDBOX_AFFILIATE_DEMO_PASSWORD).toBe('password');
    expect(alert).toContain('>password</span>');
  });
});
