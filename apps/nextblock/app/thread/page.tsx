import { headers } from 'next/headers';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { getCookieValue } from '../../lib/auth/cookies';
import {
  THREAD_COOKIE,
  touchThreadToken,
  verifyThreadToken,
} from '../../lib/messages/thread-token';
import ThreadView, { type ThreadMessage } from './ThreadView';

// A conversation changes whenever either side writes; a cached copy would show the
// visitor a reply that is no longer the latest, or hide one that just arrived.
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const MAX_MESSAGES = 200;

/**
 * The visitor's half of a private conversation.
 *
 * Authentication is the HttpOnly cookie set by `/thread/[token]`, verified here in
 * application code and then read with the service role — no RLS policy in this schema
 * authenticates an anonymous caller by token, and this page does not invent one.
 *
 * There is exactly one failure page. A visitor whose link expired, was revoked, or never
 * existed sees the same words, because anything else would let someone probe for valid
 * threads.
 */
export default async function ThreadPage() {
  const supabase = getServiceRoleSupabaseClient();
  const token = await getCookieValue(THREAD_COOKIE);
  const check = await verifyThreadToken(supabase, token);

  if (!check.valid) {
    return <ThreadView invalid />;
  }

  const thread = check.thread;

  const [{ data: rows }, botProtection, scriptNonce] = await Promise.all([
    supabase
      .from('thread_messages')
      .select('id, direction, body, author_name, created_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true })
      .limit(MAX_MESSAGES),
    loadBotProtection(supabase),
    loadNonce(),
  ]);

  // The visitor is looking at it, so it is no longer unread for them.
  if (thread.unread_for_visitor) {
    await supabase
      .from('message_threads')
      .update({ unread_for_visitor: false })
      .eq('id', thread.id);
  }
  await touchThreadToken(supabase, thread.id);

  return (
    <ThreadView
      subjectLabel={thread.subject_label}
      closed={thread.status === 'closed'}
      messages={(rows ?? []) as ThreadMessage[]}
      botProtectionProvider={botProtection.provider}
      botProtectionSiteKey={botProtection.siteKey}
      scriptNonce={scriptNonce}
    />
  );
}

async function loadBotProtection(supabase: {
  from: (table: string) => any;
}): Promise<{ provider: 'none' | 'turnstile' | 'recaptcha'; siteKey: string }> {
  try {
    const { data } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'bot_protection_public')
      .maybeSingle();
    if (data?.value) {
      const value = data.value as Record<string, any>;
      return { provider: value.provider || 'none', siteKey: value.siteKey || '' };
    }
  } catch (error) {
    console.error('[thread] Could not load bot protection settings:', error);
  }
  return { provider: 'none', siteKey: '' };
}

// The route is force-dynamic (above), so headers() never throws here.
async function loadNonce(): Promise<string> {
  return (await headers()).get('x-nonce') || '';
}
