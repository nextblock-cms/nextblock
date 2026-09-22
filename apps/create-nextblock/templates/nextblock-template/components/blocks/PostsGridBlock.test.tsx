import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchInitial, clientGrid } = vi.hoisted(() => ({ fetchInitial: vi.fn(), clientGrid: vi.fn() }));

vi.mock('../../app/actions/postActions', () => ({
  fetchInitialPublishedPosts: fetchInitial,
  fetchPaginatedPublishedPosts: vi.fn(),
}));
// The client grid needs a browser (router, language context); only the server wrapper is under
// test, so a stub records the props it hands the grid.
vi.mock('./PostsGridClient', () => ({
  default: (props: unknown) => {
    clientGrid(props);
    return null;
  },
}));

import PostsGridBlock from './PostsGridBlock';

const baseContent = { columns: 3, postsPerPage: 6, showPagination: true, title: 'Latest Deep Dives' };

async function render(content: Record<string, unknown>): Promise<string> {
  // An async server component: call it, then render the element it resolves to.
  const element = await (PostsGridBlock as unknown as (props: unknown) => Promise<ReactElement>)({
    block: { content },
    languageId: 1,
  });
  return renderToStaticMarkup(element);
}

describe('PostsGridBlock anchor', () => {
  beforeEach(() => {
    fetchInitial.mockReset();
    clientGrid.mockReset();
    fetchInitial.mockResolvedValue({ posts: [{ id: 1, slug: 'a', title: 'A' }], totalCount: 1 });
  });

  it('renders id="latest" by default, the target of the seeded /articles#latest button', async () => {
    expect(await render(baseContent)).toContain('id="latest"');
  });

  it('renders its own anchor when one is set', async () => {
    const html = await render({ ...baseContent, anchor: 'news' });

    expect(html).toContain('id="news"');
    expect(html).not.toContain('id="latest"');
    // The client grid gets the same id for its `?page=N#news` pagination links.
    expect(clientGrid).toHaveBeenCalledWith(expect.objectContaining({ anchor: 'news' }));
  });

  it('falls back to the default for an invalid anchor', async () => {
    expect(await render({ ...baseContent, anchor: 'Bad id' })).toContain('id="latest"');
  });

  it('keeps the id when there are no posts', async () => {
    fetchInitial.mockResolvedValue({ posts: [], totalCount: 0 });

    const html = await render(baseContent);

    expect(html).toContain('id="latest"');
    expect(html).toContain('No posts found.');
  });

  it('keeps the id when the posts fail to load', async () => {
    fetchInitial.mockResolvedValue({ posts: [], totalCount: 0, error: 'boom' });

    expect(await render({ ...baseContent, anchor: 'news' })).toContain('id="news"');
  });
});
