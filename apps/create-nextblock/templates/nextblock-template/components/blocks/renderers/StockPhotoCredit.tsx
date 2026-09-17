import React from "react";
import { StockPhotoCreditPhrase } from "./StockPhotoCreditPhrase";

// Stock-photo attribution. Field names match the search_stock_photos result +
// the ImageAttribution schema; snake_case is tolerated defensively.
export type StockPhotoAttribution = {
  provider?: string | null;
  photographer?: string | null;
  photographerUrl?: string | null;
  sourceUrl?: string | null;
  downloadLocation?: string | null;
  // The operator's registered Unsplash app name, resolved from CMS settings at
  // search time and carried on the attribution — never hardcoded.
  utmSource?: string | null;
  photographer_url?: string | null;
  source_url?: string | null;
};

function isUnsplash(attribution: StockPhotoAttribution) {
  return (
    attribution.provider === "unsplash" ||
    /unsplash\.com/i.test(attribution.sourceUrl || attribution.source_url || "")
  );
}

// Unsplash requires attribution links to carry utm params identifying your app.
// Without the operator's registered app name (set in /cms/settings/cortex-ai) we
// omit utm rather than tag a wrong app — the links still work.
function buildUnsplashUtm(attribution: StockPhotoAttribution) {
  const source = attribution.utmSource?.trim();
  if (!source) {
    return null;
  }
  return `utm_source=${encodeURIComponent(source)}&utm_medium=referral`;
}

function withUtm(url: string, attribution: StockPhotoAttribution) {
  if (!url || !isUnsplash(attribution)) {
    return url;
  }
  const utm = buildUnsplashUtm(attribution);
  if (!utm) {
    return url;
  }
  return url.includes("?") ? `${url}&${utm}` : `${url}?${utm}`;
}

function resolveProvider(attribution: StockPhotoAttribution) {
  const source = attribution.sourceUrl || attribution.source_url || "";
  if (attribution.provider === "unsplash" || /unsplash\.com/i.test(source)) {
    return { home: "https://unsplash.com", name: "Unsplash" };
  }
  if (attribution.provider === "pexels" || /pexels\.com/i.test(source)) {
    return { home: "https://www.pexels.com", name: "Pexels" };
  }
  return null;
}

/**
 * The plain-text form of the credit that {@link StockPhotoCredit} renders
 * ("Photo by {photographer} on {Provider}"). Used to detect — and suppress — a
 * caption that merely duplicates the attribution credit.
 */
export function stockPhotoCreditText(
  attribution: StockPhotoAttribution | null | undefined
): string | null {
  if (!attribution) {
    return null;
  }

  const provider = resolveProvider(attribution);
  const photographer = attribution.photographer;

  if (!photographer && !provider) {
    return null;
  }

  const who = photographer || "a photographer";
  return provider ? `Photo by ${who} on ${provider.name}` : `Photo by ${who}`;
}

/**
 * True when `caption` is just an attribution credit for `attribution` (so it
 * would duplicate the rendered {@link StockPhotoCredit}). Covers the normal
 * "Photo by {name} on {Provider}" form and the no-photographer fallback that
 * search_stock_photos historically stored, "Photo on {Provider}".
 */
export function isStockPhotoCreditCaption(
  caption: string | null | undefined,
  attribution: StockPhotoAttribution | null | undefined
): boolean {
  const text = (caption || "").trim().toLowerCase();
  if (!text) {
    return false;
  }

  const credit = stockPhotoCreditText(attribution);
  if (credit && text === credit.toLowerCase()) {
    return true;
  }

  const provider = resolveProvider(attribution || {});
  return Boolean(provider && text === `photo on ${provider.name.toLowerCase()}`);
}

/**
 * Renders "Photo by {photographer} on {Provider}" with the photographer's profile
 * and the provider properly linked — satisfying the Unsplash API attribution
 * requirement (also shown for Pexels as a courtesy). Renders nothing without a
 * usable attribution.
 */
export function StockPhotoCredit({
  attribution,
  className,
}: {
  attribution: StockPhotoAttribution | null | undefined;
  className?: string;
}) {
  if (!attribution) {
    return null;
  }

  const photographer = attribution.photographer;
  const photographerUrl = attribution.photographerUrl || attribution.photographer_url;
  const sourceUrl = attribution.sourceUrl || attribution.source_url;
  const provider = resolveProvider(attribution);

  if (!photographer && !provider) {
    return null;
  }

  const linkClass = "underline underline-offset-2 hover:opacity-80";

  return (
    <span className={className}>
      <StockPhotoCreditPhrase part="by" />{" "}
      {photographer ? (
        photographerUrl ? (
          <a
            href={withUtm(photographerUrl, attribution)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={linkClass}
          >
            {photographer}
          </a>
        ) : (
          photographer
        )
      ) : (
        <StockPhotoCreditPhrase part="anonymous" />
      )}
      {provider ? (
        <>
          {" "}
          <StockPhotoCreditPhrase part="on" />{" "}
          <a
            href={withUtm(sourceUrl || provider.home, attribution)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={linkClass}
          >
            {provider.name}
          </a>
        </>
      ) : null}
    </span>
  );
}
