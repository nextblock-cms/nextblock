// Field names shared by the client widgets and the server verifier. Kept free of server
// imports so client components can use the constants (verify.ts pulls in the service-role
// Supabase client and throws in a browser).

/**
 * The honeypot. Deliberately NOT named after anything a browser or password manager
 * autofills. The previous name, `verification_secondary_email`, matched email autofill
 * heuristics: on the sign-up and contact forms a real visitor's browser could fill the hidden
 * field, the server then took them for a bot, answered with its fake success, and silently
 * dropped the sign-up or the message.
 */
export const HONEYPOT_FIELD = 'nb_form_ref';

/** Still honoured so a page cached before the rename keeps working as a honeypot. */
export const LEGACY_HONEYPOT_FIELD = 'verification_secondary_email';

export const TURNSTILE_TOKEN_FIELD = 'cf-turnstile-response';
export const RECAPTCHA_TOKEN_FIELD = 'g-recaptcha-response';
