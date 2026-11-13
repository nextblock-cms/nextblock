import 'server-only';

import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PARTNERS_PATH_FR,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  collectStorefrontProductIds,
  computeAffiliateCommissionMinor,
  convertAffiliateAmountToBaseMinor,
  formatAffiliateMoney,
  isStorefrontDocEmpty,
  normalizeAffiliateEmail,
  normalizeStorefrontSiteOrigin,
  sanitizeAffiliateSocialLinks,
  sanitizeStorefrontDoc,
  type AffiliateAdminLifecycleEvent,
  type AffiliateEmailData,
  type AffiliateGateway,
  type AffiliatePublishedProfile,
  type StorefrontBlockNode,
  type StorefrontDoc,
  type StorefrontListItemNode,
  type StorefrontProductGridColumns,
} from '@nextblock-cms/affiliates';
import { buildAffiliateSystemAlert } from '@nextblock-cms/affiliates/server';

/**
 * The public sandbox's demo partners. The reset cron calls this right after seedFakeStoreData(),
 * and only when FREEMIUS_AFFILIATES_SANDBOX_KEY activated the Affiliates package.
 *
 * - "Studio Nova", a Founding Ambassador with a published English storefront at
 *   /partners/studio-nova, signed in with partner@nextblock.dev / password (listed on /sign-in). Its
 *   ledger: one PAID commission on a COMPLETED payout, one CLEARED, one PENDING_CLEARANCE, one
 *   CLEARED commission held by a FAILED payout (Retry and Release show on /cms/affiliates/payouts)
 *   with the payout-failed alert the payout runner raised when its automatic retries ran out, and
 *   one unpaid (pending) order credited to it, which the demo admin can mark paid in /cms/orders to
 *   watch the order trigger record a commission.
 * - "Atelier Boréal", a French partner on the Growth tier with a published French storefront at
 *   /partners/atelier-boreal and an edited draft waiting for review (/cms/affiliates/approvals), plus
 *   its SIGNED_UP and PAGE_SUBMITTED alerts for the Activity feed. Its login is never advertised:
 *   a reserved @example.com address (usableEmail() never mails it) with a random password each run,
 *   so nobody can sign in as it. It is optional: without its account or tier, Studio Nova is
 *   seeded alone, and a failure in its own writes rolls back only its rows (a savepoint).
 *
 * - It runs after the reset transaction committed, in a transaction of its own. Migration 02029
 *   adds 'RTL' to public.user_role inside the reset's single transaction, and Postgres refuses a
 *   new enum label until the transaction that added it has committed.
 * - Neither partner is one of Step A's preserved users (tools/scripts/generate-sandbox-reset.ts):
 *   every reset deletes the accounts and everything they own, and this step recreates them.
 * - Idempotent: a second run converges on the same rows. The accounts, profiles and pages are
 *   upserted, the demo ledger, the seed's own orders and the alerts are replaced, and the pages
 *   are re-published at the versions below.
 * - Non-fatal: any failure is logged and returned as `{ seeded: false }`. Studio Nova's writes are
 *   all or nothing (its totals depend on every row), so the transaction rolls back and no partner
 *   is ever half seeded (at worst a plain customer account is left over, which the next reset
 *   deletes). A failure in Atelier Boréal's own writes rolls back only its rows and is logged as a
 *   warning: Studio Nova is still seeded.
 * - The ledger is written directly. The orders trigger only records a commission when `paid_at`
 *   goes from NULL to a value, and seedFakeStoreData inserts its orders already paid. The orders
 *   the commissions point at are back-dated to the commissions' dates in the statement that
 *   attributes them: one non-null `paid_at` to another, which fires the trigger but takes neither
 *   of its branches (it records only from NULL, and voids only on a status change to refunded or
 *   cancelled).
 *   Amounts use the lib's money helpers with the SQL's formula (store base currency, net of
 *   discounts, before tax and shipping, the tier rate). The profile totals match the rows, and every
 *   row is marked notified so no commission sweep or alert mailer ever emails anyone.
 * - Every demo order, commission and payout carries the same key mode. Checkout is refused on the
 *   sandbox (`/api/checkout` answers 403 there), so no real attributed order exists. The seed uses
 *   live mode, which is also how the SQL treats a sale whose key mode checkout could not tell
 *   (`orders.affiliate_livemode` NULL).
 * - Stripe Connect stays unconfigured (Connect and payouts are disabled in the sandbox). The
 *   COMPLETED and FAILED payouts carry a placeholder destination, the COMPLETED one a placeholder
 *   transfer id.
 * - Of the auth users and profiles, only the partners' own are written. The demo admin (a preserved
 *   user) is only read there: it is the buyer of the attributed orders (seedFakeStoreData's, which
 *   this step attributes and back-dates, and the two it adds in the admin's name) and the reviewer
 *   of the pages.
 */

type SqlClient = postgres.Sql<Record<string, unknown>>;

export const SANDBOX_AFFILIATE_DEMO_EMAIL = 'partner@nextblock.dev';
export const SANDBOX_AFFILIATE_DEMO_PASSWORD = 'password';
export const SANDBOX_AFFILIATE_DEMO_HANDLE = 'studio-nova';
export const SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME = 'Studio Nova';
export const SANDBOX_AFFILIATE_DEMO_TIER_SLUG = 'founding-ambassador';
/** Bundled with the app (public/images, BUNDLED_PUBLIC_MEDIA_KEYS): the reset wipes the bucket. */
export const SANDBOX_AFFILIATE_DEMO_AVATAR_KEY = 'images/affiliate-demo-avatar.png';
/** seedFakeStoreData's demo admin: the buyer of every order the demo partner earned on. */
export const SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL = 'demo@nextblock.dev';
/** The name seedFakeStoreData puts on the demo admin's orders. */
export const SANDBOX_AFFILIATE_DEMO_BUYER_NAME = 'Nextblock CMS';
/** The apparel catalog the reset seeds (route.ts APPAREL_PRODUCT_SEEDS), in storefront order. */
export const SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS = ['NB-STUDIO-TEE', 'NB-SIGNAL-CAP', 'NB-UTILITY-PANTS'] as const;
export const SANDBOX_AFFILIATE_DEMO_TRANSFER_ID = 'tr_sandbox_demo_1';
export const SANDBOX_AFFILIATE_DEMO_DESTINATION = 'acct_sandboxdemo';
export const SANDBOX_AFFILIATE_DEMO_TOTAL_CLICKS = 312;
/**
 * The key mode of every demo sale, commission and payout. Checkout is refused on the sandbox
 * (`/api/checkout` answers 403 there), so no real attributed order exists. The seed uses live mode,
 * which is also how the SQL treats a sale whose key mode checkout could not tell
 * (`affiliate_livemode` NULL).
 */
export const SANDBOX_AFFILIATE_DEMO_LIVEMODE = true;

/**
 * The FAILED payout's reason: a Stripe refusal the payouts screen explains ("The Stripe balance
 * was too low.") and not a closed reason (released, nothing_to_pay, below_minimum), so Retry and
 * Release show. In the sandbox both answer `sandbox` and send nothing.
 */
export const SANDBOX_AFFILIATE_DEMO_FAILURE_REASON = 'balance_insufficient';
/** How lib/affiliates/payout-runner.ts `describeFailure` words that reason in the payout-failed alert. */
export const SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION =
  'The Stripe balance could not cover the transfer (balance_insufficient).';

/**
 * The two orders this step owns, under fixed ids: every reset recreates the schema, and a re-run
 * deletes and rewrites them. One older sale whose commission the FAILED payout holds, and one
 * storefront sale still waiting for its payment.
 */
export const SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID = 'e2b7d9c4-1a6f-4d3b-8e52-7f9a0c4b6d38';
export const SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID = 'c6f1a3d2-8b4e-4f7a-9c21-5e0d7b3a9f14';
/** Their lines: variants of the seeded apparel (route.ts upsertSeededCatalogProduct: `<sku>-S|M|L`). */
export const SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES = [
  { sku: 'NB-STUDIO-TEE-M', quantity: 1 },
  { sku: 'NB-SIGNAL-CAP-M', quantity: 1 },
] as const;
export const SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES = [{ sku: 'NB-UTILITY-PANTS-M', quantity: 1 }] as const;

export const SANDBOX_AFFILIATE_DEMO_COPY = {
  bio: 'Studio Nova is a two-person design studio in Montréal. We build fast, accessible NextBlock storefronts for independent brands, and we share the gear we actually use on long build days.',
  title: "Studio Nova's build-day essentials",
  metaDescription:
    "Shop Studio Nova's build-day essentials: the NextBlock apparel a small design studio wears while launching fast, accessible storefronts.",
  website: 'https://nextblock.dev',
} as const;

/** The second demo partner (French, Growth tier). Its address is reserved and its password random. */
export const SANDBOX_AFFILIATE_DEMO_FR_EMAIL = 'atelier-boreal@example.com';
export const SANDBOX_AFFILIATE_DEMO_FR_HANDLE = 'atelier-boreal';
export const SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME = 'Atelier Boréal';
export const SANDBOX_AFFILIATE_DEMO_FR_TIER_SLUG = 'growth-partner';
export const SANDBOX_AFFILIATE_DEMO_FR_TOTAL_CLICKS = 57;
/** The edit waiting for review; the live version was approved at draft_version 1. */
export const SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION = 2;
/** The edited draft's grid: the pants first, the cap dropped (the review lists it as removed). */
export const SANDBOX_AFFILIATE_DEMO_FR_DRAFT_PRODUCT_SKUS = ['NB-UTILITY-PANTS', 'NB-STUDIO-TEE'] as const;

/**
 * The second partner's copy (Québec French: no space before ! and ?, no colon or percent sign, so
 * no no-break space is needed). `publishedBio` is the bio the live snapshot was approved with;
 * `bio` is the profile now, edited before the submission, so the review shows a profile change.
 */
export const SANDBOX_AFFILIATE_DEMO_FR_COPY = {
  publishedBio:
    "Atelier Boréal est un petit studio de design de Québec. Nous créons des boutiques NextBlock bilingues pour les marques d'ici, et nous partageons les vêtements qui nous suivent de l'atelier jusqu'aux lancements.",
  bio: "Atelier Boréal est un petit studio de design de Québec. Nous créons des boutiques NextBlock bilingues et accessibles pour les marques d'ici, du premier croquis jusqu'au lancement, et nous partageons les vêtements qui nous accompagnent pendant les longues journées d'atelier.",
  publishedTitle: "Les essentiels d'Atelier Boréal",
  publishedMetaDescription:
    "Magasinez les essentiels d'Atelier Boréal, les vêtements NextBlock que porte un petit studio de Québec pour lancer des boutiques bilingues.",
  title: "Les essentiels d'automne d'Atelier Boréal",
  metaDescription:
    "Découvrez les essentiels d'automne d'Atelier Boréal, les vêtements NextBlock que porte un petit studio de Québec pour lancer des boutiques bilingues.",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Orders read when looking for the 3 the ledger needs (some may not earn anything). */
const MAX_CANDIDATE_ORDERS = 10;
/** `STOREFRONT_LIMITS.maxProductsPerGrid`. */
const MAX_PRODUCTS_PER_GRID = 12;
/** A demo order is created this long before it is paid (the checkout). */
const DEMO_CHECKOUT_MINUTES = 3;

/**
 * The partner's history, before now, read like a real partner's first two months: signed up and
 * approved about two months ago, the current version of the page approved yesterday.
 */
const DEMO_TIMELINE = {
  joinedDaysAgo: 60,
  firstSubmittedDaysAgo: 59,
  firstApprovedDaysAgo: 58,
  lastEditedHoursAgo: 27,
  lastSubmittedHoursAgo: 26,
  lastApprovedHoursAgo: 20,
  lastClickHoursAgo: 2,
} as const;

/**
 * The failed payout's story, between the ledger's PAID (44 days) and CLEARED (33 days) sales: a
 * sale 38 days ago cleared 8 days ago; the next run claimed it and Stripe refused the transfer
 * (balance too low); the next four daily cycles retried it and failed too, and automatic retries
 * stop after 5 attempts, so Retry and Release are the admin's. The balance has been short since,
 * so no run claimed the commission that cleared 3 days ago (claims need the balance).
 *
 * `balance_insufficient` is transient: a cycle retries a FAILED payout once its last attempt is
 * 12 hours old, until `attempt_count` reaches `AFFILIATE_PAYOUT_MAX_ATTEMPTS` (5). The attempts
 * were 168, 150, 126, 102 and 78 hours ago; the last one raised the payout-failed alert.
 */
const DEMO_FAILED_PAYOUT_TIMELINE = {
  earnedDaysAgo: 38,
  /** The founding tier's 30-day hold. */
  clearsInDays: -8,
  firstAttemptDaysAgo: 7,
  lastAttemptHoursAgo: 78,
  attempts: 5,
} as const;

/** The unpaid storefront sale: a checkout that has not been paid yet. */
const DEMO_PENDING_ORDER_MINUTES_AGO = 25;

/** The second partner: joined and approved over two weeks ago, the edited draft submitted today. */
const DEMO_FR_TIMELINE = {
  joinedDaysAgo: 18,
  firstSubmittedDaysAgo: 17,
  firstApprovedDaysAgo: 16,
  lastEditedHoursAgo: 5,
  lastSubmittedHoursAgo: 4,
  lastClickHoursAgo: 3,
} as const;

export type SandboxAffiliateDemoCommissionStatus = 'PAID' | 'CLEARED' | 'PENDING_CLEARANCE';

type SandboxAffiliateDemoSource = 'storefront' | 'referral_link';

interface DemoLedgerSlot {
  status: SandboxAffiliateDemoCommissionStatus;
  source: SandboxAffiliateDemoSource;
  earnedDaysAgo: number;
  /** Days from now to `clears_at`; negative once the 30-day hold is over. */
  clearsInDays: number;
  /** PAID only: when the payout went out. */
  paidDaysAgo: number | null;
}

/**
 * Filled in this order when fewer orders qualify, then placed on the orders oldest first. The
 * dates assume the founding tier's 30-day hold (clears_at = earned + 30 days).
 */
const DEMO_LEDGER_SLOTS: readonly DemoLedgerSlot[] = [
  { status: 'PAID', source: 'referral_link', earnedDaysAgo: 44, clearsInDays: -14, paidDaysAgo: 13 },
  { status: 'PENDING_CLEARANCE', source: 'storefront', earnedDaysAgo: 10, clearsInDays: 20, paidDaysAgo: null },
  { status: 'CLEARED', source: 'storefront', earnedDaysAgo: 33, clearsInDays: -3, paidDaysAgo: null },
];

/** The part of the service-role Supabase client this step uses (auth admin only). */
export interface SandboxAffiliateDemoAuthAdmin {
  auth: {
    admin: {
      createUser(attributes: {
        email: string;
        password: string;
        email_confirm: boolean;
        user_metadata: Record<string, unknown>;
      }): Promise<{ data?: { user?: { id?: string | null } | null } | null; error?: unknown }>;
      updateUserById(
        uid: string,
        attributes: { password: string; email_confirm: boolean; user_metadata: Record<string, unknown> },
      ): Promise<{ data?: unknown; error?: unknown }>;
    };
  };
}

export interface SeedSandboxAffiliateDemoOptions {
  /** The sandbox origin (route.ts `siteUrl`): the sanitizer's site origin and the log line. */
  siteUrl: string;
  /** Clock for the demo timeline (tests). */
  now?: Date;
}

export interface SeedSandboxAffiliateDemoResult {
  handle: string;
  seeded: boolean;
}

/** An `orders` row as the candidate query returns it (numerics may arrive as strings). */
export interface SandboxAffiliateDemoOrder {
  id: string;
  total: unknown;
  subtotal: unknown;
  discount_total: unknown;
  currency: unknown;
  exchange_rate_at_purchase: unknown;
  provider: unknown;
  buyer_email?: unknown;
}

export interface SandboxAffiliateDemoCommission {
  orderId: string;
  status: SandboxAffiliateDemoCommissionStatus;
  source: SandboxAffiliateDemoSource;
  gateway: AffiliateGateway;
  orderCurrency: string;
  orderNetMinor: number;
  exchangeRateSnapshot: number;
  netBaseMinor: number;
  ratePercent: number;
  commissionMinor: number;
  createdAt: Date;
  clearsAt: Date;
  clearedAt: Date | null;
  paidAt: Date | null;
}

export interface SandboxAffiliateDemoLedger {
  /** Store base currency: every amount below is in its minor units. */
  currency: string;
  /** Oldest first. */
  commissions: SandboxAffiliateDemoCommission[];
  /** The COMPLETED payout of the PAID commissions, when there is one. */
  payout: { amountMinor: number; createdAt: Date; paidAt: Date } | null;
  /** SUM(commission - refunded) of the non-voided commissions (nothing is refunded here). */
  totalEarnedMinor: number;
  /** SUM(amount) of the COMPLETED payouts. */
  totalPaidMinor: number;
}

/** A product variant as the order-line query returns it. */
export interface SandboxAffiliateDemoVariantRow {
  variant_id: unknown;
  sku: unknown;
  variant_price: unknown;
  product_id: unknown;
  product_price: unknown;
}

/** One `order_items` row of a demo order. */
export interface SandboxAffiliateDemoOrderLine {
  productId: string;
  variantId: string;
  sku: string;
  quantity: number;
  unitPriceMinor: number;
}

/** The FAILED payout and the CLEARED commission it holds. */
export interface SandboxAffiliateDemoFailedPayout {
  commission: SandboxAffiliateDemoCommission;
  payout: {
    amountMinor: number;
    createdAt: Date;
    lastAttemptAt: Date;
    attemptCount: number;
    failureReason: string;
  };
}

/** A `system_alerts` row for a demo partner (the notifier's shape, already mailed). */
export interface SandboxAffiliateDemoAlert {
  alert_type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function readCurrency(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function shiftDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE_MS);
}

/** When the checkout of an order paid at `paidAt` was created. */
function checkoutStartedAt(paidAt: Date): Date {
  return minutesAgo(paidAt, DEMO_CHECKOUT_MINUTES);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code ? `${error.message} (${code})` : error.message;
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** postgres.js types `json()` for index-signature objects; the storefront types are interfaces. */
function json(sql: SqlClient, value: unknown) {
  return sql.json(value as postgres.JSONValue);
}

function listItem(text: string): StorefrontListItemNode {
  return { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function gridColumns(ids: readonly string[]): StorefrontProductGridColumns {
  return ids.length >= 3 ? 3 : 2;
}

function uniqueGridIds(productIds: readonly string[]): string[] {
  return [...new Set(productIds)].slice(0, MAX_PRODUCTS_PER_GRID);
}

/**
 * The demo storefront (English, the partner's locale): a heading, an intro that discloses the
 * commission and links to the partner program, a tip, the studio's picks and a closing line.
 * Without products (the commerce catalog was not seeded) there is no grid and no picks section.
 */
export function buildSandboxAffiliateDemoDoc(productIds: readonly string[]): StorefrontDoc {
  const ids = uniqueGridIds(productIds);
  const columns = gridColumns(ids);

  const content: StorefrontBlockNode[] = [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Build-day essentials from Studio Nova' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: "Hi, we're Studio Nova, a two-person design studio that launches fast, accessible storefronts on NextBlock. These are the pieces we actually wear through long build days and late launches. When you shop through this page, we earn a commission at no extra cost to you. Want a storefront like this one? ",
        },
        {
          type: 'text',
          text: 'Join the partner program',
          marks: [{ type: 'link', attrs: { href: AFFILIATE_PARTNERS_PATH } }],
        },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'storefrontCallout',
      attrs: { tone: 'tip' },
      content: [
        { type: 'text', text: 'Tip: ', marks: [{ type: 'bold' }] },
        {
          type: 'text',
          text: 'bookmark this page. We update our picks whenever a new piece earns a permanent spot in the studio.',
        },
      ],
    },
  ];

  if (ids.length > 0) {
    content.push(
      {
        type: 'affiliateProductGrid',
        attrs: { productIds: ids, title: 'Our studio kit', columns },
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: 'Why we picked them' }],
      },
      {
        type: 'bulletList',
        content: [
          listItem('Heavyweight basics that hold up through a week of late deploys.'),
          listItem('Clean, quiet designs that still look sharp on a client call.'),
          listItem('Comfortable enough for a full day at the keyboard.'),
        ],
      },
    );
  }

  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: 'Thanks for supporting independent studios, and happy building!' }],
  });

  return { type: 'doc', content };
}

/** The approval snapshot the public page renders (the shape review.ts buildAffiliatePublishedProfile stores). */
export function buildSandboxAffiliateDemoPublishedProfile(): AffiliatePublishedProfile {
  return {
    display_name: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
    bio: SANDBOX_AFFILIATE_DEMO_COPY.bio,
    avatar_object_key: SANDBOX_AFFILIATE_DEMO_AVATAR_KEY,
    social_links: sanitizeAffiliateSocialLinks({ website: SANDBOX_AFFILIATE_DEMO_COPY.website }),
    // The demo copy is English and the partner's preferred_locale is 'en' (seeded below).
    locale: 'en',
  };
}

const FR_INTRO: StorefrontBlockNode = {
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text: "Bonjour! Nous sommes Atelier Boréal, un petit studio de Québec qui lance des boutiques NextBlock bilingues et accessibles. Voici les vêtements que nous portons du premier croquis jusqu'à la mise en ligne. Quand vous magasinez à partir de cette page, nous recevons une commission, sans frais supplémentaires pour vous. Envie d'une vitrine comme celle-ci? ",
    },
    {
      type: 'text',
      text: 'Joignez-vous au programme de partenaires',
      marks: [{ type: 'link', attrs: { href: AFFILIATE_PARTNERS_PATH_FR } }],
    },
    { type: 'text', text: '.' },
  ],
};

const FR_CLOSING: StorefrontBlockNode = {
  type: 'paragraph',
  content: [{ type: 'text', text: "Merci d'encourager les studios d'ici, et bon magasinage!" }],
};

/**
 * The second partner's storefront (French, its locale), in two versions:
 * - `published`: the version approved 16 days ago, live at /partners/atelier-boreal: a heading, an
 *   intro that discloses the commission and links to /partenaires, the apparel grid, a closing line.
 * - `draft`: the edit waiting for review: a new heading, the same intro, a smaller grid (the
 *   `SANDBOX_AFFILIATE_DEMO_FR_DRAFT_PRODUCT_SKUS`), a new tip, a new picks section, the same
 *   closing line, so the side-by-side review highlights changed and added blocks.
 * Without products there is no grid and no picks section in either version.
 */
export function buildSandboxAffiliateDemoFrDoc(version: 'published' | 'draft', productIds: readonly string[]): StorefrontDoc {
  const ids = uniqueGridIds(productIds);
  const columns = gridColumns(ids);

  if (version === 'published') {
    const content: StorefrontBlockNode[] = [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: "Nos essentiels d'atelier" }] },
      FR_INTRO,
    ];
    if (ids.length > 0) {
      content.push({ type: 'affiliateProductGrid', attrs: { productIds: ids, title: "Notre trousse d'atelier", columns } });
    }
    content.push(FR_CLOSING);
    const published: StorefrontDoc = { type: 'doc', content };
    // Both versions share the intro and closing nodes: hand out copies.
    return structuredClone(published);
  }

  const content: StorefrontBlockNode[] = [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: "Nos essentiels d'atelier pour l'automne" }],
    },
    FR_INTRO,
  ];
  if (ids.length > 0) {
    content.push({ type: 'affiliateProductGrid', attrs: { productIds: ids, title: "Notre trousse d'automne", columns } });
  }
  content.push({
    type: 'storefrontCallout',
    attrs: { tone: 'tip' },
    content: [
      { type: 'text', text: 'Ajoutez cette page à vos favoris.', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' Nous renouvelons notre sélection à chaque saison.' },
    ],
  });
  if (ids.length > 0) {
    content.push(
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Pourquoi nous les aimons' }] },
      {
        type: 'bulletList',
        content: [
          listItem('Des matières robustes qui tiennent le coup pendant les semaines de lancement.'),
          listItem("Des coupes sobres qui restent impeccables lors d'un appel avec un client."),
          listItem('Assez confortables pour une longue journée au clavier.'),
        ],
      },
    );
  }
  content.push(FR_CLOSING);
  const draft: StorefrontDoc = { type: 'doc', content };
  return structuredClone(draft);
}

/**
 * The second partner's live snapshot: its profile as it was at the first approval (the bio it had
 * then), in the shape and normalization review.ts buildAffiliatePublishedProfile stores. Its profile
 * now carries the edited bio (`SANDBOX_AFFILIATE_DEMO_FR_COPY.bio`): the storefront keeps showing
 * this snapshot until an admin approves the submission, which publishes the snapshot of the profile
 * the review screen showed (its fingerprint).
 */
export function buildSandboxAffiliateDemoFrPublishedProfile(): AffiliatePublishedProfile {
  return {
    display_name: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
    bio: SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedBio,
    avatar_object_key: null,
    social_links: sanitizeAffiliateSocialLinks({}),
    locale: 'fr',
  };
}

/**
 * The second partner's Activity feed rows, built like lib/affiliates/notify.ts builds them: the
 * lib's `buildAffiliateSystemAlert` (English, the CMS's language) for the event, its metadata plus
 * the ids the notifier adds (the partner, and the page for a submission), and `emailed_at`, the
 * notifier's "already mailed" marker (nothing goes out: the sandbox mails nobody anyway). SIGNED_UP
 * names the partner's tier; Growth has no cap, so there is no spots count (the signup RPC returns
 * none for an uncapped tier). PAGE_SUBMITTED links the review (`page_id`) and stays unresolved, so
 * the banner and the approvals queue show it until an admin decides.
 */
export function buildSandboxAffiliateDemoFrAlerts(input: {
  affiliateId: string;
  pageId: string;
  tierName: string | null;
  siteUrl: string;
  signedUpAt: Date;
  submittedAt: Date;
}): SandboxAffiliateDemoAlert[] {
  const events: Array<{ event: AffiliateAdminLifecycleEvent; at: Date; cmsPath: string; ids: Record<string, string> }> = [
    {
      event: 'SIGNED_UP',
      at: input.signedUpAt,
      cmsPath: AFFILIATE_CMS_PATH,
      ids: { affiliate_id: input.affiliateId },
    },
    {
      event: 'PAGE_SUBMITTED',
      at: input.submittedAt,
      cmsPath: AFFILIATE_CMS_APPROVALS_PATH,
      ids: { affiliate_id: input.affiliateId, page_id: input.pageId },
    },
  ];

  return events.map(({ event, at, cmsPath, ids }) => {
    const data: AffiliateEmailData = {
      locale: 'en',
      siteName: 'NextBlock',
      siteUrl: input.siteUrl,
      recipientName: null,
      handle: SANDBOX_AFFILIATE_DEMO_FR_HANDLE,
      displayName: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
      // Admin alerts never carry a storefront link.
      storefrontUrl: null,
      portalUrl: `${input.siteUrl}${AFFILIATE_PORTAL_PATH}`,
      cmsUrl: `${input.siteUrl}${cmsPath}`,
      tierName: event === 'SIGNED_UP' ? input.tierName : null,
      spotsRemaining: null,
    };
    const built = buildAffiliateSystemAlert(event, data);
    return {
      alert_type: built.alert_type,
      title: built.title,
      message: built.message,
      metadata: { ...built.metadata, ...ids, emailed_at: at.toISOString() },
      createdAt: at,
    };
  });
}

/**
 * Studio Nova's alert for the FAILED payout, the one lib/affiliates/payout-runner.ts raises when a
 * transient failure exhausts the automatic retries (`onPayoutFailed` → `notifyAffiliateLifecycle`):
 * built like lib/affiliates/notify.ts builds it, with the lib's `buildAffiliateSystemAlert`
 * (English) and the email data the notifier passes for PAYOUT_FAILED (the amount, the reason
 * payout-runner.ts describes, the payouts screens), its metadata plus the ids the notifier adds
 * (the partner, and the payout it deduplicates on), and `emailed_at`. Unresolved, and a CMS
 * banner type (`AFFILIATE_BANNER_ALERT_TYPES`), so the banner links /cms/affiliates/payouts until
 * an admin resolves it.
 */
export function buildSandboxAffiliateDemoPayoutFailedAlert(input: {
  affiliateId: string;
  payoutId: string;
  amountMinor: number;
  currency: string;
  siteUrl: string;
  failedAt: Date;
}): SandboxAffiliateDemoAlert {
  const data: AffiliateEmailData = {
    locale: 'en',
    siteName: 'NextBlock',
    siteUrl: input.siteUrl,
    recipientName: null,
    handle: SANDBOX_AFFILIATE_DEMO_HANDLE,
    displayName: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
    // Admin alerts never carry a storefront link.
    storefrontUrl: null,
    portalUrl: `${input.siteUrl}${AFFILIATE_PORTAL_PAYOUTS_PATH}`,
    cmsUrl: `${input.siteUrl}${AFFILIATE_CMS_PAYOUTS_PATH}`,
    tierName: null,
    spotsRemaining: null,
    amountLabel: formatAffiliateMoney(input.amountMinor, input.currency, 'en'),
    reason: SANDBOX_AFFILIATE_DEMO_FAILURE_DESCRIPTION,
  };
  const built = buildAffiliateSystemAlert('PAYOUT_FAILED', data);
  return {
    alert_type: built.alert_type,
    title: built.title,
    message: built.message,
    metadata: {
      ...built.metadata,
      affiliate_id: input.affiliateId,
      payout_id: input.payoutId,
      emailed_at: input.failedAt.toISOString(),
    },
    createdAt: input.failedAt,
  };
}

type PricedDemoOrder = Omit<
  SandboxAffiliateDemoCommission,
  'status' | 'source' | 'createdAt' | 'clearsAt' | 'clearedAt' | 'paidAt'
>;

/** `private.affiliate_record_commission`'s arithmetic for one order, or null when it earns nothing. */
function priceDemoOrder(order: SandboxAffiliateDemoOrder, baseCurrency: string, ratePercent: number): PricedDemoOrder | null {
  const orderId = readString(order.id);
  if (!orderId) return null;

  const orderCurrency = readCurrency(order.currency) ?? baseCurrency;
  const gross = readInteger(order.subtotal) ?? readInteger(order.total);
  if (gross === null) return null;
  const orderNetMinor = Math.max(gross - (readInteger(order.discount_total) ?? 0), 0);

  const sameCurrency = orderCurrency === baseCurrency;
  const exchangeRateSnapshot = sameCurrency ? 1 : Number(order.exchange_rate_at_purchase);
  if (!Number.isFinite(exchangeRateSnapshot) || exchangeRateSnapshot <= 0) return null;

  let netBaseMinor: number;
  try {
    netBaseMinor = convertAffiliateAmountToBaseMinor({
      amountMinor: orderNetMinor,
      fromCurrency: orderCurrency,
      toCurrency: baseCurrency,
      exchangeRate: exchangeRateSnapshot,
    });
  } catch {
    return null;
  }

  const commissionMinor = computeAffiliateCommissionMinor({ netMinor: netBaseMinor, ratePercent });
  if (commissionMinor <= 0) return null;

  return {
    orderId,
    gateway: readString(order.provider) === 'freemius' ? 'FREEMIUS' : 'STRIPE',
    orderCurrency,
    orderNetMinor,
    exchangeRateSnapshot,
    netBaseMinor,
    ratePercent,
    commissionMinor,
  };
}

function isPartnerPurchase(buyerEmail: unknown): boolean {
  const buyer = normalizeAffiliateEmail(buyerEmail);
  return buyer !== null && buyer === normalizeAffiliateEmail(SANDBOX_AFFILIATE_DEMO_EMAIL);
}

/**
 * The demo ledger for up to three paid orders (oldest first): one PAID commission on a
 * COMPLETED payout, one CLEARED, one PENDING_CLEARANCE that clears in 20 days. Orders that earn
 * nothing (free, fully discounted, no usable exchange rate) or that the partner bought are skipped.
 */
export function planSandboxAffiliateDemoLedger(input: {
  orders: readonly SandboxAffiliateDemoOrder[];
  ratePercent: number;
  baseCurrency: string | null;
  now: Date;
}): SandboxAffiliateDemoLedger {
  const currency = readCurrency(input.baseCurrency) ?? 'USD';
  const ratePercent = Number(input.ratePercent);

  const priced: PricedDemoOrder[] = [];
  for (const order of input.orders) {
    if (priced.length >= DEMO_LEDGER_SLOTS.length) break;
    if (isPartnerPurchase(order.buyer_email)) continue;
    const entry = priceDemoOrder(order, currency, ratePercent);
    if (entry && !priced.some((existing) => existing.orderId === entry.orderId)) priced.push(entry);
  }

  const slots = DEMO_LEDGER_SLOTS.slice(0, priced.length).sort((a, b) => b.earnedDaysAgo - a.earnedDaysAgo);
  const commissions: SandboxAffiliateDemoCommission[] = [];
  priced.forEach((entry, index) => {
    const slot = slots[index];
    if (!slot) return;
    const clearsAt = shiftDays(input.now, slot.clearsInDays);
    commissions.push({
      ...entry,
      status: slot.status,
      source: slot.source,
      createdAt: shiftDays(input.now, -slot.earnedDaysAgo),
      clearsAt,
      clearedAt: slot.status === 'PENDING_CLEARANCE' ? null : clearsAt,
      paidAt: slot.paidDaysAgo === null ? null : shiftDays(input.now, -slot.paidDaysAgo),
    });
  });

  const paid = commissions.filter((commission) => commission.status === 'PAID');
  const paidAt = paid[0]?.paidAt ?? null;
  const paidMinor = paid.reduce((sum, commission) => sum + commission.commissionMinor, 0);
  const payout = paidMinor > 0 && paidAt ? { amountMinor: paidMinor, createdAt: paidAt, paidAt } : null;

  return {
    currency,
    commissions,
    payout,
    totalEarnedMinor: commissions.reduce((sum, commission) => sum + commission.commissionMinor, 0),
    totalPaidMinor: payout ? payout.amountMinor : 0,
  };
}

/**
 * The `order_items` of a demo order: each wanted variant of the default-language apparel, at its
 * price (the product's when the variant has none). Lines whose variant is missing are left out.
 */
export function buildSandboxAffiliateDemoOrderLines(
  wanted: ReadonlyArray<{ sku: string; quantity: number }>,
  rows: readonly SandboxAffiliateDemoVariantRow[],
): SandboxAffiliateDemoOrderLine[] {
  const lines: SandboxAffiliateDemoOrderLine[] = [];
  for (const { sku, quantity } of wanted) {
    const row = rows.find((candidate) => readString(candidate.sku) === sku);
    const productId = readString(row?.product_id);
    const variantId = readString(row?.variant_id);
    if (!row || !productId || !variantId || !Number.isInteger(quantity) || quantity < 1) continue;
    const variantPrice = readInteger(row.variant_price);
    const unitPriceMinor = variantPrice !== null && variantPrice > 0 ? variantPrice : readInteger(row.product_price);
    if (unitPriceMinor === null || unitPriceMinor <= 0) continue;
    lines.push({ productId, variantId, sku, quantity, unitPriceMinor });
  }
  return lines;
}

function orderSubtotal(lines: readonly SandboxAffiliateDemoOrderLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
}

/**
 * The FAILED payout (see DEMO_FAILED_PAYOUT_TIMELINE) and the CLEARED commission it holds, on the
 * seed's own older sale. Null when that sale earns nothing or the partner bought it.
 */
export function planSandboxAffiliateDemoFailedPayout(input: {
  orderId: string;
  lines: readonly SandboxAffiliateDemoOrderLine[];
  buyerEmail: string | null;
  ratePercent: number;
  baseCurrency: string | null;
  now: Date;
}): SandboxAffiliateDemoFailedPayout | null {
  if (input.lines.length === 0 || isPartnerPurchase(input.buyerEmail)) return null;
  const currency = readCurrency(input.baseCurrency) ?? 'USD';
  const subtotal = orderSubtotal(input.lines);
  const priced = priceDemoOrder(
    {
      id: input.orderId,
      total: subtotal,
      subtotal,
      discount_total: 0,
      currency,
      exchange_rate_at_purchase: 1,
      provider: 'stripe',
      buyer_email: input.buyerEmail,
    },
    currency,
    Number(input.ratePercent),
  );
  if (!priced) return null;

  const timeline = DEMO_FAILED_PAYOUT_TIMELINE;
  const clearsAt = shiftDays(input.now, timeline.clearsInDays);
  return {
    commission: {
      ...priced,
      status: 'CLEARED',
      source: 'referral_link',
      createdAt: shiftDays(input.now, -timeline.earnedDaysAgo),
      clearsAt,
      clearedAt: clearsAt,
      paidAt: null,
    },
    payout: {
      amountMinor: priced.commissionMinor,
      createdAt: shiftDays(input.now, -timeline.firstAttemptDaysAgo),
      lastAttemptAt: hoursAgo(input.now, timeline.lastAttemptHoursAgo),
      attemptCount: timeline.attempts,
      failureReason: SANDBOX_AFFILIATE_DEMO_FAILURE_REASON,
    },
  };
}

/** Long enough for any GoTrue password policy, with every character class one may require. */
function randomDemoPassword(): string {
  return `Nb-${randomBytes(24).toString('base64url')}-7a`;
}

async function readAuthUserIds(db: SqlClient): Promise<Map<string, string>> {
  const rows = await db`
    SELECT id::text AS id, lower(email::text) AS email
    FROM auth.users
    WHERE lower(email::text) = ANY(${[SANDBOX_AFFILIATE_DEMO_EMAIL, SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL, SANDBOX_AFFILIATE_DEMO_FR_EMAIL]}::text[])
  `;
  const ids = new Map<string, string>();
  for (const row of rows) {
    const id = readString(row['id']);
    const email = readString(row['email']);
    if (id && email && !ids.has(email)) ids.set(email, id);
  }
  return ids;
}

interface DemoAccount {
  email: string;
  password: string;
  displayName: string;
  /** For the log lines ("the demo partner account"). */
  label: string;
}

/**
 * Find or create a partner's auth user and (re-)assert its password: Studio Nova's is published,
 * so anyone can sign in with it and change it, and nothing else would ever restore it before the
 * next Step A; Atelier Boréal's is random on every run, so a password set in between is dropped.
 */
async function ensureDemoAccount(
  db: SqlClient,
  supabaseAdmin: SandboxAffiliateDemoAuthAdmin,
  account: DemoAccount,
  existingId: string | null,
): Promise<string> {
  const attributes = {
    password: account.password,
    email_confirm: true,
    user_metadata: { full_name: account.displayName },
  };

  const reassert = async (userId: string) => {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, attributes);
    if (error) {
      // Non-fatal, like the demo admin's password restore in the route's restoreDemoAdmin().
      console.error(`[Sandbox Reset] Failed to restore the ${account.label} password:`, describeError(error));
    }
  };

  if (existingId) {
    await reassert(existingId);
    return existingId;
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: account.email,
    ...attributes,
  });
  const createdId = readString(data?.user?.id);
  if (!error && createdId) {
    console.log(`[Sandbox Reset] Created the ${account.label} account.`);
    return createdId;
  }

  // Created concurrently, or the lookup missed it: look again before giving up.
  const retryId = (await readAuthUserIds(db)).get(account.email) ?? null;
  if (retryId) {
    await reassert(retryId);
    return retryId;
  }
  throw new Error(`Could not create the ${account.label} account: ${describeError(error ?? 'no user returned')}`);
}

interface DemoSeedContext {
  partnerUserId: string;
  /** Atelier Boréal's account, or null when it could not be created (Studio Nova is seeded alone). */
  frPartnerUserId: string | null;
  /** The demo admin: buyer of the attributed orders and reviewer of the pages. */
  buyerUserId: string | null;
  now: Date;
  siteUrl: string;
}

interface DemoSeedSummary {
  products: number;
  commissions: number;
  payouts: number;
  unpaidOrders: number;
  /** Atelier Boréal was seeded (published, with an edit in review). */
  frPartner: boolean;
}

function sanitizeDemoDoc(doc: StorefrontDoc, siteUrl: string, label: string): StorefrontDoc {
  const sanitized = sanitizeStorefrontDoc(doc, {
    allowedImageOrigins: [],
    siteOrigin: normalizeStorefrontSiteOrigin(siteUrl),
  });
  if (isStorefrontDocEmpty(sanitized.doc)) {
    throw new Error(`The ${label} document is empty after sanitizing.`);
  }
  if (sanitized.issues.length > 0) {
    console.warn(`[Sandbox Reset] The sanitizer adjusted the ${label}:`, sanitized.issues.slice(0, 5));
  }
  return sanitized.doc;
}

async function readDemoVariantRows(sql: SqlClient, skus: readonly string[]): Promise<SandboxAffiliateDemoVariantRow[]> {
  const rows = await sql`
    SELECT v.id::text AS variant_id, v.sku, v.price AS variant_price, p.id::text AS product_id, p.price AS product_price
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id
    JOIN public.languages l ON l.id = p.language_id
    WHERE l.is_default
      AND p.status = 'active'
      AND v.sku = ANY(${[...skus]}::text[])
    ORDER BY v.sku, v.id
  `;
  return rows.map((row) => ({
    variant_id: row['variant_id'],
    sku: row['sku'],
    variant_price: row['variant_price'],
    product_id: row['product_id'],
    product_price: row['product_price'],
  }));
}

interface DemoOrderInsert {
  id: string;
  buyerUserId: string;
  status: 'pending' | 'shipped';
  lines: readonly SandboxAffiliateDemoOrderLine[];
  currency: string;
  createdAt: Date;
  /** Null for an unpaid order: marking it paid (the CMS) is what records its commission. */
  paidAt: Date | null;
  affiliateId: string;
  source: SandboxAffiliateDemoSource;
}

/**
 * One of the seed's own orders, attributed the way checkout records it (partner, source, store
 * base currency, key mode) and carrying its lines. In the base currency, without tax, shipping or
 * discount, so the commission base is the subtotal. A paid order gets its invoice number from the
 * same sequence the "mark paid" path uses; an INSERT never fires the orders trigger that records a
 * commission (02035's BEFORE INSERT trigger only copies the partner's tier rate and hold onto a paid,
 * attributed order).
 */
async function insertDemoOrder(sql: SqlClient, order: DemoOrderInsert): Promise<void> {
  const subtotal = orderSubtotal(order.lines);
  await sql`
    INSERT INTO public.orders (
      id, user_id, status, total, subtotal, shipping_total, tax_total, discount_total, currency,
      exchange_rate_at_purchase, paid_at, created_at, customer_details, provider,
      affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode
    )
    VALUES (
      ${order.id}, ${order.buyerUserId}, ${order.status}, ${subtotal}, ${subtotal}, 0, 0, 0, ${order.currency},
      1, ${order.paidAt}, ${order.createdAt},
      ${json(sql, { email: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL, name: SANDBOX_AFFILIATE_DEMO_BUYER_NAME })}, 'stripe',
      ${order.affiliateId}, ${order.source}, ${order.currency}, ${SANDBOX_AFFILIATE_DEMO_LIVEMODE}
    )
  `;
  if (order.paidAt) {
    // No paid_at or status in the statement: the orders trigger does not fire.
    await sql`
      UPDATE public.orders
      SET invoice_number = public.generate_order_invoice_number()
      WHERE id = ${order.id} AND invoice_number IS NULL
    `;
  }
  for (const line of order.lines) {
    await sql`
      INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, price_at_purchase)
      VALUES (${order.id}, ${line.productId}, ${line.variantId}, ${line.quantity}, ${line.unitPriceMinor})
    `;
  }
}

async function insertDemoCommission(
  sql: SqlClient,
  affiliateId: string,
  currency: string,
  commission: SandboxAffiliateDemoCommission,
  payout: { id: string; transferId: string | null } | null,
): Promise<void> {
  await sql`
    INSERT INTO public.affiliate_commissions (
      affiliate_id, order_id, gateway, order_currency, order_net_amount_minor, exchange_rate_snapshot,
      net_order_amount_cents, commission_rate_snapshot, commission_amount_cents, currency, livemode, status,
      clears_at, cleared_at, paid_at, payout_id, stripe_transfer_id, notified_at, created_at
    )
    VALUES (
      ${affiliateId}, ${commission.orderId}, ${commission.gateway}, ${commission.orderCurrency},
      ${commission.orderNetMinor}, ${commission.exchangeRateSnapshot}, ${commission.netBaseMinor},
      ${commission.ratePercent}, ${commission.commissionMinor}, ${currency}, ${SANDBOX_AFFILIATE_DEMO_LIVEMODE},
      ${commission.status}, ${commission.clearsAt}, ${commission.clearedAt}, ${commission.paidAt},
      ${payout ? payout.id : null}, ${payout ? payout.transferId : null}, ${commission.createdAt}, ${commission.createdAt}
    )
  `;
}

/** One Activity feed row, unresolved, dated when its event happened. */
async function insertDemoAlert(sql: SqlClient, alert: SandboxAffiliateDemoAlert): Promise<void> {
  await sql`
    INSERT INTO public.system_alerts (alert_type, title, message, metadata, is_resolved, created_at, updated_at)
    VALUES (${alert.alert_type}, ${alert.title}, ${alert.message}, ${json(sql, alert.metadata)}, false, ${alert.createdAt}, ${alert.createdAt})
  `;
}

async function seedDemoRows(sql: SqlClient, context: DemoSeedContext): Promise<DemoSeedSummary> {
  const { partnerUserId, buyerUserId, now } = context;

  const [tier] = await sql`
    SELECT id::text AS id, commission_percentage::text AS commission_percentage
    FROM public.affiliate_tiers
    WHERE slug = ${SANDBOX_AFFILIATE_DEMO_TIER_SLUG}
    LIMIT 1
  `;
  const tierId = readString(tier?.['id']);
  if (!tierId) {
    throw new Error(`The ${SANDBOX_AFFILIATE_DEMO_TIER_SLUG} tier is missing.`);
  }
  const ratePercent = Number(tier?.['commission_percentage']);

  // The same lookup as private.affiliate_record_commission's base currency.
  const [baseCurrencyRow] = await sql`
    SELECT upper(code) AS code
    FROM public.currencies
    WHERE is_default
    ORDER BY updated_at DESC, created_at DESC, code
    LIMIT 1
  `;
  const baseCurrency = readCurrency(baseCurrencyRow?.['code']);

  // The account becomes a partner. Postgres resolves the literal now that the reset transaction
  // (which added the label) has committed.
  await sql`
    INSERT INTO public.profiles (id, full_name, website, role, updated_at)
    VALUES (${partnerUserId}, ${SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME}, ${SANDBOX_AFFILIATE_DEMO_COPY.website}, 'RTL', now())
    ON CONFLICT (id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      website = EXCLUDED.website,
      role = 'RTL',
      updated_at = now()
  `;

  const joinedAt = shiftDays(now, -DEMO_TIMELINE.joinedDaysAgo);
  const socialLinks = sanitizeAffiliateSocialLinks({ website: SANDBOX_AFFILIATE_DEMO_COPY.website });

  // The profile guard derives onboarding_step (ACTIVE_PUBLISHED here) and the tier trigger
  // maintains member_count. Connect stays unconfigured (payout_configured_at NULL).
  const [profile] = await sql`
    INSERT INTO public.affiliate_profiles (
      user_id, tier_id, handle, display_name, bio, avatar_object_key, social_links, preferred_locale,
      status, profile_completed_at, page_submitted_at, first_published_at, created_at
    )
    VALUES (
      ${partnerUserId}, ${tierId}, ${SANDBOX_AFFILIATE_DEMO_HANDLE}, ${SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME},
      ${SANDBOX_AFFILIATE_DEMO_COPY.bio}, ${SANDBOX_AFFILIATE_DEMO_AVATAR_KEY}, ${json(sql, socialLinks)}, 'en',
      'ACTIVE', ${joinedAt}, ${shiftDays(now, -DEMO_TIMELINE.firstSubmittedDaysAgo)},
      ${shiftDays(now, -DEMO_TIMELINE.firstApprovedDaysAgo)}, ${joinedAt}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      tier_id = EXCLUDED.tier_id,
      handle = EXCLUDED.handle,
      display_name = EXCLUDED.display_name,
      bio = EXCLUDED.bio,
      avatar_object_key = EXCLUDED.avatar_object_key,
      social_links = EXCLUDED.social_links,
      preferred_locale = EXCLUDED.preferred_locale,
      status = 'ACTIVE',
      suspended_reason = NULL,
      stripe_connect_account_id = NULL,
      stripe_connect_livemode = NULL,
      stripe_connect_onboarding_complete = false,
      stripe_connect_details_submitted = false,
      stripe_connect_payouts_enabled = false,
      stripe_connect_checked_at = NULL,
      payout_configured_at = NULL,
      profile_completed_at = EXCLUDED.profile_completed_at,
      page_submitted_at = EXCLUDED.page_submitted_at,
      first_published_at = EXCLUDED.first_published_at
    RETURNING id::text AS id
  `;
  const affiliateId = readString(profile?.['id']);
  if (!affiliateId) {
    throw new Error('The demo partner profile was not written.');
  }

  // The seeded apparel in the default language (a grid shows each pick in the visitor's language).
  const productRows = await sql`
    SELECT p.id::text AS id, p.sku
    FROM public.products p
    JOIN public.languages l ON l.id = p.language_id
    WHERE l.is_default
      AND p.status = 'active'
      AND p.sku = ANY(${[...SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS]}::text[])
  `;
  const productIdBySku = new Map<string, string>();
  for (const sku of SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS) {
    const id = readString(productRows.find((row) => row['sku'] === sku)?.['id']);
    if (id) productIdBySku.set(sku, id);
  }
  const productIds = [...new Set(productIdBySku.values())];

  const storefrontDoc = sanitizeDemoDoc(buildSandboxAffiliateDemoDoc(productIds), context.siteUrl, 'demo storefront');
  const featuredProductIds = collectStorefrontProductIds(storefrontDoc);

  // The page guard refuses any draft write while a submission is pending, service role included.
  await sql`
    UPDATE public.affiliate_pages
    SET approval_status = 'DRAFT'
    WHERE affiliate_id = ${affiliateId} AND approval_status = 'PENDING_REVIEW'
  `;

  // A new row's draft_updated_at is set here (the guard only stamps it on an UPDATE that edits
  // the draft): last edited just before the submission that was approved.
  const [page] = await sql`
    INSERT INTO public.affiliate_pages (
      affiliate_id, user_id, title, meta_description, draft_content, featured_product_ids, draft_updated_at, created_at
    )
    VALUES (
      ${affiliateId}, ${partnerUserId}, ${SANDBOX_AFFILIATE_DEMO_COPY.title},
      ${SANDBOX_AFFILIATE_DEMO_COPY.metaDescription}, ${json(sql, storefrontDoc)}, ${featuredProductIds}::uuid[],
      ${hoursAgo(now, DEMO_TIMELINE.lastEditedHoursAgo)}, ${joinedAt}
    )
    ON CONFLICT (affiliate_id) DO UPDATE SET
      title = EXCLUDED.title,
      meta_description = EXCLUDED.meta_description,
      draft_content = EXCLUDED.draft_content,
      featured_product_ids = EXCLUDED.featured_product_ids
    RETURNING id::text AS id
  `;
  const pageId = readString(page?.['id']);
  if (!pageId) {
    throw new Error('The demo storefront page was not written.');
  }

  // Approve exactly the stored draft. No draft column is in this statement, so the page guard
  // neither bumps draft_version nor sends the page back to DRAFT, and submitted_version matches.
  const [publication] = await sql`
    UPDATE public.affiliate_pages
    SET
      published_content = draft_content,
      published_title = title,
      published_meta_description = meta_description,
      published_profile = ${json(sql, buildSandboxAffiliateDemoPublishedProfile())},
      published_featured_product_ids = featured_product_ids,
      approval_status = 'PUBLISHED',
      admin_feedback_note = NULL,
      submitted_at = ${hoursAgo(now, DEMO_TIMELINE.lastSubmittedHoursAgo)},
      submitted_version = draft_version,
      reviewed_at = ${hoursAgo(now, DEMO_TIMELINE.lastApprovedHoursAgo)},
      reviewed_by = ${buyerUserId},
      published_at = ${hoursAgo(now, DEMO_TIMELINE.lastApprovedHoursAgo)}
    WHERE id = ${pageId}
    RETURNING draft_version, submitted_version
  `;
  if (!publication) {
    throw new Error('The demo storefront page was not published.');
  }

  // Replace the demo ledger (commissions first: they reference the payouts and the orders), then
  // the seed's own orders (with no commission left, the order delete trigger has nothing to void).
  await sql`DELETE FROM public.affiliate_commissions WHERE affiliate_id = ${affiliateId}`;
  await sql`DELETE FROM public.affiliate_payouts WHERE affiliate_id = ${affiliateId}`;
  // With the payouts goes the payout-failed alert naming one. The notifier would reuse an alert of
  // the same payout instead; a re-run gives the FAILED payout a new id, so replace it here.
  await sql`
    DELETE FROM public.system_alerts
    WHERE alert_type = ${AFFILIATE_ALERT_TYPES.PAYOUT_FAILED} AND metadata ->> 'affiliate_id' = ${affiliateId}
  `;
  await sql`
    DELETE FROM public.orders
    WHERE id = ANY(${[SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID, SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID]}::uuid[])
  `;
  await sql`
    UPDATE public.orders
    SET affiliate_id = NULL, affiliate_source = NULL, affiliate_base_currency = NULL, affiliate_livemode = NULL
    WHERE affiliate_id = ${affiliateId}
  `;

  const hasBuyer = Boolean(buyerUserId && buyerUserId !== partnerUserId);
  const candidates: SandboxAffiliateDemoOrder[] = [];
  if (hasBuyer) {
    const orderRows = await sql`
      SELECT
        o.id::text AS id,
        o.total,
        o.subtotal,
        o.discount_total,
        o.currency,
        o.exchange_rate_at_purchase::text AS exchange_rate_at_purchase,
        o.provider,
        o.customer_details ->> 'email' AS buyer_email
      FROM public.orders o
      WHERE o.user_id = ${buyerUserId}
        AND o.status IN ('paid', 'shipped')
        AND o.paid_at IS NOT NULL
        AND o.affiliate_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.affiliate_commissions c WHERE c.order_id = o.id)
      ORDER BY o.paid_at ASC, o.id ASC
      LIMIT ${MAX_CANDIDATE_ORDERS}
      FOR UPDATE OF o
    `;
    for (const row of orderRows) {
      const id = readString(row['id']);
      if (!id) continue;
      candidates.push({
        id,
        total: row['total'],
        subtotal: row['subtotal'],
        discount_total: row['discount_total'],
        currency: row['currency'],
        exchange_rate_at_purchase: row['exchange_rate_at_purchase'],
        provider: row['provider'],
        buyer_email: row['buyer_email'],
      });
    }
  }

  const ledger = planSandboxAffiliateDemoLedger({ orders: candidates, ratePercent, baseCurrency, now });

  // Attribute each order the way checkout records it, and back-date it to its commission: the
  // order was paid when the commission was earned. paid_at goes from one value to another (never
  // from NULL, which the WHERE pins), so the orders trigger fires but records and voids nothing.
  for (const commission of ledger.commissions) {
    const attached = await sql`
      UPDATE public.orders
      SET
        affiliate_id = ${affiliateId},
        affiliate_source = ${commission.source},
        affiliate_base_currency = ${ledger.currency},
        affiliate_livemode = ${SANDBOX_AFFILIATE_DEMO_LIVEMODE},
        paid_at = ${commission.createdAt},
        created_at = ${checkoutStartedAt(commission.createdAt)}
      WHERE id = ${commission.orderId} AND affiliate_id IS NULL AND paid_at IS NOT NULL
      RETURNING id::text AS id
    `;
    if (attached.length === 0) {
      throw new Error('A demo order could not be attributed to the demo partner.');
    }
  }

  let payoutId: string | null = null;
  if (ledger.payout) {
    const [payout] = await sql`
      INSERT INTO public.affiliate_payouts (
        affiliate_id, amount_cents, currency, stripe_destination_account, livemode, stripe_transfer_id,
        status, attempt_count, last_attempt_at, trigger, paid_at, created_at
      )
      VALUES (
        ${affiliateId}, ${ledger.payout.amountMinor}, ${ledger.currency}, ${SANDBOX_AFFILIATE_DEMO_DESTINATION},
        ${SANDBOX_AFFILIATE_DEMO_LIVEMODE}, ${SANDBOX_AFFILIATE_DEMO_TRANSFER_ID}, 'COMPLETED', 1, ${ledger.payout.createdAt},
        'cron', ${ledger.payout.paidAt}, ${ledger.payout.createdAt}
      )
      RETURNING id::text AS id
    `;
    payoutId = readString(payout?.['id']);
    if (!payoutId) {
      throw new Error('The demo payout was not written.');
    }
  }

  for (const commission of ledger.commissions) {
    const paid = commission.status === 'PAID' && payoutId !== null;
    await insertDemoCommission(
      sql,
      affiliateId,
      ledger.currency,
      commission,
      paid && payoutId ? { id: payoutId, transferId: SANDBOX_AFFILIATE_DEMO_TRANSFER_ID } : null,
    );
  }

  // The seed's own orders: the older sale whose commission a FAILED payout holds, and a storefront
  // sale still waiting for its payment (no commission until it is marked paid).
  let failedPayout: SandboxAffiliateDemoFailedPayout | null = null;
  let unpaidOrders = 0;
  if (hasBuyer && buyerUserId) {
    const variantRows = await readDemoVariantRows(sql, [
      ...SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES.map((line) => line.sku),
      ...SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES.map((line) => line.sku),
    ]);

    const failedLines = buildSandboxAffiliateDemoOrderLines(SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_LINES, variantRows);
    failedPayout = planSandboxAffiliateDemoFailedPayout({
      orderId: SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID,
      lines: failedLines,
      buyerEmail: SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL,
      ratePercent,
      baseCurrency: ledger.currency,
      now,
    });
    if (failedPayout) {
      const { commission } = failedPayout;
      await insertDemoOrder(sql, {
        id: SANDBOX_AFFILIATE_DEMO_FAILED_PAYOUT_ORDER_ID,
        buyerUserId,
        status: 'shipped',
        lines: failedLines,
        currency: ledger.currency,
        createdAt: checkoutStartedAt(commission.createdAt),
        paidAt: commission.createdAt,
        affiliateId,
        source: commission.source,
      });
      const [payout] = await sql`
        INSERT INTO public.affiliate_payouts (
          affiliate_id, amount_cents, currency, stripe_destination_account, livemode, status,
          attempt_count, last_attempt_at, failure_reason, trigger, created_at
        )
        VALUES (
          ${affiliateId}, ${failedPayout.payout.amountMinor}, ${ledger.currency}, ${SANDBOX_AFFILIATE_DEMO_DESTINATION},
          ${SANDBOX_AFFILIATE_DEMO_LIVEMODE}, 'FAILED', ${failedPayout.payout.attemptCount}, ${failedPayout.payout.lastAttemptAt},
          ${failedPayout.payout.failureReason}, 'cron', ${failedPayout.payout.createdAt}
        )
        RETURNING id::text AS id
      `;
      const failedPayoutId = readString(payout?.['id']);
      if (!failedPayoutId) {
        throw new Error('The failed demo payout was not written.');
      }
      // CLEARED and attached: the partner's "in a payout" balance, back in "cleared" after a Release.
      await insertDemoCommission(sql, affiliateId, ledger.currency, commission, { id: failedPayoutId, transferId: null });

      // The alert the last automatic retry raised (retries exhausted), dated then.
      await insertDemoAlert(
        sql,
        buildSandboxAffiliateDemoPayoutFailedAlert({
          affiliateId,
          payoutId: failedPayoutId,
          amountMinor: failedPayout.payout.amountMinor,
          currency: ledger.currency,
          siteUrl: context.siteUrl,
          failedAt: failedPayout.payout.lastAttemptAt,
        }),
      );
    } else {
      console.warn('[Sandbox Reset] The apparel variants are missing; skipping the failed demo payout.');
    }

    const pendingLines = buildSandboxAffiliateDemoOrderLines(SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_LINES, variantRows);
    if (pendingLines.length > 0) {
      await insertDemoOrder(sql, {
        id: SANDBOX_AFFILIATE_DEMO_PENDING_ORDER_ID,
        buyerUserId,
        status: 'pending',
        lines: pendingLines,
        currency: ledger.currency,
        createdAt: minutesAgo(now, DEMO_PENDING_ORDER_MINUTES_AGO),
        paidAt: null,
        affiliateId,
        source: 'storefront',
      });
      unpaidOrders = 1;
    } else {
      console.warn('[Sandbox Reset] The apparel variants are missing; skipping the unpaid demo order.');
    }
  }

  await sql`
    UPDATE public.affiliate_profiles
    SET
      total_earned_cents = ${ledger.totalEarnedMinor + (failedPayout ? failedPayout.commission.commissionMinor : 0)},
      total_paid_cents = ${ledger.totalPaidMinor},
      total_clicks = ${SANDBOX_AFFILIATE_DEMO_TOTAL_CLICKS},
      last_click_at = ${hoursAgo(now, DEMO_TIMELINE.lastClickHoursAgo)}
    WHERE id = ${affiliateId}
  `;

  // Atelier Boréal is optional: a failure rolls back its own rows (a savepoint), never Studio Nova's.
  let frPartner = false;
  try {
    frPartner = await (sql as unknown as postgres.TransactionSql<Record<string, unknown>>).savepoint((savepoint) =>
      seedFrenchDemoPartner(savepoint as unknown as SqlClient, context, productIdBySku),
    );
  } catch (error) {
    console.warn('[Sandbox Reset] Seeding Studio Nova without the second demo partner:', describeError(error));
  }

  return {
    products: featuredProductIds.length,
    commissions: ledger.commissions.length + (failedPayout ? 1 : 0),
    payouts: (ledger.payout ? 1 : 0) + (failedPayout ? 1 : 0),
    unpaidOrders,
    frPartner,
  };
}

/**
 * Atelier Boréal: the profile (its bio already edited), the page with the version approved 16 days
 * ago live and the edited draft waiting for review, and its two Activity feed alerts. Skipped
 * (false) without its account, or when its tier is missing, inactive or full (the seed bypasses
 * create_affiliate_account(), so it checks the seat cap itself). It has no ledger. The caller runs
 * it in a savepoint: a failure in its own writes rolls back only its rows.
 */
async function seedFrenchDemoPartner(
  sql: SqlClient,
  context: DemoSeedContext,
  productIdBySku: ReadonlyMap<string, string>,
): Promise<boolean> {
  const { frPartnerUserId: userId, buyerUserId, now } = context;
  if (!userId) return false;

  // The same seat rule `create_affiliate_account()` applies (without its row lock: the reset runs
  // alone), plus the seat it already holds on a re-run.
  const [tier] = await sql`
    SELECT
      t.id::text AS id,
      t.name,
      (t.is_active AND (
        t.max_ambassadors_cap IS NULL
        OR t.member_count < t.max_ambassadors_cap
        OR EXISTS (SELECT 1 FROM public.affiliate_profiles p WHERE p.tier_id = t.id AND p.user_id = ${userId})
      )) AS has_room
    FROM public.affiliate_tiers t
    WHERE t.slug = ${SANDBOX_AFFILIATE_DEMO_FR_TIER_SLUG}
    LIMIT 1
  `;
  const tierId = readString(tier?.['id']);
  if (!tierId || tier?.['has_room'] !== true) {
    console.warn(
      `[Sandbox Reset] The ${SANDBOX_AFFILIATE_DEMO_FR_TIER_SLUG} tier is missing, inactive or full; skipping the second demo partner.`,
    );
    return false;
  }

  const timeline = DEMO_FR_TIMELINE;
  const joinedAt = shiftDays(now, -timeline.joinedDaysAgo);
  const firstApprovedAt = shiftDays(now, -timeline.firstApprovedDaysAgo);
  const lastEditedAt = hoursAgo(now, timeline.lastEditedHoursAgo);
  const lastSubmittedAt = hoursAgo(now, timeline.lastSubmittedHoursAgo);
  const reviewerId = buyerUserId && buyerUserId !== userId ? buyerUserId : null;

  await sql`
    INSERT INTO public.profiles (id, full_name, website, role, updated_at)
    VALUES (${userId}, ${SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME}, NULL, 'RTL', now())
    ON CONFLICT (id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      website = EXCLUDED.website,
      role = 'RTL',
      updated_at = now()
  `;

  const [profile] = await sql`
    INSERT INTO public.affiliate_profiles (
      user_id, tier_id, handle, display_name, bio, avatar_object_key, social_links, preferred_locale,
      status, profile_completed_at, page_submitted_at, first_published_at, created_at
    )
    VALUES (
      ${userId}, ${tierId}, ${SANDBOX_AFFILIATE_DEMO_FR_HANDLE}, ${SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME},
      ${SANDBOX_AFFILIATE_DEMO_FR_COPY.bio}, NULL, ${json(sql, sanitizeAffiliateSocialLinks({}))}, 'fr',
      'ACTIVE', ${joinedAt}, ${shiftDays(now, -timeline.firstSubmittedDaysAgo)}, ${firstApprovedAt}, ${joinedAt}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      tier_id = EXCLUDED.tier_id,
      handle = EXCLUDED.handle,
      display_name = EXCLUDED.display_name,
      bio = EXCLUDED.bio,
      avatar_object_key = EXCLUDED.avatar_object_key,
      social_links = EXCLUDED.social_links,
      preferred_locale = EXCLUDED.preferred_locale,
      status = 'ACTIVE',
      suspended_reason = NULL,
      stripe_connect_account_id = NULL,
      stripe_connect_livemode = NULL,
      stripe_connect_onboarding_complete = false,
      stripe_connect_details_submitted = false,
      stripe_connect_payouts_enabled = false,
      stripe_connect_checked_at = NULL,
      payout_configured_at = NULL,
      profile_completed_at = EXCLUDED.profile_completed_at,
      page_submitted_at = EXCLUDED.page_submitted_at,
      first_published_at = EXCLUDED.first_published_at
    RETURNING id::text AS id
  `;
  const affiliateId = readString(profile?.['id']);
  if (!affiliateId) {
    throw new Error('The second demo partner profile was not written.');
  }

  const idsOf = (skus: readonly string[]) =>
    skus.map((sku) => productIdBySku.get(sku)).filter((id): id is string => typeof id === 'string');
  const publishedDoc = sanitizeDemoDoc(
    buildSandboxAffiliateDemoFrDoc('published', idsOf(SANDBOX_AFFILIATE_DEMO_PRODUCT_SKUS)),
    context.siteUrl,
    'second demo storefront',
  );
  const draftDoc = sanitizeDemoDoc(
    buildSandboxAffiliateDemoFrDoc('draft', idsOf(SANDBOX_AFFILIATE_DEMO_FR_DRAFT_PRODUCT_SKUS)),
    context.siteUrl,
    'second demo storefront draft',
  );

  // Out of review first: the page guard refuses a draft write while PENDING_REVIEW.
  await sql`
    UPDATE public.affiliate_pages
    SET approval_status = 'DRAFT'
    WHERE affiliate_id = ${affiliateId} AND approval_status = 'PENDING_REVIEW'
  `;

  // The draft is the edit in review. On a re-run that finds it unchanged the guard leaves the
  // version alone; a changed draft bumps it, and the next statement sets it back.
  const [page] = await sql`
    INSERT INTO public.affiliate_pages (
      affiliate_id, user_id, title, meta_description, draft_content, featured_product_ids, draft_updated_at, created_at
    )
    VALUES (
      ${affiliateId}, ${userId}, ${SANDBOX_AFFILIATE_DEMO_FR_COPY.title}, ${SANDBOX_AFFILIATE_DEMO_FR_COPY.metaDescription},
      ${json(sql, draftDoc)}, ${collectStorefrontProductIds(draftDoc)}::uuid[], ${lastEditedAt}, ${joinedAt}
    )
    ON CONFLICT (affiliate_id) DO UPDATE SET
      title = EXCLUDED.title,
      meta_description = EXCLUDED.meta_description,
      draft_content = EXCLUDED.draft_content,
      featured_product_ids = EXCLUDED.featured_product_ids
    RETURNING id::text AS id
  `;
  const pageId = readString(page?.['id']);
  if (!pageId) {
    throw new Error('The second demo storefront page was not written.');
  }

  // The version approved at the first review stays live (published_*, with the profile snapshot of
  // that day); the edit was saved at version 2 and submitted at that version. No draft column is
  // in this statement, so the guard keeps every value it sets.
  const [review] = await sql`
    UPDATE public.affiliate_pages
    SET
      published_content = ${json(sql, publishedDoc)},
      published_title = ${SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedTitle},
      published_meta_description = ${SANDBOX_AFFILIATE_DEMO_FR_COPY.publishedMetaDescription},
      published_profile = ${json(sql, buildSandboxAffiliateDemoFrPublishedProfile())},
      published_featured_product_ids = ${collectStorefrontProductIds(publishedDoc)}::uuid[],
      approval_status = 'PENDING_REVIEW',
      admin_feedback_note = NULL,
      draft_version = ${SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION},
      draft_updated_at = ${lastEditedAt},
      submitted_at = ${lastSubmittedAt},
      submitted_version = ${SANDBOX_AFFILIATE_DEMO_FR_DRAFT_VERSION},
      reviewed_at = ${firstApprovedAt},
      reviewed_by = ${reviewerId},
      published_at = ${firstApprovedAt}
    WHERE id = ${pageId}
    RETURNING draft_version, submitted_version
  `;
  if (!review) {
    throw new Error('The second demo storefront page was not submitted.');
  }

  await sql`
    UPDATE public.affiliate_profiles
    SET
      total_clicks = ${SANDBOX_AFFILIATE_DEMO_FR_TOTAL_CLICKS},
      last_click_at = ${hoursAgo(now, timeline.lastClickHoursAgo)}
    WHERE id = ${affiliateId}
  `;

  // Replace its two alerts (the reset itself starts from none).
  await sql`
    DELETE FROM public.system_alerts
    WHERE alert_type = ANY(${[AFFILIATE_ALERT_TYPES.SIGNED_UP, AFFILIATE_ALERT_TYPES.PAGE_SUBMITTED]}::text[])
      AND metadata ->> 'affiliate_id' = ${affiliateId}
  `;
  const alerts = buildSandboxAffiliateDemoFrAlerts({
    affiliateId,
    pageId,
    tierName: readString(tier?.['name']),
    siteUrl: context.siteUrl,
    signedUpAt: joinedAt,
    submittedAt: lastSubmittedAt,
  });
  for (const alert of alerts) {
    await insertDemoAlert(sql, alert);
  }

  return true;
}

/**
 * Seed (or re-seed) the sandbox's demo partners. Never throws: returns `{ seeded: false }` after
 * logging when the Affiliates schema is missing, no ADMIN exists yet (handle_new_user would make
 * a new account the first ADMIN), Studio Nova's auth user cannot be created, or any of Studio
 * Nova's writes fails. Atelier Boréal is optional: when its account cannot be created Studio Nova
 * is seeded alone, and a failure in its own writes rolls back only its rows.
 */
export async function seedSandboxAffiliateDemo(
  db: SqlClient,
  supabaseAdmin: SandboxAffiliateDemoAuthAdmin,
  options: SeedSandboxAffiliateDemoOptions,
): Promise<SeedSandboxAffiliateDemoResult> {
  const handle = SANDBOX_AFFILIATE_DEMO_HANDLE;
  const now = options.now ?? new Date();

  try {
    const [readiness] = await db`
      SELECT
        to_regclass('public.affiliate_profiles') IS NOT NULL
          AND to_regclass('public.affiliate_pages') IS NOT NULL
          AND to_regclass('public.affiliate_payouts') IS NOT NULL
          AND to_regclass('public.affiliate_commissions') IS NOT NULL AS schema_ready,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_enum e
          JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = 'user_role' AND e.enumlabel = 'RTL'
        ) AS role_ready,
        EXISTS (SELECT 1 FROM public.profiles WHERE role = 'ADMIN') AS admin_exists
    `;
    if (readiness?.['schema_ready'] !== true || readiness?.['role_ready'] !== true) {
      console.warn('[Sandbox Reset] The Affiliates schema (migrations 02029-02030) is missing; skipping the demo partner.');
      return { handle, seeded: false };
    }
    if (readiness['admin_exists'] !== true) {
      console.warn('[Sandbox Reset] No ADMIN profile exists yet; skipping the demo partner so it cannot become the first admin.');
      return { handle, seeded: false };
    }

    const userIds = await readAuthUserIds(db);
    const partnerUserId = await ensureDemoAccount(
      db,
      supabaseAdmin,
      {
        email: SANDBOX_AFFILIATE_DEMO_EMAIL,
        password: SANDBOX_AFFILIATE_DEMO_PASSWORD,
        displayName: SANDBOX_AFFILIATE_DEMO_DISPLAY_NAME,
        label: 'demo partner',
      },
      userIds.get(SANDBOX_AFFILIATE_DEMO_EMAIL) ?? null,
    );
    let frPartnerUserId: string | null = null;
    try {
      frPartnerUserId = await ensureDemoAccount(
        db,
        supabaseAdmin,
        {
          email: SANDBOX_AFFILIATE_DEMO_FR_EMAIL,
          password: randomDemoPassword(),
          displayName: SANDBOX_AFFILIATE_DEMO_FR_DISPLAY_NAME,
          label: 'second demo partner',
        },
        userIds.get(SANDBOX_AFFILIATE_DEMO_FR_EMAIL) ?? null,
      );
    } catch (error) {
      console.warn('[Sandbox Reset] Seeding Studio Nova without the second demo partner:', describeError(error));
    }
    const buyerUserId = userIds.get(SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL) ?? null;

    const summary = await db.begin((transaction) =>
      seedDemoRows(transaction as unknown as SqlClient, {
        partnerUserId,
        frPartnerUserId: frPartnerUserId === partnerUserId ? null : frPartnerUserId,
        buyerUserId: buyerUserId === partnerUserId ? null : buyerUserId,
        now,
        siteUrl: options.siteUrl,
      }),
    );

    console.log(
      `[Sandbox Reset] Seeded the demo partner storefront ${options.siteUrl}${AFFILIATE_PARTNERS_PATH}/${handle} ` +
        `(${summary.products} product(s), ${summary.commissions} commission(s), ${summary.payouts} payout(s), ` +
        `${summary.unpaidOrders} unpaid order(s))` +
        (summary.frPartner
          ? ` and ${options.siteUrl}${AFFILIATE_PARTNERS_PATH}/${SANDBOX_AFFILIATE_DEMO_FR_HANDLE} (an edit in review).`
          : '.'),
    );
    return { handle, seeded: true };
  } catch (error) {
    console.error('[Sandbox Reset] Failed to seed the demo partner storefront:', describeError(error));
    return { handle, seeded: false };
  }
}
