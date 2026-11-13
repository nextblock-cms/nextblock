/**
 * The public sandbox publishes its admin login, so a captcha secret one visitor saved would be shown
 * to every later visitor. There `updateBotProtectionSettings` refuses a secret with this sentence,
 * `getBotProtectionSettings` never returns the stored one, and the form's secret field renders
 * disabled beside a note with the same sentence. Import-free: the `'use server'` actions (which may
 * export only async functions) and the client form both read it.
 */
export const SANDBOX_SECRET_REFUSED = 'The sandbox cannot store captcha secret keys.';

/** id of the note the disabled secret field points at with aria-describedby. */
export const SANDBOX_SECRET_NOTE_ID = 'bot-protection-secret-sandbox-note';
