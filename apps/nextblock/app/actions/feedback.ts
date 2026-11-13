"use server";

import { createClient } from "@nextblock-cms/db/server";
import { PRODUCT_FEEDBACK_INBOX, sendEmail } from "./email";

interface FeedbackData {
  subject: string;
  message: string;
  /** Accepted for call-site compatibility but ignored — identity comes from the session. */
  userEmail?: string;
  userName?: string;
  url?: string;
}

const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_URL_LENGTH = 500;

/** Everything below is attacker-controlled text landing in an HTML email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function submitFeedback(data: FeedbackData) {
  try {
    // This is a client-callable action, so the CMS-only modal in front of it is not a
    // gate: without this check any unauthenticated caller could relay arbitrary mail
    // through the tenant's SMTP credentials.
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return { success: false, error: "You must be signed in to send feedback." };
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') {
      return { success: false, error: "You do not have permission to send feedback." };
    }

    const subject = (data.subject ?? '').slice(0, MAX_SUBJECT_LENGTH);
    const message = (data.message ?? '').slice(0, MAX_MESSAGE_LENGTH);
    const url = (data.url ?? '').slice(0, MAX_URL_LENGTH);
    if (!message.trim()) {
      return { success: false, error: "Feedback message is empty." };
    }

    // Identity is read from the session rather than the request body — the client cannot
    // choose whose name a report is filed under.
    const senderEmail = user.email ?? 'unknown';
    const senderName = profile?.full_name || senderEmail;

    const htmlContent = `
      {{brand_header}}
      <h2>New Feedback Received</h2>
      <p><strong>From:</strong> ${escapeHtml(senderName)} (${escapeHtml(senderEmail)})</p>
      <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
      <p><strong>URL:</strong> ${escapeHtml(url) || 'N/A'}</p>
      <br/>
      <h3>Message:</h3>
      <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
    `;

    const textContent = `
      New Feedback Received
      From: ${senderName} (${senderEmail})
      Subject: ${subject}
      URL: ${url || 'N/A'}

      Message:
      ${message}
    `;

    await sendEmail({
      // Fixed in code, so the sandbox still delivers it (sendEmail allows no visitor-chosen inbox there).
      to: PRODUCT_FEEDBACK_INBOX,
      // Newlines in a header would let a caller inject extra headers (Bcc, …).
      subject: `[CMS Feedback] ${subject.replace(/[\r\n]+/g, ' ')}`,
      text: textContent,
      html: htmlContent,
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to submit feedback:", error);
    return { success: false, error: "Failed to send feedback email." };
  }
}
