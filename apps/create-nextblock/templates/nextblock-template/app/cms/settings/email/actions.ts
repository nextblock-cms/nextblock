// app/cms/settings/email/actions.ts
'use server';

import { createClient, isSandboxEnvironment } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import { saveEmailSettings } from '../../../../lib/config/email-settings';
import { sendEmail } from '../../../actions/email';

/**
 * Returned rather than thrown: Next replaces uncaught Server Action error messages with a
 * generic string in production, and the relay's own rejection ("535 authentication failed")
 * is the single most useful thing an admin can see while getting SMTP working.
 */
export type EmailActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Null when the caller is an ADMIN, otherwise the failure to return. */
async function adminCheck(): Promise<EmailActionResult | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'You must be logged in to update settings.' };
  }
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error || !profile || profile.role !== 'ADMIN') {
    return { ok: false, error: 'You do not have permission to perform this action.' };
  }
  return null;
}

export async function updateEmailSettings(formData: FormData): Promise<EmailActionResult> {
  const denied = await adminCheck();
  if (denied) return denied;

  try {
    await saveEmailSettings({
      host: String(formData.get('host') ?? ''),
      port: String(formData.get('port') ?? ''),
      fromEmail: String(formData.get('fromEmail') ?? ''),
      fromName: String(formData.get('fromName') ?? ''),
      secure: formData.get('secure') === 'on' || formData.get('secure') === 'true',
      user: String(formData.get('user') ?? ''),
      pass: String(formData.get('pass') ?? ''),
    });
  } catch (error) {
    console.error('Failed to save email settings:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to save email settings.',
    };
  }

  revalidatePath('/cms/settings/email');
  return { ok: true, message: 'Email settings saved.' };
}

export async function sendTestEmail(formData: FormData): Promise<EmailActionResult> {
  const denied = await adminCheck();
  if (denied) return denied;

  // The sandbox's admin login is public: a test send would mail any address on the
  // deployment's SMTP account.
  if (isSandboxEnvironment()) {
    return { ok: false, error: 'Test emails are turned off in the sandbox.' };
  }

  const to = String(formData.get('to') ?? '').trim();
  if (!to) {
    return { ok: false, error: 'Enter a recipient email address.' };
  }

  try {
    await sendEmail({
      to,
      subject: 'Test email',
      text: 'This is a test email from your CMS. SMTP is configured correctly.',
      html:
        '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '{{brand_header}}' +
        '<p>This is a test email from your CMS. SMTP is configured correctly. 🎉</p>' +
        '</div>',
    });
  } catch (error) {
    console.error('Test email failed:', error);
    // Surface the relay's verbatim complaint — that is the whole point of a test send.
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to send test email.',
    };
  }

  return { ok: true, message: `Test email sent to ${to}.` };
}
