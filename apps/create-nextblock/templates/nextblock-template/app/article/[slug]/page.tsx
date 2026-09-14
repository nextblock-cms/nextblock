// app/article/[slug]/page.tsx
import React from 'react';
import { notFound } from "next/navigation";
import type { Metadata } from 'next';
import PostClientContent from "./PostClientContent";

import { getCachedPublishedPostTranslatedSlugs, getPostDataBySlug } from "./page.utils";
import BlockRenderer from "../../../components/BlockRenderer";
import { getSsgSupabaseClient } from "@nextblock-cms/db/server"; // Correct import
import type { SectionBlockContent } from '../../../lib/blocks/blockRegistry';
import { resolveMediaUrl } from '../../../lib/media/resolveMediaUrl';
import {
  resolveMetaTitle,
  resolvePostMetaDescription,
  stringifyJsonLd,
  buildSocialMetadata,
  buildCanonicalUrl,
  toOpenGraphLocale,
} from '../../lib/seo';
import { getSiteSettings } from '../../lib/site-settings';
import { draftMode, headers } from 'next/headers';
import { getRequestOrigin } from '../../../lib/visual-editing/edit-info';

export const dynamicParams = true;
export const revalidate = 3600;
// Render per-request: the shared root layout reads cookies()/headers()/draftMode() (auth + locale),
// so attempting a statically-cached render throws DYNAMIC_SERVER_USAGE (500). Matches the sibling
// content routes /[slug] and /product/[slug], which already force dynamic for the same reason.
export const dynamic = 'force-dynamic';
// No `fetchCache = 'force-no-store'`: Next disables `unstable_cache` under it, which would
// switch off the cached post read below AND the root layout's cached reads on this route.

interface ResolvedPostParams {
  slug: string;
}

interface PostPageProps {
  params: Promise<ResolvedPostParams>;
}

export async function generateStaticParams(): Promise<ResolvedPostParams[]> {
  // Cookie-free SSG client. getSsgSupabaseClient() resolves the Supabase URL/anon key
  // under every alias the Vercel integration may inject (incl. the new publishable key)
  // and degrades to a dummy client when unconfigured (the query below then returns []).
  const supabase = getSsgSupabaseClient();

  const { data: posts, error } = await supabase
    .from("posts")
    .select("slug")
    .eq("status", "published")
    .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`);

  if (error || !posts) {
    console.error("SSG (Posts): Error fetching post slugs for static params", error);
    return [];
  }
  return posts.map((post) => ({ slug: post.slug }));
}

// Generate metadata for the specific post slug
export async function generateMetadata(
  { params: paramsPromise }: PostPageProps,
): Promise<Metadata> {
  const params = await paramsPromise; // Await the promise to get the actual params
  const postData = await getPostDataBySlug(params.slug);

  if (!postData) {
    return {
      title: "Article Not Found",
      description: "The article you are looking for does not exist or is not yet published.",
    };
  }

  const siteUrl = process.env.NEXT_PUBLIC_URL || "";
  const supabase = getSsgSupabaseClient();
  const { data: languages } = await supabase.from('languages').select('id, code');
  const { data: postTranslations } = await supabase
    .from('posts')
    .select('language_id, slug')
    .eq('translation_group_id', postData.translation_group_id)
    .eq('status', 'published')
    .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`);

  const alternates: { [key: string]: string } = {};
  if (languages && postTranslations) {
    postTranslations.forEach(pt => {
      const langInfo = languages.find(l => l.id === pt.language_id);
      if (langInfo) {
        alternates[langInfo.code] = `${siteUrl}/article/${pt.slug}`;
      }
    });
  }

  const title = resolveMetaTitle(postData.meta_title, postData.title);
  const description = resolvePostMetaDescription(postData.meta_description, postData.subtitle);
  const { siteTitle } = await getSiteSettings();
  // Self-referencing `<siteUrl>/article/<slug>` unless the post sets a manual custom_canonical override.
  const canonicalUrl = buildCanonicalUrl(postData.custom_canonical, siteUrl, `/article/${params.slug}`);

  return {
    title,
    description,
    ...buildSocialMetadata({
      title,
      description,
      url: canonicalUrl,
      siteTitle,
      imageUrl: postData.feature_image_url,
      type: 'article',
      publishedTime: postData.published_at || postData.created_at,
      locale: toOpenGraphLocale(postData.language_code),
    }),
    alternates: {
      canonical: canonicalUrl,
      languages: Object.keys(alternates).length > 0 ? alternates : undefined,
    },
  };
}

// Server Component: Fetches data for the specific slug and passes to Client Component
export default async function DynamicPostPage({ params: paramsPromise }: PostPageProps) { // Destructure the promise
  const params = await paramsPromise; // Await the promise
  const initialPostData = await getPostDataBySlug(params.slug);

  if (!initialPostData) {
    notFound();
  }

  // Cached alongside the post itself (see lib/public-content-cache.ts).
  const translatedSlugs: { [key: string]: string } = initialPostData.translation_group_id
    ? await getCachedPublishedPostTranslatedSlugs(initialPostData.translation_group_id)
    : {};

  let lcpImageUrl: string | null = null;

  if (initialPostData && initialPostData.blocks) {
    const heroBlock = initialPostData.blocks.find(block => block.block_type === 'section' && (block.content as any)?.is_hero);
    if (heroBlock) {
      const heroContent = heroBlock.content as unknown as SectionBlockContent;
      if (
        heroContent.background &&
        heroContent.background.type === "image" &&
        heroContent.background.image &&
        heroContent.background.image.object_key
      ) {
        lcpImageUrl = resolveMediaUrl(heroContent.background.image.object_key);
      }
    }
  }

  const requestOrigin = await getRequestOrigin();
  const draft = await draftMode();
  const visualEditingEnabled =
    draft.isEnabled || process.env.NEXTBLOCK_VISUAL_EDITING_ENABLED === 'true';
  const siteUrl = process.env.NEXT_PUBLIC_URL || "";
  const nonce = (await headers()).get('x-nonce') || undefined;
  const title = resolveMetaTitle(initialPostData.meta_title, initialPostData.title);
  const description = resolvePostMetaDescription(
    initialPostData.meta_description,
    initialPostData.subtitle
  );
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description,
    image: initialPostData.feature_image_url ? [initialPostData.feature_image_url] : undefined,
    datePublished: initialPostData.published_at || initialPostData.created_at,
    dateModified: initialPostData.updated_at,
    inLanguage: initialPostData.language_code,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${siteUrl}/article/${initialPostData.slug}`,
    },
  };
  const postBlocks = initialPostData ? (
    <BlockRenderer
      blocks={initialPostData.blocks}
      languageId={initialPostData.language_id}
      visualEditing={{
        enabled: visualEditingEnabled,
        documentType: "post",
        documentId: initialPostData.id,
        slug: initialPostData.slug,
        languageId: initialPostData.language_id,
        draftId: initialPostData.draft_id ?? null,
        pageOrigin: requestOrigin,
      }}
    />
  ) : null;

  return (
    <>
      {lcpImageUrl && (
        <link rel="preload" as="image" href={lcpImageUrl} />
      )}
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: stringifyJsonLd(articleJsonLd) }}
      />
      <PostClientContent initialPostData={initialPostData} currentSlug={params.slug} translatedSlugs={translatedSlugs}>
        {postBlocks}
      </PostClientContent>
    </>
  );
}
