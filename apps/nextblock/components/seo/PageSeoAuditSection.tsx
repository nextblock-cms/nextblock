'use client';

/**
 * The page-level SEO audit, as it appears on the page and post edit screens.
 *
 * WHAT THIS IS FOR. `SeoAuditPanel` grades whatever document it is handed; this
 * component is the thing that decides *which* document that is on an edit screen
 * and how much room the result is allowed to take. It reads the shared
 * `PageSeoProvider` state — the live block array published by `BlockEditorArea`
 * and the meta title and description published by the page or post form — merges
 * them with `buildPageSeoDocument`, and hands the result to the panel at page
 * scope. That merge is the entire point of the feature: headings live both in
 * standalone `heading` blocks and inside a text block's HTML, and section blocks
 * carry more blocks in their columns, so "does this page have exactly one H1"
 * simply cannot be answered from inside one block editor.
 *
 * WHY IT IS COLLAPSED BY DEFAULT. The block editor is the reason anyone opens
 * this screen. A full analysis panel expanded above it would push the first
 * block below the fold on a laptop every time, which is a tax paid on every
 * edit for a report most sessions never read. Collapsed, the section is a single
 * row: the score, the number of findings, and a button. That row is enough to
 * decide whether the report is worth opening, which is all a summary owes you.
 *
 * WHY THE PANEL STAYS MOUNTED WHILE COLLAPSED. The summary row shows a live
 * score, and the only honest way to have one is to let the panel keep computing
 * it — so the collapsed state hides the detail with `hidden` rather than
 * unmounting the panel, and the panel reports each result back through
 * `onAuditChange`. Unmounting instead would either freeze the summary at its
 * last value or force this component to run a second, competing audit that could
 * disagree with the one behind the toggle.
 *
 * WHY THE DOCUMENT IS REBUILT ON A DELAY. `blocks` is a new array on every
 * keystroke in any block editor, and rebuilding the page document means walking
 * every block and parsing every rich-text body. Doing that during the render of
 * each keystroke would be pure waste, since only the last one is ever graded. The
 * rebuild is therefore deferred to the same trailing pause the panel already
 * waits for, which does mean the page score settles roughly two debounce
 * intervals after typing stops — a deliberate trade of latency nobody is watching
 * for work nobody needs.
 *
 * Rendering nothing without a provider is intentional, not defensive padding:
 * the same edit-screen components are reachable from the product editor, which
 * has no page-level audit, and `usePageSeo()` returning `null` is the supported
 * way that surface says so.
 */

import * as React from 'react';

import { Button } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import type { SeoAuditResult, SeoScoreBand } from '@nextblock-cms/utils/seo';
import { ChevronDown, ChevronUp, Gauge } from 'lucide-react';

import { useCortexAiActive } from '../../app/cms/components/CortexAiActiveContext';
import { usePageSeo } from '../../lib/seo/page-audit-context';
import { buildPageSeoDocument } from '../../lib/seo/page-document';
import { SEO_LIVE_AUDIT_DEBOUNCE_MS, SeoAuditPanel } from './SeoAuditPanel';

/**
 * Where the open/closed choice is remembered.
 *
 * Per-browser like the block editor's own panel toggle, and for the same reason:
 * it is a workspace preference in the family of a collapsed sidebar, not content,
 * and persisting it server-side would mean a write on every click.
 */
const PAGE_SEO_PANEL_STORAGE_KEY = 'nextblock_page_seo_audit_open';

/**
 * Badge colours for the collapsed summary, following the CMS convention: emerald
 * for fine, amber for a caution, red for a failure. `excellent` and `good` share
 * emerald because the distinction between them is carried by the number itself.
 */
const BAND_BADGE_STYLE: Record<SeoScoreBand, string> = {
  excellent: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  fair: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  poor: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

export interface PageSeoAuditSectionProps {
  className?: string;
}

export function PageSeoAuditSection({ className }: PageSeoAuditSectionProps) {
  const pageSeo = usePageSeo();
  const detailsId = React.useId();
  /**
   * Forwarded so the panel can explain where the one-click fixes went.
   *
   * There is no Fix button at page scope — a page has no single editor to write
   * a rewrite into — and the panel only says so when Cortex AI is actually
   * activated. Without this flag an activated install would show nothing at all
   * where a Fix button sits at block scope, which reads as a bug rather than as
   * a deliberate absence.
   */
  const isCortexAiActive = useCortexAiActive();

  // Read through optional chaining so every hook below runs unconditionally: the
  // "no provider" case is handled by returning null *after* the hooks, never by
  // skipping them, which would break the rules of hooks the moment a provider
  // appeared or disappeared above this component.
  const liveBlocks = pageSeo?.snapshot.blocks;

  const [audit, setAudit] = React.useState<SeoAuditResult | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [settledBlocks, setSettledBlocks] = React.useState<unknown[]>(() => liveBlocks ?? []);

  /**
   * Adopt the remembered preference once, after mount.
   *
   * Every access is wrapped because `localStorage` does not merely come back
   * empty in a private window or with site data blocked — the property access
   * itself throws, and an uncaught throw here would take the whole edit screen
   * down over a panel toggle. A first visit stays collapsed, which is the state
   * that keeps the block editor where the author expects to find it.
   */
  React.useEffect(() => {
    try {
      setIsOpen(window.localStorage.getItem(PAGE_SEO_PANEL_STORAGE_KEY) === 'true');
    } catch {
      setIsOpen(false);
    }
  }, []);

  const toggleOpen = React.useCallback(() => {
    setIsOpen((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(PAGE_SEO_PANEL_STORAGE_KEY, String(next));
      } catch {
        // The preference is a convenience; losing it is not worth an error.
      }
      return next;
    });
  }, []);

  // The deferred rebuild described in the module docblock. `liveBlocks` changes
  // identity on every keystroke anywhere in the page, so each change restarts
  // this timer and only the array that survives a pause is ever walked.
  React.useEffect(() => {
    if (liveBlocks === undefined) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSettledBlocks(liveBlocks);
    }, SEO_LIVE_AUDIT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [liveBlocks]);

  // Memoised because the document's identity is one of the panel's debounce
  // dependencies: a fresh object on every render would reset the panel's timer
  // forever and no score would ever appear.
  const pageDocument = React.useMemo(
    () =>
      buildPageSeoDocument(settledBlocks, {
        documentTitle: pageSeo?.snapshot.documentTitle,
        documentType: pageSeo?.snapshot.documentType,
      }),
    [settledBlocks, pageSeo?.snapshot.documentTitle, pageSeo?.snapshot.documentType],
  );

  const handleAuditChange = React.useCallback((next: SeoAuditResult | null) => {
    setAudit(next);
  }, []);

  if (!pageSeo) {
    return null;
  }

  const issueCount = audit?.issues.length ?? 0;
  const errorCount = audit?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  const summary = !audit
    ? 'Reading every block on this page…'
    : issueCount === 0
      ? 'No issues found across this page.'
      : `${issueCount} ${issueCount === 1 ? 'finding' : 'findings'} across this page` +
        (errorCount > 0 ? `, ${errorCount} of them ${errorCount === 1 ? 'an error' : 'errors'}.` : '.');

  return (
    <section className={cn('rounded-lg border bg-background', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <Gauge aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold mt-0">Page SEO analysis</h2>
            <p className="text-xs text-muted-foreground">{summary}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {audit && (
            /* The band's colour repeats what the number already says, so it is
               hidden from assistive technology and spelled out in the button's
               accessible name instead of being announced twice. */
            <span
              aria-hidden="true"
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
                BAND_BADGE_STYLE[audit.scoreBand]
              )}
            >
              {audit.score}/100
            </span>
          )}
          <Button
            aria-controls={detailsId}
            aria-expanded={isOpen}
            className="h-8 text-xs"
            onClick={toggleOpen}
            size="sm"
            type="button"
            variant="outline"
          >
            {isOpen ? (
              <ChevronUp aria-hidden="true" className="mr-1.5 h-4 w-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="mr-1.5 h-4 w-4" />
            )}
            {isOpen ? 'Hide SEO analysis' : 'Show SEO analysis'}
            <span className="sr-only">
              {audit ? ` — currently scoring ${audit.score} out of 100.` : ''}
            </span>
          </Button>
        </div>
      </div>

      {/*
        `hidden` rather than a conditional render: the panel has to stay mounted
        for the summary above to keep updating. Tailwind's `hidden` is
        `display: none`, so a collapsed section costs no layout and the block
        editor below it does not move.
      */}
      <div className={cn('border-t', !isOpen && 'hidden')} id={detailsId}>
        <SeoAuditPanel
          document={pageDocument}
          isCortexAiActive={isCortexAiActive}
          keyword={pageSeo.keyword}
          metaDescription={pageSeo.snapshot.metaDescription}
          metaTitle={pageSeo.snapshot.metaTitle}
          onAuditChange={handleAuditChange}
          onKeywordChange={pageSeo.setKeyword}
          scope="page"
        />
      </div>
    </section>
  );
}

export default PageSeoAuditSection;
