import { ImageResponse } from 'next/og';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_STOREFRONT_COPY,
  AFFILIATE_PARTNERS_PATH,
  affiliateTierDisplayName,
  type AffiliateBadgeColor,
} from '@nextblock-cms/affiliates';
import { getServerAffiliatesCopy } from '../../../../lib/affiliates/server-copy';
import { composeTitleWithSite } from '../../../lib/seo';
import { getSiteSettings } from '../../../lib/site-settings';
import { loadStorefrontCardAvatar } from '../_components/storefront-card-avatar';
import { loadAffiliateStorefrontPage } from '../_components/storefront-loader';
import { resolveAffiliateStorefrontTitle } from '../_components/storefront-metadata';

/**
 * The social card of `/partners/<handle>` (1200×630 PNG): display name, handle, tier badge and site
 * name, the tier and tagline in the partner's language when the approved snapshot names it (the
 * page's `og:locale`). The page's metadata names no image (ADDENDUM C5), so this is the only one;
 * its alt text comes from `generateImageMetadata`. The avatar comes from `loadStorefrontCardAvatar`
 * (the deployment's own media origin only, bounded fetch); without it the card draws initials. 404
 * when the package is off or nothing is published.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** The one card's id: its URL is `/partners/<handle>/opengraph-image-<hash>/card`. */
const STOREFRONT_CARD_IMAGE_ID = 'card';

/** Badge colours for the card (Satori takes inline styles, not Tailwind classes). */
const CARD_BADGE_COLORS: Readonly<Record<AffiliateBadgeColor, { background: string; text: string }>> = {
  violet: { background: '#ede9fe', text: '#4c1d95' },
  indigo: { background: '#e0e7ff', text: '#312e81' },
  blue: { background: '#dbeafe', text: '#1e3a8a' },
  sky: { background: '#e0f2fe', text: '#0c4a6e' },
  emerald: { background: '#d1fae5', text: '#064e3b' },
  amber: { background: '#fef3c7', text: '#78350f' },
  orange: { background: '#ffedd5', text: '#7c2d12' },
  rose: { background: '#ffe4e6', text: '#881337' },
  slate: { background: '#f1f5f9', text: '#0f172a' },
};

const OG_COPY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_STOREFRONT_COPY };

function plainResponse(status: 404 | 503): Response {
  return new Response(status === 404 ? 'Not found' : 'Unavailable', {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function shorten(value: string, max: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= max ? characters.join('') : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return '';
  }
}

/**
 * The card's metadata, so `og:image:alt` (and `twitter:image:alt`, which Next copies from Open Graph)
 * describes it: the social title, i.e. the page title with the site name, exactly as `og:title`. No
 * entry when nothing is published (the page names no card then, and the card URL answers 404). A
 * failed storefront read throws, as it does for the page: an outage is never answered "no card".
 * Next 16 passes `params` here as a plain object (the image function gets promises).
 */
export async function generateImageMetadata({ params }: { params?: { handle?: string } }) {
  const page = await loadAffiliateStorefrontPage(typeof params?.handle === 'string' ? params.handle : '');
  if (!page) return [];

  const [t, settings] = await Promise.all([
    getServerAffiliatesCopy({ locale: page.siteLocale, dictionary: OG_COPY }),
    getSiteSettings().catch(() => ({ siteTitle: '' })),
  ]);
  const title = resolveAffiliateStorefrontTitle({
    displayName: page.storefront.profile.display_name,
    title: page.storefront.title,
    t,
  });
  return [{ id: STOREFRONT_CARD_IMAGE_ID, alt: composeTitleWithSite(title, settings.siteTitle), size, contentType }];
}

export default async function Image({ params }: { params: Promise<{ handle: string }>; id?: Promise<string | number> }) {
  const { handle: rawHandle } = await params;
  let page: Awaited<ReturnType<typeof loadAffiliateStorefrontPage>>;
  try {
    page = await loadAffiliateStorefrontPage(rawHandle);
  } catch {
    return plainResponse(503);
  }
  if (!page) return plainResponse(404);

  const { storefront, handle, siteLocale, siteUrl } = page;
  // The partner's language when the approved snapshot names it (the page's og:locale): a social
  // crawler sends no language preference, so the visitor's language would be the site default.
  const cardLocale = storefront.profile.locale ?? siteLocale;
  const [t, settings, avatar] = await Promise.all([
    getServerAffiliatesCopy({ locale: cardLocale, dictionary: OG_COPY }),
    getSiteSettings().catch(() => ({ siteTitle: '' })),
    loadStorefrontCardAvatar(storefront.profile.avatar_object_key),
  ]);

  const displayName = shorten(storefront.profile.display_name, 48);
  const nameLength = Array.from(displayName).length;
  const nameSize = nameLength <= 22 ? 76 : nameLength <= 34 ? 60 : 48;
  const tierName = shorten(
    affiliateTierDisplayName({ name: storefront.tier.name, name_translations: storefront.tier.nameTranslations }, cardLocale),
    40,
  );
  const badge = CARD_BADGE_COLORS[storefront.tier.badgeColor] ?? CARD_BADGE_COLORS.violet;
  const address = shorten(`${siteHost(siteUrl)}${AFFILIATE_PARTNERS_PATH}/${handle}`, 60);
  const siteName = shorten(settings.siteTitle || siteHost(siteUrl), 48);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #334155 100%)',
          color: '#f8fafc',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 56 }}>
          {avatar ? (
            // Satori draws <img> elements; next/image does not apply to a generated PNG.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt=""
              width={240}
              height={240}
              style={{ width: 240, height: 240, borderRadius: 9999, objectFit: 'cover', border: '6px solid #f8fafc' }}
            />
          ) : (
            <div
              style={{
                width: 240,
                height: 240,
                borderRadius: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: badge.background,
                color: badge.text,
                fontSize: 96,
                fontWeight: 700,
              }}
            >
              {initialsOf(displayName)}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 20 }}>
            <div style={{ display: 'flex', fontSize: nameSize, fontWeight: 700, lineHeight: 1.1 }}>{displayName}</div>
            <div style={{ display: 'flex', fontSize: 30, color: '#cbd5e1' }}>{address}</div>
            <div style={{ display: 'flex' }}>
              <div
                style={{
                  display: 'flex',
                  padding: '10px 24px',
                  borderRadius: 9999,
                  background: badge.background,
                  color: badge.text,
                  fontSize: 28,
                  fontWeight: 700,
                }}
              >
                {tierName}
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 30 }}>
          <div style={{ display: 'flex', fontWeight: 700 }}>{t('affiliates.storefront.og_tagline')}</div>
          <div style={{ display: 'flex', color: '#cbd5e1' }}>{siteName}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
