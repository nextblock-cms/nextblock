'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_SIGNUP_COPY,
  AFFILIATE_PORTAL_PATH,
} from '@nextblock-cms/affiliates';
import { z } from '../../../lib/zod-config';
import { getServerAffiliatesCopy } from '../../../lib/affiliates/server-copy';
import {
  checkAffiliateHandleAvailability,
  submitAffiliateSignup,
  type AffiliateHandleAvailability,
  type AffiliateSignupErrorCode,
  type AffiliateSignupOutcome,
} from '../../../lib/affiliates/signup';

/**
 * Public server actions of `/partners`. Both are unauthenticated POST endpoints by design (they
 * create the account), so there is no actor to authorize: each validates its input with zod, and
 * the signup service (lib/affiliates/signup.ts) is the gate — package activation, bot protection,
 * the visitor's own session for upgrades, a masked-IP throttle. Neither takes an id, a role or a
 * client from the browser. Answers are `{ ok, … }` shapes with localized messages; database text
 * never reaches the response.
 */

export type PartnerSignupField = 'handle' | 'displayName' | 'email' | 'password' | 'terms';

/** What the visitor typed, echoed back on a refusal (React 19 resets an uncontrolled form). Never the password. */
export interface PartnerSignupEchoValues {
  handle: string;
  displayName: string;
  email: string;
  terms: boolean;
}

export type PartnerSignupErrorCode = AffiliateSignupErrorCode | 'terms_required' | 'validation';

export type PartnerSignupState =
  | { ok: null; attempt: number }
  | { ok: true; status: 'confirm_email' | 'sign_in'; attempt: number }
  /** The public sandbox: every check passed and nothing was created; `handle` is the one it would claim. */
  | { ok: true; status: 'sandbox_demo'; handle: string; attempt: number }
  | {
      ok: false;
      error: PartnerSignupErrorCode;
      message: string;
      field: PartnerSignupField | null;
      values: PartnerSignupEchoValues;
      attempt: number;
    };

export type PartnerHandleCheckResult =
  | { ok: true; status: AffiliateHandleAvailability }
  | { ok: false; error: 'rate_limited' | 'unavailable' | 'invalid_input' };

const SIGNUP_MESSAGES = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_SIGNUP_COPY };

const SIGNUP_ERROR_KEYS: Readonly<Record<PartnerSignupErrorCode, keyof typeof SIGNUP_MESSAGES>> = {
  handle_taken: 'affiliates.common.error_handle_taken',
  handle_invalid: 'affiliates.common.error_handle_invalid',
  handle_reserved: 'affiliates.common.error_handle_reserved',
  role_conflict: 'affiliates.common.error_role_conflict',
  affiliate_exists: 'affiliates.common.error_affiliate_exists',
  program_full: 'affiliates.common.error_program_full',
  unknown: 'affiliates.common.error_generic',
  package_inactive: 'affiliates.common.error_package_inactive',
  captcha: 'affiliates.partners.signup_error_captcha',
  throttled: 'affiliates.partners.signup_error_throttled',
  account_exists: 'affiliates.partners.signup_error_account_exists',
  factor_pending: 'affiliates.partners.signup_error_factor_pending',
  rate_limited: 'affiliates.common.error_rate_limited',
  email_invalid: 'affiliates.partners.signup_error_email',
  password_invalid: 'affiliates.partners.signup_error_password',
  name_invalid: 'affiliates.partners.signup_error_name',
  terms_required: 'affiliates.partners.signup_error_terms',
  validation: 'affiliates.common.error_validation',
};

const SIGNUP_ERROR_FIELDS: Partial<Record<PartnerSignupErrorCode, PartnerSignupField>> = {
  handle_taken: 'handle',
  handle_invalid: 'handle',
  handle_reserved: 'handle',
  account_exists: 'email',
  email_invalid: 'email',
  password_invalid: 'password',
  name_invalid: 'displayName',
  terms_required: 'terms',
};

const signupFormSchema = z.object({
  handle: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  // Empty for a signed-in visitor (the upgrade form has no email or password field).
  email: z.union([z.literal(''), z.email().max(254)]),
  password: z.union([z.literal(''), z.string().min(8).max(72)]),
  terms: z.literal('on'),
});

const handleCheckSchema = z.object({ handle: z.string().max(64) }).strict();

function formText(formData: FormData, name: string, max: number): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function nextAttempt(previous: unknown): number {
  const attempt = previous && typeof previous === 'object' ? (previous as { attempt?: unknown }).attempt : 0;
  return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0 ? Math.min(attempt + 1, 1_000_000) : 1;
}

function firstInvalidField(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): PartnerSignupErrorCode {
  const fields = new Set(issues.map((issue) => String(issue.path[0] ?? '')));
  if (fields.has('handle')) return 'handle_invalid';
  if (fields.has('displayName')) return 'name_invalid';
  if (fields.has('email')) return 'email_invalid';
  if (fields.has('password')) return 'password_invalid';
  if (fields.has('terms')) return 'terms_required';
  return 'validation';
}

async function refusal(
  error: PartnerSignupErrorCode,
  values: PartnerSignupEchoValues,
  attempt: number,
): Promise<PartnerSignupState> {
  const t = await getServerAffiliatesCopy({ dictionary: SIGNUP_MESSAGES });
  return { ok: false, error, message: t(SIGNUP_ERROR_KEYS[error]), field: SIGNUP_ERROR_FIELDS[error] ?? null, values, attempt };
}

/**
 * The `/partners` signup form (`useActionState`). A visitor with a session is upgraded; an
 * anonymous one gets an account first. Success with a session redirects to the partner portal;
 * otherwise the form shows "check your email" or "sign in". On the public sandbox the service
 * creates nothing and the form shows the demo result (no session, so never a redirect).
 */
export async function submitPartnerSignup(prevState: PartnerSignupState, formData: FormData): Promise<PartnerSignupState> {
  const attempt = nextAttempt(prevState);
  const raw = {
    handle: formText(formData, 'handle', 256),
    displayName: formText(formData, 'displayName', 256),
    email: formText(formData, 'email', 512).trim(),
    password: formText(formData, 'password', 512),
    terms: formText(formData, 'terms', 8),
  };
  const values: PartnerSignupEchoValues = {
    handle: raw.handle.slice(0, 64),
    displayName: raw.displayName.slice(0, 80),
    email: raw.email.slice(0, 254),
    terms: raw.terms === 'on',
  };

  const parsed = signupFormSchema.safeParse(raw);
  if (!parsed.success) return refusal(firstInvalidField(parsed.error.issues), values, attempt);

  let outcome: AffiliateSignupOutcome;
  try {
    outcome = await submitAffiliateSignup(
      {
        handle: parsed.data.handle,
        displayName: parsed.data.displayName,
        email: parsed.data.email || null,
        password: parsed.data.password || null,
      },
      formData,
    );
  } catch (error) {
    console.error('[affiliates] Partner signup failed unexpectedly:', error instanceof Error ? error.message : String(error));
    return refusal('unknown', values, attempt);
  }

  if (outcome.kind === 'error') return refusal(outcome.code, values, attempt);
  if (outcome.kind === 'sandbox_demo') return { ok: true, status: 'sandbox_demo', handle: outcome.handle, attempt };
  if (outcome.kind === 'signed_in') {
    // Outside any try/catch: redirect() works by throwing.
    redirect(`${AFFILIATE_PORTAL_PATH}?welcome=1`);
  }
  return { ok: true, status: outcome.kind === 'sign_in' ? 'sign_in' : 'confirm_email', attempt };
}

/**
 * Live availability for the handle field. Rate-limited per masked address (best effort) and
 * answering only `available | taken | invalid | reserved | unknown`.
 */
export async function checkPartnerHandleAvailability(input: { handle: string }): Promise<PartnerHandleCheckResult> {
  const parsed = handleCheckSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  try {
    return await checkAffiliateHandleAvailability(parsed.data.handle);
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
