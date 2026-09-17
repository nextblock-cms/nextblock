// components/blocks/PostsGridClient.tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useLanguage } from '../../context/LanguageContext';
import type { PostWithMediaDimensions } from './types';
import Image from 'next/image';
import { Button } from '@nextblock-cms/ui';
import PostCardSkeleton from './PostCardSkeleton'; // Added import
import { usePageParam } from '../../hooks/usePageParam';
import { useLabel } from '../../lib/i18n/use-label';

interface PostsGridClientProps {
  initialPosts: PostWithMediaDimensions[];
  initialPage: number;
  postsPerPage: number;
  totalCount: number;
  columns: number;
  languageId: number;
  showPagination: boolean;
  fetchAction: (languageId: number, page: number, limit: number) => Promise<{ posts: PostWithMediaDimensions[], totalCount: number, error?: string }>;
}

const DEFAULT_FEATURE_IMAGE_WIDTH = 1600;
const DEFAULT_FEATURE_IMAGE_HEIGHT = 900;

const PostsGridClient: React.FC<PostsGridClientProps> = ({
  initialPosts,
  initialPage,
  postsPerPage,
  totalCount,
  columns,
  languageId,
  showPagination,
  fetchAction,
}) => {
  const { currentLocale } = useLanguage();
  const label = useLabel();
  const gridRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [posts, setPosts] = useState<PostWithMediaDimensions[]>(initialPosts);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Initialize skeletonCount to postsPerPage, or a sensible minimum if initialPosts is empty.
  const [skeletonCount, setSkeletonCount] = useState(initialPosts.length > 0 ? initialPosts.length : postsPerPage);

  const totalPages = Math.ceil(totalCount / postsPerPage);

  useEffect(() => {
    setPosts(initialPosts); // Sync if initialPosts change due to parent re-render
    setCurrentPage(initialPage);
    // When initialPosts change, update skeletonCount to reflect the number of items actually rendered initially,
    // or fall back to postsPerPage if initialPosts is empty (e.g., for a client-side initial fetch)
    setSkeletonCount(initialPosts.length > 0 ? initialPosts.length : postsPerPage);
  }, [initialPosts, initialPage, postsPerPage]);

  const handlePageChange = async (newPage: number, { recordInUrl = true } = {}) => {
    if (newPage < 1 || newPage > totalPages || isLoading || newPage === currentPage) return;

    // For subsequent page loads, always show `postsPerPage` skeletons
    setSkeletonCount(postsPerPage);
    setIsLoading(true);
    setError(null);
    // Don't clear posts here immediately, skeletons will cover the loading state
    try {
      const result = await fetchAction(languageId, newPage, postsPerPage);

      if (result.error) {
        setError(result.error);
        setPosts([]); // Clear posts on error
      } else {
        setPosts(result.posts);
        setCurrentPage(newPage);
        if (recordInUrl) pushPage(newPage);
        // Keep the top of the grid in view rather than leaving the reader at the bottom of
        // the previous page. An explicit `behavior` beats the reduced-motion stylesheet rule.
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gridRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    } catch {
      // A thrown server action carries Next's generic English text in production.
      setError(label('posts_grid.error', 'Failed to load posts.', 'Impossible de charger les articles.'));
      setPosts([]); // Clear posts on error
    }
    setIsLoading(false);
  };

  // `?page=N` in the address bar, and Back/Forward, restore a page without a new history entry.
  const pushPage = usePageParam((page) => void handlePageChange(page, { recordInUrl: false }));

  const columnClasses: { [key: number]: string } = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  };
  const gridColsClass = columnClasses[columns] || columnClasses[3];

  const getImageSizes = (cols: number): string => {
    switch (cols) {
      case 1:
        return '100vw';
      case 2:
        return '(max-width: 767px) 100vw, 50vw';
      case 4:
        return '(max-width: 639px) 100vw, (max-width: 767px) 50vw, (max-width: 1023px) 33vw, 25vw';
      case 3:
      default:
        return '(max-width: 767px) 100vw, (max-width: 1023px) 50vw, 33vw';
    }
  };

  const imageSizes = getImageSizes(columns);

  if (error && !isLoading) { // Only show full error if not also loading (e.g. initial load error after skeletons)
    return <div role="alert" className="text-destructive py-10 text-center">{error}</div>;
  }

  return (
    <div ref={gridRef} className="scroll-mt-24">
      <div aria-busy={isLoading} className={`grid ${gridColsClass} gap-6`}>
        {isLoading ? (
          Array.from({ length: skeletonCount }).map((_, index) => (
            <PostCardSkeleton key={`skeleton-${index}`} />
          ))
        ) : posts.length > 0 ? (
          posts.map((post) => (
            <Link href={`/article/${post.slug}`} key={post.id} className="block group h-full">
              <div className="border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-card text-card-foreground h-full flex flex-col">
                {/* Basic Post Card Structure - Enhanced with Feature Image */}
                {post.feature_image_url ? (
                  <div className="aspect-video overflow-hidden">
                    <Image
                      src={post.feature_image_url}
                      // Decorative: the card is one link and the title right below names it.
                      alt=""
                      width={post.feature_image_width && post.feature_image_width > 0 ? post.feature_image_width : DEFAULT_FEATURE_IMAGE_WIDTH}
                      height={post.feature_image_height && post.feature_image_height > 0 ? post.feature_image_height : DEFAULT_FEATURE_IMAGE_HEIGHT}
                      sizes={imageSizes}
                      loading="lazy"
                      placeholder={post.blur_data_url ? 'blur' : 'empty'}
                      blurDataURL={post.blur_data_url ?? undefined}
                      quality={60}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                ) : null}
                <div className="p-4 flex flex-1 flex-col">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold text-slate-700">
                      {post.label?.trim() || 'Article'}
                    </span>
                    <span>
                      {post.estimated_read_time_minutes} {currentLocale === 'fr' ? 'min de lecture' : 'min read'}
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold mb-2 group-hover:text-primary">{post.title}</h3>
                  {post.excerpt && <p className="text-sm text-muted-foreground mb-3 line-clamp-3">{post.excerpt}</p>}
                  <div className="mt-auto pt-2">
                    <span className="text-xs text-primary group-hover:underline">
                      {label('posts_grid.read_more', 'Read more', 'Lire la suite')}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))
        ) : (
          !error && (
            <div className="col-span-full text-center py-10">
              {label('posts_grid.empty', 'No posts found.', 'Aucun article trouvé.')}
            </div>
          ) // Show if no posts and no error, and not loading
        )}
      </div>

      {showPagination && totalPages > 1 && (
        <nav
          aria-label={label('pagination.label', 'Pagination', 'Pagination')}
          className="flex justify-center items-center mt-8 space-x-2"
        >
          <Button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1 || isLoading}
            variant="outline"
          >
            {label('pagination.previous', 'Previous', 'Précédent')}
          </Button>
          <span aria-live="polite" className="text-sm tabular-nums">
            {label('pagination.page_of', 'Page {current} of {total}', 'Page {current} sur {total}', {
              current: currentPage,
              total: totalPages,
            })}
          </span>
          <Button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages || isLoading}
            variant="outline"
          >
            {label('pagination.next', 'Next', 'Suivant')}
          </Button>
        </nav>
      )}
      {/* {isLoading && <p className="text-center mt-4 text-sm text-muted-foreground">Fetching posts...</p>} */}
    </div>
  );
};

export default PostsGridClient;
