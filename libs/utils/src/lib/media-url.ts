/**
 * Display URLs for media rows, in the browser and on the server.
 *
 * A media row's `object_key` (`file_path` on older rows) is normally a key in the storage bucket,
 * served from the public media base: `NEXT_PUBLIC_R2_BASE_URL`, which next.config.js inlines with
 * Supabase Storage's public endpoint on a zero-key Supabase deploy. A few keys are not in the
 * bucket at all. The seeded demo content, the sandbox reset and migration 02032 (the Affiliates
 * license products) point media rows at files bundled with the app in
 * `apps/nextblock/public/images`, which it serves from `/images/…`. Joining one of those keys to
 * the bucket base gives a broken image, so every display URL goes through `resolveMediaUrl`,
 * never `${base}/${key}` by hand. `tools/scripts/media-url-builders.test.ts` fails on a source
 * file that reads the base outside this module and the config plumbing it allowlists.
 *
 * Client-safe: no Node, Supabase or server-only imports. It lives in this lib because
 * `libs/ecommerce` needs the same check and a lib may never import the app; the app re-exports it
 * as `apps/nextblock/lib/media/resolveMediaUrl.ts`.
 */

/**
 * Object keys of the files bundled in `apps/nextblock/public/images`, served from `/images/…`
 * whatever the storage backend. Add a key when a migration, the seed or the sandbox reset points a
 * media row at a new bundled file (`apps/nextblock/lib/media/resolveMediaUrl.test.ts` fails on a
 * key with no file behind it).
 */
export const BUNDLED_PUBLIC_MEDIA_KEYS: ReadonlySet<string> = new Set([
  'images/NBcover.webp',
  // The sandbox demo partner's avatar (app/api/cron/reset-sandbox/affiliate-demo.ts).
  'images/affiliate-demo-avatar.png',
  // The Affiliates license cover (migration 02032 on nextblock.dev, the sandbox reset).
  'images/affiliates-square.webp',
  'images/cap.webp',
  'images/commerce-plan.webp',
  'images/commerce-square.webp',
  'images/commerce-wide.webp',
  'images/cortex-ai-square.webp',
  'images/cortex-ai.webp',
  'images/cortex_post.webp',
  'images/developer.webp',
  'images/extensibility.webp',
  'images/goals.webp',
  'images/included.webp',
  'images/metadata_image.webp',
  'images/nextblock-logo-small.webp',
  'images/nextblock-logo-button-tiny.png',
  'images/nx-graph.webp',
  'images/pants.webp',
  'images/programmer-upscaled.webp',
  'images/t-shirt.webp',
  'images/update_nextblock.webp',
]);

/** Whether the key names a file bundled with the app rather than an object in the bucket. */
export function isBundledPublicMediaKey(objectKey: string | null | undefined): boolean {
  return typeof objectKey === 'string' && BUNDLED_PUBLIC_MEDIA_KEYS.has(objectKey);
}

/**
 * The public media base that storage keys are joined to, or '' when none is configured.
 *
 * On the client, NEXT_PUBLIC_R2_BASE_URL is inlined at build time, so a fresh-clone dev bundle
 * built with no env holds an empty string; fall back to the runtime value injected by
 * <PublicEnvBootstrap> (window.__NEXTBLOCK_PUBLIC_ENV__.r2Base). On the server, process.env is
 * always current and the window branch is skipped. Server code that must derive Supabase
 * Storage's endpoint at runtime uses the app's `resolveMediaBaseUrl()` (lib/storage/provider.ts).
 */
export function getPublicMediaBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_R2_BASE_URL ||
    (typeof window !== 'undefined'
      ? (window as { __NEXTBLOCK_PUBLIC_ENV__?: { r2Base?: string } }).__NEXTBLOCK_PUBLIC_ENV__
          ?.r2Base || ''
      : '')
  );
}

/**
 * Supabase Storage's public endpoint for the `media` bucket, or '' without a project URL. Code that
 * used to build that URL by hand when no public media base was configured falls back to it through
 * `resolveMediaUrlWithSupabaseFallback`.
 */
export function getSupabaseMediaBaseUrl(
  supabaseUrl: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL
): string {
  const projectUrl = (supabaseUrl || '').trim().replace(/\/+$/, '');
  return projectUrl ? `${projectUrl}/storage/v1/object/public/media` : '';
}

/**
 * The URL a media row's key displays from, or null without a key:
 * - an absolute http(s) URL, or a root-relative path, as it is;
 * - a bundled key (BUNDLED_PUBLIC_MEDIA_KEYS) as `/images/…`, whatever the base;
 * - any other key joined to `baseUrl` (default: getPublicMediaBaseUrl()), or as the relative
 *   `/${key}` when there is no base.
 */
export function resolveMediaUrl(
  objectKey?: string | null,
  baseUrl: string | null = getPublicMediaBaseUrl()
): string | null {
  if (!objectKey) return null;

  if (objectKey.startsWith('http://') || objectKey.startsWith('https://')) {
    return objectKey;
  }

  if (objectKey.startsWith('/')) {
    return objectKey;
  }

  if (BUNDLED_PUBLIC_MEDIA_KEYS.has(objectKey)) {
    return `/${objectKey}`;
  }

  const normalizedBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const normalizedObjectKey = objectKey.replace(/^\/+/, '');

  return normalizedBaseUrl
    ? `${normalizedBaseUrl}/${normalizedObjectKey}`
    : `/${normalizedObjectKey}`;
}

/**
 * `resolveMediaUrl` against the public media base, else Supabase Storage's public `media` bucket
 * when no base is configured: the fallback the storefront's product images, the shop's variant,
 * invoice and avatar URLs used before they shared this module. A bundled key still resolves to
 * `/images/…`.
 */
export function resolveMediaUrlWithSupabaseFallback(objectKey?: string | null): string | null {
  return resolveMediaUrl(objectKey, getPublicMediaBaseUrl() || getSupabaseMediaBaseUrl());
}
