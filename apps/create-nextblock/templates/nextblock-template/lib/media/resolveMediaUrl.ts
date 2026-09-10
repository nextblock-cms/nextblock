const BUNDLED_PUBLIC_MEDIA_KEYS = new Set([
  'images/NBcover.webp',
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

export function resolveMediaUrl(
  objectKey?: string | null,
  // On the client, NEXT_PUBLIC_R2_BASE_URL is inlined at build time, so a fresh-clone
  // dev bundle built with no env holds an empty string; fall back to the runtime value
  // injected by <PublicEnvBootstrap> (window.__NEXTBLOCK_PUBLIC_ENV__.r2Base). On the
  // server, process.env is always current and the window branch is skipped.
  baseUrl = process.env.NEXT_PUBLIC_R2_BASE_URL ||
    (typeof window !== 'undefined'
      ? (window as { __NEXTBLOCK_PUBLIC_ENV__?: { r2Base?: string } })
          .__NEXTBLOCK_PUBLIC_ENV__?.r2Base || ''
      : '')
) {
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

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const normalizedObjectKey = objectKey.replace(/^\/+/, '');

  return normalizedBaseUrl
    ? `${normalizedBaseUrl}/${normalizedObjectKey}`
    : `/${normalizedObjectKey}`;
}
