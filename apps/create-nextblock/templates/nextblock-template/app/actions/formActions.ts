// app/actions/formActions.ts
"use server";

import { headers } from 'next/headers';
import { after } from 'next/server';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import {
  createThread,
  getFormEndpoint,
  notifyAdminOfMessage,
  resolveFormRecipient,
} from '../../lib/messages/threads';
import {
  verifyBotProtection,
  type BotProtectionProvider,
  HONEYPOT_FIELD,
  LEGACY_HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  RECAPTCHA_TOKEN_FIELD,
} from '../../lib/botProtection/verify';

/**
 * Contact-form submissions.
 *
 * This used to take its recipient as a bound argument from the client and send an email
 * with no record kept. Two consequences: the shop owner's address was published in the
 * RSC payload of every page carrying a form, and every submission was lost whenever
 * SMTP was unconfigured or down.
 *
 * Now the browser posts only `form_key` — an opaque handle that grants nothing. The
 * destination and the field LABELS are read server-side from `form_endpoints`, so
 * neither can be forged by editing the request, and the submission is stored as a
 * message thread before any mail is attempted.
 */

interface FormSubmissionResult {
  success: boolean;
  message: string;
  /**
   * Stable reason for a failure the renderer can translate; `message` stays the English
   * text for anything that reads the result without the renderer.
   */
  code?: 'empty' | 'throttled' | 'error';
  /**
   * What the visitor typed, echoed back on failure only. React 19 resets an uncontrolled
   * form when its action settles, so without this a server error wiped the message the
   * visitor had just written. Keys are the posted field names (`f_<temp_id>`).
   */
  values?: Record<string, string>;
}

type FormSubmissionConfig = {
  /** Handle for the form's server-side manifest. */
  formKey?: string;
  botProtectionProvider?: BotProtectionProvider;
};

const MAX_FIELD_LENGTH = 5000;
const MAX_USER_AGENT_LENGTH = 500;
const THROTTLE_WINDOW_MINUTES = 10;
const THROTTLE_MAX_SUBMISSIONS = 5;

/** Shared with the enquiry action: an unparseable origin is throttled, not exempted. */
const UNKNOWN_IP_BUCKET = 'unknown';

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

function resolveClientIp(requestHeaders: Headers): string | null {
  return (
    firstHop(requestHeaders.get('x-vercel-forwarded-for')) ??
    firstHop(requestHeaders.get('x-real-ip')) ??
    firstHop(requestHeaders.get('x-forwarded-for'))
  );
}

function maskIp(ip: string | null): string {
  if (!ip) return UNKNOWN_IP_BUCKET;
  if (ip.includes(':')) {
    const hextets = ip.split(':').filter(Boolean);
    return `${hextets.slice(0, 3).join(':')}::x`;
  }
  const octets = ip.split('.');
  if (octets.length === 4) {
    octets[3] = 'x';
    return octets.join('.');
  }
  return UNKNOWN_IP_BUCKET;
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeSubmissionConfig(config: string | FormSubmissionConfig): FormSubmissionConfig {
  // A bare string used to mean "this is the recipient address". It no longer is, and
  // honouring it would reopen the relay: accept the shape, ignore the value.
  if (typeof config === 'string') {
    return { formKey: undefined, botProtectionProvider: undefined };
  }
  return config;
}

export async function handleFormSubmission(
  config: string | FormSubmissionConfig,
  prevState: unknown,
  formData: FormData
): Promise<FormSubmissionResult> {
  const { formKey, botProtectionProvider } = normalizeSubmissionConfig(config);

  const values: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === 'string' && key.startsWith('f_')) {
      values[key] = value.slice(0, MAX_FIELD_LENGTH);
    }
  });

  const verification = await verifyBotProtection(formData, { botProtectionProvider });
  if (!verification.ok) {
    if (verification.reason === 'honeypot') {
      // Fool the bot by returning a fake success so it learns nothing.
      return { success: true, message: "Submission successful!" };
    }
    return { success: false, message: verification.message, values };
  }

  try {
    const endpoint = formKey ? await getFormEndpoint(formKey) : null;

    // Field labels come from the SERVER manifest, never from the posted names — a
    // client-supplied display value must not reach the owner's mailbox as fact.
    const labelByTempId = new Map<string, string>();
    for (const field of endpoint?.fields ?? []) {
      if (field.temp_id) labelByTempId.set(field.temp_id, field.label || field.temp_id);
    }

    const submitted: Array<{ label: string; value: string; key: string }> = [];
    formData.forEach((value, key) => {
      if (typeof value !== 'string') return;
      if (
        key.startsWith('$') ||
        key === HONEYPOT_FIELD ||
        key === LEGACY_HONEYPOT_FIELD ||
        key === RECAPTCHA_TOKEN_FIELD ||
        key === TURNSTILE_TOKEN_FIELD ||
        key === 'form_key' ||
        key === 'locale'
      ) {
        return;
      }
      const tempId = key.startsWith('f_') ? key.slice(2) : key;
      const label =
        labelByTempId.get(tempId) ??
        // Un-migrated block, or a field added after the manifest was written.
        tempId.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
      submitted.push({ key: tempId, label, value: value.slice(0, MAX_FIELD_LENGTH) });
    });

    if (submitted.length === 0) {
      return { success: false, code: 'empty', message: 'Please fill in the form before submitting.', values };
    }

    const senderEmail =
      submitted.find((field) => isPlausibleEmail(field.value))?.value ?? null;
    const senderName =
      submitted.find((field) => /name/i.test(field.label))?.value ?? null;
    // The message body is the WHOLE submission, labelled.
    //
    // An earlier version used just the longest answer, on the theory that the textarea
    // is the message and the rest is metadata. That silently discarded content: a form
    // asking "budget" and "how did you hear about us" would show the admin one answer
    // and drop the others entirely. Every answer is also kept structurally in `fields`
    // below, but the body is what the notification email and the inbox preview render,
    // so it has to be complete on its own.
    const textareaIds = new Set(
      (endpoint?.fields ?? [])
        .filter((field) => field.field_type === 'textarea' && field.temp_id)
        .map((field) => field.temp_id as string)
    );
    const primary = submitted.find((field) => textareaIds.has(field.key));
    const details = submitted.filter((field) => field !== primary);
    const body = [
      ...(primary ? [primary.value, ''] : []),
      ...details.map((field) => `${field.label}: ${field.value}`),
    ]
      .join('\n')
      .trim();

    if (!body) {
      return { success: false, code: 'empty', message: 'Please fill in the form before submitting.', values };
    }

    const requestHeaders = await headers();
    const ipMasked = maskIp(resolveClientIp(requestHeaders));
    const userAgent = requestHeaders.get('user-agent');
    const locale = (formData.get('locale') as string | null)?.slice(0, 12) || null;

    // Same fail-closed throttle as the enquiry action: this is a public, unauthenticated
    // endpoint that can send mail, and the repo has no shared rate limiter.
    const supabase = getServiceRoleSupabaseClient();
    const since = new Date(Date.now() - THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
    const { count } = await supabase
      .from('message_threads')
      .select('id', { count: 'exact', head: true })
      .eq('ip_masked', ipMasked)
      .gte('created_at', since);
    if ((count ?? 0) >= THROTTLE_MAX_SUBMISSIONS) {
      return {
        success: false,
        code: 'throttled',
        message: "You've sent several messages already. Please wait a few minutes before sending another.",
        values,
      };
    }

    const subjectLabel = endpoint?.label || 'Contact form';

    const thread = await createThread({
      source: 'contact_form',
      // A form block that predates the migration has no key. Fall back to a stable
      // sentinel so the submission is still stored rather than rejected.
      formKey: formKey ?? '00000000-0000-0000-0000-000000000000',
      subjectLabel,
      senderName,
      senderEmail,
      message: body,
      locale,
      fields: Object.fromEntries(submitted.map((field) => [field.label, field.value])),
      ipMasked,
      userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    });

    if (!thread) {
      return {
        success: false,
        code: 'error',
        message: 'Sorry, there was an error sending your message. Please try again later.',
        values,
      };
    }

    after(async () => {
      const recipient = await resolveFormRecipient(endpoint);
      await notifyAdminOfMessage({
        threadId: thread.threadId,
        source: 'contact_form',
        messageId: thread.messageId,
        subjectLabel,
        senderName,
        senderEmail,
        message: body,
        recipient,
        extraFields: submitted.map((field) => ({ label: field.label, value: field.value })),
      });
    });

    return { success: true, message: "Submission successful!" };
  } catch (error) {
    console.error('Form submission failed:', error);
    return {
      success: false,
      code: 'error',
      message: 'Sorry, there was an error sending your message. Please try again later.',
      values,
    };
  }
}
