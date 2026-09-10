// app/article/[slug]/PostClientContent.tsx
"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { Database } from "@nextblock-cms/db";
import { useLanguage } from '../../../context/LanguageContext';
import { useCurrentContent } from '../../../context/CurrentContentContext';
import Link from 'next/link';
import { estimateReadTimeMinutesFromBlocks } from '../../../lib/posts/readTime';
import FeatureImageHero from '../../../components/FeatureImageHero';
import PostCommentsSection from '../../../components/PostCommentsSection';

type PostType = Database['public']['Tables']['posts']['Row'];
type BlockType = Database['public']['Tables']['blocks']['Row'];

export type ImageBlockContent = {
  media_id: string | null;
  object_key?: string;
};

interface PostClientContentProps {
  initialPostData: (PostType & {
    blocks: BlockType[];
    language_code: string;
    language_id: number;
    translation_group_id: string;
    feature_image_url?: string | null;
    feature_image_alt?: string | null;
    feature_image_blur_data_url?: string | null;
    feature_image_width?: number | null;
    feature_image_height?: number | null;
  }) | null;
  currentSlug: string; // The slug of the currently viewed page/post
  children: React.ReactNode;
  translatedSlugs?: { [key: string]: string };
}

type PostPresentation = {
  badgeClassName: string;
  featureFrameClassName: string;
  featureImageClassName: string;
  articleClassName?: string;
};

const editorialCategories: Record<string, PostPresentation> = {
  'how-nextblock-works': {
    badgeClassName:
      'border-sky-200/80 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.28),_transparent_48%),linear-gradient(135deg,#020617,#0f172a_55%,#1e293b)]',
    featureImageClassName: 'h-full w-full object-cover',
  },
  'comment-nextblock-fonctionne': {
    badgeClassName:
      'border-sky-200/80 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.28),_transparent_48%),linear-gradient(135deg,#020617,#0f172a_55%,#1e293b)]',
    featureImageClassName: 'h-full w-full object-cover',
  },
  'how-to-setup-nextblock': {
    badgeClassName:
      'border-indigo-200/80 bg-indigo-50 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.32),_transparent_45%),linear-gradient(135deg,#020617,#111827_55%,#172554)]',
    featureImageClassName: 'h-full w-full object-cover',
    articleClassName: 'post-article--tutorial',
  },
  'comment-configurer-nextblock': {
    badgeClassName:
      'border-indigo-200/80 bg-indigo-50 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.32),_transparent_45%),linear-gradient(135deg,#020617,#111827_55%,#172554)]',
    featureImageClassName: 'h-full w-full object-cover',
    articleClassName: 'post-article--tutorial',
  },
  'nextblock-commerce-guide': {
    badgeClassName:
      'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.28),_transparent_45%),linear-gradient(135deg,#021c17,#052e2b_55%,#0f172a)]',
    featureImageClassName: 'h-full w-full object-cover',
  },
  'guide-commerce-nextblock': {
    badgeClassName:
      'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.28),_transparent_45%),linear-gradient(135deg,#021c17,#052e2b_55%,#0f172a)]',
    featureImageClassName: 'h-full w-full object-cover',
  },
};

function getPostPresentation(slug: string | undefined): PostPresentation {
  if (!slug) {
    return {
      badgeClassName:
        'border-slate-200/80 bg-slate-50 text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200',
      featureFrameClassName:
        'bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_45%),linear-gradient(135deg,#020617,#111827_55%,#1f2937)]',
      featureImageClassName: 'h-full w-full object-cover',
    };
  }

  const matched = editorialCategories[slug];
  if (matched) {
    return matched;
  }

  return {
    badgeClassName:
      'border-slate-200/80 bg-slate-50 text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200',
    featureFrameClassName:
      'bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_45%),linear-gradient(135deg,#020617,#111827_55%,#1f2937)]',
    featureImageClassName: 'h-full w-full object-cover',
  };
}

function getFallbackDescription(locale: string | undefined) {
  return locale === 'fr'
    ? 'Notes techniques, guides de mise en route et apercus produit de l equipe NextBlock.'
    : 'Technical breakdowns, launch guides, and product notes from the NextBlock™ team.';
}

function getFallbackLabel(slug: string | undefined, locale: string | undefined) {
  if (!slug) {
    return locale === 'fr' ? 'Journal' : 'Journal';
  }

  return locale === 'fr' ? 'Article' : 'Article';
}

function enhanceTutorialCodeBlocks(root: HTMLDivElement | null) {
  if (!root) return;

  const codeBlocks = root.querySelectorAll('pre code');

  codeBlocks.forEach((codeBlock) => {
    if (!(codeBlock instanceof HTMLElement) || codeBlock.dataset.terminalized === 'true') {
      return;
    }

    const pre = codeBlock.parentElement;
    if (!(pre instanceof HTMLElement)) {
      return;
    }

    const normalizedText = (codeBlock.textContent ?? '').replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    const meaningfulLines = lines.filter((line) => line.trim().length > 0);

    if (meaningfulLines.length === 0) {
      return;
    }

    const isEnvBlock = meaningfulLines.every((line) => /^[A-Z][A-Z0-9_]*=/.test(line.trim()));

    pre.classList.add('terminal-block');
    pre.classList.add(isEnvBlock ? 'terminal-block--config' : 'terminal-block--shell');

    codeBlock.textContent = '';

    lines.forEach((line) => {
      const terminalLine = document.createElement('span');
      terminalLine.classList.add('terminal-line');

      if (!line.trim()) {
        terminalLine.classList.add('terminal-line--spacer');
        terminalLine.innerHTML = '&nbsp;';
        codeBlock.appendChild(terminalLine);
        return;
      }

      if (!isEnvBlock && /^\s*#/.test(line)) {
        terminalLine.classList.add('terminal-line--comment');
        terminalLine.textContent = line.replace(/^\s*#\s?/, '');
        codeBlock.appendChild(terminalLine);
        return;
      }

      if (isEnvBlock) {
        terminalLine.classList.add('terminal-line--env');

        const envMatch = line.match(/^([A-Z][A-Z0-9_]*)(=)(.*)$/);
        if (envMatch) {
          const [, key, separator, value] = envMatch;

          const keySpan = document.createElement('span');
          keySpan.classList.add('terminal-env-key');
          keySpan.textContent = key;

          const separatorSpan = document.createElement('span');
          separatorSpan.classList.add('terminal-env-separator');
          separatorSpan.textContent = separator;

          const valueSpan = document.createElement('span');
          valueSpan.classList.add('terminal-env-value');
          valueSpan.textContent = value;

          terminalLine.append(keySpan, separatorSpan, valueSpan);
        } else {
          terminalLine.textContent = line;
        }

        codeBlock.appendChild(terminalLine);
        return;
      }

      terminalLine.classList.add('terminal-line--command');
      const promptSpan = document.createElement('span');
      promptSpan.classList.add('terminal-prompt');
      promptSpan.textContent = '>';

      const commandTextSpan = document.createElement('span');
      commandTextSpan.classList.add('terminal-command-text');
      commandTextSpan.textContent = line;

      terminalLine.append(promptSpan, commandTextSpan);
      codeBlock.appendChild(terminalLine);
    });

    codeBlock.dataset.terminalized = 'true';
  });
}

export default function PostClientContent({ initialPostData, currentSlug, children, translatedSlugs }: PostClientContentProps) {
  const { currentLocale, isLoadingLanguages } = useLanguage();
  const { currentContent, setCurrentContent } = useCurrentContent();
  const router = useRouter();
  const articleBodyRef = useRef<HTMLDivElement | null>(null);
  
  const currentPrefix = "articles";

  // currentPostData is always for the slug in the URL.
  // It's initially set by the server. It only changes if the URL itself changes (which happens on language switch).
  const [currentPostData, setCurrentPostData] = useState(initialPostData);
  const [isLoadingTargetLang, setIsLoadingTargetLang] = useState(false); // For feedback during navigation

  // Memoize postId and postSlug
  const postId = useMemo(() => currentPostData?.id, [currentPostData?.id]);
  const postSlug = useMemo(() => currentPostData?.slug, [currentPostData?.slug]);
  const postPresentation = useMemo(
    () => getPostPresentation(postSlug),
    [postSlug]
  );
  const estimatedReadTime = useMemo(
    () => estimateReadTimeMinutesFromBlocks(currentPostData?.blocks),
    [currentPostData?.blocks]
  );
  const fallbackDescription = useMemo(
    () => getFallbackDescription(currentPostData?.language_code),
    [currentPostData?.language_code]
  );
  const displayLabel = useMemo(() => {
    const label = currentPostData?.label?.trim();
    return label || getFallbackLabel(postSlug, currentPostData?.language_code);
  }, [currentPostData?.label, currentPostData?.language_code, postSlug]);
  const displaySummary = useMemo(() => {
    const summary = currentPostData?.excerpt?.trim();
    return summary || fallbackDescription;
  }, [currentPostData?.excerpt, fallbackDescription]);
  const displaySubtitle = useMemo(() => {
    return currentPostData?.subtitle?.trim() || null;
  }, [currentPostData?.subtitle]);
  const publishedLabel = useMemo(() => {
    if (!currentPostData?.published_at) {
      return null;
    }

    return new Date(currentPostData.published_at).toLocaleDateString(currentPostData.language_code, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }, [currentPostData?.language_code, currentPostData?.published_at]);

  // This effect handles navigation when the language context changes
  useEffect(() => {
    if (!isLoadingLanguages && currentLocale && initialPostData && initialPostData.language_code !== currentLocale && translatedSlugs) {
      // The current page's language (from initialPostData.language_code)
      // does not match the user's selected language (currentLocale).
      // We need to find the slug for the currentLocale version of this post and navigate.
      setIsLoadingTargetLang(true);
      const targetSlug = translatedSlugs[currentLocale];

      if (targetSlug && targetSlug !== currentSlug) {
        router.push(`/article/${targetSlug}`); // Navigate to the translated slug's URL
      } else if (!targetSlug) {
        console.warn(`No published translation found for post group ${initialPostData.translation_group_id} in language ${currentLocale} using pre-fetched slugs.`);
        // Optionally, provide user feedback here (e.g., a toast message)
        // For now, the user remains on the current page.
      }
      // If targetSlug === currentSlug, we are already on the correct page for the selected language.
      setIsLoadingTargetLang(false);
    }
  }, [currentLocale, isLoadingLanguages, initialPostData, currentSlug, router, translatedSlugs]);

  // This effect updates the document based on the currently displayed data
  useEffect(() => {
    if (currentPostData?.language_code) {
      document.documentElement.lang = currentPostData.language_code;
      if (currentPostData.meta_title || currentPostData.title) {
         document.title = currentPostData.meta_title || currentPostData.title;
      }
    }
  }, [currentPostData]);

  // Update currentPostData if initialPostData changes (e.g., after ISR revalidation of the current slug)
  useEffect(() => {
    setCurrentPostData(initialPostData);
  }, [initialPostData]);

  useEffect(() => {
    if (postPresentation.articleClassName !== 'post-article--tutorial') {
      return;
    }

    enhanceTutorialCodeBlocks(articleBodyRef.current);
  }, [currentPostData?.id, postPresentation.articleClassName]);

  // Effect for setting or updating the context
  useEffect(() => {
    const newType = 'post' as const;
    const slugToSet = postSlug ?? null; // Ensures slug is string or null

    const needsUpdate = postId &&
                        (currentContent.id !== postId ||
                         currentContent.type !== newType ||
                         currentContent.slug !== slugToSet);

    const needsClearing = !postId &&
                          (currentContent.id !== null ||
                           currentContent.type !== null ||
                           currentContent.slug !== null);

    if (needsUpdate) {
      setCurrentContent({ id: postId, type: newType, slug: slugToSet, translation_group_id: currentPostData?.translation_group_id });
    } else if (needsClearing) {
      setCurrentContent({ id: null, type: null, slug: null, translation_group_id: null });
    }
  }, [postId, postSlug, currentPostData?.translation_group_id, setCurrentContent, currentContent.id, currentContent.type, currentContent.slug]);

  // Separate useEffect for cleanup
  useEffect(() => {
    const idToClean = postId; // Capture the postId when this effect runs

    return () => {
      // Cleanup logic: only clear context if the current context ID matches the ID this instance was managing
      if (idToClean && currentContent.id === idToClean) {
        setCurrentContent({ id: null, type: null, slug: null, translation_group_id: null });
      }
    };
  }, [postId, setCurrentContent, currentContent.id]);

  if (!currentPostData && !isLoadingLanguages && !isLoadingTargetLang) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Article Not Found</h1>
        <p className="text-muted-foreground">The article for slug &quot;{currentSlug}&quot; could not be loaded.</p>
        <p className="mt-4">
          <Link href={`/${currentPrefix}`} className="text-primary hover:underline">Back to Articles</Link>
          <span className="mx-2">|</span>
          <Link href="/" className="text-primary hover:underline">Go to Homepage</Link>
        </p>
      </div>
    );
  }
  
  if (!currentPostData && (isLoadingLanguages || isLoadingTargetLang)) {
     return <div className="container mx-auto px-4 py-20 text-center"><p>Loading article content...</p></div>;
  }

  if (!currentPostData) {
     return <div className="container mx-auto px-4 py-20 text-center"><p>Could not load article content for &quot;{currentSlug}&quot;.</p></div>;
  }

  return (
    <article className={`post-article w-full mx-auto pb-16 md:pb-24 ${postPresentation.articleClassName ?? ''}`}>
      {isLoadingTargetLang && <div className="text-center py-2 text-sm text-muted-foreground">Switching language...</div>}

      <div className="mx-auto max-w-6xl px-4 pt-6 md:pt-10">
        <div className="mb-4 flex items-center justify-between gap-4 text-sm">
          <Link
            href={`/${currentPrefix}`}
            className="inline-flex items-center gap-2 text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            <span aria-hidden="true">←</span>
            {currentPostData.language_code === 'fr' ? 'Retour aux articles' : 'Back to Articles'}
          </Link>
          <span className="hidden text-slate-500 dark:text-slate-400 md:inline">
            {displaySummary}
          </span>
        </div>

        {currentPostData?.feature_image_url ? (
          <FeatureImageHero
            imageUrl={currentPostData.feature_image_url}
            alt={currentPostData.feature_image_alt?.trim() || `Hero image for ${currentPostData.title}`}
            width={currentPostData.feature_image_width}
            height={currentPostData.feature_image_height}
            blurDataURL={currentPostData.feature_image_blur_data_url}
            frameClassName={postPresentation.featureFrameClassName}
            imageClassName={postPresentation.featureImageClassName}
            priority
          />
        ) : null}

        <header className={`mx-auto max-w-4xl rounded-[1.75rem] border border-slate-200/80 bg-background/95 px-6 py-8 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.4)] backdrop-blur dark:border-white/10 dark:bg-slate-950/90 ${currentPostData?.feature_image_url ? '-mt-12 md:-mt-16' : 'mt-6'}`}>
          <div className="mb-4 flex flex-wrap items-center justify-center gap-3 text-sm md:justify-start">
            <span className={`inline-flex items-center rounded-full border px-3 py-1 font-semibold ${postPresentation.badgeClassName}`}>
              {displayLabel}
            </span>
            {publishedLabel ? (
              <span className="text-slate-500 dark:text-slate-400">
                {publishedLabel}
              </span>
            ) : null}
            <span className="text-slate-500 dark:text-slate-400">
              {estimatedReadTime} {currentPostData.language_code === 'fr' ? 'min de lecture' : 'min read'}
            </span>
          </div>
          <h1 className="text-balance text-center text-4xl font-black tracking-tight text-slate-950 dark:text-slate-50 md:text-5xl lg:text-6xl">
            {currentPostData.title}
          </h1>
          {displaySubtitle ? (
            <p className="mt-5 text-center text-lg leading-8 text-slate-600 dark:text-slate-300 md:text-xl">
              {displaySubtitle}
            </p>
          ) : null}
        </header>
      </div>

      <div ref={articleBodyRef} className="post-article__body mx-auto mt-10 w-full px-4 md:mt-14">
        {children}
      </div>

      {/* Post Comments Section */}
      <div className="mx-auto max-w-4xl px-4 mt-16 border-t pt-10 border-slate-200 dark:border-slate-800">
        <PostCommentsSection postId={currentPostData.id} />
      </div>
    </article>
  );
}
