// app/[slug]/page.utils.ts
import { createClient, getSsgSupabaseClient } from "@nextblock-cms/db/server";
import type { Database } from "@nextblock-cms/db";
import { buildPublishedAtOrFilter } from "@nextblock-cms/utils";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";
import {
  PUBLIC_CONTENT_REVALIDATE_SECONDS,
  PUBLIC_PAGES_CACHE_TAG,
} from "../../lib/public-content-cache";
import { resolveMediaUrl } from "../../lib/media/resolveMediaUrl";
import { pickOriginalUploadObjectKey } from "../../lib/media/original-upload";
import { getContentDraft } from "../../lib/visual-editing/draft-content";
import type { ContentDraftRow, DraftBlockSnapshot } from "../../lib/visual-editing/types";

type PageType = Database['public']['Tables']['pages']['Row'];
type BlockType = Database['public']['Tables']['blocks']['Row'];
type PublicPageData = PageType & {
  blocks: BlockType[];
  language_code: string;
  language_id: number;
  translation_group_id: string | null;
  feature_image_url?: string | null;
  /**
   * The same feature image for LINK PREVIEWS, resolved to the untouched upload.
   *
   * `feature_image_url` above is the AVIF derivative the browser renders. Social
   * crawlers do not decode AVIF, so `generateMetadata` uses this one instead; it
   * falls back to the same key when the row kept no original. See
   * `lib/media/original-upload.ts`.
   */
  feature_image_social_url?: string | null;
  feature_image_blur_data_url?: string | null;
  feature_image_width?: number | null;
  feature_image_height?: number | null;
  draft_id?: number | null;
};


// Define a more specific type for the content of an Image Block
export type ImageBlockContent = {
  media_id: string | null;
  object_key?: string; // Optional because it's added later
  blur_data_url?: string | null; // Optional because it's added later
};

// Interface to represent a page object after the initial database query and selection
interface SelectedPageType extends PageType { // Assumes PageType includes fields like id, slug, status, language_id, translation_group_id
  language_details: { id: number; code: string } | null; // From the join; kept nullable due to original code's caution
  blocks: BlockType[];
  feature_media_object?: {
    object_key?: string | null;
    file_path?: string | null;
    blur_data_url?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
}

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

function draftBlockToPageBlock(
  block: DraftBlockSnapshot,
  pageId: number,
  fallbackUpdatedAt: string
): BlockType {
  return {
    id: block.id ?? -(block.order + 1),
    page_id: pageId,
    post_id: null,
    product_id: null,
    language_id: block.language_id,
    block_type: block.block_type,
    content: block.content,
    order: block.order,
    created_at: block.created_at ?? fallbackUpdatedAt,
    updated_at: block.updated_at ?? fallbackUpdatedAt,
  };
}

function applyDraftToPage(page: SelectedPageType, draft: ContentDraftRow): SelectedPageType {
  const languageId = draftNumber(draft, "language_id", page.language_id);

  return {
    ...page,
    title: draftString(draft, "title", page.title),
    slug: draftString(draft, "slug", page.slug),
    language_id: languageId,
    language_details: languageId === page.language_id ? page.language_details : null,
    // Visibility is never taken from a draft — it lives on the row.
    meta_title: draftNullableString(draft, "meta_title", page.meta_title),
    meta_description: draftNullableString(draft, "meta_description", page.meta_description),
    custom_canonical: draftNullableString(draft, "custom_canonical", page.custom_canonical),
    feature_image_id: draftNullableString(draft, "feature_image_id", page.feature_image_id),
    translation_group_id: draftString(
      draft,
      "translation_group_id",
      page.translation_group_id
    ),
    blocks: draft.blocks.map((block) =>
      draftBlockToPageBlock(block, page.id, draft.updated_at || page.updated_at)
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

type PublicSupabaseClient = ReturnType<typeof createClient> | ReturnType<typeof getSsgSupabaseClient>;

/**
 * Public page data for a slug.
 *
 * Draft mode (the Live Draft preview) reads the live tables through the cookie-scoped
 * client on every request. Everything else is served from `unstable_cache`: see
 * lib/public-content-cache.ts for the lifetime and how CMS writes evict it. Before this
 * every public request paid these Supabase round trips, which showed up as 0.5-6 s of
 * body time on the home page.
 */
export const getPageDataBySlug = cache(async function getPageDataBySlug(
  slug: string,
  preferredLanguageCode?: string,
): Promise<PublicPageData | null> {
  const draft = await draftMode();
  if (draft.isEnabled) {
    return loadPageData(createClient(), slug, preferredLanguageCode, true);
  }
  // React `cache()` memoises per request: generateMetadata and the page body both
  // resolve the same page, and on Vercel every unstable_cache read is a network hop.
  return getCachedPublishedPageData(slug, preferredLanguageCode ?? null);
});

const getCachedPublishedPageData = unstable_cache(
  async (slug: string, preferredLanguageCode: string | null): Promise<PublicPageData | null> =>
    loadPageData(getSsgSupabaseClient(), slug, preferredLanguageCode ?? undefined, false),
  ['public-page-data'],
  { revalidate: PUBLIC_CONTENT_REVALIDATE_SECONDS, tags: [PUBLIC_PAGES_CACHE_TAG] },
);

/**
 * `language code -> slug` for every published page in a translation group. Feeds the
 * hreflang alternates, the "/" homepage locale resolution and the client language
 * switcher; cached and evicted together with the page data.
 */
export const getCachedPublishedPageTranslatedSlugs = cache(unstable_cache(
  async (translationGroupId: string): Promise<Record<string, string>> => {
    const supabase = getSsgSupabaseClient();
    const { data, error } = await supabase
      .from('pages')
      .select('slug, languages!inner(code)')
      .eq('translation_group_id', translationGroupId)
      .eq('status', 'published')
      .or(buildPublishedAtOrFilter());

    if (error || !data) return {};

    const slugs: Record<string, string> = {};
    for (const row of data as Array<{
      slug: string | null;
      languages: { code: string } | { code: string }[] | null;
    }>) {
      const language = Array.isArray(row.languages) ? row.languages[0] : row.languages;
      if (language?.code && row.slug) slugs[language.code] = row.slug;
    }
    return slugs;
  },
  ['public-page-translated-slugs'],
  { revalidate: PUBLIC_CONTENT_REVALIDATE_SECONDS, tags: [PUBLIC_PAGES_CACHE_TAG] },
));

async function loadPageData(
  supabase: PublicSupabaseClient,
  slug: string,
  preferredLanguageCode: string | undefined,
  isDraftModeEnabled: boolean,
): Promise<PublicPageData | null> {
  const baseSelect = `
      id, slug, title, meta_title, meta_description, custom_canonical, feature_image_id, status, language_id, translation_group_id, author_id, created_at, updated_at,
      language_details:languages!inner(id, code),
      feature_media_object:media!pages_feature_image_id_fkey(object_key, file_path, blur_data_url, width, height, variants),
      blocks (id, page_id, block_type, content, order)
    `;

  const toSelected = (rows: any[] | null | undefined): SelectedPageType[] =>
    (rows || []).map(page => ({
      ...page,
      language_details: Array.isArray(page.language_details) ? page.language_details[0] : page.language_details,
    })) as SelectedPageType[];

  let candidatePages: SelectedPageType[] = [];

  // First try to fetch the preferred language explicitly when provided
  if (preferredLanguageCode) {
    let preferredQuery = supabase
      .from("pages")
      .select(baseSelect)
      .eq("slug", slug)
      .eq("languages.code", preferredLanguageCode)
      .order('order', { foreignTable: 'blocks', ascending: true });

    if (!isDraftModeEnabled) {
      // A future published_at means "scheduled" — withheld from the public until
      // it passes. Preview (draft mode) deliberately ignores the schedule.
      preferredQuery = preferredQuery
        .eq("status", "published")
        .or(buildPublishedAtOrFilter());
    }

    const { data: preferredData, error: preferredError } = await preferredQuery.maybeSingle();
    if (!preferredError && preferredData) {
      candidatePages = toSelected([preferredData]);
    }
  }

  // Fallback: fetch all published pages with this slug
  if (candidatePages.length === 0) {
    let pageQuery = supabase
      .from("pages")
      .select(baseSelect)
      .eq("slug", slug)
      .order('order', { foreignTable: 'blocks', ascending: true });

    if (!isDraftModeEnabled) {
      pageQuery = pageQuery.eq("status", "published").or(buildPublishedAtOrFilter());
    }

    const { data: candidatePagesData, error: pageError } = await pageQuery;

    if (pageError) {
      return null;
    }
    candidatePages = toSelected(candidatePagesData);
  }

  if (candidatePages.length === 0) {
    return null;
  }

  let selectedPage: SelectedPageType | null = null;

  if (preferredLanguageCode) {
    selectedPage = candidatePages.find(
      p => p.language_details && p.language_details.code === preferredLanguageCode,
    ) || null;
  }

  if (!selectedPage && candidatePages.length === 1) {
    selectedPage = candidatePages[0];
  }

  if (!selectedPage) {
    // Prefer default language if available
    const { data: defaultLang } = await supabase
      .from('languages')
      .select('id, code')
      .eq('is_default', true)
      .maybeSingle();
    if (defaultLang) {
      const match = candidatePages.find(p => p.language_details && p.language_details.id === defaultLang.id);
      if (match) selectedPage = match;
    }
  }

  if (!selectedPage) {
    const enPage = candidatePages.find(p => p.language_details && p.language_details.code === 'en');
    if (enPage) {
      selectedPage = enPage;
    } else {
      selectedPage = candidatePages[0];
    }
  }
  
  if (!selectedPage) {
    return null;
  }

  const contentDraft = isDraftModeEnabled
    ? await getContentDraft("page", selectedPage.id)
    : null;

  if (contentDraft) {
    selectedPage = applyDraftToPage(selectedPage, contentDraft);
  }
  
  let languageCode: string | undefined = selectedPage.language_details?.code;
  let languageId: number | undefined = selectedPage.language_details?.id;

  // Optimize fallback language query with specific fields
  if (!languageCode || typeof languageId !== 'number') {
    if (typeof selectedPage.language_id === 'number') {
        const { data: fallbackLang, error: langFetchError } = await supabase
            .from("languages")
            .select("id, code")
            .eq("id", selectedPage.language_id)
            .single();

        if (langFetchError) {
            return null;
        }
        
        if (fallbackLang) {
            languageCode = fallbackLang.code;
            languageId = fallbackLang.id;
        } else {
            return null;
        }
    } else {
        return null;
    }
  }



  if (typeof languageCode !== 'string' || typeof languageId !== 'number') {
      return null;
  }

  let blocksWithMediaData: BlockType[] = selectedPage.blocks || [];
  if (blocksWithMediaData.length > 0) {
    const mediaIds = blocksWithMediaData
      .flatMap(block => extractMediaIdsFromBlock(block))
      .filter((id): id is string => id !== null && typeof id === 'string' && id !== '');

    if (mediaIds.length > 0) {
      // Optimized media query with specific fields only
      const { data: mediaItems, error: mediaError } = await supabase
        .from('media')
        .select('id, object_key, blur_data_url')
        .in('id', mediaIds);

      if (mediaError) {
        console.error('Error fetching media data:', mediaError);
      } else if (mediaItems) {
        const mediaMap = new Map(mediaItems.map(m => [m.id, { object_key: m.object_key, blur_data_url: m.blur_data_url }]));
        blocksWithMediaData = blocksWithMediaData.map(block => mapMediaDataToBlock(block, mediaMap));
      }
    }
  }

  let featureMedia = selectedPage.feature_media_object ?? null;
  if (selectedPage.feature_image_id && (!featureMedia || contentDraft)) {
    const { data: mediaItem, error: mediaError } = await supabase
      .from("media")
      .select("object_key, file_path, blur_data_url, width, height, variants")
      .eq("id", selectedPage.feature_image_id)
      .maybeSingle();

    if (mediaError) {
      console.error("Error fetching page feature image data:", mediaError);
    } else if (mediaItem) {
      featureMedia = mediaItem;
    }
  }
  
  const { language_details, blocks, feature_media_object, ...basePageData } = selectedPage;
  void language_details;
  void blocks;
  void feature_media_object;
  return {
    ...(basePageData as PageType),
    blocks: blocksWithMediaData,
    language_code: languageCode,
    language_id: languageId,
    translation_group_id: selectedPage.translation_group_id,
    feature_image_url: resolveMediaUrl(featureMedia?.object_key || featureMedia?.file_path || null),
    feature_image_social_url: resolveMediaUrl(pickOriginalUploadObjectKey(featureMedia)),
    feature_image_blur_data_url: featureMedia?.blur_data_url ?? null,
    feature_image_width: featureMedia?.width ?? null,
    feature_image_height: featureMedia?.height ?? null,
    draft_id: contentDraft?.id ?? null,
  };
}
