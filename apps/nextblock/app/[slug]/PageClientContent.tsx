// app/[slug]/PageClientContent.tsx
"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation'; // For navigation on lang switch
import type { Database } from "@nextblock-cms/db";
import { useLanguage } from '../../context/LanguageContext';
import { useCurrentContent } from '../../context/CurrentContentContext';
import Link from 'next/link';
import { getPublishedPageForLocale } from './pageClientActions';

type PageType = Database['public']['Tables']['pages']['Row'];
type BlockType = Database['public']['Tables']['blocks']['Row'];

interface PageClientContentProps {
  initialPageData: (PageType & {
    /**
     * Intentionally empty when rendered from the page routes: the blocks are
     * server-rendered and passed as `children`, and shipping them here again
     * would duplicate the whole page in the RSC payload. Only the locale
     * refetch path (getPublishedPageForLocale) fills this in.
     */
    blocks: BlockType[];
    language_code: string;
    language_id: number;
    translation_group_id: string | null;
    feature_image_url?: string | null;
    feature_image_blur_data_url?: string | null;
    feature_image_width?: number | null;
    feature_image_height?: number | null;
  }) | null;
  currentSlug: string; // The slug of the currently viewed page
  children: React.ReactNode;
  translatedSlugs?: { [key: string]: string };
}

// Fetches the slug for a given translation_group_id and target language_code
// This function is no longer needed here as slugs are pre-fetched.
// async function getSlugForTranslatedPage(
//   translationGroupId: string,
//   targetLanguageCode: string,
//   supabase: ReturnType<typeof createClient>
// ): Promise<string | null> {
//   const { data: langInfo, error: langErr } = await supabase
//     .from("languages").select("id").eq("code", targetLanguageCode).single();
//   if (langErr || !langInfo) return null;

//   const { data: page, error: pageErr } = await supabase
//     .from("pages")
//     .select("slug")
//     .eq("translation_group_id", translationGroupId)
//     .eq("language_id", langInfo.id)
//     .eq("status", "published")
//     .single();
  
//   if (pageErr || !page) return null;
//   return page.slug;
// }


export default function PageClientContent({ initialPageData, currentSlug, children, translatedSlugs }: PageClientContentProps) {
  const { currentLocale, isLoadingLanguages } = useLanguage();
  const { currentContent, setCurrentContent } = useCurrentContent();
  const router = useRouter();
  // currentPageData is the data for the slug currently in the URL.
  // It's initially set by the server for the slug it resolved.
  const [currentPageData, setCurrentPageData] = useState(initialPageData);
  const [isLoadingTargetLang, setIsLoadingTargetLang] = useState(false);
  // Memoize pageId and pageSlug
  const pageId = useMemo(() => currentPageData?.id, [currentPageData?.id]);
  const pageSlug = useMemo(() => currentPageData?.slug, [currentPageData?.id, currentLocale]); // include locale so updates propagate

  useEffect(() => {
    if (currentLocale && currentPageData && currentPageData.language_code !== currentLocale && translatedSlugs) {
      // Current page's language doesn't match context, try to navigate to translated version
      setIsLoadingTargetLang(true);
      const targetSlug = translatedSlugs[currentLocale];
      
      if (targetSlug && targetSlug !== currentSlug) {
        router.push(`/${targetSlug}`); // Navigate to the translated slug's URL
      } else if (targetSlug && targetSlug === currentSlug) {
        // Same slug across languages - refetch the page in the target language and update content
        (async () => {
          const data = await getPublishedPageForLocale(targetSlug, currentLocale);

          if (data) {
            setCurrentPageData(data as typeof currentPageData);
          } else {
            // fallback to refresh if fetch fails
            router.refresh();
          }
          setIsLoadingTargetLang(false);
        })();
      } else {
        console.warn(`No published translation found for group ${currentPageData.translation_group_id} in language ${currentLocale} using pre-fetched slugs.`);
        // Optionally, provide feedback to the user that translation is not available
        setIsLoadingTargetLang(false);
      }
    }
  }, [currentLocale, currentPageData, currentSlug, router, translatedSlugs]); // Rerun if route data or locale changes

  // Update HTML lang attribute based on the *actually displayed* content's language
  useEffect(() => {
    if (currentPageData?.language_code) {
      document.documentElement.lang = currentPageData.language_code;
      if (currentPageData.meta_title || currentPageData.title) {
         document.title = currentPageData.meta_title || currentPageData.title;
      }
    }
  }, [currentPageData]);

  // Effect for setting or updating the context
  useEffect(() => {
    const newType = 'page' as const;
    const slugToSet = pageSlug ?? null; // Ensures slug is string or null

    const needsUpdate = pageId &&
                        (currentContent.id !== pageId ||
                         currentContent.type !== newType ||
                         currentContent.slug !== slugToSet);

    const needsClearing = !pageId &&
                          (currentContent.id !== null ||
                           currentContent.type !== null ||
                           currentContent.slug !== null);

    if (needsUpdate) {
      setCurrentContent({ 
        id: pageId, 
        type: newType, 
        slug: slugToSet, 
        translation_group_id: currentPageData?.translation_group_id 
      });
    } else if (needsClearing) {
      setCurrentContent({ id: null, type: null, slug: null, translation_group_id: null });
    }
  }, [pageId, pageSlug, setCurrentContent, currentContent.id, currentContent.type, currentContent.slug, currentContent.translation_group_id, currentPageData?.translation_group_id]);

  // Separate useEffect for cleanup
  useEffect(() => {
    const idToClean = pageId; // Capture the pageId when this effect runs

    return () => {
      // Cleanup logic: only clear context if the current context ID matches the ID this instance was managing
      if (idToClean && currentContent.id === idToClean) {
        setCurrentContent({ id: null, type: null, slug: null });
      }
    };
  }, [pageId, setCurrentContent, currentContent.id]);

  if (!currentPageData && !isLoadingLanguages && !isLoadingTargetLang) { // If initial data was null and no target lang found
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Page Not Found</h1>
        <p className="text-muted-foreground">The page for slug &quot;{currentSlug}&quot; could not be loaded or is not available in any language.</p>
        <p className="mt-4"><Link href="/" className="text-primary hover:underline">Go to Homepage</Link></p>
      </div>
    );
  }
  
  if (!currentPageData && (isLoadingLanguages || isLoadingTargetLang)) {
     return <div className="container mx-auto px-4 py-20 text-center"><p>Loading page content...</p></div>;
  }
  
  if (!currentPageData) { // Fallback if still no data after loading attempts
     return <div className="container mx-auto px-4 py-20 text-center"><p>Could not load page content.</p></div>;
  }


  return (
    <article className="w-full mx-auto">
      {isLoadingTargetLang && <div className="text-center py-2 text-sm text-muted-foreground">Switching language...</div>}

      {currentPageData.feature_image_url ? (
        <div className="relative h-48 w-full overflow-hidden bg-slate-950 sm:h-56 md:h-64 lg:h-72">
          <Image
            src={currentPageData.feature_image_url}
            alt={`Feature image for ${currentPageData.title}`}
            fill
            sizes="100vw"
            className="object-cover"
            placeholder={currentPageData.feature_image_blur_data_url ? "blur" : "empty"}
            blurDataURL={currentPageData.feature_image_blur_data_url ?? undefined}
            priority
          />
          <div className="absolute inset-0 bg-slate-950/45" />
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
            <div className="max-w-5xl break-words text-3xl font-semibold leading-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.65)] sm:text-4xl md:text-5xl">
              {currentPageData.title}
            </div>
          </div>
        </div>
      ) : null}
      
      {/* Render blocks passed as children */}
      {children}
    </article>
  );
}
