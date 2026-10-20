import type { Database } from '@nextblock-cms/db';

type AuthProfile = Pick<Database['public']['Tables']['profiles']['Row'], 'role' | 'full_name'> | null;

const DASHBOARD_PATH = '/cms/dashboard';
const HOME_PATH = '/';
const PROFILE_PATH = '/profile';
const PASSWORD_RESET_PATH = '/profile/password';

/**
 * True only for a safe SITE-RELATIVE path: starts with `/`, is not scheme-relative (`//`), has no
 * backslash (browsers treat `/\host` as an authority), no control/whitespace characters, and no
 * encoded leading `//`. Exported so every redirect-target check in the app shares one rule
 * (post-auth redirect, auth callback, language switch, post actions).
 */
export function isSafeInternalPath(path?: string | null): boolean {
  if (!path) return false;
  // Must be a site-relative path, not an absolute or scheme-relative URL. Browsers treat a
  // backslash as a slash in the authority, so `/\evil.com`, `\/evil.com` and `/%2F/evil.com`
  // are open-redirect vectors that `startsWith('/')` alone does not stop. Reject backslashes,
  // control/whitespace characters, and any leading `//` (after the first char).
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('\\')) return false;
  if (hasControlOrWhitespace(path)) return false;
  if (/^\/%2f/i.test(path)) return false;
  return true;
}

/** True if the string contains any ASCII control char (incl. CR/LF/NUL), DEL, or whitespace. */
function hasControlOrWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isDashboardPath(path: string) {
  return path === DASHBOARD_PATH || path.startsWith(`${DASHBOARD_PATH}/`);
}

export function isCustomerProfileComplete(profile: AuthProfile) {
  return Boolean(profile?.full_name?.trim());
}

export function resolvePostAuthRedirect(
  profile: AuthProfile,
  requestedPath?: string | null
) {
  const safePath = isSafeInternalPath(requestedPath) ? requestedPath : null;
  const role = profile?.role ?? null;

  if (safePath === PASSWORD_RESET_PATH) {
    return PASSWORD_RESET_PATH;
  }

  if (role === 'ADMIN' || role === 'WRITER') {
    return safePath ?? DASHBOARD_PATH;
  }

  if (!isCustomerProfileComplete(profile)) {
    return PROFILE_PATH;
  }

  if (safePath && !isDashboardPath(safePath)) {
    return safePath;
  }

  return HOME_PATH;
}
