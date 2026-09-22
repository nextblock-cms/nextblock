// app/cms/blocks/editors/PostsGridBlockEditor.tsx
import React from 'react';
import { BlockEditorProps } from '../components/BlockEditorModal';
import { Input } from '@nextblock-cms/ui';
import { Label } from '@nextblock-cms/ui';
import {
  DEFAULT_POSTS_GRID_ANCHOR,
  resolvePostsGridAnchor,
  sanitizePostsGridAnchorInput,
} from '../../../../lib/blocks/posts-grid-anchor';

interface PostsGridBlockContent {
  title?: string;
  postsPerPage?: number;
  columns?: number;
  showPagination?: boolean;
  anchor?: string;
}

const PostsGridBlockEditor: React.FC<BlockEditorProps<PostsGridBlockContent>> = ({ content, onChange }) => {
  const currentTitle = content.title || 'Recent Posts';
  const currentPostsPerPage = content.postsPerPage || 6;
  const currentColumns = content.columns || 3;
  const showPagination = content.showPagination === undefined ? true : content.showPagination;

  const handleChange = (field: keyof PostsGridBlockContent, value: any) => {
    onChange({
      ...content,
      [field]: value,
    });
  };

  return (
    <div className="space-y-4 p-4 border rounded-md">
      <h4 className="text-lg font-semibold">Posts Grid Block Editor</h4>
      
      <div>
        <Label htmlFor="posts-grid-title">Title</Label>
        <Input
          id="posts-grid-title"
          value={currentTitle}
          onChange={(e) => handleChange('title', e.target.value)}
          placeholder="Enter title for the posts grid"
        />
      </div>

      <div>
        <Label htmlFor="posts-grid-per-page">Posts Per Page</Label>
        <Input
          id="posts-grid-per-page"
          type="number"
          value={currentPostsPerPage}
          onChange={(e) => handleChange('postsPerPage', parseInt(e.target.value, 10))}
          min="1"
        />
      </div>

      <div>
        <Label htmlFor="posts-grid-columns">Columns</Label>
        <Input
          id="posts-grid-columns"
          type="number"
          value={currentColumns}
          onChange={(e) => handleChange('columns', parseInt(e.target.value, 10))}
          min="1"
          max="6"
        />
      </div>

      <div>
        <Label htmlFor="posts-grid-anchor">Anchor ID</Label>
        <Input
          id="posts-grid-anchor"
          value={content.anchor ?? ''}
          onChange={(e) => handleChange('anchor', sanitizePostsGridAnchorInput(e.target.value))}
          placeholder={DEFAULT_POSTS_GRID_ANCHOR}
          aria-describedby="posts-grid-anchor-hint"
          autoComplete="off"
          spellCheck={false}
        />
        {/* The resolved id, not the raw value, so the hint always matches what the page renders. */}
        <p id="posts-grid-anchor-hint" className="mt-1 text-xs text-muted-foreground">
          Links jump here with <span className="font-mono">#{resolvePostsGridAnchor(content.anchor)}</span>.
          Give each grid on a page its own ID.
        </p>
      </div>
      
      <p className="text-sm">
        <strong>Show Pagination:</strong> {showPagination ? 'Yes' : 'No'}
      </p>

      <p className="text-xs text-muted-foreground pt-2">
        Displays a grid of posts. Frontend rendering and further configuration options will be implemented in subsequent steps.
      </p>
    </div>
  );
};

export default PostsGridBlockEditor;