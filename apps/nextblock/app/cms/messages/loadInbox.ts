import 'server-only';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { requireCmsStaff } from '../../../lib/auth/cms-actor';

/**
 * One inbox over two storage models.
 *
 * Private conversations (product enquiries, contact forms) live in `message_threads`;
 * public reviews and post comments live in `cms_interactions`. They are not merged into
 * one table because they are genuinely different: an enquiry is anonymous, targets
 * nothing in particular and is never published, while a review belongs to a registered
 * account, must target exactly one product or post, and is already on the site. Forcing
 * either into the other's shape would break something real — the ratings trigger, or the
 * account foreign key.
 *
 * So the merge happens here, in the read path, where it costs nothing but a sort.
 */

export const PAGE_SIZE = 25;

export type InboxSource = 'product_inquiry' | 'contact_form' | 'review' | 'comment';

export interface InboxItem {
  /** Which storage model this came from — the detail pane branches on it. */
  kind: 'thread' | 'interaction';
  id: string;
  source: InboxSource;
  subjectLabel: string;
  senderName: string | null;
  senderEmail: string | null;
  preview: string;
  rating: number | null;
  /** 'open' | 'closed' for threads; the approval status for interactions. */
  status: string;
  unread: boolean;
  emailDelivered: boolean | null;
  targetHref: string | null;
  lastActivityAt: string;
}

export interface InboxCounts {
  product_inquiry: number;
  contact_form: number;
  review: number;
  comment: number;
}

export interface InboxPage {
  items: InboxItem[];
  counts: InboxCounts;
  hasMore: boolean;
  /** How many handled items the default view is hiding. */
  handledCount: number;
  /** True when the viewer cannot see private threads, so the UI can explain the gap. */
  privateHidden: boolean;
}

function preview(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export async function loadInbox(options: {
  source?: string;
  page?: number;
  isAdmin: boolean;
  /** Include conversations already dealt with. Off by default: the inbox is a to-do
   *  list, and a closed thread has nothing left to do. */
  showHandled?: boolean;
}): Promise<InboxPage> {
  const page = Math.max(0, options.page ?? 0);
  const wanted = PAGE_SIZE * (page + 1);
  const source = options.source;

  const showHandled = options.showHandled === true;
  const items: InboxItem[] = [];
  let handledCount = 0;
  const counts: InboxCounts = { product_inquiry: 0, contact_form: 0, review: 0, comment: 0 };
  // Tracks whether either lane came back full. Slicing a merged list cannot tell the
  // difference between "that is everything" and "that is all I asked for".
  let laneFilled = false;

  // Private threads are ADMIN-only, by RLS and by this check. A WRITER gets the public
  // half of the inbox and is told the rest exists rather than shown an empty tab.
  const canSeeThreads = options.isAdmin;
  const wantsThreads = !source || source === 'product_inquiry' || source === 'contact_form';
  const wantsInteractions = !source || source === 'review' || source === 'comment';

  // Counted for EVERY tab, not just the active one. Computing them inside the fetch
  // branches made a badge vanish the moment you clicked the tab it belonged to.
  const countUnreadThreads = async (threadSource: 'product_inquiry' | 'contact_form') => {
    if (!canSeeThreads) return 0;
    const { count } = await getServiceRoleSupabaseClient()
      .from('message_threads')
      .select('id', { count: 'exact', head: true })
      .eq('source', threadSource)
      .eq('unread_for_admin', true);
    return count ?? 0;
  };
  const countPendingInteractions = async (type: 'review' | 'comment') => {
    const { count } = await createClient()
      .from('cms_interactions')
      .select('id', { count: 'exact', head: true })
      .eq('type', type)
      .eq('status', 'pending')
      .is('parent_id', null);
    return count ?? 0;
  };

  const countHandled = async (): Promise<number> => {
    const [threads, interactions] = await Promise.all([
      canSeeThreads
        ? getServiceRoleSupabaseClient()
            .from('message_threads')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'closed')
            .then(({ count }) => count ?? 0)
        : Promise.resolve(0),
      createClient()
        .from('cms_interactions')
        .select('id', { count: 'exact', head: true })
        .neq('status', 'pending')
        .is('parent_id', null)
        .then(({ count }) => count ?? 0),
    ]);
    return threads + interactions;
  };

  const [inquiryCount, formCount, reviewCount, commentCount, hiddenCount] = await Promise.all([
    countUnreadThreads('product_inquiry').catch(() => 0),
    countUnreadThreads('contact_form').catch(() => 0),
    countPendingInteractions('review').catch(() => 0),
    countPendingInteractions('comment').catch(() => 0),
    countHandled().catch(() => 0),
  ]);
  handledCount = hiddenCount;
  counts.product_inquiry = inquiryCount;
  counts.contact_form = formCount;
  counts.review = reviewCount;
  counts.comment = commentCount;

  if (canSeeThreads && wantsThreads) {
    const service = getServiceRoleSupabaseClient();
    let query = service
      .from('message_threads')
      .select(
        'id, source, subject_label, sender_name, sender_email, status, unread_for_admin, last_message_at'
      )
      .order('last_message_at', { ascending: false })
      .limit(wanted);
    if (source) query = query.eq('source', source);
    if (!showHandled) query = query.eq('status', 'open');

    const { data: threads } = await query;
    if ((threads?.length ?? 0) >= wanted) laneFilled = true;

    // One extra probe for the latest line of each thread, rather than N.
    const threadIds = (threads ?? []).map((thread) => thread.id);
    const latestByThread = new Map<
      string,
      { body: string; email_delivered: boolean; email_error: string | null }
    >();
    if (threadIds.length > 0) {
      // Newest first, and keep the FIRST row seen per thread. Ascending order plus
      // overwrite looks equivalent but degrades catastrophically: PostgREST caps a
      // result at max_rows (1000), which under an ascending sort truncates exactly the
      // newest messages — so a busy inbox would quietly show every thread's opening
      // line forever, with a delivery badge to match.
      const { data: messages } = await service
        .from('thread_messages')
        .select('thread_id, body, email_delivered, email_error, created_at')
        .in('thread_id', threadIds)
        .order('created_at', { ascending: false })
        .limit(threadIds.length * 8);
      for (const message of messages ?? []) {
        if (latestByThread.has(message.thread_id)) continue;
        latestByThread.set(message.thread_id, {
          body: message.body,
          email_delivered: message.email_delivered,
          email_error: message.email_error,
        });
      }
    }

    for (const thread of threads ?? []) {
      const latest = latestByThread.get(thread.id);
      items.push({
        kind: 'thread',
        id: thread.id,
        source: thread.source as InboxSource,
        subjectLabel: thread.subject_label,
        senderName: thread.sender_name,
        senderEmail: thread.sender_email,
        preview: preview(latest?.body ?? ''),
        rating: null,
        status: thread.status,
        unread: thread.unread_for_admin,
        // null means "nothing to report" — either delivered, or not yet attempted.
        // Only a recorded error is worth flagging to the admin as a problem.
        emailDelivered: latest ? (latest.email_error ? false : latest.email_delivered || null) : null,
        targetHref: null,
        lastActivityAt: thread.last_message_at,
      });
    }
  }

  if (wantsInteractions) {
    // Staff-only (the page checked; this re-checks, memoised per request) and read with the
    // service role: the row embeds the author's name from `profiles`, and other accounts'
    // rows sit behind `is_admin_mfa()` since migration 02023, so through the cookie client
    // an ADMIN on an aal1 "remember this device" session would see every sender as blank.
    // The interaction rows themselves are what RLS already shows every ADMIN and WRITER.
    const { supabase } = await requireCmsStaff();
    let query = supabase
      .from('cms_interactions')
      .select(
        'id, type, status, content, rating, created_at, product_id, post_id, profiles(full_name), products(title, slug), posts(title, slug)'
      )
      // Staff replies are themselves rows here; the inbox lists what was answered.
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(wanted);
    if (source === 'review' || source === 'comment') query = query.eq('type', source);
    // "Handled" for a review or comment means it has been moderated either way.
    if (!showHandled) query = query.eq('status', 'pending');

    const { data: interactions } = await query;
    if ((interactions?.length ?? 0) >= wanted) laneFilled = true;

    for (const row of interactions ?? []) {
      const product = row.products as { title?: string; slug?: string } | null;
      const post = row.posts as { title?: string; slug?: string } | null;
      const author = row.profiles as { full_name?: string } | null;
      items.push({
        kind: 'interaction',
        id: row.id,
        source: row.type as InboxSource,
        subjectLabel: product?.title || post?.title || 'Content',
        senderName: author?.full_name ?? null,
        senderEmail: null,
        preview: preview(row.content),
        rating: row.rating,
        status: row.status,
        // Pending is a moderation state, not a per-user read marker — there is no read
        // marker for interactions anywhere in the schema. Treated as "needs attention".
        unread: row.status === 'pending',
        emailDelivered: null,
        targetHref: product?.slug
          ? `/product/${product.slug}`
          : post?.slug
            ? `/article/${post.slug}`
            : null,
        lastActivityAt: row.created_at,
      });
    }
  }

  items.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );

  const start = page * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    counts,
    // Either the merged list overflows the page, or a lane hit its own ceiling and is
    // still holding rows back.
    hasMore: items.length > start + PAGE_SIZE || laneFilled,
    handledCount,
    privateHidden: !canSeeThreads,
  };
}

export interface ThreadDetail {
  id: string;
  subjectLabel: string;
  senderName: string | null;
  senderEmail: string | null;
  status: string;
  hasLiveLink: boolean;
  /** Every answer a contact form collected, so none is unreachable in the CMS. */
  fields: Array<{ label: string; value: string }>;
  messages: Array<{
    id: string;
    direction: string;
    body: string;
    author_name: string | null;
    email_delivered: boolean;
    email_error: string | null;
    created_at: string;
  }>;
}

/** Full history for one private conversation. ADMIN only. */
export async function loadThreadDetail(threadId: string): Promise<ThreadDetail | null> {
  const service = getServiceRoleSupabaseClient();

  const { data: thread } = await service
    .from('message_threads')
    .select(
      'id, subject_label, sender_name, sender_email, status, fields, token_hash, token_revoked_at, token_expires_at'
    )
    .eq('id', threadId)
    .maybeSingle();

  if (!thread) return null;

  const { data: messages } = await service
    .from('thread_messages')
    .select('id, direction, body, author_name, email_delivered, email_error, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  const hasLiveLink = Boolean(
    thread.token_hash &&
      !thread.token_revoked_at &&
      thread.token_expires_at &&
      new Date(thread.token_expires_at).getTime() > Date.now()
  );

  return {
    id: thread.id,
    subjectLabel: thread.subject_label,
    senderName: thread.sender_name,
    senderEmail: thread.sender_email,
    status: thread.status,
    hasLiveLink,
    fields:
      thread.fields && typeof thread.fields === 'object' && !Array.isArray(thread.fields)
        ? Object.entries(thread.fields as Record<string, unknown>).map(([label, value]) => ({
            label,
            value: String(value ?? ''),
          }))
        : [],
    messages: messages ?? [],
  };
}
