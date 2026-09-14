//@ts-check

const fs = require('node:fs');
const path = require('node:path');

const shouldEnableVercelToolbarPlugin =
  process.env.NEXTBLOCK_VERCEL_TOOLBAR_ENABLED === 'true';

function ensureVercelToolbarProjectJson() {
  const vercelDir = path.join(process.cwd(), '.vercel');
  const projectJsonPath = path.join(vercelDir, 'project.json');
  const repoJsonPath = path.join(vercelDir, 'repo.json');

  if (fs.existsSync(projectJsonPath) || !fs.existsSync(repoJsonPath)) {
    return;
  }

  try {
    const repo = JSON.parse(fs.readFileSync(repoJsonPath, 'utf8'));
    const appDirectory = path
      .relative(process.cwd(), __dirname)
      .replaceAll(path.sep, '/');
    const project =
      repo.projects?.find(
        /** @param {{ directory?: string }} candidate */
        (candidate) =>
          candidate.directory === '.' ||
          candidate.directory === '' ||
          candidate.directory === appDirectory
      ) ?? repo.projects?.[0];

    if (!project?.id || !project?.orgId) {
      return;
    }

    fs.writeFileSync(
      projectJsonPath,
      `${JSON.stringify({ orgId: project.orgId, projectId: project.id }, null, 2)}\n`
    );
  } catch {
    // The Toolbar plugin will print its normal setup guidance if linking is incomplete.
  }
}

if (shouldEnableVercelToolbarPlugin) {
  ensureVercelToolbarProjectJson();
}

/**
 * @typedef {{ protocol?: 'http' | 'https'; hostname: string; port?: string; pathname?: string }} RemotePattern
 */

const securityHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
];

// Self-hosted Docker images build a standalone server (`node apps/nextblock/server.js`) instead
// of `next start` + a full node_modules tree. Gated on DOCKER_BUILD so Vercel/cloud builds are
// completely untouched. outputFileTracingRoot is pinned to the monorepo root so the standalone
// output nests predictably under apps/nextblock (see the root Dockerfile runner stage).
const isDockerStandalone = process.env.DOCKER_BUILD === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDockerStandalone
    ? { output: 'standalone', outputFileTracingRoot: path.join(__dirname, '../../') }
    : {}),
  // Dev-only: origins the dev server trusts for internal requests (HMR websocket,
  // dev runtime). Without this, browsing via a non-default host like 127.0.0.1 or a
  // *.localhost subdomain makes Next 16 reject the ws://.../_next/webpack-hmr handshake,
  // which stalls client hydration (the header auth/search/cart controls never mount).
  // Inert in production. Add any extra dev hosts you browse from here.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  experimental: {
    optimizePackageImports: ['@nextblock-cms/ui', '@nextblock-cms/utils'],
  },
  env: {
    // Bridge every alias the Vercel Supabase integration may inject into the public
    // vars the app + browser client read, so the build inlines a value whichever copy
    // is present. The Marketplace integration injects the new publishable key
    // (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) rather than the legacy anon key — without
    // this bridge the client bundle would ship an empty anon key. Keep the alias order
    // in sync with apps/nextblock/lib/setup/env-status.ts.
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY,
    // On a zero-key Supabase deploy, media is served from Supabase Storage's public
    // object endpoint — inline that as the base URL so every resolveMediaUrl() display
    // call site works with no manual storage config (see lib/storage/provider.ts).
    NEXT_PUBLIC_R2_BASE_URL:
      process.env.NEXT_PUBLIC_R2_BASE_URL || computeSupabaseMediaBaseUrl(),
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384, 512],
    deviceSizes: [320, 480, 640, 750, 828, 1080, 1200, 1440, 1920, 2048, 2560],
    qualities: [60, 75],
    minimumCacheTTL: 31_536_000,
    dangerouslyAllowSVG: false,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: getRemotePatterns(),
  },
  compiler: {
    // Keep operational failures visible in deployed function logs.
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
  turbopack: {
    // Work around Turbopack subpath resolution for the latest y-protocols package.
    resolveAlias: {
      'y-protocols/awareness': 'y-protocols/awareness.js',
    },
  },
  transpilePackages: [
    '@nextblock-cms/utils',
    '@nextblock-cms/ui',
    '@nextblock-cms/editor',
  ],
  async headers() {
    const headers = [...securityHeaders];
    if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
      headers.push({
        key: 'X-Robots-Tag',
        value: 'noindex',
      });
    }
    return [
      {
        source: '/:path*',
        headers,
      },
    ];
  },
};

/** @type {typeof import('@vercel/toolbar/plugins/next').withVercelToolbar} */
const withVercelToolbar = require('@vercel/toolbar/plugins/next').withVercelToolbar;

module.exports = shouldEnableVercelToolbarPlugin
  ? withVercelToolbar()(nextConfig)
  : nextConfig;

/**
 * Mirror of lib/storage/provider.ts resolveMediaBaseUrl() for the native Supabase backend,
 * in CJS so it can run at build time. Returns undefined unless this is a zero-S3-key
 * Supabase deploy (no R2 keys, a connected Supabase project), in which case it returns
 * Supabase Storage's public object endpoint for the media bucket.
 * @returns {string | undefined}
 */
function computeSupabaseMediaBaseUrl() {
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) return undefined;
  const explicit = (process.env.STORAGE_PROVIDER || '').toLowerCase();
  if (explicit && explicit !== 'supabase') return undefined;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const hasSecret =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !hasSecret) return undefined;
  const bucket = process.env.STORAGE_BUCKET || process.env.R2_BUCKET_NAME || 'media';
  return `${url.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}`;
}

function getRemotePatterns() {
  /** @type {RemotePattern[]} */
  const patterns = [];

  // Well-known media/storage providers, allowlisted by wildcard. next.config.js is
  // evaluated once at server start and is NOT re-read when .env.local changes, so on a
  // fresh install (the /setup wizard writes the R2/storage env at runtime) the exact
  // env-derived hosts below would be missing until a dev-server restart — which made
  // next/image hard-crash with "hostname ... is not configured". These static patterns
  // cover the common buckets (Cloudflare R2 public + S3 endpoints, Supabase Storage)
  // regardless of env timing. Custom domains are still picked up from env below.
  patterns.push(
    { protocol: 'https', hostname: '**.r2.dev', pathname: '/**' },
    { protocol: 'https', hostname: '**.r2.cloudflarestorage.com', pathname: '/**' },
    { protocol: 'https', hostname: '**.supabase.co', pathname: '/**' },
    // YouTube poster frames for the click-to-play facade
    // (components/media/YouTubeFacade.tsx). Serving them through the optimizer
    // turns a ~205 KiB third-party JPEG with a 2h TTL into a same-origin
    // AVIF/WebP at the displayed size — the facade poster is frequently the LCP.
    { protocol: 'https', hostname: 'i.ytimg.com', pathname: '/vi/**' },
    { protocol: 'https', hostname: 'img.youtube.com', pathname: '/vi/**' },
  );

  // Add R2 Bucket URL if authenticated
  if (process.env.NEXT_PUBLIC_R2_PUBLIC_URL) {
    try {
      const parsed = new URL(process.env.NEXT_PUBLIC_R2_PUBLIC_URL);
      patterns.push({
        protocol: parsed.protocol === 'https:' ? 'https' : 'http',
        hostname: parsed.hostname,
        pathname: '/**',
      });
    } catch {
      // ignore malformed value
    }
  }

  // Add R2 Custom Domain URL
  if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
    try {
      const parsed = new URL(process.env.NEXT_PUBLIC_R2_BASE_URL);
      patterns.push({
        protocol: parsed.protocol === 'https:' ? 'https' : 'http',
        hostname: parsed.hostname,
        pathname: '/**',
      });
    } catch {
      // ignore malformed value
    }
  }

  // Add General Public URL
  if (process.env.NEXT_PUBLIC_URL) {
    try {
      const parsed = new URL(process.env.NEXT_PUBLIC_URL);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        patterns.push({
          protocol: parsed.protocol === 'https:' ? 'https' : 'http',
          hostname: parsed.hostname,
          pathname: '/**',
        });
      }
    } catch {
      // ignore malformed value
    }
  }

  return patterns;
}
