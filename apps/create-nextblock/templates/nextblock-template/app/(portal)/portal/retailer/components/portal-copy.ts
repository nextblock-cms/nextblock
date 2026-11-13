import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_COPILOT_COPY,
  AFFILIATES_EDITOR_COPY,
  AFFILIATES_PORTAL_COPY,
  AFFILIATES_SANDBOX_COPY,
  type AffiliatesCopyDictionary,
  type AffiliatesCopyValues,
} from '@nextblock-cms/affiliates';

/**
 * The partner portal's copy, typed: every key a portal screen passes to `t()` must exist in the
 * common, portal or sandbox dictionary, so a typo fails the type check instead of showing a raw key.
 * Client islands translate with `usePortalCopy()`; server components with `getPortalServerCopy()`.
 */

/**
 * The dictionary the portal's own islands and server components translate with: common and portal,
 * plus the public sandbox's notices (rendered there only).
 */
export const PORTAL_UI_COPY: Readonly<AffiliatesCopyDictionary> = {
  ...AFFILIATES_COMMON_COPY,
  ...AFFILIATES_PORTAL_COPY,
  ...AFFILIATES_SANDBOX_COPY,
};

/**
 * Everything rendered under the portal layout: its own copy plus the editor and the copilot panel,
 * whose components translate with their own area dictionaries. The layout loads the operator
 * overrides for exactly these keys.
 */
export const PORTAL_PROVIDER_COPY: Readonly<AffiliatesCopyDictionary> = {
  ...PORTAL_UI_COPY,
  ...AFFILIATES_EDITOR_COPY,
  ...AFFILIATES_COPILOT_COPY,
};

export type PortalCopyKey =
  | keyof typeof AFFILIATES_COMMON_COPY
  | keyof typeof AFFILIATES_PORTAL_COPY
  | keyof typeof AFFILIATES_SANDBOX_COPY;

export type PortalTranslate = (key: PortalCopyKey, values?: AffiliatesCopyValues) => string;
