import {
  ORIGINAL_UPLOAD_VARIANT_LABEL,
  pickOriginalUploadObjectKey,
  type MediaWithVariants,
} from '../media/original-upload';

// Pure, dependency-free rendering of the transactional-email brand header. Kept separate
// from branding.ts (which is `server-only` and hits the DB) so this string logic — the
// part worth unit-testing — imports nothing server-side and runs anywhere.

// Tenant branding used to white-label every transactional email.
//   - logoUrl  — an ABSOLUTE, email-safe logo URL, or `null` when none is configured.
//   - siteName — the site name, used as the logo `alt` text and the no-logo text banner.
export interface EmailBranding {
  logoUrl: string | null;
  siteName: string;
}

/**
 * Marker an app-rendered email template drops where the brand header belongs.
 * `applyEmailBranding` swaps it for the resolved logo (or text banner). This is a plain
 * literal — NOT a Supabase/GoTrue `{{ .Var }}` merge tag — because it is substituted by
 * our own nodemailer pipeline, never by Supabase.
 */
export const EMAIL_BRAND_HEADER_TOKEN = '{{brand_header}}';

/** Hard width cap so an oversized custom logo can't blow out Gmail/Outlook layouts. */
export const EMAIL_LOGO_MAX_WIDTH = 150;

// The pre-white-label hardcoded logo. The app templates no longer embed it, but any stray
// occurrence in an outbound email is swapped for the tenant header defensively.
const LEGACY_LOGO_IMG_RE =
  /<img\b[^>]*\bsrc=["'][^"']*nextblock-logo-small\.webp["'][^>]*>/gi;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the branded header block: an email-safe logo `<img>` (hard-capped at 150px so a
 * large custom logo can't break the layout) when a logo exists, otherwise a clean, styled
 * text banner showing the site name.
 */
export function renderEmailBrandHeader(branding: EmailBranding): string {
  const name = escapeHtml(branding.siteName);

  if (branding.logoUrl) {
    const src = escapeHtml(branding.logoUrl);
    return (
      '<div style="text-align:center;padding:0 0 24px;">' +
      `<img src="${src}" alt="${name}" width="${EMAIL_LOGO_MAX_WIDTH}" ` +
      `style="display:block;margin:0 auto;width:${EMAIL_LOGO_MAX_WIDTH}px;` +
      'max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />' +
      '</div>'
    );
  }

  // No logo → strip the image entirely and fall back to a text banner with the site name.
  return (
    '<div style="text-align:center;padding:0 0 24px;">' +
    '<span style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,' +
    "'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;line-height:1.2;" +
    `font-weight:700;color:#0f172a;letter-spacing:-0.01em;">${name}</span>` +
    '</div>'
  );
}

/**
 * Intercept a fully-rendered email body and apply tenant branding:
 *   1. Replace the `{{brand_header}}` token (used by our app-rendered templates).
 *   2. Defensively swap any stray hardcoded legacy NextBlock logo `<img>` for the header.
 * Purely a string transform so it is trivially unit-testable and side-effect free.
 */
export function applyEmailBranding(html: string, branding: EmailBranding): string {
  const header = renderEmailBrandHeader(branding);
  let out = html;
  if (out.includes(EMAIL_BRAND_HEADER_TOKEN)) {
    out = out.split(EMAIL_BRAND_HEADER_TOKEN).join(header);
  }
  out = out.replace(LEGACY_LOGO_IMG_RE, header);
  return out;
}

// The subset of a media row the email logo resolver needs.
export type LogoMediaLike = MediaWithVariants;

/**
 * Pick the storage key to use for a logo IN EMAIL.
 *
 * The image pipeline stores the AVIF derivative as `object_key` — that's what the website
 * (navbar, blocks) renders for performance — and keeps the ORIGINAL uploaded file among
 * `variants` under the label `original_uploaded`. Email clients, Outlook especially, can't
 * render AVIF (or WebP), so for email we prefer that untouched original. Fall back to
 * `object_key`/`file_path` only when no original variant was kept (e.g. the seeded default
 * logo, which has no variants). This keeps the site on AVIF while email uses the original.
 *
 * The selection itself now lives in `lib/media/original-upload.ts`, because social
 * link-preview crawlers need exactly the same thing; this stays as the email-facing name.
 */
export function pickEmailLogoObjectKey(media: LogoMediaLike | null | undefined): string | null {
  return pickOriginalUploadObjectKey(media);
}

/** Re-exported so existing email/media callers keep one import site. */
export { ORIGINAL_UPLOAD_VARIANT_LABEL };
