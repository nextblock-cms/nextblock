import type { PortalCopyKey } from './portal-copy';
import type { PortalUploadError, PortalUploadKind, RetailerPortalActionError } from './portal-types';

/** Server action error codes → the message a partner reads. */
export const PORTAL_ACTION_ERROR_KEYS: Readonly<Record<RetailerPortalActionError, PortalCopyKey>> = {
  unauthorized: 'affiliates.common.error_unauthorized',
  forbidden: 'affiliates.common.error_forbidden',
  suspended: 'affiliates.common.error_suspended',
  package_inactive: 'affiliates.common.error_package_inactive',
  invalid_input: 'affiliates.common.error_validation',
  invalid_social_links: 'affiliates.portal.error_social_links',
  not_found: 'affiliates.common.error_not_found',
  pending_review: 'affiliates.portal.error_pending_review',
  conflict: 'affiliates.portal.error_conflict',
  empty_storefront: 'affiliates.portal.error_empty_storefront',
  too_large: 'affiliates.portal.error_storefront_too_large',
  missing_title: 'affiliates.portal.error_missing_title',
  nothing_to_submit: 'affiliates.portal.error_nothing_to_submit',
  not_pending: 'affiliates.portal.error_not_pending',
  rate_limited: 'affiliates.portal.error_submit_cooldown',
  sandbox: 'affiliates.portal.error_sandbox',
  connect_unavailable: 'affiliates.portal.error_connect_unavailable',
  payouts_not_configured: 'affiliates.portal.error_payouts_not_configured',
  invalid_payout_email: 'affiliates.portal.error_payout_email',
  unknown: 'affiliates.common.error_generic',
};

/** Upload route error codes → the message a partner reads (the size limit depends on the kind). */
export function portalUploadErrorKey(error: PortalUploadError, kind: PortalUploadKind): PortalCopyKey {
  switch (error) {
    case 'unauthorized':
      return 'affiliates.common.error_unauthorized';
    case 'forbidden':
      return 'affiliates.common.error_forbidden';
    case 'suspended':
      return 'affiliates.common.error_suspended';
    case 'package_inactive':
      return 'affiliates.common.error_package_inactive';
    case 'pending_review':
      return 'affiliates.portal.error_pending_review';
    case 'rate_limited':
      return 'affiliates.portal.upload_error_rate_limited';
    case 'image_limit':
      return 'affiliates.portal.upload_error_image_limit';
    case 'too_large':
      return kind === 'avatar' ? 'affiliates.portal.upload_error_too_large_avatar' : 'affiliates.portal.upload_error_too_large_image';
    case 'unsupported_type':
      return 'affiliates.portal.upload_error_type';
    case 'invalid_image':
      return 'affiliates.portal.upload_error_invalid';
    case 'storage_unavailable':
      return 'affiliates.portal.upload_error_unavailable';
    case 'network':
      return 'affiliates.common.error_network';
    case 'invalid_request':
    case 'upload_failed':
    default:
      return 'affiliates.portal.upload_error_generic';
  }
}
