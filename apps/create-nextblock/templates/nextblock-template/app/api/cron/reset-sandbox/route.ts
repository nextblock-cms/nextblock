import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import {
  syncFreemiusProductsToSupabase,
  syncSingleFreemiusProduct,
} from '@nextblock-cms/ecommerce/server';
import postgres from 'postgres';

import { CORTEX_AI_PACKAGE_ID } from '@nextblock-cms/cortex';
import { SANDBOX_RESET_SQL } from './sandboxResetSql';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type SqlClient = postgres.Sql<Record<string, unknown>>;
type LanguageId = number | string;
type SizeSlug = 'small' | 'medium' | 'large';

type SeedAsset = {
  source: string;
  dest: string;
  fileName: string;
  contentType: string;
  description?: string;
};

type UploadedSeedAsset = SeedAsset & {
  sizeBytes: number;
};

type MediaStorageRow = {
  id: string;
  object_key: string;
  file_path: string | null;
};

type DescriptionContent = {
  headline: string;
  lead: string;
  whyHeading: string;
  whyParagraph: string;
  bullets: string[];
};

type SeededLocale = {
  title: string;
  slug: string;
  shortDescription: string;
  description: DescriptionContent;
};

type ApparelAccentName = 'amber' | 'sky' | 'rose';

type ApparelProductSeed = {
  imageKey: string;
  baseSku: string;
  price: number;
  accent: ApparelAccentName;
  variantStocks: Record<SizeSlug, number>;
  en: SeededLocale;
  fr: SeededLocale;
};

const SANDBOX_COMMERCE_PRODUCT_ID = '24851';
const SANDBOX_CORTEX_AI_PRODUCT_ID = '28609';

const SEEDED_ASSETS: SeedAsset[] = [
  {
    source: 'images/nextblock-logo-small.webp',
    dest: 'images/nextblock-logo-small.webp',
    fileName: 'nextblock-logo-small.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ logo.',
  },
  {
    source: 'images/goals.webp',
    dest: 'images/goals.webp',
    fileName: 'goals.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: goals illustration.',
  },
  {
    source: 'images/NBcover.webp',
    dest: 'images/NBcover.webp',
    fileName: 'NBcover.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ architecture cover image.',
  },
  {
    source: 'images/extensibility.webp',
    dest: 'images/extensibility.webp',
    fileName: 'extensibility.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ extensibility editorial artwork.',
  },
  {
    source: 'images/included.webp',
    dest: 'images/included.webp',
    fileName: 'included.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ getting-started platform artwork.',
  },
  {
    source: 'images/programmer-upscaled.webp',
    dest: 'images/programmer-upscaled.webp',
    fileName: 'programmer-upscaled.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: programmer hero image.',
  },
  {
    source: 'images/commerce-plan.webp',
    dest: 'images/commerce-plan.webp',
    fileName: 'commerce-plan.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ commerce roadmap artwork.',
  },
  {
    source: 'images/commerce-square.webp',
    dest: 'images/commerce-square.webp',
    fileName: 'commerce-square.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: Commerce Pro cover image.',
  },
  {
    source: 'images/commerce-wide.webp',
    dest: 'images/commerce-wide.webp',
    fileName: 'commerce-wide.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ Commerce editorial feature image.',
  },
  {
    source: 'images/cortex-ai.webp',
    dest: 'images/cortex-ai.webp',
    fileName: 'cortex-ai.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock Cortex AI editorial feature image.',
  },
  {
    source: 'images/t-shirt.webp',
    dest: 'images/t-shirt.webp',
    fileName: 't-shirt.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ Studio Tee.',
  },
  {
    source: 'images/cap.webp',
    dest: 'images/cap.webp',
    fileName: 'cap.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ Signal Cap.',
  },
  {
    source: 'images/pants.webp',
    dest: 'images/pants.webp',
    fileName: 'pants.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: NextBlock™ Utility Pants.',
  },
  {
    source: 'images/cortex-ai-square.webp',
    dest: 'images/cortex-ai-square.webp',
    fileName: 'cortex-ai-square.webp',
    contentType: 'image/webp',
    description: 'Sandbox seed asset: Cortex AI cover image.',
  },
];

const SIZE_TERM_DEFINITIONS: Array<{
  slug: SizeSlug;
  value: string;
  sortOrder: number;
  frValue: string;
}> = [
  { slug: 'small', value: 'Small', sortOrder: 0, frValue: 'Petit' },
  { slug: 'medium', value: 'Medium', sortOrder: 1, frValue: 'Moyen' },
  { slug: 'large', value: 'Large', sortOrder: 2, frValue: 'Grand' },
];

const CORE_MEDIA_RECORDS: Array<{
  assetKey: string;
  description?: string | null;
}> = [
  {
    assetKey: 'images/nextblock-logo-small.webp',
    description: 'NextBlock™ Site Logo',
  },
  {
    assetKey: 'images/NBcover.webp',
    description: 'NextBlock™ architecture overview cover image',
  },
  {
    assetKey: 'images/extensibility.webp',
    description: 'NextBlock™ extensibility editorial artwork',
  },
  {
    assetKey: 'images/included.webp',
    description: 'NextBlock™ getting-started platform artwork',
  },
  {
    assetKey: 'images/programmer-upscaled.webp',
    description: undefined,
  },
  {
    assetKey: 'images/commerce-plan.webp',
    description: 'NextBlock™ commerce roadmap artwork',
  },
  {
    assetKey: 'images/commerce-wide.webp',
    description: 'NextBlock™ Commerce editorial feature image',
  },
  {
    assetKey: 'images/cortex-ai.webp',
    description: 'NextBlock Cortex AI editorial feature image',
  },
  {
    assetKey: 'images/cortex-ai-square.webp',
    description: 'NextBlock™ Cortex AI cover image',
  },
];

function getFolderFromObjectKey(objectKey: string) {
  return objectKey.includes('/') ? objectKey.slice(0, objectKey.lastIndexOf('/')) : null;
}



type ApparelAccentStyles = {
  heroStops: Array<{ color: string; position: number }>;
  ctaStops: Array<{ color: string; position: number }>;
  eyebrow: string;
  checkBadge: string;
  cardHoverBorder: string;
  ctaSubtext: string;
};

// Per-product accent palettes. The gradient `stops` are inline hex values so they
// always render; the class strings are written here as literals so Tailwind's
// content scanner (which includes this file) compiles them into the bundle.
const APPAREL_ACCENTS: Record<ApparelAccentName, ApparelAccentStyles> = {
  amber: {
    heroStops: [
      { color: '#451a03', position: 0 },
      { color: '#78350f', position: 45 },
      { color: '#0f172a', position: 100 },
    ],
    ctaStops: [
      { color: '#78350f', position: 0 },
      { color: '#451a03', position: 100 },
    ],
    eyebrow: 'text-amber-400',
    checkBadge: 'bg-amber-950 text-amber-300',
    cardHoverBorder: 'hover:border-amber-300 dark:hover:border-amber-500',
    ctaSubtext: 'text-amber-100',
  },
  sky: {
    heroStops: [
      { color: '#082f49', position: 0 },
      { color: '#0c4a6e', position: 40 },
      { color: '#0f172a', position: 100 },
    ],
    ctaStops: [
      { color: '#0c4a6e', position: 0 },
      { color: '#082f49', position: 100 },
    ],
    eyebrow: 'text-sky-400',
    checkBadge: 'bg-sky-950 text-sky-300',
    cardHoverBorder: 'hover:border-sky-300 dark:hover:border-sky-500',
    ctaSubtext: 'text-sky-100',
  },
  rose: {
    heroStops: [
      { color: '#4c0519', position: 0 },
      { color: '#881337', position: 40 },
      { color: '#0f172a', position: 100 },
    ],
    ctaStops: [
      { color: '#881337', position: 0 },
      { color: '#4c0519', position: 100 },
    ],
    eyebrow: 'text-rose-400',
    checkBadge: 'bg-rose-950 text-rose-300',
    cardHoverBorder: 'hover:border-rose-300 dark:hover:border-rose-500',
    ctaSubtext: 'text-rose-100',
  },
};

const APPAREL_COPY: Record<
  'en' | 'fr',
  { eyebrow: string; ctaHeadline: string; ctaLead: string; ctaButton: string; ctaUrl: string }
> = {
  en: {
    eyebrow: 'NextBlock™ Apparel',
    ctaHeadline: 'Part of the NextBlock™ demo store',
    ctaLead:
      'This is a mock product that showcases the commerce engine — multi-currency pricing, size variants, and fully block-based product pages.',
    ctaButton: 'Browse the store',
    ctaUrl: '/shop',
  },
  fr: {
    eyebrow: 'Vêtements NextBlock™',
    ctaHeadline: 'Au cœur de la boutique démo NextBlock™',
    ctaLead:
      "Un article fictif qui illustre le moteur e-commerce — prix multi-devises, variantes de taille et fiches produits entièrement en blocs.",
    ctaButton: 'Voir la boutique',
    ctaUrl: '/boutique',
  },
};

// Build a rich, block-editor-native description (hero + feature cards + CTA) from the
// structured locale copy, mirroring the digital products so physical seeds are both
// editable in the block editor and visually on par with the rest of the catalog.
function buildApparelDescriptionSections(
  content: DescriptionContent,
  accentName: ApparelAccentName,
  localeCode: 'en' | 'fr'
) {
  const accent = APPAREL_ACCENTS[accentName];
  const copy = APPAREL_COPY[localeCode];

  // ── Section 0: Hero (gradient, two columns) ──
  const hero = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: { type: 'linear', direction: '135deg', stops: accent.heroStops },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 2 },
    column_gap: 'xl',
    vertical_alignment: 'center',
    padding: { top: 'xl', bottom: 'xl' },
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] ${accent.eyebrow} font-semibold mb-4">${copy.eyebrow}</p>
<h2 class="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5">${content.headline}</h2>
<p class="text-base md:text-lg text-slate-200 leading-relaxed">${content.lead}</p>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="rounded-2xl border border-slate-700 bg-slate-950 p-6 shadow-xl sm:p-8">
<h3 class="text-lg font-bold text-white mb-3">${content.whyHeading}</h3>
<p class="text-sm leading-relaxed text-slate-300">${content.whyParagraph}</p>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 1: Feature cards (one per bullet) ──
  const featureCard = (bullet: string) => ({
    block_type: 'text',
    content: {
      html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors ${accent.cardHoverBorder} hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 sm:p-7">
<div class="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-full ${accent.checkBadge} text-sm font-bold">✓</div>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">${bullet}</p>
</div>`,
    },
  });

  const features = {
    container_type: 'container',
    background: { type: 'none' },
    responsive_columns: { mobile: 1, tablet: 2, desktop: 3 },
    column_gap: 'lg',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'stretch',
    column_blocks: content.bullets.map((bullet) => [featureCard(bullet)]),
  };

  // ── Section 2: CTA (accent gradient) ──
  const cta = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: { type: 'linear', direction: '135deg', stops: accent.ctaStops },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
    column_gap: 'none',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'center',
    column_blocks: [
      [
        {
          block_type: 'heading',
          content: {
            level: 2,
            text_content: copy.ctaHeadline,
            textAlign: 'center',
            textColor: 'background',
          },
        },
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-center ${accent.ctaSubtext} max-w-xl mx-auto mt-2 mb-6">${copy.ctaLead}</p>`,
          },
        },
        {
          block_type: 'button',
          content: {
            text: copy.ctaButton,
            url: copy.ctaUrl,
            variant: 'secondary',
            size: 'lg',
            position: 'center',
          },
        },
      ],
    ],
  };

  return [hero, features, cta];
}


const APPAREL_PRODUCT_SEEDS: ApparelProductSeed[] = [
  {
    imageKey: 'images/t-shirt.webp',
    baseSku: 'NB-STUDIO-TEE',
    price: 3200,
    accent: 'amber',
    variantStocks: { small: 8, medium: 12, large: 6 },
    en: {
      title: 'NextBlock™ Studio Tee (Mock Item)',
      slug: 'nextblock-studio-tee',
      shortDescription:
        'A heavyweight studio tee built for long build sessions, late launches, and every quiet hour between.',
      description: {
        headline: 'Studio uniform for shipping days',
        lead:
          'The NextBlock™ Studio Tee is cut from premium heavyweight cotton with a clean silhouette that feels equally at home in a workshop, a coworking space, or a midnight deployment window.',
        whyHeading: 'Why it works',
        whyParagraph:
          'Soft structure, durable fabric, and a relaxed drape make it the kind of shirt you reach for when the work matters and comfort has to keep up.',
        bullets: [
          'Heavyweight cotton feel with an easy everyday fit.',
          'Clean visual profile that pairs well with any setup.',
          'Built to stay comfortable through long build-and-debug sessions.',
        ],
      },
    },
    fr: {
      title: 'T-shirt Studio NextBlock™ (Article fictif)',
      slug: 'nextblock-studio-tee-fr',
      shortDescription:
        'Un t-shirt lourd et confortable pense pour les longues sessions de build, les lancements tardifs et les jours ou il faut rester dans le flow.',
      description: {
        headline: 'L uniforme du studio pour les jours de livraison',
        lead:
          'Le T-shirt Studio NextBlock™ mise sur un coton epais, une ligne propre et une allure simple qui fonctionne autant au bureau qu en session de production tardive.',
        whyHeading: 'Pourquoi ca marche',
        whyParagraph:
          'Sa matiere robuste et sa coupe detendue offrent un bon equilibre entre maintien, confort et style discret pour les longues journees de travail.',
        bullets: [
          'Toucher coton epais avec une coupe facile a porter.',
          'Silhouette nette qui reste propre dans tous les contextes.',
          'Concu pour garder le confort pendant les longues sessions de build.',
        ],
      },
    },
  },
  {
    imageKey: 'images/cap.webp',
    baseSku: 'NB-SIGNAL-CAP',
    price: 2600,
    accent: 'sky',
    variantStocks: { small: 6, medium: 10, large: 6 },
    en: {
      title: 'NextBlock™ Signal Cap (Mock Item)',
      slug: 'nextblock-signal-cap',
      shortDescription:
        'A clean everyday cap with subtle techwear energy and just enough structure to finish a sharp off-duty kit.',
      description: {
        headline: 'Low-key signal, strong presence',
        lead:
          'The NextBlock™ Signal Cap brings a crisp shape and understated studio aesthetic to the kind of everyday accessory that quietly pulls an outfit together.',
        whyHeading: 'Why it works',
        whyParagraph:
          'It keeps the look restrained, modern, and wearable while still feeling intentional enough to stand out in the details.',
        bullets: [
          'Structured profile with an easy all-day feel.',
          'Minimal visual language inspired by modern dev studios.',
          'Simple finishing piece for travel, work, or weekend runs.',
        ],
      },
    },
    fr: {
      title: 'Casquette Signal NextBlock™ (Article fictif)',
      slug: 'nextblock-signal-cap-fr',
      shortDescription:
        'Une casquette nette et facile a porter, avec une presence sobre et un esprit techwear leger pour tous les jours.',
      description: {
        headline: 'Un signal discret, une vraie allure',
        lead:
          'La Casquette Signal NextBlock™ apporte une forme propre et une estetique studio minimaliste a un accessoire du quotidien qui complete la tenue sans effort.',
        whyHeading: 'Pourquoi ca marche',
        whyParagraph:
          'Elle garde un style moderne, simple et portable tout en donnant assez de caractere pour finir une tenue avec intention.',
        bullets: [
          'Profil structure avec un confort facile toute la journee.',
          'Langage visuel minimal inspire des studios de dev modernes.',
          'Piece simple pour le travail, les deplacements ou le week-end.',
        ],
      },
    },
  },
  {
    imageKey: 'images/pants.webp',
    baseSku: 'NB-UTILITY-PANTS',
    price: 6800,
    accent: 'rose',
    variantStocks: { small: 5, medium: 8, large: 5 },
    en: {
      title: 'NextBlock™ Utility Pants (Mock Item)',
      slug: 'nextblock-utility-pants',
      shortDescription:
        'Tapered utility pants designed for commute-to-keyboard days, with an easy fit that still feels sharp.',
      description: {
        headline: 'Utility comfort with a refined line',
        lead:
          'The NextBlock™ Utility Pants balance movement, structure, and a clean tapered cut so you can move from city errands to keyboard time without changing the tone.',
        whyHeading: 'Why it works',
        whyParagraph:
          'They are practical enough for all-day wear but polished enough to feel intentional, making them an easy anchor piece for a modern work uniform.',
        bullets: [
          'Tapered silhouette that stays neat without feeling tight.',
          'Comfort-first construction for long seated sessions.',
          'Versatile styling that fits both commute and studio rhythms.',
        ],
      },
    },
    fr: {
      title: 'Pantalon utilitaire NextBlock™ (Article fictif)',
      slug: 'nextblock-utility-pants-fr',
      shortDescription:
        'Un pantalon utilitaire a la coupe fuselee pense pour les trajets, les longues heures au clavier et les journees ou il faut rester mobile.',
      description: {
        headline: 'Le confort utilitaire avec une ligne soignee',
        lead:
          'Le Pantalon utilitaire NextBlock™ equilibre mobilite, maintien et coupe fuselee pour suivre le rythme entre les deplacements, le studio et les longues sessions de travail.',
        whyHeading: 'Pourquoi ca marche',
        whyParagraph:
          'Il reste assez pratique pour etre porte toute la journee tout en gardant une allure propre, ce qui en fait une base facile pour une garde-robe de travail moderne.',
        bullets: [
          'Silhouette fuselee nette sans sensation trop serree.',
          'Construction orientee confort pour les longues sessions assises.',
          'Style polyvalent pour le trajet, le studio et le quotidien.',
        ],
      },
    },
  },
];

async function uploadSeedAssets(params: {
  s3: S3Client;
  bucketName: string;
  siteUrl: string;
}) {
  const uploadedAssets = new Map<string, UploadedSeedAsset>();

  for (const asset of SEEDED_ASSETS) {
    let buffer: Buffer | undefined;
    const fetchUrl = `${params.siteUrl}/${asset.source}`;

    // Optimization: If fetching from localhost, try to read from disk first to avoid ECONNRESET
    if (fetchUrl.includes('localhost') || fetchUrl.includes('127.0.0.1')) {
      try {
        const localPath = path.join(process.cwd(), 'apps/nextblock/public', asset.source);
        if (fs.existsSync(localPath)) {
          console.log(`[Sandbox Reset] Loading local asset: ${localPath}`);
          buffer = fs.readFileSync(localPath);
        }
      } catch (err) {
        console.warn(`[Sandbox Reset] Failed to read local asset: ${asset.source}`, err);
      }
    }

    if (!buffer) {
      console.log(`[Sandbox Reset] Fetching ${fetchUrl}...`);
      
      let lastErr: any;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(fetchUrl);
          if (!res.ok) {
            throw new Error(`Failed to fetch asset: ${fetchUrl} (${res.status})`);
          }
          buffer = Buffer.from(await res.arrayBuffer());
          break;
        } catch (err) {
          lastErr = err;
          if (attempt === 3) break;
          console.warn(`[Sandbox Reset] Fetch failed (attempt ${attempt}): ${fetchUrl}. Retrying in 1s...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      
      if (!buffer) {
        throw new Error(`Failed to fetch asset after 3 attempts: ${fetchUrl}. Last error: ${lastErr?.message}`);
      }
    }

    await params.s3.send(
      new PutObjectCommand({
        Bucket: params.bucketName,
        Key: asset.dest,
        Body: buffer,
        ContentType: asset.contentType,
      })
    );

    uploadedAssets.set(asset.dest, {
      ...asset,
      sizeBytes: buffer.byteLength,
    });

    console.log(`[Sandbox Reset] Uploaded ${asset.dest}`);
  }

  return uploadedAssets;
}

async function upsertMediaRecord(
  sql: SqlClient,
  asset: UploadedSeedAsset,
  description?: string | null
) {
  const folder = getFolderFromObjectKey(asset.dest);
  const recordDescription = description === undefined ? asset.description ?? null : description;
  const [mediaRecord] = await sql`
    INSERT INTO public.media (
      file_name,
      object_key,
      file_path,
      file_type,
      size_bytes,
      folder,
      description
    )
    VALUES (
      ${asset.fileName},
      ${asset.dest},
      ${asset.dest},
      ${asset.contentType},
      ${asset.sizeBytes},
      ${folder},
      ${recordDescription}
    )
    ON CONFLICT (object_key) DO UPDATE
    SET
      file_name = EXCLUDED.file_name,
      file_path = EXCLUDED.file_path,
      file_type = EXCLUDED.file_type,
      size_bytes = EXCLUDED.size_bytes,
      folder = EXCLUDED.folder,
      description = EXCLUDED.description,
      updated_at = now()
    RETURNING id
  `;

  if (!mediaRecord?.id) {
    throw new Error(`Failed to upsert media record for ${asset.dest}`);
  }

  return mediaRecord.id as string;
}

async function normalizeMediaStorageKeys(sql: SqlClient) {
  const rows = (await sql`
    SELECT id, object_key, file_path
    FROM public.media
    WHERE object_key LIKE '/%' OR file_path LIKE '/%'
  `) as MediaStorageRow[];

  for (const row of rows) {
    const normalizedObjectKey = row.object_key.replace(/^\/+/, '');
    const normalizedFilePath = (row.file_path || row.object_key).replace(/^\/+/, '');
    const folder = getFolderFromObjectKey(normalizedFilePath);

    await sql`
      UPDATE public.media
      SET
        object_key = ${normalizedObjectKey},
        file_path = ${normalizedFilePath},
        folder = ${folder},
        updated_at = now()
      WHERE id = ${row.id}
    `;
  }

  return rows.length;
}

async function ensureCoreMediaRecords(params: {
  sql: SqlClient;
  uploadedAssets: Map<string, UploadedSeedAsset>;
}) {
  for (const record of CORE_MEDIA_RECORDS) {
    const asset = params.uploadedAssets.get(record.assetKey);
    if (!asset) {
      throw new Error(`Missing uploaded asset for ${record.assetKey}.`);
    }

    await upsertMediaRecord(params.sql, asset, record.description);
  }
}

async function attachProductMedia(sql: SqlClient, productId: string, mediaId: string) {
  await sql`DELETE FROM public.product_media WHERE product_id = ${productId}`;
  await sql`
    INSERT INTO public.product_media (product_id, media_id, sort_order)
    VALUES (${productId}, ${mediaId}, 0)
  `;
}

async function upsertInventoryItems(
  sql: SqlClient,
  inventoryRows: Array<{ sku: string; quantity: number }>
) {
  for (const row of inventoryRows) {
    await sql`
      INSERT INTO public.inventory_items (sku, quantity)
      VALUES (${row.sku}, ${row.quantity})
      ON CONFLICT (sku) DO UPDATE
      SET
        quantity = EXCLUDED.quantity,
        updated_at = now()
    `;
  }
}

async function getLanguageIds(sql: SqlClient) {
  const [enLangRaw] = await sql`SELECT id FROM public.languages WHERE code = 'en' LIMIT 1`;
  const [frLangRaw] = await sql`SELECT id FROM public.languages WHERE code = 'fr' LIMIT 1`;

  if (!enLangRaw?.id || !frLangRaw?.id) {
    throw new Error('Required languages (en, fr) not found during sandbox enrichment.');
  }

  return {
    enLangId: enLangRaw.id as LanguageId,
    frLangId: frLangRaw.id as LanguageId,
  };
}

async function ensureSizeAttribute(sql: SqlClient) {
  const [attribute] = await sql`
    INSERT INTO public.product_attributes (name, slug, name_translations)
    VALUES ('Size', 'size', ${sql.json({ fr: 'Taille' })})
    ON CONFLICT (slug) DO UPDATE
    SET
      name = EXCLUDED.name,
      name_translations = EXCLUDED.name_translations,
      updated_at = now()
    RETURNING id
  `;

  if (!attribute?.id) {
    throw new Error('Failed to seed the Size product attribute.');
  }

  const termIds = {} as Record<SizeSlug, string>;

  for (const termDefinition of SIZE_TERM_DEFINITIONS) {
    const [term] = await sql`
      INSERT INTO public.product_attribute_terms (
        attribute_id,
        value,
        slug,
        sort_order,
        value_translations
      )
      VALUES (
        ${attribute.id},
        ${termDefinition.value},
        ${termDefinition.slug},
        ${termDefinition.sortOrder},
        ${sql.json({ fr: termDefinition.frValue })}
      )
      ON CONFLICT ON CONSTRAINT product_attribute_terms_attribute_id_slug_key DO UPDATE
      SET
        value = EXCLUDED.value,
        sort_order = EXCLUDED.sort_order,
        value_translations = EXCLUDED.value_translations,
        updated_at = now()
      RETURNING id
    `;

    if (!term?.id) {
      throw new Error(`Failed to seed the ${termDefinition.slug} product attribute term.`);
    }

    termIds[termDefinition.slug] = term.id as string;
  }

  return termIds;
}

async function enrichCommerceProducts(params: {
  sql: SqlClient;
  commerceAsset: UploadedSeedAsset;
  enLangId: LanguageId;
  frLangId: LanguageId;
}) {
  console.log('[Sandbox Reset] Enriching NextBlock™ Commerce Pro...');

  const commerceMediaId = await upsertMediaRecord(
    params.sql,
    params.commerceAsset,
    'Sandbox seed asset: NextBlock™ Commerce Pro.'
  );

  const [product] = await params.sql`
    SELECT *
    FROM public.products
    WHERE freemius_product_id = ${SANDBOX_COMMERCE_PRODUCT_ID} AND language_id = ${params.enLangId}
    LIMIT 1
  `;

  if (!product) {
    throw new Error(
      `Commerce Pro product ${SANDBOX_COMMERCE_PRODUCT_ID} was not found after Freemius sync.`
    );
  }

  const shortDescEn =
    'NextBlock™ Commerce Pro is the ultimate AI-native, block-based headless e-commerce engine for Next.js. Deploy fast global storefronts with native multi-currency pricing, Stripe/Freemius checkouts, automatic tax calculations, and flexible shipping zones.';

  // ── Section 0: Hero Gradient ──
  const commerceS0En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '135deg',
        stops: [
          { color: '#022c22', position: 0 },
          { color: '#064e3b', position: 40 },
          { color: '#0f172a', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 2 },
    column_gap: 'xl',
    vertical_alignment: 'center',
    padding: { top: 'xl', bottom: 'xl' },
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4">Enterprise E-Commerce Engine</p>
<h2 class="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5">Turn Next.js Into a<br/>Global Storefront.</h2>
<p class="text-base md:text-lg text-slate-200 leading-relaxed mb-6">Commerce Pro is a composable, developer-first engine that powers physical product catalogs, digital licensing, and subscription commerce — all from your existing Next.js stack.</p>`,
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Get Commerce Pro →',
            url: 'https://nextblock.dev/product/nextblock-commerce-pro-commerce-license',
            variant: 'default',
            size: 'lg',
            position: 'left',
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="rounded-2xl border border-emerald-700 bg-slate-950 p-6 shadow-xl sm:p-8">
<h3 class="text-lg font-bold text-white mb-5">Why Teams Choose Commerce Pro</h3>
<ul class="space-y-4 text-sm leading-relaxed text-slate-300">
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Multi-Currency Pricing</strong> — real-time exchange rates, charm pricing rules, and automatic locale detection.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Tax Automation</strong> — built-in Stripe Tax integration calculates, collects, and reports in 40+ countries.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Resilient Stock Tracking</strong> — inventory locks at checkout to prevent over-selling, with per-variant control.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Flexible Shipping Zones</strong> — rate tables, free-shipping thresholds, and per-country rules out of the box.</span>
  </li>
</ul>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 1: Social-proof metrics bar ──
  const commerceS1En = {
    container_type: 'container',
    background: { type: 'theme', theme: 'muted' },
    responsive_columns: { mobile: 1, tablet: 2, desktop: 4 },
    column_gap: 'lg',
    padding: { top: 'lg', bottom: 'lg' },
    vertical_alignment: 'center',
    column_blocks: [
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">40+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Tax Jurisdictions</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">135+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Currencies Supported</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">&lt; 50ms</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Cart API Response</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">100 %</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Lighthouse Score</span></p>' } }],
    ],
  };

  // ── Section 2: Three-column feature cards ──
  const commerceS2En = {
    container_type: 'container',
    background: { type: 'none' },
    responsive_columns: { mobile: 1, tablet: 2, desktop: 3 },
    column_gap: 'lg',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'stretch',
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18M7 15h3"></path></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Headless Stripe Checkout</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Integrated checkout session creation for single or multiple items. Auto-fulfillment fires via webhook events, with built-in idempotency guards.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7a4 4 0 1 1-2.83 6.83L7 19H4v-3h3l2.17-2.17A4 4 0 0 1 15 7Z"></path><path d="M17.5 8.5h.01"></path></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Freemius Digital Licensing</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Distribute software downloads, validate license keys, and manage SaaS trial periods natively — no third-party integration layer required.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="m4 15 4-4 4 4 3-3 5 5"></path><circle cx="15" cy="9" r="1"></circle></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Visual Merchandising</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Content creators can add product details pages, highlight promotions, and build full landing pages — all inside the block editor, no code needed.</p>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 3: Deep-dive 2-col ──
  const commerceS3En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '180deg',
        stops: [
          { color: '#020617', position: 0 },
          { color: '#0f172a', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 2 },
    column_gap: 'xl',
    vertical_alignment: 'center',
    padding: { top: 'xl', bottom: 'xl' },
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4">Under The Hood</p>
<h3 class="text-2xl md:text-3xl font-extrabold text-white mb-4">Built for Production Scale</h3>
<p class="text-slate-300 leading-relaxed mb-5">Commerce Pro was designed from day one for high-traffic stores. Every API path is edge-cached, every database query is indexed, and every webhook handler is idempotent.</p>
<ul class="space-y-3 text-sm text-slate-400">
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Variant-level inventory with optimistic locking</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Automatic shipping zone calculation and rate tables</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Real-time order status with Stripe webhook sync</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Product attributes and filterable facets system</span>
  </li>
</ul>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="space-y-4">
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Order Management</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Full order lifecycle from cart to fulfillment. Automatic status transitions, email notifications, and refund handling baked in.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Product Categories</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Hierarchical taxonomy with slugs, media attachments, and full i18n support. Categories are managed directly in the CMS dashboard.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Multi-Language Storefronts</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Products, categories, and checkout flows are fully translatable. Each language variant shares inventory and pricing while maintaining its own SEO metadata.</p>
</div>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 4: CTA ──
  const commerceS4En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '135deg',
        stops: [
          { color: '#064e3b', position: 0 },
          { color: '#022c22', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
    column_gap: 'none',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'center',
    column_blocks: [
      [
        {
          block_type: 'heading',
          content: { level: 2, text_content: 'Ready to launch your storefront?', textAlign: 'center', textColor: 'background' },
        },
        {
          block_type: 'text',
          content: {
            html_content: '<p class="text-center text-emerald-100 max-w-xl mx-auto mt-2 mb-6">Start selling today with Commerce Pro. Multi-currency, tax-compliant, and lightning-fast out of the box.</p>',
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Purchase Commerce Pro',
            url: 'https://nextblock.dev/product/nextblock-commerce-pro-commerce-license',
            variant: 'secondary',
            size: 'lg',
            position: 'center',
          },
        },
      ],
    ],
  };

  const commerceSectionsEn = [commerceS0En, commerceS1En, commerceS2En, commerceS3En, commerceS4En];

  await params.sql`
    UPDATE public.products
    SET
      title = 'NextBlock™ Commerce Pro - Commerce License',
      short_description = ${shortDescEn},
      description_json = NULL,
      product_type = 'digital',
      payment_provider = 'freemius'
    WHERE id = ${product.id}
  `;

  await attachProductMedia(params.sql, product.id as string, commerceMediaId);

  // Set description blocks for English product
  await params.sql`DELETE FROM public.blocks WHERE product_id = ${product.id}`;
  for (let i = 0; i < commerceSectionsEn.length; i++) {
    await params.sql`
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order")
      VALUES (${product.id}, ${params.enLangId}, 'section', ${params.sql.json(commerceSectionsEn[i] as any)}, ${i})
    `;
  }

  // ── French Sections ──
  const shortDescFr =
    "NextBlock™ Commerce Pro est le moteur e-commerce headless et orienté IA ultime pour Next.js. Déployez des boutiques mondiales ultra-rapides avec support multi-devises, Stripe/Freemius, taxes automatisées et zones d'expédition.";

  const commerceS0Fr = {
    ...commerceS0En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4">Moteur E-Commerce d'Entreprise</p>
<h2 class="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5">Faites de Next.js une<br/>Boutique Mondiale.</h2>
<p class="text-base md:text-lg text-slate-200 leading-relaxed mb-6">Commerce Pro est un moteur composable pensé pour les développeurs : catalogues physiques, licences numériques et abonnements — le tout depuis votre stack Next.js existant.</p>`,
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Obtenir Commerce Pro →',
            url: 'https://nextblock.dev/product/nextblock-commerce-pro-commerce-license',
            variant: 'default',
            size: 'lg',
            position: 'left',
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="rounded-2xl border border-emerald-700 bg-slate-950 p-6 shadow-xl sm:p-8">
<h3 class="text-lg font-bold text-white mb-5">Pourquoi choisir Commerce Pro</h3>
<ul class="space-y-4 text-sm leading-relaxed text-slate-300">
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Multi-Devises</strong> — taux de change en temps réel, arrondis personnalisés et détection automatique de la localisation.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Taxes automatisées</strong> — intégration Stripe Tax pour le calcul, la collecte et le reporting dans plus de 40 pays.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Gestion des Stocks</strong> — verrouillage de l'inventaire au checkout pour éviter les surventes, avec contrôle par variante.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-950 flex items-center justify-center text-emerald-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Zones d'expédition flexibles</strong> — tables de tarifs, seuils de livraison gratuite et règles par pays inclus.</span>
  </li>
</ul>
</div>`,
          },
        },
      ],
    ],
  };

  const commerceS1Fr = {
    ...commerceS1En,
    column_blocks: [
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">40+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Juridictions fiscales</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">135+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Devises supportées</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">&lt; 50ms</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Réponse API panier</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">100 %</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Score Lighthouse</span></p>' } }],
    ],
  };

  const commerceS2Fr = {
    ...commerceS2En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18M7 15h3"></path></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Checkout Stripe Headless</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Création de sessions Stripe Checkout pour un ou plusieurs articles. Traitement automatique des commandes par webhooks avec protection d'idempotence.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7a4 4 0 1 1-2.83 6.83L7 19H4v-3h3l2.17-2.17A4 4 0 0 1 15 7Z"></path><path d="M17.5 8.5h.01"></path></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Licences Numériques Freemius</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Distribuez vos logiciels, validez les clés de licence et gérez les périodes d'essai SaaS — aucune intégration tierce requise.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-emerald-500 sm:p-7">
<div class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="m4 15 4-4 4 4 3-3 5 5"></path><circle cx="15" cy="9" r="1"></circle></svg></div>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Merchandising Visuel</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Vos équipes éditoriales enrichissent les fiches produits de landing pages, promotions et galeries — directement dans l'éditeur de blocs.</p>
</div>`,
          },
        },
      ],
    ],
  };

  const commerceS3Fr = {
    ...commerceS3En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4">Sous le capot</p>
<h3 class="text-2xl md:text-3xl font-extrabold text-white mb-4">Conçu pour la production à grande échelle</h3>
<p class="text-slate-300 leading-relaxed mb-5">Commerce Pro a été conçu dès le départ pour les boutiques à fort trafic. Chaque API est mise en cache à la périphérie, chaque requête est indexée, et chaque gestionnaire de webhook est idempotent.</p>
<ul class="space-y-3 text-sm text-slate-400">
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Inventaire par variante avec verrouillage optimiste</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Calcul automatique des zones d'expédition et tables de tarifs</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Statut des commandes en temps réel via synchronisation Stripe webhook</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-emerald-400">→</span>
    <span>Système d'attributs produits et de facettes filtrables</span>
  </li>
</ul>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="space-y-4">
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Gestion des commandes</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Cycle de vie complet : du panier à la livraison. Transitions automatiques, notifications par courriel et gestion des remboursements intégrées.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Catégories de produits</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Taxonomie hiérarchique avec slugs, médias associés et support i18n complet. Les catégories sont gérées directement dans le tableau de bord du CMS.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Boutiques multilingues</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Produits, catégories et flux de paiement entièrement traduisibles. Chaque variante linguistique partage l'inventaire et les prix tout en conservant ses propres métadonnées SEO.</p>
</div>
</div>`,
          },
        },
      ],
    ],
  };

  const commerceS4Fr = {
    ...commerceS4En,
    column_blocks: [
      [
        {
          block_type: 'heading',
          content: { level: 2, text_content: 'Prêt à lancer votre boutique ?', textAlign: 'center', textColor: 'background' },
        },
        {
          block_type: 'text',
          content: {
            html_content: '<p class="text-center text-emerald-100 max-w-xl mx-auto mt-2 mb-6">Commencez à vendre dès aujourd\'hui avec Commerce Pro. Multi-devises, conforme aux taxes, ultra-rapide dès l\'installation.</p>',
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Acheter Commerce Pro',
            url: 'https://nextblock.dev/product/nextblock-commerce-pro-commerce-license',
            variant: 'secondary',
            size: 'lg',
            position: 'center',
          },
        },
      ],
    ],
  };

  const commerceSectionsFr = [commerceS0Fr, commerceS1Fr, commerceS2Fr, commerceS3Fr, commerceS4Fr];

  const [frProduct] = await params.sql`
    INSERT INTO public.products (
      sku,
      title,
      slug,
      price,
      sale_price,
      stock,
      status,
      short_description,
      description_json,
      product_type,
      payment_provider,
      language_id,
      translation_group_id,
      freemius_product_id,
      freemius_plan_id,
      trial_period_days,
      trial_requires_payment_method
    )
    VALUES (
      ${product.sku},
      'Licence NextBlock™ Commerce Pro',
      ${String(product.slug) + '-fr'},
      ${product.price},
      ${product.sale_price},
      ${product.stock || 99},
      ${product.status},
      ${shortDescFr},
      NULL,
      'digital',
      'freemius',
      ${params.frLangId},
      ${product.translation_group_id},
      ${product.freemius_product_id},
      ${product.freemius_plan_id},
      ${product.trial_period_days ?? 0},
      ${product.trial_requires_payment_method ?? false}
    )
    ON CONFLICT ON CONSTRAINT products_language_id_slug_key DO UPDATE
    SET
      title = EXCLUDED.title,
      short_description = EXCLUDED.short_description,
      description_json = NULL,
      price = EXCLUDED.price,
      sale_price = EXCLUDED.sale_price,
      stock = EXCLUDED.stock,
      status = EXCLUDED.status,
      product_type = EXCLUDED.product_type,
      payment_provider = EXCLUDED.payment_provider,
      trial_period_days = EXCLUDED.trial_period_days,
      trial_requires_payment_method = EXCLUDED.trial_requires_payment_method
    RETURNING id
  `;

  if (frProduct?.id) {
    await attachProductMedia(params.sql, frProduct.id as string, commerceMediaId);
    await params.sql`DELETE FROM public.blocks WHERE product_id = ${frProduct.id}`;
    for (let i = 0; i < commerceSectionsFr.length; i++) {
      await params.sql`
        INSERT INTO public.blocks (product_id, language_id, block_type, content, "order")
        VALUES (${frProduct.id}, ${params.frLangId}, 'section', ${params.sql.json(commerceSectionsFr[i] as any)}, ${i})
      `;
    }
  }

  console.log('[Sandbox Reset] Successfully enriched commerce products (EN & FR).');
}

async function enrichCortexAiProducts(params: {
  sql: SqlClient;
  cortexAsset: UploadedSeedAsset;
  enLangId: LanguageId;
  frLangId: LanguageId;
}) {
  console.log('[Sandbox Reset] Enriching NextBlock™ Cortex AI...');

  const cortexMediaId = await upsertMediaRecord(
    params.sql,
    params.cortexAsset,
    'Sandbox seed asset: NextBlock™ Cortex AI.'
  );

  const [product] = await params.sql`
    SELECT *
    FROM public.products
    WHERE freemius_product_id = ${SANDBOX_CORTEX_AI_PRODUCT_ID} AND language_id = ${params.enLangId}
    LIMIT 1
  `;

  if (!product) {
    throw new Error(
      `Cortex AI product ${SANDBOX_CORTEX_AI_PRODUCT_ID} was not found after Freemius sync.`
    );
  }

  const shortDescEn =
    'NextBlock™ Cortex AI License brings block-level machine intelligence to your Next.js block editor. Generate copy, refactor structures, and automate translations in one click, built on an open, BYOK cost-controlled architecture.';

  // ── Section 0: Hero Gradient ──
  const cortexS0En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '135deg',
        stops: [
          { color: '#1e1b4b', position: 0 },
          { color: '#312e81', position: 35 },
          { color: '#0f172a', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 2 },
    column_gap: 'xl',
    vertical_alignment: 'center',
    padding: { top: 'xl', bottom: 'xl' },
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4">AI Intelligence Layer</p>
<h2 class="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5">Supercharge Your<br/>Editor with AI.</h2>
<p class="text-base md:text-lg text-slate-200 leading-relaxed mb-6">Cortex AI integrates state-of-the-art LLMs directly into the block authoring surface. Generate copy, summarize content, refactor layouts, and translate pages — all without leaving your editor.</p>`,
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Get Cortex AI →',
            url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
            variant: 'default',
            size: 'lg',
            position: 'left',
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8">
<h3 class="text-lg font-bold text-white mb-5">OpenRouter &amp; BYOK Architecture</h3>
<ul class="space-y-4 text-sm leading-relaxed text-slate-300">
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Bring Your Own Key</strong> — complete cost control using your own OpenRouter API tokens. No hidden fees.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Block-Aware Prompts</strong> — Cortex AI understands the JSONB schema, not just raw text. Outputs valid block structures.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Design-System Aware</strong> — generated content respects your Tailwind config and brand guidelines automatically.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Multi-Model Support</strong> — switch between GPT-4o, Claude, Gemini, and more via a single config toggle.</span>
  </li>
</ul>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 1: Social-proof metrics bar ──
  const cortexS1En = {
    container_type: 'container',
    background: { type: 'theme', theme: 'muted' },
    responsive_columns: { mobile: 1, tablet: 2, desktop: 4 },
    column_gap: 'lg',
    padding: { top: 'lg', bottom: 'lg' },
    vertical_alignment: 'center',
    column_blocks: [
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">50+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">AI Models Available</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">< 2s</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Avg. Generation Time</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">100 %</span><span class="text-xs text-muted-foreground uppercase tracking-wider">BYOK Cost Control</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">2</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Languages Supported</span></p>' } }],
    ],
  };

  // ── Section 2: Three-column feature cards ──
  const cortexS2En = {
    container_type: 'container',
    background: { type: 'none' },
    responsive_columns: { mobile: 1, tablet: 2, desktop: 3 },
    column_gap: 'lg',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'stretch',
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">✍️</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">One-Click Copywriting</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Draft blog entries, optimize headlines, generate call-to-actions, and write product descriptions — all with context-aware prompts that know your content.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">🔄</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Structure Refactoring</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Instantly convert columns, add layout grids, or reorganize block nodes. Cortex AI generates valid JSONB schema, not just text suggestions.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">🌐</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Automated Translation</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Localize complete pages between English and French while preserving all nested sub-blocks, layouts, and section styling intact.</p>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 3: Deep-dive 2-col ──
  const cortexS3En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '180deg',
        stops: [
          { color: '#020617', position: 0 },
          { color: '#0f172a', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 2 },
    column_gap: 'xl',
    vertical_alignment: 'center',
    padding: { top: 'xl', bottom: 'xl' },
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4">How It Works</p>
<h3 class="text-2xl md:text-3xl font-extrabold text-white mb-4">AI That Understands Blocks</h3>
<p class="text-slate-300 leading-relaxed mb-5">Unlike generic AI tools, Cortex AI is deeply integrated with the NextBlock™ block editor. It understands your section layouts, column structures, and nested content hierarchies — generating outputs that slot directly into your page without manual cleanup.</p>
<ul class="space-y-3 text-sm text-slate-400">
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Inline AI toolbar appears on text selection</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Prompt presets for common content tasks</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Full-page generation from a single prompt</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Token usage tracking in the admin dashboard</span>
  </li>
</ul>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="space-y-4">
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Content Generation</h5>
  <p class="text-xs text-slate-400 leading-relaxed">From short ad copy to long-form articles, Cortex AI generates on-brand content that matches your tone and style. Outputs are pre-formatted for your design system.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">SEO Optimization</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Auto-generate meta titles, descriptions, and heading hierarchies. Cortex AI analyzes your content structure and suggests SEO improvements in real-time.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Privacy-First Design</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Your content is sent directly to OpenRouter using YOUR key. NextBlock™ never stores, logs, or proxies your AI requests — full data sovereignty guaranteed.</p>
</div>
</div>`,
          },
        },
      ],
    ],
  };

  // ── Section 4: CTA ──
  const cortexS4En = {
    container_type: 'container',
    background: {
      type: 'gradient',
      gradient: {
        type: 'linear',
        direction: '135deg',
        stops: [
          { color: '#312e81', position: 0 },
          { color: '#1e1b4b', position: 100 },
        ],
      },
    },
    responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
    column_gap: 'none',
    padding: { top: 'xl', bottom: 'xl' },
    vertical_alignment: 'center',
    column_blocks: [
      [
        {
          block_type: 'heading',
          content: { level: 2, text_content: 'Ready to add AI to your editor?', textAlign: 'center', textColor: 'background' },
        },
        {
          block_type: 'text',
          content: {
            html_content: '<p class="text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6">Unlock the full power of AI-driven content creation. BYOK, privacy-first, and deeply integrated with your block editor.</p>',
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Purchase Cortex AI',
            url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
            variant: 'secondary',
            size: 'lg',
            position: 'center',
          },
        },
      ],
    ],
  };

  const cortexSectionsEn = [cortexS0En, cortexS1En, cortexS2En, cortexS3En, cortexS4En];

  await params.sql`
    UPDATE public.products
    SET
      title = 'NextBlock™ Cortex AI - Cortex AI License',
      short_description = ${shortDescEn},
      description_json = NULL,
      product_type = 'digital',
      payment_provider = 'freemius'
    WHERE id = ${product.id}
  `;

  await attachProductMedia(params.sql, product.id as string, cortexMediaId);

  // Set description blocks for English Cortex AI product
  await params.sql`DELETE FROM public.blocks WHERE product_id = ${product.id}`;
  for (let i = 0; i < cortexSectionsEn.length; i++) {
    await params.sql`
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order")
      VALUES (${product.id}, ${params.enLangId}, 'section', ${params.sql.json(cortexSectionsEn[i] as any)}, ${i})
    `;
  }

  // ── French Sections ──
  const shortDescFr =
    "La licence NextBlock™ Cortex AI apporte l'intelligence artificielle au niveau des blocs directement dans votre éditeur de contenu Next.js. Génération, refactorisation et traduction de pages en un clic.";

  const cortexS0Fr = {
    ...cortexS0En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4">Couche d'Intelligence IA</p>
<h2 class="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5">Boostez votre éditeur<br/>avec l'IA native.</h2>
<p class="text-base md:text-lg text-slate-200 leading-relaxed mb-6">Cortex AI intègre les LLMs les plus performants directement dans votre surface d'édition de blocs. Rédigez, résumez, restructurez et traduisez — sans quitter l'éditeur.</p>`,
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Obtenir Cortex AI →',
            url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
            variant: 'default',
            size: 'lg',
            position: 'left',
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8">
<h3 class="text-lg font-bold text-white mb-5">OpenRouter et architecture BYOK</h3>
<ul class="space-y-4 text-sm leading-relaxed text-slate-300">
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Bring Your Own Key</strong> — contrôle total des coûts avec vos propres jetons API OpenRouter. Aucun frais caché.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Prompts conscients des blocs</strong> — Cortex AI comprend le schéma JSONB, pas seulement le texte brut. Produit des structures de blocs valides.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Respect du design system</strong> — le contenu généré respecte automatiquement votre configuration Tailwind et vos guidelines de marque.</span>
  </li>
  <li class="flex items-start gap-3">
    <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold">✓</span>
    <span><strong class="text-white">Support multi-modèles</strong> — basculez entre GPT-4o, Claude, Gemini et plus via un simple paramètre.</span>
  </li>
</ul>
</div>`,
          },
        },
      ],
    ],
  };

  const cortexS1Fr = {
    ...cortexS1En,
    column_blocks: [
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">50+</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Modèles IA disponibles</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">< 2s</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Temps de génération moy.</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">100 %</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Contrôle des coûts BYOK</span></p>' } }],
      [{ block_type: 'text', content: { html_content: '<p class="text-center"><span class="block text-2xl font-extrabold text-foreground">2</span><span class="text-xs text-muted-foreground uppercase tracking-wider">Langues supportées</span></p>' } }],
    ],
  };

  const cortexS2Fr = {
    ...cortexS2En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">✍️</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Rédaction en un clic</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Rédigez des articles, optimisez vos titres, créez des appels à l'action et rédigez des descriptions produits — le tout avec des prompts contextuels.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">🔄</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Refactorisation de structure</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Convertissez des colonnes, ajoutez des grilles ou réorganisez vos nœuds de blocs. Cortex AI génère un schéma JSONB valide, pas des suggestions textuelles.</p>
</div>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7">
<p class="text-2xl mb-3">🌐</p>
<h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">Traduction automatique</h4>
<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">Localisez vos pages complètes entre le français et l'anglais en préservant tous les blocs imbriqués, mises en page et styles de section.</p>
</div>`,
          },
        },
      ],
    ],
  };

  const cortexS3Fr = {
    ...cortexS3En,
    column_blocks: [
      [
        {
          block_type: 'text',
          content: {
            html_content: `<p class="text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4">Comment ça marche</p>
<h3 class="text-2xl md:text-3xl font-extrabold text-white mb-4">Une IA qui comprend les blocs</h3>
<p class="text-slate-300 leading-relaxed mb-5">Contrairement aux outils IA génériques, Cortex AI est profondément intégré à l'éditeur de blocs NextBlock™. Il comprend vos sections, structures de colonnes et hiérarchies de contenu — générant des sorties qui s'insèrent directement dans votre page.</p>
<ul class="space-y-3 text-sm text-slate-400">
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Barre d'outils IA intégrée à la sélection de texte</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Prompts prédéfinis pour les tâches courantes</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Génération de pages complètes à partir d'un seul prompt</span>
  </li>
  <li class="flex items-start gap-2.5">
    <span class="text-violet-400">→</span>
    <span>Suivi de la consommation de tokens dans le tableau de bord</span>
  </li>
</ul>`,
          },
        },
      ],
      [
        {
          block_type: 'text',
          content: {
            html_content: `<div class="space-y-4">
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Génération de contenu</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Des textes publicitaires aux articles de fond, Cortex AI génère du contenu fidèle à votre marque. Les sorties sont pré-formatées pour votre design system.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Optimisation SEO</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Génération automatique de titres méta, descriptions et hiérarchie de titres. Cortex AI analyse votre structure et suggère des améliorations SEO en temps réel.</p>
</div>
<div class="p-5 rounded-xl border border-slate-700 bg-slate-900">
  <h5 class="text-sm font-bold text-white mb-1">Conception axée sur la vie privée</h5>
  <p class="text-xs text-slate-400 leading-relaxed">Votre contenu est envoyé directement à OpenRouter avec VOTRE clé. NextBlock™ ne stocke, ne journalise et ne proxifie jamais vos requêtes IA — souveraineté totale sur vos données.</p>
</div>
</div>`,
          },
        },
      ],
    ],
  };

  const cortexS4Fr = {
    ...cortexS4En,
    column_blocks: [
      [
        {
          block_type: 'heading',
          content: { level: 2, text_content: "Prêt à ajouter l'IA à votre éditeur ?", textAlign: 'center', textColor: 'background' },
        },
        {
          block_type: 'text',
          content: {
            html_content: '<p class="text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6">Libérez la puissance de la création de contenu assistée par IA. BYOK, vie privée d\'abord, et intégration profonde avec votre éditeur de blocs.</p>',
          },
        },
        {
          block_type: 'button',
          content: {
            text: 'Acheter Cortex AI',
            url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
            variant: 'secondary',
            size: 'lg',
            position: 'center',
          },
        },
      ],
    ],
  };

  const cortexSectionsFr = [cortexS0Fr, cortexS1Fr, cortexS2Fr, cortexS3Fr, cortexS4Fr];

  const [frProduct] = await params.sql`
    INSERT INTO public.products (
      sku, title, slug, price, sale_price, stock, status,
      short_description, description_json,
      product_type, payment_provider,
      language_id, translation_group_id,
      freemius_product_id, freemius_plan_id,
      trial_period_days, trial_requires_payment_method
    )
    VALUES (
      ${product.sku}, 'Licence NextBlock™ Cortex AI', ${String(product.slug) + '-fr'},
      ${product.price}, ${product.sale_price}, ${product.stock || 99}, ${product.status},
      ${shortDescFr}, NULL,
      'digital', 'freemius',
      ${params.frLangId}, ${product.translation_group_id},
      ${product.freemius_product_id}, ${product.freemius_plan_id},
      ${product.trial_period_days ?? 0}, ${product.trial_requires_payment_method ?? false}
    )
    ON CONFLICT ON CONSTRAINT products_language_id_slug_key DO UPDATE
    SET
      title = EXCLUDED.title,
      short_description = EXCLUDED.short_description,
      description_json = NULL,
      product_type = EXCLUDED.product_type,
      payment_provider = EXCLUDED.payment_provider,
      trial_period_days = EXCLUDED.trial_period_days,
      trial_requires_payment_method = EXCLUDED.trial_requires_payment_method
    RETURNING id
  `;

  if (frProduct?.id) {
    await attachProductMedia(params.sql, frProduct.id as string, cortexMediaId);
    await params.sql`DELETE FROM public.blocks WHERE product_id = ${frProduct.id}`;
    for (let i = 0; i < cortexSectionsFr.length; i++) {
      await params.sql`
        INSERT INTO public.blocks (product_id, language_id, block_type, content, "order")
        VALUES (${frProduct.id}, ${params.frLangId}, 'section', ${params.sql.json(cortexSectionsFr[i] as any)}, ${i})
      `;
    }
  }

  console.log('[Sandbox Reset] Successfully enriched Cortex AI products (EN & FR).');
}


async function ensureSandboxCommerceProductSynced(params: {
  sql: SqlClient;
  enLangId: LanguageId;
}) {
  const [existingProduct] = await params.sql`
    SELECT id
    FROM public.products
    WHERE freemius_product_id = ${SANDBOX_COMMERCE_PRODUCT_ID}
      AND language_id = ${params.enLangId}
    LIMIT 1
  `;

  if (existingProduct?.id) {
    return existingProduct.id as string;
  }

  console.warn(
    `[Sandbox Reset] Commerce Pro product ${SANDBOX_COMMERCE_PRODUCT_ID} was missing after the full Freemius sync. Retrying targeted sync.`
  );

  const fallbackResult = await syncSingleFreemiusProduct(SANDBOX_COMMERCE_PRODUCT_ID);
  console.log(
    `[Sandbox Reset] Targeted Commerce Pro sync completed with ${fallbackResult?.count || 0} product(s).`
  );

  const [syncedProduct] = await params.sql`
    SELECT id
    FROM public.products
    WHERE freemius_product_id = ${SANDBOX_COMMERCE_PRODUCT_ID}
      AND language_id = ${params.enLangId}
    LIMIT 1
  `;

  if (!syncedProduct?.id) {
    throw new Error(
      `Targeted Commerce Pro sync did not create product ${SANDBOX_COMMERCE_PRODUCT_ID}.`
    );
  }

  return syncedProduct.id as string;
}

async function upsertSeededCatalogProduct(params: {
  sql: SqlClient;
  productId?: string;
  translationGroupId: string;
  languageId: LanguageId;
  localeCode: 'en' | 'fr';
  locale: SeededLocale;
  baseSku: string;
  price: number;
  accent: ApparelAccentName;
  mediaId: string;
  variantStocks: Record<SizeSlug, number>;
  sizeTermIds: Record<SizeSlug, string>;
}) {
  const variantDefinitions = [
    { slug: 'small', skuSuffix: 'S' },
    { slug: 'medium', skuSuffix: 'M' },
    { slug: 'large', skuSuffix: 'L' },
  ] as const;

  const totalStock = variantDefinitions.reduce(
    (sum, variant) => sum + params.variantStocks[variant.slug],
    0
  );

  const metadata = {
    seed_source: 'sandbox-reset',
    seed_type: 'physical-apparel',
  };
  const descriptionSections = buildApparelDescriptionSections(
    params.locale.description,
    params.accent,
    params.localeCode
  );

  let seededProductId = params.productId;

  if (seededProductId) {
    const [updatedProduct] = await params.sql`
      UPDATE public.products
      SET
        language_id = ${params.languageId},
        translation_group_id = ${params.translationGroupId},
        sku = ${params.baseSku},
        title = ${params.locale.title},
        slug = ${params.locale.slug},
        price = ${params.price},
        sale_price = NULL,
        stock = ${totalStock},
        status = 'active',
        short_description = ${params.locale.shortDescription},
        description_json = NULL,
        metadata = ${params.sql.json(metadata)},
        is_taxable = true,
        product_type = 'physical',
        payment_provider = 'stripe',
        trial_period_days = 0,
        trial_requires_payment_method = false,
        updated_at = now()
      WHERE id = ${seededProductId}
      RETURNING id
    `;

    seededProductId = updatedProduct?.id as string | undefined;
  }

  if (!seededProductId) {
    const [upsertedProduct] = await params.sql`
      INSERT INTO public.products (
        language_id,
        translation_group_id,
        sku,
        title,
        slug,
        price,
        sale_price,
        stock,
        status,
        short_description,
        description_json,
        metadata,
        is_taxable,
        product_type,
        payment_provider,
        trial_period_days,
        trial_requires_payment_method
      )
      VALUES (
        ${params.languageId},
        ${params.translationGroupId},
        ${params.baseSku},
        ${params.locale.title},
        ${params.locale.slug},
        ${params.price},
        NULL,
        ${totalStock},
        'active',
        ${params.locale.shortDescription},
        NULL,
        ${params.sql.json(metadata)},
        true,
        'physical',
        'stripe',
        0,
        false
      )
      ON CONFLICT ON CONSTRAINT products_language_id_slug_key DO UPDATE
      SET
        translation_group_id = EXCLUDED.translation_group_id,
        sku = EXCLUDED.sku,
        title = EXCLUDED.title,
        price = EXCLUDED.price,
        sale_price = EXCLUDED.sale_price,
        stock = EXCLUDED.stock,
        status = EXCLUDED.status,
        short_description = EXCLUDED.short_description,
        description_json = NULL,
        metadata = EXCLUDED.metadata,
        is_taxable = EXCLUDED.is_taxable,
        product_type = EXCLUDED.product_type,
        payment_provider = EXCLUDED.payment_provider,
        trial_period_days = EXCLUDED.trial_period_days,
        trial_requires_payment_method = EXCLUDED.trial_requires_payment_method,
        updated_at = now()
      RETURNING id
    `;

    seededProductId = upsertedProduct?.id as string | undefined;
  }

  if (!seededProductId) {
    throw new Error(`Failed to upsert seeded product ${params.locale.slug}.`);
  }

  await attachProductMedia(params.sql, seededProductId, params.mediaId);

  // Set description blocks (rich section layout, editable in the block editor)
  await params.sql`DELETE FROM public.blocks WHERE product_id = ${seededProductId}`;
  for (let i = 0; i < descriptionSections.length; i++) {
    await params.sql`
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order")
      VALUES (${seededProductId}, ${params.languageId}, 'section', ${params.sql.json(descriptionSections[i] as any)}, ${i})
    `;
  }

  await params.sql`
    DELETE FROM public.variant_attribute_mapping
    WHERE variant_id IN (
      SELECT id
      FROM public.product_variants
      WHERE product_id = ${seededProductId}
    )
  `;

  await params.sql`
    DELETE FROM public.product_variants
    WHERE product_id = ${seededProductId}
  `;

  for (const variant of variantDefinitions) {
    const [insertedVariant] = await params.sql`
      INSERT INTO public.product_variants (
        product_id,
        sku,
        price,
        sale_price,
        stock_quantity,
        main_media_id
      )
      VALUES (
        ${seededProductId},
        ${`${params.baseSku}-${variant.skuSuffix}`},
        ${params.price},
        NULL,
        ${params.variantStocks[variant.slug]},
        ${params.mediaId}
      )
      RETURNING id
    `;

    if (!insertedVariant?.id) {
      throw new Error(`Failed to create variant ${params.baseSku}-${variant.skuSuffix}.`);
    }

    await params.sql`
      INSERT INTO public.variant_attribute_mapping (variant_id, attribute_term_id)
      VALUES (${insertedVariant.id}, ${params.sizeTermIds[variant.slug]})
    `;
  }

  await params.sql`
    UPDATE public.product_variants
    SET
      main_media_id = ${params.mediaId},
      updated_at = now()
    WHERE product_id = ${seededProductId}
  `;

  await upsertInventoryItems(
    params.sql,
    variantDefinitions.map((variant) => ({
      sku: `${params.baseSku}-${variant.skuSuffix}`,
      quantity: params.variantStocks[variant.slug],
    }))
  );

  return seededProductId;
}

async function seedApparelCatalog(params: {
  sql: SqlClient;
  enLangId: LanguageId;
  frLangId: LanguageId;
  uploadedAssets: Map<string, UploadedSeedAsset>;
}) {
  console.log('[Sandbox Reset] Seeding apparel catalog...');

  const sizeTermIds = await ensureSizeAttribute(params.sql);

  for (const productSeed of APPAREL_PRODUCT_SEEDS) {
    const uploadedAsset = params.uploadedAssets.get(productSeed.imageKey);
    if (!uploadedAsset) {
      throw new Error(`Missing uploaded asset for ${productSeed.imageKey}.`);
    }

    const mediaId = await upsertMediaRecord(params.sql, uploadedAsset, uploadedAsset.description);

    const [existingEnProduct] = await params.sql`
      SELECT id, translation_group_id
      FROM public.products
      WHERE language_id = ${params.enLangId} AND slug = ${productSeed.en.slug}
      LIMIT 1
    `;

    const [existingFrProduct] = await params.sql`
      SELECT id, translation_group_id
      FROM public.products
      WHERE language_id = ${params.frLangId} AND slug = ${productSeed.fr.slug}
      LIMIT 1
    `;

    const translationGroupId =
      (existingEnProduct?.translation_group_id as string | undefined) ||
      (existingFrProduct?.translation_group_id as string | undefined) ||
      crypto.randomUUID();

    await upsertSeededCatalogProduct({
      sql: params.sql,
      productId: existingEnProduct?.id as string | undefined,
      translationGroupId,
      languageId: params.enLangId,
      localeCode: 'en',
      locale: productSeed.en,
      baseSku: productSeed.baseSku,
      price: productSeed.price,
      accent: productSeed.accent,
      mediaId,
      variantStocks: productSeed.variantStocks,
      sizeTermIds,
    });

    await upsertSeededCatalogProduct({
      sql: params.sql,
      productId: existingFrProduct?.id as string | undefined,
      translationGroupId,
      languageId: params.frLangId,
      localeCode: 'fr',
      locale: productSeed.fr,
      baseSku: productSeed.baseSku,
      price: productSeed.price,
      accent: productSeed.accent,
      mediaId,
      variantStocks: productSeed.variantStocks,
      sizeTermIds,
    });
  }

  console.log('[Sandbox Reset] Successfully seeded apparel catalog.');
}

async function ensureShopPagesAndNavigation(params: {
  sql: SqlClient;
  enLangId: LanguageId;
  frLangId: LanguageId;
}) {
  console.log('[Sandbox Reset] Adding Shop Pages and navigation items...');
  let globalShopGroupId: string | undefined;

  {
    const langId = params.enLangId;
    const [existingPage] = await params.sql`
      SELECT id, translation_group_id
      FROM public.pages
      WHERE language_id = ${langId} AND slug = 'shop'
    `;
    let pageId = existingPage?.id as number | undefined;
    globalShopGroupId = existingPage?.translation_group_id as string | undefined;

    if (!pageId) {
      const [newPage] = await params.sql`
        INSERT INTO public.pages (language_id, title, slug, status, meta_title, meta_description)
        VALUES (
          ${langId},
          'Shop Our Products',
          'shop',
          'published',
          'NextBlock™ Store',
          'Browse our premium products'
        )
        RETURNING id, translation_group_id
      `;
      pageId = newPage.id as number;
      globalShopGroupId = newPage?.translation_group_id as string | undefined;

      const heroContent = {
        is_hero: true,
        container_type: 'full-width',
        background: {
          type: 'theme',
          theme: 'primary',
        },
        responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
        column_gap: 'lg',
        padding: { top: 'xl', bottom: 'xl' },
        vertical_alignment: 'center',
        column_blocks: [
          [
            {
              block_type: 'heading',
              content: {
                level: 1,
                text_content: 'NextBlock™ Store',
                textAlign: 'center',
                textColor: 'background',
              },
            },
            {
              block_type: 'text',
              content: {
                html_content:
                  '<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our premium selection of developer tools and digital commerce solutions.</p>',
              },
            },
          ],
        ],
      };

      const sectionContent = {
        container_type: 'container',
        background: { type: 'none' },
        responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
        column_gap: 'none',
        padding: { top: 'xl', bottom: 'xl' },
        column_blocks: [
          [
            {
              block_type: 'heading',
              content: {
                level: 2,
                text_content: 'Featured Products',
                textAlign: 'center',
              },
            },
            {
              block_type: 'product_grid',
              content: {
                type: 'latest',
                limit: 6,
              },
            },
          ],
        ],
      };

      await params.sql`
        INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
        VALUES
          (${pageId}, ${langId}, 'section', ${params.sql.json(heroContent as any)}, 0),
          (${pageId}, ${langId}, 'section', ${params.sql.json(sectionContent as any)}, 1)
      `;
    }

    const [exists] = await params.sql`
      SELECT id
      FROM public.navigation_items
      WHERE language_id = ${langId} AND url = '/shop'
    `;
    if (!exists) {
      await params.sql`
        INSERT INTO public.navigation_items (language_id, menu_key, label, url, "order")
        VALUES (${langId}, 'HEADER', 'Shop', '/shop', 2)
      `;
    }
  }

  {
    const langId = params.frLangId;
    const [existingPage] = await params.sql`
      SELECT id
      FROM public.pages
      WHERE language_id = ${langId} AND slug = 'boutique'
    `;
    let pageId = existingPage?.id as number | undefined;

    if (!pageId) {
      const [newPage] = await params.sql`
        INSERT INTO public.pages (
          language_id,
          title,
          slug,
          status,
          meta_title,
          meta_description,
          translation_group_id
        )
        VALUES (
          ${langId},
          'Boutique en Ligne',
          'boutique',
          'published',
          'Boutique NextBlock™',
          'Decouvrez nos produits premium',
          ${globalShopGroupId ?? null}
        )
        RETURNING id
      `;
      pageId = newPage.id as number;

      const heroContent = {
        is_hero: true,
        container_type: 'full-width',
        background: {
          type: 'theme',
          theme: 'primary',
        },
        responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
        column_gap: 'lg',
        padding: { top: 'xl', bottom: 'xl' },
        vertical_alignment: 'center',
        column_blocks: [
          [
            {
              block_type: 'heading',
              content: {
                level: 1,
                text_content: 'Boutique NextBlock™',
                textAlign: 'center',
                textColor: 'background',
              },
            },
            {
              block_type: 'text',
              content: {
                html_content:
                  '<p style="text-align: center; color: var(--background); opacity: 0.9">Decouvrez notre selection premium d outils de developpement.</p>',
              },
            },
          ],
        ],
      };

      const sectionContent = {
        container_type: 'container',
        background: { type: 'none' },
        responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
        column_gap: 'none',
        padding: { top: 'xl', bottom: 'xl' },
        column_blocks: [
          [
            {
              block_type: 'heading',
              content: {
                level: 2,
                text_content: 'Produits Vedettes',
                textAlign: 'center',
              },
            },
            {
              block_type: 'product_grid',
              content: {
                type: 'latest',
                limit: 6,
              },
            },
          ],
        ],
      };

      await params.sql`
        INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
        VALUES
          (${pageId}, ${langId}, 'section', ${params.sql.json(heroContent as any)}, 0),
          (${pageId}, ${langId}, 'section', ${params.sql.json(sectionContent as any)}, 1)
      `;
    }

    const [exists] = await params.sql`
      SELECT id
      FROM public.navigation_items
      WHERE language_id = ${langId} AND url = '/boutique'
    `;
    if (!exists) {
      await params.sql`
        INSERT INTO public.navigation_items (language_id, menu_key, label, url, "order")
        VALUES (${langId}, 'HEADER', 'Boutique', '/boutique', 2)
      `;
    }
  }

  console.log('[Sandbox Reset] Successfully created Shop pages and navigation.');
}

async function seedCategoriesAndMappings(sql: SqlClient) {
  console.log('[Sandbox Reset] Seeding categories and product mappings...');

  const categoriesToSeed = [
    { 
      name: 'Software', 
      slug: 'software', 
      description: 'Developer software products and licenses.',
      name_translations: { fr: 'Logiciel' },
      description_translations: { fr: 'Logiciels et licences de développement.' }
    },
    { 
      name: 'AI', 
      slug: 'ai', 
      description: 'Artificial Intelligence tools and neural components.',
      name_translations: { fr: 'IA' },
      description_translations: { fr: 'Outils d\'intelligence artificielle.' }
    },
    { 
      name: 'Apparel', 
      slug: 'apparel', 
      description: 'Premium garments and studio uniforms built for developers.',
      name_translations: { fr: 'Vêtements' },
      description_translations: { fr: 'Vêtements de qualité et uniformes conçus pour les développeurs.' }
    },
    { 
      name: 'Featured', 
      slug: 'featured', 
      description: 'Highlights and featured collection items.',
      name_translations: { fr: 'En vedette' },
      description_translations: { fr: 'Articles en vedette et nouveautés.' }
    },
  ];

  const categoryMap = new Map<string, string>(); // slug -> id

  for (const cat of categoriesToSeed) {
    const [inserted] = await sql`
      INSERT INTO public.categories (name, slug, description, name_translations, description_translations)
      VALUES (
        ${cat.name}, 
        ${cat.slug}, 
        ${cat.description}, 
        ${sql.json(cat.name_translations)}, 
        ${sql.json(cat.description_translations)}
      )
      ON CONFLICT (slug) DO UPDATE
      SET name = EXCLUDED.name, 
          description = EXCLUDED.description,
          name_translations = EXCLUDED.name_translations,
          description_translations = EXCLUDED.description_translations
      RETURNING id
    `;
    if (inserted?.id) {
      categoryMap.set(cat.slug, inserted.id as string);
    }
  }

  // Fetch all seeded products across both languages to ensure all translations are mapped.
  const products = await sql`
    SELECT id, sku, freemius_product_id
    FROM public.products
    WHERE freemius_product_id IN ('24851', '28609')
       OR sku IN ('NB-STUDIO-TEE', 'NB-SIGNAL-CAP', 'NB-UTILITY-PANTS')
  `;

  const productIds = products.map((p) => p.id);
  if (productIds.length > 0) {
    await sql`
      DELETE FROM public.product_categories
      WHERE product_id = ANY(${productIds})
    `;
  }

  const mappings: Array<{ product_id: string; category_id: string }> = [];

  for (const prod of products) {
    const slugs: string[] = [];
    if (prod.freemius_product_id === '24851') {
      slugs.push('software', 'featured');
    } else if (prod.freemius_product_id === '28609') {
      slugs.push('software', 'ai');
    } else if (prod.sku === 'NB-STUDIO-TEE') {
      slugs.push('apparel', 'featured');
    } else if (prod.sku === 'NB-SIGNAL-CAP') {
      slugs.push('apparel');
    } else if (prod.sku === 'NB-UTILITY-PANTS') {
      slugs.push('apparel');
    }

    for (const slug of slugs) {
      const catId = categoryMap.get(slug);
      if (catId) {
        mappings.push({
          product_id: prod.id as string,
          category_id: catId,
        });
      }
    }
  }

  if (mappings.length > 0) {
    for (const mapping of mappings) {
      await sql`
        INSERT INTO public.product_categories (product_id, category_id)
        VALUES (${mapping.product_id}, ${mapping.category_id})
        ON CONFLICT DO NOTHING
      `;
    }
    console.log(`[Sandbox Reset] Seeded ${mappings.length} product-category associations.`);
  }

  console.log('[Sandbox Reset] Successfully completed categories seeding.');
}

async function seedFakeStoreData(sql: SqlClient, supabaseAdmin: any) {
  console.log('[Sandbox Reset] Starting fake store data seeding...');
  
  // 1. Ensure Demo User
  const email = 'demo@nextblock.dev';
  console.log(`[Sandbox Reset] Checking for demo user: ${email}`);
  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.listUsers();
  if (userError) {
    console.error('[Sandbox Reset] Auth listUsers error:', userError);
    throw userError;
  }

  let demoUser = userData.users.find((u: any) => u.email === email);
  if (!demoUser) {
    console.log('[Sandbox Reset] Demo user missing in Auth, creating...');
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: 'password',
      email_confirm: true,
      user_metadata: { full_name: 'Nextblock CMS' }
    });
    if (createError) {
      console.error('[Sandbox Reset] Auth createUser error:', createError);
      throw createError;
    }
    demoUser = newUser.user;
    console.log(`[Sandbox Reset] Created new demo user with ID: ${demoUser.id}`);
  } else {
    console.log(`[Sandbox Reset] Found existing demo user with ID: ${demoUser.id}`);
    // The demo credentials are published (README + community posts), so any visitor can
    // change this account's password and lock everyone else out. The SQL reset below does
    // not touch auth.users, so re-assert the known-good password on every run — otherwise a
    // single password change survives every future reset.
    const { error: resetPwError } = await supabaseAdmin.auth.admin.updateUserById(demoUser.id, {
      password: 'password',
      email_confirm: true,
    });
    if (resetPwError) {
      // Non-fatal: the rest of the sandbox reset is still worth doing.
      console.error('[Sandbox Reset] Failed to restore demo password:', resetPwError);
    } else {
      console.log('[Sandbox Reset] Restored demo user password to the published default.');
    }
  }

  const userId = demoUser.id;

  // 2. Seed Invoice Branding
  console.log('[Sandbox Reset] Seeding invoice branding...');
  const branding = {
    business_name: 'NextBlock CMS',
    email: 'billing@nextblock.dev',
    phone: '5143188025',
    address: {
      line1: '',
      line2: '',
      city: 'Salaberry-de-Valleyfield',
      state: 'Quebec',
      postal_code: 'J6S 5B6',
      country_code: 'CA',
    },
    tax_registrations: [],
  };

  await sql`
    INSERT INTO public.site_settings (key, value)
    VALUES ('invoice_settings', ${sql.json(branding)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

  // 3. Seed Profile
  console.log('[Sandbox Reset] Seeding demo account profile (ADMIN)...');
  await sql`
    INSERT INTO public.profiles (id, full_name, website, role, updated_at)
    VALUES (${userId}, 'Nextblock CMS', 'https://nextblock.dev', 'ADMIN', now())
    ON CONFLICT (id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      website = EXCLUDED.website,
      role = 'ADMIN',
      updated_at = now()
  `;

  // 4. Seed Orders
  console.log('[Sandbox Reset] Querying products for order seeding...');
  const products = await sql`
    SELECT id, price, title 
    FROM public.products 
    WHERE status IN ('active', 'published')
    LIMIT 10
  `;
  
  console.log(`[Sandbox Reset] Found ${products.length} products for orders.`);
  
  if (products.length > 0) {
    console.log(`[Sandbox Reset] Cleaning up existing orders for user ${userId}...`);
    await sql`DELETE FROM public.orders WHERE user_id = ${userId}`;
    
    console.log('[Sandbox Reset] Inserting 5 fake orders...');
    for (let i = 0; i < 5; i++) {
      try {
        const product = products[i % products.length];
        const quantity = Math.floor(Math.random() * 2) + 1;
        const total = (product.price || 0) * quantity;
        const orderId = crypto.randomUUID();
        const invoiceNumber = `INV-2024-${1000 + i}`;
        const hoursAgo = `${i * 2} hours`;

        console.log(`[Sandbox Reset] Creating order ${i+1}/5: ${invoiceNumber} for product ${product.title}`);

        await sql`
          INSERT INTO public.orders (
            id, user_id, status, total, subtotal, tax_total, currency,
            invoice_number, paid_at, created_at, customer_details, provider
          ) VALUES (
            ${orderId}, ${userId}, 'paid', ${total}, ${total}, 0, 'USD',
            ${invoiceNumber}, now() - ${hoursAgo}::interval, now() - ${hoursAgo}::interval,
            ${sql.json({ email, name: 'Nextblock CMS' })}, 'stripe'
          )
        `;

        await sql`
          INSERT INTO public.order_items (order_id, product_id, quantity, price_at_purchase)
          VALUES (${orderId}, ${product.id}, ${quantity}, ${product.price})
        `;
      } catch (orderErr: any) {
        console.error(`[Sandbox Reset] Failed to insert order ${i}:`, orderErr.message || orderErr);
      }
    }
    console.log('[Sandbox Reset] Finished order seeding loop.');
  } else {
    console.warn('[Sandbox Reset] Skipping order seeding: No products found.');
  }
}

// The home-page "Live Demo" promo (migration 00000000000006) sends visitors to this
// very sandbox. That CTA is valuable on production (nextblock.dev) but pointless *inside*
// the demo it points at, so we strip it after the reset replays migrations. The blocks are
// tagged with a `nb-sandbox-promo` sentinel comment; after removing them we renumber the
// affected home pages so their block ordering stays contiguous.
async function removeSandboxPromoSections(sql: SqlClient) {
  const deleted = await sql`
    DELETE FROM public.blocks
    WHERE block_type = 'section'
      AND content::text LIKE '%nb-sandbox-promo%'
    RETURNING id
  `;

  if (deleted.length === 0) {
    return;
  }

  await sql`
    WITH home_pages AS (
      SELECT p.id
      FROM public.pages p
      JOIN public.languages l ON l.id = p.language_id
      WHERE (l.code = 'en' AND p.slug = 'home')
         OR (l.code = 'fr' AND p.slug = 'accueil')
    ),
    ranked AS (
      SELECT b.id,
             (ROW_NUMBER() OVER (PARTITION BY b.page_id ORDER BY b."order", b.id) - 1) AS new_order
      FROM public.blocks b
      WHERE b.page_id IN (SELECT id FROM home_pages)
    )
    UPDATE public.blocks b
    SET "order" = r.new_order
    FROM ranked r
    WHERE b.id = r.id AND b."order" <> r.new_order
  `;

  console.log(
    `[Sandbox Reset] Removed ${deleted.length} sandbox-promo section(s) from the home pages.`
  );
}

export async function GET(request: NextRequest) {
  // 1. Guard: fail closed anywhere that is not explicitly the sandbox.
  const isSandboxResetEnabled = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  if (!isSandboxResetEnabled) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // 2. Guard: Verify Cron Secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', {
      status: 401,
    });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  const r2AccountId = process.env.R2_ACCOUNT_ID;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const r2BucketName = process.env.R2_BUCKET_NAME;
  let siteUrl = process.env.NEXT_PUBLIC_URL || request.nextUrl.origin;

  if (siteUrl && siteUrl.includes('localhost:') && request.nextUrl.origin.includes('localhost:')) {
    siteUrl = request.nextUrl.origin;
  }
  if (siteUrl && !siteUrl.startsWith('http')) {
    siteUrl = `https://${siteUrl}`;
  }
  if (siteUrl && siteUrl.endsWith('/')) {
    siteUrl = siteUrl.slice(0, -1);
  }

  if (
    !supabaseUrl ||
    !supabaseServiceKey ||
    !r2AccountId ||
    !r2AccessKeyId ||
    !r2SecretAccessKey ||
    !r2BucketName ||
    !siteUrl
  ) {
    return NextResponse.json({ error: 'Missing environment variables' }, { status: 500 });
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });

  try {
    console.log('[Sandbox Reset] Starting Hard Reset...');

    console.log('[Sandbox Reset] Wiping R2 Bucket...');
    let continuationToken: string | undefined;
    do {
      const listCmd = new ListObjectsV2Command({
        Bucket: r2BucketName,
        ContinuationToken: continuationToken,
      });
      const listRes = await s3.send(listCmd);
      
      if (listRes.Contents && listRes.Contents.length > 0) {
        const objectsToDelete = listRes.Contents.map((obj) => ({ Key: obj.Key }));
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: r2BucketName,
            Delete: { Objects: objectsToDelete },
          })
        );
        console.log(`[Sandbox Reset] Deleted ${objectsToDelete.length} objects.`);
      }

      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    console.log('[Sandbox Reset] Fetching and re-seeding assets...');
    const uploadedAssets = await uploadSeedAssets({
      s3,
      bucketName: r2BucketName,
      siteUrl,
    });

    console.log('[Sandbox Reset] Resetting Database...');
    const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('Missing POSTGRES_URL environment variable');
    }

    const db = postgres(dbUrl, { ssl: 'require', onnotice: () => undefined });
    try {
      try {
        await db.unsafe(SANDBOX_RESET_SQL);
        console.log('[Sandbox Reset] Database re-seeded successfully.');
      } catch (dbError: any) {
        console.error('[Sandbox Reset] DB Error:', dbError);
        throw dbError;
      }

      // The replayed migrations re-add the "Live Demo" home-page promo that points at this
      // sandbox — strip it here so the demo does not advertise itself to itself.
      await removeSandboxPromoSections(db);

      const normalizedMediaCount = await normalizeMediaStorageKeys(db);
      if (normalizedMediaCount > 0) {
        console.log(
          `[Sandbox Reset] Normalized ${normalizedMediaCount} media storage key(s) after SQL reset.`
        );
      }

      await ensureCoreMediaRecords({
        sql: db,
        uploadedAssets,
      });

      console.log('[Sandbox Reset] Pre-activating premium packages...');
      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });

      if (process.env.FREEMIUS_ECOMMERCE_SANDBOX_KEY) {
        const { error: activationError } = await supabaseAdmin.from('package_activations').insert({
          package_id: 'ecommerce',
          license_key: process.env.FREEMIUS_ECOMMERCE_SANDBOX_KEY,
          status: 'active',
          instance_name: siteUrl,
        });
        
        if (activationError) {
          console.error('[Sandbox Reset] Failed to activate ecommerce package:', activationError.message);
          throw activationError;
        } else {
          console.log('[Sandbox Reset] Successfully activated ecommerce package.');
          
          // Dynamically populate the store with Freemius products
          try {
            console.log('[Sandbox Reset] Syncing products from Freemius...');
            const syncRes = await syncFreemiusProductsToSupabase();
            console.log(`[Sandbox Reset] Synced ${syncRes?.count || 0} products.`);
            await db`
              INSERT INTO public.site_settings (key, value)
              VALUES (
                'enabled_payment_providers',
                '{"stripe": true, "freemius": true}'::jsonb
              )
              ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value
            `;

            try {
              const { enLangId, frLangId } = await getLanguageIds(db);
              await ensureSandboxCommerceProductSynced({
                sql: db,
                enLangId,
              });
              const commerceAsset = uploadedAssets.get('images/commerce-square.webp');

              if (!commerceAsset) {
                throw new Error('Missing uploaded Commerce Pro asset after R2 seed step.');
              }

              await enrichCommerceProducts({
                sql: db,
                commerceAsset,
                enLangId,
                frLangId,
              });

              const cortexAsset = uploadedAssets.get('images/cortex-ai-square.webp');
              if (!cortexAsset) {
                throw new Error('Missing uploaded Cortex AI asset after R2 seed step.');
              }

              await enrichCortexAiProducts({
                sql: db,
                cortexAsset,
                enLangId,
                frLangId,
              });

              await db.begin(async (sql: any) => {
                const tx = sql as SqlClient;

                await seedApparelCatalog({
                  sql: tx,
                  enLangId,
                  frLangId,
                  uploadedAssets,
                });
              });

              await ensureShopPagesAndNavigation({
                sql: db,
                enLangId,
                frLangId,
              });

              await seedCategoriesAndMappings(db);
            } catch (enrichErr: any) {
              console.error('[Sandbox Reset] Product enrichment failed:', enrichErr.message || enrichErr);
              throw enrichErr;
            }

          /*
          // Post-sync enrichment: Add image and rich description to the Commerce Pro product
          try {
            console.log('[Sandbox Reset] Enriching NextBlock™ Commerce Pro...');
            const commerceLogoKey = 'images/commerce-square.webp';
            
            // 0. Get language IDs
            const [enLangRaw] = await db`SELECT id FROM public.languages WHERE code = 'en' LIMIT 1`;
            const [frLangRaw] = await db`SELECT id FROM public.languages WHERE code = 'fr' LIMIT 1`;
            const enLangId = enLangRaw?.id;
            const frLangId = frLangRaw?.id;

            // 1. Ensure media record exists for the seeded asset
            const [mediaRecord] = await db`
              INSERT INTO public.media (file_name, object_key, file_path, file_type, size_bytes)
              VALUES ('commerce-square.webp', ${commerceLogoKey}, ${commerceLogoKey}, 'image/webp', 1651652)
              ON CONFLICT (object_key) DO UPDATE SET file_path = EXCLUDED.file_path
              RETURNING id
            `;

            // 2. Find the synced product (NextBlock™ Commerce Pro)
            const [product] = await db`
              SELECT * FROM public.products 
              WHERE freemius_product_id = '24851' AND language_id = ${enLangId}
              LIMIT 1
            `;

            if (product && mediaRecord) {
              // 3. Link media to English product
              await db`
                INSERT INTO public.product_media (product_id, media_id, sort_order)
                VALUES (${product.id}, ${mediaRecord.id}, 0)
                ON CONFLICT (product_id, media_id) DO NOTHING
              `;

              // 4. Update English descriptions
              const shortDescEn = "NextBlock™ Ecommerce is an AI-native, block-based storefront engine for Next.js. Featuring a premium, developer-first aesthetic and high-performance edge rendering.";
              
              const htmlDescriptionEn = {
                type: "doc",
                content: [
                  {
                    type: "heading",
                    attrs: { level: 2 },
                    content: [{ type: "text", text: "🚀 The Future of Digital Commerce" }]
                  },
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "NextBlock™ Ecommerce bridges the gap between high-performance headless architecture and intuitive visual editing. Built on the NextBlock™ Performance Stack (NPS), it leverages Next.js 16, Supabase, and Tailwind CSS to deliver sub-millisecond latency and a seamless \"Vibe Coding\" experience."
                      }
                    ]
                  },
                  {
                    type: "heading",
                    attrs: { level: 3 },
                    content: [{ type: "text", text: "🎨 Notion-Style Editor" }]
                  },
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "Stop fighting with complex backends. Our Tiptap-powered editor provides a familiar, block-based interface that allows you to build stunning product pages as easily as writing a document."
                      }
                    ]
                  },
                  {
                    type: "heading",
                    attrs: { level: 3 },
                    content: [{ type: "text", text: "🛡️ Secure by Design" }]
                  },
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "Integrated with Freemius for cryptographic licensing and recurring billing. Features dual-layer payment strategy with Freemius MoR and native Stripe support."
                      }
                    ]
                  },
                  {
                    type: "heading",
                    attrs: { level: 3 },
                    content: [{ type: "text", text: "Key Technical Specs" }]
                  },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "⚡ ISR & Edge Caching: Sub-millisecond Time to First Byte (TTFB) globally." }]
                          }
                        ]
                      },
                      {
                        type: "listItem",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "📦 Nx Monorepo: Strictly decoupled architecture for ultimate scalability and code-splitting." }]
                          }
                        ]
                      },
                      {
                        type: "listItem",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "🖼️ AVIF Optimization: 20% smaller media payloads with native Next.js Image component integration." }]
                          }
                        ]
                      }
                    ]
                  },
                  {
                    type: "heading",
                    attrs: { level: 3 },
                    content: [{ type: "text", text: "Ready for the \"Vibe Coding\" Era" }]
                  },
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "NextBlock™ is built from the ground up to be extendable by AI Agents. Whether you're using Claude, v0, or custom GPTs, our highly typed Block SDK and Zod schema validations ensure every extension stays robust and secure."
                      }
                    ]
                  }
                ]
              };

              await db`
                UPDATE public.products 
                SET short_description = ${shortDescEn}, 
                    description_json = ${db.json(htmlDescriptionEn)},
                    product_type = 'digital',
                    payment_provider = 'freemius'
                WHERE id = ${product.id}
              `;

              // 5. Create French Version
              if (frLangId) {
                console.log('[Sandbox Reset] Creating French version of NextBlock™ Commerce Pro...');
                
                const shortDescFr = "NextBlock™ Ecommerce est un moteur de boutique basé sur des blocs et natif de l'IA pour Next.js. Doté d'une esthétique premium et d'un rendu edge haute performance.";
                
                const htmlDescriptionFr = {
                  type: "doc",
                  content: [
                    {
                      type: "heading",
                      attrs: { level: 2 },
                      content: [{ type: "text", text: "🚀 Le futur du commerce numérique" }]
                    },
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "NextBlock™ Ecommerce comble le fossé entre l'architecture headless haute performance et l'édition visuelle intuitive. Construit sur la NextBlock™ Performance Stack (NPS), il exploite Next.js 16, Supabase et Tailwind CSS pour offrir une latence de moins d'une milliseconde."
                        }
                      ]
                    },
                    {
                      type: "heading",
                      attrs: { level: 3 },
                      content: [{ type: "text", text: "🎨 Éditeur style Notion" }]
                    },
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "Arrêtez de vous battre avec des backends complexes. Notre éditeur propulsé par Tiptap offre une interface familière basée sur des blocs qui vous permet de créer de superbes pages produits aussi facilement qu'un document."
                        }
                      ]
                    },
                    {
                      type: "heading",
                      attrs: { level: 3 },
                      content: [{ type: "text", text: "🛡️ Sécurisé par conception" }]
                    },
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "Intégré avec Freemius pour les licences cryptographiques et la facturation récurrente. Stratégie de paiement à double couche avec Freemius MoR et support natif Stripe."
                        }
                      ]
                    },
                    {
                      type: "heading",
                      attrs: { level: 3 },
                      content: [{ type: "text", text: "Spécifications techniques clés" }]
                    },
                    {
                      type: "bulletList",
                      content: [
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{ type: "text", text: "⚡ ISR & Mise en cache Edge : Temps de premier octet (TTFB) inférieur à la milliseconde." }]
                            }
                          ]
                        },
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{ type: "text", text: "📦 Monorepo Nx : Architecture strictement découplée pour une évolutivité ultime." }]
                            }
                          ]
                        },
                        {
                          type: "listItem",
                          content: [
                            {
                              type: "paragraph",
                              content: [{ type: "text", text: "🖼️ Optimisation AVIF : Payloads média 20 % plus petits avec Next.js Image." }]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                };

                const [frProduct] = await db`
                  INSERT INTO public.products (
                    sku, title, slug, price, sale_price, stock, status, 
                    short_description, description_json, 
                    product_type, payment_provider,
                    language_id, translation_group_id,
                    freemius_product_id, freemius_plan_id,
                    trial_period_days, trial_requires_payment_method
                  )
                  VALUES (
                    ${product.sku}, 'NextBlock™ Commerce Pro - Licence Commerce', ${product.slug + '-fr'}, 
                    ${product.price}, ${product.sale_price}, ${product.stock || 99}, ${product.status},
                    ${shortDescFr}, ${db.json(htmlDescriptionFr)},
                    'digital', 'freemius',
                    ${frLangId}, ${product.translation_group_id},
                    ${product.freemius_product_id}, ${product.freemius_plan_id},
                    ${product.trial_period_days ?? 0}, ${product.trial_requires_payment_method ?? false}
                  )
                  ON CONFLICT ON CONSTRAINT products_language_id_slug_key DO UPDATE
                  SET
                    title = EXCLUDED.title,
                    short_description = EXCLUDED.short_description,
                    description_json = EXCLUDED.description_json,
                    product_type = EXCLUDED.product_type,
                    payment_provider = EXCLUDED.payment_provider,
                    trial_period_days = EXCLUDED.trial_period_days,
                    trial_requires_payment_method = EXCLUDED.trial_requires_payment_method
                  RETURNING id
                `;

                if (frProduct) {
                   await db`
                    INSERT INTO public.product_media (product_id, media_id, sort_order)
                    VALUES (${frProduct.id}, ${mediaRecord.id}, 0)
                    ON CONFLICT (product_id, media_id) DO NOTHING
                  `;
                }
              }
              console.log('[Sandbox Reset] Successfully enriched commerce products (EN & FR).');
            }


            // 6. Add Shop Pages & Navigation Items
            console.log('[Sandbox Reset] Adding Shop Pages and navigation items...');
            let globalShopGroupId: string | undefined;
            
            if (enLangId) {
              const langId = enLangId;
              
              // Insert Page
              const [existingPage] = await db`SELECT id, translation_group_id FROM public.pages WHERE language_id = ${langId} AND slug = 'shop'`;
              let pageId = existingPage?.id;
              globalShopGroupId = existingPage?.translation_group_id;
              
              if (!pageId) {
                const [newPage] = await db`
                  INSERT INTO public.pages (language_id, title, slug, status, meta_title, meta_description)
                  VALUES (${langId}, 'Shop Our Products', 'shop', 'published', 'Shop NextBlock™ Modules | Official Store', 'Browse official commercial modules and licenses for NextBlock CMS. Get instant access to NextBlock Commerce and Cortex AI with secure checkout.')
                  RETURNING id, translation_group_id
                `;
                pageId = newPage.id;
                globalShopGroupId = newPage?.translation_group_id;

                const heroContent = {
                  is_hero: true,
                  container_type: "full-width",
                  background: {
                    type: "theme",
                    theme: "primary"
                  },
                  responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
                  column_gap: "lg",
                  padding: { top: "xl", bottom: "xl" },
                  vertical_alignment: "center",
                  column_blocks: [
                    [
                      {
                        block_type: "heading",
                        content: {
                          level: 1,
                          text_content: "NextBlock™ Store",
                          textAlign: "center",
                          textColor: "background"
                        }
                      },
                      {
                        block_type: "text",
                        content: {
                          html_content: "<p style=\"text-align: center; color: var(--background); opacity: 0.9\">Discover our selection of official commercial add-ons and developer tools for NextBlock CMS.</p><div class='mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left'><h2 class='text-2xl font-bold text-white mb-4'>Power Up Your Web Projects</h2><p>Welcome to the official NextBlock™ digital store. Here you can purchase licenses for our premium packages, including NextBlock™ Commerce and NextBlock™ Cortex AI. Every commercial license helps fund full-time open-source development on our core CMS while giving your team advanced tools to launch high-performance websites faster.</p><p>Our premium modules are designed to feel native from day one. You get clean code that fits right into your existing NextBlock project without third-party plugins or complex configuration. When you purchase a license from our store, you receive instant access to everything you need:</p><ul class='space-y-2 list-disc pl-5'><li><strong>Full Source Code:</strong> Inspect, customize, and adapt the modules to your exact requirements.</li><li><strong>Perpetual Use:</strong> Use the software for your project with full peace of mind.</li><li><strong>Automated Updates:</strong> Enjoy smooth updates that match each new release of NextBlock and Next.js.</li><li><strong>Secure Checkout:</strong> Payments are processed safely with Stripe and Freemius with instant receipt generation.</li></ul><p>Whether you need multi-currency store features, automated sales tax calculations, or AI block generation in your editor, our modules deliver tested solutions that keep your Lighthouse scores at 100%.</p><p>All purchases include dedicated onboarding resources, detailed developer docs, and friendly technical support. If you ever run into an issue or need help wiring up a provider webhook, our core engineers are ready to assist you. We also offer a thirty-day refund policy so you can try our tools risk-free.</p><p>Have questions about license tiers, volume pricing, team seats, or custom agency usage? Contact our support team anytime. Our team is here to answer your questions and help your developers succeed. We are happy to help you pick the best plan for your company. Browse our featured products below to get started today.</p></div>"
                        }
                      }
                    ]
                  ]
                };

                const sectionContent = {
                  container_type: "container",
                  background: { type: "none" },
                  responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
                  column_gap: "none",
                  padding: { top: "xl", bottom: "xl" },
                  column_blocks: [
                    [
                      {
                        block_type: "heading",
                        content: {
                          level: 2,
                          text_content: "Featured Products",
                          textAlign: "center"
                        }
                      },
                      {
                        block_type: "product_grid",
                        content: {
                          type: "latest",
                          limit: 6
                        }
                      }
                    ]
                  ]
                };

                await db`
                  INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
                  VALUES 
                  (${pageId}, ${langId}, 'section', ${db.json(heroContent as any)}, 0),
                  (${pageId}, ${langId}, 'section', ${db.json(sectionContent as any)}, 1)
                `;
              }

              const [exists] = await db`SELECT id FROM public.navigation_items WHERE language_id = ${langId} AND url = '/shop'`;
              if (!exists) {
                await db`
                  INSERT INTO public.navigation_items (language_id, menu_key, label, url, "order")
                  VALUES (${langId}, 'HEADER', 'Shop', '/shop', 2)
                `;
              }
            }

            if (frLangId) {
              const langId = frLangId;

              // Insert French Page (keep slug 'boutique' matching original nav link)
              const [existingPage] = await db`SELECT id FROM public.pages WHERE language_id = ${langId} AND slug = 'boutique'`;
              let pageId = existingPage?.id;
              
              if (!pageId) {
                const [newPage] = await db`
                  INSERT INTO public.pages (language_id, title, slug, status, meta_title, meta_description, translation_group_id)
                  VALUES (${langId}, 'Boutique en Ligne', 'boutique', 'published', 'Boutique NextBlock™ | Modules et Licences Officielles', 'Achetez des licences et extensions officielles pour NextBlock CMS. Accédez à NextBlock Commerce et Cortex AI avec un paiement simple et sécurisé.', ${globalShopGroupId ?? null})
                  RETURNING id
                `;
                pageId = newPage.id;

                const heroContent = {
                  is_hero: true,
                  container_type: "full-width",
                  background: {
                    type: "theme",
                    theme: "primary"
                  },
                  responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
                  column_gap: "lg",
                  padding: { top: "xl", bottom: "xl" },
                  vertical_alignment: "center",
                  column_blocks: [
                    [
                      {
                        block_type: "heading",
                        content: {
                          level: 1,
                          text_content: "Boutique NextBlock™",
                          textAlign: "center",
                          textColor: "background"
                        }
                      },
                      {
                        block_type: "text",
                        content: {
                          html_content: "<p style=\"text-align: center; color: var(--background); opacity: 0.9\">Découvrez nos extensions officielles et nos outils pour développeurs conçus pour le CMS NextBlock.</p><div class='mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left'><h2 class='text-2xl font-bold text-white mb-4'>Accélérez vos projets web</h2><p>Bienvenue sur la boutique officielle de NextBlock™. Vous pouvez acheter ici des licences pour nos modules professionnels, comme NextBlock™ Commerce et NextBlock™ Cortex AI. Chaque achat aide à financer le travail open-source sur le cœur du CMS. Il donne aussi à votre équipe des outils de pointe pour créer des sites rapides et fiables.</p><p>Nos modules premium s'intègrent sans effort à votre projet existant. Vous profitez d'un code propre et bien testé, sans plugin externe lourd ni réglage complexe. En choisissant nos outils, vous profitez immédiatement de nombreux avantages :</p><ul class='space-y-2 list-disc pl-5'><li><strong>Code source complet :</strong> Lisez, adaptez et faites évoluer chaque bloc selon vos besoins métier.</li><li><strong>Licence perpétuelle :</strong> Utilisez le code sur votre projet en toute sérénité.</li><li><strong>Mises à jour suivies :</strong> Recevez les nouvelles versions au rythme de Next.js et de NextBlock.</li><li><strong>Paiement sécurisé :</strong> Les achats passent par Stripe et Freemius avec facture instantanée.</li></ul><p>Vous voulez vendre dans plusieurs devises ? Vous avez besoin du calcul automatique des taxes ? Vous voulez générer des blocs avec l'IA ? Nos modules offrent des solutions prêtes à l'emploi qui préservent vos scores Lighthouse à 100%.</p><p>Chaque commande donne accès à une documentation claire et à notre support technique. Si vous avez besoin d'aide pour brancher un webhook ou un mode de paiement, nos développeurs vous répondent rapidement. Notre équipe est à vos côtés pour vous faire gagner du temps. Nous proposons aussi une garantie satisfait ou remboursé de trente jours.</p><p>Vous avez des questions sur nos tarifs, les licences agence ou les remises en volume ? Écrivez à notre équipe à tout moment. Nous vous guiderons avec grand plaisir vers l'offre idéale pour votre entreprise. Découvrez dès aujourd'hui l'ensemble de nos produits ci-dessous pour bien démarrer votre projet.</p></div>"
                        }
                      }
                    ]
                  ]
                };

                const sectionContent = {
                  container_type: "container",
                  background: { type: "none" },
                  responsive_columns: { mobile: 1, tablet: 1, desktop: 1 },
                  column_gap: "none",
                  padding: { top: "xl", bottom: "xl" },
                  column_blocks: [
                    [
                      {
                        block_type: "heading",
                        content: {
                          level: 2,
                          text_content: "Produits Vedettes",
                          textAlign: "center"
                        }
                      },
                      {
                        block_type: "product_grid",
                        content: {
                          type: "latest",
                          limit: 6
                        }
                      }
                    ]
                  ]
                };

                await db`
                  INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
                  VALUES 
                  (${pageId}, ${langId}, 'section', ${db.json(heroContent as any)}, 0),
                  (${pageId}, ${langId}, 'section', ${db.json(sectionContent as any)}, 1)
                `;
              }

              const [exists] = await db`SELECT id FROM public.navigation_items WHERE language_id = ${langId} AND url = '/boutique'`;
              if (!exists) {
                await db`
                  INSERT INTO public.navigation_items (language_id, menu_key, label, url, "order")
                  VALUES (${langId}, 'HEADER', 'Boutique', '/boutique', 2)
                `;
              }
            }
            console.log('[Sandbox Reset] Successfully created Shop pages and navigation.');
          } catch (enrichErr: any) {
            console.error('[Sandbox Reset] Product enrichment failed:', enrichErr.message || enrichErr);
          }
          */
          } catch (syncErr: any) {
            console.error('[Sandbox Reset] Failed to sync Freemius products:', syncErr.message || syncErr);
            throw syncErr;
          }
        }
      }

      if (process.env.FREEMIUS_AI_SANDBOX_KEY) {
        const { error: cortexActivationError } = await supabaseAdmin
          .from('package_activations')
          .upsert(
            {
              package_id: CORTEX_AI_PACKAGE_ID,
              license_key: process.env.FREEMIUS_AI_SANDBOX_KEY,
              status: 'active',
              instance_name: siteUrl,
              last_validated_at: new Date().toISOString(),
            },
            { onConflict: 'license_key, package_id' }
          );

        if (cortexActivationError) {
          console.error(
            '[Sandbox Reset] Failed to activate Cortex AI package:',
            cortexActivationError.message
          );
          throw cortexActivationError;
        } else {
          console.log('[Sandbox Reset] Successfully activated Cortex AI package.');
        }
      }

      // Seed additional store data: Branding, Demo Account, and Fake Orders
      try {
        await seedFakeStoreData(db, supabaseAdmin);
        console.log('[Sandbox Reset] Successfully seeded fake store data.');
      } catch (storeSeedErr: any) {
        console.error('[Sandbox Reset] Failed to seed store data:', storeSeedErr.message || storeSeedErr);
      }
    } finally {
      await db.end();
    }

    console.log('[Sandbox Reset] Complete.');
    return NextResponse.json({ success: true, message: 'Sandbox hard reset completed successfully' });
  } catch (err: any) {
    console.error('[Sandbox Reset] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error', stack: err.stack }, { status: 500 });
  }
}
