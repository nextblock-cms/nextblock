'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { requireAdminSupabaseClient } from './require-admin';
import { ensureThreadToken, sendThreadNotice } from '../../../lib/messages/threads';
import { invalidateEmailConfigCache } from '../../../lib/config/email-settings';
import { resolveSiteUrl } from '../../../lib/site-url';

export interface MessageActionState {
  success: boolean;
  message: string;
}

const MAX_REPLY_LENGTH = 5000;

function failure(error: unknown, fallback: string): MessageActionState {
  const message = error instanceof Error ? error.message : fallback;
  return { success: false, message };
}

/**
 * Answer a private conversation.
 *
 * This is the ONLY place a visitor thread token is minted. Deferring it to the first
 * reply means a store that receives a hundred enquiries and answers three has three
 * live credentials rather than a hundred — and an enquiry nobody ever answered never
 * had one at all.
 */
export async function replyToThread(
  threadId: string,
  body: string
): Promise<MessageActionState> {
  try {
    const { userId, fullName } = await requireAdminSupabaseClient();

    const reply = body.trim().slice(0, MAX_REPLY_LENGTH);
    if (!reply) return { success: false, message: 'Write a reply before sending.' };

    const service = getServiceRoleSupabaseClient();

    const { data: thread } = await service
      .from('message_threads')
      .select('id, source, subject_label, sender_name, sender_email, status')
      .eq('id', threadId)
      .maybeSingle();

    if (!thread) return { success: false, message: 'That conversation no longer exists.' };

    const { data: message, error: messageError } = await service
      .from('thread_messages')
      .insert({
        thread_id: threadId,
        direction: 'outbound',
        body: reply,
        author_id: userId,
        author_name: fullName,
      })
      .select('id')
      .single();

    if (messageError || !message) {
      console.error('[messages] Reply insert failed:', messageError?.message);
      return { success: false, message: 'Could not save your reply.' };
    }

    const now = new Date().toISOString();
    await service
      .from('message_threads')
      .update({
        last_message_at: now,
        unread_for_admin: false,
        unread_for_visitor: true,
        // Answering reopens a closed conversation — otherwise the visitor could reply
        // to a thread the CMS still shows as done.
        status: 'open',
      })
      .eq('id', threadId);

    const { token, hasExistingToken } = await ensureThreadToken(threadId);

    // AWAITED, not deferred to after().
    //
    // The public paths defer their notifications because a visitor should not wait on an
    // SMTP round trip. An admin reply is the opposite: someone clicked Send and is owed a
    // truthful answer. Deferring it also raced the page refresh — the row is written with
    // email_delivered at its default of false, so the UI re-rendered before the send
    // finished and reported "Not delivered" for a reply that was about to go out fine.
    await sendThreadNotice({
      threadId,
      source: thread.source as 'product_inquiry' | 'contact_form',
      messageId: message.id,
      subjectLabel: thread.subject_label,
      senderName: thread.sender_name,
      senderEmail: thread.sender_email,
      body: reply,
      token,
      hasExistingToken,
    });

    const { data: delivery } = await service
      .from('thread_messages')
      .select('email_delivered, email_error')
      .eq('id', message.id)
      .maybeSingle();

    revalidatePath('/cms/messages');

    if (!thread.sender_email) {
      return {
        success: true,
        message: 'Reply saved. This sender left no email address, so they will not be notified.',
      };
    }

    return delivery?.email_delivered
      ? { success: true, message: 'Reply sent.' }
      : {
          // The reply itself is safely stored; only delivery failed. Say exactly that,
          // rather than "sent" over a failure or "failed" over a saved reply.
          success: false,
          message: `Reply saved, but it could not be delivered. ${delivery?.email_error ?? ''}`.trim(),
        };
  } catch (error) {
    return failure(error, 'Could not send that reply.');
  }
}

/**
 * Try again to deliver a reply that was written but never sent.
 *
 * The whole design treats the stored row as the record and delivery as best-effort, so
 * an SMTP outage or a misconfiguration leaves real replies sitting unsent. Without this
 * the only way to deliver one is to retype it as a new reply, which also re-notifies the
 * visitor about a message they may already have.
 *
 * Drops the SMTP config cache first: the usual reason a retry is being attempted is that
 * the settings were just corrected, and a cached transport would fail the same way.
 */
export async function retryThreadDelivery(messageId: string): Promise<MessageActionState> {
  try {
    await requireAdminSupabaseClient();
    const service = getServiceRoleSupabaseClient();

    const { data: message } = await service
      .from('thread_messages')
      .select('id, thread_id, body, direction, email_delivered')
      .eq('id', messageId)
      .maybeSingle();

    if (!message) return { success: false, message: 'That reply no longer exists.' };
    if (message.direction !== 'outbound') {
      return { success: false, message: 'Only replies you sent can be re-delivered.' };
    }
    if (message.email_delivered) {
      return { success: false, message: 'That reply was already delivered.' };
    }

    const { data: thread } = await service
      .from('message_threads')
      .select('id, source, subject_label, sender_name, sender_email')
      .eq('id', message.thread_id)
      .maybeSingle();

    if (!thread) return { success: false, message: 'That conversation no longer exists.' };
    if (!thread.sender_email) {
      return { success: false, message: 'This sender left no email address, so there is nowhere to deliver it.' };
    }

    invalidateEmailConfigCache();

    const { token, hasExistingToken } = await ensureThreadToken(thread.id);

    // Awaited rather than deferred: the admin clicked a button and is waiting to learn
    // whether it worked this time.
    await sendThreadNotice({
      threadId: thread.id,
      source: thread.source as 'product_inquiry' | 'contact_form',
      messageId: message.id,
      subjectLabel: thread.subject_label,
      senderName: thread.sender_name,
      senderEmail: thread.sender_email,
      body: message.body,
      token,
      hasExistingToken,
    });

    const { data: after } = await service
      .from('thread_messages')
      .select('email_delivered, email_error')
      .eq('id', message.id)
      .maybeSingle();

    revalidatePath('/cms/messages');
    return after?.email_delivered
      ? { success: true, message: 'Delivered.' }
      : { success: false, message: after?.email_error || 'Still could not deliver that reply.' };
  } catch (error) {
    return failure(error, 'Could not re-send that reply.');
  }
}

/** Open or close a conversation. Mirrors the flag onto the originating enquiry row. */
export async function setThreadStatus(
  threadId: string,
  status: 'open' | 'closed'
): Promise<MessageActionState> {
  try {
    await requireAdminSupabaseClient();
    const service = getServiceRoleSupabaseClient();

    const { data: thread } = await service
      .from('message_threads')
      .select('source, subject_id')
      .eq('id', threadId)
      .maybeSingle();

    const { error } = await service
      .from('message_threads')
      .update({ status, unread_for_admin: false })
      .eq('id', threadId);

    if (error) return { success: false, message: 'Could not update that conversation.' };

    // Keep the enquiry list truthful — it has its own is_resolved flag.
    if (thread?.source === 'product_inquiry' && thread.subject_id) {
      await service
        .from('product_inquiries')
        .update({ is_resolved: status === 'closed' })
        .eq('id', thread.subject_id);
    }

    revalidatePath('/cms/messages');
    return { success: true, message: status === 'closed' ? 'Marked as handled.' : 'Reopened.' };
  } catch (error) {
    return failure(error, 'Could not update that conversation.');
  }
}

export async function markThreadRead(threadId: string): Promise<MessageActionState> {
  try {
    await requireAdminSupabaseClient();
    const service = getServiceRoleSupabaseClient();
    await service.from('message_threads').update({ unread_for_admin: false }).eq('id', threadId);
    revalidatePath('/cms/messages');
    return { success: true, message: '' };
  } catch (error) {
    return failure(error, 'Could not update that conversation.');
  }
}

/**
 * Kill a visitor's link without destroying the conversation.
 *
 * The row is kept deliberately: its hash stays in the unique index, so a revoked token
 * can never be re-minted onto a different thread, and the history survives. Thread rows
 * cannot be deleted at all — `thread_messages` is append-only and the cascade would
 * trip its trigger — so "delete" in this UI means closed plus revoked.
 */
export async function revokeThreadLink(threadId: string): Promise<MessageActionState> {
  try {
    await requireAdminSupabaseClient();
    const service = getServiceRoleSupabaseClient();
    const { error } = await service
      .from('message_threads')
      .update({ token_revoked_at: new Date().toISOString() })
      .eq('id', threadId);

    if (error) return { success: false, message: 'Could not revoke that link.' };

    revalidatePath('/cms/messages');
    return {
      success: true,
      message: 'Link revoked. The next reply you send will issue a fresh one.',
    };
  } catch (error) {
    return failure(error, 'Could not revoke that link.');
  }
}

/**
 * Mint a fresh visitor link and hand it back to the admin, without sending anything.
 *
 * The notification email is best-effort by design, and a recipient's own filtering can
 * remove a message after it has been accepted by every hop — Microsoft's ZAP does exactly
 * that, silently and with no bounce. When that happens the conversation is not broken,
 * only the delivery is: the thread, the reply and a valid link all still exist.
 *
 * This is the manual channel. The admin copies the link and sends it however actually
 * works — their own mail client, a chat message, over the phone. Same rotation rule as a
 * reply: minting a new one retires the previous link.
 */
export async function createVisitorLink(
  threadId: string
): Promise<MessageActionState & { url?: string }> {
  try {
    await requireAdminSupabaseClient();

    const { token } = await ensureThreadToken(threadId);
    if (!token) {
      return { success: false, message: 'Could not create a link for that conversation.' };
    }

    revalidatePath('/cms/messages');
    return {
      success: true,
      message: 'Link copied. It replaces any link sent earlier.',
      url: `${resolveSiteUrl()}/thread/${token}`,
    };
  } catch (error) {
    return failure(error, 'Could not create a link for that conversation.');
  }
}

/**
 * Save where a contact form's submissions go, plus the server-trusted field manifest.
 * Called from the form block editor — the address lives here, never in block content.
 */
export async function saveFormEndpoint(
  formKey: string,
  label: string,
  recipientEmail: string,
  fields: Array<{ temp_id?: string; label?: string; field_type?: string }>
): Promise<MessageActionState> {
  try {
    await requireAdminSupabaseClient();

    const email = recipientEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: "That doesn't look like a valid email address." };
    }

    const service = getServiceRoleSupabaseClient();
    const { error } = await service.from('form_endpoints').upsert({
      form_key: formKey,
      label: label.trim() || 'Contact form',
      recipient_email: email || null,
      fields: fields.map((field) => ({
        temp_id: field.temp_id,
        label: field.label,
        field_type: field.field_type,
      })),
    });

    if (error) {
      console.error('[messages] Could not save form endpoint:', error.message);
      return { success: false, message: 'Could not save the form settings.' };
    }

    return {
      success: true,
      message: email
        ? 'Saved. Submissions will be emailed there and stored in Messages.'
        : 'Saved. Submissions will use your site contact address and are stored in Messages.',
    };
  } catch (error) {
    return failure(error, 'Could not save the form settings.');
  }
}

/**
 * Current endpoint settings for the block editor.
 *
 * Readable by WRITERs as well as ADMINs, matching form_endpoints_editor_read_policy —
 * WRITERs can edit pages and therefore open this block, and showing them an empty field
 * would read as "no address configured" rather than "you may not change this". Writing
 * stays ADMIN-only; `canEdit` tells the UI which to render.
 */
export async function getFormEndpointForEditor(
  formKey: string
): Promise<{ label: string; recipientEmail: string; canEdit: boolean } | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') return null;

    const service = getServiceRoleSupabaseClient();
    const { data } = await service
      .from('form_endpoints')
      .select('label, recipient_email')
      .eq('form_key', formKey)
      .maybeSingle();

    const canEdit = profile.role === 'ADMIN';
    if (!data) return { label: '', recipientEmail: '', canEdit };
    return {
      label: data.label ?? '',
      recipientEmail: data.recipient_email ?? '',
      canEdit,
    };
  } catch {
    return null;
  }
}
