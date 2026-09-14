import React from "react";
import { headers } from 'next/headers';
import ClientTextBlockRenderer from "./ClientTextBlockRenderer";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";
import { addNonceToInlineScripts } from "../../../lib/blocks/inlineScriptNonce";
import { substitutePrivacyMergeTags } from "../../../lib/privacy/contact-emails";

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
  const hdrs = await headers();
  const nonce = hdrs.get('x-nonce') || '';
  let html = content.html_content || '';
  if (html.includes('{{')) {
    html = await substitutePrivacyMergeTags(html);
  }
  const htmlWithNonce = html ? addNonceToInlineScripts(html, nonce) : '';
  const patchedContent = { ...content, html_content: htmlWithNonce };
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
