'use client';

/**
 * A small client cache of catalog products, keyed by id, shared by every product grid of one
 * editor (and primed by the picker), so a page with several grids resolves each product once.
 * Framework-free: React reads it with `useSyncExternalStore(store.subscribe, store.getVersion)`.
 */
import { isStorefrontProductId } from '../storefront/sanitize';
import type { StorefrontEditorProduct } from '../storefront/types';
import { sanitizeStorefrontHref } from '../storefront/urls';

export type StorefrontProductResolver = (ids: string[]) => Promise<StorefrontEditorProduct[]>;

export interface StorefrontProductStore {
  /** The product, `null` when the catalog did not return it (unavailable), `undefined` while unknown. */
  get(id: string): StorefrontEditorProduct | null | undefined;
  /** Adds products already loaded elsewhere (picker results). */
  prime(products: readonly StorefrontEditorProduct[]): void;
  /** Resolves the ids that are not known yet (batched; each id is requested once). */
  ensure(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  /** Changes whenever an entry changes. */
  getVersion(): number;
}

const MAX_BATCH = 48;
const MAX_TEXT = 300;

/** A product from untrusted input in the exact `StorefrontEditorProduct` shape, or null. */
export function normalizeStorefrontEditorProduct(value: unknown): StorefrontEditorProduct | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const title = record['title'];
  if (!isStorefrontProductId(id) || typeof title !== 'string') return null;
  const imageUrl = record['imageUrl'];
  const priceLabel = record['priceLabel'];
  return {
    id: id.toLowerCase(),
    title: title.slice(0, MAX_TEXT),
    imageUrl: typeof imageUrl === 'string' && imageUrl.length <= 2000 ? imageUrl : null,
    priceLabel: typeof priceLabel === 'string' ? priceLabel.slice(0, 64) : null,
  };
}

/** A catalog image address safe to show in the editor UI (an http(s) URL or a site path), or null. */
export function storefrontEditorProductImageSrc(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const href = sanitizeStorefrontHref(url);
  return href !== null && !href.startsWith('mailto:') ? href : null;
}

export function createStorefrontProductStore(getResolver: () => StorefrontProductResolver | null | undefined): StorefrontProductStore {
  const entries = new Map<string, StorefrontEditorProduct | null>();
  const requested = new Set<string>();
  const queue = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  let scheduled = false;

  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  const flush = () => {
    scheduled = false;
    const resolver = getResolver();
    const batch = [...queue].slice(0, MAX_BATCH);
    for (const id of batch) queue.delete(id);
    if (queue.size > 0) schedule();
    if (!resolver || batch.length === 0) return;

    Promise.resolve()
      .then(() => resolver(batch))
      .then(
        (products) => {
          const returned = new Set<string>();
          for (const product of Array.isArray(products) ? products : []) {
            const normalized = normalizeStorefrontEditorProduct(product);
            if (!normalized || !batch.includes(normalized.id)) continue;
            entries.set(normalized.id, normalized);
            returned.add(normalized.id);
          }
          for (const id of batch) if (!returned.has(id)) entries.set(id, null);
          notify();
        },
        () => {
          // Leave them unknown so a later `ensure` retries: a network error is not "unavailable".
          for (const id of batch) requested.delete(id);
        }
      );
  };

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  return {
    get: (id) => entries.get(id.toLowerCase()),
    prime(products) {
      let changed = false;
      for (const product of products) {
        const normalized = normalizeStorefrontEditorProduct(product);
        if (!normalized) continue;
        entries.set(normalized.id, normalized);
        requested.add(normalized.id);
        changed = true;
      }
      if (changed) notify();
    },
    ensure(ids) {
      for (const raw of ids) {
        if (!isStorefrontProductId(raw)) continue;
        const id = raw.toLowerCase();
        if (entries.has(id) || requested.has(id)) continue;
        requested.add(id);
        queue.add(id);
      }
      if (queue.size > 0) schedule();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}
