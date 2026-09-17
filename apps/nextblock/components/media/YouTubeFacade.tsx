'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { useLabel } from '../../lib/i18n/use-label';
import {
  buildNoCookieEmbedUrl,
  youTubePosterUrl,
  YOUTUBE_POSTER_DIMENSIONS,
  type YouTubePosterQuality,
} from '../../lib/media/youtube';

interface YouTubeFacadeProps {
  videoId: string;
  title?: string;
  /** Serialized extra player params (from parseYouTubeUrl). */
  query?: string;
  /** Classes for the clickable surface / injected iframe. Defaults to filling its parent. */
  className?: string;
  /**
   * Above-the-fold embeds. The poster is very often the page's LCP element, so
   * this preloads it, marks it fetchpriority=high and drops lazy-loading.
   */
  priority?: boolean;
  /** Responsive-srcset layout hint; override when the embed is not ~half-width. */
  sizes?: string;
}

const FILL = 'absolute inset-0 h-full w-full';
// The video block is content-width, so it is full-bleed on phones and roughly a
// column wide on desktop. Callers that know better pass their own `sizes`.
const DEFAULT_SIZES = '(max-width: 768px) 100vw, 50vw';

/**
 * Click-to-play YouTube facade: renders a poster + play button and loads no
 * youtube.com resource at all until the user clicks. This is what keeps the
 * Lighthouse `inspector-issues` audit green -- the nocookie host still writes
 * cookies from the player JS, so the only reliable fix is not booting the
 * player during the audit. See lib/media/youtube.ts.
 */
const YouTubeFacade: React.FC<YouTubeFacadeProps> = ({
  videoId,
  title,
  query,
  className,
  priority = false,
  sizes,
}) => {
  const [activated, setActivated] = useState(false);
  const [posterQuality, setPosterQuality] = useState<YouTubePosterQuality>('maxres');
  const translate = useLabel();
  const label = title || translate('video.untitled', 'YouTube video', 'Vidéo YouTube');
  const surface = className || FILL;
  const poster = youTubePosterUrl(videoId, posterQuality);
  const posterSize = YOUTUBE_POSTER_DIMENSIONS[posterQuality];

  if (activated) {
    return (
      <iframe
        className={surface}
        src={buildNoCookieEmbedUrl(videoId, new URLSearchParams(query || ''), { autoplay: true })}
        title={label}
        allow="autoplay; accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setActivated(true)}
      aria-label={translate('video.play', 'Play video: {title}', 'Lire la vidéo : {title}', { title: label })}
      className={`${surface} group flex items-center justify-center overflow-hidden border-0 bg-black p-0`}
    >
      {/* Routed through next/image on purpose: i.ytimg.com serves the poster as a
          full-size JPEG with a 2h cache TTL, which made a ~205 KiB download the LCP
          for a thumbnail-sized slot. The optimizer re-encodes to AVIF/WebP at the
          displayed width and serves it same-origin under the app's long cache TTL. */}
      <Image
        src={poster}
        alt=""
        aria-hidden="true"
        width={posterSize.width}
        height={posterSize.height}
        sizes={sizes || DEFAULT_SIZES}
        quality={60}
        priority={priority}
        fetchPriority={priority ? 'high' : undefined}
        loading={priority ? undefined : 'lazy'}
        decoding="async"
        // maxresdefault.jpg is not uploaded for every video; fall back to the
        // hqdefault variant, which always exists.
        onError={() => setPosterQuality((current) => (current === 'maxres' ? 'hq' : current))}
        className="absolute inset-0 h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
      />
      <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-black/70 text-white shadow-lg transition group-hover:scale-110 group-hover:bg-red-600">
        <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7" aria-hidden="true" focusable="false">
          <path d="M8 5v14l11-7z" fill="currentColor" />
        </svg>
      </span>
    </button>
  );
};

export default YouTubeFacade;
