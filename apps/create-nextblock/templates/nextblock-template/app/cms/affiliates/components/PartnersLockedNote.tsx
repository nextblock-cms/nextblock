import { Lock } from 'lucide-react';

/** The id the disabled partner controls point `aria-describedby` at (one note per page). */
export const PARTNERS_LOCKED_NOTE_ID = 'affiliate-partners-locked-note';

/** The partner actions' sandbox refusal, word for word (actions.ts and lib/affiliates/review.ts). */
export const PARTNERS_LOCKED_NOTE = "Partner accounts can't be changed in the sandbox: every visitor shares them.";

/**
 * Shown beside the partner controls on the public sandbox, whose demo partners every visitor
 * shares: the controls render disabled and described by this note, and the actions refuse there
 * either way. Server component.
 */
export function PartnersLockedNote({ id = PARTNERS_LOCKED_NOTE_ID }: { id?: string }) {
  return (
    <p
      id={id}
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span>{PARTNERS_LOCKED_NOTE}</span>
    </p>
  );
}
