-- 02036: commissions paid outside Stripe (Affiliates & Creator Storefronts, docs/15 → "Paying
-- partners manually").
--
-- Partners are paid by Stripe Connect transfers from the platform's Stripe balance. Freemius pays
-- the operator (monthly, by PayPal), never the partners, and that money never reaches the Stripe
-- balance (and Canada has no Stripe top-ups), so a store that sells digital products through
-- Freemius cannot fund those commissions in Stripe. A partner's Stripe Express account cannot receive
-- money from PayPal either. So the program now routes each gateway's commissions either to Stripe
-- Connect (as before) or to "manual" (affiliates_settings.payoutMethods, read by the app): the daily
-- run leaves manual-routed commissions out of every transfer, and the operator sends that money from
-- PayPal, Interac e-Transfer, Wise or a bank and records it in the CMS. This file:
--
-- 1. affiliate_payouts gains the payout's method: 'stripe_connect' (default, every existing row) or
--    'manual'. A Stripe payout still needs its destination account; a manual one carries no Stripe
--    field at all (stripe_destination_account becomes nullable; no destination and no transfer id,
--    so complete_affiliate_payout() and prepare_affiliate_payout_retry(), which write them, can never
--    touch a manual payout). A manual payout is claimed BEFORE the money is sent, like a Stripe one:
--    PROCESSING while it is prepared (its commissions reserved for it), COMPLETED once the admin
--    records it, never FAILED (a cancelled one is deleted and its commissions handed back). A
--    recorded one names its channel (paypal, interac, wise, bank_transfer, other) and carries the
--    admin's reference (the PayPal transaction ID, e-Transfer or bank reference; unique per partner,
--    case ignored), an optional note the partner reads, and the admin who recorded it (recorded_by).
--    One prepared payout per partner and currency at a time.
-- 2. affiliate_profiles.payout_email: where the partner wants manual payouts sent (PayPal or
--    Interac e-Transfer). The portal writes it for the partner with the service role after
--    requireRetailer(), like every other portal write, so it gets no Data API grant: authenticated
--    keeps exactly its four self-service UPDATE columns (02030, re-pinned by the post-apply pass),
--    and private.affiliate_profile_guard() (02035's definition plus this column) refuses it from a
--    partner session even with table rights. anon reads no partner table at all. Its CHECK also
--    refuses a leading =, +, - or @: a spreadsheet would read such an address as a formula, and the
--    PayPal payouts file would have to rewrite it (a different, still valid recipient).
-- 3. public.claim_affiliate_payout gains p_gateways public.affiliate_gateway[] DEFAULT NULL: only
--    commissions of those gateways are claimed (NULL = every gateway, the behaviour before this
--    file). The 4-argument function is dropped (a call with four arguments resolves to this one; two
--    overloads would make PostgREST refuse it with PGRST203), and the new one is 02030's body with
--    that filter on each of its four commission statements. The app passes the gateways routed to
--    Stripe; when none is, it never calls Stripe.
-- 4. The manual payout lifecycle, three service-role RPCs in the claim's lock order (the profile, the
--    commissions, the payout), each answering a status instead of raising for every expected case:
--    - claim_manual_affiliate_payout(affiliate, currency, min amount, gateways), the CMS "Prepare":
--      for an ACTIVE, approved partner, the CLEARED, unattached, undisputed, live-mode commissions of
--      that currency and those gateways (refunded or cancelled orders voided first, as the claim
--      does) are attached to a new PROCESSING manual payout of their sum. The admin sends exactly
--      that amount afterwards, so nothing can change under the payment: a refund or a dispute that
--      arrives meanwhile takes the in-flight path (flagged and alerted, never silently taken out),
--      and a commission that clears later waits for the next payout. A test-mode commission is
--      never paid with real money.
--    - record_manual_affiliate_payout(payout, channel, reference, note, recorded_by), the CMS "Record
--      payout": once the money left, that exact payout becomes COMPLETED with the reference, its
--      commissions PAID and total_paid_cents up by its amount, as complete_affiliate_payout() does
--      for a transfer (no eligibility or amount check: the money was sent).
--    - cancel_manual_affiliate_payout(payout), the CMS "Cancel": a prepared payout given up before any
--      money left; the refund work owed to its commissions is applied (A8), the rest are handed back
--      to the cleared balance and the row is deleted.
-- 5. private.affiliate_alert_refund_after_payout (02030's definition): a refund after a recorded
--    MANUAL payout says "Recover the amount from the partner, for example by asking them to send it
--    back" instead of the Stripe reversal advice; one whose manual payout is only prepared says to
--    cancel and prepare it again if it was not sent yet. The metadata names the payout's method and
--    status. The ledger still has no clawback: a refund after any payout is flagged and alerted,
--    never taken back automatically (and nothing deducts it from a later payout).
-- 6. The UI copy of the partner side (section 7): new portal and terms keys, and the terms, landing
--    and onboarding lines that promised every payout would go through Stripe, each changed only
--    where it still holds the text 02031 seeded.
--
-- Grants. No table, view or sequence is created; the new columns ride the existing table grants
-- (02030: authenticated SELECT through the owner and ADMIN policies, so a partner reads its own
-- payout rows, note included; no API write on payouts; the profile column grants as above). The
-- four RPCs are SECURITY INVOKER in public, revoked from PUBLIC, anon and authenticated here and in
-- BOTH copies of API_ROLE_REVOKE_SQL (apps/nextblock/tools/lib/migrate-core.mjs,
-- apps/nextblock/lib/setup/schema-apply.ts). The two redefined private functions keep 02030's
-- SECURITY DEFINER, search_path and grants (restated below). tools/scripts/security-verify.sql
-- section 40 checks all of it, and section 35 pins the new claim signature.
--
-- Append-only, forward-only, idempotent: ADD COLUMN IF NOT EXISTS, constraints and the foreign key
-- added only when missing, CREATE UNIQUE INDEX IF NOT EXISTS, DROP FUNCTION IF EXISTS before the new
-- claim, CREATE OR REPLACE elsewhere; it replays cleanly after 02000-02035 on an empty database and
-- on one that holds data (every existing payout is a Stripe transfer with a destination).

-- 02001 turns body validation off for the session; a one-connection replay would otherwise
-- create every function below unchecked.
SET check_function_bodies = on;

-- ---------------------------------------------------------------------------
-- 1. affiliate_payouts: the method of a payout, and what a manual one records
-- ---------------------------------------------------------------------------
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'stripe_connect';
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS manual_channel text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS external_reference text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS note text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS recorded_by uuid NULL;
-- A manual payout has no Connect account; a Stripe payout still needs one (the CHECK below).
ALTER TABLE public.affiliate_payouts ALTER COLUMN stripe_destination_account DROP NOT NULL;

DO $nb_02036_payouts$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_method_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_method_check CHECK (method IN ('stripe_connect', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_destination_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_destination_check CHECK (method <> 'stripe_connect' OR stripe_destination_account IS NOT NULL);
  END IF;
  -- a manual payout is prepared (PROCESSING, its commissions reserved) or recorded (COMPLETED); it
  -- never fails (a cancelled one is deleted), so fail_affiliate_payout() and release_affiliate_payout()
  -- never apply to it
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_manual_status_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_manual_status_check CHECK (
        method = 'stripe_connect'
        OR status IN ('PROCESSING'::public.affiliate_payout_status, 'COMPLETED'::public.affiliate_payout_status));
  END IF;
  -- a manual payout carries no Stripe field: complete_affiliate_payout() (transfer id) and
  -- prepare_affiliate_payout_retry() (destination) can never complete or re-send one
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_manual_stripe_fields_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_manual_stripe_fields_check CHECK (
        method <> 'manual' OR (stripe_destination_account IS NULL AND stripe_transfer_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_manual_channel_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_manual_channel_check CHECK (
        manual_channel IS NULL OR manual_channel IN ('paypal', 'interac', 'wise', 'bank_transfer', 'other'));
  END IF;
  -- a recorded manual payout names its channel and reference and when it was paid
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_manual_recorded_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_manual_recorded_check CHECK (
        method <> 'manual' OR status <> 'COMPLETED'::public.affiliate_payout_status
        OR (manual_channel IS NOT NULL AND external_reference IS NOT NULL AND paid_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_external_reference_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_external_reference_check CHECK (external_reference IS NULL OR char_length(external_reference) <= 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_note_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_note_check CHECK (note IS NULL OR char_length(note) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_recorded_by_fkey' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users (id) ON DELETE SET NULL;
  END IF;
END
$nb_02036_payouts$;

-- One manual payout per reference and partner (a PayPal transaction recorded twice would pay the
-- same commissions twice in the books); record_manual_affiliate_payout() answers
-- 'duplicate_reference' first, the index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_manual_reference_key
  ON public.affiliate_payouts (affiliate_id, lower(external_reference))
  WHERE method = 'manual' AND external_reference IS NOT NULL;

-- One prepared (not yet recorded) manual payout per partner and currency: the PayPal file and the
-- "Record payout" row each name exactly one. claim_manual_affiliate_payout() answers
-- 'already_prepared' first, under the profile lock; the index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_manual_prepared_key
  ON public.affiliate_payouts (affiliate_id, currency)
  WHERE method = 'manual' AND status = 'PROCESSING'::public.affiliate_payout_status;

-- ---------------------------------------------------------------------------
-- 2. affiliate_profiles.payout_email (server-written; no Data API grant)
-- ---------------------------------------------------------------------------
ALTER TABLE public.affiliate_profiles ADD COLUMN IF NOT EXISTS payout_email text NULL;

DO $nb_02036_profiles$
BEGIN
  -- a simple shape: one @, no whitespace, at most 254 characters (the app validates more strictly),
  -- and no leading =, +, - or @: a spreadsheet reads such a cell as a formula, and neutralizing it in
  -- the PayPal payouts file would change the recipient
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_profiles_payout_email_check' AND conrelid = 'public.affiliate_profiles'::regclass) THEN
    ALTER TABLE public.affiliate_profiles
      ADD CONSTRAINT affiliate_profiles_payout_email_check CHECK (
        payout_email IS NULL OR (char_length(payout_email) <= 254 AND payout_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
                                 AND payout_email !~ '^[=+@-]'));
  END IF;
END
$nb_02036_profiles$;

-- 02035's definition with one change: payout_email joins the columns a non-admin session may not
-- change (the portal writes it with the service role, which carries no session). Signature,
-- SECURITY DEFINER, search_path, grants and the trigger are 02030's.
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
          OR NEW.payout_email IS DISTINCT FROM OLD.payout_email
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
-- 3. public.claim_affiliate_payout: only the gateways routed to Stripe
-- ---------------------------------------------------------------------------
-- 02030's definition with one change: p_gateways (NULL = every gateway) filters the commissions on
-- each of the four statements that select them (the lock, the void loop, the sum and the attaching
-- UPDATE). The old signature is dropped first: with both, a four-argument call would match two
-- functions. Security, search_path, owner semantics and grants are 02030's.
--
-- Claims a payout for one partner and currency: the partner must be ACTIVE, approved and
-- onboarded to Stripe Connect with an account of a known key mode; CLEARED, unattached
-- commissions in p_currency of that mode (finding C: a test-mode sale is only ever paid by a
-- test-mode transfer, a live one by a live transfer) that no open dispute holds (finding L), of the
-- gateways in p_gateways (02036: those the program pays through Stripe), are locked, those whose
-- order is now refunded or cancelled are voided (A11), and the rest are attached to a new PROCESSING
-- payout of sum(commission - refunded) with a snapshot of the destination account and its mode.
-- Returns no row when nothing is claimable or the sum is below p_min_amount.
DROP FUNCTION IF EXISTS public.claim_affiliate_payout(uuid, text, bigint, text);
CREATE OR REPLACE FUNCTION public.claim_affiliate_payout(
    p_affiliate_id uuid, p_currency text, p_min_amount bigint, p_trigger text, p_gateways public.affiliate_gateway[] DEFAULT NULL)
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
      AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways))
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
       AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways))
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
     AND c.disputed_at IS NULL
     AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways));
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
     AND c.disputed_at IS NULL
     AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways));

  RETURN NEXT v_payout;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The manual payout lifecycle (service role only): claim, record, cancel
-- ---------------------------------------------------------------------------
-- The CMS "Pay manually" section (lib/affiliates/manual-payouts.ts, after requireCmsAdmin()). A
-- manual payout follows the Stripe path's order: the commissions are claimed (PROCESSING) BEFORE any
-- money is sent, so what the admin sends, what the PayPal file lists and what gets recorded are the
-- same commissions. A refund, a lost dispute or a cancellation that arrives while the payout is
-- prepared takes the in-flight path of private.affiliate_void_order_commissions() and
-- apply_affiliate_refund() (void_requested_at / refund_pending_cents and a refund-after-payout
-- alert), a dispute only holds the commission (disputed_at), and a commission that clears later is
-- left for the next payout. Nothing here moves money. Lock order of the claim and of
-- complete_affiliate_payout(): the profile, then the commissions, then the payout.

-- claim_manual_affiliate_payout(): the CMS "Prepare payout" (and "Prepare PayPal payouts", which
-- passes the program minimum). For an ACTIVE, approved partner (paused partners are not paid, as the
-- terms say) with no prepared manual payout in that currency yet, the CLEARED, unattached,
-- undisputed, live-mode commissions of p_currency and the gateways in p_gateways (NULL = every
-- gateway) are locked, those whose order is refunded or cancelled are voided exactly as the claim
-- does, and the rest are attached to a new PROCESSING manual payout of sum(commission - refunded).
-- Only live-mode commissions: a test-mode sale (Stripe test key, Freemius sandbox) is never paid
-- with real money. Answers:
--   {"status": "invalid_input"}       a currency that is not three letters
--   {"status": "not_found"}           no such partner
--   {"status": "not_eligible"}        the partner is not ACTIVE or was never approved
--   {"status": "already_prepared", "payout_id": id, "amount_cents": n}
--                                     a prepared payout of that currency waits to be recorded or
--                                     cancelled (one at a time per partner and currency)
--   {"status": "nothing_owed"}        nothing of that currency and those gateways is left (after the voids)
--   {"status": "below_minimum", "amount_cents": n, "commission_count": n}
--                                     the sum is below p_min_amount: nothing is reserved
--   {"status": "prepared", "payout_id": id, "amount_cents": n, "commission_count": n}
CREATE OR REPLACE FUNCTION public.claim_manual_affiliate_payout(
    p_affiliate_id uuid, p_currency text, p_min_amount bigint DEFAULT 0, p_gateways public.affiliate_gateway[] DEFAULT NULL)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_profile record;
  v_existing record;
  v_order record;
  v_amount bigint;
  v_count integer;
  v_payout_id uuid;
BEGIN
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  IF p_affiliate_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT p.id, p.status::text AS status, p.first_published_at
    INTO v_profile
    FROM public.affiliate_profiles p
   WHERE p.id = p_affiliate_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_profile.status <> 'ACTIVE' OR v_profile.first_published_at IS NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- read under the profile lock: a concurrent claim of the same partner committed before it
  SELECT po.id, po.amount_cents
    INTO v_existing
    FROM public.affiliate_payouts po
   WHERE po.affiliate_id = p_affiliate_id
     AND po.method = 'manual'
     AND po.status = 'PROCESSING'::public.affiliate_payout_status
     AND po.currency = v_currency
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_prepared', 'payout_id', v_existing.id, 'amount_cents', v_existing.amount_cents);
  END IF;

  PERFORM 1 FROM public.affiliate_commissions c
    WHERE c.affiliate_id = p_affiliate_id
      AND c.status = 'CLEARED'::public.affiliate_commission_status
      AND c.payout_id IS NULL
      AND c.currency = v_currency
      AND c.livemode = true
      AND c.disputed_at IS NULL
      AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways))
    FOR UPDATE;

  FOR v_order IN
    SELECT DISTINCT c.order_id, o.status
      FROM public.affiliate_commissions c
      JOIN public.orders o ON o.id = c.order_id
     WHERE c.affiliate_id = p_affiliate_id
       AND c.status = 'CLEARED'::public.affiliate_commission_status
       AND c.payout_id IS NULL
       AND c.currency = v_currency
       AND c.livemode = true
       AND c.disputed_at IS NULL
       AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways))
       AND o.status IN ('refunded', 'cancelled')
  LOOP
    PERFORM private.affiliate_void_order_commissions(v_order.order_id, v_order.status);
  END LOOP;

  SELECT coalesce(sum(c.commission_amount_cents - c.refunded_amount_cents), 0)::bigint, count(*)::integer
    INTO v_amount, v_count
    FROM public.affiliate_commissions c
   WHERE c.affiliate_id = p_affiliate_id
     AND c.status = 'CLEARED'::public.affiliate_commission_status
     AND c.payout_id IS NULL
     AND c.currency = v_currency
     AND c.livemode = true
     AND c.disputed_at IS NULL
     AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways));
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_owed');
  END IF;
  IF v_amount < GREATEST(coalesce(p_min_amount, 0), 0) THEN
    RETURN jsonb_build_object('status', 'below_minimum', 'amount_cents', v_amount, 'commission_count', v_count);
  END IF;

  INSERT INTO public.affiliate_payouts (
    affiliate_id, amount_cents, currency, stripe_destination_account, livemode, status, attempt_count, last_attempt_at,
    trigger, method
  )
  VALUES (
    p_affiliate_id, v_amount, v_currency, NULL, true, 'PROCESSING'::public.affiliate_payout_status, 1, now(),
    'admin', 'manual'
  )
  RETURNING id INTO v_payout_id;

  UPDATE public.affiliate_commissions c
     SET payout_id = v_payout_id
   WHERE c.affiliate_id = p_affiliate_id
     AND c.status = 'CLEARED'::public.affiliate_commission_status
     AND c.payout_id IS NULL
     AND c.currency = v_currency
     AND c.livemode = true
     AND c.disputed_at IS NULL
     AND (p_gateways IS NULL OR c.gateway = ANY (p_gateways));
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('status', 'prepared', 'payout_id', v_payout_id, 'amount_cents', v_amount, 'commission_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[]) TO service_role;

-- record_manual_affiliate_payout(): the CMS "Record payout", once the money of a prepared payout
-- left (p_recorded_by is the verified admin, never a value from the request). That exact payout
-- becomes COMPLETED with the channel, the reference, the note the partner reads and paid_at; its
-- commissions become PAID and the partner's total_paid_cents grows by its amount, as
-- complete_affiliate_payout() does for a transfer. No eligibility or amount check: the money was
-- sent (a partner paused since, or a refund flagged since, changes nothing here; the refund already
-- raised its alert). Answers:
--   {"status": "invalid_input"}       an unknown channel, a reference over 120 or a note over 500 characters
--   {"status": "reference_required"}  an empty reference
--   {"status": "not_found"}           no such manual payout (it was cancelled, or it is a Stripe payout)
--   {"status": "already_recorded"}    it is COMPLETED already (a second click, or another admin)
--   {"status": "duplicate_reference"} another manual payout of this partner has this reference (case ignored)
--   {"status": "recorded", "payout_id": id, "affiliate_id": id, "amount_cents": n, "currency": c, "commission_count": n}
CREATE OR REPLACE FUNCTION public.record_manual_affiliate_payout(
    p_payout_id uuid, p_channel text, p_reference text, p_note text, p_recorded_by uuid)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_affiliate uuid;
  v_payout record;
  v_count integer;
BEGIN
  IF v_channel NOT IN ('paypal', 'interac', 'wise', 'bank_transfer', 'other')
     OR char_length(coalesce(v_reference, '')) > 120
     OR char_length(coalesce(v_note, '')) > 500 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  IF v_reference IS NULL THEN
    RETURN jsonb_build_object('status', 'reference_required');
  END IF;

  SELECT po.affiliate_id INTO v_affiliate
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'manual';
  IF v_affiliate IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.amount_cents, po.currency
    INTO v_payout
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'manual'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_payout.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('status', 'already_recorded');
  END IF;
  -- read under the profile lock: a concurrent record of the same reference committed before it
  IF EXISTS (
    SELECT 1 FROM public.affiliate_payouts po
     WHERE po.affiliate_id = v_affiliate
       AND po.method = 'manual'
       AND po.id <> p_payout_id
       AND po.external_reference IS NOT NULL
       AND lower(po.external_reference) = lower(v_reference)
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate_reference');
  END IF;

  UPDATE public.affiliate_payouts
     SET status = 'COMPLETED'::public.affiliate_payout_status, paid_at = now(), manual_channel = v_channel,
         external_reference = v_reference, note = v_note, recorded_by = p_recorded_by
   WHERE id = p_payout_id;
  UPDATE public.affiliate_commissions c
     SET status = 'PAID'::public.affiliate_commission_status, paid_at = now()
   WHERE c.payout_id = p_payout_id
     AND c.status IN ('PENDING_CLEARANCE'::public.affiliate_commission_status, 'CLEARED'::public.affiliate_commission_status);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.affiliate_profiles SET total_paid_cents = total_paid_cents + v_payout.amount_cents WHERE id = v_affiliate;

  RETURN jsonb_build_object('status', 'recorded', 'payout_id', p_payout_id, 'affiliate_id', v_affiliate,
                            'amount_cents', v_payout.amount_cents, 'currency', v_payout.currency, 'commission_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.record_manual_affiliate_payout(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_affiliate_payout(uuid, text, text, text, uuid) TO service_role;

-- cancel_manual_affiliate_payout(): the CMS "Cancel" of a prepared payout, before any money left.
-- The work the payout owes its commissions is applied (A8: a refund flagged while it was prepared
-- voids or reduces its commission), every commission left is handed back to the cleared balance
-- (for a later payout, manual or Stripe) and the row is deleted: it moved no money, and a manual
-- payout is never FAILED. Answers:
--   {"status": "not_found"}           no such manual payout (cancelled already, or a Stripe payout)
--   {"status": "already_recorded"}    it is COMPLETED: a recorded payout cannot be cancelled
--   {"status": "cancelled", "commission_count": n}   n commissions handed back
CREATE OR REPLACE FUNCTION public.cancel_manual_affiliate_payout(p_payout_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_status text;
  v_count integer;
BEGIN
  SELECT po.affiliate_id INTO v_affiliate
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'manual';
  IF v_affiliate IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text INTO v_status
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'manual'
   FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('status', 'already_recorded');
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);
  UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.affiliate_payouts po WHERE po.id = p_payout_id;

  RETURN jsonb_build_object('status', 'cancelled', 'commission_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_manual_affiliate_payout(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_manual_affiliate_payout(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. private.affiliate_alert_refund_after_payout: the advice follows the payout's method
-- ---------------------------------------------------------------------------
-- 02030's definition with one change: the advice follows the payout's method and status. A manual
-- payout already recorded (COMPLETED) has no Stripe transfer to reverse: the admin recovers the
-- amount from the partner (asking them to send it back; nothing in the ledger deducts it from a
-- later payout, which would only record a false amount). A manual payout still prepared
-- (PROCESSING) may not have been sent yet: the admin cancels it and prepares it again, so the
-- refunded commission is voided first, or, if the money already left, records it and recovers the
-- amount. The metadata names the method and the status (payout_method, payout_status). Signature,
-- SECURITY DEFINER, search_path, grants and the one-unresolved-alert-per-commission rule are 02030's.
--
-- One unresolved affiliate_refund_after_payout alert per commission (A19 text and metadata).
CREATE OR REPLACE FUNCTION private.affiliate_alert_refund_after_payout(
    p_commission_id uuid, p_affiliate_id uuid, p_order_id uuid, p_payout_id uuid, p_reason text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_method text;
  v_status text;
  v_manual boolean := false;
  v_advice text;
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
  IF p_payout_id IS NOT NULL THEN
    SELECT po.method, po.status::text INTO v_method, v_status FROM public.affiliate_payouts po WHERE po.id = p_payout_id;
    v_manual := coalesce(v_method = 'manual', false);
  END IF;
  v_advice := CASE
    WHEN v_manual AND v_status = 'PROCESSING' THEN 'Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.'
    WHEN v_manual THEN 'Recover the amount from the partner, for example by asking them to send it back.'
    ELSE 'Reverse the transfer in Stripe if needed.'
  END;
  INSERT INTO public.system_alerts (alert_type, title, message, metadata)
  VALUES (
    'affiliate_refund_after_payout',
    'Refund after an affiliate payout',
    CASE
      WHEN p_reason = 'order_deleted' THEN
        format('Order %s was deleted after its commission was paid or queued. %s', coalesce(p_order_id::text, 'unknown'), v_advice)
      ELSE
        format('Order %s was refunded after its commission was paid or queued. %s', coalesce(p_order_id::text, 'unknown'), v_advice)
    END,
    jsonb_build_object(
      'commission_id', p_commission_id,
      'affiliate_id', p_affiliate_id,
      'order_id', p_order_id,
      'payout_id', p_payout_id,
      'payout_method', CASE WHEN v_manual THEN 'manual' ELSE 'stripe_connect' END,
      'payout_status', v_status,
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
-- 6. Comments (02030's that this file makes wrong, and the new objects)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.affiliate_payouts IS 'Payouts to partners: Stripe Connect transfers (method stripe_connect) and payouts the operator sends outside Stripe (method manual, 02036), each claimed before the money moves (PROCESSING). A manual payout is COMPLETED when an admin records it and deleted when cancelled, never FAILED. Written only by the service-role RPCs; the partner reads its own rows.';
COMMENT ON COLUMN public.affiliate_payouts.stripe_destination_account IS 'Connect account snapshot at claim (refreshed on retry); required for a Stripe payout, NULL for a manual one (02036).';
COMMENT ON COLUMN public.affiliate_payouts.method IS 'stripe_connect (a Stripe Connect transfer from the platform balance) or manual (money sent outside Stripe: prepared with claim_manual_affiliate_payout, recorded with record_manual_affiliate_payout, cancelled with cancel_manual_affiliate_payout; never carries a destination or a transfer id). 02036.';
COMMENT ON COLUMN public.affiliate_payouts.manual_channel IS 'Where a manual payout was sent from: paypal, interac (Interac e-Transfer), wise, bank_transfer or other. Required once a manual payout is recorded (COMPLETED); NULL while it is prepared.';
COMMENT ON COLUMN public.affiliate_payouts.external_reference IS 'A manual payout''s reference (the PayPal transaction ID, e-Transfer or bank reference), at most 120 characters, unique per partner (case ignored).';
COMMENT ON COLUMN public.affiliate_payouts.note IS 'An optional note from the admin, at most 500 characters. The partner reads it in the portal: never put anything internal here.';
COMMENT ON COLUMN public.affiliate_payouts.recorded_by IS 'The admin who recorded a manual payout (auth.users; NULL for a Stripe payout or once that account is deleted).';
COMMENT ON COLUMN public.affiliate_profiles.payout_email IS 'Where the partner wants manual payouts sent (a PayPal or Interac e-Transfer address), or NULL. Written by the server for the partner (the portal, after requireRetailer()) or by an admin; no Data API grant, and the profile guard refuses it from a partner session (02036).';
COMMENT ON TABLE public.affiliate_profiles IS 'One per partner (RTL) account. Created only by create_affiliate_account(); the owner may edit display_name, bio, social_links and preferred_locale over the Data API, everything else (payout_email included, written by the portal with the service role) is server- or ADMIN-written (column grants + affiliate_profile_guard).';
COMMENT ON FUNCTION public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[]) IS 'Service role: attaches a partner''s CLEARED, unattached, undisputed commissions of one currency, of the partner''s Connect key mode and of the gateways in p_gateways (NULL = all), to a new PROCESSING Stripe payout; no row when nothing is claimable or the sum is below p_min_amount.';
COMMENT ON FUNCTION public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[]) IS 'Service role: prepares a manual payout before any money is sent, attaching an ACTIVE, approved partner''s CLEARED, unattached, undisputed, live-mode commissions of one currency and of the gateways in p_gateways (NULL = all) to a new PROCESSING manual payout; one per partner and currency. Returns {status, ...}: invalid_input, not_found, not_eligible, already_prepared, nothing_owed, below_minimum or prepared.';
COMMENT ON FUNCTION public.record_manual_affiliate_payout(uuid, text, text, text, uuid) IS 'Service role: records that the money of a prepared manual payout was sent: COMPLETED with its channel, reference (unique per partner) and note, its commissions PAID, total_paid_cents up by its amount. Returns {status, ...}: invalid_input, reference_required, not_found, already_recorded, duplicate_reference or recorded.';
COMMENT ON FUNCTION public.cancel_manual_affiliate_payout(uuid) IS 'Service role: gives up a prepared manual payout before any money left: the pending refund work applied, its commissions handed back to the cleared balance, the row deleted. Returns {status, ...}: not_found, already_recorded or cancelled.';

-- ---------------------------------------------------------------------------
-- 7. UI copy of the partner side (the forms the 02031 generator header prescribes)
-- ---------------------------------------------------------------------------
-- The partner portal's payouts page now says how each commission is paid: the "How you get paid"
-- card and the payout email form (saveRetailerPayoutEmail), the figure for the payouts the store
-- sends by hand (and one it prepared and is sending), the commissions table's Payout column and
-- "PayPal · Ref. …" history rows. The
-- partner terms describe both ways of paying, the recovery after a refund (a Stripe transfer
-- reversal, or a deduction from a later payout) and what the PayPal payouts file shares; the
-- Program details table reads the method per kind of sale from the settings. The landing page and
-- the onboarding tracker no longer promise that every payout goes through Stripe.
--
-- New keys, never overwriting a row that already exists.
INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('affiliates.portal.balance_cleared_manual_hint', jsonb_build_object('en', 'Paid by {site} once it reaches {min}.', 'fr', 'Versé par {site} une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.balance_cleared_mixed_hint', jsonb_build_object('en', '{stripe} goes by Stripe transfer and {manual} is paid by {site}, each once it reaches {min}.', 'fr', '{stripe} part par virement Stripe et {manual} est versé par {site}, chacun une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.balance_next_manual_payout', jsonb_build_object('en', 'Next payout from {site}', 'fr', 'Prochain versement de {site}'), now(), now()),
  ('affiliates.portal.balance_processing_manual_hint', jsonb_build_object('en', 'We''re sending you {amount} directly.', 'fr', 'Nous vous envoyons {amount} directement.'), now(), now()),
  ('affiliates.portal.commission_payout_direct', jsonb_build_object('en', 'Sent directly', 'fr', 'Envoi direct'), now(), now()),
  ('affiliates.portal.commission_payout_stripe', jsonb_build_object('en', 'Stripe transfer', 'fr', 'Virement Stripe'), now(), now()),
  ('affiliates.portal.connect_intro_partial', jsonb_build_object('en', 'Connect a bank account through Stripe to receive the commissions we pay through Stripe. Stripe handles identity checks and bank details securely; we never see them.', 'fr', 'Connectez un compte bancaire par l''entremise de Stripe pour recevoir les commissions que nous payons par Stripe. Stripe s''occupe de façon sécurisée de la vérification d''identité et des coordonnées bancaires; nous n''y avons jamais accès.'), now(), now()),
  ('affiliates.portal.connect_ready_body_partial', jsonb_build_object('en', 'Cleared commissions we pay through Stripe are sent to your bank automatically. Manage your bank details and see transfers in your Stripe Express dashboard.', 'fr', 'Les commissions confirmées que nous payons par Stripe sont versées automatiquement dans votre compte bancaire. Gérez vos coordonnées bancaires et consultez vos virements dans votre tableau de bord Stripe Express.'), now(), now()),
  ('affiliates.portal.error_payout_email', jsonb_build_object('en', 'Enter a valid email address, like name@example.com.', 'fr', 'Entrez une adresse courriel valide, comme nom@exemple.com.'), now(), now()),
  ('affiliates.portal.faq_payout_answer_manual', jsonb_build_object('en', 'Once your cleared balance reaches {min}, {site} sends it to you directly, by PayPal or Interac e-Transfer. Each payout then appears in your payout history.', 'fr', 'Une fois que votre solde confirmé atteint {min}, {site} vous l''envoie directement, par PayPal ou virement Interac. Chaque versement apparaît ensuite dans votre historique des versements.'), now(), now()),
  ('affiliates.portal.faq_payout_answer_mixed', jsonb_build_object('en', 'It depends on the order: “How you get paid” above says which commissions go through Stripe. Those go to your bank in the daily payout run once they reach {min}. {site} sends you the others directly, by PayPal or Interac e-Transfer, once they reach the same minimum.', 'fr', 'Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions passent par Stripe. Celles-ci sont versées dans votre compte bancaire lors du versement quotidien, dès qu''elles atteignent {min}. {site} vous envoie les autres directement, par PayPal ou virement Interac, une fois ce même minimum atteint.'), now(), now()),
  ('affiliates.portal.next_payout_email_required', jsonb_build_object('en', 'Add your payout email', 'fr', 'Ajoutez votre courriel de versement'), now(), now()),
  ('affiliates.portal.next_payout_email_required_hint', jsonb_build_object('en', '{site} needs it to send your payouts.', 'fr', '{site} en a besoin pour vous envoyer vos versements.'), now(), now()),
  ('affiliates.portal.next_payout_manual', jsonb_build_object('en', 'Paid by {site}', 'fr', 'Versé par {site}'), now(), now()),
  ('affiliates.portal.next_payout_manual_clearing_hint', jsonb_build_object('en', 'Sent to {email} by PayPal or Interac e-Transfer once your cleared balance reaches {min}.', 'fr', 'Envoyé à {email} par PayPal ou virement Interac une fois que votre solde confirmé atteint {min}.'), now(), now()),
  ('affiliates.portal.next_payout_manual_ready_hint', jsonb_build_object('en', '{site} sends your cleared balance to {email} by PayPal or Interac e-Transfer.', 'fr', '{site} envoie votre solde confirmé à {email} par PayPal ou virement Interac.'), now(), now()),
  ('affiliates.portal.next_payout_manual_sending_hint', jsonb_build_object('en', '{site} is sending you {amount}.', 'fr', '{site} vous envoie {amount}.'), now(), now()),
  ('affiliates.portal.payout_channel_bank_transfer', jsonb_build_object('en', 'Bank transfer', 'fr', 'Virement bancaire'), now(), now()),
  ('affiliates.portal.payout_channel_interac', jsonb_build_object('en', 'Interac e-Transfer', 'fr', 'Virement Interac'), now(), now()),
  ('affiliates.portal.payout_channel_other', jsonb_build_object('en', 'Other method', 'fr', 'Autre mode de paiement'), now(), now()),
  ('affiliates.portal.payout_channel_paypal', jsonb_build_object('en', 'PayPal', 'fr', 'PayPal'), now(), now()),
  ('affiliates.portal.payout_channel_wise', jsonb_build_object('en', 'Wise', 'fr', 'Wise'), now(), now()),
  ('affiliates.portal.payout_email_help', jsonb_build_object('en', 'We send manual payouts to this address. Use the email of your PayPal account, or the one you use for Interac e-Transfer.', 'fr', 'Nous envoyons les versements manuels à cette adresse. Utilisez le courriel de votre compte PayPal, ou celui que vous utilisez pour les virements Interac.'), now(), now()),
  ('affiliates.portal.payout_email_label', jsonb_build_object('en', 'Email for PayPal or Interac e-Transfer payouts', 'fr', 'Courriel pour les versements par PayPal ou virement Interac'), now(), now()),
  ('affiliates.portal.payout_email_remove', jsonb_build_object('en', 'Remove', 'fr', 'Retirer'), now(), now()),
  ('affiliates.portal.payout_email_removed', jsonb_build_object('en', 'Payout email removed.', 'fr', 'Courriel de versement retiré.'), now(), now()),
  ('affiliates.portal.payout_email_saved', jsonb_build_object('en', 'Payout email saved.', 'fr', 'Courriel de versement enregistré.'), now(), now()),
  ('affiliates.portal.payout_manual_note', jsonb_build_object('en', 'Note: {note}', 'fr', 'Note : {note}'), now(), now()),
  ('affiliates.portal.payout_manual_reference', jsonb_build_object('en', '{channel} · Ref. {reference}', 'fr', '{channel} · Réf. {reference}'), now(), now()),
  ('affiliates.portal.payout_manual_sending_note', jsonb_build_object('en', 'Being sent to you directly.', 'fr', 'Envoi direct en cours.'), now(), now()),
  ('affiliates.portal.payout_methods_by_site', jsonb_build_object('en', 'Your commissions are sent to you directly by {site}, by PayPal or Interac e-Transfer.', 'fr', 'Vos commissions vous sont envoyées directement par {site}, par PayPal ou virement Interac.'), now(), now()),
  ('affiliates.portal.payout_methods_by_stripe', jsonb_build_object('en', 'Your commissions are transferred to your Stripe account.', 'fr', 'Vos commissions sont virées dans votre compte Stripe.'), now(), now()),
  ('affiliates.portal.payout_methods_manual', jsonb_build_object('en', '{site} sends your commissions to you directly, by PayPal or Interac e-Transfer.', 'fr', '{site} vous envoie vos commissions directement, par PayPal ou virement Interac.'), now(), now()),
  ('affiliates.portal.payout_methods_mixed_intro', jsonb_build_object('en', 'How a commission is paid depends on how the order was paid.', 'fr', 'Le mode de versement d''une commission dépend du mode de paiement de la commande.'), now(), now()),
  ('affiliates.portal.payout_methods_orders_freemius', jsonb_build_object('en', 'Orders paid through Freemius', 'fr', 'Commandes payées par Freemius'), now(), now()),
  ('affiliates.portal.payout_methods_orders_stripe', jsonb_build_object('en', 'Orders paid through Stripe', 'fr', 'Commandes payées par Stripe'), now(), now()),
  ('affiliates.portal.payout_methods_title', jsonb_build_object('en', 'How you get paid', 'fr', 'Comment vous êtes payé'), now(), now()),
  ('affiliates.portal.payouts_description_manual', jsonb_build_object('en', 'Your commissions clear after the refund window, then {site} sends them to you directly, by PayPal or Interac e-Transfer.', 'fr', 'Vos commissions sont confirmées après la période de remboursement, puis {site} vous les envoie directement, par PayPal ou virement Interac.'), now(), now()),
  ('affiliates.portal.payouts_description_mixed', jsonb_build_object('en', 'Your commissions clear after the refund window. Depending on the order, they then go to your bank through Stripe, or {site} sends them to you directly.', 'fr', 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite versées dans votre compte bancaire par Stripe, ou {site} vous les envoie directement.'), now(), now()),
  ('affiliates.portal.table_payout', jsonb_build_object('en', 'Payout', 'fr', 'Versement'), now(), now()),
  ('affiliates.terms.details_payout_method_freemius_orders', jsonb_build_object('en', 'Payout method, orders paid through Freemius', 'fr', 'Mode de versement, commandes payées par Freemius'), now(), now()),
  ('affiliates.terms.details_payout_method_manual', jsonb_build_object('en', 'Sent directly by us, for example by PayPal or Interac e-Transfer', 'fr', 'Envoyé directement par nous, par exemple par PayPal ou virement Interac'), now(), now()),
  ('affiliates.terms.details_payout_method_stripe_orders', jsonb_build_object('en', 'Payout method, orders paid through Stripe', 'fr', 'Mode de versement, commandes payées par Stripe'), now(), now()),
  ('affiliates.terms.details_schedule_direct', jsonb_build_object('en', 'When we send them', 'fr', 'Quand nous les envoyons'), now(), now()),
  ('affiliates.terms.details_schedule_mixed_daily', jsonb_build_object('en', 'Stripe transfers: automatic, every day. Direct payouts: when we send them.', 'fr', 'Virements Stripe : automatiques, chaque jour. Versements directs : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_mixed_manual', jsonb_build_object('en', 'Stripe transfers: when we run them. Direct payouts: when we send them.', 'fr', 'Virements Stripe : quand nous les lançons. Versements directs : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.payouts_direct', jsonb_build_object('en', 'For payouts we send directly, add your payout email in your partner portal. We send the money to that address, so keep it up to date.', 'fr', 'Pour les versements que nous envoyons directement, ajoutez votre courriel de versement dans votre portail partenaire. Nous envoyons l''argent à cette adresse : gardez-la à jour.'), now(), now()),
  ('affiliates.terms.privacy_direct', jsonb_build_object('en', 'To send you a payout directly, we give your payout email, the amount and your handle to the payment service we use, such as PayPal.', 'fr', 'Pour vous envoyer un versement directement, nous transmettons votre courriel de versement, le montant et votre identifiant au service de paiement que nous utilisons, comme PayPal.'), now(), now())
ON CONFLICT (key) DO NOTHING;

-- Changed text, each language guarded by the text 02031 seeded, so copy an operator edited (CMS >
-- Settings > Extra Translations) stays theirs.
UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{en}', to_jsonb(fix.new_en)), updated_at = now()
  FROM (VALUES
    ('affiliates.common.step_payouts',
     'Bank payouts connected',
     'Payouts set up'),
    ('affiliates.partners.benefit_payouts_body',
     'Cleared money goes straight to your bank. You never need to ask for a payout.',
     'Once your cleared balance reaches the minimum, we send your money. You never need to ask for a payout.'),
    ('affiliates.partners.benefit_payouts_title',
     'Automatic Stripe payouts',
     'Payouts come to you'),
    ('affiliates.partners.faq_cost_answer',
     'No. Joining is free, and there are no monthly fees. You only need an account and a bank account for payouts.',
     'No. Joining is free, and there are no monthly fees. You only need an account and a way to receive your payouts.'),
    ('affiliates.partners.faq_payouts_answer',
     'Each commission waits {days} days in case of a refund. Then it clears, and we send it to your bank through Stripe. Payouts go out on their own once your cleared balance reaches the minimum.',
     'Each commission waits {days} days in case of a refund. Then it clears. We send your payout once your cleared balance reaches the minimum. Your partner portal shows how you get paid.'),
    ('affiliates.partners.hero_point_payouts_stripe',
     'Payouts through Stripe',
     'Payouts sent by our team'),
    ('affiliates.partners.hero_subtitle',
     'Share the products you love from your own storefront. We track each sale and pay you automatically.',
     'Share the products you love from your own storefront. We track each sale and pay your commissions.'),
    ('affiliates.partners.how_step_payouts_body',
     'Link your bank once through Stripe. After that, your payouts arrive on their own.',
     'Tell us once where to send your money. After that, your payouts come to you.'),
    ('affiliates.partners.how_step_payouts_title',
     'Connect your bank',
     'Set up your payouts'),
    ('affiliates.partners.meta_description',
     'Join our free partner program. Earn up to {rate}% on every sale you refer, get your own storefront and receive automatic payouts through Stripe.',
     'Join our free partner program. Earn up to {rate}% on every sale you refer, get your own storefront and get paid once your commissions clear.'),
    ('affiliates.partners.meta_description_no_rate',
     'Join our free partner program. Earn a commission on every sale you refer, get your own storefront and receive automatic payouts through Stripe.',
     'Join our free partner program. Earn a commission on every sale you refer, get your own storefront and get paid once your commissions clear.'),
    ('affiliates.portal.next_payout_none',
     'No earnings yet',
     'Nothing to pay out yet'),
    ('affiliates.portal.progress_action_payouts',
     'Connect my bank account',
     'Set up my payouts'),
    ('affiliates.portal.stats_cleared_hint',
     'Cleared commissions waiting for the next automated payout.',
     'Cleared commissions waiting for the next payout.'),
    ('affiliates.portal.welcome_body',
     'Three steps get your storefront live: complete your profile, connect your bank account for automated payouts, then build your page and submit it for approval. Your links start earning commissions after the first approval.',
     'Three steps get your storefront live: complete your profile, set up your payouts, then build your page and submit it for approval. Your links start earning commissions after the first approval.'),
    ('affiliates.terms.meta_description',
     'How our partner program works: commissions, the hold period, refunds, payouts through Stripe, your duties and how to leave.',
     'How our partner program works: commissions, the hold period, refunds, payouts, your duties and how to leave.'),
    ('affiliates.terms.payouts_schedule',
     'Payouts follow our schedule. A payout can be late, for example if Stripe is unavailable or our Stripe balance is too low.',
     'Payouts follow our schedule. A payout can be late, for example if a payment service is unavailable or our Stripe balance is too low.'),
    ('affiliates.terms.payouts_setup',
     'To get paid, finish the Stripe setup in your partner portal. Your Stripe account must be in a country where we can pay you.',
     'For payouts through Stripe, finish the Stripe setup in your partner portal. Your Stripe account must be in a country where we can pay you.'),
    ('affiliates.terms.payouts_stripe',
     'We pay you with Stripe Connect Express, into a Stripe account in your name.',
     'Depending on the sale, we pay you with Stripe Connect Express, into a Stripe account in your name, or we send the money to you directly, for example by PayPal or Interac e-Transfer.'),
    ('affiliates.terms.privacy_stripe',
     'To set up your payouts, we share your email address, your country and your storefront address with Stripe.',
     'If you set up payouts through Stripe, we share your email address, your country and your storefront address with Stripe.'),
    ('affiliates.terms.refunds_after_payout',
     'If a refund or a lost dispute comes after we paid you, we may take that amount back by reversing the Stripe transfer.',
     'If a refund or a lost dispute comes after we paid you, we may take that amount back, by reversing the Stripe transfer or by deducting it from a later payout.')
  ) AS fix(key, old_en, new_en)
 WHERE t.key = fix.key AND t.translations->>'en' = fix.old_en;

UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)), updated_at = now()
  FROM (VALUES
    ('affiliates.common.step_payouts',
     'Versements bancaires connectés',
     'Versements configurés'),
    ('affiliates.partners.benefit_payouts_body',
     'L''argent confirmé va directement dans votre compte bancaire. Vous n''avez jamais à demander un versement.',
     'Une fois que votre solde confirmé atteint le minimum, nous vous envoyons votre argent. Vous n''avez jamais à demander un versement.'),
    ('affiliates.partners.benefit_payouts_title',
     'Versements Stripe automatiques',
     'Les versements viennent à vous'),
    ('affiliates.partners.faq_cost_answer',
     'Non. L''inscription est gratuite et il n''y a aucuns frais mensuels. Il vous faut seulement un compte et un compte bancaire pour les versements.',
     'Non. L''inscription est gratuite et il n''y a aucuns frais mensuels. Il vous faut seulement un compte et un moyen de recevoir vos versements.'),
    ('affiliates.partners.faq_payouts_answer',
     'Chaque commission attend {days} jours en cas de remboursement. Elle est ensuite confirmée, puis envoyée à votre banque avec Stripe. Les versements partent tout seuls dès que votre solde confirmé atteint le minimum.',
     'Chaque commission attend {days} jours en cas de remboursement. Elle est ensuite confirmée. Nous envoyons votre versement une fois que votre solde confirmé atteint le minimum. Votre portail partenaire indique comment vous êtes payé.'),
    ('affiliates.partners.hero_point_payouts_stripe',
     'Versements par Stripe',
     'Versements envoyés par notre équipe'),
    ('affiliates.partners.hero_subtitle',
     'Partagez les produits que vous aimez dans votre propre vitrine. Nous suivons chaque vente et nous vous payons automatiquement.',
     'Partagez les produits que vous aimez dans votre propre vitrine. Nous suivons chaque vente et nous vous versons vos commissions.'),
    ('affiliates.partners.how_step_payouts_body',
     'Liez votre banque une seule fois avec Stripe. Ensuite, vos versements arrivent tout seuls.',
     'Dites-nous une seule fois où envoyer votre argent. Ensuite, vos versements viennent à vous.'),
    ('affiliates.partners.how_step_payouts_title',
     'Connectez votre banque',
     'Configurez vos versements'),
    ('affiliates.partners.meta_description',
     'Inscrivez-vous gratuitement à notre programme de partenaires. Gagnez jusqu''à {rate} % sur chaque vente recommandée et recevez vos versements automatiquement.',
     'Inscrivez-vous gratuitement à notre programme de partenaires. Gagnez jusqu''à {rate} % sur chaque vente recommandée et recevez vos versements.'),
    ('affiliates.partners.meta_description_no_rate',
     'Inscrivez-vous gratuitement à notre programme de partenaires. Touchez une commission sur chaque vente recommandée et recevez vos versements automatiquement.',
     'Inscrivez-vous gratuitement à notre programme de partenaires. Touchez une commission sur chaque vente recommandée et recevez vos versements.'),
    ('affiliates.portal.next_payout_none',
     'Aucun gain pour l''instant',
     'Rien à verser pour l''instant'),
    ('affiliates.portal.progress_action_payouts',
     'Connecter mon compte bancaire',
     'Configurer mes versements'),
    ('affiliates.portal.stats_cleared_hint',
     'Commissions confirmées en attente du prochain versement automatisé.',
     'Commissions confirmées en attente du prochain versement.'),
    ('affiliates.portal.welcome_body',
     'Trois étapes pour mettre votre vitrine en ligne : complétez votre profil, connectez votre compte bancaire pour les versements automatisés, puis créez votre page et soumettez-la pour approbation. Vos liens commencent à rapporter des commissions après la première approbation.',
     'Trois étapes pour mettre votre vitrine en ligne : complétez votre profil, configurez vos versements, puis créez votre page et soumettez-la pour approbation. Vos liens commencent à rapporter des commissions après la première approbation.'),
    ('affiliates.terms.meta_description',
     'Le fonctionnement de notre programme partenaires : commissions, retenue, remboursements, versements par Stripe, vos obligations et votre départ.',
     'Le fonctionnement de notre programme partenaires : commissions, retenue, remboursements, versements, vos obligations et votre départ.'),
    ('affiliates.terms.payouts_schedule',
     'Les versements suivent notre calendrier. Un versement peut être retardé, par exemple si Stripe est indisponible ou si notre solde Stripe est insuffisant.',
     'Les versements suivent notre calendrier. Un versement peut être retardé, par exemple si un service de paiement est indisponible ou si notre solde Stripe est insuffisant.'),
    ('affiliates.terms.payouts_setup',
     'Pour être payé, terminez la configuration Stripe dans votre portail partenaire. Votre compte Stripe doit être situé dans un pays où nous pouvons vous payer.',
     'Pour les versements par Stripe, terminez la configuration Stripe dans votre portail partenaire. Votre compte Stripe doit être situé dans un pays où nous pouvons vous payer.'),
    ('affiliates.terms.payouts_stripe',
     'Nous vous payons avec Stripe Connect Express, dans un compte Stripe à votre nom.',
     'Selon la vente, nous vous payons avec Stripe Connect Express, dans un compte Stripe à votre nom, ou nous vous envoyons l''argent directement, par exemple par PayPal ou virement Interac.'),
    ('affiliates.terms.privacy_stripe',
     'Pour configurer vos versements, nous transmettons à Stripe votre adresse courriel, votre pays et l''adresse de votre vitrine.',
     'Si vous configurez des versements par Stripe, nous transmettons à Stripe votre adresse courriel, votre pays et l''adresse de votre vitrine.'),
    ('affiliates.terms.refunds_after_payout',
     'Si un remboursement ou un litige perdu survient après votre versement, nous pouvons reprendre ce montant en annulant le virement Stripe.',
     'Si un remboursement ou un litige perdu survient après votre versement, nous pouvons reprendre ce montant, en annulant le virement Stripe ou en le déduisant d''un versement suivant.')
  ) AS fix(key, old_fr, new_fr)
 WHERE t.key = fix.key AND t.translations->>'fr' = fix.old_fr;
