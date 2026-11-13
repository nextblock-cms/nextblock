import 'server-only';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AFFILIATE_CMS_APPROVALS_PATH } from '@nextblock-cms/affiliates';
import { Button } from '@nextblock-cms/ui';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import {
  loadAffiliateApprovalQueue,
  loadAffiliatePartnerEmails,
  loadAffiliateStorefrontsAdmin,
  parseAffiliateAdminPage,
  parseAffiliateAdminPageSize,
  toAffiliateAdminClient,
  type AffiliateApprovalQueueItem,
  type AffiliateRecentReviewItem,
  type AffiliateStorefrontAdminItem,
} from '../../../../lib/affiliates/admin-data';
import { getAffiliatePartnerEmailSubject } from '../../../../lib/affiliates/partner-contact';
import TablePagination from '../../components/TablePagination';
import { AffiliateLoadErrorCard, AffiliatePageHeading } from '../components/AdminCards';
import { AffiliatesSubnav } from '../components/AffiliatesSubnav';
import { formatAdminDate, formatAdminDateTime, formatAdminRelative } from '../components/format';
import { PartnerEmailActions } from '../components/PartnerEmailActions';
import { PARTNERS_LOCKED_NOTE_ID, PartnersLockedNote } from '../components/PartnersLockedNote';
import { PartnerStatusControls } from '../components/PartnerStatusControls';
import {
  AffiliatePageStatusBadge,
  AffiliatePartnerStatusBadge,
  AffiliateStorefrontStateBadge,
  AffiliateTierBadge,
} from '../components/StatusBadges';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Storefront Approvals | NextBlock™ CMS',
};

/** `?storefronts=` / `?storefrontsPageSize=`: the Storefronts list pages on its own (the queue uses `page`). */
const STOREFRONTS_PAGE_PARAM = 'storefronts';
const STOREFRONTS_PAGE_SIZE_PARAM = 'storefrontsPageSize';
/** TablePagination leaves the page size out of the address at its default. */
const DEFAULT_PAGE_SIZE = 25;

/** Underlined at rest: inside a sentence a link must not differ from the text by colour alone. */
const INLINE_LINK_CLASS =
  'font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** This screen's address for the given pages (only this screen's own parameters, defaults left out). */
function approvalsHref(query: { page?: number; pageSize?: number; storefronts?: number; storefrontsPageSize?: number }): string {
  const search = new URLSearchParams();
  if (query.page && query.page > 1) search.set('page', String(query.page));
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE) search.set('pageSize', String(query.pageSize));
  if (query.storefronts && query.storefronts > 1) search.set(STOREFRONTS_PAGE_PARAM, String(query.storefronts));
  if (query.storefrontsPageSize && query.storefrontsPageSize !== DEFAULT_PAGE_SIZE) {
    search.set(STOREFRONTS_PAGE_SIZE_PARAM, String(query.storefrontsPageSize));
  }
  const text = search.toString();
  return `${AFFILIATE_CMS_APPROVALS_PATH}${text ? `?${text}` : ''}`;
}

function logLoadFailure(what: string, error: unknown): void {
  console.error(`[affiliates] ${what} failed to load`, {
    code: error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null,
  });
}

/**
 * The review queue (every storefront waiting for approval, oldest submission first), the last
 * reviews, and every storefront that has been published, with pause / resume, email and a link to
 * its review page. Handles are plain text: no admin screen links `/partners/<handle>` (an admin's
 * click would set the referral cookie).
 */
export default async function AffiliateApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase } = await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  const params = await searchParams;
  const page = parseAffiliateAdminPage(params['page']);
  const pageSize = parseAffiliateAdminPageSize(params['pageSize']);
  const storefrontsPage = parseAffiliateAdminPage(params[STOREFRONTS_PAGE_PARAM]);
  const storefrontsPageSize = parseAffiliateAdminPageSize(params[STOREFRONTS_PAGE_SIZE_PARAM]);
  const db = toAffiliateAdminClient(supabase);

  type QueueData = { items: AffiliateApprovalQueueItem[]; total: number; recentlyReviewed: AffiliateRecentReviewItem[] };
  type StorefrontsData = { rows: AffiliateStorefrontAdminItem[]; total: number };
  const [queue, storefronts] = await Promise.all([
    loadAffiliateApprovalQueue(db, { page, pageSize }).catch((error: unknown): QueueData | null => {
      logLoadFailure('approval queue', error);
      return null;
    }),
    loadAffiliateStorefrontsAdmin(db, { page: storefrontsPage, pageSize: storefrontsPageSize }).catch(
      (error: unknown): StorefrontsData | null => {
        logLoadFailure('storefront list', error);
        return null;
      }
    ),
  ]);
  // Partner addresses live in auth.users: one lookup per visible row, 10 at a time.
  const [emails, emailSubject] = await Promise.all([
    loadAffiliatePartnerEmails(db, [
      ...(queue?.items ?? []).map((item) => item.userId),
      ...(storefronts?.rows ?? []).map((row) => row.userId),
    ]),
    getAffiliatePartnerEmailSubject(),
  ]);
  // As loaded: an address, null (no usable address) or undefined (the lookup failed).
  const emailOf = (userId: string | null) => (userId ? emails[userId] : undefined);
  // The public sandbox's demo partners are shared: pause and resume render disabled there.
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  // A stale page number (the lists shrink with reviews and removals): no rows, but some exist.
  const queuePastEnd = queue !== null && queue.items.length === 0 && queue.total > 0 && page > 1;
  const storefrontsPastEnd =
    storefronts !== null && storefronts.rows.length === 0 && storefronts.total > 0 && storefrontsPage > 1;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="approvals" pendingApprovals={queue?.total ?? 0} />
      <AffiliatePageHeading
        title="Storefront approvals"
        description="Partners submit their storefront for review. Nothing they write is public until you approve it; the previously approved version stays live meanwhile."
      />

      {queue === null ? (
        <AffiliateLoadErrorCard what="approval queue" />
      ) : (
        <>
          <section aria-labelledby="affiliate-queue-heading" className="space-y-3">
            <h3 id="affiliate-queue-heading" className="text-lg font-semibold text-foreground">
              Waiting for review ({queue.total})
            </h3>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-left text-sm">
                  <caption className="sr-only">Storefronts waiting for review, oldest first</caption>
                  <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Partner</th>
                      <th scope="col" className="px-4 py-3 font-medium">Tier</th>
                      <th scope="col" className="px-4 py-3 font-medium">Submitted</th>
                      <th scope="col" className="px-4 py-3 font-medium">Kind</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        <span className="sr-only">Review</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {queue.items.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                          {queuePastEnd ? (
                            <>
                              This page is past the last storefront waiting for review.{' '}
                              <Link
                                href={approvalsHref({ pageSize, storefronts: storefrontsPage, storefrontsPageSize })}
                                className={INLINE_LINK_CLASS}
                              >
                                Go to the first page
                              </Link>
                            </>
                          ) : (
                            'Nothing to review. Submitted storefronts appear here.'
                          )}
                        </td>
                      </tr>
                    ) : (
                      queue.items.map((item) => (
                        <tr key={item.pageId} className="align-top">
                          <td className="px-4 py-3">
                            <p className="font-medium text-foreground">{item.displayName}</p>
                            <p className="text-xs text-muted-foreground">@{item.handle}</p>
                            {item.title ? <p className="mt-1 max-w-sm truncate text-xs text-muted-foreground">{item.title}</p> : null}
                            <div className="mt-2">
                              <PartnerEmailActions email={emailOf(item.userId)} subject={emailSubject} handle={item.handle} />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {item.tierName ? <AffiliateTierBadge name={item.tierName} color={item.tierBadgeColor} /> : '—'}
                            {item.partnerStatus === 'SUSPENDED' ? (
                              <div className="mt-1">
                                <AffiliatePartnerStatusBadge status="SUSPENDED" />
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <time dateTime={item.submittedAt ?? undefined} title={formatAdminDateTime(item.submittedAt)}>
                              {formatAdminRelative(item.submittedAt)}
                            </time>
                            <p className="text-xs text-muted-foreground">Version {item.draftVersion}</p>
                          </td>
                          <td className="px-4 py-3">
                            {item.isFirstPublication ? (
                              <span className="font-medium text-foreground">First publication</span>
                            ) : (
                              // A paused partner's storefront is offline: it is no live storefront.
                              <span className="text-muted-foreground">
                                {item.partnerStatus === 'SUSPENDED' ? 'Update to a paused storefront' : 'Update to a live storefront'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button asChild size="sm">
                              <Link href={`${AFFILIATE_CMS_APPROVALS_PATH}/${item.pageId}`} aria-label={`Review the storefront of @${item.handle}`}>
                                Review
                              </Link>
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {queue.total > pageSize && !queuePastEnd ? (
                <TablePagination
                  currentPage={page}
                  pageSize={pageSize}
                  totalCount={queue.total}
                  basePath={AFFILIATE_CMS_APPROVALS_PATH}
                  itemLabel="storefronts"
                />
              ) : null}
            </div>
          </section>

          {queue.recentlyReviewed.length > 0 ? (
            <section aria-labelledby="affiliate-recent-heading" className="space-y-3">
              <h3 id="affiliate-recent-heading" className="text-lg font-semibold text-foreground">
                Recently reviewed
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {queue.recentlyReviewed.map((item) => (
                  <li key={item.pageId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div>
                      <Link
                        href={`${AFFILIATE_CMS_APPROVALS_PATH}/${item.pageId}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.displayName}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">@{item.handle}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* A paused partner's published storefront is offline: it does not read "Published". */}
                      {item.partnerStatus === 'SUSPENDED' && item.status === 'PUBLISHED' ? null : (
                        <AffiliatePageStatusBadge status={item.status} />
                      )}
                      {item.partnerStatus === 'SUSPENDED' ? <AffiliatePartnerStatusBadge status="SUSPENDED" /> : null}
                      <time dateTime={item.reviewedAt} title={formatAdminDateTime(item.reviewedAt)} className="text-xs text-muted-foreground">
                        {formatAdminRelative(item.reviewedAt)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <section aria-labelledby="affiliate-storefronts-heading" className="space-y-3">
        <div className="space-y-1">
          <h3 id="affiliate-storefronts-heading" className="text-lg font-semibold text-foreground">
            Storefronts{storefronts ? ` (${storefronts.total})` : ''}
          </h3>
          <p className="text-sm text-muted-foreground">
            Every storefront that has been published, newest approval first. Pausing a partner takes their storefront offline
            and stops their referral links from earning until you resume them.
          </p>
        </div>
        {isSandbox ? <PartnersLockedNote /> : null}
        {storefronts === null ? (
          <AffiliateLoadErrorCard what="storefront list" />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <caption className="sr-only">Published storefronts, newest approval first</caption>
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Partner</th>
                    <th scope="col" className="px-4 py-3 font-medium">Status</th>
                    <th scope="col" className="px-4 py-3 font-medium">Last published</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {storefronts.rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                        {storefrontsPastEnd ? (
                          <>
                            This page is past the last storefront.{' '}
                            <Link href={approvalsHref({ page, pageSize, storefrontsPageSize })} className={INLINE_LINK_CLASS}>
                              Go to the first page
                            </Link>
                          </>
                        ) : (
                          'No storefront has been published yet. Approved storefronts appear here.'
                        )}
                      </td>
                    </tr>
                  ) : (
                    storefronts.rows.map((row) => (
                      <tr key={row.pageId} className="align-top">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{row.displayName}</p>
                          {/* Plain text on purpose: an admin's click on /partners/<handle> would set the referral cookie. */}
                          <p className="text-xs text-muted-foreground">@{row.handle}</p>
                        </td>
                        <td className="px-4 py-3">
                          <AffiliateStorefrontStateBadge state={row.state} />
                          {row.state === 'paused' && row.suspendedReason ? (
                            <p className="mt-1 max-w-xs whitespace-pre-line break-words text-xs text-red-800 dark:text-red-300">
                              {row.suspendedReason}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <time dateTime={row.publishedAt ?? undefined} title={formatAdminDateTime(row.publishedAt)}>
                            {formatAdminDate(row.publishedAt)}
                          </time>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {row.partnerStatus ? (
                              <PartnerStatusControls
                                affiliateId={row.affiliateId}
                                handle={row.handle}
                                displayName={row.displayName}
                                status={row.partnerStatus}
                                isApproved={row.isApproved}
                                lockedNoteId={isSandbox ? PARTNERS_LOCKED_NOTE_ID : undefined}
                              />
                            ) : null}
                            <PartnerEmailActions email={emailOf(row.userId)} subject={emailSubject} handle={row.handle} />
                            <Button asChild size="sm" variant="outline">
                              <Link
                                href={`${AFFILIATE_CMS_APPROVALS_PATH}/${row.pageId}`}
                                aria-label={`Open review for @${row.handle}`}
                              >
                                Open review
                              </Link>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {(storefronts.total > storefrontsPageSize || storefrontsPage > 1) && !storefrontsPastEnd ? (
              <TablePagination
                currentPage={storefrontsPage}
                pageSize={storefrontsPageSize}
                totalCount={storefronts.total}
                basePath={AFFILIATE_CMS_APPROVALS_PATH}
                itemLabel="storefronts"
                pageParam={STOREFRONTS_PAGE_PARAM}
                pageSizeParam={STOREFRONTS_PAGE_SIZE_PARAM}
              />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
