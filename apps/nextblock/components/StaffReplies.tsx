'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@nextblock-cms/db';
import { useTranslations } from '@nextblock-cms/utils';
import { ShieldCheck } from 'lucide-react';

/**
 * Staff answers rendered under the review or comment they belong to.
 *
 * A reply is stored as an ordinary approved `type='comment'` row carrying its parent's
 * target, so it is readable through the same public RLS policy the parent is — no
 * special access, nothing new exposed. It is fetched separately rather than joined
 * because the parents arrive one page at a time.
 *
 * Shared by the product-reviews and post-comments sections, which are otherwise near
 * duplicates of each other.
 */

export interface StaffReply {
  id: string;
  content: string;
  created_at: string;
  parent_id: string;
  profiles?: { full_name?: string | null } | null;
}

/** One query for a whole page of parents, keyed by parent id. */
export function useStaffReplies(parentIds: string[]): Record<string, StaffReply[]> {
  const [byParent, setByParent] = useState<Record<string, StaffReply[]>>({});
  const key = parentIds.join(',');

  useEffect(() => {
    if (parentIds.length === 0) {
      setByParent({});
      return;
    }

    let cancelled = false;
    const supabase = createClient();

    void supabase
      .from('cms_interactions' as any)
      .select('id, content, created_at, parent_id, profiles(full_name)')
      .in('parent_id', parentIds)
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .then(({ data }: { data: StaffReply[] | null }) => {
        if (cancelled || !data) return;
        const grouped: Record<string, StaffReply[]> = {};
        for (const reply of data) {
          (grouped[reply.parent_id] ??= []).push(reply);
        }
        setByParent(grouped);
      });

    return () => {
      cancelled = true;
    };
    // Keyed on the joined id list rather than the array: `parentIds` is a fresh array on
    // every render, so depending on it directly would refetch forever.
  }, [key]);

  return byParent;
}

export function StaffReplies({ replies }: { replies: StaffReply[] | undefined }) {
  const { t, lang } = useTranslations();

  if (!replies || replies.length === 0) return null;

  const badge = t('interactions.staff_badge');
  const badgeLabel = badge === 'interactions.staff_badge' ? 'Staff' : badge;

  return (
    <ol className="mt-4 space-y-3 border-l-2 border-primary/25 pl-4">
      {replies.map((reply) => (
        <li key={reply.id} className="rounded-xl bg-primary/5 p-3">
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase leading-none text-primary">
              <ShieldCheck className="h-3 w-3" />
              {badgeLabel}
            </span>
            <span className="text-xs font-semibold text-foreground">
              {reply.profiles?.full_name || 'Support'}
            </span>
            <time className="text-[10px] text-muted-foreground" suppressHydrationWarning>
              {new Date(reply.created_at).toLocaleDateString(lang, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          </div>
          <p className="whitespace-pre-line text-sm leading-relaxed break-words text-slate-600 dark:text-slate-300">
            {reply.content}
          </p>
        </li>
      ))}
    </ol>
  );
}
