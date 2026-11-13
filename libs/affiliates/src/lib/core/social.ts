/**
 * `affiliate_profiles.social_links` sanitizer. Partners author these, so every value is
 * untrusted: only known networks, https only, no credentials or ports, and the host must be
 * the network's own (any https host for `website`). Pure, client-safe, never throws.
 */
import { AFFILIATE_SOCIAL_NETWORKS } from './constants';
import type { AffiliateSocialLinks, AffiliateSocialNetwork } from './types';

export const AFFILIATE_SOCIAL_LINK_MAX_LENGTH = 300;

const NETWORK_HOSTS: Readonly<Record<Exclude<AffiliateSocialNetwork, 'website'>, readonly string[]>> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  facebook: ['facebook.com'],
  pinterest: ['pinterest.com'],
  linkedin: ['linkedin.com'],
};

// Whitespace, control characters and backslashes never belong in a link a partner pastes;
// refusing them up front keeps the WHATWG parser's lenient rewrites (`\` → `/`) out of play.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f\\]/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostAllowed(network: AffiliateSocialNetwork, hostname: string): boolean {
  if (network === 'website') {
    // Any public-looking https host: a dot, not an IP literal.
    return hostname.includes('.') && !IPV4_HOST.test(hostname) && !hostname.startsWith('[');
  }

  return NETWORK_HOSTS[network].some((host) => hostname === host || hostname === `www.${host}`);
}

/** The normalized https URL for `network`, or null when the value is not acceptable. */
export function sanitizeAffiliateSocialUrl(network: AffiliateSocialNetwork, value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const raw = value.trim();

  if (!raw || raw.length > AFFILIATE_SOCIAL_LINK_MAX_LENGTH || FORBIDDEN_CHARACTERS.test(raw)) {
    return null;
  }

  // "instagram.com/jane" is accepted as https; any other explicit scheme must be https.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : raw.startsWith('/') ? null : `https://${raw}`;

  if (!candidate) return null;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();

  if (!hostname || !hostAllowed(network, hostname)) {
    return null;
  }

  const normalized = url.toString();

  return normalized.length <= AFFILIATE_SOCIAL_LINK_MAX_LENGTH ? normalized : null;
}

/**
 * Keep only the known networks whose values pass {@link sanitizeAffiliateSocialUrl}; anything
 * else (unknown keys, non-strings, javascript:/http:/data: URLs, foreign hosts) is dropped.
 */
export function sanitizeAffiliateSocialLinks(input: unknown): AffiliateSocialLinks {
  const links: AffiliateSocialLinks = {};

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return links;
  }

  const source = input as Record<string, unknown>;

  for (const network of AFFILIATE_SOCIAL_NETWORKS) {
    if (!Object.prototype.hasOwnProperty.call(source, network)) continue;

    const url = sanitizeAffiliateSocialUrl(network, source[network]);

    if (url) links[network] = url;
  }

  return links;
}
