import React from 'react';
import { Element, type HTMLReactParserOptions } from 'html-react-parser';
import YouTubeFacade from './YouTubeFacade';
import { parseYouTubeUrl } from '../../lib/media/youtube';

export interface ReplaceYouTubeIframeOptions {
  /**
   * Above-the-fold embed: preload the poster, mark it fetchpriority=high and drop
   * lazy-loading (see YouTubeFacade). The hero's rich text is where this matters:
   * the poster is routinely the page's LCP element, and a lazy-loaded LCP image
   * costs seconds on mobile. Also honored when the editor put
   * fetchpriority="high" on the iframe itself.
   */
  priority?: boolean;
}

/**
 * html-react-parser `replace` helper: swaps any YouTube <iframe> for a
 * click-to-play facade (zero third-party requests on load) and forces
 * loading="lazy" on every other third-party frame.
 * Returns undefined to let the parser render the node normally.
 */
export function replaceYouTubeIframe(
  domNode: Element,
  options: ReplaceYouTubeIframeOptions = {},
): React.ReactElement | undefined {
  if (domNode.name !== 'iframe' || !domNode.attribs) return undefined;
  const parsed = parseYouTubeUrl(domNode.attribs.src);
  if (!parsed) {
    if (!domNode.attribs.loading) domNode.attribs.loading = 'lazy';
    return undefined;
  }
  const priority =
    options.priority === true || domNode.attribs.fetchpriority?.toLowerCase() === 'high';
  return (
    <YouTubeFacade
      videoId={parsed.videoId}
      title={domNode.attribs.title}
      query={parsed.params.toString()}
      className={domNode.attribs.class}
      priority={priority}
    />
  );
}

/** Minimal parser options for raw-HTML surfaces that only need embed safety. */
export const embedSafeParserOptions: HTMLReactParserOptions = {
  replace: (domNode) => (domNode instanceof Element ? replaceYouTubeIframe(domNode) : undefined),
};
