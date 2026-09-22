import React from "react";
import PostsGridBlock from "../../blocks/PostsGridBlock";
import type { Database } from "@nextblock-cms/db";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";

type Block = Database['public']['Tables']['blocks']['Row'];
type PostsGridBlockContent = {
    title?: string;
    postsPerPage?: number;
    columns?: number;
    showPagination?: boolean;
    anchor?: string;
};

interface PostsGridBlockRendererProps {
  content: PostsGridBlockContent;
  languageId: number;
  block: Block;
  visualEditAttributes?: VisualEditAttributes;
}

const PostsGridBlockRenderer: React.FC<PostsGridBlockRendererProps> = ({
  content,
  languageId,
  block,
  visualEditAttributes,
}) => {
  void content;
  return (
    <div {...visualEditAttributes}>
      <PostsGridBlock
        block={block}
        languageId={languageId}
      />
    </div>
  );
};

export default PostsGridBlockRenderer;
