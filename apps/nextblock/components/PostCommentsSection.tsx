"use client";

import React, { useState, useEffect, useTransition, useOptimistic } from "react";
import { createClient } from "@nextblock-cms/db";
import { Button } from "@nextblock-cms/ui/button";
import { Textarea } from "@nextblock-cms/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui/avatar";
import { submitInteraction, toggleReaction } from "../app/actions/interactions";
import { cn, useTranslations } from "@nextblock-cms/utils";
import { MessageSquare, ThumbsUp, Loader2, PenTool } from "lucide-react";
import { StaffReplies, useStaffReplies } from "./StaffReplies";
import { useLabel } from "../lib/i18n/use-label";

interface PostCommentsSectionProps {
  postId: number;
}

export default function PostCommentsSection({ postId }: PostCommentsSectionProps) {
  const { t, lang } = useTranslations();
  // `comments.cancel` and `comments.submitting` were seeded by no migration and `t()` answers
  // a missing key with the key itself, so both buttons showed the raw key to visitors.
  const label = useLabel();
  const [comments, setComments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [user, setUser] = useState<any>(null);

  // Form states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Liked interactions tracking
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  // Optimistic comments list
  const [optimisticComments, setOptimisticComments] = useOptimistic(
    comments,
    (state, { commentId, hasReacted, count }: { commentId: string; hasReacted: boolean; count: number }) =>
      state.map((c) => {
        if (c.id === commentId) {
          const reactions = { ...((c.reactions as Record<string, number>) || {}) };
          reactions.likes = count;
          return { ...c, reactions, tempHasReacted: hasReacted };
        }
        return c;
      })
  );

  // Staff answers for the comments currently on screen.
  const staffReplies = useStaffReplies(comments.map((item: any) => item.id));

  useEffect(() => {
    // 1. Fetch user
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    // 2. Read liked interactions from cookies
    const match = document.cookie.match(/reacted_interactions=([^;]+)/);
    if (match) {
      try {
        setLikedIds(JSON.parse(decodeURIComponent(match[1])));
      } catch (err) {
        console.warn("Failed to parse liked interactions cookie:", err);
      }
    }

    // 3. Load initial comments
    fetchComments(0, true);
  }, [postId]);

  const fetchComments = async (pageNum: number, isInitial = false) => {
    setLoading(true);
    const supabase = createClient();
    const limit = 5;
    const start = pageNum * limit;
    const end = start + limit - 1;

    try {
      const { data, error: dbError } = await supabase
        .from("cms_interactions" as any)
        .select("*, profiles(full_name, avatar_url)")
        .eq("post_id", postId)
        .eq("type", "comment")
        .eq("status", "approved")
        // Staff replies are ALSO type='comment' on the same post, so without this a
        // reply would surface as a top-level comment detached from what it answers.
        .is("parent_id", null)
        .order("created_at", { ascending: false })
        .range(start, end);

      if (dbError) throw dbError;

      if (data) {
        if (isInitial) {
          setComments(data);
          setPage(0);
        } else {
          setComments((prev) => [...prev, ...data]);
          setPage(pageNum);
        }
        setHasMore(data.length === limit);
      }
    } catch (err) {
      console.error("Error fetching comments:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMore = () => {
    fetchComments(page + 1);
  };

  const handleLike = async (commentId: string) => {
    const isLiked = likedIds.includes(commentId);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;

    const currentLikes = (comment.reactions as Record<string, number>)?.likes || 0;
    const nextCount = isLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;

    startTransition(async () => {
      // Apply optimistic update
      setOptimisticComments({ commentId, hasReacted: !isLiked, count: nextCount });

      const res = await toggleReaction(commentId);
      if (res.success) {
        // Update liked cookie state locally
        if (isLiked) {
          setLikedIds((prev) => prev.filter((id) => id !== commentId));
        } else {
          setLikedIds((prev) => [...prev, commentId]);
        }
        // Sync actual state
        setComments((prev) =>
          prev.map((c) => {
            if (c.id === commentId) {
              const reactions = { ...((c.reactions as Record<string, number>) || {}) };
              reactions.likes = res.count ?? nextCount;
              return { ...c, reactions };
            }
            return c;
          })
        );
      }
    });
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      setError(t("comments.login_to_write"));
      return;
    }

    if (content.trim().length < 5) {
      setError(lang === "fr" ? "Votre commentaire doit faire au moins 5 caractères." : "Your comment must be at least 5 characters long.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const res = await submitInteraction({
      type: "comment",
      content: content.trim(),
      postId,
    });

    setSubmitting(false);

    if (res.error) {
      setError(res.error);
    } else {
      setSuccess(t("comments.success_pending"));
      setContent("");
      // Close form after a brief delay
      setTimeout(() => {
        setIsFormOpen(false);
        setSuccess(null);
      }, 3000);
    }
  };

  const getInitials = (profile: any) => {
    if (profile?.full_name) {
      return profile.full_name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    return "U";
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b pb-6 gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <MessageSquare className="h-6 w-6 text-primary" />
            {t("comments.discussion")}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("comments.join_conversation")}
          </p>
        </div>

        {user ? (
          <Button
            aria-expanded={isFormOpen}
            aria-controls="comment-form"
            onClick={() => setIsFormOpen(!isFormOpen)}
            className="flex items-center gap-2 transition-colors"
            variant={isFormOpen ? "outline" : "default"}
          >
            <PenTool className="h-4 w-4" />
            {isFormOpen ? t("comments.cancel_comment") : t("comments.write_comment")}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {t("comments.login_to_write")}
          </p>
        )}
      </div>

      {/* Submission Form */}
      {isFormOpen && (
        <form
          id="comment-form"
          onSubmit={handleSubmitComment}
          className="bg-card/50 border border-border/80 rounded-2xl p-6 shadow-sm space-y-4 animate-in fade-in slide-in-from-top-4 duration-300"
        >
          <h3 className="text-lg font-semibold text-foreground">{t("comments.join_discussion")}</h3>

          {/* Text Area */}
          <div className="space-y-1.5">
            <label
              htmlFor="comment-content"
              className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block"
            >
              {t("comments.your_message")}
            </label>
            <Textarea
              id="comment-content"
              name="comment"
              autoComplete="off"
              placeholder={t("comments.message_placeholder")}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[120px] focus-visible:ring-1 focus-visible:ring-primary"
              disabled={submitting}
              required
            />
          </div>

          {error && <div role="alert" className="text-sm font-semibold text-destructive">{error}</div>}
          {success && <div role="status" className="text-sm font-semibold text-emerald-600">{success}</div>}

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setIsFormOpen(false)}
              disabled={submitting}
            >
              {label("comments.cancel", "Cancel", "Annuler")}
            </Button>
            <Button type="submit" disabled={submitting} className="min-w-[120px]">
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {label("comments.submitting", "Submitting…", "Envoi en cours…")}
                </>
              ) : (
                t("comments.post_comment")
              )}
            </Button>
          </div>
        </form>
      )}

      {/* Comments List */}
      <div className="space-y-6">
        {optimisticComments.length > 0 ? (
          optimisticComments.map((comment) => {
            const hasLiked = likedIds.includes(comment.id) || comment.tempHasReacted;
            const likeCount = (comment.reactions as Record<string, number>)?.likes || 0;
            const commenterName =
              comment.profiles?.full_name || label("interactions.anonymous", "Anonymous", "Anonyme");
            const dateStr = new Date(comment.created_at).toLocaleDateString(lang, {
              year: "numeric",
              month: "long",
              day: "numeric",
            });

            return (
              <div
                key={comment.id}
                className="bg-card border border-border/60 rounded-2xl p-5 shadow-sm space-y-4 hover:border-border/100 transition-colors duration-300"
              >
                {/* Commenter Header */}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 border">
                      <AvatarImage src={comment.profiles?.avatar_url || undefined} alt={commenterName} />
                      <AvatarFallback className="bg-primary/5 text-primary text-xs font-semibold">
                        {getInitials(comment.profiles)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      {/* h3, not h4: the section title is an h2 and nothing sits between. */}
                      <h3 className="text-sm font-semibold text-foreground leading-none">
                        {commenterName}
                      </h3>
                      <span className="text-[10px] text-muted-foreground mt-1.5 block" suppressHydrationWarning>
                        {dateStr}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Comment Content */}
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line break-words text-left">
                  {comment.content}
                </p>

                {/* Reaction Actions */}
                <div className="flex items-center pt-2">
                  <button
                    type="button"
                    aria-pressed={Boolean(hasLiked)}
                    onClick={() => handleLike(comment.id)}
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-[color,background-color,border-color,transform] active:scale-95",
                      hasLiked
                        ? "bg-primary/5 border-primary/20 text-primary"
                        : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-border/100"
                    )}
                  >
                    <ThumbsUp className={cn("h-3.5 w-3.5", hasLiked && "fill-current")} />
                    <span>{t("comments.like")}</span>
                    {likeCount > 0 && <span className="font-semibold ml-0.5">{likeCount}</span>}
                  </button>
                </div>

                <StaffReplies replies={staffReplies[comment.id]} />
              </div>
            );
          })
        ) : (
          !loading && (
            <div className="text-center py-12 border border-dashed rounded-2xl bg-slate-50/50 dark:bg-slate-900/10">
              <MessageSquare className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-700" />
              <h3 className="mt-4 text-sm font-semibold text-foreground">{t("comments.no_comments")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("comments.be_the_first")}
              </p>
            </div>
          )
        )}

        {/* Loading Spinner */}
        {loading && (
          <div role="status" className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="sr-only">{label("loading", "Loading…", "Chargement…")}</span>
          </div>
        )}

        {/* Load More */}
        {hasMore && !loading && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" size="sm" onClick={handleLoadMore}>
              {t("comments.load_more")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
