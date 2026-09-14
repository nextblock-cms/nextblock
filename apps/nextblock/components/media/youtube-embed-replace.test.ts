import { describe, expect, it } from 'vitest';
import { Element } from 'html-react-parser';
import { replaceYouTubeIframe, type ReplaceYouTubeIframeOptions } from './youtube-embed-replace';

const EMBED = 'https://www.youtube-nocookie.com/embed/71MyfoL4YVM?si=jtlDXV6cSC8rDgz0';

function iframe(attribs: Record<string, string>) {
  return new Element('iframe', attribs);
}

/** Runs the replacer and fails the test if it did not produce a facade. */
function facadeProps(attribs: Record<string, string>, options?: ReplaceYouTubeIframeOptions) {
  const element = replaceYouTubeIframe(iframe(attribs), options);
  if (!element) throw new Error('expected a YouTubeFacade element');
  return element.props as Record<string, unknown>;
}

describe('replaceYouTubeIframe', () => {
  it('swaps a YouTube iframe for the facade with a lazy poster by default', () => {
    const props = facadeProps({ src: EMBED, title: 'Demo', class: 'abs' });
    expect(props).toMatchObject({ videoId: '71MyfoL4YVM', title: 'Demo', className: 'abs' });
    expect(props.priority).toBe(false);
  });

  it('marks the poster as priority for above-the-fold blocks', () => {
    expect(facadeProps({ src: EMBED }, { priority: true }).priority).toBe(true);
  });

  it('honours an explicit fetchpriority="high" set by the editor', () => {
    expect(facadeProps({ src: EMBED, fetchpriority: 'HIGH' }).priority).toBe(true);
  });

  it('leaves non-YouTube frames alone but forces them lazy', () => {
    const node = iframe({ src: 'https://player.vimeo.com/video/1' });
    expect(replaceYouTubeIframe(node, { priority: true })).toBeUndefined();
    expect(node.attribs.loading).toBe('lazy');
  });

  it('ignores elements that are not iframes', () => {
    expect(replaceYouTubeIframe(new Element('img', { src: EMBED }))).toBeUndefined();
  });
});
