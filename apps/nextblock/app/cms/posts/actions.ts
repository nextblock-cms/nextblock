// app/cms/posts/actions.ts
"use server";

import { createClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@nextblock-cms/db";
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateContentDraft } from "../../../lib/visual-editing/draft-content";
import { revalidatePublicContent } from "../../../lib/public-content-cache";

type PageStatus = Database['public']['Enums']['page_status'];
import { encodedRedirect } from "@nextblock-cms/utils/server"; // Ensure this is correctly imported
// --- createPost and updatePost functions to be updated similarly for error returns ---

/**
 * Publish a post directly (status -> "published") so it becomes visible on the
 * live site.
 *
 * The CMS top bar now goes through `setContentVisibility` in
 * `app/actions/visibilityActions.ts`, which also handles scheduling and
 * unpublishing. This remains as a simple programmatic publish for scripts and
 * customizations.
 */
export async function publishPost(postId: number): Promise<{ error?: string } | void> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "User not authenticated." };

  const nowIso = new Date().toISOString();
  const { data: existing } = await supabase
    .from("posts")
    .select("published_at")
    .eq("id", postId)
    .maybeSingle();

  // Publishing "now": if the post has no publish date or a future-scheduled one,
  // set it to now so it isn't withheld by the public "published_at <= now" filter.
  const currentPublishedAt = existing?.published_at;
  const setPublishedNow =
    !currentPublishedAt || new Date(currentPublishedAt).getTime() > Date.now();

  const { data: post, error } = await supabase
    .from("posts")
    .update({
      status: "published",
      updated_at: nowIso,
      ...(setPublishedNow ? { published_at: nowIso } : {}),
    })
    .eq("id", postId)
    .select("slug")
    .single();

  if (error || !post) {
    return { error: error?.message || "Could not publish the post." };
  }

  revalidatePath("/cms/posts");
  revalidatePath(`/cms/posts/${postId}/edit`);
  revalidatePath(`/article/${post.slug}`);
  revalidatePath("/articles");
  // The public post read is cached (lib/public-content-cache.ts).
  revalidatePublicContent("posts");
  return {};
}

export async function createPost(formData: FormData) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return encodedRedirect("error", "/cms/posts/new", "User not authenticated.");
  }

  const featureImageIdStr_create = formData.get("feature_image_id") as string;
  let featureImageId_create: string | null = null;
  if (featureImageIdStr_create && featureImageIdStr_create.trim() !== "") {
    featureImageId_create = featureImageIdStr_create;
  }

  const rawFormData = {
    title: formData.get("title") as string,
    slug: formData.get("slug") as string,
    language_id: parseInt(formData.get("language_id") as string, 10),
    label: formData.get("label") as string || null,
    // New posts always start private; going public is an explicit act in the
    // editor's top bar, never a side effect of creating something.
    status: "draft" as PageStatus,
    excerpt: formData.get("excerpt") as string || null,
    subtitle: formData.get("subtitle") as string || null,
    meta_title: formData.get("meta_title") as string || null,
    meta_description: formData.get("meta_description") as string || null,
    custom_canonical: formData.get("custom_canonical") as string || null,
    feature_image_id: featureImageId_create,
  };

  if (!rawFormData.title || !rawFormData.slug || isNaN(rawFormData.language_id)) {
    return encodedRedirect("error", "/cms/posts/new", "Missing required fields: title, slug, or language.");
  }

  const newTranslationGroupId = uuidv4();

  const postData: UpsertPostPayload = {
    ...rawFormData,
    published_at: null,
    author_id: user.id,
    translation_group_id: newTranslationGroupId,
    feature_image_id: rawFormData.feature_image_id,
  };

  const { data: newPost, error: createError } = await supabase
    .from("posts")
    .insert(postData)
    .select("id, title, slug, language_id, translation_group_id, label, excerpt, subtitle, feature_image_id")
    .single();

  if (createError) {
    console.error("Error creating post:", createError);
    if (createError.code === '23505' && createError.message.includes('posts_language_id_slug_key')) {
        return encodedRedirect("error", "/cms/posts/new", `The slug "${postData.slug}" already exists for the selected language. Please use a unique slug.`);
    }
    return encodedRedirect("error", "/cms/posts/new", `Failed to create post: ${createError.message}`);
  }

  let successMessage = "Post created successfully.";

  if (newPost) {
    const { data: languages, error: langError } = await supabase
      .from("languages")
      .select("id, code")
      .neq("id", newPost.language_id);

    if (langError) {
      console.error("Error fetching other languages for post auto-creation:", langError);
    } else if (languages && languages.length > 0) {
      let placeholderCreations = 0;
      for (const lang of languages) {
        const placeholderSlug = generatePlaceholderSlug(newPost.title, lang.code);
        const placeholderPostData: Omit<UpsertPostPayload, 'author_id'> & {author_id?: string | null} = {
          language_id: lang.id,
          title: `[${lang.code.toUpperCase()}] ${newPost.title}`,
          slug: placeholderSlug,
          label: newPost.label || null,
          status: 'draft',
          published_at: null,
          excerpt: `Placeholder for ${lang.code.toUpperCase()} translation. Original excerpt: ${newPost.excerpt || ''}`.substring(0, 250),
          subtitle: `Placeholder for ${lang.code.toUpperCase()} translation. Original subtitle: ${newPost.subtitle || ''}`.substring(0, 500),
          meta_title: null,
          meta_description: null,
          custom_canonical: null,
          translation_group_id: newPost.translation_group_id,
          author_id: user.id,
        };
        const { error: placeholderError } = await supabase.from("posts").insert(placeholderPostData);
        if (placeholderError) {
          console.error(`Error auto-creating post for language ${lang.code} (slug: ${placeholderSlug}):`, placeholderError);
        } else {
          placeholderCreations++;
        }
      }
      if (placeholderCreations > 0) {
        successMessage += ` ${placeholderCreations} placeholder version(s) also created (draft status, please edit their slugs and content).`;
      }
    }
  }

  revalidatePath("/cms/posts");
  if (newPost?.slug) revalidatePath(`/article/${newPost.slug}`);
  revalidatePath("/articles");
  revalidatePublicContent("posts");

  if (newPost?.id) {
    redirect(`/cms/posts/${newPost.id}/edit?success=${encodeURIComponent(successMessage)}`);
  } else {
    redirect(`/cms/posts?success=${encodeURIComponent(successMessage)}`);
  }
}

export async function updatePost(postId: number, formData: FormData) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const postEditPath = `/cms/posts/${postId}/edit`;

  if (!user) return { error: "User not authenticated." };

  const { data: existingPost, error: fetchError } = await supabase
    .from("posts")
    .select("slug, translation_group_id, language_id")
    .eq("id", postId)
    .single();

  if (fetchError || !existingPost) {
    return { error: "Original post not found or error fetching it." };
  }

  const featureImageIdStr_update = formData.get("feature_image_id") as string;
  let featureImageId_update: string | null = null;
  if (featureImageIdStr_update && featureImageIdStr_update.trim() !== "") {
    featureImageId_update = featureImageIdStr_update;
  }

  // Visibility (status / published_at) is NOT part of this payload — see the note
  // in cms/pages/actions.ts updatePage. The top-bar control owns it.
  const rawFormData = {
    title: formData.get("title") as string,
    slug: formData.get("slug") as string,
    language_id: existingPost.language_id, // Use existing post's language_id
    label: formData.get("label") as string || null,
    excerpt: formData.get("excerpt") as string || null,
    subtitle: formData.get("subtitle") as string || null,
    meta_title: formData.get("meta_title") as string || null,
    meta_description: formData.get("meta_description") as string || null,
    custom_canonical: formData.get("custom_canonical") as string || null,
    feature_image_id: featureImageId_update,
  };

  if (!rawFormData.title || !rawFormData.slug || isNaN(rawFormData.language_id)) {
     return { error: "Missing required fields: title, slug, or language." };
  }
  if (rawFormData.language_id !== existingPost.language_id) {
      return { error: "Changing the language of an existing post version is not allowed. Create a new translation instead." };
  }

  const postUpdateData: Partial<Omit<UpsertPostPayload, 'translation_group_id' | 'author_id'>> = {
    title: rawFormData.title,
    slug: rawFormData.slug,
    language_id: rawFormData.language_id,
    label: rawFormData.label,
    excerpt: rawFormData.excerpt,
    subtitle: rawFormData.subtitle,
    meta_title: rawFormData.meta_title,
    meta_description: rawFormData.meta_description,
    custom_canonical: rawFormData.custom_canonical,
    feature_image_id: rawFormData.feature_image_id,
  };

  try {
    const draft = await getOrCreateContentDraft(supabase, "post", postId, user.id);
    const updatedMeta = {
      ...draft.meta,
      ...postUpdateData,
    };

    const { error: updateError } = await supabase
      .from("content_drafts")
      .update({ meta: updatedMeta as any })
      .eq("id", draft.id);

    if (updateError) {
      console.error("Error updating post draft:", updateError);
      return { error: `Failed to update draft: ${updateError.message}` };
    }
  } catch (err: any) {
    console.error("Error loading/creating draft for post metadata update:", err);
    return { error: `Failed to load draft: ${err.message || err}` };
  }

  revalidatePath(postEditPath);
  return { success: true };
}


export async function deletePost(postId: number) {
  const supabase = createClient();

  // 1. Fetch the Translation Group
  const { data: post, error: fetchError } = await supabase
    .from("posts")
    .select("translation_group_id")
    .eq("id", postId)
    .single();

  if (fetchError || !post) {
    return encodedRedirect("error", "/cms/posts", "Post not found or error fetching details.");
  }

  const { translation_group_id } = post;

  // 2. Find All Related Posts
  const { data: relatedPosts, error: relatedPostsError } = await supabase
    .from("posts")
    .select("slug")
    .eq("translation_group_id", translation_group_id);

  if (relatedPostsError) {
    return encodedRedirect("error", "/cms/posts", "Could not fetch related posts for deletion.");
  }

  // 3. Delete All Associated Navigation Links
  if (relatedPosts && relatedPosts.length > 0) {
    const urlsToDelete = relatedPosts.map(p => `/article/${p.slug}`);
    const { error: navError } = await supabase
      .from("navigation_items")
      .delete()
      .in("url", urlsToDelete);

    if (navError) {
      console.error("Error deleting navigation links:", navError);
      // Not returning an error to the user, but logging it.
    }
  }

  // 4. Delete All Related Posts
  const { error: deletePostsError } = await supabase
    .from("posts")
    .delete()
    .eq("translation_group_id", translation_group_id);

  if (deletePostsError) {
    return encodedRedirect("error", "/cms/posts", `Failed to delete posts: ${deletePostsError.message}`);
  }

  // Revalidate paths
  revalidatePath("/cms/posts");
  revalidatePath("/cms/navigation");
  if (relatedPosts) {
    relatedPosts.forEach(p => {
      if (p.slug) {
        revalidatePath(`/article/${p.slug}`);
      }
    });
  }
  revalidatePath("/articles");
  revalidatePublicContent("posts");

  // 5. Update Redirect Message
  redirect(`/cms/posts?success=${encodeURIComponent("Post and all its translations were deleted successfully.")}`);
}

// Helper function (already defined in page actions, ensure consistent or shared)
function generatePlaceholderSlug(title: string, langCode: string): string {
  const baseSlug = title.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 70);
  return `${baseSlug}-${langCode}-${uuidv4().substring(0, 6)}`;
}

type UpsertPostPayload = {
  language_id: number;
  author_id: string | null;
  title: string;
  slug: string;
  label?: string | null;
  excerpt?: string | null;
  subtitle?: string | null;
  status: PageStatus;
  published_at?: string | null;
  meta_title?: string | null;
  meta_description?: string | null;
  custom_canonical?: string | null;
  translation_group_id: string;
  feature_image_id?: string | null;
};
