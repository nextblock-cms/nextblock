'use server';

import 'server-only';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { getCookieValue } from '../../lib/auth/cookies';
import { THREAD_COOKIE, verifyThreadToken } from '../../lib/messages/thread-token';
import {
  getFormEndpoint,
  notifyAdminOfMessage,
  resolveFormRecipient,
} from '../../lib/messages/threads';
import { resolveSellerContactEmail } from '../../lib/commerce/seller-contact';
import { verifyBotProtection } from '../../lib/botProtection/verify';

/**
 * A visitor replying on their own thread page.
 *
 * The token is read from the HttpOnly COOKIE, never from a form field — so it is never
 * in a POST body, never in a client-side variable, and cannot be swapped by editing the
 * request. Everything else here mirrors the enquiry action: bot protection first, a
 * fail-closed per-IP throttle, then a write.
 */

const MAX_BODY_LENGTH = 5000;
const MAX_USER_AGENT_LENGTH = 500;
const THROTTLE_WINDOW_MINUTES = 10;
const THROTTLE_MAX_REPLIES = 10;
const UNKNOWN_IP_BUCKET = 'unknown';

export interface ThreadReplyState {
  success: boolean;
  messageKey: 'thread.sent' | 'thread.error' | 'thread.throttled' | 'thread.closed' | '';
  message?: string;
}

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
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

export async function submitThreadReply(
  _prevState: unknown,
  formData: FormData
): Promise<ThreadReplyState> {
  const verification = await verifyBotProtection(formData);
  if (!verification.ok) {
    if (verification.reason === 'honeypot') {
      return { success: true, messageKey: 'thread.sent' };
    }
    return { success: false, messageKey: '', message: verification.message };
  }

  const rawBody = formData.get('body');
  const body = typeof rawBody === 'string' ? rawBody.trim().slice(0, MAX_BODY_LENGTH) : '';
  if (!body) return { success: false, messageKey: 'thread.error' };

  try {
    const supabase = getServiceRoleSupabaseClient();

    const token = await getCookieValue(THREAD_COOKIE);
    const check = await verifyThreadToken(supabase, token);
    if (!check.valid) return { success: false, messageKey: 'thread.error' };

    const thread = check.thread;
    if (thread.status === 'closed') return { success: false, messageKey: 'thread.closed' };

    const requestHeaders = await headers();
    const ipMasked = maskIp(
      firstHop(requestHeaders.get('x-vercel-forwarded-for')) ??
        firstHop(requestHeaders.get('x-real-ip')) ??
        firstHop(requestHeaders.get('x-forwarded-for'))
    );
    const userAgent = requestHeaders.get('user-agent');

    const since = new Date(Date.now() - THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
    const { count } = await supabase
      .from('thread_messages')
      .select('id', { count: 'exact', head: true })
      .eq('ip_masked', ipMasked)
      .gte('created_at', since);
    if ((count ?? 0) >= THROTTLE_MAX_REPLIES) {
      return { success: false, messageKey: 'thread.throttled' };
    }

    const { data: message, error } = await supabase
      .from('thread_messages')
      .insert({
        thread_id: thread.id,
        direction: 'inbound',
        body,
        author_name: thread.sender_name,
        ip_masked: ipMasked,
      })
      .select('id')
      .single();

    if (error || !message) {
      console.error('[thread] Could not store a visitor reply:', error?.message);
      return { success: false, messageKey: 'thread.error' };
    }

    await supabase
      .from('message_threads')
      .update({
        last_message_at: new Date().toISOString(),
        unread_for_admin: true,
        unread_for_visitor: false,
        // A visitor writing back REOPENS the conversation. Marking it handled was a
        // statement about the last exchange, not a permanent verdict — leaving it closed
        // would drop their reply out of the inbox's default view, which is precisely
        // where someone waiting on an answer must not go.
        status: 'open',
        user_agent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      })
      .eq('id', thread.id);

    after(async () => {
      // Route the notice the same way the original submission was routed, so a
      // contact-form conversation keeps reaching that form's address.
      const recipient =
        thread.source === 'contact_form'
          ? await resolveFormRecipient(
              // Load the ORIGINATING form's endpoint. Passing null here would skip the
              // per-form address entirely and quietly deliver a careers-form follow-up
              // to the general mailbox.
              thread.form_key ? await getFormEndpoint(thread.form_key) : null
            )
          : (await resolveSellerContactEmail()).email;

      await notifyAdminOfMessage({
        threadId: thread.id,
        source: thread.source as 'product_inquiry' | 'contact_form',
        messageId: message.id,
        subjectLabel: thread.subject_label,
        senderName: thread.sender_name,
        senderEmail: thread.sender_email,
        message: body,
        recipient,
      });
    });

    revalidatePath('/thread');
    return { success: true, messageKey: 'thread.sent' };
  } catch (error) {
    console.error('[thread] Visitor reply failed:', error);
    return { success: false, messageKey: 'thread.error' };
  }
}
