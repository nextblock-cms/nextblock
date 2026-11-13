/**
 * Every affiliates UI string, per area and merged.
 *
 * Client islands import ONLY their area's dictionary (`AFFILIATES_PORTAL_COPY`, …) and pass it to
 * `useAffiliatesCopy()`; the merged {@link AFFILIATES_COPY} is for the server, the 02031
 * migration generator and tests. The merged objects are plain object literals (no calls) so a
 * bundler can drop them from client chunks that never use them.
 */
import { AFFILIATES_COMMON_COPY } from './copy/common';
import { AFFILIATES_COPILOT_COPY } from './copy/copilot';
import { AFFILIATES_EDITOR_COPY } from './copy/editor';
import { AFFILIATES_PARTNERS_COPY } from './copy/partners';
import { AFFILIATES_PORTAL_COPY } from './copy/portal';
import { AFFILIATES_SANDBOX_COPY } from './copy/sandbox';
import { AFFILIATES_STOREFRONT_COPY } from './copy/storefront';
import { AFFILIATES_TERMS_COPY } from './copy/terms';
import type { AffiliatesCopyArea, AffiliatesCopyDictionary } from './types';

/** Every affiliates copy key starts with this (the root layout filters it out of the global payload). */
export const AFFILIATES_COPY_KEY_PREFIX = 'affiliates.';

/** The areas, in the order the merged dictionary (and the generated migration) lists them. */
export const AFFILIATES_COPY_AREAS = [
  'common',
  'partners',
  'storefront',
  'portal',
  'editor',
  'copilot',
  'sandbox',
  'terms',
] as const satisfies readonly AffiliatesCopyArea[];

/** Each area's dictionary; every key of `common` starts with `affiliates.common.`, and so on. */
export const AFFILIATES_COPY_BY_AREA: Readonly<Record<AffiliatesCopyArea, Readonly<AffiliatesCopyDictionary>>> = {
  common: AFFILIATES_COMMON_COPY,
  partners: AFFILIATES_PARTNERS_COPY,
  storefront: AFFILIATES_STOREFRONT_COPY,
  portal: AFFILIATES_PORTAL_COPY,
  editor: AFFILIATES_EDITOR_COPY,
  copilot: AFFILIATES_COPILOT_COPY,
  sandbox: AFFILIATES_SANDBOX_COPY,
  terms: AFFILIATES_TERMS_COPY,
};

/** All areas merged. Server, generator and tests only (see the module comment). */
export const AFFILIATES_COPY: Readonly<AffiliatesCopyDictionary> = {
  ...AFFILIATES_COMMON_COPY,
  ...AFFILIATES_PARTNERS_COPY,
  ...AFFILIATES_STOREFRONT_COPY,
  ...AFFILIATES_PORTAL_COPY,
  ...AFFILIATES_EDITOR_COPY,
  ...AFFILIATES_COPILOT_COPY,
  ...AFFILIATES_SANDBOX_COPY,
  ...AFFILIATES_TERMS_COPY,
};

/** `affiliates.<area>.` */
export function affiliatesCopyAreaPrefix(area: AffiliatesCopyArea): string {
  return `${AFFILIATES_COPY_KEY_PREFIX}${area}.`;
}

/** The keys of `dictionary` (default: every area) that start with `prefix`, sorted. */
export function affiliatesCopyKeysWithPrefix(
  prefix: string,
  dictionary: Readonly<AffiliatesCopyDictionary> = AFFILIATES_COPY
): string[] {
  return Object.keys(dictionary)
    .filter((key) => key.startsWith(prefix))
    .sort();
}
