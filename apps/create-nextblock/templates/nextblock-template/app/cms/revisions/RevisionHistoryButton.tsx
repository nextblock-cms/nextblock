// apps/nextblock/app/cms/revisions/RevisionHistoryButton.tsx
"use client";

import { useEffect, useState, useTransition, Fragment } from 'react';
import { Button } from "@nextblock-cms/ui";
import { cn } from "@nextblock-cms/utils";
import { Spinner, Alert, AlertDescription } from "@nextblock-cms/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@nextblock-cms/ui";
import {
  listPageRevisions,
  listPostRevisions,
  listProductRevisions,
  restorePageVersion,
  restorePostVersion,
  restoreProductVersion,
  comparePageVersion,
  comparePostVersion,
  compareProductVersion,
} from './actions';
import { useRouter } from 'next/navigation';
import JsonDiffView from './JsonDiffView';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'react-hot-toast';

type ParentType = 'page' | 'post' | 'product';

interface RevisionHistoryButtonProps {
  parentType: ParentType;
  /** Pages and posts are keyed by bigint; products by uuid. */
  parentId: number | string;
}

type RevisionItem = {
  id: number;
  version: number;
  revision_type: 'snapshot' | 'diff';
  created_at: string;
  author_id: string | null;
  author?: { full_name?: string | null } | null;
  has_changes?: boolean;
};

type ListResult = { error: string } | { revisions: unknown[]; currentVersion: number | null; totalPages: number };
type RestoreResult = { error: string } | { success: true; version: number };
type CompareResult = { success: true; current: unknown; target: unknown } | { error: string };

/**
 * Exhaustive dispatch, one entry per parent type.
 *
 * Deliberately a lookup rather than an `if page / else` chain: with three parent types a
 * bare `else` silently routes products into the post actions, which type-checks cleanly
 * because both take an id and a version.
 */
const REVISION_API: Record<ParentType, {
  list: (id: any, page: number, start?: string, end?: string) => Promise<ListResult>;
  restore: (id: any, version: number) => Promise<RestoreResult>;
  compare: (id: any, version: number) => Promise<CompareResult>;
}> = {
  page: { list: listPageRevisions, restore: restorePageVersion, compare: comparePageVersion },
  post: { list: listPostRevisions, restore: restorePostVersion, compare: comparePostVersion },
  product: { list: listProductRevisions, restore: restoreProductVersion, compare: compareProductVersion },
};

import { Input } from "@nextblock-cms/ui";

export default function RevisionHistoryButton({ parentType, parentId }: RevisionHistoryButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revisions, setRevisions] = useState<RevisionItem[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [page, setPage] = useState(1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  const [totalPages, setTotalPages] = useState(0);
  
  const router = useRouter();
  const [compareLoading, setCompareLoading] = useState(false);
  const [activeCompareVersion, setActiveCompareVersion] = useState<number | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [leftText, setLeftText] = useState<string | null>(null);
  const [rightText, setRightText] = useState<string | null>(null);

  const api = REVISION_API[parentType];

  const loadRevisions = async (pageToLoad: number, start?: string, end?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.list(parentId, pageToLoad, start, end);

      if ('error' in res) {
        setError(res.error ?? 'Unknown error');
        setRevisions([]);
      } else {
        const newRevisions = res.revisions as unknown as RevisionItem[];
        setRevisions(newRevisions);
        setCurrentVersion((res as any).currentVersion ?? null);
        setTotalPages((res as any).totalPages ?? 0);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load revisions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setRevisions([]);
    setPage(1);
    setStartDate('');
    setEndDate('');
    loadRevisions(1, '', '');
  }, [open, parentId, parentType]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    loadRevisions(newPage, startDate, endDate);
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setStartDate(newVal);
    setPage(1);
    loadRevisions(1, newVal, endDate);
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setEndDate(newVal);
    setPage(1);
    loadRevisions(1, startDate, newVal);
  };

  const handleClearDates = () => {
    setStartDate('');
    setEndDate('');
    setPage(1);
    loadRevisions(1, '', '');
  };

  const handleRestore = (version: number) => {
    setMessage(null);
    setError(null);
    setRestoringVersion(version);
    startTransition(async () => {
      try {
        const res = await api.restore(parentId, version);
        if ('error' in res) {
          setError(res.error ?? 'Unknown error');
          toast.error(res.error ?? 'Failed to restore version');
          return;
        }
        setMessage(`Version ${version} restored as version ${res.version}.`);
        toast.success('Version restored successfully');
        router.refresh();
        setTimeout(() => setOpen(false), 800);
        if (parentType === 'product') {
          // The restore deleted the product's draft, but the edit page's draft flag
          // (ProductDraftFlagProvider) only ever latches on: without a reload the draft bar and the
          // visibility dialog kept offering the deleted draft, and its Publish failed.
          setTimeout(() => window.location.reload(), 800);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to restore version');
        toast.error(e instanceof Error ? e.message : 'Failed to restore version');
      } finally {
        setRestoringVersion(null);
      }
    });
  };

  const handleCompare = async (version: number) => {
    setError(null);
    setMessage(null);
    setActiveCompareVersion(version);
    setCompareLoading(true);
    try {
      const res = await api.compare(parentId, version);
      if ('error' in res) {
        setError(res.error);
        setLeftText(null);
        setRightText(null);
      } else {
        const left = JSON.stringify(res.current, null, 2);
        const right = JSON.stringify(res.target, null, 2);
        setLeftText(left);
        setRightText(right);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load comparison');
    } finally {
      setCompareLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>Revision History</Button>
      <DialogContent 
        className="max-w-2xl h-[95vh] overflow-y-auto flex flex-col"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center justify-between mr-8">
            <DialogTitle>Revision History</DialogTitle>
            <div className="flex items-center gap-2">
                 <span className="text-sm text-muted-foreground whitespace-nowrap">From:</span>
                 <Input 
                    type="date" 
                    className="w-auto h-8 text-sm px-2" 
                    value={startDate} 
                    onChange={handleStartDateChange} 
                 />
                 <span className="text-sm text-muted-foreground whitespace-nowrap">To:</span>
                 <Input 
                    type="date" 
                    className="w-auto h-8 text-sm px-2" 
                    value={endDate} 
                    onChange={handleEndDateChange} 
                 />
                 {(startDate || endDate) && (
                   <Button variant="ghost" size="sm" onClick={handleClearDates} className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground">
                     Clear
                   </Button>
                 )}
            </div>
          </div>
          <DialogDescription>
            Browse and restore previous versions.
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-1 overflow-y-auto space-y-3 p-1">
          {error && (
            <Alert variant="destructive">
               <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {message && (
            <Alert variant="success">
               <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {revisions && revisions.length > 0 ? (
            <div className="rounded border divide-y">
              {revisions.map((rev: RevisionItem, idx) => {
                const when = rev.created_at ? formatDistanceToNow(new Date(rev.created_at), { addSuffix: true }) : '';
                const authorName = rev.author?.full_name;
                const isCurrent = currentVersion != null && rev.version === currentVersion;
                const isInitial = rev.version === 1;

                return (
                  <Fragment key={`${rev.id}-${idx}`}>
                    <div className={cn("flex items-center justify-between gap-3 p-3 text-sm", activeCompareVersion === rev.version && "bg-muted/50")}>
                     <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                           <span className="font-semibold text-gray-900">
                              {isCurrent ? 'Current Version' : (isInitial ? 'Initial Version' : `Version ${rev.version}`)}
                           </span>
                           <span className="text-muted-foreground text-xs">• {when}</span>
                           {authorName && <span className="text-muted-foreground text-xs">• by {authorName}</span>}
                           {!isCurrent && (
                              <span className="text-[10px] text-muted-foreground bg-gray-100 px-1 rounded uppercase tracking-wider">{rev.revision_type}</span>
                           )}
                           {isInitial && !isCurrent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">v1</span>}
                        </div>
                     </div>

                    <div className="flex gap-2">
                      {/* A row with no differences against the live content is labelled, not
                          hidden: `invisible` left an interactive-looking blank where the
                          buttons should be, which reads as a broken dialog. */}
                      {!isCurrent && rev.has_changes === false && (
                        <span className="text-xs text-muted-foreground italic px-2 self-center">Identical to current</span>
                      )}
                      {!isCurrent && rev.has_changes !== false && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCompare(rev.version)}
                            disabled={compareLoading && activeCompareVersion === rev.version}
                            className="h-8 px-2 text-xs text-blue-600 border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                          >
                            {compareLoading && activeCompareVersion === rev.version ? <><Spinner className="mr-1 h-3 w-3" /> compare</> : 'Compare'}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRestore(rev.version)}
                            disabled={isPending}
                            className="h-8 px-2 text-xs"
                          >
                            {isPending && restoringVersion === rev.version ? <Spinner className="h-3 w-3" /> : 'Restore'}
                          </Button>
                        </>
                      )}
                      {isCurrent && <span className="text-xs text-muted-foreground italic px-2 self-center">Active</span>}
                    </div>
                  </div>
                  
                  {activeCompareVersion === rev.version && (
                    <div className="p-3 bg-slate-50 border-b relative">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="font-semibold text-sm">Comparing Version {activeCompareVersion} to Current</div>
                        <Button variant="outline" size="sm" onClick={() => { setActiveCompareVersion(null); setLeftText(null); setRightText(null); }} className="h-7 text-xs">Close Compare</Button>
                      </div>
                      {compareLoading && <div className="text-sm text-muted-foreground py-4 text-center">Preparing diff…</div>}
                      {!compareLoading && leftText && rightText && (
                        <div className="max-h-[50vh] overflow-y-auto border rounded bg-white">
                           <div className="p-2">
                              <JsonDiffView
                                oldValue={leftText}
                                newValue={rightText}
                                leftTitle="Current (Now)"
                                rightTitle={`Version ${activeCompareVersion}`}
                              />
                           </div>
                        </div>
                      )}
                    </div>
                  )}
                  </Fragment>
                );
              })}
            </div>
          ) : (!loading && <div className="text-sm text-muted-foreground text-center py-4">No revisions found for this selection.</div>)}

          {loading && (
             <div className="flex items-center justify-center py-2">
                <Spinner size="lg" />
             </div>
          )}

          {!loading && (revisions.length > 0 || page > 1) && (
            <div className="flex items-center justify-center gap-2 py-2 flex-wrap">
               <Button 
                 variant="outline" 
                 size="sm" 
                 onClick={() => handlePageChange(page - 1)} 
                 disabled={page <= 1}
                 className="h-8 px-2"
               >
                 Previous
               </Button>
               
               {totalPages > 0 && Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                  // Show limited pages if too many
                  if (totalPages > 10) {
                      if (p === 1 || p === totalPages || (p >= page - 2 && p <= page + 2)) {
                          return (
                            <Button
                                key={p}
                                variant={p === page ? "default" : "outline"}
                                size="sm"
                                onClick={() => handlePageChange(p)}
                                className="h-8 w-8 p-0"
                            >
                                {p}
                            </Button>
                          );
                      } else if (p === page - 3 || p === page + 3) {
                          return <span key={p} className="text-muted-foreground px-1">...</span>;
                      }
                      return null;
                  }
                  
                  return (
                    <Button
                        key={p}
                        variant={p === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => handlePageChange(p)}
                        className="h-8 w-8 p-0"
                    >
                        {p}
                    </Button>
                  );
               })}

               <Button 
                 variant="outline" 
                 size="sm" 
                 onClick={() => handlePageChange(page + 1)} 
                 disabled={page >= totalPages}
                 className="h-8 px-2"
               >
                 Next
               </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
