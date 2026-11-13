/**
 * The public sandbox (`NEXT_PUBLIC_IS_SANDBOX === 'true'`) publishes its admin and partner logins,
 * so every visitor is that admin and every account is shared. /cms/users changes nothing there:
 * each write action in `actions.ts` refuses with this sentence right after its admin check, and
 * the create form's submit, the edit form's Save and the Delete control render disabled, pointing
 * (`aria-describedby`) at a visible note with the same sentence.
 *
 * Import-free on purpose: the server actions, the server pages and the client forms all read it
 * (a `'use server'` file may export only async functions, so the sentence cannot live there).
 */
export const USERS_LOCKED_IN_SANDBOX =
  "User accounts can't be created, changed or deleted in the sandbox: every visitor shares them.";

/** id of the visible sandbox note on each /cms/users screen; one note per page. */
export const USERS_SANDBOX_NOTE_ID = 'users-sandbox-lock-note';

/** Classes of that note: the muted card the edit screen's partner notice uses. */
export const USERS_SANDBOX_NOTE_CLASS = 'mb-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground';
