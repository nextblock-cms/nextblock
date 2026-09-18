'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { buttonVariants } from '@nextblock-cms/ui/button';
import { cn } from '@nextblock-cms/utils';

import { useLabel } from '../../lib/i18n/use-label';

interface GridPaginationProps {
  currentPage: number;
  totalPages: number;
  isLoading: boolean;
  /**
   * Loads a page in place. The link's own navigation is cancelled first, so with JavaScript
   * the grid swaps its items without a full page load; without it, the browser follows
   * `?page=N` and the server renders that page.
   */
  onNavigate: (page: number) => void;
  size?: 'default' | 'sm';
  className?: string;
}

const isPlainLeftClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Previous / Next controls for a paginated grid, as real links to `?page=N`.
 *
 * Links rather than buttons so page 2 exists as a URL: it can be opened in a new tab,
 * bookmarked, crawled, and reached with JavaScript off. The server honours the parameter
 * (see `lib/blocks/requested-page.ts`); the client keeps the in-place experience.
 */
export default function GridPagination({
  currentPage,
  totalPages,
  isLoading,
  onNavigate,
  size = 'default',
  className,
}: GridPaginationProps) {
  const label = useLabel();
  const pathname = usePathname() || '/';

  const hrefFor = (page: number) => (page <= 1 ? pathname : `${pathname}?page=${page}`);

  const renderControl = (page: number, rel: 'prev' | 'next', children: React.ReactNode) => {
    const disabled = page < 1 || page > totalPages || isLoading;
    const classes = cn(buttonVariants({ variant: 'outline', size }), 'gap-1');

    if (disabled) {
      return (
        <span aria-disabled="true" className={cn(classes, 'pointer-events-none opacity-50')}>
          {children}
        </span>
      );
    }

    return (
      <Link
        href={hrefFor(page)}
        rel={rel}
        prefetch={false}
        scroll={false}
        className={classes}
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return; // new tab, new window: let the browser do it
          event.preventDefault();
          onNavigate(page);
        }}
      >
        {children}
      </Link>
    );
  };

  return (
    <nav
      aria-label={label('pagination.label', 'Pagination', 'Pagination')}
      className={cn('flex items-center justify-center gap-3', className)}
    >
      {renderControl(
        currentPage - 1,
        'prev',
        <>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {label('pagination.previous', 'Previous', 'Précédent')}
        </>
      )}
      <span
        aria-live="polite"
        className="flex min-w-[7rem] items-center justify-center gap-1.5 text-sm tabular-nums text-muted-foreground"
      >
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {label('pagination.page_of', 'Page {current} of {total}', 'Page {current} sur {total}', {
          current: currentPage,
          total: totalPages,
        })}
      </span>
      {renderControl(
        currentPage + 1,
        'next',
        <>
          {label('pagination.next', 'Next', 'Suivant')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </>
      )}
    </nav>
  );
}
