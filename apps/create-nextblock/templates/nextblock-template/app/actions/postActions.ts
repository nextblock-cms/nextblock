'use server';

import { cache } from 'react';
import { createClient } from '@nextblock-cms/db/server';
import { buildPublishedAtOrFilter } from '@nextblock-cms/utils';
import { revalidatePath } from 'next/cache';
import type { Database } from '@nextblock-cms/db';
import type { PostWithMediaDimensions } from '../../components/blocks/types';
import { resolveMediaUrl } from '../../lib/media/resolveMediaUrl';
import { estimateReadTimeMinutesFromBlocks } from '../../lib/posts/readTime';

type PostRow = Database['public']['Tables']['posts']['Row'];
type BlockRow = Database['public']['Tables']['blocks']['Row'];
type FeatureMediaSelection = {
  object_key: string;
  width?: number | null;
  height?: number | null;
  blur_data_url?: string | null;
};

type PostQueryRow = PostRow & {
  feature_media_object?: FeatureMediaSelection | FeatureMediaSelection[] | null;
};

type PostWithFeatureMedia = PostRow & {
  feature_media_object?: FeatureMediaSelection | null;
};

function normalizeFeatureMediaObject(
  mediaObject: PostQueryRow['feature_media_object']
): FeatureMediaSelection | null {
  if (Array.isArray(mediaObject)) {
    return mediaObject[0] ?? null;
  }

  return mediaObject ?? null;
}

async function getEstimatedReadTimeMap(
  supabase: ReturnType<typeof createClient>,
  postIds: number[]
) {
  if (postIds.length === 0) {
    return new Map<number, number>();
  }

  const { data: textBlocks, error } = await supabase
    .from('blocks')
    .select('post_id, block_type, content')
    .in('post_id', postIds)
    .eq('block_type', 'text')
    .order('order', { ascending: true });

  if (error) {
    console.error('Error fetching post text blocks for read-time estimation:', error);
    return new Map(postIds.map((postId) => [postId, 1]));
  }

  const blocksByPostId = new Map<number, Array<Pick<BlockRow, 'block_type' | 'content'>>>();
  postIds.forEach((postId) => blocksByPostId.set(postId, []));

  (textBlocks || []).forEach((block) => {
    if (typeof block.post_id !== 'number') {
      return;
    }

    const blocks = blocksByPostId.get(block.post_id) || [];
    blocks.push(block as Pick<BlockRow, 'block_type' | 'content'>);
    blocksByPostId.set(block.post_id, blocks);
  });

  return new Map(
    postIds.map((postId) => [
      postId,
      estimateReadTimeMinutesFromBlocks(blocksByPostId.get(postId)),
    ])
  );
}

function normalizePostsForCards(
  posts: PostWithFeatureMedia[],
  estimatedReadTimeMap: Map<number, number>
) {
  return posts.map((post) => {
    const mediaObject = post.feature_media_object || null;

    return {
      ...post,
      feature_image_url: resolveMediaUrl(mediaObject?.object_key),
      feature_image_width: mediaObject?.width || null,
      feature_image_height: mediaObject?.height || null,
      blur_data_url: mediaObject?.blur_data_url || null,
      estimated_read_time_minutes: estimatedReadTimeMap.get(post.id) || 1,
    } satisfies PostWithMediaDimensions;
  });
}

async function fetchPublishedPostsPage(languageId: number, page: number, limit: number) {
  const supabase = createClient();
  const offset = (page - 1) * limit;

  const { data: posts, error, count } = await supabase
    .from('posts')
    .select(
      'id, title, slug, label, excerpt, subtitle, published_at, language_id, status, created_at, updated_at, translation_group_id, feature_image_id, version, author_id, meta_title, meta_description, feature_media_object:media!feature_image_id(object_key, width, height, blur_data_url)',
      { count: 'exact' }
    )
    .eq('status', 'published')
    // Without this a scheduled post is listed here while its own URL 404s.
    .or(buildPublishedAtOrFilter())
    .eq('language_id', languageId)
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    // PostgREST answers an offset past the last row with 416 "Requested range not
    // satisfiable" (PGRST103). For a paginated grid that is an empty page, not a failure:
    // `?page=99` and a stale page count both land here.
    if (error.code === 'PGRST103') {
      return { posts: [], totalCount: 0, error: undefined };
    }
    console.error('Error fetching published posts:', error);
    return { posts: [], totalCount: 0, error: error.message };
  }

  const normalizedPosts: PostWithFeatureMedia[] = ((posts as PostQueryRow[] | null) ?? []).map(
    (post) => ({
      ...post,
      feature_media_object: normalizeFeatureMediaObject(post.feature_media_object),
    })
  );
  const postIds = normalizedPosts.map((post) => post.id);
  const estimatedReadTimeMap = await getEstimatedReadTimeMap(supabase, postIds);

  return {
    posts: normalizePostsForCards(normalizedPosts, estimatedReadTimeMap),
    totalCount: count || 0,
    error: undefined,
  };
}

export async function fetchPaginatedPublishedPosts(languageId: number, page: number, limit: number): Promise<{ posts: PostWithMediaDimensions[], totalCount: number, error?: string }> {
  return fetchPublishedPostsPage(languageId, page, limit);
}

export const fetchInitialPublishedPosts = cache(async (languageId: number, limit: number, page = 1): Promise<{ posts: PostWithMediaDimensions[], totalCount: number, error?: string | null }> => {
  const result = await fetchPublishedPostsPage(languageId, page, limit);
  return {
    posts: result.posts,
    totalCount: result.totalCount,
    error: result.error ?? null,
  };
});
export async function revalidateAndLog(path: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Revalidate the path
    revalidatePath(path);

    // Step 2: Log the revalidation by calling the API route
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      throw new Error('NEXT_PUBLIC_BASE_URL is not set in environment variables.');
    }
    
    const logUrl = new URL('/api/revalidate-log', baseUrl);

    const response = await fetch(logUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const errorBody = await response.json();
      throw new Error(`Failed to log revalidation: ${response.status} ${response.statusText} - ${errorBody.error}`);
    }

    return { success: true };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.error(`Error in revalidateAndLog for path "${path}":`, errorMessage);
    return { success: false, error: errorMessage };
  }
}
