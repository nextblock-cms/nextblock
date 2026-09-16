// app/[slug]/page.tsx
import React from 'react';
import { getSsgSupabaseClient } from "@nextblock-cms/db/server";
import { buildPublishedAtOrFilter } from "@nextblock-cms/utils";
import { notFound } from "next/navigation";
import type { Metadata } from 'next';
import PageClientContent from "./PageClientContent";
import { getCachedPublishedPageTranslatedSlugs, getPageDataBySlug } from "./page.utils";
import BlockRenderer from "../../components/BlockRenderer";
import { cookies, draftMode, headers } from "next/headers";
import {
  resolveMetaTitle,
  resolvePageMetaDescription,
  stringifyJsonLd,
  buildSocialMetadata,
  buildCanonicalUrl,
  toOpenGraphLocale,
} from "../lib/seo";
import { getSiteSettings } from "../lib/site-settings";
import { getRequestOrigin } from "../../lib/visual-editing/edit-info";
import { resolveSiteUrl } from "../../lib/site-url";

export const dynamicParams = true;
export const revalidate = 360;
export const dynamic = 'force-dynamic'; // keeps per-request locale; paired with short revalidate
// No `fetchCache = 'force-no-store'` here: Next disables `unstable_cache` under it, which
// silently turned off the root layout's cached reads (navigation, translations, themes)
// on every page served by this route. `force-dynamic` already keeps fetch() uncached.

interface ResolvedPageParams {
  slug: string;
}

interface PageProps {
  params: Promise<ResolvedPageParams>;
}

export async function generateStaticParams(): Promise<ResolvedPageParams[]> {
  // Unconfigured instance (pre-/setup): no DB to read slugs from. Accept every Supabase
  // key alias the Vercel integration may inject (incl. the new publishable key).
  const hasSupabaseEnv =
    (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) &&
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY);
  if (!hasSupabaseEnv) {
    return [];
  }

  const supabase = getSsgSupabaseClient();
  const { data: pages, error } = await supabase
    .from("pages")
    .select("slug")
    .eq("status", "published")
    .or(buildPublishedAtOrFilter());

  if (error || !pages) {
    console.error("SSG: Error fetching page slugs for static params:", error);
    return [];
  }
  return pages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata(
  { params: paramsPromise }: PageProps,
): Promise<Metadata> {
  const params = await paramsPromise;
  let preferredLocale: string | undefined;
  try {
    const store = await cookies();
    preferredLocale = store.get("NEXT_USER_LOCALE")?.value || store.get("NEXT_LOCALE")?.value;
  } catch {
    preferredLocale = undefined;
  }
  if (!preferredLocale) {
    try {
      const hdrs = await headers();
      // Proxy-detected locale first: it honors the CMS language-detection settings.
      preferredLocale = hdrs.get("x-user-locale") || undefined;
      if (!preferredLocale) {
        const al = hdrs.get("accept-language");
        if (al) preferredLocale = al.split(",")[0]?.split("-")[0];
      }
    } catch {
      // ignore header lookup errors
    }
  }
  const pageData = await getPageDataBySlug(params.slug, preferredLocale);

  if (!pageData) {
    return { title: "Page Not Found" };
  }

  // No trailing slash: NEXT_PUBLIC_URL is often set as "https://host/", which made
  // hreflang, canonical and JSON-LD URLs come out as "https://host//slug".
  const siteUrl = resolveSiteUrl('');

  // Cached `code -> slug` map of the published translations (a scheduled one is never
  // advertised via hreflang); shared with the page body and the language switcher.
  const alternates: { [key: string]: string } = {};
  if (pageData.translation_group_id) {
    const slugs = await getCachedPublishedPageTranslatedSlugs(pageData.translation_group_id);
    for (const [code, slug] of Object.entries(slugs)) {
      alternates[code] = `${siteUrl}/${slug}`;
    }
  }

  const title = resolveMetaTitle(pageData.meta_title, pageData.title);
  const description = resolvePageMetaDescription(pageData.meta_description, pageData.blocks);
  const { siteTitle, socialImage } = await getSiteSettings();
  // Self-referencing `<siteUrl>/<slug>` unless the page sets a manual custom_canonical override.
  const canonicalUrl = buildCanonicalUrl(pageData.custom_canonical, siteUrl, `/${params.slug}`);

  return {
    title,
    description,
    ...buildSocialMetadata({
      title,
      description,
      url: canonicalUrl,
      siteTitle,
      imageUrl: pageData.feature_image_social_url ?? pageData.feature_image_url,
      fallbackImage: socialImage,
      type: 'website',
      locale: toOpenGraphLocale(pageData.language_code),
    }),
    alternates: {
      canonical: canonicalUrl,
      languages: Object.keys(alternates).length > 0 ? alternates : undefined,
    },
  };
}

export default async function DynamicPage({ params: paramsPromise }: PageProps) {
  const params = await paramsPromise;
  let preferredLocale: string | undefined;
  try {
    const store = await cookies();
    preferredLocale = store.get("NEXT_USER_LOCALE")?.value || store.get("NEXT_LOCALE")?.value;
  } catch {
    preferredLocale = undefined;
  }
  if (!preferredLocale) {
    try {
      const hdrs = await headers();
      // Proxy-detected locale first: it honors the CMS language-detection settings.
      preferredLocale = hdrs.get("x-user-locale") || undefined;
      if (!preferredLocale) {
        const al = hdrs.get("accept-language");
        if (al) preferredLocale = al.split(",")[0]?.split("-")[0];
      }
    } catch {
      // ignore header lookup errors
    }
  }
  const pageData = await getPageDataBySlug(params.slug, preferredLocale);

  if (!pageData) {
    notFound();
  }

  const translatedSlugs: { [key: string]: string } = pageData.translation_group_id
    ? await getCachedPublishedPageTranslatedSlugs(pageData.translation_group_id)
    : {};



  const requestOrigin = await getRequestOrigin();
  const draft = await draftMode();
  const visualEditingEnabled =
    draft.isEnabled || process.env.NEXTBLOCK_VISUAL_EDITING_ENABLED === 'true';
  // No trailing slash: NEXT_PUBLIC_URL is often set as "https://host/", which made
  // hreflang, canonical and JSON-LD URLs come out as "https://host//slug".
  const siteUrl = resolveSiteUrl('');
  const nonce = (await headers()).get('x-nonce') || undefined;
  const title = resolveMetaTitle(pageData.meta_title, pageData.title);
  const description = resolvePageMetaDescription(pageData.meta_description, pageData.blocks);
  const pageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url: `${siteUrl}/${params.slug}`,
    inLanguage: pageData.language_code,
  };
  const pageBlocks = pageData ? (
    <BlockRenderer
      blocks={pageData.blocks}
      languageId={pageData.language_id}
      visualEditing={{
        enabled: visualEditingEnabled,
        documentType: "page",
        documentId: pageData.id,
        slug: pageData.slug,
        languageId: pageData.language_id,
        draftId: pageData.draft_id ?? null,
        pageOrigin: requestOrigin,
      }}
    />
  ) : null;

  return (
    <>
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: stringifyJsonLd(pageJsonLd) }}
      />
      {/* Blocks are rendered above as server components; re-sending them as a client
          prop only bloats the RSC payload. PageClientContent never reads them. */}
      <PageClientContent
        initialPageData={{ ...pageData, blocks: [] }}
        currentSlug={params.slug}
        translatedSlugs={translatedSlugs}
      >
        {pageBlocks}
      </PageClientContent>
    </>
  );
}
