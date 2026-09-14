"use server";

/**
 * Visibility actions — the ONLY writes that can change what the public sees.
 *
 * These deliberately bypass the Live Draft pipeline (`content_drafts` /
 * `product_drafts`) entirely: they read nothing from a draft, create nothing, and
 * leave any pending content edits exactly where they are. Publishing a page and
 * publishing your unsaved edits are two different decisions, so they are two
 * different code paths.
 *
 * Visibility is stored as the (status, published_at) pair — see
 * `libs/utils/src/lib/publishing.ts` for how "scheduled" is derived from it.
 */

import { createClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import {
  LIVE_STATUS,
  isFutureSchedule,
  resolveVisibilityState,
  type PublishableType,
  type VisibilityState,
} from "@nextblock-cms/utils";
import { getHomepageTranslationGroupId } from "../lib/homepage";
import { revalidatePublicContent } from "../../lib/public-content-cache";

export interface VisibilityResult {
  error?: string;
  state?: VisibilityState;
  publishedAt?: string | null;
}

/** What the caller wants the content to become. */
export type VisibilityIntent =
  | { action: "publish" }
  | { action: "schedule"; publishedAt: string }
  | { action: "unpublish" }
  | { action: "archive" };

const TABLE: Record<PublishableType, "pages" | "posts" | "products"> = {
  page: "pages",
  post: "posts",
  product: "products",
};

const CMS_LIST_PATH: Record<PublishableType, string> = {
  page: "/cms/pages",
  post: "/cms/posts",
  product: "/cms/products",
};

function publicPath(type: PublishableType, slug: string): string {
  if (type === "post") return `/article/${slug}`;
  if (type === "product") return `/product/${slug}`;
  return `/${slug}`;
}

/**
 * Turn an intent into the columns to write.
 *
 * "Publish" always clears `published_at`. Leaving a past timestamp behind would be
 * harmless for the public gate but would keep rendering as a stale schedule in the
 * CMS; leaving a FUTURE one would mean "Publish now" silently did nothing.
 */
function buildUpdate(type: PublishableType, intent: VisibilityIntent) {
  const liveStatus = LIVE_STATUS[type];

  switch (intent.action) {
    case "publish":
      return { status: liveStatus, published_at: null };
    case "schedule":
      return { status: liveStatus, published_at: intent.publishedAt };
    case "unpublish":
      return { status: "draft", published_at: null };
    case "archive":
      return { status: "archived", published_at: null };
  }
}

/**
 * Set a page/post/product's visibility directly on its row.
 *
 * `id` is a number for pages and posts, a uuid string for products.
 */
export async function setContentVisibility(
  type: PublishableType,
  id: number | string,
  intent: VisibilityIntent,
): Promise<VisibilityResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "You must be signed in to change visibility." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    return { error: "You do not have permission to change visibility." };
  }

  if (intent.action === "schedule" && !isFutureSchedule(intent.publishedAt)) {
    return { error: "Pick a date and time in the future, or publish now instead." };
  }

  const update = buildUpdate(type, intent);
  const { data: row, error } = await supabase
    .from(TABLE[type])
    .update({ ...update, updated_at: new Date().toISOString() } as never)
    .eq("id", id as never)
    .select("slug, status, published_at, translation_group_id")
    .single();

  if (error || !row) {
    return { error: error?.message || "Could not update visibility." };
  }

  const updated = row as unknown as {
    slug: string | null;
    status: string;
    published_at: string | null;
    translation_group_id: string | null;
  };

  revalidatePath(CMS_LIST_PATH[type]);
  revalidatePath(`${CMS_LIST_PATH[type]}/${id}/edit`);

  if (updated.slug) {
    revalidatePath(publicPath(type, updated.slug));
  }

  // The public page/post reads are cached (lib/public-content-cache.ts): evict them so
  // the new visibility is what the very next request sees, from every path.
  if (type === "page" || type === "post") {
    revalidatePublicContent(type === "page" ? "pages" : "posts");
  }

  // Every language variation of the homepage is also served at "/", whatever its
  // slug, so taking one down (or putting it up) has to bust that cache too.
  if (type === "page") {
    const homepageGroupId = await getHomepageTranslationGroupId(supabase);
    if (
      (homepageGroupId && updated.translation_group_id === homepageGroupId) ||
      updated.slug === "home"
    ) {
      revalidatePath("/");
    }
  }

  if (type === "post") {
    revalidatePath("/articles");
  }

  return {
    state: resolveVisibilityState({
      status: updated.status,
      publishedAt: updated.published_at,
      liveStatus: LIVE_STATUS[type],
    }),
    publishedAt: updated.published_at,
  };
}

/**
 * Sibling-language versions of the same content, with their visibility state.
 *
 * Status is per-row, so publishing the French page does nothing for English. The
 * publish dialog shows this list to catch the half-published translation — the
 * single most common multilingual mistake.
 */
export interface SiblingVisibility {
  id: number | string;
  languageId: number;
  title: string;
  state: VisibilityState;
}

export async function getSiblingVisibility(
  type: PublishableType,
  translationGroupId: string,
  excludeId: number | string,
): Promise<SiblingVisibility[]> {
  if (!translationGroupId) return [];

  const supabase = createClient();
  const { data, error } = await supabase
    .from(TABLE[type])
    .select("id, title, language_id, status, published_at")
    .eq("translation_group_id", translationGroupId);

  if (error || !data) return [];

  return (data as unknown as Array<{
    id: number | string;
    title: string;
    language_id: number;
    status: string;
    published_at: string | null;
  }>)
    .filter((row) => String(row.id) !== String(excludeId))
    .map((row) => ({
      id: row.id,
      languageId: row.language_id,
      title: row.title,
      state: resolveVisibilityState({
        status: row.status,
        publishedAt: row.published_at,
        liveStatus: LIVE_STATUS[type],
      }),
    }));
}
