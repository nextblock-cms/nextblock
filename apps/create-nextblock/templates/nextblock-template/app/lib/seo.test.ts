import { describe, expect, it } from "vitest";
import {
  buildCanonicalUrl,
  buildSocialMetadata,
  DEFAULT_OG_IMAGE,
  DEFAULT_OG_IMAGE_HEIGHT,
  DEFAULT_OG_IMAGE_WIDTH,
  extractIntroExcerptFromBlocks,
  resolveMetaTitle,
  resolvePageMetaDescription,
  resolvePostMetaDescription,
  resolveProductMetaDescription,
  stringifyJsonLd,
} from "./seo";

describe("seo helpers", () => {
  it("uses manual title only when it contains text", () => {
    expect(resolveMetaTitle("  Custom SEO Title  ", "Fallback Title")).toBe("Custom SEO Title");
    expect(resolveMetaTitle("   ", "Fallback Title")).toBe("Fallback Title");
  });

  it("resolves page descriptions from the first meaningful paragraph", () => {
    const blocks = [
      {
        block_type: "text",
        content: {
          html_content: "<h1>Hero heading</h1>",
        },
      },
      {
        block_type: "text",
        content: {
          html_content:
            "<p>NextBlock gives teams a fast CMS foundation with editable content, commerce, and production-ready metadata.</p>",
        },
      },
    ];

    expect(extractIntroExcerptFromBlocks(blocks)).toBe(
      "NextBlock gives teams a fast CMS foundation with editable content, commerce, and production-ready metadata."
    );
    expect(resolvePageMetaDescription(null, blocks)).toBe(
      "NextBlock gives teams a fast CMS foundation with editable content, commerce, and production-ready metadata."
    );
  });

  it("uses type-specific description fallbacks", () => {
    expect(resolvePostMetaDescription(null, "Post subtitle")).toBe("Post subtitle");
    expect(resolveProductMetaDescription(null, "<p>Short product description.</p>")).toBe(
      "Short product description."
    );
  });

  it("escapes JSON-LD closing tags", () => {
    expect(stringifyJsonLd({ name: "</script>" })).toContain("\\u003c/script>");
  });
});

describe("buildCanonicalUrl", () => {
  const siteUrl = "https://example.com";

  it("self-references when there is no override", () => {
    expect(buildCanonicalUrl(null, siteUrl, "/about")).toBe("https://example.com/about");
    expect(buildCanonicalUrl("", siteUrl, "/about")).toBe("https://example.com/about");
    expect(buildCanonicalUrl("   ", siteUrl, "/about")).toBe("https://example.com/about");
  });

  it("uses an absolute override verbatim (cross-domain allowed)", () => {
    expect(buildCanonicalUrl("https://other.com/x", siteUrl, "/about")).toBe("https://other.com/x");
    expect(buildCanonicalUrl("  http://other.com/y  ", siteUrl, "/about")).toBe("http://other.com/y");
  });

  it("resolves relative overrides against the site URL", () => {
    expect(buildCanonicalUrl("/canonical-path", siteUrl, "/about")).toBe(
      "https://example.com/canonical-path"
    );
    expect(buildCanonicalUrl("canonical-path", siteUrl, "/about")).toBe(
      "https://example.com/canonical-path"
    );
  });

  it("normalizes the path and a trailing slash on the site URL", () => {
    expect(buildCanonicalUrl(null, "https://example.com/", "about")).toBe(
      "https://example.com/about"
    );
  });

  it("returns a relative fallback when the site URL is unset (resolved by metadataBase)", () => {
    expect(buildCanonicalUrl(null, "", "/about")).toBe("/about");
    expect(buildCanonicalUrl("/override", "", "/about")).toBe("/override");
  });
});

describe("buildSocialMetadata", () => {
  const base = { title: "Home", description: "Desc", url: "https://acme.test/", siteTitle: "Acme" };
  const imagesOf = (meta: ReturnType<typeof buildSocialMetadata>) => ({
    og: (meta.openGraph as { images?: unknown } | undefined)?.images,
    twitter: (meta.twitter as { images?: unknown } | undefined)?.images,
  });

  it("uses the page's own feature image first", () => {
    const meta = buildSocialMetadata({
      ...base,
      fallbackImage: { url: "https://cdn.test/share.jpg" },
      imageUrl: "https://cdn.test/feature.jpg",
    });

    expect(imagesOf(meta)).toEqual({
      og: [{ url: "https://cdn.test/feature.jpg", alt: "Home | Acme" }],
      twitter: ["https://cdn.test/feature.jpg"],
    });
  });

  it("falls back to the site-wide social image, with its dimensions and alt text", () => {
    const meta = buildSocialMetadata({
      ...base,
      fallbackImage: { alt: "Acme storefront", height: 630, url: "https://cdn.test/share.jpg", width: 1200 },
      imageUrl: null,
    });

    expect(imagesOf(meta)).toEqual({
      og: [{ url: "https://cdn.test/share.jpg", width: 1200, height: 630, alt: "Acme storefront" }],
      twitter: ["https://cdn.test/share.jpg"],
    });
  });

  it("uses the bundled banner, declared at its real size, when nothing is configured", () => {
    const meta = buildSocialMetadata({ ...base, fallbackImage: null, imageUrl: null });

    expect(imagesOf(meta).og).toEqual([
      { url: DEFAULT_OG_IMAGE, width: DEFAULT_OG_IMAGE_WIDTH, height: DEFAULT_OG_IMAGE_HEIGHT, alt: "Home | Acme" },
    ]);
  });
});
