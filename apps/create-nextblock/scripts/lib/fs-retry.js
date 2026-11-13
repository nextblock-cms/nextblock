// On Windows a file that was written a moment ago is often still open somewhere else: Microsoft
// Defender scans it, and an editor's language servers or the Nx daemon read it. Rewriting it then
// fails with EBUSY, EPERM, EACCES, or libuv's catch-all UNKNOWN (ERROR_USER_MAPPED_FILE, printed as
// "UNKNOWN: unknown error, open '…/nextblock-template/…'"), on a different file each run, and
// removing a folder whose last file is still being deleted fails with ENOTEMPTY. On 2026-11-10
// and again for the 0.23.0 CLI release on 2026-11-13 the template sync stopped half way, leaving
// the template without its standalone package.json, Docker assets and UI proxies.
// Every sync step is idempotent, so a step that hits one of these simply runs again after a pause.

export const TRANSIENT_FS_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'UNKNOWN']);

export function isTransientFsError(error) {
  return Boolean(error) && TRANSIENT_FS_ERROR_CODES.has(error.code);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `action`; when it fails with a transient file-lock error, waits `delayMs * attempt` and runs
 * it again, up to `attempts` runs in all. Any other error, or the last transient one, is rethrown.
 */
export async function retryTransientFsErrors(
  label,
  action,
  { attempts = 6, delayMs = 500, sleep = wait, log = console.log } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      const pause = delayMs * attempt;
      log(
        `${label}: ${error.code} on a locked file (${error.path ?? 'path unknown'}). ` +
          `Retrying in ${pause}ms (${attempt}/${attempts - 1})...`,
      );
      await sleep(pause);
    }
  }
}
