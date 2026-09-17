'use client';

import { useCallback, useEffect, useRef } from 'react';

function readPage(param: string): number {
  const raw = new URLSearchParams(window.location.search).get(param);
  const page = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

/**
 * Keeps a grid's page number in the URL (`?page=3`) without giving up static rendering.
 *
 * Pagination used to live only in component state: page 2 could not be linked, shared or
 * reloaded, and Back left the site instead of returning to the previous page of results.
 * Reading `searchParams` on the server would make every CMS page dynamic, so the first page
 * stays in the static HTML and later pages are restored client-side:
 *
 * - on mount, a `?page=N` in the address bar calls `onRestore(N)`;
 * - Back/Forward (`popstate`) calls `onRestore` with whatever the URL now says;
 * - the returned function records a user-initiated page change as a history entry.
 *
 * `onRestore` must NOT push history itself.
 */
export function usePageParam(onRestore: (page: number) => void, param = 'page') {
  const onRestoreRef = useRef(onRestore);

  useEffect(() => {
    onRestoreRef.current = onRestore;
  });

  useEffect(() => {
    const initialPage = readPage(param);
    if (initialPage > 1) onRestoreRef.current(initialPage);

    const handlePopState = () => onRestoreRef.current(readPage(param));

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [param]);

  return useCallback(
    (page: number) => {
      const url = new URL(window.location.href);

      if (page <= 1) url.searchParams.delete(param);
      else url.searchParams.set(param, String(page));

      if (url.href !== window.location.href) window.history.pushState(null, '', url);
    },
    [param]
  );
}
