// app/article/[slug]/page.utils.ts
import { createClient, getSsgSupabaseClient } from "@nextblock-cms/db/server";
import type { Database } from "@nextblock-cms/db";
import { draftMode } from "next/headers";
import { resolveMediaUrl } from "../../../lib/media/resolveMediaUrl";
import { getContentDraft } from "../../../lib/visual-editing/draft-content";
import type { ContentDraftRow, DraftBlockSnapshot } from "../../../lib/visual-editing/types";

type PostType = Database['public']['Tables']['posts']['Row'];
type BlockType = Database['public']['Tables']['blocks']['Row'];
type PublicPostData = PostType & {
  blocks: BlockType[];
  language_code: string;
  language_id: number;
  translation_group_id: string;
  feature_image_url?: string | null;
  /** The media row's description, used as the hero image alt text when present. */
  feature_image_alt?: string | null;
  feature_image_blur_data_url?: string | null;
  feature_image_width?: number | null;
  feature_image_height?: number | null;
  draft_id?: number | null;
};

// Define a more specific type for the content of an Image Block

// Define a more specific type for the content of an Image Block
export type ImageBlockContent = {
  media_id: string | null;
  object_key?: string; // Optional because it's added later
  blur_data_url?: string | null;
};

function hasMetaValue(draft: ContentDraftRow, key: string) {
  return Object.prototype.hasOwnProperty.call(draft.meta, key);
}

function draftString(draft: ContentDraftRow, key: string, fallback: string): string {
  const value = draft.meta[key];
  return typeof value === "string" ? value : fallback;
}

function draftNullableString(
  draft: ContentDraftRow,
  key: string,
  fallback: string | null
): string | null {
  if (!hasMetaValue(draft, key)) {
    return fallback;
  }

  const value = draft.meta[key];
  return typeof value === "string" ? value : null;
}

function draftNumber(draft: ContentDraftRow, key: string, fallback: number): number {
  const value = draft.meta[key];
  return typeof value === "number" ? value : fallback;
}

function draftBlockToPostBlock(
  block: DraftBlockSnapshot,
  postId: number,
  fallbackUpdatedAt: string
): BlockType {
  return {
    id: block.id ?? -(block.order + 1),
    page_id: null,
    post_id: postId,
    product_id: null,
    language_id: block.language_id,
    block_type: block.block_type,
    content: block.content,
    order: block.order,
    created_at: block.created_at ?? fallbackUpdatedAt,
    updated_at: block.updated_at ?? fallbackUpdatedAt,
  };
}

function applyDraftToPost(post: any, draft: ContentDraftRow) {
  const languageId = draftNumber(draft, "language_id", post.language_id);

  return {
    ...post,
    title: draftString(draft, "title", post.title),
    slug: draftString(draft, "slug", post.slug),
    language_id: languageId,
    languages: languageId === post.language_id ? post.languages : null,
    // Visibility is never taken from a draft — it lives on the row.
    meta_title: draftNullableString(draft, "meta_title", post.meta_title),
    meta_description: draftNullableString(draft, "meta_description", post.meta_description),
    custom_canonical: draftNullableString(draft, "custom_canonical", post.custom_canonical),
    label: draftNullableString(draft, "label", post.label),
    excerpt: draftNullableString(draft, "excerpt", post.excerpt),
    subtitle: draftNullableString(draft, "subtitle", post.subtitle),
    feature_image_id: draftNullableString(draft, "feature_image_id", post.feature_image_id),
    translation_group_id: draftString(
      draft,
      "translation_group_id",
      post.translation_group_id
    ),
    blocks: draft.blocks.map((block) =>
      draftBlockToPostBlock(block, post.id, draft.updated_at || post.updated_at)
    ),
  };
}

function extractMediaIdsFromBlock(block: any): string[] {
  const ids: string[] = [];
  if (!block || !block.block_type) return ids;

  if (block.block_type === 'image') {
    const mediaId = block.content?.media_id;
    if (mediaId && typeof mediaId === 'string') {
      ids.push(mediaId);
    }
  } else if (block.block_type === 'section') {
    const content = block.content;
    if (content) {
      if (content.background?.type === 'image' && content.background.image?.media_id) {
        ids.push(content.background.image.media_id);
      }
      if (Array.isArray(content.column_blocks)) {
        for (const col of content.column_blocks) {
          if (Array.isArray(col)) {
            for (const nestedBlock of col) {
              ids.push(...extractMediaIdsFromBlock(nestedBlock));
            }
          }
        }
      }
      if (Array.isArray(content.slides)) {
        for (const slide of content.slides) {
          if (slide.background?.type === 'image' && slide.background.image?.media_id) {
            ids.push(slide.background.image.media_id);
          }
          if (Array.isArray(slide.column_blocks)) {
            for (const col of slide.column_blocks) {
              if (Array.isArray(col)) {
                for (const nestedBlock of col) {
                  ids.push(...extractMediaIdsFromBlock(nestedBlock));
                }
              }
            }
          }
        }
      }
    }
  }
  return ids;
}

function mapMediaDataToBlock(
  block: any,
  mediaMap: Map<string, { object_key: string; blur_data_url?: string | null }>
): any {
  if (!block || !block.block_type) return block;

  if (block.block_type === 'image') {
    const content = block.content;
    if (content?.media_id) {
      const mediaData = mediaMap.get(content.media_id);
      if (mediaData) {
        return {
          ...block,
          content: {
            ...content,
            object_key: mediaData.object_key,
            blur_data_url: mediaData.blur_data_url,
          },
        };
      }
    }
  } else if (block.block_type === 'section') {
    const content = block.content;
    if (!content) return block;

    const updatedContent = { ...content };

    if (content.background?.type === 'image' && content.background.image?.media_id) {
      const mediaData = mediaMap.get(content.background.image.media_id);
      if (mediaData) {
        updatedContent.background = {
          ...content.background,
          image: {
            ...content.background.image,
            object_key: mediaData.object_key,
            blur_data_url: mediaData.blur_data_url,
          },
        };
      }
    }

    if (Array.isArray(content.column_blocks)) {
      updatedContent.column_blocks = content.column_blocks.map((col: any) => {
        if (Array.isArray(col)) {
          return col.map((nestedBlock: any) => mapMediaDataToBlock(nestedBlock, mediaMap));
        }
        return col;
      });
    }

    if (Array.isArray(content.slides)) {
      updatedContent.slides = content.slides.map((slide: any) => {
        const updatedSlide = { ...slide };

        if (slide.background?.type === 'image' && slide.background.image?.media_id) {
          const mediaData = mediaMap.get(slide.background.image.media_id);
          if (mediaData) {
            updatedSlide.background = {
              ...slide.background,
              image: {
                ...slide.background.image,
                object_key: mediaData.object_key,
                blur_data_url: mediaData.blur_data_url,
              },
            };
          }
        }

        if (Array.isArray(slide.column_blocks)) {
          updatedSlide.column_blocks = slide.column_blocks.map((col: any) => {
            if (Array.isArray(col)) {
              return col.map((nestedBlock: any) => mapMediaDataToBlock(nestedBlock, mediaMap));
            }
            return col;
          });
        }

        return updatedSlide;
      });
    }

    return {
      ...block,
      content: updatedContent,
    };
  }

  return block;
}

export async function getPostDataBySlug(slug: string): Promise<PublicPostData | null> {
  const draft = await draftMode();
  const isDraftModeEnabled = draft.isEnabled;
  const supabase = isDraftModeEnabled ? createClient() : getSsgSupabaseClient();

  let postQuery = supabase
    .from("posts")
    .select(`
      *,
      languages!inner (id, code),
      blocks (*),
      media ( object_key, blur_data_url, width, height, description )
    `)
    .eq("slug", slug) // Find the post by its unique slug for this language
    .order('order', { foreignTable: 'blocks', ascending: true });

  if (!isDraftModeEnabled) {
    postQuery = postQuery
      .eq("status", "published")
      .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`); // Check published_at
  }

  const { data: initialPostData, error: postError } = await postQuery.maybeSingle();
  let postData = initialPostData;

  if (postError || !postData) {
    if(postError) console.error(`Error fetching post data for slug '${slug}':`, postError);
    return null;
  }

  const contentDraft = isDraftModeEnabled
    ? await getContentDraft("post", postData.id)
    : null;

  if (contentDraft) {
    postData = applyDraftToPost(postData, contentDraft);
  }

  // Ensure language information is correctly extracted
  let langInfo = postData.languages as unknown as { id: number; code: string } | null;
  if (!langInfo || !langInfo.id || !langInfo.code) {
      console.error(`Language information missing or incomplete for post slug '${slug}'. DB response:`, postData.languages);
      if (!postData.language_id) return null; 
      const {data: fallbackLang} = await supabase.from("languages").select("code").eq("id", postData.language_id).single();
      if (!fallbackLang) return null;
      langInfo = { id: postData.language_id, code: fallbackLang.code };
  }
  
  
  if (!postData.translation_group_id) {
      console.error(`Post with slug '${slug}' is missing a translation_group_id.`);
      return null;
  }

  let blocksWithMediaData: BlockType[] = postData.blocks || [];
  if (blocksWithMediaData.length > 0) {
    const mediaIds = blocksWithMediaData
      .flatMap(block => extractMediaIdsFromBlock(block))
      .filter((id): id is string => id !== null && typeof id === 'string' && id !== '');

    if (mediaIds.length > 0) {
      const { data: mediaItems, error: mediaError } = await supabase
        .from('media')
        .select('id, object_key, blur_data_url')
        .in('id', mediaIds);

      if (mediaError) {
        console.error("SSG (Posts): Error fetching media items for blocks:", mediaError);
      } else if (mediaItems) {
        const mediaMap = new Map(mediaItems.map(m => [m.id, { object_key: m.object_key, blur_data_url: m.blur_data_url }]));
        blocksWithMediaData = blocksWithMediaData.map(block => mapMediaDataToBlock(block, mediaMap));
      }
    }
  }

  return {
    ...postData,
    blocks: blocksWithMediaData,
    language_code: langInfo.code,
    language_id: langInfo.id,
    translation_group_id: postData.translation_group_id,
    feature_image_url: resolveMediaUrl(postData.media?.object_key),
    feature_image_alt: postData.media?.description ?? null,
    feature_image_blur_data_url: postData.media?.blur_data_url,
    feature_image_width: postData.media?.width ?? null,
    feature_image_height: postData.media?.height ?? null,
    draft_id: contentDraft?.id ?? null,
  } as PublicPostData;
}
