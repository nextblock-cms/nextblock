import { cache } from 'react';

/** Upper bound on `?page=N`; anything past the last page falls back to the first page anyway. */
const MAX_PAGE = 10_000;

/**
 * The page number a visitor asked for with `?page=N`, shared by every paginated grid on the
 * page (posts grid, product grid), so later pages render on the server and work without
 * JavaScript.
 *
 * Request-scoped on purpose: React `cache` hands each server render its own store, so a
 * value set by one request never leaks into another. The page routes are already rendered per
 * request (they read the locale cookie), so honouring a query parameter costs them nothing.
 * A grid can sit several levels down (inside a section column, rendered through the block
 * registry), which is why this is a store the page fills and the grid reads, rather than a
 * prop threaded through every renderer in between.
 */
const requestStore = cache(() => ({ page: 1 }));

export function parsePageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = raw ? Number.parseInt(raw, 10) : 1;

  return Number.isFinite(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}

/** Called once by the page route, before its blocks render. */
export function setRequestedPage(page: number): void {
  requestStore().page = page;
}

/** Read by the grid server components. Defaults to 1 when no route set it. */
export function getRequestedPage(): number {
  return requestStore().page;
}
