import 'server-only';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Info } from 'lucide-react';
import {
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_PARTNERS_PATH,
  StorefrontRenderer,
  type StorefrontRenderProductGridArgs,
} from '@nextblock-cms/affiliates';
import { requireCmsAdmin } from '../../../../../lib/auth/cms-actor';
import { checkAffiliateUserDeletion, type AffiliateDeletionCheck } from '../../../../../lib/affiliates/affiliate-deletion-guard';
import {
  describeAffiliateStorefrontState,
  loadAffiliateApprovalReview,
  loadAffiliatePartnerEmails,
  toAffiliateAdminClient,
  type AffiliateApprovalReviewData,
  type AffiliateReviewFieldChange,
  type AffiliateReviewProduct,
} from '../../../../../lib/affiliates/admin-data';
import { getAffiliatePartnerEmailSubject } from '../../../../../lib/affiliates/partner-contact';
import JsonDiffView from '../../../revisions/JsonDiffView';
import { AffiliateLoadErrorCard, AffiliatePageHeading } from '../../components/AdminCards';
import { AffiliatesSubnav } from '../../components/AffiliatesSubnav';
import { formatAdminDate, formatAdminDateTime, formatAdminRate, formatAdminRelative } from '../../components/format';
import { AFFILIATE_PAGE_STATUS_LABEL } from '../../components/labels';
import { PartnerEmailActions } from '../../components/PartnerEmailActions';
import { PARTNERS_LOCKED_NOTE_ID, PartnersLockedNote } from '../../components/PartnersLockedNote';
import { PartnerStatusControls } from '../../components/PartnerStatusControls';
import { PartnerTierControl } from '../../components/PartnerTierControl';
import { RemovePartnerControl } from '../../components/RemovePartnerControl';
import { buildPartnerTierOptions } from '../../components/tier-options';
import { ReviewActions } from '../../components/ReviewActions';
import { ReviewProductChip } from '../../components/ReviewProductChip';
import {
  AffiliatePageStatusBadge,
  AffiliatePartnerStatusBadge,
  AffiliateStorefrontStateBadge,
  AffiliateTierBadge,
} from '../../components/StatusBadges';
import { isAffiliatesProgramActive } from '../../../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Review Storefront | NextBlock™ CMS',
};

const MISSING_PRODUCT = (id: string): AffiliateReviewProduct => ({ id, title: null, imageUrl: null, status: 'missing' });

/** Product grids of the preview, as chips (the CMS has no storefront product cards). */
function productGridRenderer(products: Record<string, AffiliateReviewProduct>) {
  return function renderReviewProductGrid({ productIds, title, columns }: StorefrontRenderProductGridArgs) {
    return (
      <div className="my-6 rounded-lg border border-dashed border-border bg-muted/20 p-3 not-italic">
        <p className="text-xs font-medium text-muted-foreground">
          Product grid{title ? `: ${title}` : ''} · {productIds.length} {productIds.length === 1 ? 'product' : 'products'} · {columns}{' '}
          columns
        </p>
        {productIds.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {productIds.map((id) => (
              <li key={id}>
                <ReviewProductChip product={products[id] ?? MISSING_PRODUCT(id)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No products picked (the grid is hidden on the storefront).</p>
        )}
      </div>
    );
  };
}

function ChangedMark({ changed }: { changed: boolean }) {
  return changed ? (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-700/30 dark:text-amber-200">
      Changed
    </span>
  ) : (
    <span className="text-[11px] text-muted-foreground">Unchanged</span>
  );
}

function FieldValue({ value, empty }: { value: string | null; empty: string }) {
  return value ? (
    <p className="whitespace-pre-line break-words text-sm text-foreground">{value}</p>
  ) : (
    <p className="text-sm italic text-muted-foreground">{empty}</p>
  );
}

function FieldChangeRows({ changes, liveEmpty }: { changes: AffiliateReviewFieldChange[]; liveEmpty: string }) {
  return (
    <dl className="divide-y divide-border">
      {changes.map((change) => (
        <div key={change.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-sm font-medium text-foreground">{change.label}</dt>
            <ChangedMark changed={change.changed} />
          </div>
          <dd className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Live</p>
              <FieldValue value={change.live} empty={liveEmpty} />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Proposed</p>
              <FieldValue value={change.proposed} empty="(empty)" />
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Why "Remove partner" is not offered, from the ledger check (null when the partner can be
 * removed). A partner who is already paused is told to stay paused, not to be paused.
 */
function removalBlockedReason(check: AffiliateDeletionCheck, name: string, status: 'ACTIVE' | 'SUSPENDED'): string | null {
  if (check.kind === 'allowed') return null;
  if (check.kind === 'blocked') {
    return status === 'SUSPENDED'
      ? `${name} has commission or payout history, so they can't be removed. Keep them paused to keep those records.`
      : `${name} has commission or payout history, so they can't be removed: pause them instead to keep those records.`;
  }
  return 'Their commission and payout records could not be checked, so removal is unavailable right now. Reload the page to try again.';
}

function AvatarPreview({ src, label }: { src: string | null; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} width={48} height={48} loading="lazy" decoding="async" className="h-12 w-12 rounded-full border border-border object-cover" />
      ) : (
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-border text-[10px] text-muted-foreground">
          None
        </span>
      )}
    </div>
  );
}

/**
 * One submitted storefront, side by side with what is live: the block diff (new blocks get a green
 * bar, changed ones amber), the profile / title / featured-product changes, everything the
 * sanitizer will strip, and the Approve & Publish / Request Changes decision. Both documents are
 * sanitized exactly the way publication will sanitize them, so the preview is what goes live.
 * The Partner card shows whether the storefront is live, the partner's sign-in address (Email,
 * Copy), their tier and since when, Change tier, Pause / Resume, and Remove partner (offered only
 * while their ledger is empty).
 */
export default async function AffiliateApprovalReviewPage({ params }: { params: Promise<{ pageId: string }> }) {
  const { supabase } = await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  const { pageId } = await params;
  const db = toAffiliateAdminClient(supabase);
  let review: AffiliateApprovalReviewData | null = null;
  let failed = false;
  try {
    review = await loadAffiliateApprovalReview(db, pageId);
  } catch (error) {
    failed = true;
    console.error('[affiliates] storefront review failed to load', {
      code: error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null,
    });
  }

  if (failed) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <AffiliatesSubnav active="approvals" />
        <AffiliateLoadErrorCard what="storefront review" />
      </div>
    );
  }
  if (!review) notFound();

  const { page, profile, tier, diff } = review;
  // The Partner card: the sign-in address (auth.users), the email subject, and whether the
  // partner's ledger allows "Remove partner" (the action checks again after pausing them).
  const [emails, emailSubject, ledger] = await Promise.all([
    loadAffiliatePartnerEmails(db, [profile.user_id]),
    getAffiliatePartnerEmailSubject(),
    checkAffiliateUserDeletion(db, profile.user_id),
  ]);
  // As loaded: an address, null (no usable address) or undefined (the lookup failed).
  const partnerEmail = emails[profile.user_id];
  const partnerName = profile.display_name.trim() || `@${profile.handle}`;
  const describedState = describeAffiliateStorefrontState(profile);
  // Live needs a published document too (`get_affiliate_storefront` serves nothing without one).
  const storefrontState = describedState === 'live' && !review.publishedDoc ? 'unpublished' : describedState;
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const lockedNoteId = isSandbox ? PARTNERS_LOCKED_NOTE_ID : undefined;
  const tierOptions = buildPartnerTierOptions(review.tiers);
  // In this tier since the last move (02035 stamps tier_changed_at), else since sign-up.
  const tierSince = formatAdminDate(profile.tier_changed_at ?? profile.created_at);
  const isPending = page.approval_status === 'PENDING_REVIEW';
  const isFirstPublication = !profile.first_published_at;
  const renderProductGrid = productGridRenderer(review.products);
  const approveBlockedReason =
    profile.status !== 'ACTIVE'
      ? 'This partner is paused. Resume them in the Partner card below before publishing their storefront.'
      : review.draftIsEmpty
        ? 'The proposed storefront has no visible content after sanitizing, so there is nothing to publish. Request changes instead.'
        : null;
  const addedCount = diff.statuses.filter((status) => status === 'added').length;
  const changedCount = diff.statuses.filter((status) => status === 'changed').length;
  const featuredChanged = review.featured.added.length > 0 || review.featured.removed.length > 0;
  const productOf = (id: string) => review.products[id] ?? MISSING_PRODUCT(id);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="approvals" />
      <Link
        href={AFFILIATE_CMS_APPROVALS_PATH}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All approvals
      </Link>

      <AffiliatePageHeading
        title={`Review @${profile.handle}`}
        description={`${profile.display_name} · public address ${AFFILIATE_PARTNERS_PATH}/${profile.handle}`}
      />

      <section aria-labelledby="affiliate-review-summary-heading" className="grid gap-6 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-3">
          <h3 id="affiliate-review-summary-heading" className="sr-only">
            Submission
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <AffiliatePageStatusBadge status={page.approval_status} />
            <AffiliatePartnerStatusBadge status={profile.status} />
            {tier ? <AffiliateTierBadge name={tier.name} color={tier.badge_color} /> : null}
            <span className="text-sm text-muted-foreground">
              {isFirstPublication
                ? 'First publication: approving also lets this partner earn.'
                : profile.status === 'SUSPENDED'
                  ? 'Update to a paused storefront.'
                  : 'Update to a live storefront.'}
            </span>
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Submitted</dt>
              <dd>
                <time dateTime={page.submitted_at ?? undefined} title={formatAdminDateTime(page.submitted_at)}>
                  {page.submitted_at ? formatAdminRelative(page.submitted_at) : '—'}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Draft version</dt>
              <dd className="tabular-nums">{page.draft_version}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last published</dt>
              <dd>{page.published_at ? formatAdminDateTime(page.published_at) : 'Never'}</dd>
            </div>
          </dl>
          {page.admin_feedback_note && !isPending ? (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">Your last note to the partner</p>
              <p className="mt-1 whitespace-pre-line break-words">{page.admin_feedback_note}</p>
            </div>
          ) : null}
        </div>
        <div className="lg:max-w-sm">
          {isPending ? (
            <ReviewActions
              pageId={page.id}
              handle={profile.handle}
              draftVersion={page.draft_version}
              profileFingerprint={review.profileFingerprint}
              canReview
              approveBlockedReason={approveBlockedReason}
              isFirstPublication={isFirstPublication}
            />
          ) : (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Not waiting for review (status: {AFFILIATE_PAGE_STATUS_LABEL[page.approval_status]}). When the partner submits
                it from their portal, this page offers the decision.
              </span>
            </p>
          )}
        </div>
      </section>

      <section
        aria-labelledby="affiliate-review-partner-heading"
        className="space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="affiliate-review-partner-heading" className="text-base font-semibold text-foreground">
            Partner
          </h3>
          <AffiliateStorefrontStateBadge state={storefrontState} />
        </div>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Storefront</dt>
            <dd>
              {storefrontState === 'paused'
                ? 'Paused: offline, and their referral links do not earn.'
                : storefrontState === 'live'
                  ? `Live since ${formatAdminDate(profile.first_published_at)}.`
                  : 'Not published yet.'}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Email</dt>
            <dd className="mt-1">
              <PartnerEmailActions email={partnerEmail} subject={emailSubject} handle={profile.handle} showAddress />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tier</dt>
            <dd>
              {tier ? `${tier.name} (${formatAdminRate(tier.commission_percentage)})` : 'Unknown tier'}
              <span className="block text-xs text-muted-foreground">Tier since {tierSince}</span>
            </dd>
          </div>
        </dl>
        {profile.status === 'SUSPENDED' && profile.suspended_reason ? (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Reason for the pause (the partner sees it)</p>
            <p className="mt-1 whitespace-pre-line break-words">{profile.suspended_reason}</p>
          </div>
        ) : null}
        {isSandbox ? <PartnersLockedNote /> : null}
        <div className="flex flex-wrap items-start gap-3">
          <PartnerTierControl
            affiliateId={profile.id}
            handle={profile.handle}
            displayName={profile.display_name}
            tierId={profile.tier_id}
            tiers={tierOptions}
            lockedNoteId={lockedNoteId}
          />
          <PartnerStatusControls
            affiliateId={profile.id}
            handle={profile.handle}
            displayName={profile.display_name}
            status={profile.status}
            isApproved={Boolean(profile.first_published_at)}
            lockedNoteId={lockedNoteId}
          />
          <RemovePartnerControl
            affiliateId={profile.id}
            handle={profile.handle}
            displayName={profile.display_name}
            blockedReason={removalBlockedReason(ledger, partnerName, profile.status)}
            lockedNoteId={lockedNoteId}
            afterRemoveHref={AFFILIATE_CMS_APPROVALS_PATH}
          />
        </div>
      </section>

      {review.draftIssues.length > 0 ? (
        <section
          aria-labelledby="affiliate-review-issues-heading"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <h3 id="affiliate-review-issues-heading" className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            The sanitizer will change the draft before publishing
          </h3>
          <p className="mt-1 text-sm">
            These parts are not allowed on storefronts and are already left out of the preview below:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {review.draftIssues.map((issue, index) => (
              <li key={`${index}-${issue}`} className="break-words">
                {issue}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="affiliate-review-seo-heading" className="space-y-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
          <h3 id="affiliate-review-seo-heading" className="text-base font-semibold text-foreground">
            Page title and description
          </h3>
          <FieldChangeRows changes={review.seoChanges} liveEmpty="(none published)" />
        </section>

        <section aria-labelledby="affiliate-review-profile-heading" className="space-y-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
          <h3 id="affiliate-review-profile-heading" className="text-base font-semibold text-foreground">
            Public profile
          </h3>
          <p className="text-xs text-muted-foreground">
            The storefront shows the profile as it was when you last approved it; approving publishes the version below.
          </p>
          <div className="flex items-center gap-6">
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Live avatar</p>
              <AvatarPreview src={review.liveAvatarUrl} label={`Live avatar of @${profile.handle}`} />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Proposed avatar</p>
              <AvatarPreview src={review.proposedAvatarUrl} label={`Proposed avatar of @${profile.handle}`} />
            </div>
          </div>
          <FieldChangeRows changes={review.profileChanges.filter((change) => change.key !== 'avatar')} liveEmpty="(none published)" />
        </section>
      </div>

      <section aria-labelledby="affiliate-review-featured-heading" className="space-y-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="affiliate-review-featured-heading" className="text-base font-semibold text-foreground">
            Featured products
          </h3>
          <ChangedMark changed={featuredChanged} />
        </div>
        {review.featured.added.length === 0 && review.featured.removed.length === 0 && review.featured.kept.length === 0 ? (
          <p className="text-sm text-muted-foreground">No featured products.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {(
              [
                ['Added', review.featured.added],
                ['Removed', review.featured.removed],
                ['Kept', review.featured.kept],
              ] as const
            ).map(([label, ids]) => (
              <div key={label} className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {label} ({ids.length})
                </p>
                {ids.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {ids.map((id) => (
                      <li key={id}>
                        <ReviewProductChip product={productOf(id)} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="affiliate-review-content-heading" className="space-y-3">
        <div className="space-y-1">
          <h3 id="affiliate-review-content-heading" className="text-lg font-semibold text-foreground">
            Storefront content
          </h3>
          <p className="text-sm text-muted-foreground">
            In the proposed version, a green bar marks a new block and an amber bar a changed one.{' '}
            {addedCount} new, {changedCount} changed
            {diff.removedCount > 0 ? `, ${diff.removedCount} live ${diff.removedCount === 1 ? 'block' : 'blocks'} removed` : ''}.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="affiliate-review-live-heading" className="min-w-0 rounded-lg border border-border bg-card text-card-foreground">
            <h4 id="affiliate-review-live-heading" className="border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
              Live
            </h4>
            <div className="max-h-[56rem] overflow-y-auto px-4 pb-4">
              {review.publishedDoc ? (
                <StorefrontRenderer
                  doc={review.publishedDoc}
                  allowedImageOrigins={review.allowedImageOrigins}
                  siteOrigin={review.siteOrigin}
                  renderProductGrid={renderProductGrid}
                />
              ) : (
                <p className="py-6 text-sm text-muted-foreground">Nothing is published yet.</p>
              )}
            </div>
          </section>
          <section aria-labelledby="affiliate-review-proposed-heading" className="min-w-0 rounded-lg border border-primary/40 bg-card text-card-foreground">
            <h4 id="affiliate-review-proposed-heading" className="border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
              Proposed
            </h4>
            <div className="max-h-[56rem] overflow-y-auto px-4 pb-4">
              {review.draftIsEmpty ? (
                <p className="py-6 text-sm text-muted-foreground">The proposed storefront is empty.</p>
              ) : (
                <StorefrontRenderer
                  doc={review.draftDoc}
                  allowedImageOrigins={review.allowedImageOrigins}
                  siteOrigin={review.siteOrigin}
                  renderProductGrid={renderProductGrid}
                  highlight={diff.statuses}
                />
              )}
            </div>
          </section>
        </div>
      </section>

      <details className="group rounded-lg border border-border bg-card text-card-foreground">
        <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          Document diff (JSON)
        </summary>
        <div className="border-t border-border p-4">
          <JsonDiffView
            oldValue={JSON.stringify(review.publishedDoc ?? { type: 'doc', content: [] })}
            newValue={JSON.stringify(review.draftDoc)}
            leftTitle="Live"
            rightTitle="Proposed"
          />
        </div>
      </details>
    </div>
  );
}
