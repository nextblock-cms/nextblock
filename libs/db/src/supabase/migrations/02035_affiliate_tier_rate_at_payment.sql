-- 02035: a partner's tier can change at any time, and the new rate applies only to orders paid
-- from the moment of the change (Affiliates & Creator Storefronts, docs/15 → "The amount").
--
-- Before this file private.affiliate_record_commission() (02030) read the partner's CURRENT tier
-- when it recorded a commission. The paid trigger records at payment, but
-- reconcile_affiliate_commissions() credits an order paid while the partner was paused (or whose
-- trigger failed) later, at the next payout run, with the tier in effect THEN: an order paid
-- before a tier move could earn the new rate and the other way round, a rate edit on the Tiers
-- screen leaked into orders paid before it, and the refund hold counted from the recording, not
-- the payment. Now:
--
-- 1. orders.affiliate_commission_rate / orders.affiliate_clearance_hold_days (nullable). A BEFORE
--    INSERT OR UPDATE OF paid_at trigger (private.affiliate_snapshot_order_rate) copies the
--    partner's tier rate and hold onto an attributed order the moment it is paid: paid_at goes
--    NULL -> set on an UPDATE (every "mark paid" path ends in assign_order_invoice_metadata()), or
--    an order is inserted already paid. The partner's status is not checked (a paused partner's
--    order keeps the rate of its payment for reconcile), a value the statement already wrote is
--    kept, and the body swallows every error (an order write never fails because of it).
--    BEFORE triggers always run before the AFTER trigger that records the commission.
-- 2. private.affiliate_record_commission() records coalesce(the order's rate, the current tier's
--    rate) and clears at the payment time plus coalesce(the order's hold, the tier's hold). A
--    recording whose hold has already passed (a late reconcile) clears at the next promote, unless
--    an open dispute holds it (5): the hold protects against refunds, and refunds keep being
--    applied after it (apply_affiliate_refund flags and alerts what was paid or is in flight).
--    Every other rule is unchanged.
-- 3. affiliate_profiles.tier_changed_at: stamped by private.affiliate_profile_guard() whenever
--    tier_id changes (every writer), and one more column a partner session may not change.
-- 4. public.change_affiliate_partner_tier(affiliate, tier, allow_over_cap): the CMS move, service
--    role only. It locks the profile, then both tier rows, re-checks under the locks and answers
--    'not_found' | 'unchanged' | 'tier_not_found' | 'tier_inactive' | 'tier_full' | 'moved'. It
--    never checks the partner's status (paused partners can be moved). A capped tier that is full
--    takes the partner only with p_allow_over_cap: the cap limits public sign-ups and the spots
--    the public pages count, not the operator.
-- 5. orders.affiliate_disputed_at: a payment dispute that opens before the order has a commission
--    (the partner was paused at payment, or the paid trigger failed). set_affiliate_commission_dispute()
--    answered 'none' for it and kept nothing; with the hold counted from the payment (2), reconcile
--    could then record that commission already past its hold, and one payout run (reconcile,
--    promote, claim) would transfer it on a disputed sale. Now such a dispute is kept on the order
--    (opened: set, closed without a loss: cleared; 'held' / 'released' as for a commission), and
--    affiliate_record_commission() records the commission with disputed_at from it, so promote,
--    claim and retry skip it until the dispute closes. A lost dispute is a full refund, whose
--    tombstone (apply_affiliate_refund) stops the commission from being recorded at all.
--
-- Orders paid before this file ran carry no stored rate: those still waiting for a commission
-- (a paused partner's, or one whose trigger failed) are recorded at the tier's rate in effect when
-- reconcile reaches them, as before, but their hold now counts from paid_at as well (the tier's
-- hold then), so one whose hold has passed clears at the next promote too. No backfill: the tier in
-- effect at their payment was never recorded anywhere, and neither was a dispute opened before
-- this file ran (it was answered 'none'). Commissions already recorded keep their rate, hold and
-- clears_at.
--
-- Copy. The partner terms clause on rate changes now says "orders paid after the change" (EN +
-- FR, AFFILIATE_TERMS_VERSION 2026-11-11), and the partner portal gains "Tier since {date}".
-- Both ship here as translations rows in the forms the generator header of 02031 prescribes: a
-- new key with ON CONFLICT (key) DO NOTHING, changed text guarded by the exact text 02031 seeded,
-- so a string an operator edited stays theirs.
--
-- Grants. No table, view or sequence is created, and new columns are covered by the existing
-- table grants: on orders an ADMIN on a satisfied second factor already writes every column, and
-- authenticated holds only the four self-service UPDATE column grants on affiliate_profiles
-- (table UPDATE revoked by 02030 and by the post-apply pass), so tier_changed_at is not writable
-- over the Data API. The trigger function is a SECURITY DEFINER in `private` (search_path '',
-- revoked from PUBLIC, anon, authenticated); the RPC is SECURITY INVOKER in public, revoked from
-- the API roles here and in BOTH copies of API_ROLE_REVOKE_SQL (apps/nextblock/tools/lib/migrate-core.mjs,
-- apps/nextblock/lib/setup/schema-apply.ts). set_affiliate_commission_dispute() keeps 02030's
-- signature, security and grants (its revoke is restated here and has been in API_ROLE_REVOKE_SQL
-- since 02030). tools/scripts/security-verify.sql section 39 checks all of it.
--
-- Append-only, forward-only, idempotent: ADD COLUMN IF NOT EXISTS, constraints added only when
-- missing, CREATE OR REPLACE, DROP TRIGGER IF EXISTS before CREATE TRIGGER; it replays cleanly
-- after 02000-02034 on an empty database and on one that holds data.

-- 02001 turns body validation off for the session; a one-connection replay would otherwise
-- create every function below unchecked.
SET check_function_bodies = on;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_commission_rate numeric(5,2) NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_clearance_hold_days integer NULL;
ALTER TABLE public.affiliate_profiles ADD COLUMN IF NOT EXISTS tier_changed_at timestamptz NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS affiliate_disputed_at timestamptz NULL;

DO $nb_02035_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_commission_rate_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_commission_rate_check CHECK (
        affiliate_commission_rate IS NULL OR (affiliate_commission_rate >= 0 AND affiliate_commission_rate <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_affiliate_clearance_hold_days_check' AND conrelid = 'public.orders'::regclass) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_affiliate_clearance_hold_days_check CHECK (
        affiliate_clearance_hold_days IS NULL OR affiliate_clearance_hold_days BETWEEN 0 AND 365);
  END IF;
END
$nb_02035_checks$;

-- ---------------------------------------------------------------------------
-- 2. The rate at payment: BEFORE INSERT OR UPDATE OF paid_at on orders
-- ---------------------------------------------------------------------------
-- Copies the partner's tier rate and clearance hold onto an attributed order when it becomes
-- paid. Lock order of the ledger (02030): the order row (this write already holds it on an
-- UPDATE; the AFTER trigger and apply_affiliate_refund() take it first too), then the partner
-- profile, then a plain read of the tier, exactly as affiliate_record_commission() does. So a
-- concurrent change_affiliate_partner_tier() either commits first (the order gets the new tier)
-- or waits for this payment (the order keeps the old one). Never fails the order write.
CREATE OR REPLACE FUNCTION private.affiliate_snapshot_order_rate()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_tier_id uuid;
  v_rate numeric(5,2);
  v_hold integer;
BEGIN
  IF NEW.affiliate_id IS NULL OR NEW.paid_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- the first payment only: a later "mark paid" rewrites paid_at with the same value
  IF TG_OP = 'UPDATE' THEN
    IF OLD.paid_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  -- a value the statement already wrote is kept
  IF NEW.affiliate_commission_rate IS NOT NULL AND NEW.affiliate_clearance_hold_days IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT p.tier_id INTO v_tier_id
      FROM public.affiliate_profiles p
     WHERE p.id = NEW.affiliate_id
     FOR UPDATE;
    IF FOUND THEN
      SELECT t.commission_percentage, t.clearance_hold_days INTO v_rate, v_hold
        FROM public.affiliate_tiers t
       WHERE t.id = v_tier_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_rate := NULL;
    v_hold := NULL;
    RAISE WARNING 'affiliate rate snapshot failed for order %: %', NEW.id, SQLERRM;
  END;

  IF v_rate IS NOT NULL THEN
    NEW.affiliate_commission_rate := coalesce(NEW.affiliate_commission_rate, v_rate);
  END IF;
  IF v_hold IS NOT NULL THEN
    NEW.affiliate_clearance_hold_days := coalesce(NEW.affiliate_clearance_hold_days, v_hold);
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are never called by API roles (02013, 02021, 02030).
REVOKE ALL ON FUNCTION private.affiliate_snapshot_order_rate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.affiliate_snapshot_order_rate() TO service_role;

DROP TRIGGER IF EXISTS affiliate_snapshot_order_rate ON public.orders;
CREATE TRIGGER affiliate_snapshot_order_rate
  BEFORE INSERT OR UPDATE OF paid_at ON public.orders
  FOR EACH ROW
  WHEN (NEW.affiliate_id IS NOT NULL AND NEW.paid_at IS NOT NULL)
  EXECUTE FUNCTION private.affiliate_snapshot_order_rate();

-- ---------------------------------------------------------------------------
-- 3. private.affiliate_record_commission: the stored rate and the hold from the payment
-- ---------------------------------------------------------------------------
-- 02030's definition with four changes: the order's affiliate_commission_rate,
-- affiliate_clearance_hold_days and affiliate_disputed_at are read with it, the commission and
-- commission_rate_snapshot use coalesce(the stored rate, the current tier's rate) (an order paid
-- before 02035 has none), clears_at is the payment time plus coalesce(the stored hold, the tier's
-- hold), so a late recording whose hold already passed clears at the next promote, and a dispute
-- the order kept from before the commission existed (section 3b) is recorded as its disputed_at,
-- so that late recording is held instead (promote, claim and retry skip it until the dispute
-- closes). Signature, SECURITY DEFINER, search_path and grants are 02030's.
--
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
  v_commission_pct numeric(5,2);
  v_hold_days integer;
  v_commission bigint;
  v_refunded bigint;
  v_voided boolean;
  v_id uuid;
BEGIN
  SELECT o.id, o.user_id, o.status, o.total, o.subtotal, o.discount_total, o.shipping_total, o.currency,
         o.exchange_rate_at_purchase, o.provider, o.paid_at, o.affiliate_id,
         o.affiliate_base_currency, o.affiliate_livemode, o.affiliate_refunded_minor,
         o.affiliate_refund_total_minor, o.customer_details,
         o.affiliate_commission_rate, o.affiliate_clearance_hold_days, o.affiliate_disputed_at
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
  -- the rate and hold stored on the order when it was paid (02035); the current tier for an order
  -- paid before that
  v_commission_pct := coalesce(v_order.affiliate_commission_rate, v_tier.commission_percentage);
  v_hold_days := coalesce(v_order.affiliate_clearance_hold_days, v_tier.clearance_hold_days);

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

  v_commission := round(v_net_base::numeric * v_commission_pct / 100)::bigint;
  IF v_commission <= 0 THEN
    RETURN NULL;
  END IF;
  v_refunded := private.affiliate_refund_share(v_commission, v_order.affiliate_refunded_minor,
                                               v_order.affiliate_refund_total_minor, v_order.total, v_order.shipping_total);
  v_voided := v_refunded >= v_commission;

  INSERT INTO public.affiliate_commissions (
    affiliate_id, order_id, gateway, order_currency, order_net_amount_minor, exchange_rate_snapshot,
    net_order_amount_cents, commission_rate_snapshot, commission_amount_cents, refunded_amount_cents,
    currency, livemode, status, clears_at, voided_at, void_reason, disputed_at
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
    v_commission_pct,
    v_commission,
    v_refunded,
    v_base_currency,
    coalesce(v_order.affiliate_livemode, true),
    CASE WHEN v_voided
      THEN 'VOIDED_REFUND'::public.affiliate_commission_status
      ELSE 'PENDING_CLEARANCE'::public.affiliate_commission_status
    END,
    -- the hold counts from the payment, not the recording (02035)
    coalesce(v_order.paid_at, now()) + make_interval(days => v_hold_days),
    CASE WHEN v_voided THEN now() END,
    CASE WHEN v_voided THEN 'refunded' END,
    -- an open dispute the order kept from before its commission existed holds it from the start
    -- (02035); a voided row holds nothing
    CASE WHEN v_voided THEN NULL ELSE v_order.affiliate_disputed_at END
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

-- ---------------------------------------------------------------------------
-- 3b. public.set_affiliate_commission_dispute: a dispute that opens before the commission
-- ---------------------------------------------------------------------------
-- 02030's definition with the order row locked first and one more branch: an attributed order
-- with no commission yet keeps the dispute (orders.affiliate_disputed_at) instead of answering
-- 'none' and forgetting it, and affiliate_record_commission() (section 3) records that commission
-- held. Without it, a commission recorded late (reconcile after a pause) whose hold, counted from
-- the payment, had passed would be promoted, claimed and transferred in one payout run on a
-- disputed sale. Signature, SECURITY INVOKER, search_path, grants and the three answers are
-- 02030's.
--
-- Payment disputes (finding L). Returns 'held' | 'released' | 'none'.
--   p_open = true (Stripe charge.dispute.created, Freemius payment.dispute.created): the order's
--     PENDING_CLEARANCE / CLEARED commission gets disputed_at ('held'; again 'held' on a
--     redelivery), so promote, claim and retry skip it: it neither clears nor is transferred
--     while the dispute is open. One already attached to a PROCESSING payout is held too: that
--     transfer is not stopped (complete_affiliate_payout still marks it PAID), but if it fails
--     the retry detaches the commission instead of re-sending it. A PAID or voided commission:
--     'none'. An attributed order with no commission yet keeps the dispute itself
--     (affiliate_disputed_at, first date kept; 'held'), and the commission recorded later starts
--     with disputed_at. An unattributed or unknown order: 'none'.
--   p_open = false (won, or closed without a loss): the hold is cleared whatever the status, the
--     order's included ('released'; 'none' when nothing was held). A lost dispute is a full
--     refund and goes through apply_affiliate_refund().
-- Lock order: the order row first, as apply_affiliate_refund() takes it (the orders triggers hold
-- it while they record or void, so a dispute racing the paid update waits for its commission),
-- then A2: the profile, then the commission, re-read under the profile lock. reconcile records
-- while it holds the profile lock and reads the order without locking it, so "no commission yet"
-- is decided only once no recording can be in flight, and a recording that waited for this one
-- reads the dispute it kept.
CREATE OR REPLACE FUNCTION public.set_affiliate_commission_dispute(p_gateway public.affiliate_gateway, p_order_id uuid, p_open boolean)
    RETURNS text
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_order record;
  v_affiliate uuid;
  v_commission record;
  v_order_released boolean := false;
BEGIN
  IF p_gateway IS NULL OR p_order_id IS NULL OR p_open IS NULL THEN
    RETURN 'none';
  END IF;

  SELECT o.id, o.affiliate_id, o.affiliate_disputed_at
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
  SELECT c.id, c.status::text AS status, c.disputed_at
    INTO v_commission
    FROM public.affiliate_commissions c
   WHERE c.order_id = p_order_id AND c.gateway = p_gateway
   FOR UPDATE;

  IF NOT FOUND THEN
    -- no commission yet (02035): the order keeps the dispute for the commission recorded later
    IF v_order.id IS NULL OR v_order.affiliate_id IS DISTINCT FROM v_affiliate THEN
      RETURN 'none';
    END IF;
    IF p_open THEN
      IF v_order.affiliate_disputed_at IS NULL THEN
        UPDATE public.orders o SET affiliate_disputed_at = now() WHERE o.id = p_order_id;
      END IF;
      RETURN 'held';
    END IF;
    IF v_order.affiliate_disputed_at IS NULL THEN
      RETURN 'none';
    END IF;
    UPDATE public.orders o SET affiliate_disputed_at = NULL WHERE o.id = p_order_id;
    RETURN 'released';
  END IF;

  IF NOT p_open THEN
    -- a dispute the order kept from before its commission existed is lifted with it (02035)
    IF v_order.affiliate_disputed_at IS NOT NULL THEN
      UPDATE public.orders o SET affiliate_disputed_at = NULL WHERE o.id = p_order_id;
      v_order_released := true;
    END IF;
    IF v_commission.disputed_at IS NULL THEN
      IF v_order_released THEN
        RETURN 'released';
      END IF;
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

-- ---------------------------------------------------------------------------
-- 4. private.affiliate_profile_guard: tier_changed_at
-- ---------------------------------------------------------------------------
-- 02030's definition with two changes: tier_changed_at joins the columns a non-admin session may
-- not change, and every writer that changes tier_id gets tier_changed_at = now() (whatever the
-- statement wrote there). An INSERT leaves it NULL: a partner is in the sign-up tier since
-- created_at.
--
-- A request that carries a user session (auth.uid() is set) and is not an ADMIN on a satisfied
-- second factor may not change any column the partner does not own. It keys off the session,
-- not the SQL role (02021's protect_profile_role reasoning): service_role and postgres carry no
-- session. total_clicks / last_click_at are not on the list (record_affiliate_click() bumps
-- them from any session; the column grants already pin them, A15). The same session may not
-- change display_name, bio or social_links while the partner's page is PENDING_REVIEW either
-- (finding A): approval snapshots them, and the portal withdraws the submission first. The review
-- lock is session-scoped on purpose: server writes (portal actions, the upload route, the
-- sandbox demo) carry no session and are held by the app, whose Approve pins the profile the
-- reviewer saw. Then, for every writer: a tier move stamps tier_changed_at, the handle is
-- lower-cased and onboarding_step is recomputed from the lifecycle timestamps.
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
          OR NEW.tier_changed_at IS DISTINCT FROM OLD.tier_changed_at
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

  IF TG_OP = 'UPDATE' AND NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
    NEW.tier_changed_at := now();
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

-- ---------------------------------------------------------------------------
-- 5. public.change_affiliate_partner_tier (service role only)
-- ---------------------------------------------------------------------------
-- The CMS "Change tier" move (lib/affiliates/review.ts, after requireCmsAdmin()). Lock order: the
-- partner profile, then both tier rows in the order create_affiliate_account() locks tiers
-- (default sign-up tiers first, highest sort_order first among them, then the others by
-- sort_order, then created_at and id), so a move never deadlocks with a concurrent sign-up or
-- another move; the member_count trigger then updates rows already held. Everything is checked
-- under those locks, so two moves into the last spot of a capped tier cannot both pass.
-- Returns:
--   'not_found'      no such partner
--   'unchanged'      the partner is already in that tier (nothing written)
--   'tier_not_found' no such tier
--   'tier_inactive'  the tier is inactive
--   'tier_full'      the tier is capped, member_count >= the cap, and p_allow_over_cap is false
--   'moved'          tier_id written: the member_count trigger moves the counts and the profile
--                    guard stamps tier_changed_at; orders paid from now on store the new rate
-- The partner's status is never checked: a paused partner can be moved.
CREATE OR REPLACE FUNCTION public.change_affiliate_partner_tier(p_affiliate_id uuid, p_tier_id uuid, p_allow_over_cap boolean DEFAULT false)
    RETURNS text
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_profile record;
  v_target record;
BEGIN
  IF p_affiliate_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT p.id, p.tier_id INTO v_profile
    FROM public.affiliate_profiles p
   WHERE p.id = p_affiliate_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF p_tier_id IS NULL THEN
    RETURN 'tier_not_found';
  END IF;
  IF v_profile.tier_id = p_tier_id THEN
    RETURN 'unchanged';
  END IF;

  PERFORM 1
     FROM public.affiliate_tiers t
    WHERE t.id IN (v_profile.tier_id, p_tier_id)
    ORDER BY t.is_default_signup_tier DESC,
             CASE WHEN t.is_default_signup_tier THEN -t.sort_order ELSE t.sort_order END,
             t.created_at,
             t.id
      FOR UPDATE;

  SELECT t.id, t.is_active, t.max_ambassadors_cap, t.member_count INTO v_target
    FROM public.affiliate_tiers t
   WHERE t.id = p_tier_id;
  IF NOT FOUND THEN
    RETURN 'tier_not_found';
  END IF;
  IF NOT v_target.is_active THEN
    RETURN 'tier_inactive';
  END IF;
  IF v_target.max_ambassadors_cap IS NOT NULL
     AND v_target.member_count >= v_target.max_ambassadors_cap
     AND NOT coalesce(p_allow_over_cap, false) THEN
    RETURN 'tier_full';
  END IF;

  UPDATE public.affiliate_profiles p
     SET tier_id = p_tier_id
   WHERE p.id = v_profile.id;
  RETURN 'moved';
END;
$$;

REVOKE ALL ON FUNCTION public.change_affiliate_partner_tier(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_affiliate_partner_tier(uuid, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Comments (02030's that this file makes wrong, and the new objects)
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN public.orders.affiliate_commission_rate IS 'The partner''s tier rate when the order was paid (private.affiliate_snapshot_order_rate, 02035); the commission is recorded at this rate whenever it is recorded. NULL for an unattributed order or one paid before 02035 (recorded at the tier in effect then).';
COMMENT ON COLUMN public.orders.affiliate_clearance_hold_days IS 'The partner''s tier clearance hold when the order was paid (02035): the commission clears this many days after paid_at. NULL as for affiliate_commission_rate.';
COMMENT ON COLUMN public.affiliate_profiles.tier_changed_at IS 'When tier_id last changed (stamped by affiliate_profile_guard for every writer); NULL = in the sign-up tier since created_at. A partner session cannot write it.';
COMMENT ON COLUMN public.affiliate_tiers.commission_percentage IS 'Share of the net order amount (subtotal minus discount, no tax or shipping). Copied onto an attributed order when it is paid (orders.affiliate_commission_rate), so a rate edit or a tier move applies only to orders paid afterwards.';
COMMENT ON COLUMN public.affiliate_tiers.clearance_hold_days IS 'Refund-protection hold, copied onto an attributed order when it is paid (orders.affiliate_clearance_hold_days): its commission clears this many days after the payment.';
COMMENT ON COLUMN public.affiliate_commissions.commission_rate_snapshot IS 'Rate the commission was recorded at: the rate stored on the order at payment (orders.affiliate_commission_rate), else the partner''s tier rate at recording for an order paid before 02035.';
COMMENT ON COLUMN public.affiliate_commissions.clears_at IS 'End of the refund-protection hold: the order''s paid_at plus the hold stored on the order at payment (else the tier''s); a commission recorded after that clears at the next promote, unless an open dispute holds it (disputed_at).';
COMMENT ON COLUMN public.orders.affiliate_disputed_at IS 'Open payment dispute on an attributed order that had no commission yet (set_affiliate_commission_dispute, 02035); cleared when it closes without a loss. affiliate_record_commission records the commission with this as disputed_at, so it is held until the dispute closes.';
COMMENT ON COLUMN public.affiliate_commissions.disputed_at IS 'Open payment dispute (set_affiliate_commission_dispute): while set, the commission is not promoted, claimed or re-sent by a retry. A dispute that opened before the commission was recorded is copied from orders.affiliate_disputed_at (02035).';
COMMENT ON FUNCTION public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean) IS 'Service role: holds (open) or releases (closed without a loss) the commission of a disputed order, or keeps the dispute on an attributed order that has no commission yet (orders.affiliate_disputed_at, 02035); returns held, released or none.';
COMMENT ON FUNCTION public.change_affiliate_partner_tier(uuid, uuid, boolean) IS 'Service role: moves a partner to another tier under row locks; returns not_found, unchanged, tier_not_found, tier_inactive, tier_full (a full capped tier without p_allow_over_cap) or moved. Never checks the partner''s status.';

-- ---------------------------------------------------------------------------
-- 7. UI copy (the forms the 02031 generator header prescribes)
-- ---------------------------------------------------------------------------
-- New key: the partner portal overview's "Tier since {date}".
INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('affiliates.portal.overview_tier_since', jsonb_build_object('en', 'Tier since {date}', 'fr', 'À ce niveau depuis le {date}'), now(), now())
ON CONFLICT (key) DO NOTHING;

-- Changed text: the partner terms clause on rate changes, each language guarded by the text 02031
-- seeded, so a clause an operator edited (CMS > Settings > Extra Translations) stays theirs.
UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{en}', to_jsonb(fix.new_en)), updated_at = now()
  FROM (VALUES
    ('affiliates.terms.earning_rate_changes',
     'A rate change applies only to commissions recorded after the change.',
     'A rate change applies only to orders paid after the change.')
  ) AS fix(key, old_en, new_en)
 WHERE t.key = fix.key AND t.translations->>'en' = fix.old_en;

UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)), updated_at = now()
  FROM (VALUES
    ('affiliates.terms.earning_rate_changes',
     'Un changement de taux s''applique seulement aux commissions inscrites après ce changement.',
     'Un changement de taux s''applique seulement aux commandes payées après ce changement.')
  ) AS fix(key, old_fr, new_fr)
 WHERE t.key = fix.key AND t.translations->>'fr' = fix.old_fr;
