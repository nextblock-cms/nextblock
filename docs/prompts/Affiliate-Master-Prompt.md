# Role & Objective
You are the Lead Full-Stack Architect working on **NextBlock CMS** (Next.js 16 App Router, React Server Components, Supabase PostgreSQL + JSONB, Tiptap Editor, Cortex AI, Tailwind CSS, Nx Monorepo).

We are building a brand-new, modular first-party premium package: **NextBlock Affiliates & Creator Storefronts (`@nextblock/affiliates`)** located in `packages/affiliates` (mounted at `/cms/affiliates` for Admins and `/portal/retailer` for Affiliates/Retailers).

### Core Architectural Pillars:
1. **30-Day Attribution & 30-Day Refund Protection:** Next.js 16 Edge Middleware sets a **30-day** first-party HTTP-only cookie (`nb_affiliate_ref`). Every commission (from Stripe or Freemius) starts as `PENDING_CLEARANCE` for a default **30-day** clearance window before payout.
2. **100% Automated Payouts via Stripe Connect Express:** No manual payouts. Affiliates onboard via Stripe Connect Express (`stripe_connect_account_id`), and a scheduled cron job automatically transfers cleared commissions to their bank account once the 30-day hold expires.
3. **Pre-Seeded Tiers (10%, 20%, 35%, and Limited-Time 50%) with Full Admin CRUD:** Seed 4 default tiers (`Starter 10%`, `Growth 20%`, `Elite 35%`, and `Founding Ambassador 50%`). Admins can rename tiers, change percentages, and set spot caps in `/cms/affiliates/tiers`.
4. **New `'RTL'` (Retailer) Auth Role & Dropshipping-Proof Single Storefront Page:** Each `RTL` user gets strictly ONE co-branded storefront page (`/partners/[handle]`) edited via a scoped Tiptap editor (`draft_content` vs `published_content`) requiring Admin approval to publish.
5. **Hard-Sandboxed Cortex AI Copilot for `RTL` Users:** `RTL` users can use Cortex AI ONLY to write their bio and build/edit Tiptap blocks on their single storefront page. They must have ZERO access to store analytics, sales numbers, global navigation, or other pages.

Execute this implementation sequentially across the following 7 Milestones.

---

## 🛠️ MILESTONE 1: Database Schema, `RTL` Auth Role & Pre-Seeded Tier CRUD (`packages/affiliates/schema`)
Create a new additive Supabase SQL migration with strict Row-Level Security (RLS):

1. **Auth Role Extension (`RTL`):**
   - Extend our user role enum / role constraints so users can hold the `'RTL'` (Retailer) role alongside `'ADMIN'` and standard roles.
2. **`affiliate_tiers` Table (Full Admin CRUD + Pre-Seeded Tiers):**
   - Columns:
     - `id` (UUID PK)
     - `name` (TEXT NOT NULL)
     - `slug` (TEXT UNIQUE NOT NULL)
     - `commission_percentage` (NUMERIC(5,2) NOT NULL CHECK 0–100)
     - `cookie_duration_days` (INT NOT NULL DEFAULT 30)
     - `clearance_hold_days` (INT NOT NULL DEFAULT 30)
     - `is_default_signup_tier` (BOOLEAN NOT NULL DEFAULT false)
     - `is_limited_time_promo` (BOOLEAN NOT NULL DEFAULT false)
     - `max_ambassadors_cap` (INT NULL — e.g., 50 spots for the Founding tier; NULL = unlimited)
     - `sort_order` (INT NOT NULL DEFAULT 0)
     - `badge_color` (TEXT DEFAULT 'violet')
     - `created_at`, `updated_at`
   - **Seed Data:** Pre-seed 4 tiers in order:
     1. `Starter Partner` (`10.00%`, `sort_order: 1`, `is_default_signup_tier: false`)
     2. `Growth Partner` (`20.00%`, `sort_order: 2`, `is_default_signup_tier: false`)
     3. `Elite Partner` (`35.00%`, `sort_order: 3`, `is_default_signup_tier: false`)
     4. `Founding Ambassador` (`50.00%`, `sort_order: 4`, `is_default_signup_tier: true`, `is_limited_time_promo: true`, `max_ambassadors_cap: 50`)
3. **`affiliate_profiles` Table:**
   - Columns: `id` (UUID PK), `user_id` (UUID UNIQUE FK -> `auth.users`), `tier_id` (UUID FK -> `affiliate_tiers`), `handle` (TEXT UNIQUE, URL-safe slug), `display_name` (TEXT), `bio` (TEXT), `avatar_url` (TEXT), `social_links` (JSONB), `onboarding_step` (ENUM: `'SIGNED_UP'`, `'PROFILE_COMPLETED'`, `'PAYOUT_CONFIGURED'`, `'PAGE_SUBMITTED'`, `'ACTIVE_PUBLISHED'`), `stripe_connect_account_id` (TEXT UNIQUE), `stripe_connect_onboarding_complete` (BOOLEAN DEFAULT false), `total_clicks` (INT DEFAULT 0), `total_earned_cents` (BIGINT DEFAULT 0), `total_paid_cents` (BIGINT DEFAULT 0), `status` (ENUM: `'ACTIVE'`, `'SUSPENDED'`), `created_at`, `updated_at`.
4. **`affiliate_pages` Table (Strict 1-Page-Per-Retailer Constraint):**
   - Columns: `id` (UUID PK), `affiliate_id` (UUID UNIQUE FK -> `affiliate_profiles.id` — **strictly enforces maximum ONE page per `RTL` user**), `user_id` (UUID UNIQUE FK -> `auth.users`), `title` (TEXT), `meta_description` (TEXT), `draft_content` (JSONB - Tiptap document tree edited by the `RTL` user), `published_content` (JSONB - live Tiptap tree updated ONLY upon Admin approval), `featured_product_ids` (UUID[] array of promoted product IDs), `approval_status` (ENUM: `'DRAFT'`, `'PENDING_REVIEW'`, `'PUBLISHED'`, `'CHANGES_REQUESTED'`), `admin_feedback_note` (TEXT), `submitted_at` (TIMESTAMPTZ), `published_at` (TIMESTAMPTZ), `updated_at`.
5. **`affiliate_commissions` & `affiliate_payouts` Tables:**
   - `affiliate_commissions`: `id` (UUID PK), `affiliate_id` (UUID FK), `order_id` (TEXT/UUID), `gateway` (ENUM: `'STRIPE'`, `'FREEMIUS'`), `net_order_amount_cents` (BIGINT), `commission_rate_snapshot` (NUMERIC(5,2)), `commission_amount_cents` (BIGINT), `currency` (TEXT DEFAULT `'USD'`), `status` (ENUM: `'PENDING_CLEARANCE'`, `'CLEARED'`, `'PAID'`, `'VOIDED_REFUND'`), `clears_at` (TIMESTAMPTZ — defaults to `NOW() + INTERVAL '30 days'`), `stripe_transfer_id` (TEXT NULL), `created_at`.
   - `affiliate_payouts`: `id` (UUID PK), `affiliate_id` (UUID FK), `amount_cents` (BIGINT), `currency` (TEXT), `stripe_transfer_id` (TEXT NOT NULL), `status` (ENUM: `'COMPLETED'`, `'FAILED'`), `paid_at` (TIMESTAMPTZ).
6. **Row-Level Security (RLS):**
   - `ADMIN` has full CRUD across all tables.
   - `RTL` users can `SELECT` and `UPDATE` **only** their own row in `affiliate_profiles` and `draft_content` / `title` / `meta_description` / `featured_product_ids` in `affiliate_pages` (`auth.uid() = user_id`).
   - `RTL` users **cannot** mutate `tier_id`, `published_content`, `approval_status = 'PUBLISHED'`, or read any other user's commissions/orders.

---

## 🚀 MILESTONE 2: High-Converting SEO Signup Page & "50% FOMO Hype Slider" (`/partners`)
Build a public, SEO-optimized Ambassador/Retailer landing and signup route at `app/(public)/partners/page.tsx` passing 100/100 on our SEO and Lighthouse checks:

1. **Limited-Time 50% FOMO Tier Showcase & Revenue Calculator:**
   - Query `affiliate_tiers` ordered by `sort_order`.
   - Display a visual **Tier Ladder** showing all 4 tiers (`Starter 10%`, `Growth 20%`, `Elite 35%`, and `🔥 Founding Ambassador 50%`).
   - Visually lock the active tier slider onto the **50% Founding Ambassador** tier with an urgent badge: *"LIMITED TIME LAUNCH OFFER: Claim 50% Revenue Share (Normally 10%–35%) — Limited to our First [remaining_spots] Founding Ambassadors!"*
   - **Interactive Sliders:** Users slide *Monthly Referrals (1–100)* and *Average Order Value*, seeing their projected annual income at **50%** side-by-side with what they would normally make at the standard **10%** tier (highlighting the extra bonus they lock in by joining now).
2. **1-Step Frictionless `RTL` Signup Form:**
   - Claim handle (`yourstore.com/partners/[handle]`), Name, Email, Password.
   - Server Action creates the user with role `'RTL'`, assigns them to the active default tier (`Founding Ambassador 50%`, or automatically falls back to the next default tier if `max_ambassadors_cap` is reached), initializes their single `affiliate_pages` row with a clean Tiptap starter template, notifies the Admin, and redirects to `/portal/retailer`.

---

## 🎨 MILESTONE 3: The `RTL` Retailer Portal, Stripe Connect Express & Scoped Tiptap Studio (`/portal/retailer`)
Create the dedicated Retailer Portal at `app/(portal)/portal/retailer`:

1. **Gamified 4-Step Onboarding Progress Bar:**
   - Tracks: `1. Account Created` ➔ `2. Bio & Profile Completed` ➔ `3. Stripe Bank Payouts Connected` ➔ `4. Storefront Page Submitted & Published`. Every completed step triggers an Admin notification.
2. **1-Click Stripe Connect Express Onboarding (`/portal/retailer/payouts`):**
   - Implement a Server Action using the Stripe SDK (`stripe.accounts.create({ type: 'express' })` and `stripe.accountLinks.create(...)`) so the `RTL` user clicks **"Connect Bank Account (Automated Payouts)"**, completes KYC/bank linking on Stripe's hosted onboarding flow, and returns to `/portal/retailer/payouts?connected=true`.
   - Display live cards for: **30-Day Pending Clearance Balance**, **Lifetime Paid Out**, and **Next Automated Payout Date**.
3. **Scoped Single-Page Tiptap Studio (`/portal/retailer/storefront`):**
   - Binds our Tiptap editor strictly to the user's single `affiliate_pages.draft_content` JSONB column.
   - Includes Bio & Avatar uploader + custom Tiptap `/promote` slash-command block (`AffiliateProductGrid`) allowing the affiliate to pick products from the store catalog to showcase.
   - **"Submit for Admin Approval" Button:** Sets `approval_status = 'PENDING_REVIEW'` while keeping their previously approved `published_content` live.

---

## 🧠 MILESTONE 4: Hard-Sandboxed Cortex AI Copilot for `RTL` Users (`/api/affiliates/cortex`)
Give `RTL` users access to Cortex AI inside `/portal/retailer/storefront` to write their bio and build their Tiptap page, while enforcing **strict architectural isolation**:

1. **Dedicated Scoped Endpoint (`/api/affiliates/cortex/route.ts`):**
   - **NEVER** allow `RTL` users to call the admin `/api/cortex` or `/api/mcp` endpoints. Verify `user.role === 'RTL'` (or `'ADMIN'`).
   - **Zero Global Tools:** Do NOT import or register `query_site_analytics`, `update_navigation`, `get_database_schema`, or any `orders`/`cms_pages` tools in this route. If an `RTL` user asks about monthly store sales, order counts, or modifying other site pages, the model has zero access and must politely decline, stating it is scoped exclusively to their Partner Storefront.
2. **Strictly 3 Allowed Constrained-Decoding Tools (Zod-Validated JSONB):**
   - `generate_retailer_bio`: Takes the user's background notes and outputs a high-converting Ambassador Bio (`bio`) and SEO `meta_description` for their profile.
   - `generate_storefront_section`: Uses constrained JSONB decoding to generate valid NextBlock Tiptap JSONB nodes (headings, paragraphs, callouts, free Unsplash/Pexels stock image placeholders, and `AffiliateProductGrid` nodes populated only from active public products) directly into their `affiliate_pages.draft_content`.
   - `rewrite_storefront_copy`: Rewrites or polishes selected text inside their Tiptap editor for better conversion and readability.

---

## 🛡️ MILESTONE 5: Admin Collabs Command Center, Tier CRUD & Visual Diff Approval (`/cms/affiliates`)
Build the Admin management suite at `/cms/affiliates`:

1. **Affiliate Tiers CRUD (`/cms/affiliates/tiers`):**
   - Full CRUD UI allowing the Admin to edit the 4 pre-seeded tiers (`10%`, `20%`, `35%`, `50%`) or create new ones.
   - Admin can edit: **Tier Name**, **Commission %**, **Cookie Duration (default 30d)**, **Clearance Hold (default 30d)**, **Max Ambassadors Cap**, **Limited-Time Promo Badge**, and **Default Signup Tier toggle**.
2. **Page Approval Queue with Side-by-Side Visual Diff (`/cms/affiliates/approvals`):**
   - Shows all `PENDING_REVIEW` affiliate pages with a visual diff comparing `published_content` vs `draft_content` and the promoted products list.
   - **1-Click "Approve & Publish":** Copies `draft_content` ➔ `published_content`, sets `approval_status = 'PUBLISHED'`, revalidates cache, and emails/notifies the affiliate.
   - **"Request Changes":** Saves `admin_feedback_note`, sets `approval_status = 'CHANGES_REQUESTED'`, and notifies the affiliate.
3. **Automated Payouts Ledger (`/cms/affiliates/payouts`):**
   - Read-only oversight table showing `PENDING_CLEARANCE` (with 30-day countdown), `CLEARED`, `PAID` (with Stripe Transfer ID), and `VOIDED_REFUND` commissions, plus a manual "Retry Failed Transfer" button if platform balance ever needs topping up.

---

## 🔔 MILESTONE 6: Lifecycle Notification Engine (`system_alerts` + Dynamic SMTP)
Create `notifyAffiliateLifecycle()` wired into `system_alerts` and our `cms_settings` SMTP mailer:
- **Notify Admin on Every Onboarding Step:**
  1. `SIGNED_UP` (with tier name & remaining 50% spots)
  2. `PROFILE_COMPLETED`
  3. `PAYOUT_CONFIGURED` (Stripe Connect Express verified)
  4. `PAGE_SUBMITTED` (with direct link to `/cms/affiliates/approvals`)
- **Notify Affiliate (`RTL`) on:**
  1. `PAGE_PUBLISHED` (Celebratory email + live link `/partners/[handle]` + social share buttons)
  2. `CHANGES_REQUESTED` (Includes Admin feedback note)
  3. `COMMISSION_EARNED` (*"You just earned 50% ($X) — clears in 30 days!"*)
  4. `PAYOUT_SENT` (*"Your automated payout of $X has been sent to your bank via Stripe!"*)

---

## ⚡ MILESTONE 7: Co-Branded Storefront (`/partners/[handle]`), 30-Day Edge Attribution, Dual Webhooks & Automated Payout Cron
1. **Public Co-Branded Storefront (`app/(public)/partners/[handle]/page.tsx`):**
   - RSC page rendering `affiliate_pages.published_content` with 100/100 Lighthouse performance and an auto-generated `opengraph-image.tsx` social card.
   - **Dropshipping-Proof Server Binding:** Every product card on `/partners/[handle]` embeds `affiliate_id` directly into the server checkout payload so attribution works even if cookies are blocked.
2. **Next.js 16 Edge Middleware (30-Day Cookie):**
   - Intercepts `?ref=[handle]` and `/partners/[handle]`, increments `total_clicks`, and sets an HTTP-only first-party cookie `nb_affiliate_ref` with `maxAge: 30 * 24 * 60 * 60` (30 days, or dynamically from `tier.cookie_duration_days`).
3. **Stripe & Freemius Webhook Attribution + 30-Day Clearance:**
   - **Stripe (`checkout.session.completed`) & Freemius (`payment.created` / `license.created`):** Reads `affiliate_id` from metadata/custom payload, snapshots the affiliate's current `tier.commission_percentage`, and inserts a row into `affiliate_commissions` with `status = 'PENDING_CLEARANCE'` and `clears_at = NOW() + INTERVAL '30 days'`.
   - **Refund Clawback (`charge.refunded` / `payment.refunded`):** Automatically marks any matching `PENDING_CLEARANCE` commission as `VOIDED_REFUND`.
4. **Automated Stripe Connect Payout Cron (`/api/affiliates/cron/payouts`):**
   - Runs daily (via Vercel Cron / GitHub Actions). Queries all `affiliate_commissions` where `status = 'PENDING_CLEARANCE'` and `clears_at <= NOW()`, groups by `affiliate_id`, executes `stripe.transfers.create({ amount, currency, destination: stripe_connect_account_id })`, marks commissions as `'PAID'`, logs a row in `affiliate_payouts`, and sends the `PAYOUT_SENT` email.
5. **Sandbox Key Support:**
   - Add `FREEMIUS_AFFILIATES_SANDBOX_KEY` support and seed a demo 50% Founding Ambassador storefront in our 15-minute public sandbox on `nextblock.dev`.