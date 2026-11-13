import React from "react";
import ClientTextBlockRenderer from "./ClientTextBlockRenderer";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";
import { sanitizeAuthoredBlockHtml } from "../../../lib/blocks/inlineScriptNonce";
import { substitutePrivacyMergeTags } from "../../../lib/privacy/contact-emails";
import { isTiptapJsonString } from "./tiptap-json-string";

export type TextBlockContent = {
    html_content?: string;
};

interface TextBlockRendererProps {
  content: TextBlockContent;
  languageId: number;
  visualEditAttributes?: VisualEditAttributes;
  renderContext?: 'prose' | 'section';
  /** Above-the-fold block: the first YouTube embed's poster is preloaded (LCP). */
  priority?: boolean;
}

const TextBlockRenderer: React.FC<TextBlockRendererProps> = async ({
  content,
  languageId,
  visualEditAttributes,
  renderContext = 'prose',
  priority = false,
}) => {
  let html = content.html_content || '';
  if (html.includes('{{')) {
    html = await substitutePrivacyMergeTags(html);
  }
  // Tiptap JSON renders through React, which escapes its text (isTiptapJsonString): the HTML
  // sanitizer would show an authored `a<b` as `a&lt;b`. Everything else is HTML.
  const safeHtml = isTiptapJsonString(html) ? html : sanitizeAuthoredBlockHtml(html);
  const patchedContent = { ...content, html_content: safeHtml };
  return (
    <ClientTextBlockRenderer
      content={patchedContent}
      languageId={languageId}
      visualEditAttributes={visualEditAttributes}
      renderContext={renderContext}
      priority={priority}
    />
  );
};

export default TextBlockRenderer;
