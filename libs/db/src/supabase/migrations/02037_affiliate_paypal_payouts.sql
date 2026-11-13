-- 02037: commissions paid automatically from the operator's PayPal balance (Affiliates & Creator
-- Storefronts, docs/15 → "Paying partners with PayPal").
--
-- 02036 let the program route a gateway's commissions to "manual": the operator sends the money from
-- PayPal, Interac e-Transfer, Wise or a bank and records each payment in the CMS. An operator whose
-- Freemius earnings land in a PayPal Business balance can let the daily payout run send that money
-- itself with the PayPal Payouts REST API instead. affiliates_settings.payoutMethods (read by the
-- app) gains 'paypal'; partners whose payout email is an Interac e-Transfer address (PayPal cannot
-- send one), or who have none, are still paid by hand under Pay manually. This file:
--
-- 1. affiliate_payouts.method also allows 'paypal' (the 02036 CHECK replaced by name). A PayPal
--    payout snapshots its recipient (paypal_receiver, the partner's payout email when it was claimed)
--    and carries PayPal's ids as they become known: the sender_batch_id the app saves BEFORE the
--    create call (also its PayPal-Request-Id, so a create that timed out is retried with the same
--    id), PayPal's payout_batch_id and payout_item_id, the transaction id once paid, the item's last
--    transaction_status, PayPal's fee and when PayPal was last asked. It carries no Stripe field and
--    no manual field; a payout of another method carries no PayPal field. It is PROCESSING while
--    PayPal has it, COMPLETED once PayPal paid the item (transaction id required), FAILED when PayPal
--    will not pay it (its commissions are then handed back, so a FAILED PayPal payout holds nothing).
--    02036's manual status CHECK (written when only two methods existed, it kept every payout that is
--    not a Stripe one PROCESSING or COMPLETED, so a PayPal payout could never fail) is replaced by
--    name and now holds for manual payouts only. A FAILED PayPal payout carries a paypal_ reason
--    (fail_ or release_paypal_affiliate_payout): the Stripe RPCs fail_affiliate_payout,
--    release_affiliate_payout and prepare_affiliate_payout_retry raise on a PayPal payout instead of
--    failing it with its commissions still attached, or rewriting the reason that keeps PayPal off an
--    address it returned a payout from.
--    One in flight per partner, currency and mode; a PayPal item and a transaction id are recorded
--    on one payout only. livemode is the PayPal environment's money: a live payout holds only
--    live-mode commissions, a PayPal sandbox payout only test-mode ones (a real sale is never marked
--    paid with sandbox money).
-- 2. affiliate_profiles.payout_email_kind ('paypal', the default, or 'interac'): what payout_email
--    is, and affiliate_profiles.payout_email_saved_at: when the partner last saved it (the portal
--    stamps it on every save, the same address included). The run stops sending PayPal payouts to an
--    address PayPal returned one from; a save after that return lifts it, so a partner who opened or
--    confirmed their PayPal account can ask for PayPal again. Both are written like payout_email (the
--    portal, with the service role after requireRetailer(), or an admin): no Data API grant, and
--    private.affiliate_profile_guard() (02036's definition plus these two columns) refuses them from a
--    partner session.
-- 3. Six service-role RPCs in the claim's lock order (the profile, the commissions, the payout), each
--    answering a status instead of raising for every expected case:
--    - claim_paypal_affiliate_payout(affiliate, currency, min, gateways, livemode, trigger): for an
--      ACTIVE, approved partner whose payout email is a PayPal account (kind 'paypal', at most 127
--      characters, PayPal's receiver limit), the CLEARED, unattached, undisputed commissions of that
--      currency, of the PayPal gateways and of the environment's mode (refunded or cancelled orders
--      voided first, as the claim does) are attached to a new PROCESSING PayPal payout of their sum.
--      Nothing moves money here.
--    - record_paypal_affiliate_payout_batch(payouts, sender batch id, payout batch id): saves a
--      batch's ids on its PROCESSING PayPal payouts, never overwriting a different id; called with the
--      same sender id before every resend, it stamps that send (last_attempt_at, attempt_count).
--    - note_paypal_affiliate_payout_item(payout, item id, status, fee): what a sync learned about an
--      in-flight payout (PENDING, UNCLAIMED, ONHOLD, …).
--    - complete_paypal_affiliate_payout(payout, item id, transaction id, fee, status): PayPal paid the
--      item; that exact payout becomes COMPLETED with the transaction id and fee, its commissions PAID,
--      total_paid_cents up by its amount, exactly once.
--    - fail_paypal_affiliate_payout(payout, reason, status): PayPal will not pay it (a definitive
--      refusal, FAILED, BLOCKED, RETURNED, REFUNDED, REVERSED, a denied batch, an UNCLAIMED item the
--      admin cancelled); the refund work owed to its commissions is applied as the Stripe failure path
--      does (A8), the rest are handed back to the cleared balance (unattached, payable again), and the
--      row is FAILED with the reason.
--    - release_paypal_affiliate_payout(payout): the CMS Release, once the admin checked PayPal paid
--      nothing. Checked under the row locks, not only by the screen: a batch PayPal never acknowledged
--      is released only an hour after its last send (a resend stamps it first), one PayPal acknowledged
--      but never settled only 7 days after it and while PayPal lists no status it holds money in.
-- 4. private.affiliate_alert_refund_after_payout (02036's definition): a refund while a PayPal payout
--    is still with PayPal says the refund is applied if PayPal returns it or it fails, and to recover
--    the amount from the partner if it completes; after a completed PayPal payout, to recover the
--    amount (PayPal cannot take a payout back). The metadata names payout_method 'paypal'.
-- 5. site_settings.affiliates_paypal_secret, the CMS-saved PayPal credentials (the active environment
--    and, per environment, a client id and the secret encrypted with the app's secret envelope): a
--    RESTRICTIVE policy keeps it from every API role, an ADMIN on an aal2 session included (the
--    02021/02028 tiers already make an unlisted key ADMIN-only; this makes it service-role only). The
--    app reads and writes it with the service role after requireCmsAdmin(), never on the public
--    sandbox; the PAYPAL_* environment variables are the fallback.
-- 6. The UI copy of the partner side (section 7, data only): the partner portal's PayPal or Interac
--    e-Transfer choice and PayPal wording, and the terms clauses and Program details rows that name
--    PayPal Payouts, as new public.translations keys and guarded rewordings (the 02031 header's forms).
--
-- Grants. No table, view or sequence is created; the new columns ride the existing table grants
-- (02030: authenticated SELECT through the owner and ADMIN policies, no API write on payouts;
-- affiliate_profiles keeps exactly its four self-service UPDATE column grants). The six RPCs are
-- SECURITY INVOKER in public, revoked from PUBLIC, anon and authenticated here and in BOTH copies of
-- API_ROLE_REVOKE_SQL (apps/nextblock/tools/lib/migrate-core.mjs, apps/nextblock/lib/setup/schema-apply.ts).
-- The two redefined private functions keep their SECURITY DEFINER, search_path and grants (restated
-- below). tools/scripts/security-verify.sql section 41 checks all of it.
--
-- Append-only, forward-only, idempotent: ADD COLUMN IF NOT EXISTS, the method and manual status CHECKs
-- dropped and added by name, the other constraints added only when missing, CREATE UNIQUE INDEX IF NOT
-- EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS before CREATE POLICY; it replays cleanly after
-- 02000-02036 on an empty database and on one that holds data (no existing payout is a PayPal payout,
-- and every manual payout is PROCESSING or COMPLETED already).

-- 02001 turns body validation off for the session; a one-connection replay would otherwise
-- create every function below unchecked.
SET check_function_bodies = on;

-- ---------------------------------------------------------------------------
-- 1. affiliate_payouts: the PayPal method and what a PayPal payout records
-- ---------------------------------------------------------------------------
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_receiver text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_sender_batch_id text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_batch_id text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_item_id text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_transaction_id text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_item_status text NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_fee_cents bigint NULL;
ALTER TABLE public.affiliate_payouts ADD COLUMN IF NOT EXISTS paypal_checked_at timestamptz NULL;

-- 02036's method CHECK, replaced by name: 'paypal' joins. Every existing row holds 'stripe_connect' or
-- 'manual', so the re-check passes; dropping and adding it again on a replay is harmless.
ALTER TABLE public.affiliate_payouts DROP CONSTRAINT IF EXISTS affiliate_payouts_method_check;
ALTER TABLE public.affiliate_payouts
  ADD CONSTRAINT affiliate_payouts_method_check CHECK (method IN ('stripe_connect', 'paypal', 'manual'));

-- 02036's manual status CHECK, replaced by name. It read "a payout that is not a Stripe payout is
-- PROCESSING or COMPLETED" (written when 'manual' was the only other method), so a PayPal payout could
-- never become FAILED: fail_paypal_affiliate_payout() would raise and keep its commissions reserved. It
-- now holds for manual payouts only (still never FAILED: a cancelled one is deleted). Every existing row
-- passes it: Stripe rows of any status, and manual rows the old CHECK already kept PROCESSING or
-- COMPLETED; dropping and adding it again on a replay is harmless.
ALTER TABLE public.affiliate_payouts DROP CONSTRAINT IF EXISTS affiliate_payouts_manual_status_check;
ALTER TABLE public.affiliate_payouts
  ADD CONSTRAINT affiliate_payouts_manual_status_check CHECK (
    method <> 'manual'
    OR status IN ('PROCESSING'::public.affiliate_payout_status, 'COMPLETED'::public.affiliate_payout_status));

DO $nb_02037_payouts$
BEGIN
  -- a PayPal payout names its recipient and carries no Stripe or manual field: complete_affiliate_payout()
  -- (transfer id) and prepare_affiliate_payout_retry() (destination) can never complete or re-send one
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_fields_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_fields_check CHECK (
        method <> 'paypal'
        OR (paypal_receiver IS NOT NULL AND stripe_destination_account IS NULL AND stripe_transfer_id IS NULL
            AND manual_channel IS NULL AND external_reference IS NULL AND recorded_by IS NULL));
  END IF;
  -- a payout of another method carries no PayPal field
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_only_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_only_check CHECK (
        method = 'paypal'
        OR (paypal_receiver IS NULL AND paypal_sender_batch_id IS NULL AND paypal_batch_id IS NULL AND paypal_item_id IS NULL
            AND paypal_transaction_id IS NULL AND paypal_item_status IS NULL AND paypal_fee_cents IS NULL AND paypal_checked_at IS NULL));
  END IF;
  -- a PayPal payout is in flight (PROCESSING), paid (COMPLETED) or given up (FAILED, its commissions
  -- handed back); unlike a manual payout it can fail
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_status_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_status_check CHECK (
        method <> 'paypal'
        OR status IN ('PROCESSING'::public.affiliate_payout_status, 'COMPLETED'::public.affiliate_payout_status,
                      'FAILED'::public.affiliate_payout_status));
  END IF;
  -- a FAILED PayPal payout was failed by fail_ or release_paypal_affiliate_payout(), which hand its
  -- commissions back and give it a paypal_ reason. The Stripe RPCs therefore raise on a PayPal payout:
  -- fail_affiliate_payout() (a Stripe reason, commissions left attached while PayPal may still pay the
  -- item), release_affiliate_payout() ('released') and the give-up branch of
  -- prepare_affiliate_payout_retry() ('nothing_to_pay', 'below_minimum') would rewrite the reason that
  -- keeps the run off an address PayPal returned a payout from (its re-send branch is refused by the
  -- fields CHECK above)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_failure_reason_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_failure_reason_check CHECK (
        method <> 'paypal' OR status <> 'FAILED'::public.affiliate_payout_status
        OR coalesce(failure_reason, '') ~ '^paypal_');
  END IF;
  -- a paid PayPal payout names PayPal's item and transaction and when it was paid
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_completed_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_completed_check CHECK (
        method <> 'paypal' OR status <> 'COMPLETED'::public.affiliate_payout_status
        OR (paypal_item_id IS NOT NULL AND paypal_transaction_id IS NOT NULL AND paid_at IS NOT NULL));
  END IF;
  -- PayPal's receiver takes at most 127 characters; the shape of payout_email's own CHECK (02036)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_receiver_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_receiver_check CHECK (
        paypal_receiver IS NULL OR (char_length(paypal_receiver) <= 127 AND paypal_receiver ~ '^[^@[:space:]]+@[^@[:space:]]+$'
                                    AND paypal_receiver !~ '^[=+@-]'));
  END IF;
  -- PayPal's ids end up in request paths: letters, digits, _ and - only
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_ids_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_ids_check CHECK (
        (paypal_sender_batch_id IS NULL OR paypal_sender_batch_id ~ '^[A-Za-z0-9_-]{1,64}$')
        AND (paypal_batch_id IS NULL OR paypal_batch_id ~ '^[A-Za-z0-9_-]{1,128}$')
        AND (paypal_item_id IS NULL OR paypal_item_id ~ '^[A-Za-z0-9_-]{1,128}$')
        AND (paypal_transaction_id IS NULL OR paypal_transaction_id ~ '^[A-Za-z0-9_-]{1,128}$')
        AND (paypal_item_status IS NULL OR paypal_item_status ~ '^[A-Z][A-Z_]{0,39}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_payouts_paypal_fee_check' AND conrelid = 'public.affiliate_payouts'::regclass) THEN
    ALTER TABLE public.affiliate_payouts
      ADD CONSTRAINT affiliate_payouts_paypal_fee_check CHECK (paypal_fee_cents IS NULL OR paypal_fee_cents >= 0);
  END IF;
END
$nb_02037_payouts$;

-- One PayPal payout in flight per partner, currency and mode: claim_paypal_affiliate_payout() answers
-- 'already_in_flight' first, under the profile lock; the index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_paypal_in_flight_key
  ON public.affiliate_payouts (affiliate_id, currency, livemode)
  WHERE method = 'paypal' AND status = 'PROCESSING'::public.affiliate_payout_status;

-- A PayPal item, and a PayPal transaction, completes one payout only.
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_paypal_item_key
  ON public.affiliate_payouts (paypal_item_id) WHERE paypal_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_paypal_transaction_key
  ON public.affiliate_payouts (paypal_transaction_id) WHERE paypal_transaction_id IS NOT NULL;

-- The sync groups in-flight payouts by their batch.
CREATE INDEX IF NOT EXISTS affiliate_payouts_paypal_sender_batch_idx
  ON public.affiliate_payouts (paypal_sender_batch_id) WHERE paypal_sender_batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. affiliate_profiles.payout_email_kind and payout_email_saved_at (server-written; no Data API grant)
-- ---------------------------------------------------------------------------
ALTER TABLE public.affiliate_profiles ADD COLUMN IF NOT EXISTS payout_email_kind text NOT NULL DEFAULT 'paypal';
-- When the partner last saved the payout email (the portal stamps every save, the same address too):
-- a PayPal payout returned from an address keeps the run off it until a save after that return.
ALTER TABLE public.affiliate_profiles ADD COLUMN IF NOT EXISTS payout_email_saved_at timestamptz NULL;

DO $nb_02037_profiles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_profiles_payout_email_kind_check' AND conrelid = 'public.affiliate_profiles'::regclass) THEN
    ALTER TABLE public.affiliate_profiles
      ADD CONSTRAINT affiliate_profiles_payout_email_kind_check CHECK (payout_email_kind IN ('paypal', 'interac'));
  END IF;
END
$nb_02037_profiles$;

-- 02036's definition with one change: payout_email_kind and payout_email_saved_at join the columns a
-- non-admin session may not change (the portal writes them with the service role, which carries no
-- session). Signature, SECURITY DEFINER, search_path, grants and the trigger are 02030's.
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
          OR NEW.payout_email_kind IS DISTINCT FROM OLD.payout_email_kind
          OR NEW.payout_email_saved_at IS DISTINCT FROM OLD.payout_email_saved_at
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
-- 3. The PayPal payout lifecycle (service role only): claim, batch ids, item notes, complete, fail
-- ---------------------------------------------------------------------------
-- The daily payout run, "Run payouts now" and the CMS PayPal payouts screen
-- (apps/nextblock/lib/affiliates/paypal/, after the package, sandbox and ADMIN checks). A PayPal payout
-- follows the Stripe path's order: the commissions are claimed (PROCESSING) BEFORE PayPal is asked to
-- send anything, the batch's sender_batch_id is saved before the create call, and PayPal's answer
-- settles the payout later (SUCCESS completes it, a definitive failure fails it and hands its
-- commissions back). A refund, a lost dispute or a cancellation that arrives while it is in flight
-- takes the in-flight path of private.affiliate_void_order_commissions() and apply_affiliate_refund()
-- (void_requested_at / refund_pending_cents and a refund-after-payout alert), applied if it fails; a
-- dispute only holds the commission (disputed_at). Lock order of the claim and of
-- complete_affiliate_payout(): the profile, then the commissions, then the payout.

-- claim_paypal_affiliate_payout(): one PayPal payout for one partner and currency. For an ACTIVE,
-- approved partner (paused partners are not paid, as the terms say) whose payout email is a PayPal
-- account (payout_email_kind 'paypal', at most 127 characters: PayPal's receiver limit) and who has
-- no PayPal payout of that currency and mode in flight, the CLEARED, unattached, undisputed
-- commissions of p_currency, of the gateways in p_gateways (required: the gateways the program pays
-- with PayPal) and of the mode p_livemode (true: live PayPal pays live sales only; false: the PayPal
-- sandbox pays test-mode sales only, so a real sale is never marked paid with sandbox money) are
-- locked, those whose order is refunded or cancelled are voided exactly as the claim does, and the
-- rest are attached to a new PROCESSING PayPal payout of sum(commission - refunded) with the email as
-- its recipient. Answers:
--   {"status": "invalid_input"}      a currency that is not three letters, no gateway, no mode, a bad trigger
--   {"status": "not_found"}          no such partner
--   {"status": "not_eligible"}       the partner is not ACTIVE or was never approved
--   {"status": "no_paypal_email"}    no payout email, an Interac e-Transfer one, or one PayPal cannot take
--   {"status": "already_in_flight", "payout_id": id, "amount_cents": n}
--                                    a PayPal payout of that currency and mode is still with PayPal
--   {"status": "nothing_owed"}       nothing of that currency, those gateways and that mode is left
--   {"status": "below_minimum", "amount_cents": n, "commission_count": n}
--                                    the sum is below p_min_amount: nothing is reserved
--   {"status": "claimed", "payout_id": id, "amount_cents": n, "commission_count": n, "receiver": email}
CREATE OR REPLACE FUNCTION public.claim_paypal_affiliate_payout(
    p_affiliate_id uuid, p_currency text, p_min_amount bigint, p_gateways public.affiliate_gateway[], p_livemode boolean,
    p_trigger text DEFAULT 'cron')
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_trigger text := lower(btrim(coalesce(p_trigger, 'cron')));
  v_profile record;
  v_receiver text;
  v_existing record;
  v_order record;
  v_amount bigint;
  v_count integer;
  v_payout_id uuid;
BEGIN
  IF v_currency !~ '^[A-Z]{3}$' OR p_livemode IS NULL OR p_gateways IS NULL OR cardinality(p_gateways) = 0
     OR v_trigger NOT IN ('cron', 'admin', 'auto') THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  IF p_affiliate_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT p.id, p.status::text AS status, p.first_published_at, p.payout_email, p.payout_email_kind
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
  v_receiver := lower(btrim(coalesce(v_profile.payout_email, '')));
  IF v_profile.payout_email_kind IS DISTINCT FROM 'paypal' OR v_receiver = '' OR char_length(v_receiver) > 127
     OR v_receiver !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR v_receiver ~ '^[=+@-]' THEN
    RETURN jsonb_build_object('status', 'no_paypal_email');
  END IF;

  -- read under the profile lock: a concurrent claim of the same partner committed before it
  SELECT po.id, po.amount_cents
    INTO v_existing
    FROM public.affiliate_payouts po
   WHERE po.affiliate_id = p_affiliate_id
     AND po.method = 'paypal'
     AND po.status = 'PROCESSING'::public.affiliate_payout_status
     AND po.currency = v_currency
     AND po.livemode = p_livemode
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_in_flight', 'payout_id', v_existing.id, 'amount_cents', v_existing.amount_cents);
  END IF;

  PERFORM 1 FROM public.affiliate_commissions c
    WHERE c.affiliate_id = p_affiliate_id
      AND c.status = 'CLEARED'::public.affiliate_commission_status
      AND c.payout_id IS NULL
      AND c.currency = v_currency
      AND c.livemode = p_livemode
      AND c.disputed_at IS NULL
      AND c.gateway = ANY (p_gateways)
    FOR UPDATE;

  FOR v_order IN
    SELECT DISTINCT c.order_id, o.status
      FROM public.affiliate_commissions c
      JOIN public.orders o ON o.id = c.order_id
     WHERE c.affiliate_id = p_affiliate_id
       AND c.status = 'CLEARED'::public.affiliate_commission_status
       AND c.payout_id IS NULL
       AND c.currency = v_currency
       AND c.livemode = p_livemode
       AND c.disputed_at IS NULL
       AND c.gateway = ANY (p_gateways)
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
     AND c.livemode = p_livemode
     AND c.disputed_at IS NULL
     AND c.gateway = ANY (p_gateways);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_owed');
  END IF;
  IF v_amount < GREATEST(coalesce(p_min_amount, 0), 0) THEN
    RETURN jsonb_build_object('status', 'below_minimum', 'amount_cents', v_amount, 'commission_count', v_count);
  END IF;

  INSERT INTO public.affiliate_payouts (
    affiliate_id, amount_cents, currency, stripe_destination_account, livemode, status, attempt_count, last_attempt_at,
    trigger, method, paypal_receiver
  )
  VALUES (
    p_affiliate_id, v_amount, v_currency, NULL, p_livemode, 'PROCESSING'::public.affiliate_payout_status, 1, now(),
    v_trigger, 'paypal', v_receiver
  )
  RETURNING id INTO v_payout_id;

  UPDATE public.affiliate_commissions c
     SET payout_id = v_payout_id
   WHERE c.affiliate_id = p_affiliate_id
     AND c.status = 'CLEARED'::public.affiliate_commission_status
     AND c.payout_id IS NULL
     AND c.currency = v_currency
     AND c.livemode = p_livemode
     AND c.disputed_at IS NULL
     AND c.gateway = ANY (p_gateways);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('status', 'claimed', 'payout_id', v_payout_id, 'amount_cents', v_amount, 'commission_count', v_count,
                            'receiver', v_receiver);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text) TO service_role;

-- record_paypal_affiliate_payout_batch(): a batch's ids on its PROCESSING PayPal payouts. Called with
-- p_payout_batch_id NULL BEFORE the create call (the sender_batch_id, also the PayPal-Request-Id, is
-- saved first, so a create that timed out is retried with the same id: PayPal pays a sender_batch_id
-- once in 30 days), and with PayPal's payout_batch_id after it. Never overwrites a different id. Every
-- call without a batch id stamps the send (last_attempt_at; attempt_count + 1 when the same sender id
-- is saved again, i.e. a resend): the CMS Release waits an hour after the LAST send, which
-- release_paypal_affiliate_payout() checks under the payout lock. The payouts are locked in id order.
-- Answers {"status": "invalid_input"} (a malformed id, no payout, more than PayPal's 15,000 items) or
-- {"status": "recorded", "count": n}: how many of p_payout_ids carry the ids now (fewer when one was
-- released or settled meanwhile: the caller sends exactly the payouts that still carry the id).
CREATE OR REPLACE FUNCTION public.record_paypal_affiliate_payout_batch(
    p_payout_ids uuid[], p_sender_batch_id text, p_payout_batch_id text DEFAULT NULL)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_sender text := btrim(coalesce(p_sender_batch_id, ''));
  v_batch text := nullif(btrim(coalesce(p_payout_batch_id, '')), '');
  v_count integer;
BEGIN
  IF v_sender !~ '^[A-Za-z0-9_-]{1,64}$' OR (v_batch IS NOT NULL AND v_batch !~ '^[A-Za-z0-9_-]{1,128}$')
     OR p_payout_ids IS NULL OR cardinality(p_payout_ids) = 0 OR cardinality(p_payout_ids) > 15000 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;

  PERFORM 1 FROM public.affiliate_payouts po WHERE po.id = ANY (p_payout_ids) ORDER BY po.id FOR UPDATE;
  UPDATE public.affiliate_payouts po
     SET paypal_sender_batch_id = v_sender,
         paypal_batch_id = coalesce(v_batch, po.paypal_batch_id),
         last_attempt_at = CASE WHEN v_batch IS NULL THEN now() ELSE po.last_attempt_at END,
         attempt_count = CASE WHEN v_batch IS NULL AND po.paypal_sender_batch_id = v_sender THEN po.attempt_count + 1 ELSE po.attempt_count END,
         paypal_checked_at = CASE WHEN v_batch IS NULL THEN po.paypal_checked_at ELSE now() END
   WHERE po.id = ANY (p_payout_ids)
     AND po.method = 'paypal'
     AND po.status = 'PROCESSING'::public.affiliate_payout_status
     AND (po.paypal_sender_batch_id IS NULL OR po.paypal_sender_batch_id = v_sender)
     AND (v_batch IS NULL OR po.paypal_batch_id IS NULL OR po.paypal_batch_id = v_batch);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('status', 'recorded', 'count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.record_paypal_affiliate_payout_batch(uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_paypal_affiliate_payout_batch(uuid[], text, text) TO service_role;

-- note_paypal_affiliate_payout_item(): what a sync learned about an in-flight PayPal payout: its item
-- id (kept once set: a different one is refused), the item's transaction_status (PENDING, UNCLAIMED,
-- ONHOLD, …, or a status this file does not know, recorded as PayPal wrote it) and fee, and the time
-- of the check. Answers {"status": "invalid_input"} (a malformed id or status, a negative fee),
-- {"status": "not_found"} (no such PayPal payout in flight, or another item id) or {"status": "noted"}.
CREATE OR REPLACE FUNCTION public.note_paypal_affiliate_payout_item(
    p_payout_id uuid, p_item_id text, p_item_status text, p_fee_cents bigint DEFAULT NULL)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_item text := nullif(btrim(coalesce(p_item_id, '')), '');
  v_status text := nullif(upper(btrim(coalesce(p_item_status, ''))), '');
BEGIN
  IF p_payout_id IS NULL OR (v_item IS NOT NULL AND v_item !~ '^[A-Za-z0-9_-]{1,128}$')
     OR (v_status IS NOT NULL AND v_status !~ '^[A-Z][A-Z_]{0,39}$') OR (p_fee_cents IS NOT NULL AND p_fee_cents < 0) THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;

  UPDATE public.affiliate_payouts po
     SET paypal_item_id = coalesce(po.paypal_item_id, v_item),
         paypal_item_status = coalesce(v_status, po.paypal_item_status),
         paypal_fee_cents = coalesce(p_fee_cents, po.paypal_fee_cents),
         paypal_checked_at = now()
   WHERE po.id = p_payout_id
     AND po.method = 'paypal'
     AND po.status = 'PROCESSING'::public.affiliate_payout_status
     AND (v_item IS NULL OR po.paypal_item_id IS NULL OR po.paypal_item_id = v_item);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  RETURN jsonb_build_object('status', 'noted');
END;
$$;

REVOKE ALL ON FUNCTION public.note_paypal_affiliate_payout_item(uuid, text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_paypal_affiliate_payout_item(uuid, text, text, bigint) TO service_role;

-- complete_paypal_affiliate_payout(): PayPal paid the item (transaction_status SUCCESS). That exact
-- PayPal payout, still PROCESSING, becomes COMPLETED with the item id, the transaction id, the fee and
-- paid_at; its commissions become PAID and the partner's total_paid_cents grows by its amount, as
-- complete_affiliate_payout() does for a transfer (no eligibility or amount check: PayPal paid it).
-- Exactly once. Answers:
--   {"status": "invalid_input"}          a malformed item or transaction id or status, a negative fee
--   {"status": "not_found"}              no such PayPal payout
--   {"status": "already_completed"}      it is COMPLETED already (a concurrent sync)
--   {"status": "not_processing"}         it was FAILED (its commissions were handed back)
--   {"status": "item_mismatch"}          it holds another PayPal item, or this item completes another payout
--   {"status": "duplicate_transaction"}  another payout carries this transaction id
--   {"status": "completed", "payout_id": id, "affiliate_id": id, "amount_cents": n, "currency": c,
--    "commission_count": n, "transaction_id": t}
CREATE OR REPLACE FUNCTION public.complete_paypal_affiliate_payout(
    p_payout_id uuid, p_item_id text, p_transaction_id text, p_fee_cents bigint DEFAULT NULL, p_item_status text DEFAULT 'SUCCESS')
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_item text := nullif(btrim(coalesce(p_item_id, '')), '');
  v_transaction text := nullif(btrim(coalesce(p_transaction_id, '')), '');
  v_status text := coalesce(nullif(upper(btrim(coalesce(p_item_status, ''))), ''), 'SUCCESS');
  v_affiliate uuid;
  v_payout record;
  v_count integer;
BEGIN
  IF p_payout_id IS NULL OR v_item IS NULL OR v_item !~ '^[A-Za-z0-9_-]{1,128}$'
     OR v_transaction IS NULL OR v_transaction !~ '^[A-Za-z0-9_-]{1,128}$'
     OR v_status !~ '^[A-Z][A-Z_]{0,39}$' OR (p_fee_cents IS NOT NULL AND p_fee_cents < 0) THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;

  SELECT po.affiliate_id INTO v_affiliate
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal';
  IF v_affiliate IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.amount_cents, po.currency, po.paypal_item_id
    INTO v_payout
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_payout.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_payout.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('status', 'not_processing');
  END IF;
  IF (v_payout.paypal_item_id IS NOT NULL AND v_payout.paypal_item_id <> v_item)
     OR EXISTS (SELECT 1 FROM public.affiliate_payouts po WHERE po.paypal_item_id = v_item AND po.id <> p_payout_id) THEN
    RETURN jsonb_build_object('status', 'item_mismatch');
  END IF;
  IF EXISTS (SELECT 1 FROM public.affiliate_payouts po WHERE po.paypal_transaction_id = v_transaction AND po.id <> p_payout_id) THEN
    RETURN jsonb_build_object('status', 'duplicate_transaction');
  END IF;

  UPDATE public.affiliate_payouts
     SET status = 'COMPLETED'::public.affiliate_payout_status, paid_at = now(), failure_reason = NULL,
         paypal_item_id = v_item, paypal_transaction_id = v_transaction, paypal_item_status = v_status,
         paypal_fee_cents = coalesce(p_fee_cents, paypal_fee_cents), paypal_checked_at = now()
   WHERE id = p_payout_id;
  UPDATE public.affiliate_commissions c
     SET status = 'PAID'::public.affiliate_commission_status, paid_at = now()
   WHERE c.payout_id = p_payout_id
     AND c.status IN ('PENDING_CLEARANCE'::public.affiliate_commission_status, 'CLEARED'::public.affiliate_commission_status);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.affiliate_profiles SET total_paid_cents = total_paid_cents + v_payout.amount_cents WHERE id = v_affiliate;

  RETURN jsonb_build_object('status', 'completed', 'payout_id', p_payout_id, 'affiliate_id', v_affiliate,
                            'amount_cents', v_payout.amount_cents, 'currency', v_payout.currency, 'commission_count', v_count,
                            'transaction_id', v_transaction);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_paypal_affiliate_payout(uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_paypal_affiliate_payout(uuid, text, text, bigint, text) TO service_role;

-- fail_paypal_affiliate_payout(): PayPal will not pay it. That PayPal payout, still PROCESSING, becomes
-- FAILED with the reason (trimmed to 500 characters, prefixed 'paypal_failed:' unless it starts with
-- 'paypal_', which the failure reason CHECK requires) and the item's status; the work it owes its
-- commissions is applied first (A8: a full refund flagged while it was in flight voids its commission,
-- a partial one reduces it, as fail_affiliate_payout() does for a transfer), and every commission left
-- is handed back to the cleared balance (unattached), so the next run pays it again (manually, through
-- Stripe or PayPal, by the program's routing then). Nothing here moves money. Answers:
--   {"status": "not_found"}          no such PayPal payout
--   {"status": "already_completed"}  PayPal paid it: it cannot fail
--   {"status": "already_failed"}     it is FAILED already (its commissions were handed back)
--   {"status": "failed", "payout_id": id, "affiliate_id": id, "amount_cents": n, "currency": c, "commission_count": n}
--                                    commission_count: how many commissions went back to the cleared balance
CREATE OR REPLACE FUNCTION public.fail_paypal_affiliate_payout(p_payout_id uuid, p_reason text, p_item_status text DEFAULT NULL)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_reason text := left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'paypal_failed'), 500);
  v_status text := nullif(upper(btrim(coalesce(p_item_status, ''))), '');
  v_affiliate uuid;
  v_payout record;
  v_count integer;
BEGIN
  IF v_status IS NOT NULL AND v_status !~ '^[A-Z][A-Z_]{0,39}$' THEN
    v_status := NULL;
  END IF;
  IF v_reason !~ '^paypal_' THEN
    v_reason := left('paypal_failed:' || v_reason, 500);
  END IF;

  SELECT po.affiliate_id INTO v_affiliate
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal';
  IF v_affiliate IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.amount_cents, po.currency
    INTO v_payout
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_payout.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_payout.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('status', 'already_failed');
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);
  UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.affiliate_payouts
     SET status = 'FAILED'::public.affiliate_payout_status, failure_reason = v_reason,
         paypal_item_status = coalesce(v_status, paypal_item_status), paypal_checked_at = now()
   WHERE id = p_payout_id;

  RETURN jsonb_build_object('status', 'failed', 'payout_id', p_payout_id, 'affiliate_id', v_affiliate,
                            'amount_cents', v_payout.amount_cents, 'currency', v_payout.currency, 'commission_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_paypal_affiliate_payout(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_paypal_affiliate_payout(uuid, text, text) TO service_role;

-- release_paypal_affiliate_payout(): the CMS Release of a PayPal payout PayPal has not settled, after
-- the admin checked in PayPal (Activity) that it paid nothing. The rule is checked here, under the
-- claim's lock order (the profile, the commissions, the payout), not only by the screen that offers the
-- button: a run that sends the batch again meanwhile stamps last_attempt_at first, so the release
-- waits. That PayPal payout, still PROCESSING, is released only when PayPal cannot be paying it:
--   - PayPal never acknowledged its batch (no paypal_batch_id: claimed and never sent, or sent with an
--     unknown outcome) and its last send is at least 1 hour old;
--   - or PayPal acknowledged the batch but never settled the payout (the run cannot read the batch, the
--     item is missing from it, its status is one this site does not know): its last send is at least
--     7 days old and PayPal lists no status it holds money in for its item (SUCCESS, PENDING, ONHOLD;
--     an UNCLAIMED item is cancelled at PayPal instead).
-- Then, as fail_paypal_affiliate_payout() does, the refund work owed to its commissions is applied, the
-- rest go back to the cleared balance and the row is FAILED with 'paypal_released_by_admin'. Nothing
-- here moves money. Answers:
--   {"status": "not_found"}          no such PayPal payout
--   {"status": "already_completed"}  PayPal paid it
--   {"status": "already_failed"}     it is FAILED already
--   {"status": "held_by_paypal"}     PayPal lists its item as SUCCESS, PENDING, ONHOLD or UNCLAIMED
--   {"status": "too_recent"}         its last send is less than 1 hour (unacknowledged) or 7 days old
--   {"status": "released", "payout_id": id, "affiliate_id": id, "amount_cents": n, "currency": c,
--    "commission_count": n, "acknowledged": bool}
CREATE OR REPLACE FUNCTION public.release_paypal_affiliate_payout(p_payout_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_affiliate uuid;
  v_payout record;
  v_count integer;
BEGIN
  SELECT po.affiliate_id INTO v_affiliate
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal';
  IF v_affiliate IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1 FROM public.affiliate_profiles p WHERE p.id = v_affiliate FOR UPDATE;
  PERFORM 1 FROM public.affiliate_commissions c WHERE c.payout_id = p_payout_id FOR UPDATE;
  SELECT po.status::text AS status, po.amount_cents, po.currency, po.paypal_batch_id, po.paypal_item_status, po.last_attempt_at
    INTO v_payout
    FROM public.affiliate_payouts po
   WHERE po.id = p_payout_id AND po.method = 'paypal'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_payout.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_payout.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('status', 'already_failed');
  END IF;
  IF v_payout.paypal_batch_id IS NOT NULL
     AND coalesce(v_payout.paypal_item_status, '') IN ('SUCCESS', 'PENDING', 'ONHOLD', 'UNCLAIMED') THEN
    RETURN jsonb_build_object('status', 'held_by_paypal');
  END IF;
  IF (v_payout.paypal_batch_id IS NULL AND v_payout.last_attempt_at > now() - interval '1 hour')
     OR (v_payout.paypal_batch_id IS NOT NULL AND v_payout.last_attempt_at > now() - interval '7 days') THEN
    RETURN jsonb_build_object('status', 'too_recent');
  END IF;

  PERFORM private.affiliate_apply_pending_payout_work(p_payout_id);
  UPDATE public.affiliate_commissions c SET payout_id = NULL WHERE c.payout_id = p_payout_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.affiliate_payouts
     SET status = 'FAILED'::public.affiliate_payout_status, failure_reason = 'paypal_released_by_admin'
   WHERE id = p_payout_id;

  RETURN jsonb_build_object('status', 'released', 'payout_id', p_payout_id, 'affiliate_id', v_affiliate,
                            'amount_cents', v_payout.amount_cents, 'currency', v_payout.currency, 'commission_count', v_count,
                            'acknowledged', v_payout.paypal_batch_id IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.release_paypal_affiliate_payout(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_paypal_affiliate_payout(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. private.affiliate_alert_refund_after_payout: PayPal payouts get their own advice
-- ---------------------------------------------------------------------------
-- 02036's definition with one change: a PayPal payout. While PayPal still has it (PROCESSING) the
-- refund is flagged on its commission (void_requested_at / refund_pending_cents) and applied if PayPal
-- returns it or it fails (fail_paypal_affiliate_payout); if it completes, the partner was paid for a
-- refunded sale and the admin recovers the amount. After a completed PayPal payout, the admin recovers
-- the amount from the partner (a PayPal payout cannot be taken back, and nothing in the ledger deducts
-- it from a later payout). The metadata names payout_method 'paypal' and the status. Signature,
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
  v_paypal boolean := false;
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
    v_paypal := coalesce(v_method = 'paypal', false);
  END IF;
  v_advice := CASE
    WHEN v_manual AND v_status = 'PROCESSING' THEN 'Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.'
    WHEN v_manual THEN 'Recover the amount from the partner, for example by asking them to send it back.'
    WHEN v_paypal AND v_status = 'PROCESSING' THEN 'Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.'
    WHEN v_paypal THEN 'Recover the amount from the partner, for example by asking them to send it back.'
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
      'payout_method', CASE WHEN v_manual THEN 'manual' WHEN v_paypal THEN 'paypal' ELSE 'stripe_connect' END,
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
-- 5. site_settings.affiliates_paypal_secret: service role only
-- ---------------------------------------------------------------------------
-- The CMS-saved PayPal credentials: {"environment": "sandbox" | "live", "sandbox": {"clientId": …,
-- "secret": <encrypted envelope>}, "live": {…}, "updatedAt": …}. The read and write tiers of 02021 /
-- 02028 already keep a key they do not list ADMIN-only on a satisfied second factor; a RESTRICTIVE
-- policy (AND-ed with every permissive one) takes it from the API roles altogether, so neither an aal2
-- ADMIN session nor the public sandbox's factor-less demo admin can read the encrypted envelope or
-- plant credentials over the Data API. The service role bypasses RLS: the app reads and writes the
-- row after requireCmsAdmin(), never on the sandbox. No grant changes.
DROP POLICY IF EXISTS site_settings_paypal_secret_service_only_policy ON public.site_settings;
CREATE POLICY site_settings_paypal_secret_service_only_policy ON public.site_settings
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (key <> 'affiliates_paypal_secret')
  WITH CHECK (key <> 'affiliates_paypal_secret');

-- ---------------------------------------------------------------------------
-- 6. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.affiliate_payouts IS 'Payouts to partners: Stripe Connect transfers (method stripe_connect), PayPal Payouts items sent from the operator''s PayPal balance (method paypal, 02037) and payouts the operator sends outside Stripe (method manual, 02036), each claimed before the money moves (PROCESSING). A manual payout is COMPLETED when an admin records it and deleted when cancelled, never FAILED; a PayPal payout is COMPLETED when PayPal paid its item and FAILED, its commissions handed back, when PayPal will not. Written only by the service-role RPCs; the partner reads its own rows.';
COMMENT ON COLUMN public.affiliate_payouts.method IS 'stripe_connect (a Stripe Connect transfer from the platform balance), paypal (a PayPal Payouts item from the operator''s PayPal balance: claim_paypal_affiliate_payout, then complete_ or fail_paypal_affiliate_payout on PayPal''s answer, or release_paypal_affiliate_payout from the CMS; 02037) or manual (money sent outside Stripe: prepared with claim_manual_affiliate_payout, recorded with record_manual_affiliate_payout, cancelled with cancel_manual_affiliate_payout). Only a Stripe payout carries a destination or a transfer id, only a PayPal one the paypal_* columns.';
COMMENT ON COLUMN public.affiliate_payouts.livemode IS 'Mode of the money: for a Stripe payout the destination account''s key mode at claim, for a PayPal payout the PayPal environment (false: the PayPal sandbox). A payout holds only commissions of its mode; a Stripe one is retried only with a key of the same mode.';
COMMENT ON COLUMN public.affiliate_payouts.paypal_receiver IS 'A PayPal payout''s recipient: the partner''s PayPal payout email when it was claimed (at most 127 characters, PayPal''s receiver limit).';
COMMENT ON COLUMN public.affiliate_payouts.paypal_sender_batch_id IS 'The sender_batch_id (and PayPal-Request-Id) of the PayPal batch carrying the payout, saved before the create call: a create that timed out is retried with the same id.';
COMMENT ON COLUMN public.affiliate_payouts.paypal_batch_id IS 'PayPal''s payout_batch_id, once the create call answered.';
COMMENT ON COLUMN public.affiliate_payouts.paypal_item_id IS 'PayPal''s payout_item_id of this payout''s item (unique).';
COMMENT ON COLUMN public.affiliate_payouts.paypal_transaction_id IS 'PayPal''s transaction id once the item reached SUCCESS (unique; required once COMPLETED).';
COMMENT ON COLUMN public.affiliate_payouts.paypal_item_status IS 'The item''s last transaction_status as PayPal wrote it (SUCCESS, PENDING, UNCLAIMED, ONHOLD, RETURNED, …).';
COMMENT ON COLUMN public.affiliate_payouts.paypal_fee_cents IS 'PayPal''s fee for the item, minor units of the payout currency (NULL when unknown or charged in another currency). The partner receives the full amount.';
COMMENT ON COLUMN public.affiliate_payouts.paypal_checked_at IS 'When PayPal was last asked about the payout.';
COMMENT ON COLUMN public.affiliate_payouts.failure_reason IS 'Why the last attempt failed (a Stripe error code, stale, nothing_to_pay, below_minimum, released; for a PayPal payout always paypal_…: paypal_<status> or paypal_<error name>, paypal_cancelled, paypal_released_by_admin).';
COMMENT ON COLUMN public.affiliate_profiles.payout_email_saved_at IS 'When the partner last saved the payout email (the portal stamps every save, the same address included). A PayPal payout returned from an address keeps the run off it until a save after that return. Server-written like payout_email; no Data API grant, and the profile guard refuses it from a partner session (02037).';
COMMENT ON COLUMN public.affiliate_profiles.payout_email_kind IS 'What payout_email is: paypal (the email of a PayPal account: automatic PayPal payouts and the PayPal payouts file can use it; the default) or interac (an Interac e-Transfer address, paid by hand). Written like payout_email (the server after requireRetailer(), or an admin); no Data API grant, and the profile guard refuses it from a partner session (02037).';
COMMENT ON FUNCTION public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text) IS 'Service role: before any PayPal call, attaches an ACTIVE, approved partner''s CLEARED, unattached, undisputed commissions of one currency, of the PayPal gateways and of the PayPal environment''s mode to a new PROCESSING PayPal payout to their PayPal payout email; one in flight per partner, currency and mode. Returns {status, ...}: invalid_input, not_found, not_eligible, no_paypal_email, already_in_flight, nothing_owed, below_minimum or claimed.';
COMMENT ON FUNCTION public.record_paypal_affiliate_payout_batch(uuid[], text, text) IS 'Service role: saves a PayPal batch''s sender_batch_id (before the create call) and payout_batch_id (after it) on its PROCESSING PayPal payouts, never overwriting a different id. Returns {status, count}: recorded or invalid_input.';
COMMENT ON FUNCTION public.note_paypal_affiliate_payout_item(uuid, text, text, bigint) IS 'Service role: records what a sync learned about an in-flight PayPal payout (item id, transaction_status, fee, check time). Returns {status}: noted, not_found or invalid_input.';
COMMENT ON FUNCTION public.complete_paypal_affiliate_payout(uuid, text, text, bigint, text) IS 'Service role: PayPal paid the item: the PROCESSING PayPal payout becomes COMPLETED with its transaction id and fee, its commissions PAID, total_paid_cents up by its amount, exactly once. Returns {status, ...}: invalid_input, not_found, already_completed, not_processing, item_mismatch, duplicate_transaction or completed.';
COMMENT ON FUNCTION public.fail_paypal_affiliate_payout(uuid, text, text) IS 'Service role: PayPal will not pay the item: the PROCESSING PayPal payout becomes FAILED with the reason, the refund work owed to its commissions is applied and the rest go back to the cleared balance. Returns {status, ...}: not_found, already_completed, already_failed or failed.';
COMMENT ON FUNCTION public.release_paypal_affiliate_payout(uuid) IS 'Service role: the CMS Release of a PayPal payout PayPal has not settled, checked under the payout lock: an unacknowledged batch 1 hour after its last send, an acknowledged one 7 days after it while PayPal lists no SUCCESS, PENDING, ONHOLD or UNCLAIMED status; then FAILED (paypal_released_by_admin) with its commissions handed back. Returns {status, ...}: not_found, already_completed, already_failed, held_by_paypal, too_recent or released.';
COMMENT ON POLICY site_settings_paypal_secret_service_only_policy ON public.site_settings IS 'affiliates_paypal_secret (the CMS-saved PayPal credentials, 02037) is service-role only: no API role reads or writes it, an aal2 ADMIN included.';

-- ---------------------------------------------------------------------------
-- 7. UI copy of the partner side (the forms the 02031 generator header prescribes)
-- ---------------------------------------------------------------------------
-- Data only (public.translations, which already has its grants): no schema object, no grant. The
-- partner portal's payouts page asks PayPal or Interac e-Transfer first (payout_email_kind) and takes a
-- PayPal email twice; payout_email_label is now the question above that choice and payout_email_help
-- the PayPal warning (keys kept, reworded below). It says when PayPal sends the next payout ("Sent by
-- PayPal on the next daily run once you reach {min}."), reads PayPal payouts in the history as
-- "PayPal · {status}" with the transaction id once paid and where to claim one PayPal holds, and warns
-- a partner whose PayPal payout came back (with "I checked it: try PayPal again", which saves the same
-- address again: payout_email_saved_at lifts the block). Its header and FAQ name Stripe and PayPal, or
-- PayPal and the store's own payouts, for programs that mix them; an empty PayPal email confirmation
-- has its own message. The built-in terms name PayPal Payouts per kind of sale (the
-- Program details method and schedule rows), say what PayPal does with an unclaimed payout, that
-- Interac e-Transfers are sent by hand and that PayPal has its own agreement; the payout, schedule and
-- recovery clauses name PayPal. The partner emails of PayPal payouts are internal copy (not seeded).
-- libs/affiliates/src/lib/i18n/translations-migration.test.ts replays this section with every other
-- migration and fails until the seeded copy matches the dictionaries.
--
-- New keys, never overwriting a row that already exists.
INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('affiliates.portal.balance_cleared_paypal_hint', jsonb_build_object('en', 'Sent by PayPal once it reaches {min}.', 'fr', 'Envoyé par PayPal une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.balance_cleared_paypal_manual_hint', jsonb_build_object('en', '{paypal} goes by PayPal and {manual} is paid by {site}, each once it reaches {min}.', 'fr', '{paypal} part par PayPal et {manual} est versé par {site}, chacun une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.balance_cleared_stripe_paypal_hint', jsonb_build_object('en', '{stripe} goes by Stripe transfer and {paypal} by PayPal, each once it reaches {min}.', 'fr', '{stripe} part par virement Stripe et {paypal} par PayPal, chacun une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.balance_next_paypal_payout', jsonb_build_object('en', 'Next PayPal payout', 'fr', 'Prochain versement PayPal'), now(), now()),
  ('affiliates.portal.balance_processing_paypal_hint', jsonb_build_object('en', '{amount} is on its way to your PayPal account.', 'fr', '{amount} est en route vers votre compte PayPal.'), now(), now()),
  ('affiliates.portal.balance_unclaimed_paypal_hint', jsonb_build_object('en', '{amount} is waiting for you to claim it in PayPal.', 'fr', '{amount} attend que vous le réclamiez dans PayPal.'), now(), now()),
  ('affiliates.portal.commission_payout_paypal', jsonb_build_object('en', 'PayPal', 'fr', 'PayPal'), now(), now()),
  ('affiliates.portal.error_payout_email_confirm_empty', jsonb_build_object('en', 'Type your PayPal email again to confirm it.', 'fr', 'Entrez de nouveau votre courriel PayPal pour le confirmer.'), now(), now()),
  ('affiliates.portal.error_payout_email_mismatch', jsonb_build_object('en', 'The two email addresses don''t match.', 'fr', 'Les deux adresses courriel ne correspondent pas.'), now(), now()),
  ('affiliates.portal.faq_payout_answer_paypal', jsonb_build_object('en', 'Once your cleared balance reaches {min}, the next daily payout run sends it to your PayPal account. If you chose Interac e-Transfer, {site} sends it by hand instead.', 'fr', 'Dès que votre solde confirmé atteint {min}, le prochain versement quotidien l''envoie dans votre compte PayPal. Si vous avez choisi le virement Interac, {site} vous l''envoie plutôt manuellement.'), now(), now()),
  ('affiliates.portal.faq_payout_answer_paypal_manual', jsonb_build_object('en', 'It depends on the order: “How you get paid” above says which commissions go to PayPal. Those are sent to your PayPal account in the daily payout run once they reach {min}, or by hand if you chose Interac e-Transfer. {site} sends you the others directly, once they reach the same minimum.', 'fr', 'Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions vont à PayPal. Celles-ci sont envoyées dans votre compte PayPal lors du versement quotidien dès qu''elles atteignent {min}, ou manuellement si vous avez choisi le virement Interac. {site} vous envoie les autres directement, une fois ce même minimum atteint.'), now(), now()),
  ('affiliates.portal.faq_payout_answer_stripe_paypal', jsonb_build_object('en', 'It depends on the order: “How you get paid” above says which commissions go through Stripe and which go to PayPal. Each kind is sent in the daily payout run once it reaches {min}: to your bank through Stripe, or to your PayPal account. If you chose Interac e-Transfer, {site} sends the PayPal ones by hand instead.', 'fr', 'Cela dépend de la commande : la section « Comment vous êtes payé » ci-dessus indique quelles commissions passent par Stripe et lesquelles vont à PayPal. Chacune est envoyée lors du versement quotidien dès qu''elle atteint {min} : dans votre compte bancaire par Stripe, ou dans votre compte PayPal. Si vous avez choisi le virement Interac, {site} vous envoie plutôt manuellement celles de PayPal.'), now(), now()),
  ('affiliates.portal.next_payout_paypal_hint', jsonb_build_object('en', 'Sent by PayPal on the next daily run once you reach {min}.', 'fr', 'Envoyé par PayPal au prochain versement quotidien, une fois le minimum de {min} atteint.'), now(), now()),
  ('affiliates.portal.next_payout_paypal_sending', jsonb_build_object('en', 'On its way', 'fr', 'En route'), now(), now()),
  ('affiliates.portal.payout_email_interac_help', jsonb_build_object('en', 'Interac e-Transfers are sent by {site} by hand, usually less often.', 'fr', 'Les virements Interac sont envoyés manuellement par {site}, habituellement moins souvent.'), now(), now()),
  ('affiliates.portal.payout_email_interac_help_manual', jsonb_build_object('en', '{site} sends Interac e-Transfers by hand.', 'fr', '{site} envoie les virements Interac manuellement.'), now(), now()),
  ('affiliates.portal.payout_email_interac_label', jsonb_build_object('en', 'Email for Interac e-Transfers', 'fr', 'Courriel pour les virements Interac'), now(), now()),
  ('affiliates.portal.payout_email_paypal_confirm_hint', jsonb_build_object('en', 'A new PayPal email is typed twice: confirm it in the next field.', 'fr', 'Un nouveau courriel PayPal doit être entré deux fois : confirmez-le dans le champ suivant.'), now(), now()),
  ('affiliates.portal.payout_email_paypal_confirm_label', jsonb_build_object('en', 'Confirm your PayPal email', 'fr', 'Confirmez votre courriel PayPal'), now(), now()),
  ('affiliates.portal.payout_email_paypal_label', jsonb_build_object('en', 'Email of your PayPal account', 'fr', 'Courriel de votre compte PayPal'), now(), now()),
  ('affiliates.portal.payout_email_retry_paypal', jsonb_build_object('en', 'I checked it: try PayPal again', 'fr', 'Je l''ai vérifié : réessayer PayPal'), now(), now()),
  ('affiliates.portal.payout_email_retry_saved', jsonb_build_object('en', 'Saved: PayPal is tried at this address again with your next payout.', 'fr', 'Enregistré : PayPal sera réessayé à cette adresse lors de votre prochain versement.'), now(), now()),
  ('affiliates.portal.payout_kind_interac', jsonb_build_object('en', 'Interac e-Transfer', 'fr', 'Virement Interac'), now(), now()),
  ('affiliates.portal.payout_kind_paypal', jsonb_build_object('en', 'PayPal', 'fr', 'PayPal'), now(), now()),
  ('affiliates.portal.payout_methods_by_paypal', jsonb_build_object('en', 'Your commissions are sent to your PayPal account automatically, or by Interac e-Transfer if you choose it.', 'fr', 'Vos commissions sont envoyées automatiquement dans votre compte PayPal, ou par virement Interac si vous le choisissez.'), now(), now()),
  ('affiliates.portal.payout_paypal_back_in_balance', jsonb_build_object('en', 'The amount went back to your balance.', 'fr', 'Le montant est retourné dans votre solde.'), now(), now()),
  ('affiliates.portal.payout_paypal_claim_hint', jsonb_build_object('en', 'Claim it in PayPal: check the email PayPal sent to {email}.', 'fr', 'Réclamez-le dans PayPal : consultez le courriel que PayPal a envoyé à {email}.'), now(), now()),
  ('affiliates.portal.payout_paypal_returned_notice', jsonb_build_object('en', 'PayPal returned the last payout sent to {email}. Check that it is the email of your PayPal account (or open and confirm a PayPal account with it), then save it again below, or choose Interac e-Transfer. Until you do, {site} pays you by hand.', 'fr', 'PayPal a retourné le dernier versement envoyé à {email}. Vérifiez qu''il s''agit bien du courriel de votre compte PayPal (ou ouvrez et confirmez un compte PayPal avec ce courriel), puis enregistrez-le de nouveau ci-dessous, ou choisissez le virement Interac. D''ici là, {site} vous paie manuellement.'), now(), now()),
  ('affiliates.portal.payout_paypal_status', jsonb_build_object('en', 'PayPal · {status}', 'fr', 'PayPal · {status}'), now(), now()),
  ('affiliates.portal.payout_paypal_status_not_sent', jsonb_build_object('en', 'Not sent', 'fr', 'Non envoyé'), now(), now()),
  ('affiliates.portal.payout_paypal_status_paid', jsonb_build_object('en', 'Paid', 'fr', 'Payé'), now(), now()),
  ('affiliates.portal.payout_paypal_status_returned', jsonb_build_object('en', 'Returned', 'fr', 'Retourné'), now(), now()),
  ('affiliates.portal.payout_paypal_status_sent', jsonb_build_object('en', 'Sent', 'fr', 'Envoyé'), now(), now()),
  ('affiliates.portal.payout_paypal_status_unclaimed', jsonb_build_object('en', 'Waiting for you to claim it', 'fr', 'En attente que vous le réclamiez'), now(), now()),
  ('affiliates.portal.payout_paypal_transaction', jsonb_build_object('en', 'Transaction {reference}', 'fr', 'Transaction {reference}'), now(), now()),
  ('affiliates.portal.payouts_description_paypal', jsonb_build_object('en', 'Your commissions clear after the refund window, then go to your PayPal account automatically, or by Interac e-Transfer if you choose it.', 'fr', 'Vos commissions sont confirmées après la période de remboursement, puis envoyées automatiquement dans votre compte PayPal, ou par virement Interac si vous le choisissez.'), now(), now()),
  ('affiliates.portal.payouts_description_paypal_manual', jsonb_build_object('en', 'Your commissions clear after the refund window. Depending on the order, they then go to your PayPal account automatically (or by Interac e-Transfer if you choose it), or {site} sends them to you directly.', 'fr', 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite envoyées automatiquement dans votre compte PayPal (ou par virement Interac si vous le choisissez), ou {site} vous les envoie directement.'), now(), now()),
  ('affiliates.portal.payouts_description_stripe_paypal', jsonb_build_object('en', 'Your commissions clear after the refund window. Depending on the order, they then go to your bank through Stripe, or to your PayPal account automatically (or by Interac e-Transfer if you choose it).', 'fr', 'Vos commissions sont confirmées après la période de remboursement. Selon la commande, elles sont ensuite versées dans votre compte bancaire par Stripe, ou envoyées automatiquement dans votre compte PayPal (ou par virement Interac si vous le choisissez).'), now(), now()),
  ('affiliates.terms.details_payout_method_paypal', jsonb_build_object('en', 'Sent to your PayPal account by PayPal Payouts, or by Interac e-Transfer if you choose it', 'fr', 'Envoyé à votre compte PayPal par PayPal Payouts, ou par virement Interac si vous le choisissez'), now(), now()),
  ('affiliates.terms.details_schedule_paypal_daily', jsonb_build_object('en', 'PayPal payouts: automatic, every day. Interac e-Transfers: when we send them.', 'fr', 'Versements PayPal : automatiques, chaque jour. Virements Interac : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_paypal_direct_daily', jsonb_build_object('en', 'PayPal payouts: automatic, every day. Direct payouts: when we send them.', 'fr', 'Versements PayPal : automatiques, chaque jour. Versements directs : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_paypal_direct_manual', jsonb_build_object('en', 'PayPal payouts: when we run them. Direct payouts: when we send them.', 'fr', 'Versements PayPal : quand nous les lançons. Versements directs : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_paypal_manual', jsonb_build_object('en', 'PayPal payouts: when we run them. Interac e-Transfers: when we send them.', 'fr', 'Versements PayPal : quand nous les lançons. Virements Interac : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_stripe_paypal_daily', jsonb_build_object('en', 'Stripe transfers and PayPal payouts: automatic, every day. Interac e-Transfers: when we send them.', 'fr', 'Virements Stripe et versements PayPal : automatiques, chaque jour. Virements Interac : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.details_schedule_stripe_paypal_manual', jsonb_build_object('en', 'Stripe transfers and PayPal payouts: when we run them. Interac e-Transfers: when we send them.', 'fr', 'Virements Stripe et versements PayPal : quand nous les lançons. Virements Interac : quand nous les envoyons.'), now(), now()),
  ('affiliates.terms.payouts_interac', jsonb_build_object('en', 'If you choose Interac e-Transfer, we send your payouts by hand.', 'fr', 'Si vous choisissez le virement Interac, nous envoyons vos versements manuellement.'), now(), now()),
  ('affiliates.terms.payouts_paypal', jsonb_build_object('en', 'For payouts by PayPal, use the email of your PayPal account. A payout sent to an address without a confirmed PayPal account waits to be claimed for a limited time; then PayPal returns it, and the amount goes back to your balance.', 'fr', 'Pour les versements par PayPal, utilisez le courriel de votre compte PayPal. Un versement envoyé à une adresse sans compte PayPal confirmé attend d''être réclamé pendant un temps limité; PayPal le retourne ensuite, et le montant revient dans votre solde.'), now(), now()),
  ('affiliates.terms.payouts_paypal_agreement', jsonb_build_object('en', 'Your PayPal account is covered by PayPal''s own agreement with you.', 'fr', 'Votre compte PayPal est soumis à l''entente que PayPal conclut avec vous.'), now(), now())
ON CONFLICT (key) DO NOTHING;

-- Changed text, each language guarded by the text 02036 seeded (its new keys, or its rewording of
-- 02031's), so copy an operator edited (CMS > Settings > Extra Translations) stays theirs.
UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{en}', to_jsonb(fix.new_en)), updated_at = now()
  FROM (VALUES
    ('affiliates.portal.payout_email_label',
     'Email for PayPal or Interac e-Transfer payouts',
     'How do you want to receive your payouts?'),
    ('affiliates.portal.payout_email_help',
     'We send manual payouts to this address. Use the email of your PayPal account, or the one you use for Interac e-Transfer.',
     'Use the email of your PayPal account. A payout to an address without a confirmed PayPal account waits 30 days to be claimed, then returns.'),
    ('affiliates.terms.payouts_stripe',
     'Depending on the sale, we pay you with Stripe Connect Express, into a Stripe account in your name, or we send the money to you directly, for example by PayPal or Interac e-Transfer.',
     'Depending on the sale, we pay you into a Stripe account in your name (Stripe Connect Express), into your PayPal account with PayPal Payouts, or we send the money to you directly, for example by PayPal or Interac e-Transfer.'),
    ('affiliates.terms.payouts_direct',
     'For payouts we send directly, add your payout email in your partner portal. We send the money to that address, so keep it up to date.',
     'For payouts by PayPal or sent directly, add your payout email in your partner portal and choose PayPal or Interac e-Transfer. We send the money to that address, so keep it up to date.'),
    ('affiliates.terms.payouts_schedule',
     'Payouts follow our schedule. A payout can be late, for example if a payment service is unavailable or our Stripe balance is too low.',
     'Payouts follow our schedule. A payout can be late, for example if a payment service is unavailable or our Stripe or PayPal balance is too low.'),
    ('affiliates.terms.refunds_after_payout',
     'If a refund or a lost dispute comes after we paid you, we may take that amount back, by reversing the Stripe transfer or by deducting it from a later payout.',
     'If a refund or a lost dispute comes after we paid you, we may take that amount back: by reversing the Stripe transfer, by asking you to send it back, or by deducting it from a later payout.')
  ) AS fix(key, old_en, new_en)
 WHERE t.key = fix.key AND t.translations->>'en' = fix.old_en;

UPDATE public.translations AS t
   SET translations = jsonb_set(t.translations, '{fr}', to_jsonb(fix.new_fr)), updated_at = now()
  FROM (VALUES
    ('affiliates.portal.payout_email_label',
     'Courriel pour les versements par PayPal ou virement Interac',
     'Comment voulez-vous recevoir vos versements?'),
    ('affiliates.portal.payout_email_help',
     'Nous envoyons les versements manuels à cette adresse. Utilisez le courriel de votre compte PayPal, ou celui que vous utilisez pour les virements Interac.',
     'Utilisez le courriel de votre compte PayPal. Un versement envoyé à une adresse sans compte PayPal confirmé attend 30 jours d''être réclamé, puis il est retourné.'),
    ('affiliates.terms.payouts_stripe',
     'Selon la vente, nous vous payons avec Stripe Connect Express, dans un compte Stripe à votre nom, ou nous vous envoyons l''argent directement, par exemple par PayPal ou virement Interac.',
     'Selon la vente, nous vous payons dans un compte Stripe à votre nom (Stripe Connect Express), dans votre compte PayPal avec PayPal Payouts, ou nous vous envoyons l''argent directement, par exemple par PayPal ou virement Interac.'),
    ('affiliates.terms.payouts_direct',
     'Pour les versements que nous envoyons directement, ajoutez votre courriel de versement dans votre portail partenaire. Nous envoyons l''argent à cette adresse : gardez-la à jour.',
     'Pour les versements par PayPal ou envoyés directement, ajoutez votre courriel de versement dans votre portail partenaire et choisissez PayPal ou le virement Interac. Nous envoyons l''argent à cette adresse : gardez-la à jour.'),
    ('affiliates.terms.payouts_schedule',
     'Les versements suivent notre calendrier. Un versement peut être retardé, par exemple si un service de paiement est indisponible ou si notre solde Stripe est insuffisant.',
     'Les versements suivent notre calendrier. Un versement peut être retardé, par exemple si un service de paiement est indisponible ou si notre solde Stripe ou PayPal est insuffisant.'),
    ('affiliates.terms.refunds_after_payout',
     'Si un remboursement ou un litige perdu survient après votre versement, nous pouvons reprendre ce montant, en annulant le virement Stripe ou en le déduisant d''un versement suivant.',
     'Si un remboursement ou un litige perdu survient après votre versement, nous pouvons reprendre ce montant : en annulant le virement Stripe, en vous demandant de nous le renvoyer ou en le déduisant d''un versement suivant.')
  ) AS fix(key, old_fr, new_fr)
 WHERE t.key = fix.key AND t.translations->>'fr' = fix.old_fr;
