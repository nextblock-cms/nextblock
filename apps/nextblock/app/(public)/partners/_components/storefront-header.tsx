import { ExternalLink } from 'lucide-react';
import {
  AFFILIATE_SOCIAL_NETWORKS,
  type AffiliateBadgeColor,
  type AffiliateSocialLinks,
  type AffiliateSocialNetwork,
  type AffiliatesCopyTranslate,
} from '@nextblock-cms/affiliates';
import { AffiliateTierBadge } from '../../../../components/affiliates/public/tier-badge';

/**
 * The partner header of `/partners/<handle>`: avatar, display name (the page's only h1), tier badge,
 * bio, social links and the affiliate disclosure, all from the APPROVED profile snapshot. Pure
 * server component; text renders as React text (escaped), the bio keeps its line breaks.
 */

/** Brand names are the same in every language; only "Website" is translated. */
const NETWORK_NAMES: Readonly<Record<Exclude<AffiliateSocialNetwork, 'website'>, string>> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  facebook: 'Facebook',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
};

export interface StorefrontHeaderProps {
  t: AffiliatesCopyTranslate;
  displayName: string;
  /** A validated URL on an allowed image origin, or a site path; null shows the initials. */
  avatarUrl: string | null;
  tierName: string;
  tierBadgeColor: AffiliateBadgeColor;
  bio: string | null;
  socialLinks: AffiliateSocialLinks;
  /**
   * The language the partner wrote the bio in, set only when it differs from the page's language
   * (WCAG 3.1.2): the chrome around it follows the visitor.
   */
  contentLang?: string;
}

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('');
  return letters.toUpperCase() || '?';
}

function networkName(t: AffiliatesCopyTranslate, network: AffiliateSocialNetwork): string {
  return network === 'website' ? t('affiliates.storefront.social_website') : NETWORK_NAMES[network];
}

export function StorefrontHeader({ t, displayName, avatarUrl, tierName, tierBadgeColor, bio, socialLinks, contentLang }: StorefrontHeaderProps) {
  const links = AFFILIATE_SOCIAL_NETWORKS.flatMap((network) => {
    const href = socialLinks[network];
    return typeof href === 'string' && href ? [{ network, href }] : [];
  });

  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-start">
      {avatarUrl ? (
        // A plain <img>, as in the storefront renderer: the avatar host is the partner media
        // origin (checked against the allow-list), which next/image may not be configured for.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          width={112}
          height={112}
          decoding="async"
          className="h-28 w-28 shrink-0 rounded-full border border-border object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-3xl font-semibold text-foreground"
        >
          {initialsOf(displayName)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="break-words text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{displayName}</h1>
        <p className="mt-3">
          <AffiliateTierBadge color={tierBadgeColor} srLabel={t('affiliates.storefront.tier_label')}>
            {tierName}
          </AffiliateTierBadge>
        </p>
        {bio ? (
          <p lang={contentLang} className="mt-4 max-w-3xl whitespace-pre-line break-words leading-7 text-foreground">
            {bio}
          </p>
        ) : null}
        {links.length > 0 ? (
          <nav aria-label={t('affiliates.storefront.social_nav_label', { name: displayName })} className="mt-4">
            <ul className="flex flex-wrap gap-2">
              {links.map(({ network, href }) => (
                <li key={network}>
                  <a
                    href={href}
                    rel="nofollow ugc noopener noreferrer"
                    target="_blank"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-sm font-medium text-foreground ring-offset-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {networkName(t, network)}
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                    <span className="sr-only">{` ${t('affiliates.storefront.opens_new_tab')}`}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <p className="mt-6 max-w-3xl rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground">
          {t('affiliates.storefront.disclosure', { name: displayName })}
        </p>
      </div>
    </header>
  );
}
