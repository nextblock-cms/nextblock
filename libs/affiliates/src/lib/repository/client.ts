import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Any Supabase client the app hands in (cookie-scoped or service role). The affiliates tables
 * are read untyped: the generated `Database` type only learns them after `npm run db:types`
 * runs against a project that has migrations 02029–02031, so rows are normalized by hand
 * (`./rows.ts`) against the contract in `core/types.ts`.
 */
export type AffiliateRepositoryClient = SupabaseClient<any>;

/** One page of a `listAffiliate*` read. */
export interface AffiliateRepositoryPage<T> {
  rows: T[];
  /** Total matching rows (PostgREST `count: 'exact'`). */
  count: number;
}

/** Largest page `listAffiliate*` returns. */
export const AFFILIATE_REPOSITORY_MAX_PAGE_SIZE = 200;

/** Page size when the caller passes none. */
export const AFFILIATE_REPOSITORY_DEFAULT_PAGE_SIZE = 50;

/**
 * A failed read or write. `message` is generic on purpose (it can reach logs and, through a
 * careless caller, a response); the PostgREST error stays on `cause`.
 */
export class AffiliateRepositoryError extends Error {
  readonly operation: string;
  /** PostgREST / Postgres error code (`PGRST116`, `22P02`, …) when there is one. */
  readonly code: string | null;

  constructor(operation: string, cause: unknown) {
    super(`Affiliates repository: ${operation} failed`, { cause });
    this.name = 'AffiliateRepositoryError';
    this.operation = operation;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' && code ? code : null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A lowercase uuid, or null: ids are checked before they reach a filter (a malformed one is a 22P02). */
export function normalizeAffiliateUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * Escape a user-supplied string for a LIKE / ILIKE pattern: `\`, `%` and `_` are escaped, and
 * `*` (PostgREST's alias for `%` in like filters) is removed. Use the result inside a pattern
 * you build (`%${escaped}%`) and pass it to `.ilike()`, never to an `.or()` string.
 */
export function escapeAffiliateLikePattern(value: string): string {
  return String(value)
    .replace(/\*/g, '')
    .replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function clampAffiliatePageSize(limit: unknown): number {
  const number = Math.floor(Number(limit));
  if (!Number.isFinite(number) || number <= 0) return AFFILIATE_REPOSITORY_DEFAULT_PAGE_SIZE;
  return Math.min(number, AFFILIATE_REPOSITORY_MAX_PAGE_SIZE);
}

export function clampAffiliatePageOffset(offset: unknown): number {
  const number = Math.floor(Number(offset));
  return Number.isFinite(number) && number > 0 ? Math.min(number, 1_000_000) : 0;
}

/** The untyped table builder (see {@link AffiliateRepositoryClient}). */
export function affiliateTable(supabase: AffiliateRepositoryClient, table: string) {
  return (supabase as SupabaseClient<any>).from(table);
}
