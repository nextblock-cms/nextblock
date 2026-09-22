// components/blocks/PostsGridBlock.tsx
import React from 'react';
import type { Database } from '@nextblock-cms/db';

type Block = Database['public']['Tables']['blocks']['Row'];
// import Link from 'next/link'; // Unused, PostsGridClient handles links
import PostsGridClient from './PostsGridClient';
import { fetchInitialPublishedPosts, fetchPaginatedPublishedPosts } from '../../app/actions/postActions';
import { getRequestedPage } from '../../lib/blocks/requested-page';
import { resolvePostsGridAnchor } from '../../lib/blocks/posts-grid-anchor';

interface PostsGridBlockProps {
  block: Block;
  languageId: number;
}

const PostsGridBlock: React.FC<PostsGridBlockProps> = async ({ block, languageId }) => {
  const {
    title = "Recent Posts",
    postsPerPage = 12,
    columns = 3,
    showPagination = true,
    anchor,
  } = block.content as { title?: string, postsPerPage?: number, columns?: number, showPagination?: boolean, anchor?: string };

  // Every branch carries the id, so `/articles#latest` (the seeded hero button) and any custom
  // `#anchor` link land on the grid even when it is empty or failed to load. No scroll margin:
  // the public header is in normal flow, and `py-8` already clears the heading.
  const anchorId = resolvePostsGridAnchor(anchor);

  // `?page=N` renders that page on the server, so later pages work without JavaScript and
  // have a URL of their own. A page past the end falls back to the first one.
  const requestedPage = showPagination ? getRequestedPage() : 1;
  let initialPage = requestedPage;
  let { posts: initialPosts, totalCount, error: postsError } = await fetchInitialPublishedPosts(languageId, postsPerPage, requestedPage);

  if (!postsError && requestedPage > 1 && initialPosts.length === 0) {
    initialPage = 1;
    ({ posts: initialPosts, totalCount, error: postsError } = await fetchInitialPublishedPosts(languageId, postsPerPage, 1));
  }

  if (postsError) {
    return <div id={anchorId} className="text-red-500">Error loading posts: {postsError}</div>;
  }

  if (!initialPosts || initialPosts.length === 0) {
    return (
      <section id={anchorId} className="py-8 container mx-auto">
        {title && <h2 className="text-2xl font-semibold mb-4">{title}</h2>}
        <p>No posts found.</p>
      </section>
    );
  }

  return (
    <section id={anchorId} className="py-8 container mx-auto">
      {title && <h2 className="text-2xl font-semibold mb-6">{title}</h2>}
      <PostsGridClient
        initialPosts={initialPosts}
        initialPage={initialPage}
        postsPerPage={postsPerPage}
        totalCount={totalCount}
        columns={columns}
        languageId={languageId}
        showPagination={showPagination}
        anchor={anchorId}
        fetchAction={fetchPaginatedPublishedPosts} // Pass the server action for pagination
      />
    </section>
  );
};

export default PostsGridBlock;
