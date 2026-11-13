-- 02030: NextBlock Affiliates & Creator Storefronts (package id `affiliates`, lib
-- @nextblock-cms/affiliates). Partner ("RTL", added by 02029) accounts, one storefront page each,
-- a commission ledger fed by the orders table, Stripe Connect payouts and the public storefront
-- reads. Append-only, forward-only, idempotent: types are created in DO/EXCEPTION blocks, tables
-- and indexes IF NOT EXISTS, functions CREATE OR REPLACE, every policy and trigger dropped by
-- name before it is created, the tier seed ON CONFLICT DO NOTHING.
--
-- Roles. 'RTL' was added to public.user_role by 02029 and is never resolved as an enum literal
-- at CREATE or apply time (the sandbox reset replays every migration in one transaction, where
-- the new label is not yet committed): policies compare `(SELECT public.get_current_user_role())::text
-- = 'RTL'`, create_affiliate_account() compares `role::text` and assigns 'RTL' inside plpgsql.
-- The migration lint refuses an 'RTL'::public.user_role cast outside a plpgsql body (A18).
--
-- Who writes what. The Data API grants and policies below are defense in depth; the app writes
-- through server actions on the service role after requireRetailer() / requireCmsAdmin():
--   * affiliate_tiers: public read of active tiers (the /partners ladder); ADMIN CRUD on a
--     satisfied second factor (is_admin_mfa()).
--   * affiliate_profiles / affiliate_pages: the owner (RTL, ACTIVE) reads its row and may UPDATE
--     only display_name, bio, social_links, preferred_locale / title, meta_description,
--     draft_content, featured_product_ids (column grants, pinned again by the post-apply pass);
--     a BEFORE UPDATE guard refuses any other column from a non-admin session. Nobody INSERTs or
--     DELETEs over the API: accounts are created by create_affiliate_account() only, and deleting
--     one would erase the ledger. ADMIN reads and updates every row (aal2).
--   * affiliate_commissions / affiliate_payouts: read-only ledger for the owner and ADMIN;
--     every write is a service-role RPC below or the orders trigger.
--   * affiliate_click_events / affiliate_payout_runs: service role only (RLS on, no API policy).
--
-- Money. Commissions are recorded in the store base currency (orders.affiliate_base_currency,
-- snapshotted at checkout, else the current default currency, else the order currency) from
-- GREATEST(COALESCE(subtotal, total) - discount_total, 0), i.e. without tax and shipping,
-- converted with orders.exchange_rate_at_purchase. The AFTER UPDATE trigger on orders records
-- one commission when paid_at goes NULL -> NOT NULL (every "mark paid" path ends in
-- assign_order_invoice_metadata(), which sets paid_at once under a row lock) and voids it when
-- the order becomes refunded or cancelled; a BEFORE DELETE trigger voids it when an order is
-- deleted. Only the paid branch swallows errors (an order update must never fail because of the
-- affiliate hook; reconcile_affiliate_commissions() repairs a missed commission). Paid or
-- in-flight money is never voided silently: it is flagged (void_requested_at /
-- refund_pending_cents) and raises an affiliate_refund_after_payout system alert. Every money
-- function takes its locks in one order: the order row when it needs one (the orders triggers
-- already hold it), then the affiliate profile row, then its commission rows, then the payout
-- row, and never aggregates under FOR UPDATE. A sale is only ever paid by a transfer of its own
-- key mode (orders.affiliate_livemode -> affiliate_commissions.livemode -> affiliate_payouts.livemode,
-- matched against the partner's Connect account), and an open payment dispute holds its
-- commission (affiliate_commissions.disputed_at) until it closes.
--
-- Functions: SECURITY DEFINER code lives in `private` (never callable over /rpc, advisor lints
-- 0028/0029) behind SECURITY INVOKER wrappers in public (02021 pattern) for the four anonymous
-- storefront reads; the service-role RPCs are SECURITY INVOKER in public and revoked from the
-- API roles here and in BOTH copies of API_ROLE_REVOKE_SQL (apps/nextblock/tools/lib/migrate-core.mjs,
-- apps/nextblock/lib/setup/schema-apply.ts), which also re-pin the table and column grants after
-- the post-apply pass. tools/scripts/security-verify.sql sections 35-38 check all of it.

-- 02001 turns body validation off for the session; a one-connection replay would otherwise
-- create every function below unchecked.
SET check_function_bodies = on;

-- ---------------------------------------------------------------------------
-- 1. Enum types
-- ---------------------------------------------------------------------------
DO $nb$ BEGIN
  CREATE TYPE public.affiliate_onboarding_step AS ENUM ('SIGNED_UP', 'PROFILE_COMPLETED', 'PAYOUT_CONFIGURED', 'PAGE_SUBMITTED', 'ACTIVE_PUBLISHED');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

DO $nb$ BEGIN
  CREATE TYPE public.affiliate_status AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

DO $nb$ BEGIN
  CREATE TYPE public.affiliate_page_status AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'CHANGES_REQUESTED');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

DO $nb$ BEGIN
  CREATE TYPE public.affiliate_gateway AS ENUM ('STRIPE', 'FREEMIUS');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

DO $nb$ BEGIN
  CREATE TYPE public.affiliate_commission_status AS ENUM ('PENDING_CLEARANCE', 'CLEARED', 'PAID', 'VOIDED_REFUND');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

DO $nb$ BEGIN
  CREATE TYPE public.affiliate_payout_status AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $nb$;

-- ---------------------------------------------------------------------------
-- 2. affiliate_tiers (+ the four launch tiers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_tiers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_translations jsonb NOT NULL DEFAULT '{}'::jsonb,
  slug text NOT NULL,
  commission_percentage numeric(5,2) NOT NULL,
  cookie_duration_days integer NOT NULL DEFAULT 30,
  clearance_hold_days integer NOT NULL DEFAULT 30,
  is_default_signup_tier boolean NOT NULL DEFAULT false,
  is_limited_time_promo boolean NOT NULL DEFAULT false,
  max_ambassadors_cap integer NULL,
  member_count integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  badge_color text NOT NULL DEFAULT 'violet',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_tiers_pkey PRIMARY KEY (id),
  CONSTRAINT affiliate_tiers_slug_key UNIQUE (slug),
  CONSTRAINT affiliate_tiers_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT affiliate_tiers_name_translations_check CHECK (jsonb_typeof(name_translations) = 'object' AND octet_length(name_translations::text) <= 2000),
  CONSTRAINT affiliate_tiers_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 64),
  CONSTRAINT affiliate_tiers_commission_percentage_check CHECK (commission_percentage >= 0 AND commission_percentage <= 100),
  CONSTRAINT affiliate_tiers_cookie_duration_days_check CHECK (cookie_duration_days BETWEEN 1 AND 365),
  CONSTRAINT affiliate_tiers_clearance_hold_days_check CHECK (clearance_hold_days BETWEEN 0 AND 365),
  CONSTRAINT affiliate_tiers_max_ambassadors_cap_check CHECK (max_ambassadors_cap IS NULL OR max_ambassadors_cap >= 0),
  CONSTRAINT affiliate_tiers_member_count_check CHECK (member_count >= 0),
  CONSTRAINT affiliate_tiers_badge_color_check CHECK (badge_color IN ('violet', 'indigo', 'blue', 'sky', 'emerald', 'amber', 'orange', 'rose', 'slate'))
);

INSERT INTO public.affiliate_tiers
  (name, name_translations, slug, commission_percentage, sort_order, is_default_signup_tier, is_limited_time_promo, max_ambassadors_cap, badge_color)
VALUES
  ('Starter Partner', '{"fr": "Partenaire Départ"}'::jsonb, 'starter-partner', 10.00, 1, false, false, NULL, 'slate'),
  ('Growth Partner', '{"fr": "Partenaire Croissance"}'::jsonb, 'growth-partner', 20.00, 2, false, false, NULL, 'sky'),
  ('Elite Partner', '{"fr": "Partenaire Élite"}'::jsonb, 'elite-partner', 35.00, 3, false, false, NULL, 'violet'),
  ('Founding Ambassador', '{"fr": "Ambassadeur fondateur"}'::jsonb, 'founding-ambassador', 50.00, 4, true, true, 50, 'amber')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. affiliate_profiles (one per partner account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  handle text NOT NULL,
  display_name text NOT NULL,
  bio text NULL,
  avatar_object_key text NULL,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferred_locale text NOT NULL DEFAULT 'en',
  onboarding_step public.affiliate_onboarding_step NOT NULL DEFAULT 'SIGNED_UP',
  status public.affiliate_status NOT NULL DEFAULT 'ACTIVE',
  suspended_reason text NULL,
  stripe_connect_account_id text NULL,
  stripe_connect_livemode boolean NULL,
  stripe_connect_onboarding_complete boolean NOT NULL DEFAULT false,
  stripe_connect_details_submitted boolean NOT NULL DEFAULT false,
  stripe_connect_payouts_enabled boolean NOT NULL DEFAULT false,
  stripe_connect_checked_at timestamptz NULL,
  total_clicks integer NOT NULL DEFAULT 0,
  last_click_at timestamptz NULL,
  total_earned_cents bigint NOT NULL DEFAULT 0,
  total_paid_cents bigint NOT NULL DEFAULT 0,
  profile_completed_at timestamptz NULL,
  payout_configured_at timestamptz NULL,
  page_submitted_at timestamptz NULL,
  first_published_at timestamptz NULL,
  signup_ip_masked text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT affiliate_profiles_user_id_key UNIQUE (user_id),
  CONSTRAINT affiliate_profiles_id_user_id_key UNIQUE (id, user_id),
  CONSTRAINT affiliate_profiles_handle_key UNIQUE (handle),
  CONSTRAINT affiliate_profiles_stripe_connect_account_id_key UNIQUE (stripe_connect_account_id),
  CONSTRAINT affiliate_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  CONSTRAINT affiliate_profiles_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.affiliate_tiers (id) ON DELETE RESTRICT,
  CONSTRAINT affiliate_profiles_handle_check CHECK (handle ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'),
  CONSTRAINT affiliate_profiles_display_name_check CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT affiliate_profiles_bio_check CHECK (bio IS NULL OR char_length(bio) <= 2000),
  CONSTRAINT affiliate_profiles_avatar_object_key_check CHECK (
    avatar_object_key IS NULL
    OR (char_length(avatar_object_key) <= 512
        AND avatar_object_key ~ '^(affiliates/avatars/|images/)[A-Za-z0-9._/-]+$'
        AND avatar_object_key !~ '(\.\.|//)')
  ),
  CONSTRAINT affiliate_profiles_social_links_check CHECK (jsonb_typeof(social_links) = 'object' AND octet_length(social_links::text) <= 4000),
  CONSTRAINT affiliate_profiles_preferred_locale_check CHECK (preferred_locale ~ '^[a-z]{2}$'),
  CONSTRAINT affiliate_profiles_suspended_reason_check CHECK (suspended_reason IS NULL OR char_length(suspended_reason) <= 500),
  CONSTRAINT affiliate_profiles_stripe_connect_account_id_check CHECK (stripe_connect_account_id IS NULL OR stripe_connect_account_id ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT affiliate_profiles_signup_ip_masked_check CHECK (signup_ip_masked IS NULL OR char_length(signup_ip_masked) <= 64)
);

CREATE INDEX IF NOT EXISTS affiliate_profiles_tier_id_idx ON public.affiliate_profiles (tier_id);
CREATE INDEX IF NOT EXISTS affiliate_profiles_status_idx ON public.affiliate_profiles (status);
CREATE INDEX IF NOT EXISTS affiliate_profiles_signup_ip_masked_idx ON public.affiliate_profiles (signup_ip_masked, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. affiliate_pages (exactly one storefront per partner)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_pages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT '',
  meta_description text NOT NULL DEFAULT '',
  draft_content jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  featured_product_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  published_content jsonb NULL,
  published_title text NULL,
  published_meta_description text NULL,
  published_profile jsonb NULL,
  published_featured_product_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  approval_status public.affiliate_page_status NOT NULL DEFAULT 'DRAFT',
  admin_feedback_note text NULL,
  draft_version integer NOT NULL DEFAULT 1,
  draft_updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL,
  submitted_version integer NULL,
  reviewed_at timestamptz NULL,
  reviewed_by uuid NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_pages_pkey PRIMARY KEY (id),
  CONSTRAINT affiliate_pages_affiliate_id_key UNIQUE (affiliate_id),
  CONSTRAINT affiliate_pages_user_id_key UNIQUE (user_id),
  -- the page belongs to the same account as its profile (A22); the composite key replaces a
  -- single-column affiliate_id foreign key
  CONSTRAINT affiliate_pages_affiliate_owner_fkey FOREIGN KEY (affiliate_id, user_id)
    REFERENCES public.affiliate_profiles (id, user_id) ON DELETE CASCADE,
  CONSTRAINT affiliate_pages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  CONSTRAINT affiliate_pages_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT affiliate_pages_title_check CHECK (char_length(title) <= 120),
  CONSTRAINT affiliate_pages_meta_description_check CHECK (char_length(meta_description) <= 300),
  CONSTRAINT affiliate_pages_draft_content_check CHECK (jsonb_typeof(draft_content) = 'object' AND octet_length(draft_content::text) <= 262144),
  CONSTRAINT affiliate_pages_featured_product_ids_check CHECK (cardinality(featured_product_ids) <= 24),
  CONSTRAINT affiliate_pages_published_content_check CHECK (
    published_content IS NULL OR (jsonb_typeof(published_content) = 'object' AND octet_length(published_content::text) <= 262144)
  ),
  CONSTRAINT affiliate_pages_published_title_check CHECK (published_title IS NULL OR char_length(published_title) <= 120),
  CONSTRAINT affiliate_pages_published_meta_description_check CHECK (published_meta_description IS NULL OR char_length(published_meta_description) <= 300),
  CONSTRAINT affiliate_pages_published_profile_check CHECK (published_profile IS NULL OR jsonb_typeof(published_profile) = 'object'),
  CONSTRAINT affiliate_pages_published_featured_product_ids_check CHECK (cardinality(published_featured_product_ids) <= 24),
  CONSTRAINT affiliate_pages_admin_feedback_note_check CHECK (admin_feedback_note IS NULL OR char_length(admin_feedback_note) <= 2000)
);

CREATE INDEX IF NOT EXISTS affiliate_pages_approval_status_idx ON public.affiliate_pages (approval_status, submitted_at);

-- ---------------------------------------------------------------------------
-- 5. affiliate_payouts (before the commissions that reference it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_payouts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  stripe_destination_account text NOT NULL,
  livemode boolean NOT NULL DEFAULT true,
  stripe_transfer_id text NULL,
  status public.affiliate_payout_status NOT NULL DEFAULT 'PROCESSING',
  attempt_count integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text NULL,
  trigger text NOT NULL DEFAULT 'cron',
  paid_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_payouts_pkey PRIMARY KEY (id),
  CONSTRAINT affiliate_payouts_stripe_transfer_id_key UNIQUE (stripe_transfer_id),
  CONSTRAINT affiliate_payouts_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliate_profiles (id) ON DELETE CASCADE,
  CONSTRAINT affiliate_payouts_amount_cents_check CHECK (amount_cents > 0),
  CONSTRAINT affiliate_payouts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT affiliate_payouts_attempt_count_check CHECK (attempt_count >= 1),
  CONSTRAINT affiliate_payouts_failure_reason_check CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  CONSTRAINT affiliate_payouts_trigger_check CHECK (trigger IN ('cron', 'admin', 'auto'))
);

CREATE INDEX IF NOT EXISTS affiliate_payouts_affiliate_created_idx ON public.affiliate_payouts (affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS affiliate_payouts_status_idx ON public.affiliate_payouts (status);

-- ---------------------------------------------------------------------------
-- 6. affiliate_commissions (the ledger; base-currency minor units)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_commissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL,
  order_id uuid NULL,
  gateway public.affiliate_gateway NOT NULL,
  order_currency text NOT NULL,
  order_net_amount_minor bigint NOT NULL,
  exchange_rate_snapshot numeric(20,10) NOT NULL DEFAULT 1,
  net_order_amount_cents bigint NOT NULL,
  commission_rate_snapshot numeric(5,2) NOT NULL,
  commission_amount_cents bigint NOT NULL,
  refunded_amount_cents bigint NOT NULL DEFAULT 0,
  refund_pending_cents bigint NOT NULL DEFAULT 0,
  void_requested_at timestamptz NULL,
  disputed_at timestamptz NULL,
  currency text NOT NULL DEFAULT 'USD',
  livemode boolean NOT NULL DEFAULT true,
  status public.affiliate_commission_status NOT NULL DEFAULT 'PENDING_CLEARANCE',
  clears_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  cleared_at timestamptz NULL,
  paid_at timestamptz NULL,
  voided_at timestamptz NULL,
  void_reason text NULL,
  payout_id uuid NULL,
  stripe_transfer_id text NULL,
  notified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_commissions_pkey PRIMARY KEY (id),
  -- order_id first: the orders triggers and the refund RPC look commissions up by order (A9)
  CONSTRAINT affiliate_commissions_order_gateway_key UNIQUE (order_id, gateway),
  CONSTRAINT affiliate_commissions_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliate_profiles (id) ON DELETE CASCADE,
  CONSTRAINT affiliate_commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders (id) ON DELETE SET NULL,
  CONSTRAINT affiliate_commissions_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES public.affiliate_payouts (id) ON DELETE SET NULL,
  CONSTRAINT affiliate_commissions_order_currency_check CHECK (order_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT affiliate_commissions_order_net_amount_minor_check CHECK (order_net_amount_minor >= 0),
  CONSTRAINT affiliate_commissions_exchange_rate_snapshot_check CHECK (exchange_rate_snapshot > 0),
  CONSTRAINT affiliate_commissions_net_order_amount_cents_check CHECK (net_order_amount_cents >= 0),
  CONSTRAINT affiliate_commissions_commission_rate_snapshot_check CHECK (commission_rate_snapshot >= 0 AND commission_rate_snapshot <= 100),
  CONSTRAINT affiliate_commissions_commission_amount_cents_check CHECK (commission_amount_cents >= 0),
  CONSTRAINT affiliate_commissions_refunded_amount_cents_check CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= commission_amount_cents),
  CONSTRAINT affiliate_commissions_refund_pending_cents_check CHECK (refund_pending_cents >= 0 AND refund_pending_cents <= commission_amount_cents),
  CONSTRAINT affiliate_commissions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT affiliate_commissions_void_reason_check CHECK (void_reason IS NULL OR char_length(void_reason) <= 500)
);

CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_status_idx ON public.affiliate_commissions (affiliate_id, status);
CREATE INDEX IF NOT EXISTS affiliate_commissions_status_clears_at_idx ON public.affiliate_commissions (status, clears_at);
CREATE INDEX IF NOT EXISTS affiliate_commissions_payout_id_idx ON public.affiliate_commissions (payout_id);
CREATE INDEX IF NOT EXISTS affiliate_commissions_unnotified_idx ON public.affiliate_commissions (created_at) WHERE notified_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7. affiliate_click_events (service role only; 30-day rolling window)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_click_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL,
  visitor_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_click_events_pkey PRIMARY KEY (id),
  CONSTRAINT affiliate_click_events_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliate_profiles (id) ON DELETE CASCADE,
  CONSTRAINT affiliate_click_events_visitor_hash_check CHECK (char_length(visitor_hash) <= 128)
);

CREATE INDEX IF NOT EXISTS affiliate_click_events_dedupe_idx ON public.affiliate_click_events (affiliate_id, visitor_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS affiliate_click_events_visitor_idx ON public.affiliate_click_events (visitor_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS affiliate_click_events_affiliate_created_idx ON public.affiliate_click_events (affiliate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS affiliate_click_events_created_at_idx ON public.affiliate_click_events (created_at);

-- ---------------------------------------------------------------------------
-- 8. affiliate_payout_runs (service role only; one claim per UTC day)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliate_payout_runs (
  run_date date NOT NULL,
  trigger text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT affiliate_payout_runs_pkey PRIMARY KEY (run_date),
  CONSTRAINT affiliate_payout_runs_trigger_check CHECK (char_length(trigger) BETWEEN 1 AND 64)
);

-- ---------------------------------------------------------------------------
-- 9. orders: attribution columns (no grant change: the table grants cover new columns)
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_id uuid NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_source text NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_base_currency text NULL;
-- the payment mode of an attributed checkout, written with the attribution (C)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_livemode boolean NULL;
-- a partial refund that arrives before the order has a commission (Y): the largest cumulative
-- refund and the charge total it was measured against, written by apply_affiliate_refund()
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_refunded_minor bigint NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_refund_total_minor bigint NULL;

DO $nb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_id_fkey' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliate_profiles (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_source_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_source_check CHECK (affiliate_source IS NULL OR affiliate_source IN ('storefront', 'referral_link'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_base_currency_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_base_currency_check CHECK (affiliate_base_currency IS NULL OR affiliate_base_currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_refunded_minor_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_refunded_minor_check CHECK (affiliate_refunded_minor IS NULL OR affiliate_refunded_minor >= 0);
  END IF;
  -- written together: a refund is meaningless without the charge it was measured against
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_refund_total_minor_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_refund_total_minor_check CHECK (
        (affiliate_refund_total_minor IS NULL) = (affiliate_refunded_minor IS NULL)
        AND (affiliate_refund_total_minor IS NULL OR affiliate_refund_total_minor > 0));
  END IF;
END
$nb$;

CREATE INDEX IF NOT EXISTS orders_affiliate_id_idx ON public.orders (affiliate_id) WHERE affiliate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_payment_intent_id_idx ON public.orders (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 10. system_alerts: the affiliate alert types
-- ---------------------------------------------------------------------------
-- NOT VALID first so the add cannot fail half-way; every existing row holds one of the two
-- previous types, so the VALIDATE that follows passes.
ALTER TABLE public.system_alerts DROP CONSTRAINT IF EXISTS system_alerts_alert_type_check;
ALTER TABLE public.system_alerts
  ADD CONSTRAINT system_alerts_alert_type_check CHECK (alert_type = ANY (ARRAY[
    'merge_conflict', 'runtime_update_available',
    'affiliate_signed_up', 'affiliate_profile_completed', 'affiliate_payout_configured',
    'affiliate_page_submitted', 'affiliate_payout_failed', 'affiliate_refund_after_payout'
  ]::text[])) NOT VALID;
ALTER TABLE public.system_alerts VALIDATE CONSTRAINT system_alerts_alert_type_check;

COMMENT ON TABLE public.system_alerts IS 'System notifications for the CMS: the automated upstream-update architecture (merge conflicts, runtime updates available) and the affiliates package (partner lifecycle, payout failures, refunds after a payout). Written by service-role (and the affiliate SECURITY DEFINER functions); read by ADMINs.';
COMMENT ON COLUMN public.system_alerts.alert_type IS 'One of: merge_conflict, runtime_update_available, affiliate_signed_up, affiliate_profile_completed, affiliate_payout_configured, affiliate_page_submitted, affiliate_payout_failed, affiliate_refund_after_payout.';

-- ---------------------------------------------------------------------------
-- 11. updated_at triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS affiliate_tiers_set_updated_at ON public.affiliate_tiers;
CREATE TRIGGER affiliate_tiers_set_updated_at BEFORE UPDATE ON public.affiliate_tiers FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
DROP TRIGGER IF EXISTS affiliate_profiles_set_updated_at ON public.affiliate_profiles;
CREATE TRIGGER affiliate_profiles_set_updated_at BEFORE UPDATE ON public.affiliate_profiles FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
DROP TRIGGER IF EXISTS affiliate_pages_set_updated_at ON public.affiliate_pages;
CREATE TRIGGER affiliate_pages_set_updated_at BEFORE UPDATE ON public.affiliate_pages FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
DROP TRIGGER IF EXISTS affiliate_payouts_set_updated_at ON public.affiliate_payouts;
CREATE TRIGGER affiliate_payouts_set_updated_at BEFORE UPDATE ON public.affiliate_payouts FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
DROP TRIGGER IF EXISTS affiliate_commissions_set_updated_at ON public.affiliate_commissions;
CREATE TRIGGER affiliate_commissions_set_updated_at BEFORE UPDATE ON public.affiliate_commissions FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- ---------------------------------------------------------------------------
-- 12a. private helpers: currency factor, email normalisation, refund alert
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

-- Minor units per major unit; mirrors getCurrencyMinorUnitFactor() in libs/utils (zero-decimal
-- currencies are 1, everything else 100).
CREATE OR REPLACE FUNCTION private.affiliate_currency_factor(p_code text)
    RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT CASE
    WHEN upper(btrim(coalesce(p_code, ''))) = ANY (ARRAY['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])
      THEN 1
    ELSE 100
  END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_currency_factor(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_currency_factor(text) TO service_role;

-- The part of a commission a cumulative refund takes back (finding I), used by
-- apply_affiliate_refund() and by affiliate_record_commission() for a refund that came first.
-- The commission was earned on the goods (no tax, no shipping), but a refund carries no
-- breakdown: shipping is taken to be refunded last and tax with the goods it was charged on.
-- So the base is the charge minus the order's shipping share (p_total_minor scaled by the
-- order's own shipping / total ratio, which keeps it unit-agnostic), the share is pro rata on
-- it, and a refund of everything but shipping takes the whole commission. Without shipping it
-- is the plain ratio refunded / charge. 0 for a non-positive commission, refund or charge.
CREATE OR REPLACE FUNCTION private.affiliate_refund_share(
    p_commission bigint, p_refunded_minor bigint, p_total_minor bigint, p_order_total bigint, p_order_shipping bigint)
    RETURNS bigint
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT CASE
    WHEN coalesce(p_commission, 0) <= 0 OR coalesce(p_refunded_minor, 0) <= 0 OR coalesce(p_total_minor, 0) <= 0 THEN 0::bigint
    ELSE LEAST(p_commission, round(p_commission::numeric * LEAST(p_refunded_minor, b.base) / b.base)::bigint)
  END
  FROM (
    SELECT GREATEST(p_total_minor - CASE
             WHEN coalesce(p_order_total, 0) > 0 AND coalesce(p_order_shipping, 0) > 0
               THEN round(p_total_minor::numeric * LEAST(p_order_shipping, p_order_total) / p_order_total)::bigint
             ELSE 0
           END, 1) AS base
  ) AS b;
$$;

REVOKE ALL ON FUNCTION private.affiliate_refund_share(bigint, bigint, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_refund_share(bigint, bigint, bigint, bigint, bigint) TO service_role;

-- Self-referral comparison key (A13); mirrored by normalizeAffiliateEmail() in the lib: trim,
-- lower-case, split at the LAST '@', drop a '+tag' from the local part, and for gmail.com /
-- googlemail.com drop every dot from the local part and use gmail.com. NULL for a blank input;
-- an input without '@' comes back trimmed and lower-cased.
CREATE OR REPLACE FUNCTION private.affiliate_normalize_email(p_email text)
    RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_email text := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g'));
  v_at integer;
  v_local text;
  v_domain text;
BEGIN
  IF v_email = '' THEN
    RETURN NULL;
  END IF;
  IF strpos(v_email, '@') = 0 THEN
    RETURN v_email;
  END IF;
  v_at := length(v_email) - strpos(reverse(v_email), '@') + 1;
  v_local := left(v_email, v_at - 1);
  v_domain := substr(v_email, v_at + 1);
  IF strpos(v_local, '+') > 0 THEN
    v_local := left(v_local, strpos(v_local, '+') - 1);
  END IF;
  IF v_domain IN ('gmail.com', 'googlemail.com') THEN
    v_local := replace(v_local, '.', '');
    v_domain := 'gmail.com';
  END IF;
  RETURN v_local || '@' || v_domain;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_normalize_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_normalize_email(text) TO service_role;

-- One unresolved affiliate_refund_after_payout alert per commission (A19 text and metadata).
CREATE OR REPLACE FUNCTION private.affiliate_alert_refund_after_payout(
    p_commission_id uuid, p_affiliate_id uuid, p_order_id uuid, p_payout_id uuid, p_reason text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_commission_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.system_alerts a
     WHERE a.alert_type = 'affiliate_refund_after_payout'
       AND a.is_resolved = false
       AND a.metadata ->> 'commission_id' = p_commission_id::text
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.system_alerts (alert_type, title, message, metadata)
  VALUES (
    'affiliate_refund_after_payout',
    'Refund after an affiliate payout',
    CASE
      WHEN p_reason = 'order_deleted' THEN
        format('Order %s was deleted after its commission was paid or queued. Reverse the transfer in Stripe if needed.', coalesce(p_order_id::text, 'unknown'))
      ELSE
        format('Order %s was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.', coalesce(p_order_id::text, 'unknown'))
    END,
    jsonb_build_object(
      'commission_id', p_commission_id,
      'affiliate_id', p_affiliate_id,
      'order_id', p_order_id,
      'payout_id', p_payout_id,
      'reason', p_reason,
      'action_url', '/cms/affiliates/payouts',
      'action_label', 'Review payouts'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_alert_refund_after_payout(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_alert_refund_after_payout(uuid, uuid, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 12b. trigger functions on affiliate_profiles / affiliate_pages
-- ---------------------------------------------------------------------------
-- member_count follows the profiles in each tier (never below 0). Both rows of a tier move are
-- updated in one statement so two opposite moves lock them in the same order.
CREATE OR REPLACE FUNCTION private.affiliate_tier_member_count()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.affiliate_tiers SET member_count = member_count + 1 WHERE id = NEW.tier_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.affiliate_tiers SET member_count = GREATEST(member_count - 1, 0) WHERE id = OLD.tier_id;
  ELSIF NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
    UPDATE public.affiliate_tiers
       SET member_count = CASE WHEN id = NEW.tier_id THEN member_count + 1 ELSE GREATEST(member_count - 1, 0) END
     WHERE id IN (OLD.tier_id, NEW.tier_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Trigger functions are never called by API roles (02013, 02021).
REVOKE ALL ON FUNCTION private.affiliate_tier_member_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_tier_member_count() TO service_role;

-- A request that carries a user session (auth.uid() is set) and is not an ADMIN on a satisfied
-- second factor may not change any column the partner does not own. It keys off the session,
-- not the SQL role (02021's protect_profile_role reasoning): service_role and postgres carry no
-- session. total_clicks / last_click_at are not on the list (record_affiliate_click() bumps
-- them from any session; the column grants already pin them, A15). The same session may not
-- change display_name, bio or social_links while the partner's page is PENDING_REVIEW either
-- (finding A): approval snapshots them, and the portal withdraws the submission first. The review
-- lock is session-scoped on purpose: server writes (portal actions, the upload route, the
-- sandbox demo) carry no session and are held by the app, whose Approve pins the profile the
-- reviewer saw. Then, for every writer: the handle is lower-cased and onboarding_step is
-- recomputed from the lifecycle timestamps.
CREATE OR REPLACE FUNCTION private.affiliate_profile_guard()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (SELECT auth.uid()) IS NOT NULL
     AND (SELECT public.is_admin_mfa()) IS NOT TRUE
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.tier_id IS DISTINCT FROM OLD.tier_id
          OR NEW.handle IS DISTINCT FROM OLD.handle
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
          OR NEW.avatar_object_key IS DISTINCT FROM OLD.avatar_object_key
          OR NEW.onboarding_step IS DISTINCT FROM OLD.onboarding_step
          OR NEW.stripe_connect_account_id IS DISTINCT FROM OLD.stripe_connect_account_id
          OR NEW.stripe_connect_livemode IS DISTINCT FROM OLD.stripe_connect_livemode
          OR NEW.stripe_connect_onboarding_complete IS DISTINCT FROM OLD.stripe_connect_onboarding_complete
          OR NEW.stripe_connect_details_submitted IS DISTINCT FROM OLD.stripe_connect_details_submitted
          OR NEW.stripe_connect_payouts_enabled IS DISTINCT FROM OLD.stripe_connect_payouts_enabled
          OR NEW.stripe_connect_checked_at IS DISTINCT FROM OLD.stripe_connect_checked_at
          OR NEW.total_earned_cents IS DISTINCT FROM OLD.total_earned_cents
          OR NEW.total_paid_cents IS DISTINCT FROM OLD.total_paid_cents
          OR NEW.profile_completed_at IS DISTINCT FROM OLD.profile_completed_at
          OR NEW.payout_configured_at IS DISTINCT FROM OLD.payout_configured_at
          OR NEW.page_submitted_at IS DISTINCT FROM OLD.page_submitted_at
          OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at
          OR NEW.signup_ip_masked IS DISTINCT FROM OLD.signup_ip_masked
          OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  THEN
    RAISE EXCEPTION 'affiliate_profile_field_protected'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Only an administrator or the server can change this partner field.';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (SELECT auth.uid()) IS NOT NULL
     AND (SELECT public.is_admin_mfa()) IS NOT TRUE
     AND (NEW.display_name IS DISTINCT FROM OLD.display_name
          OR NEW.bio IS DISTINCT FROM OLD.bio
          OR NEW.social_links IS DISTINCT FROM OLD.social_links)
     AND EXISTS (
       SELECT 1 FROM public.affiliate_pages pg
        WHERE pg.affiliate_id = OLD.id
          AND pg.approval_status = 'PENDING_REVIEW'::public.affiliate_page_status)
  THEN
    RAISE EXCEPTION 'affiliate_profile_pending_review'
      USING ERRCODE = '55000',
            HINT = 'Withdraw the submission before editing the public profile.';
  END IF;

  NEW.handle := lower(NEW.handle);
  NEW.onboarding_step := CASE
    WHEN NEW.first_published_at IS NOT NULL THEN 'ACTIVE_PUBLISHED'::public.affiliate_onboarding_step
    WHEN NEW.page_submitted_at IS NOT NULL THEN 'PAGE_SUBMITTED'::public.affiliate_onboarding_step
    WHEN NEW.payout_configured_at IS NOT NULL THEN 'PAYOUT_CONFIGURED'::public.affiliate_onboarding_step
    WHEN NEW.profile_completed_at IS NOT NULL THEN 'PROFILE_COMPLETED'::public.affiliate_onboarding_step
    ELSE 'SIGNED_UP'::public.affiliate_onboarding_step
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_profile_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_profile_guard() TO service_role;

-- In this order (A16): (1) a non-admin session changing a review or publication column is
-- refused, judged on NEW as the statement wrote it; (2) nobody edits the draft while it waits for
-- review (the portal withdraws the submission first); (3) a draft edit bumps draft_version and
-- draft_updated_at, and sends a PUBLISHED or CHANGES_REQUESTED page back to DRAFT unless the
-- statement set the status itself. Approving and requesting changes never write draft columns.
CREATE OR REPLACE FUNCTION private.affiliate_page_guard()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_draft_changed boolean;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND (SELECT public.is_admin_mfa()) IS NOT TRUE
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.affiliate_id IS DISTINCT FROM OLD.affiliate_id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.published_content IS DISTINCT FROM OLD.published_content
          OR NEW.published_title IS DISTINCT FROM OLD.published_title
          OR NEW.published_meta_description IS DISTINCT FROM OLD.published_meta_description
          OR NEW.published_profile IS DISTINCT FROM OLD.published_profile
          OR NEW.published_featured_product_ids IS DISTINCT FROM OLD.published_featured_product_ids
          OR NEW.published_at IS DISTINCT FROM OLD.published_at
          OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
          OR NEW.admin_feedback_note IS DISTINCT FROM OLD.admin_feedback_note
          OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
          OR NEW.submitted_version IS DISTINCT FROM OLD.submitted_version
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
          OR NEW.draft_version IS DISTINCT FROM OLD.draft_version
          OR NEW.draft_updated_at IS DISTINCT FROM OLD.draft_updated_at
          OR NEW.created_at IS DISTINCT FROM OLD.created_at)
  THEN
    RAISE EXCEPTION 'affiliate_page_field_protected'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Only an administrator or the server can change the review and publication fields.';
  END IF;

  v_draft_changed := NEW.title IS DISTINCT FROM OLD.title
    OR NEW.meta_description IS DISTINCT FROM OLD.meta_description
    OR NEW.draft_content IS DISTINCT FROM OLD.draft_content
    OR NEW.featured_product_ids IS DISTINCT FROM OLD.featured_product_ids;

  IF v_draft_changed THEN
    IF OLD.approval_status = 'PENDING_REVIEW'::public.affiliate_page_status THEN
      RAISE EXCEPTION 'affiliate_page_pending_review'
        USING ERRCODE = '55000',
              HINT = 'Withdraw the submission before editing the draft.';
    END IF;
    NEW.draft_version := OLD.draft_version + 1;
    NEW.draft_updated_at := now();
    IF OLD.approval_status IN ('PUBLISHED'::public.affiliate_page_status, 'CHANGES_REQUESTED'::public.affiliate_page_status)
       AND NEW.approval_status = OLD.approval_status THEN
      NEW.approval_status := 'DRAFT'::public.affiliate_page_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_page_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_page_guard() TO service_role;

DROP TRIGGER IF EXISTS affiliate_profile_guard ON public.affiliate_profiles;
CREATE TRIGGER affiliate_profile_guard
  BEFORE INSERT OR UPDATE ON public.affiliate_profiles
  FOR EACH ROW EXECUTE FUNCTION private.affiliate_profile_guard();

DROP TRIGGER IF EXISTS affiliate_tier_member_count ON public.affiliate_profiles;
CREATE TRIGGER affiliate_tier_member_count
  AFTER INSERT OR DELETE OR UPDATE OF tier_id ON public.affiliate_profiles
  FOR EACH ROW EXECUTE FUNCTION private.affiliate_tier_member_count();

DROP TRIGGER IF EXISTS affiliate_page_guard ON public.affiliate_pages;
CREATE TRIGGER affiliate_page_guard
  BEFORE UPDATE ON public.affiliate_pages
  FOR EACH ROW EXECUTE FUNCTION private.affiliate_page_guard();

-- ---------------------------------------------------------------------------
-- 12c. the ledger core: void and record (SECURITY DEFINER, service role + the triggers)
-- ---------------------------------------------------------------------------
-- Voids every live commission of an order and returns how many it voided. A commission is live
-- while PENDING_CLEARANCE or CLEARED and not in flight: unattached, or attached to a FAILED
-- payout (it is detached). A PAID commission, or one attached to a PROCESSING / COMPLETED payout,
-- keeps its amounts (the money left or is leaving): it gets void_requested_at (applied if that
-- payout fails) and an affiliate_refund_after_payout alert. Lock order (A2): profile, then the
-- order's commissions, then each payout's status in its own statement.
CREATE OR REPLACE FUNCTION private.affiliate_void_order_commissions(p_order_id uuid, p_reason text)
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'refunded'), 500);
  v_affiliate uuid;
  v_commission record;
  v_payout_status text;
  v_voided integer := 0;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_affiliate IN
    SELECT DISTINCT c.affiliate_id FROM public.affiliate_commissions c WHERE c.order_id = p_order_id ORDER BY 1
  LOOP
    PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
    PERFORM 1 FROM public.affiliate_commissions c WHERE c.order_id = p_order_id AND c.affiliate_id = v_affiliate FOR UPDATE;

    FOR v_commission IN
      SELECT c.id, c.status::text AS status, c.payout_id, c.commission_amount_cents, c.refunded_amount_cents
        FROM public.affiliate_commissions c
       WHERE c.order_id = p_order_id AND c.affiliate_id = v_affiliate
       ORDER BY c.created_at, c.id
    LOOP
      v_payout_status := NULL;
      IF v_commission.payout_id IS NOT NULL THEN
        SELECT po.status::text INTO v_payout_status FROM public.affiliate_payouts po WHERE po.id = v_commission.payout_id;
      END IF;

      IF v_commission.status IN ('PENDING_CLEARANCE', 'CLEARED')
         AND (v_commission.payout_id IS NULL OR v_payout_status IS NULL OR v_payout_status = 'FAILED') THEN
        UPDATE public.affiliate_commissions
           SET status = 'VOIDED_REFUND', voided_at = now(), void_reason = v_reason, payout_id = NULL
         WHERE id = v_commission.id;
        UPDATE public.affiliate_profiles
           SET total_earned_cents = GREATEST(total_earned_cents - (v_commission.commission_amount_cents - v_commission.refunded_amount_cents), 0)
         WHERE id = v_affiliate;
        v_voided := v_voided + 1;
      ELSIF v_commission.status = 'PAID'
         OR (v_commission.status IN ('PENDING_CLEARANCE', 'CLEARED') AND v_payout_status IN ('PROCESSING', 'COMPLETED')) THEN
        UPDATE public.affiliate_commissions
           SET void_requested_at = coalesce(void_requested_at, now()), void_reason = coalesce(void_reason, v_reason)
         WHERE id = v_commission.id;
        PERFORM private.affiliate_alert_refund_after_payout(v_commission.id, v_affiliate, p_order_id, v_commission.payout_id, v_reason);
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_voided;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_void_order_commissions(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_void_order_commissions(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION private.affiliate_void_commission_for_order(p_order_id uuid, p_reason text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM private.affiliate_void_order_commissions(p_order_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_void_commission_for_order(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_void_commission_for_order(uuid, text) TO service_role;

-- Records the commission of a paid, attributed order (idempotent: one row per order and
-- gateway, ON CONFLICT DO NOTHING) and returns its id, or NULL when nothing was recorded: the
-- order is not paid/shipped or not attributed, the partner is not ACTIVE or not approved yet
-- (first_published_at, A12), the buyer is the partner (same account, or the same normalised
-- e-mail, A13), or the commission rounds to 0. Amounts are in the base currency (A14). The row
-- carries the sale's key mode (orders.affiliate_livemode; true when unknown, C), and a partial
-- refund that arrived before it (kept on the order by apply_affiliate_refund, Y) is taken off
-- from the start with the same share rule: total_earned_cents grows by the rest only, and a
-- refund that takes the whole commission records it VOIDED_REFUND ('refunded').
CREATE OR REPLACE FUNCTION private.affiliate_record_commission(p_order_id uuid)
    RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_order record;
  v_profile record;
  v_tier record;
  v_buyer_email text;
  v_partner_email text;
  v_order_currency text;
  v_base_currency text;
  v_net_minor bigint;
  v_net_base bigint;
  v_rate numeric(20,10);
  v_commission bigint;
  v_refunded bigint;
  v_voided boolean;
  v_id uuid;
BEGIN
  SELECT o.id, o.user_id, o.status, o.total, o.subtotal, o.discount_total, o.shipping_total, o.currency,
         o.exchange_rate_at_purchase, o.provider, o.paid_at, o.affiliate_id,
         o.affiliate_base_currency, o.affiliate_livemode, o.affiliate_refunded_minor,
         o.affiliate_refund_total_minor, o.customer_details
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF NOT FOUND OR v_order.affiliate_id IS NULL OR v_order.paid_at IS NULL
     OR v_order.status IS NULL OR v_order.status NOT IN ('paid', 'shipped') THEN
    RETURN NULL;
  END IF;

  SELECT p.id, p.user_id, p.tier_id, p.status::text AS status, p.first_published_at
    INTO v_profile
    FROM public.affiliate_profiles p
   WHERE p.id = v_order.affiliate_id
   FOR UPDATE;

  IF NOT FOUND OR v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_order.user_id IS NOT NULL AND v_order.user_id = v_profile.user_id THEN
    RETURN NULL;
  END IF;
  v_buyer_email := private.affiliate_normalize_email(v_order.customer_details ->> 'email');
  IF v_buyer_email IS NOT NULL THEN
    SELECT private.affiliate_normalize_email(u.email::text) INTO v_partner_email
      FROM auth.users u
     WHERE u.id = v_profile.user_id;
    IF v_partner_email IS NOT NULL AND v_partner_email = v_buyer_email THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT t.commission_percentage, t.clearance_hold_days
    INTO v_tier
    FROM public.affiliate_tiers t
   WHERE t.id = v_profile.tier_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_order_currency := upper(btrim(coalesce(v_order.currency, 'USD')));
  v_base_currency := coalesce(
    nullif(upper(btrim(coalesce(v_order.affiliate_base_currency, ''))), ''),
    (SELECT upper(c.code) FROM public.currencies c
      WHERE c.is_default
      ORDER BY c.updated_at DESC, c.created_at DESC, c.code
      LIMIT 1),
    v_order_currency
  );

  v_net_minor := GREATEST(coalesce(v_order.subtotal, v_order.total)::bigint - coalesce(v_order.discount_total, 0)::bigint, 0);
  IF v_order_currency = v_base_currency THEN
    v_net_base := v_net_minor;
    v_rate := 1;
  ELSE
    v_rate := v_order.exchange_rate_at_purchase;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN NULL;
    END IF;
    v_net_base := round(
      (v_net_minor::numeric / private.affiliate_currency_factor(v_order_currency))
      / v_rate
      * private.affiliate_currency_factor(v_base_currency)
    )::bigint;
  END IF;

  v_commission := round(v_net_base::numeric * v_tier.commission_percentage / 100)::bigint;
  IF v_commission <= 0 THEN
    RETURN NULL;
  END IF;
  v_refunded := private.affiliate_refund_share(v_commission, v_order.affiliate_refunded_minor,
                                               v_order.affiliate_refund_total_minor, v_order.total, v_order.shipping_total);
  v_voided := v_refunded >= v_commission;

  INSERT INTO public.affiliate_commissions (
    affiliate_id, order_id, gateway, order_currency, order_net_amount_minor, exchange_rate_snapshot,
    net_order_amount_cents, commission_rate_snapshot, commission_amount_cents, refunded_amount_cents,
    currency, livemode, status, clears_at, voided_at, void_reason
  )
  VALUES (
    v_profile.id,
    v_order.id,
    CASE WHEN coalesce(v_order.provider, 'stripe') = 'freemius'
      THEN 'FREEMIUS'::public.affiliate_gateway
      ELSE 'STRIPE'::public.affiliate_gateway
    END,
    v_order_currency,
    v_net_minor,
    v_rate,
    v_net_base,
    v_tier.commission_percentage,
    v_commission,
    v_refunded,
    v_base_currency,
    coalesce(v_order.affiliate_livemode, true),
    CASE WHEN v_voided
      THEN 'VOIDED_REFUND'::public.affiliate_commission_status
      ELSE 'PENDING_CLEARANCE'::public.affiliate_commission_status
    END,
    now() + make_interval(days => v_tier.clearance_hold_days),
    CASE WHEN v_voided THEN now() END,
    CASE WHEN v_voided THEN 'refunded' END
  )
  ON CONFLICT ON CONSTRAINT affiliate_commissions_order_gateway_key DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL AND NOT v_voided THEN
    UPDATE public.affiliate_profiles SET total_earned_cents = total_earned_cents + (v_commission - v_refunded) WHERE id = v_profile.id;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_record_commission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_record_commission(uuid) TO service_role;

-- Work a payout row owes its commissions when it does not complete (A8): a void requested
-- while it was in flight is applied (the commission is voided and detached), and a partial
-- refund recorded meanwhile (refund_pending_cents) moves into refunded_amount_cents, with
-- total_earned_cents following; a pending refund that takes the whole commission voids it like
-- apply_affiliate_refund() does outside a payout (finding I). Callers hold the profile and
-- commission locks already.
CREATE OR REPLACE FUNCTION private.affiliate_apply_pending_payout_work(p_payout_id uuid)
    RETURNS void
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_commission record;
  v_new bigint;
BEGIN
  FOR v_commission IN
    SELECT c.id, c.affiliate_id, c.status::text AS status, c.commission_amount_cents, c.refunded_amount_cents,
           c.refund_pending_cents, c.void_requested_at
      FROM public.affiliate_commissions c
     WHERE c.payout_id = p_payout_id
     ORDER BY c.created_at, c.id
  LOOP
    IF v_commission.status NOT IN ('PENDING_CLEARANCE', 'CLEARED') THEN
      CONTINUE;
    END IF;
    IF v_commission.void_requested_at IS NOT NULL
       OR (v_commission.commission_amount_cents > 0
           AND v_commission.refund_pending_cents >= v_commission.commission_amount_cents) THEN
      UPDATE public.affiliate_commissions
         SET status = 'VOIDED_REFUND', voided_at = now(), void_reason = coalesce(void_reason, 'refunded'), payout_id = NULL
       WHERE id = v_commission.id;
      UPDATE public.affiliate_profiles
         SET total_earned_cents = GREATEST(total_earned_cents - (v_commission.commission_amount_cents - v_commission.refunded_amount_cents), 0)
       WHERE id = v_commission.affiliate_id;
    ELSIF v_commission.refund_pending_cents > v_commission.refunded_amount_cents THEN
      v_new := LEAST(v_commission.commission_amount_cents, v_commission.refund_pending_cents);
      UPDATE public.affiliate_commissions SET refunded_amount_cents = v_new WHERE id = v_commission.id;
      UPDATE public.affiliate_profiles
         SET total_earned_cents = GREATEST(total_earned_cents - (v_new - v_commission.refunded_amount_cents), 0)
       WHERE id = v_commission.affiliate_id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_apply_pending_payout_work(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_apply_pending_payout_work(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 12d. orders triggers
-- ---------------------------------------------------------------------------
-- Runs inside every "mark paid" write (assign_order_invoice_metadata()) and every status change.
-- Only the paid branch is wrapped (A5): recording can never fail an order update, and
-- reconcile_affiliate_commissions() repairs a commission it missed. A void that fails fails the
-- status update (the CMS shows the error; a webhook gets a 5xx and is redelivered).
CREATE OR REPLACE FUNCTION private.affiliate_on_order_change()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND NEW.affiliate_id IS NOT NULL THEN
    BEGIN
      PERFORM private.affiliate_record_commission(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'affiliate commission hook failed for order %: %', NEW.id, SQLERRM;
    END;
  END IF;

  IF NEW.status IN ('refunded', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM private.affiliate_void_order_commissions(NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_on_order_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_on_order_change() TO service_role;

-- A deleted order takes its live commissions with it (A10); paid or in-flight ones are flagged
-- and alerted instead. The commissions' order_id then goes NULL (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION private.affiliate_on_order_delete()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM private.affiliate_void_order_commissions(OLD.id, 'order_deleted');
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION private.affiliate_on_order_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_on_order_delete() TO service_role;

DROP TRIGGER IF EXISTS affiliate_on_order_change ON public.orders;
CREATE TRIGGER affiliate_on_order_change
  AFTER UPDATE OF paid_at, status ON public.orders
  FOR EACH ROW
  WHEN (OLD.paid_at IS DISTINCT FROM NEW.paid_at OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.affiliate_on_order_change();

DROP TRIGGER IF EXISTS affiliate_on_order_delete ON public.orders;
CREATE TRIGGER affiliate_on_order_delete
  BEFORE DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION private.affiliate_on_order_delete();

-- ---------------------------------------------------------------------------
-- 12e. anonymous storefront reads and the click counter
--      (definer in private + SECURITY INVOKER wrapper in public, 02021 pattern)
-- ---------------------------------------------------------------------------
-- A storefront is public while its partner is ACTIVE and approved (first_published_at, A12)
-- and an approved document exists. Only the approved snapshot is returned (published_*), never
-- a draft. updated_at is the last approval (published_at), so a draft autosave or a click never
-- moves a sitemap lastmod.
CREATE OR REPLACE FUNCTION private.get_affiliate_storefront(p_handle text)
    RETURNS TABLE(
      affiliate_id uuid, handle text, tier_name text, tier_name_translations jsonb, tier_badge_color text,
      tier_is_limited_time_promo boolean, published_profile jsonb, published_title text,
      published_meta_description text, published_content jsonb, published_featured_product_ids uuid[],
      published_at timestamptz, updated_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p.id, p.handle, t.name, t.name_translations, t.badge_color, t.is_limited_time_promo,
         pg.published_profile, pg.published_title, pg.published_meta_description, pg.published_content,
         pg.published_featured_product_ids, pg.published_at, coalesce(pg.published_at, pg.updated_at)
    FROM public.affiliate_profiles p
    JOIN public.affiliate_tiers t ON t.id = p.tier_id
    JOIN public.affiliate_pages pg ON pg.affiliate_id = p.id
   WHERE p_handle IS NOT NULL
     AND lower(p_handle) ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'
     AND p.handle = lower(p_handle)
     AND p.status = 'ACTIVE'::public.affiliate_status
     AND p.first_published_at IS NOT NULL
     AND pg.published_content IS NOT NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private.get_affiliate_storefront(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.get_affiliate_storefront(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_affiliate_storefront(p_handle text)
    RETURNS TABLE(
      affiliate_id uuid, handle text, tier_name text, tier_name_translations jsonb, tier_badge_color text,
      tier_is_limited_time_promo boolean, published_profile jsonb, published_title text,
      published_meta_description text, published_content jsonb, published_featured_product_ids uuid[],
      published_at timestamptz, updated_at timestamptz)
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  SELECT * FROM private.get_affiliate_storefront(p_handle);
$$;

REVOKE ALL ON FUNCTION public.get_affiliate_storefront(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_affiliate_storefront(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.list_affiliate_storefronts(p_limit integer DEFAULT 5000)
    RETURNS TABLE(handle text, published_at timestamptz, updated_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p.handle, pg.published_at, coalesce(pg.published_at, pg.updated_at)
    FROM public.affiliate_profiles p
    JOIN public.affiliate_pages pg ON pg.affiliate_id = p.id
   WHERE p.status = 'ACTIVE'::public.affiliate_status
     AND p.first_published_at IS NOT NULL
     AND pg.published_content IS NOT NULL
   ORDER BY p.handle
   LIMIT LEAST(GREATEST(coalesce(p_limit, 5000), 1), 5000);
$$;

REVOKE ALL ON FUNCTION private.list_affiliate_storefronts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.list_affiliate_storefronts(integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_affiliate_storefronts(p_limit integer DEFAULT 5000)
    RETURNS TABLE(handle text, published_at timestamptz, updated_at timestamptz)
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  SELECT * FROM private.list_affiliate_storefronts(p_limit);
$$;

REVOKE ALL ON FUNCTION public.list_affiliate_storefronts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_affiliate_storefronts(integer) TO anon, authenticated, service_role;

-- The proxy's referral-cookie lifetime: the tier's cookie_duration_days for an ACTIVE, approved
-- partner, else NULL (no cookie).
CREATE OR REPLACE FUNCTION private.get_affiliate_referral_window(p_handle text)
    RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT t.cookie_duration_days
    FROM public.affiliate_profiles p
    JOIN public.affiliate_tiers t ON t.id = p.tier_id
   WHERE p_handle IS NOT NULL
     AND lower(p_handle) ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'
     AND p.handle = lower(p_handle)
     AND p.status = 'ACTIVE'::public.affiliate_status
     AND p.first_published_at IS NOT NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private.get_affiliate_referral_window(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.get_affiliate_referral_window(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_affiliate_referral_window(p_handle text)
    RETURNS integer
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  SELECT private.get_affiliate_referral_window(p_handle);
$$;

REVOKE ALL ON FUNCTION public.get_affiliate_referral_window(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_affiliate_referral_window(text) TO anon, authenticated, service_role;

-- One counted click per visitor hash per partner per 24 h, and the flood limits of A15: at most
-- 60 events per visitor hash per hour, 500 per partner per day and 2000 overall per minute.
-- Silently ignores anything else (malformed input, unknown or unapproved partner). Each call
-- also prunes up to 500 events older than 30 days. VOLATILE (it writes).
CREATE OR REPLACE FUNCTION private.record_affiliate_click(p_handle text, p_visitor_hash text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_handle text := lower(coalesce(p_handle, ''));
  v_affiliate uuid;
BEGIN
  IF v_handle !~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$' THEN
    RETURN;
  END IF;
  IF p_visitor_hash IS NULL OR p_visitor_hash !~ '^[a-f0-9]{16,64}$' THEN
    RETURN;
  END IF;

  SELECT p.id INTO v_affiliate
    FROM public.affiliate_profiles p
   WHERE p.handle = v_handle
     AND p.status = 'ACTIVE'::public.affiliate_status
     AND p.first_published_at IS NOT NULL;
  IF v_affiliate IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.affiliate_click_events e
     WHERE e.affiliate_id = v_affiliate AND e.visitor_hash = p_visitor_hash AND e.created_at > now() - interval '24 hours'
  ) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM (
        SELECT 1 FROM public.affiliate_click_events e
         WHERE e.visitor_hash = p_visitor_hash AND e.created_at > now() - interval '1 hour'
         LIMIT 60) AS recent) >= 60 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM (
        SELECT 1 FROM public.affiliate_click_events e
         WHERE e.affiliate_id = v_affiliate AND e.created_at > now() - interval '1 day'
         LIMIT 500) AS recent) >= 500 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM (
        SELECT 1 FROM public.affiliate_click_events e
         WHERE e.created_at > now() - interval '1 minute'
         LIMIT 2000) AS recent) >= 2000 THEN
    RETURN;
  END IF;

  INSERT INTO public.affiliate_click_events (affiliate_id, visitor_hash) VALUES (v_affiliate, p_visitor_hash);
  UPDATE public.affiliate_profiles SET total_clicks = total_clicks + 1, last_click_at = now() WHERE id = v_affiliate;

  DELETE FROM public.affiliate_click_events
   WHERE id IN (
     SELECT e.id FROM public.affiliate_click_events e
      WHERE e.created_at < now() - interval '30 days'
      ORDER BY e.created_at
      LIMIT 500
   );
END;
$$;

REVOKE ALL ON FUNCTION private.record_affiliate_click(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_affiliate_click(text, text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_affiliate_click(p_handle text, p_visitor_hash text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM private.record_affiliate_click(p_handle, p_visitor_hash);
END;
$$;

REVOKE ALL ON FUNCTION public.record_affiliate_click(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_affiliate_click(text, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12f. service-role RPCs (SECURITY INVOKER in public; revoked from the API roles here and in
--      both copies of API_ROLE_REVOKE_SQL)
-- ---------------------------------------------------------------------------
-- Partner sign-up. Errors (SQLSTATE P0001, message = code): affiliate_role_conflict (the account
-- is not USER or RTL, or has no profiles row), affiliate_exists, affiliate_handle_invalid,
-- affiliate_program_full (no active tier has room); a taken handle surfaces as SQLSTATE 23505
-- (affiliate_profiles_handle_key). The tier is the first active one, default sign-up tiers first
-- (highest sort_order first among them), then the rest by sort_order, that still has room; the
-- tier rows are locked so concurrent sign-ups cannot overfill a capped tier.
CREATE OR REPLACE FUNCTION public.create_affiliate_account(
    p_user_id uuid, p_handle text, p_display_name text, p_locale text, p_title text,
    p_meta_description text, p_starter_doc jsonb, p_signup_ip_masked text)
    RETURNS TABLE(
      affiliate_id uuid, page_id uuid, tier_id uuid, tier_name text, tier_slug text,
      commission_percentage numeric, is_limited_time_promo boolean, spots_remaining integer)
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_role text;
  v_handle text := lower(btrim(coalesce(p_handle, '')));
  v_locale text := lower(substr(btrim(coalesce(p_locale, '')), 1, 2));
  v_tier record;
  v_tier_id uuid;
  v_affiliate_id uuid;
  v_page_id uuid;
  v_chosen record;
BEGIN
  SELECT pr.role::text INTO v_role FROM public.profiles pr WHERE pr.id = p_user_id FOR UPDATE;
  IF v_role IS NULL OR v_role NOT IN ('USER', 'RTL') THEN
    RAISE EXCEPTION 'affiliate_role_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.affiliate_profiles ap WHERE ap.user_id = p_user_id) THEN
    RAISE EXCEPTION 'affiliate_exists' USING ERRCODE = 'P0001';
  END IF;

  IF v_handle !~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$' THEN
    RAISE EXCEPTION 'affiliate_handle_invalid' USING ERRCODE = 'P0001';
  END IF;

  FOR v_tier IN
    SELECT t.id, t.max_ambassadors_cap, t.member_count
      FROM public.affiliate_tiers t
     WHERE t.is_active
     ORDER BY t.is_default_signup_tier DESC,
              CASE WHEN t.is_default_signup_tier THEN -t.sort_order ELSE t.sort_order END,
              t.created_at
       FOR UPDATE
  LOOP
    IF v_tier.max_ambassadors_cap IS NULL OR v_tier.member_count < v_tier.max_ambassadors_cap THEN
      v_tier_id := v_tier.id;
      EXIT;
    END IF;
  END LOOP;

  IF v_tier_id IS NULL THEN
    RAISE EXCEPTION 'affiliate_program_full' USING ERRCODE = 'P0001';
  END IF;

  IF v_locale !~ '^[a-z]{2}$' THEN
    v_locale := 'en';
  END IF;

  INSERT INTO public.affiliate_profiles (user_id, tier_id, handle, display_name, preferred_locale, status, signup_ip_masked)
  VALUES (
    p_user_id, v_tier_id, v_handle, btrim(coalesce(p_display_name, '')), v_locale,
    'ACTIVE'::public.affiliate_status,
    left(nullif(btrim(coalesce(p_signup_ip_masked, '')), ''), 64)
  )
  RETURNING id INTO v_affiliate_id;

  INSERT INTO public.affiliate_pages (affiliate_id, user_id, title, meta_description, draft_content)
  VALUES (
    v_affiliate_id, p_user_id,
    left(btrim(coalesce(p_title, '')), 120),
    left(btrim(coalesce(p_meta_description, '')), 300),
    CASE
      WHEN jsonb_typeof(p_starter_doc) = 'object' AND octet_length(p_starter_doc::text) <= 262144 THEN p_starter_doc
      ELSE '{"type":"doc","content":[]}'::jsonb
    END
  )
  RETURNING id INTO v_page_id;

  UPDATE public.profiles SET role = 'RTL' WHERE id = p_user_id AND role::text = 'USER';

  -- member_count already counts this partner (AFTER INSERT trigger)
  SELECT t.id, t.name, t.slug, t.commission_percentage, t.is_limited_time_promo, t.max_ambassadors_cap, t.member_count
    INTO v_chosen
    FROM public.affiliate_tiers t
   WHERE t.id = v_tier_id;

  affiliate_id := v_affiliate_id;
  page_id := v_page_id;
  tier_id := v_chosen.id;
  tier_name := v_chosen.name;
  tier_slug := v_chosen.slug;
  commission_percentage := v_chosen.commission_percentage;
  is_limited_time_promo := v_chosen.is_limited_time_promo;
  spots_remaining := CASE
    WHEN v_chosen.max_ambassadors_cap IS NULL THEN NULL
    ELSE GREATEST(v_chosen.max_ambassadors_cap - v_chosen.member_count, 0)
  END;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_affiliate_account(uuid, text, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_affiliate_account(uuid, text, text, text, text, text, jsonb, text) TO service_role;

-- PENDING_CLEARANCE commissions whose clears_at has passed become CLEARED; those whose order
-- is refunded or cancelled are voided instead (A11). A commission an open dispute holds
-- (disputed_at, finding L) waits, whatever its clears_at. Returns how many were promoted.
-- Profiles are locked in id order so two concurrent runs cannot deadlock.
CREATE OR REPLACE FUNCTION public.promote_cleared_affiliate_commissions()
    RETURNS integer
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_order record;
  v_promoted integer := 0;
  v_count integer;
BEGIN
  FOR v_affiliate IN
    SELECT DISTINCT c.affiliate_id
      FROM public.affiliate_commissions c
     WHERE c.status = 'PENDING_CLEARANCE'::public.affiliate_commission_status
       AND c.clears_at <= now()
       AND c.disputed_at IS NULL
     ORDER BY 1
  LOOP
    PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
    PERFORM 1 FROM public.affiliate_commissions c
      WHERE c.affiliate_id = v_affiliate
        AND c.status = 'PENDING_CLEARANCE'::public.affiliate_commission_status
        AND c.clears_at <= now()
        AND c.disputed_at IS NULL
      FOR UPDATE;

    FOR v_order IN
      SELECT DISTINCT c.order_id, o.status
        FROM public.affiliate_commissions c
        JOIN public.orders o ON o.id = c.order_id
       WHERE c.affiliate_id = v_affiliate
         AND c.status = 'PENDING_CLEARANCE'::public.affiliate_commission_status
         AND c.clears_at <= now()
         AND c.disputed_at IS NULL
         AND o.status IN ('refunded', 'cancelled')
    LOOP
      PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);
    END LOOP;

    UPDATE public.affiliate_commissions c
       SET status = 'CLEARED'::public.affiliate_commission_status, cleared_at = now()
     WHERE c.affiliate_id = v_affiliate
       AND c.status = 'PENDING_CLEARANCE'::public.affiliate_commission_status
       AND c.clears_at <= now()
       AND c.disputed_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_promoted := v_promoted + v_count;
  END LOOP;
  RETURN v_promoted;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_cleared_affiliate_commissions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_cleared_affiliate_commissions() TO service_role;

-- Claims a payout for one partner and currency: the partner must be ACTIVE, approved and
-- onboarded to Stripe Connect with an account of a known key mode; CLEARED, unattached
-- commissions in p_currency of that mode (finding C: a test-mode sale is only ever paid by a
-- test-mode transfer, a live one by a live transfer) that no open dispute holds (finding L) are
-- locked, those whose order is now refunded or cancelled are voided (A11), and the rest are
-- attached to a new PROCESSING payout of sum(commission - refunded) with a snapshot of the
-- destination account and its mode. Returns no row when nothing is claimable or the sum is below
-- p_min_amount.
CREATE OR REPLACE FUNCTION public.claim_affiliate_payout(p_affiliate_id uuid, p_currency text, p_min_amount bigint, p_trigger text)
    RETURNS SETOF public.affiliate_payouts
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_profile record;
  v_order record;
  v_amount bigint;
  v_payout public.affiliate_payouts%ROWTYPE;
BEGIN
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RETURN;
  END IF;

  SELECT p.id, p.status::text AS status, p.first_published_at, p.stripe_connect_account_id,
         p.stripe_connect_onboarding_complete, p.stripe_connect_livemode
    INTO v_profile
    FROM public.affiliate_profiles p
   WHERE p.id = p_affiliate_id
   FOR UPDATE;
  IF NOT FOUND OR v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL
     OR v_profile.stripe_connect_account_id IS NULL OR NOT v_profile.stripe_connect_onboarding_complete
     OR v_profile.stripe_connect_livemode IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.affiliate_commissions c
    WHERE c.affiliate_id = p_affiliate_id
      AND c.status = 'CLEARED'::public.affiliate_commission_status
      AND c.payout_id IS NULL
      AND c.currency = v_currency
      AND c.livemode = v_profile.stripe_connect_livemode
      AND c.disputed_at IS NULL
    FOR UPDATE;

  FOR v_order IN
    SELECT DISTINCT c.order_id, o.status
      FROM public.affiliate_commissions c
      JOIN public.orders o ON o.id = c.order_id
     WHERE c.affiliate_id = p_affiliate_id
       AND c.status = 'CLEARED'::public.affiliate_commission_status
       AND c.payout_id IS NULL
       AND c.currency = v_currency
       AND c.livemode = v_profile.stripe_connect_livemode
       AND c.disputed_at IS NULL
       AND o.status IN ('refunded', 'cancelled')
  LOOP
    PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);
  END LOOP;

  SELECT coalesce(sum(c.commission_amount_cents - c.refunded_amount_cents), 0)::bigint
    INTO v_amount
    FROM public.affiliate_commissions c
   WHERE c.affiliate_id = p_affiliate_id
     AND c.status = 'CLEARED'::public.affiliate_commission_status
     AND c.payout_id IS NULL
     AND c.currency = v_currency
     AND c.livemode = v_profile.stripe_connect_livemode
     AND c.disputed_at IS NULL;
  IF v_amount <= 0 OR v_amount < coalesce(p_min_amount, 0) THEN
    RETURN;
  END IF;

  INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, stripe_destination_account, livemode, status, attempt_count, last_attempt_at, trigger)
  VALUES (p_affiliate_id, v_amount, v_currency, v_profile.stripe_connect_account_id, v_profile.stripe_connect_livemode,
          'PROCESSING'::public.affiliate_payout_status, 1, now(), coalesce(p_trigger, 'cron'))
  RETURNING * INTO v_payout;

  UPDATE public.affiliate_commissions c
     SET payout_id = v_payout.id
   WHERE c.affiliate_id = p_affiliate_id
     AND c.status = 'CLEARED'::public.affiliate_commission_status
     AND c.payout_id IS NULL
     AND c.currency = v_currency
     AND c.livemode = v_profile.stripe_connect_livemode
     AND c.disputed_at IS NULL;

  RETURN NEXT v_payout;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text) TO service_role;

-- PROCESSING (or FAILED, when reconciliation finds the transfer after all, B1; never a payout
-- whose commissions were handed back: released, nothing_to_pay or below_minimum) -> COMPLETED
-- with the transfer id; its commissions become PAID and the partner's total_paid_cents grows by
-- amount_cents. False when the payout cannot complete. Raises affiliate_transfer_id_required
-- (22023) without a transfer id.
CREATE OR REPLACE FUNCTION public.complete_affiliate_payout(p_payout_id uuid, p_transfer_id text)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_transfer text := nullif(btrim(coalesce(p_transfer_id, '')), '');
  v_affiliate uuid;
  v_payout record;
BEGIN
  IF v_transfer IS NULL THEN
    RAISE EXCEPTION 'affiliate_transfer_id_required' USING ERRCODE = '22023';
  END IF;

  SELECT po.affiliate_id INTO v_affiliate FROM public.affiliate_payouts po WHERE po.id = p_payout_id;
  IF v_affiliate IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.amount_cents, po.failure_reason
    INTO v_payout
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_payout.status = 'PROCESSING'
     OR (v_payout.status = 'FAILED' AND coalesce(v_payout.failure_reason, '') NOT IN ('released', 'nothing_to_pay', 'below_minimum')) THEN
    UPDATE public.affiliate_payouts
       SET status = 'COMPLETED'::public.affiliate_payout_status, paid_at = now(), stripe_transfer_id = v_transfer, failure_reason = NULL
     WHERE id = p_payout_id;
    UPDATE public.affiliate_commissions c
       SET status = 'PAID'::public.affiliate_commission_status, paid_at = now(), stripe_transfer_id = v_transfer
     WHERE c.payout_id = p_payout_id
       AND c.status IN ('PENDING_CLEARANCE'::public.affiliate_commission_status, 'CLEARED'::public.affiliate_commission_status);
    UPDATE public.affiliate_profiles SET total_paid_cents = total_paid_cents + v_payout.amount_cents WHERE id = v_affiliate;
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_affiliate_payout(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_affiliate_payout(uuid, text) TO service_role;

-- PROCESSING -> FAILED (reason trimmed to 500 characters) after applying the work the payout
-- owes its commissions (A8). False when the payout is not PROCESSING.
CREATE OR REPLACE FUNCTION public.fail_affiliate_payout(p_payout_id uuid, p_reason text)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_status text;
BEGIN
  SELECT po.affiliate_id INTO v_affiliate FROM public.affiliate_payouts po WHERE po.id = p_payout_id;
  IF v_affiliate IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text INTO v_status FROM public.affiliate_payouts po WHERE po.id = p_payout_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'PROCESSING' THEN
    RETURN false;
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);
  UPDATE public.affiliate_payouts
     SET status = 'FAILED'::public.affiliate_payout_status,
         failure_reason = left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'failed'), 500)
   WHERE id = p_payout_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_affiliate_payout(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_affiliate_payout(uuid, text) TO service_role;

-- FAILED -> PROCESSING for another attempt. Re-checks the claim conditions (ACTIVE, approved,
-- Connect onboarding complete, and an account of the payout's key mode: finding C, a payout
-- claimed in one mode is never re-sent in the other; no row and no change otherwise) and
-- refreshes the destination account from the profile (B1); applies the pending work (A8), voids
-- commissions whose order is refunded or cancelled, and detaches every voided one and every one
-- an open dispute holds (finding L); the new amount is the sum of the attached CLEARED
-- commissions (commission - refunded). Nothing left: the payout stays FAILED with failure_reason
-- 'nothing_to_pay'. Less than p_min_amount left (finding Z; the automatic retry passes the
-- program minimum, an admin Retry the default 0 and sends what is left): it stays FAILED with
-- 'below_minimum'. Either way attempt_count is unchanged, every commission is detached (back in
-- the cleared balance for a later claim) and no row is returned. The (uuid) overload of the first
-- 02030 text is dropped, so a one-argument call resolves to this one (no PGRST203).
DROP FUNCTION IF EXISTS public.prepare_affiliate_payout_retry(uuid);
CREATE OR REPLACE FUNCTION public.prepare_affiliate_payout_retry(p_payout_id uuid, p_min_amount bigint DEFAULT 0)
    RETURNS SETOF public.affiliate_payouts
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_profile record;
  v_current record;
  v_order record;
  v_amount bigint;
  v_payout public.affiliate_payouts%ROWTYPE;
BEGIN
  SELECT po.affiliate_id INTO v_affiliate FROM public.affiliate_payouts po WHERE po.id = p_payout_id;
  IF v_affiliate IS NULL THEN
    RETURN;
  END IF;
  SELECT p.status::text AS status, p.first_published_at, p.stripe_connect_account_id,
         p.stripe_connect_onboarding_complete, p.stripe_connect_livemode
    INTO v_profile
    FROM public.affiliate_profiles p
   WHERE p.id = v_affiliate
   FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.livemode
    INTO v_current
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id
   FOR UPDATE;
  IF v_current.status IS DISTINCT FROM 'FAILED' THEN
    RETURN;
  END IF;
  IF v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL
     OR v_profile.stripe_connect_account_id IS NULL OR NOT v_profile.stripe_connect_onboarding_complete
     OR v_profile.stripe_connect_livemode IS DISTINCT FROM v_current.livemode THEN
    RETURN;
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);

  FOR v_order IN
    SELECT DISTINCT c.order_id, o.status
      FROM public.affiliate_commissions c
      JOIN public.orders o ON o.id = c.order_id
     WHERE c.payout_id = p_payout_id
       AND c.status IN ('PENDING_CLEARANCE'::public.affiliate_commission_status, 'CLEARED'::public.affiliate_commission_status)
       AND o.status IN ('refunded', 'cancelled')
  LOOP
    PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);
  END LOOP;

  UPDATE public.affiliate_commissions c
     SET payout_id = NULL
   WHERE c.payout_id = p_payout_id
     AND (c.status = 'VOIDED_REFUND'::public.affiliate_commission_status OR c.disputed_at IS NOT NULL);

  SELECT coalesce(sum(c.commission_amount_cents - c.refunded_amount_cents), 0)::bigint
    INTO v_amount
    FROM public.affiliate_commissions c
   WHERE c.payout_id = p_payout_id AND c.status = 'CLEARED'::public.affiliate_commission_status;

  IF v_amount <= 0 OR v_amount < GREATEST(coalesce(p_min_amount, 0), 0) THEN
    UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;
    UPDATE public.affiliate_payouts
       SET failure_reason = CASE WHEN v_amount <= 0 THEN 'nothing_to_pay' ELSE 'below_minimum' END
     WHERE id = p_payout_id;
    RETURN;
  END IF;

  UPDATE public.affiliate_payouts
     SET status = 'PROCESSING'::public.affiliate_payout_status,
         attempt_count = attempt_count + 1,
         last_attempt_at = now(),
         amount_cents = v_amount,
         failure_reason = NULL,
         stripe_destination_account = v_profile.stripe_connect_account_id
   WHERE id = p_payout_id
  RETURNING * INTO v_payout;
  RETURN NEXT v_payout;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_affiliate_payout_retry(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_affiliate_payout_retry(uuid, bigint) TO service_role;

-- FAILED payout given up: pending work applied (A8), every commission detached (claimable by
-- the next payout), failure_reason 'released'. False when the payout is not FAILED.
CREATE OR REPLACE FUNCTION public.release_affiliate_payout(p_payout_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_status text;
BEGIN
  SELECT po.affiliate_id INTO v_affiliate FROM public.affiliate_payouts po WHERE po.id = p_payout_id;
  IF v_affiliate IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text INTO v_status FROM public.affiliate_payouts po WHERE po.id = p_payout_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'FAILED' THEN
    RETURN false;
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);
  UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;
  UPDATE public.affiliate_payouts SET failure_reason = 'released' WHERE id = p_payout_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_affiliate_payout(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_affiliate_payout(uuid) TO service_role;

-- One payout cycle per day: true for the caller that claims p_run_date (NULL = today in UTC),
-- false for every later caller.
CREATE OR REPLACE FUNCTION public.claim_affiliate_payout_run(p_run_date date, p_trigger text)
    RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  WITH claimed AS (
    INSERT INTO public.affiliate_payout_runs (run_date, trigger)
    VALUES (coalesce(p_run_date, (now() AT TIME ZONE 'UTC')::date), left(coalesce(nullif(btrim(p_trigger), ''), 'cron'), 64))
    ON CONFLICT (run_date) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.claim_affiliate_payout_run(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_affiliate_payout_run(date, text) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_affiliate_payout_run(p_run_date date, p_summary jsonb)
    RETURNS void
    LANGUAGE sql VOLATILE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  UPDATE public.affiliate_payout_runs
     SET finished_at = now(),
         summary = CASE WHEN jsonb_typeof(p_summary) = 'object' THEN p_summary ELSE '{}'::jsonb END
   WHERE run_date = coalesce(p_run_date, (now() AT TIME ZONE 'UTC')::date);
$$;

REVOKE ALL ON FUNCTION public.finish_affiliate_payout_run(date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_affiliate_payout_run(date, jsonb) TO service_role;

-- Claims up to p_limit (1..200, default 50) commissions that still need their "you earned"
-- e-mail, oldest first, skipping voided rows and zero-amount tombstones (A25); rows locked by a
-- concurrent sweep are skipped, so two sweeps never claim the same commission.
CREATE OR REPLACE FUNCTION public.claim_affiliate_commission_notifications(p_limit integer)
    RETURNS SETOF public.affiliate_commissions
    LANGUAGE sql VOLATILE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  UPDATE public.affiliate_commissions c
     SET notified_at = now()
   WHERE c.id IN (
     SELECT c2.id
       FROM public.affiliate_commissions c2
      WHERE c2.notified_at IS NULL
        AND c2.status <> 'VOIDED_REFUND'::public.affiliate_commission_status
        AND c2.commission_amount_cents > 0
      ORDER BY c2.created_at
      LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING c.*;
$$;

REVOKE ALL ON FUNCTION public.claim_affiliate_commission_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_affiliate_commission_notifications(integer) TO service_role;

-- Refund handling for both gateways (A7). Returns 'voided' | 'adjusted' | 'alerted' | 'none'.
--   full (p_full, a non-positive total, or refunded >= total): live commissions of the order are
--     voided ('voided'); a paid or in-flight one gets void_requested_at and an alert ('alerted');
--     an attributed order with no commission yet gets a zero-amount VOIDED_REFUND tombstone
--     (void_reason 'refunded_before_commission') so the paid trigger never records one later.
--   partial: refunded_amount_cents rises to private.affiliate_refund_share() of the cumulative
--     refund (pro rata on the charge minus the order's shipping share, finding I) and never falls
--     (out-of-order events cannot raise earnings), total_earned_cents follows ('adjusted', or
--     'none' when nothing changes); a share that takes the whole commission (everything but
--     shipping came back) voids it ('voided'); a paid or in-flight commission keeps its amounts,
--     records refund_pending_cents and alerts ('alerted'). An attributed order with no commission
--     yet keeps the largest cumulative refund (orders.affiliate_refunded_minor and the charge
--     total, finding Y), and the commission recorded later starts from it ('none').
-- Lock order: the order row first (the orders triggers hold it while they record or void, so a
-- refund racing the paid update waits instead of deadlocking), then A2: the profile, the
-- commission (re-read under the lock), the payout status.
CREATE OR REPLACE FUNCTION public.apply_affiliate_refund(
    p_gateway public.affiliate_gateway, p_order_id uuid, p_refunded_minor bigint, p_order_total_minor bigint, p_full boolean)
    RETURNS text
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_full boolean := coalesce(p_full, false)
    OR coalesce(p_order_total_minor, 0) <= 0
    OR coalesce(p_refunded_minor, 0) >= coalesce(p_order_total_minor, 0);
  v_order record;
  v_affiliate uuid;
  v_commission record;
  v_payout_status text;
  v_in_flight boolean;
  v_new bigint;
  v_tombstone uuid;
BEGIN
  IF p_gateway IS NULL OR p_order_id IS NULL THEN
    RETURN 'none';
  END IF;

  SELECT o.id, o.currency, o.total, o.shipping_total, o.affiliate_id, o.affiliate_base_currency
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  SELECT c.affiliate_id INTO v_affiliate
    FROM public.affiliate_commissions c
   WHERE c.order_id = p_order_id AND c.gateway = p_gateway;
  IF v_affiliate IS NULL THEN
    v_affiliate := v_order.affiliate_id;
  END IF;
  IF v_affiliate IS NULL THEN
    RETURN 'none';
  END IF;

  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  SELECT c.id, c.affiliate_id, c.status::text AS status, c.payout_id, c.commission_amount_cents, c.refunded_amount_cents
    INTO v_commission
    FROM public.affiliate_commissions c
   WHERE c.order_id = p_order_id AND c.gateway = p_gateway
   FOR UPDATE;

  IF NOT FOUND THEN
    IF v_order.id IS NULL OR v_order.affiliate_id IS DISTINCT FROM v_affiliate THEN
      RETURN 'none';
    END IF;
    IF NOT v_full THEN
      UPDATE public.orders o
         SET affiliate_refunded_minor = p_refunded_minor,
             affiliate_refund_total_minor = p_order_total_minor
       WHERE o.id = p_order_id
         AND p_refunded_minor > coalesce(o.affiliate_refunded_minor, 0);
      RETURN 'none';
    END IF;
    INSERT INTO public.affiliate_commissions (
      affiliate_id, order_id, gateway, order_currency, order_net_amount_minor, exchange_rate_snapshot,
      net_order_amount_cents, commission_rate_snapshot, commission_amount_cents, refunded_amount_cents,
      currency, status, clears_at, voided_at, void_reason
    )
    VALUES (
      v_affiliate, p_order_id, p_gateway,
      upper(btrim(coalesce(v_order.currency, 'USD'))), 0, 1, 0, 0, 0, 0,
      coalesce(
        nullif(upper(btrim(coalesce(v_order.affiliate_base_currency, ''))), ''),
        (SELECT upper(cu.code) FROM public.currencies cu
          WHERE cu.is_default
          ORDER BY cu.updated_at DESC, cu.created_at DESC, cu.code
          LIMIT 1),
        upper(btrim(coalesce(v_order.currency, 'USD')))
      ),
      'VOIDED_REFUND'::public.affiliate_commission_status, now(), now(), 'refunded_before_commission'
    )
    ON CONFLICT ON CONSTRAINT affiliate_commissions_order_gateway_key DO NOTHING
    RETURNING id INTO v_tombstone;
    RETURN CASE WHEN v_tombstone IS NULL THEN 'none' ELSE 'voided' END;
  END IF;

  IF v_commission.status = 'VOIDED_REFUND' THEN
    RETURN 'none';
  END IF;

  v_payout_status := NULL;
  IF v_commission.payout_id IS NOT NULL THEN
    SELECT po.status::text INTO v_payout_status FROM public.affiliate_payouts po WHERE po.id = v_commission.payout_id;
  END IF;
  v_in_flight := v_commission.status = 'PAID' OR coalesce(v_payout_status IN ('PROCESSING', 'COMPLETED'), false);

  IF v_full THEN
    -- the shared void path flags and alerts an in-flight commission instead of voiding it
    PERFORM private.affiliate_void_order_commissions(p_order_id, 'refunded');
    RETURN CASE WHEN v_in_flight THEN 'alerted' ELSE 'voided' END;
  END IF;

  v_new := private.affiliate_refund_share(v_commission.commission_amount_cents, p_refunded_minor, p_order_total_minor,
                                          v_order.total, v_order.shipping_total);

  IF v_in_flight THEN
    UPDATE public.affiliate_commissions c
       SET refund_pending_cents = GREATEST(c.refund_pending_cents, v_new)
     WHERE c.id = v_commission.id;
    PERFORM private.affiliate_alert_refund_after_payout(v_commission.id, v_affiliate, p_order_id, v_commission.payout_id, 'refunded');
    RETURN 'alerted';
  END IF;

  IF v_commission.commission_amount_cents > 0 AND v_new >= v_commission.commission_amount_cents THEN
    -- nothing of the commission is left to earn: void it now, so a net-zero row is never
    -- claimed and a later refund of the shipping raises no refund-after-payout alert
    PERFORM private.affiliate_void_order_commissions(p_order_id, 'refunded');
    RETURN 'voided';
  END IF;
  IF v_new <= v_commission.refunded_amount_cents THEN
    RETURN 'none';
  END IF;
  UPDATE public.affiliate_commissions c SET refunded_amount_cents = v_new WHERE c.id = v_commission.id;
  UPDATE public.affiliate_profiles p
     SET total_earned_cents = GREATEST(p.total_earned_cents - (v_new - v_commission.refunded_amount_cents), 0)
   WHERE p.id = v_affiliate;
  RETURN 'adjusted';
END;
$$;

REVOKE ALL ON FUNCTION public.apply_affiliate_refund(public.affiliate_gateway, uuid, bigint, bigint, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_affiliate_refund(public.affiliate_gateway, uuid, bigint, bigint, boolean) TO service_role;

-- Payment disputes (finding L). Returns 'held' | 'released' | 'none'.
--   p_open = true (Stripe charge.dispute.created, Freemius payment.dispute.created): the order's
--     PENDING_CLEARANCE / CLEARED commission gets disputed_at ('held'; again 'held' on a
--     redelivery), so promote, claim and retry skip it: it neither clears nor is transferred
--     while the dispute is open. One already attached to a PROCESSING payout is held too: that
--     transfer is not stopped (complete_affiliate_payout still marks it PAID), but if it fails
--     the retry detaches the commission instead of re-sending it. A PAID or voided commission,
--     or none at all: 'none'.
--   p_open = false (won, or closed without a loss): the hold is cleared whatever the status
--     ('released'; 'none' when nothing was held). A lost dispute is a full refund and goes
--     through apply_affiliate_refund().
-- Lock order (A2): the profile, then the commission.
CREATE OR REPLACE FUNCTION public.set_affiliate_commission_dispute(p_gateway public.affiliate_gateway, p_order_id uuid, p_open boolean)
    RETURNS text
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_commission record;
BEGIN
  IF p_gateway IS NULL OR p_order_id IS NULL OR p_open IS NULL THEN
    RETURN 'none';
  END IF;

  SELECT c.affiliate_id INTO v_affiliate
    FROM public.affiliate_commissions c
   WHERE c.order_id = p_order_id AND c.gateway = p_gateway;
  IF v_affiliate IS NULL THEN
    RETURN 'none';
  END IF;

  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  SELECT c.id, c.status::text AS status, c.disputed_at
    INTO v_commission
    FROM public.affiliate_commissions c
   WHERE c.order_id = p_order_id AND c.gateway = p_gateway
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF NOT p_open THEN
    IF v_commission.disputed_at IS NULL THEN
      RETURN 'none';
    END IF;
    UPDATE public.affiliate_commissions c SET disputed_at = NULL WHERE c.id = v_commission.id;
    RETURN 'released';
  END IF;

  IF v_commission.status NOT IN ('PENDING_CLEARANCE', 'CLEARED') THEN
    RETURN 'none';
  END IF;
  IF v_commission.disputed_at IS NULL THEN
    UPDATE public.affiliate_commissions c SET disputed_at = now() WHERE c.id = v_commission.id;
  END IF;
  RETURN 'held';
END;
$$;

REVOKE ALL ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) TO service_role;

-- Repairs what the triggers missed (A11), run first in every payout cycle. (a) Attributed,
-- paid/shipped orders of the last 120 days, newest first, whose partner is ACTIVE and approved
-- and is not the buyer, with no commission row: the commission is recorded. (b) Live
-- commissions (PENDING_CLEARANCE / CLEARED, not yet flagged) whose order is refunded or
-- cancelled: voided, or flagged and alerted when in flight. Every profile involved is locked
-- first, in id order. Returns {"recorded": n, "voided": n}.
CREATE OR REPLACE FUNCTION public.reconcile_affiliate_commissions(p_limit integer DEFAULT 200)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 200), 1), 1000);
  v_record_orders uuid[];
  v_void_orders uuid[];
  v_order_id uuid;
  v_order record;
  v_recorded integer := 0;
  v_voided integer := 0;
BEGIN
  SELECT coalesce(array_agg(s.id), '{}'::uuid[]) INTO v_record_orders
    FROM (
      SELECT o.id
        FROM public.orders o
        JOIN public.affiliate_profiles p ON p.id = o.affiliate_id
       WHERE o.affiliate_id IS NOT NULL
         AND o.paid_at IS NOT NULL
         AND o.status IN ('paid', 'shipped')
         AND o.created_at >= now() - interval '120 days'
         AND p.status = 'ACTIVE'::public.affiliate_status
         AND p.first_published_at IS NOT NULL
         AND (o.user_id IS NULL OR o.user_id <> p.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.affiliate_commissions c WHERE c.order_id = o.id)
       ORDER BY o.created_at DESC
       LIMIT v_limit
    ) AS s;

  SELECT coalesce(array_agg(s.order_id), '{}'::uuid[]) INTO v_void_orders
    FROM (
      SELECT DISTINCT c.order_id
        FROM public.affiliate_commissions c
        JOIN public.orders o ON o.id = c.order_id
       WHERE c.status IN ('PENDING_CLEARANCE'::public.affiliate_commission_status, 'CLEARED'::public.affiliate_commission_status)
         AND c.void_requested_at IS NULL
         AND o.status IN ('refunded', 'cancelled')
       LIMIT v_limit
    ) AS s;

  IF cardinality(v_record_orders) = 0 AND cardinality(v_void_orders) = 0 THEN
    RETURN jsonb_build_object('recorded', 0, 'voided', 0);
  END IF;

  PERFORM 1
     FROM public.affiliate_profiles p
    WHERE p.id IN (
      SELECT o.affiliate_id FROM public.orders o WHERE o.id = ANY (v_record_orders)
      UNION
      SELECT c.affiliate_id FROM public.affiliate_commissions c WHERE c.order_id = ANY (v_void_orders)
    )
    ORDER BY p.id
    FOR UPDATE;

  FOREACH v_order_id IN ARRAY v_record_orders LOOP
    IF private.affiliate_record_commission(v_order_id) IS NOT NULL THEN
      v_recorded := v_recorded + 1;
    END IF;
  END LOOP;

  FOR v_order IN
    SELECT o.id, o.status FROM public.orders o WHERE o.id = ANY (v_void_orders)
  LOOP
    v_voided := v_voided + private.affiliate_void_order_commissions(v_order.id, v_order.status);
  END LOOP;

  RETURN jsonb_build_object('recorded', v_recorded, 'voided', v_voided);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_affiliate_commissions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_affiliate_commissions(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 13. Row-level security: one permissive policy per role and command, helpers as (SELECT ...)
-- ---------------------------------------------------------------------------
ALTER TABLE public.affiliate_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_commissions ENABLE ROW LEVEL SECURITY;
-- service role only: RLS on, no API-role policy (service_role bypasses RLS)
ALTER TABLE public.affiliate_click_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_payout_runs ENABLE ROW LEVEL SECURITY;

-- affiliate_tiers: the active ladder is public; ADMIN (second factor) reads and writes all
DROP POLICY IF EXISTS affiliate_tiers_anon_read_policy ON public.affiliate_tiers;
CREATE POLICY affiliate_tiers_anon_read_policy ON public.affiliate_tiers
  FOR SELECT TO anon
  USING (is_active);

DROP POLICY IF EXISTS affiliate_tiers_read_policy ON public.affiliate_tiers;
CREATE POLICY affiliate_tiers_read_policy ON public.affiliate_tiers
  FOR SELECT TO authenticated
  USING (is_active OR ((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS affiliate_tiers_insert_policy ON public.affiliate_tiers;
CREATE POLICY affiliate_tiers_insert_policy ON public.affiliate_tiers
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS affiliate_tiers_update_policy ON public.affiliate_tiers;
CREATE POLICY affiliate_tiers_update_policy ON public.affiliate_tiers
  FOR UPDATE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE))
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS affiliate_tiers_delete_policy ON public.affiliate_tiers;
CREATE POLICY affiliate_tiers_delete_policy ON public.affiliate_tiers
  FOR DELETE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- affiliate_profiles: the owner reads its row and, while it is an ACTIVE RTL, edits the granted
-- columns; ADMIN reads and updates every row. No INSERT / DELETE policy (A6).
DROP POLICY IF EXISTS affiliate_profiles_read_policy ON public.affiliate_profiles;
CREATE POLICY affiliate_profiles_read_policy ON public.affiliate_profiles
  FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid())) OR ((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS affiliate_profiles_update_policy ON public.affiliate_profiles;
CREATE POLICY affiliate_profiles_update_policy ON public.affiliate_profiles
  FOR UPDATE TO authenticated
  USING (
    ((user_id = (SELECT auth.uid()))
      AND ((SELECT public.get_current_user_role())::text = 'RTL')
      AND (status = 'ACTIVE'::public.affiliate_status))
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  )
  WITH CHECK (
    ((user_id = (SELECT auth.uid())) AND (status = 'ACTIVE'::public.affiliate_status))
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

-- affiliate_pages: the owner reads its page and, while it is an ACTIVE RTL and the page is not
-- waiting for review, edits the draft columns; ADMIN reads and updates every page.
DROP POLICY IF EXISTS affiliate_pages_read_policy ON public.affiliate_pages;
CREATE POLICY affiliate_pages_read_policy ON public.affiliate_pages
  FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid())) OR ((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS affiliate_pages_update_policy ON public.affiliate_pages;
CREATE POLICY affiliate_pages_update_policy ON public.affiliate_pages
  FOR UPDATE TO authenticated
  USING (
    ((user_id = (SELECT auth.uid()))
      AND ((SELECT public.get_current_user_role())::text = 'RTL')
      AND (approval_status <> 'PENDING_REVIEW'::public.affiliate_page_status)
      AND EXISTS (
        SELECT 1 FROM public.affiliate_profiles p
         WHERE p.id = affiliate_pages.affiliate_id
           AND p.user_id = (SELECT auth.uid())
           AND p.status = 'ACTIVE'::public.affiliate_status
      ))
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  )
  WITH CHECK ((user_id = (SELECT auth.uid())) OR ((SELECT public.is_admin_mfa()) IS TRUE));

-- affiliate_commissions / affiliate_payouts: the owner's rows and ADMIN, read only (A6)
DROP POLICY IF EXISTS affiliate_commissions_read_policy ON public.affiliate_commissions;
CREATE POLICY affiliate_commissions_read_policy ON public.affiliate_commissions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.affiliate_profiles p
       WHERE p.id = affiliate_commissions.affiliate_id AND p.user_id = (SELECT auth.uid())
    )
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

DROP POLICY IF EXISTS affiliate_payouts_read_policy ON public.affiliate_payouts;
CREATE POLICY affiliate_payouts_read_policy ON public.affiliate_payouts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.affiliate_profiles p
       WHERE p.id = affiliate_payouts.affiliate_id AND p.user_id = (SELECT auth.uid())
    )
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

-- ---------------------------------------------------------------------------
-- 14. Grants (Supabase grants nothing on new objects in public; local images and older
--     projects grant everything by default privilege, so every table is revoked first)
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_tiers FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_tiers FROM authenticated;
GRANT SELECT ON TABLE public.affiliate_tiers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_tiers TO authenticated, service_role;

-- Revoking the table-level UPDATE also revokes any column grant of it, so the column grant
-- below is the complete list afterwards (02025).
REVOKE ALL ON TABLE public.affiliate_profiles FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_profiles FROM authenticated;
GRANT SELECT ON TABLE public.affiliate_profiles TO authenticated;
GRANT UPDATE (display_name, bio, social_links, preferred_locale) ON TABLE public.affiliate_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_profiles TO service_role;

REVOKE ALL ON TABLE public.affiliate_pages FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_pages FROM authenticated;
GRANT SELECT ON TABLE public.affiliate_pages TO authenticated;
GRANT UPDATE (title, meta_description, draft_content, featured_product_ids) ON TABLE public.affiliate_pages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_pages TO service_role;

REVOKE ALL ON TABLE public.affiliate_commissions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_commissions FROM authenticated;
GRANT SELECT ON TABLE public.affiliate_commissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_commissions TO service_role;

REVOKE ALL ON TABLE public.affiliate_payouts FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.affiliate_payouts FROM authenticated;
GRANT SELECT ON TABLE public.affiliate_payouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_payouts TO service_role;

REVOKE ALL ON TABLE public.affiliate_click_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_click_events TO service_role;

REVOKE ALL ON TABLE public.affiliate_payout_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_payout_runs TO service_role;

-- ---------------------------------------------------------------------------
-- 15. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.affiliate_tiers IS 'Affiliate commission tiers (the /partners ladder). Active tiers are public; ADMIN CRUD on a satisfied second factor. member_count is maintained by a trigger on affiliate_profiles.';
COMMENT ON COLUMN public.affiliate_tiers.name_translations IS 'Localised tier names, e.g. {"fr": "Ambassadeur fondateur"}; English lives in name.';
COMMENT ON COLUMN public.affiliate_tiers.commission_percentage IS 'Share of the net order amount (subtotal minus discount, no tax or shipping), snapshotted onto each commission.';
COMMENT ON COLUMN public.affiliate_tiers.cookie_duration_days IS 'Referral cookie lifetime set by the proxy (get_affiliate_referral_window).';
COMMENT ON COLUMN public.affiliate_tiers.clearance_hold_days IS 'Refund-protection hold: a commission clears this many days after the order is paid.';
COMMENT ON COLUMN public.affiliate_tiers.is_default_signup_tier IS 'Sign-ups land in the first default tier with room (highest sort_order first), then the other tiers by sort_order.';
COMMENT ON COLUMN public.affiliate_tiers.max_ambassadors_cap IS 'Spots in the tier; NULL = unlimited.';
COMMENT ON COLUMN public.affiliate_tiers.member_count IS 'Partners currently in the tier (trigger-maintained, never below 0).';
COMMENT ON COLUMN public.affiliate_tiers.badge_color IS 'Badge colour token, rendered through a literal class map.';

COMMENT ON TABLE public.affiliate_profiles IS 'One per partner (RTL) account. Created only by create_affiliate_account(); the owner may edit display_name, bio, social_links and preferred_locale, everything else is server- or ADMIN-written (column grants + affiliate_profile_guard).';
COMMENT ON COLUMN public.affiliate_profiles.handle IS 'Storefront slug (/partners/<handle>): lower-case, 3-32 characters, letters, digits and inner hyphens.';
COMMENT ON COLUMN public.affiliate_profiles.avatar_object_key IS 'Storage key set by the upload route (affiliates/avatars/... or images/...); never a user-supplied URL.';
COMMENT ON COLUMN public.affiliate_profiles.onboarding_step IS 'Derived from the lifecycle timestamps by affiliate_profile_guard; never written directly.';
COMMENT ON COLUMN public.affiliate_profiles.stripe_connect_account_id IS 'Stripe Connect Express account (acct_...), set once by the connect action.';
COMMENT ON COLUMN public.affiliate_profiles.stripe_connect_livemode IS 'Stripe key mode the account was created in; a mismatch with the current key means re-onboarding.';
COMMENT ON COLUMN public.affiliate_profiles.total_clicks IS 'Counted referral clicks (record_affiliate_click: one per visitor per 24 h).';
COMMENT ON COLUMN public.affiliate_profiles.total_earned_cents IS 'Recorded commissions net of refunds and voids, base-currency minor units.';
COMMENT ON COLUMN public.affiliate_profiles.total_paid_cents IS 'Completed payouts, base-currency minor units.';
COMMENT ON COLUMN public.affiliate_profiles.first_published_at IS 'First storefront approval. A partner earns, counts clicks and gets a referral cookie only once this is set.';
COMMENT ON COLUMN public.affiliate_profiles.signup_ip_masked IS 'Sign-up IP truncated to /24 (IPv4) or /48 (IPv6) for abuse review; never the full address.';

COMMENT ON TABLE public.affiliate_pages IS 'Exactly one storefront page per partner. draft_content is UNTRUSTED (the owner may PATCH it over the Data API): sanitize before any use. published_* is the approved snapshot the public page renders.';
COMMENT ON COLUMN public.affiliate_pages.draft_content IS 'Untrusted Tiptap JSON edited by the partner; every reader runs the storefront sanitizer.';
COMMENT ON COLUMN public.affiliate_pages.published_content IS 'Sanitized document copied from the draft on approval; NULL until the first approval.';
COMMENT ON COLUMN public.affiliate_pages.published_profile IS 'Approved snapshot of {display_name, bio, avatar_object_key, social_links} shown on the public page.';
COMMENT ON COLUMN public.affiliate_pages.approval_status IS 'DRAFT -> PENDING_REVIEW (submitted) -> PUBLISHED or CHANGES_REQUESTED; a draft edit sends PUBLISHED / CHANGES_REQUESTED back to DRAFT (affiliate_page_guard).';
COMMENT ON COLUMN public.affiliate_pages.draft_version IS 'Bumped by affiliate_page_guard on every draft edit; submitted_version records the version under review.';

COMMENT ON TABLE public.affiliate_payouts IS 'Stripe Connect transfers to partners, claimed before the transfer (PROCESSING) for crash safety. Written only by the service-role RPCs.';
COMMENT ON COLUMN public.affiliate_payouts.stripe_destination_account IS 'Connect account snapshot at claim (refreshed on retry).';
COMMENT ON COLUMN public.affiliate_payouts.livemode IS 'Stripe key mode of the destination account at claim; the payout holds only commissions of that mode and is retried only to an account of the same mode.';
COMMENT ON COLUMN public.affiliate_payouts.stripe_transfer_id IS 'Stripe transfer id once COMPLETED; NULL while PROCESSING or FAILED.';
COMMENT ON COLUMN public.affiliate_payouts.failure_reason IS 'Why the last attempt failed (a Stripe error code, stale, nothing_to_pay, below_minimum, released).';

COMMENT ON TABLE public.affiliate_commissions IS 'Commission ledger, one row per order and gateway, in the store base currency. Written only by the orders triggers and the service-role RPCs.';
COMMENT ON COLUMN public.affiliate_commissions.order_net_amount_minor IS 'Net order amount (subtotal minus discount) in the order currency, minor units.';
COMMENT ON COLUMN public.affiliate_commissions.exchange_rate_snapshot IS 'orders.exchange_rate_at_purchase used for the conversion (1 when the order was in the base currency).';
COMMENT ON COLUMN public.affiliate_commissions.net_order_amount_cents IS 'Net order amount in the base currency, minor units.';
COMMENT ON COLUMN public.affiliate_commissions.commission_amount_cents IS 'Commission before refunds, base-currency minor units.';
COMMENT ON COLUMN public.affiliate_commissions.refunded_amount_cents IS 'Portion reversed by partial refunds (monotonic), base-currency minor units.';
COMMENT ON COLUMN public.affiliate_commissions.refund_pending_cents IS 'Refund recorded while the commission was paid or in flight; applied if that payout fails.';
COMMENT ON COLUMN public.affiliate_commissions.void_requested_at IS 'Full refund recorded while the commission was paid or in flight; applied if that payout fails.';
COMMENT ON COLUMN public.affiliate_commissions.disputed_at IS 'Open payment dispute (set_affiliate_commission_dispute): while set, the commission is not promoted, claimed or re-sent by a retry.';
COMMENT ON COLUMN public.affiliate_commissions.currency IS 'Store base currency when the commission was recorded.';
COMMENT ON COLUMN public.affiliate_commissions.livemode IS 'Payment mode of the sale (orders.affiliate_livemode; true when unknown): only a payout to a Connect account of the same mode claims it.';
COMMENT ON COLUMN public.affiliate_commissions.clears_at IS 'End of the refund-protection hold (tier clearance_hold_days after payment).';
COMMENT ON COLUMN public.affiliate_commissions.notified_at IS 'When the "you earned" e-mail was claimed (claim_affiliate_commission_notifications).';

COMMENT ON TABLE public.affiliate_click_events IS 'Referral click log (service role only): visitor_hash is a daily salted hash of a masked IP and user agent, never a raw IP. Pruned after 30 days.';
COMMENT ON TABLE public.affiliate_payout_runs IS 'One automated payout cycle per UTC day (service role only).';

COMMENT ON COLUMN public.orders.affiliate_id IS 'Partner credited for the order (resolved at checkout from the signed storefront token or the referral cookie).';
COMMENT ON COLUMN public.orders.affiliate_source IS 'storefront (signed storefront token) or referral_link (referral cookie).';
COMMENT ON COLUMN public.orders.affiliate_base_currency IS 'Store default currency at checkout, the commission currency.';
COMMENT ON COLUMN public.orders.affiliate_livemode IS 'Payment mode of an attributed checkout: false for a Stripe test key or the Freemius sandbox, true for live, NULL when unknown (treated as live).';
COMMENT ON COLUMN public.orders.affiliate_refunded_minor IS 'Largest cumulative partial refund seen before the order had a commission (apply_affiliate_refund); the commission recorded later starts from it.';
COMMENT ON COLUMN public.orders.affiliate_refund_total_minor IS 'Charge total that affiliate_refunded_minor was measured against, in the same minor units.';

COMMENT ON FUNCTION public.get_affiliate_storefront(text) IS 'Public storefront read: the approved snapshot of an ACTIVE, approved partner, or nothing.';
COMMENT ON FUNCTION public.list_affiliate_storefronts(integer) IS 'Public storefront list for the sitemap (at most 5000).';
COMMENT ON FUNCTION public.get_affiliate_referral_window(text) IS 'Referral cookie lifetime in days for an ACTIVE, approved partner, else NULL.';
COMMENT ON FUNCTION public.record_affiliate_click(text, text) IS 'Counts one referral click per visitor hash per partner per 24 h (flood-limited).';
COMMENT ON FUNCTION public.create_affiliate_account(uuid, text, text, text, text, text, jsonb, text) IS 'Service role: partner sign-up (profile, page, tier, role RTL).';
COMMENT ON FUNCTION public.apply_affiliate_refund(public.affiliate_gateway, uuid, bigint, bigint, boolean) IS 'Service role: refund handling; returns voided, adjusted, alerted or none.';
COMMENT ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) IS 'Service role: holds (open) or releases (closed without a loss) the commission of a disputed order; returns held, released or none.';
COMMENT ON FUNCTION public.prepare_affiliate_payout_retry(uuid, bigint) IS 'Service role: FAILED -> PROCESSING for another attempt in the payout''s own key mode; a remainder below p_min_amount stays FAILED (below_minimum).';
COMMENT ON FUNCTION public.reconcile_affiliate_commissions(integer) IS 'Service role: records missed commissions and voids those of refunded or cancelled orders.';

-- ---------------------------------------------------------------------------
-- 16. cortex_request_log: the partner copilot's shared quota counts one route's rows
-- ---------------------------------------------------------------------------
-- evaluateRetailerCopilotGlobalQuota() (apps/nextblock/lib/cortex-ai/request-quota.ts) counts
-- every account's 'affiliates/cortex' rows of the last hour (route = ... AND created_at >= ...);
-- 02022's (user_id, created_at) index cannot serve that. The table's grants are unchanged.
CREATE INDEX IF NOT EXISTS cortex_request_log_route_created_idx ON public.cortex_request_log (route, created_at DESC);
