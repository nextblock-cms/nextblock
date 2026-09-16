import { getProductBySlug, getProducts, getProviderReadiness } from '@nextblock-cms/ecommerce/server';
import { pickOriginalUploadObjectKey } from '../../../lib/media/original-upload';
import {
  ProductProvider,
  mapRawVariantRelations,
  getVariantEffectivePriceRange,
  normalizePriceMap,
  normalizeSalePriceMap,
  resolveTranslatedText,
} from '@nextblock-cms/ecommerce';
import { getSsgSupabaseClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { LIVE_STATUS, buildPublishedAtOrFilter, isPubliclyVisible } from '@nextblock-cms/utils';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { draftMode, cookies, headers } from 'next/headers';
import { getPageDataBySlug } from "../../[slug]/page.utils";
import BlockRenderer from "../../../components/BlockRenderer";
import { CurrentContentSetter } from "../../../components/CurrentContentSetter";
import {
  applyProductDraftToProductRecord,
  getProductDraft,
} from "../../../lib/visual-editing/product-drafts";
import { getRequestOrigin } from "../../../lib/visual-editing/edit-info";
import {
  resolveMetaTitle,
  resolveProductMetaDescription,
  stringifyJsonLd,
  buildSocialMetadata,
  buildCanonicalUrl,
  toOpenGraphLocale,
} from "../../lib/seo";
import { getSiteSettings } from "../../lib/site-settings";
// Ensure BlockType is imported or compatible with BlockRenderer props
import type { Database } from "@nextblock-cms/db";
type BlockType = Database['public']['Tables']['blocks']['Row'];

export const dynamicParams = true;
export const revalidate = 360;
export const dynamic = 'force-dynamic'; // keeps per-request locale; paired with short revalidate
// No `fetchCache = 'force-no-store'`: Next disables `unstable_cache` under it, which switched
// off the root layout's cached reads (navigation, translations, themes) on product pages.

interface ProductPageProps {
  params: Promise<{
    slug: string;
  }>;
}

function formatMinorUnitAmount(amount: unknown) {
  const numericAmount = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return undefined;
  }

  return (numericAmount / 100).toFixed(2);
}

function resolveOfferAvailability(productRecord: any, canPurchase = true) {
  // Don't advertise a buyable offer for something checkout will refuse: a rich result
  // promising "InStock" that dead-ends at an enquiry form is worse than no offer badge.
  if (!canPurchase) {
    return 'https://schema.org/InStoreOnly';
  }

  if (productRecord.product_type === 'digital') {
    return 'https://schema.org/InStock';
  }

  return typeof productRecord.stock === 'number' && productRecord.stock <= 0
    ? 'https://schema.org/OutOfStock'
    : 'https://schema.org/InStock';
}

function resolveCategoryName(category: any, languageCode?: string | null) {
  if (!category || typeof category.name !== 'string') {
    return null;
  }

  return resolveTranslatedText(
    category.name,
    category.name_translations,
    languageCode
  );
}

export async function generateStaticParams() {
  // Unconfigured instance (pre-/setup): no DB to read product slugs from. Accept every
  // Supabase key alias the Vercel integration may inject (incl. the new publishable key).
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
  const { data: products } = await getProducts(supabase);
  const productRows = ((products || []) as any[]).filter(
    (product) => product.status === 'active'
  );
  if (productRows.length === 0) return [];
  return productRows.map((product: any) => ({
    slug: product.slug,
  }));
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = getSsgSupabaseClient();
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
      // ignore
    }
  }
  const { data: product } = await getProductBySlug(supabase, slug, preferredLocale);
  const productRecord = product as any;

  if (
    !productRecord ||
    !isPubliclyVisible({
      status: productRecord.status,
      publishedAt: productRecord.published_at,
      liveStatus: LIVE_STATUS.product,
    })
  ) {
    return { title: 'Product Not Found' };
  }
  
  // Resolve image URL for OG Image. Social crawlers do not decode AVIF, and the upload
  // pipeline makes the AVIF derivative the row's primary key, so the preview uses the
  // untouched upload when the row kept one. See lib/media/original-upload.ts. The
  // storefront gallery further down is unaffected and still renders the AVIF.
  let imageUrl = undefined;
  const mediaItem = productRecord.product_media?.[0]?.media;
  const socialKey: string | undefined =
    pickOriginalUploadObjectKey(mediaItem) ?? mediaItem?.file_path ?? undefined;
  if (socialKey) {
     if (socialKey.startsWith('http')) {
        imageUrl = socialKey;
     } else if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
        imageUrl = `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${socialKey}`;
     } else {
        imageUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${socialKey}`;
     }
  }

  const siteUrl = process.env.NEXT_PUBLIC_URL || "";
  const [languagesResult, productTranslationsResult] = await Promise.all([
    supabase.from('languages').select('id, code'),
    supabase
      .from('products')
      .select('language_id, slug')
      .eq('translation_group_id', productRecord.translation_group_id)
      .eq('status', 'active')
      // Never advertise a scheduled translation via hreflang.
      .or(buildPublishedAtOrFilter())
  ]);

  const { data: languages } = languagesResult;
  const { data: productTranslations } = productTranslationsResult;

  const alternates: { [key: string]: string } = {};
  if (languages && productTranslations) {
    productTranslations.forEach(pt => {
      const langInfo = languages.find(l => l.id === pt.language_id);
      if (langInfo) {
        alternates[langInfo.code] = `${siteUrl}/product/${pt.slug}`;
      }
    });
  }

  const title = resolveMetaTitle(productRecord.meta_title, productRecord.title);
  const description = resolveProductMetaDescription(
    productRecord.meta_description,
    productRecord.short_description
  );
  const { siteTitle, socialImage } = await getSiteSettings();
  // Self-referencing `<siteUrl>/product/<slug>` unless the product sets a manual custom_canonical override.
  const canonicalUrl = buildCanonicalUrl(productRecord.custom_canonical, siteUrl, `/product/${slug}`);

  return {
    title,
    description,
    ...buildSocialMetadata({
      title,
      description,
      url: canonicalUrl,
      siteTitle,
      imageUrl,
      fallbackImage: socialImage,
      type: 'website',
      locale: toOpenGraphLocale(productRecord.language_code),
    }),
    alternates: {
      canonical: canonicalUrl,
      languages: Object.keys(alternates).length > 0 ? alternates : undefined,
    },
  };
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const supabase = getSsgSupabaseClient();

  // 0. Verify License
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
      notFound();
  }

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
      // ignore
    }
  }

  // 1. Fetch Product Data
  const { data: product } = await getProductBySlug(supabase, slug, preferredLocale);
  let productRecord = product as any;

  const draft = await draftMode();

  // Draft mode is how the CMS previews a product before it is public, so it must
  // reach draft and scheduled rows — everyone else only sees active products whose
  // go-live moment has passed.
  if (
    !productRecord ||
    (!draft.isEnabled &&
      !isPubliclyVisible({
        status: productRecord.status,
        publishedAt: productRecord.published_at,
        liveStatus: LIVE_STATUS.product,
      }))
  ) {
    notFound();
  }

  const visualEditingEnabled =
    draft.isEnabled || process.env.NEXTBLOCK_VISUAL_EDITING_ENABLED === 'true';

  if (visualEditingEnabled) {
    const productDraft = await getProductDraft(productRecord.id);
    productRecord = applyProductDraftToProductRecord(productRecord, productDraft);
  }

  // 2. Fetch Template Page
  const templatePage = await getPageDataBySlug('product-template');

  // 3. Fallback or Use Template
  let blocks: BlockType[] = [];
  let languageId = 1; // Default to 1 if not found

  if (templatePage) {
    blocks = templatePage.blocks;
    languageId = templatePage.language_id;
  } else {
    // Fallback Layout if no template exists
    // We cast to any to avoid strict DB type matching for fallback mocks, specifically for UUID/Dates
    blocks = [
      {
        id: 'fallback-product-details',
        block_type: 'product_details',
        content: {},
        page_id: 'temp',
        order: 0,
        language_id: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
         id: 'fallback-product-grid',
         block_type: 'product_grid',
         content: { type: 'latest', limit: 4, title: "You might also like" },
         page_id: 'temp',
         order: 1,
         language_id: 1,
         created_at: new Date().toISOString(),
         updated_at: new Date().toISOString()
      }
    ] as any as BlockType[];
  }

  const requestOrigin = await getRequestOrigin();
  const productTemplateVisualEditing = templatePage
    ? {
        enabled: visualEditingEnabled,
        documentType: "page" as const,
        documentId: templatePage.id,
        slug: templatePage.slug,
        languageId: templatePage.language_id,
        draftId: templatePage.draft_id ?? null,
        pageOrigin: requestOrigin,
      }
    : undefined;

  // 4. Transform Product Data for Context
  // Value Mapping
  // Image URL resolution
  let imageUrl: string | undefined = undefined;
  const images: { url: string; alt?: string }[] = [];
  
  if (productRecord.product_media && productRecord.product_media.length > 0) {
      // Sort by sort_order
      const sortedMedia = [...productRecord.product_media].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      
      sortedMedia.forEach(pm => {
          if (pm.media?.file_path) {
              let url = '';
              if (pm.media.file_path.startsWith('http')) {
                  url = pm.media.file_path;
              } else if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
                  url = `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${pm.media.file_path}`;
              } else {
                  url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${pm.media.file_path}`;
              }
              
              images.push({ url, alt: productRecord.title });
              
              // Set primary image if it's the first one
              if (!imageUrl) imageUrl = url;
          }
      });
  }

  const languageCode = Array.isArray(productRecord.languages)
    ? productRecord.languages[0]?.code
    : productRecord.languages?.code;
  const { attributes, variants } = mapRawVariantRelations(
    productRecord.product_variants || [],
    languageCode
  );
  const variantPriceRange = getVariantEffectivePriceRange(variants);
  const productCategories = (productRecord.product_categories || [])
    .map((pc: any) => pc.category)
    .filter(Boolean);
  const productCategoryNames = productCategories
    .map((category: any) => resolveCategoryName(category, languageCode))
    .filter((name: string | null): name is string => Boolean(name));

  const contextProduct = {
    id: productRecord.id,
    title: productRecord.title,
    slug: productRecord.slug,
    sku: productRecord.sku,
    average_rating: productRecord.average_rating,
    total_reviews: productRecord.total_reviews,
    upc: productRecord.upc || undefined,
    price: productRecord.price,
    prices: normalizePriceMap(productRecord.prices),
    sale_price: productRecord.sale_price || null,
    sale_prices: normalizeSalePriceMap(productRecord.sale_prices),
    sale_start_at: productRecord.sale_start_at ?? null,
    sale_end_at: productRecord.sale_end_at ?? null,
    scheduled_price:
      typeof productRecord.scheduled_price === 'number' ? productRecord.scheduled_price : undefined,
    scheduled_prices: normalizePriceMap(productRecord.scheduled_prices),
    scheduled_price_at: productRecord.scheduled_price_at ?? null,
    is_taxable: productRecord.is_taxable ?? true,
    product_type: productRecord.product_type ?? undefined,
    payment_provider: productRecord.payment_provider ?? undefined,
    price_range_min: variantPriceRange?.min ?? null,
    price_range_max: variantPriceRange?.max ?? null,
    image_url: imageUrl,
    images: images,
    short_description: productRecord.short_description || undefined,
    description_json: productRecord.description_json,
    stock:
      productRecord.stock !== undefined && productRecord.stock !== null
        ? productRecord.stock
        : undefined,
    freemius_product_id: productRecord.freemius_product_id || undefined,
    freemius_plan_id: productRecord.freemius_plan_id || undefined,
    trial_period_days: productRecord.trial_period_days ?? 0,
    trial_requires_payment_method: productRecord.trial_requires_payment_method ?? false,
    freemius_plans: productRecord.freemius_plans,
    language_id: productRecord.language_id,
    translation_group_id: productRecord.translation_group_id || "",
    has_variants: variants.length > 0,
    attributes,
    variants,
    categories: productCategories,
    product_variants: (productRecord.product_variants || []).map((variant: any) => ({
      id: variant.id,
      price: variant.price,
      prices: normalizePriceMap(variant.prices),
      sale_price: variant.sale_price,
      sale_prices: normalizeSalePriceMap(variant.sale_prices),
      sale_start_at: variant.sale_start_at ?? null,
      sale_end_at: variant.sale_end_at ?? null,
      scheduled_price: variant.scheduled_price ?? null,
      scheduled_prices: normalizePriceMap(variant.scheduled_prices),
      scheduled_price_at: variant.scheduled_price_at ?? null,
    })),
  };
  const siteUrl = process.env.NEXT_PUBLIC_URL || "";

  // Whether checkout would actually accept this product, so the structured data
  // doesn't promise a purchase the store can't complete. Defaults to buyable on any
  // failure — a working shop must never lose its offer markup to an unrelated error.
  const canPurchase = await (async () => {
    const provider = productRecord.payment_provider;
    if (provider !== 'stripe' && provider !== 'freemius') return true;
    try {
      return (await getProviderReadiness(provider)).ready;
    } catch {
      return true;
    }
  })();

  const nonce = (await headers()).get('x-nonce') || undefined;
  const title = resolveMetaTitle(productRecord.meta_title, productRecord.title);
  const description = resolveProductMetaDescription(
    productRecord.meta_description,
    productRecord.short_description
  );
  const { data: defaultCurrency } = await supabase
    .from('currencies')
    .select('code')
    .eq('is_default', true)
    .maybeSingle();
  const price = formatMinorUnitAmount(productRecord.sale_price ?? productRecord.price);
  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    description,
    image: images.map((image) => image.url),
    category:
      productCategoryNames.length > 1
        ? productCategoryNames
        : productCategoryNames[0] ?? undefined,
    sku: productRecord.sku || undefined,
    gtin: productRecord.upc || undefined,
    url: `${siteUrl}/product/${productRecord.slug}`,
    offers: price
      ? {
          '@type': 'Offer',
          url: `${siteUrl}/product/${productRecord.slug}`,
          price,
          priceCurrency: defaultCurrency?.code || 'USD',
          availability: resolveOfferAvailability(productRecord, canPurchase),
          itemCondition: 'https://schema.org/NewCondition',
        }
      : undefined,
  };

  return (
    <div className="min-h-screen bg-background pb-12">
        <script
          type="application/ld+json"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: stringifyJsonLd(productJsonLd) }}
        />
        <ProductProvider product={contextProduct}>
            {/* 
              BlockRenderer expects languageId property. 
              If templatePage is null, we defaulted languageId to 1.
            */}
            <CurrentContentSetter
              id={productRecord.id}
              type="product"
              slug={productRecord.slug}
              translation_group_id={productRecord.translation_group_id}
            />
            <BlockRenderer 
              blocks={blocks} 
              languageId={languageId} 
              excludeProductId={productRecord.id}
              excludeTranslationGroupId={productRecord.translation_group_id}
              visualEditing={productTemplateVisualEditing}
              productVisualEditingEnabled={visualEditingEnabled}
            />
        </ProductProvider>
    </div>
  );
}
