/* eslint-disable no-script-url -- javascript:/data: URLs are the vectors this suite must reject */
import { describe, expect, it } from 'vitest';
import {
  STOREFRONT_DEFAULT_LINK_REL,
  isAllowedStorefrontImageSrc,
  isExternalStorefrontHref,
  normalizeStorefrontImageOrigins,
  normalizeStorefrontImageSrc,
  normalizeStorefrontSiteOrigin,
  sanitizeStorefrontHref,
} from './urls';

// Invisible and control characters are built from code points so the test source stays ASCII.
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const TAB = ch(0x09);
const LF = ch(0x0a);
const CR = ch(0x0d);
const NUL = ch(0x00);
const ZWSP = ch(0x200b);
const ZWJ = ch(0x200d);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const NBSP = ch(0xa0);
const BOM = ch(0xfeff);
const BACKSLASH = ch(0x5c);
const IDEOGRAPHIC_SPACE = ch(0x3000);
const SOFT_HYPHEN = ch(0xad);
const TAG_LATIN_A = ch(0xe0061);
const C1_CONTROL = ch(0x85);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const FULLWIDTH_JAVASCRIPT = Array.from('javascript', (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');

const KEPT: Array<[string, string]> = [
  ['https://example.com', 'https://example.com/'],
  ['HTTPS://Example.COM/Path?q=1#top', 'https://example.com/Path?q=1#top'],
  ['http://example.com:80/a', 'http://example.com/a'],
  ['https://example.com:8443/a', 'https://example.com:8443/a'],
  ['  https://example.com/a  ', 'https://example.com/a'],
  ['https:example.com/x', 'https://example.com/x'],
  ['https://example.com/<script>', 'https://example.com/%3Cscript%3E'],
  ['https://example.com/a?u=javascript:alert(1)', 'https://example.com/a?u=javascript:alert(1)'],
  ['mailto:hello@example.com', 'mailto:hello@example.com'],
  ['MAILTO:hello@example.com?subject=Hi%20there', 'mailto:hello@example.com?subject=Hi%20there'],
  ['/products/blue-shirt', '/products/blue-shirt'],
  ['/products/blue-shirt?ref=jane#reviews', '/products/blue-shirt?ref=jane#reviews'],
  ['/a/../b', '/b'],
  ['/fr/produits/chandail-bleu', '/fr/produits/chandail-bleu'],
];

const REJECTED: Array<[string, unknown]> = [
  ['javascript scheme', 'javascript:alert(1)'],
  ['upper-case javascript', 'JAVASCRIPT:alert(1)'],
  ['mixed-case javascript', 'JaVaScRiPt:alert(document.cookie)'],
  ['leading space before javascript', ' javascript:alert(1)'],
  ['tab inside the scheme', `java${TAB}script:alert(1)`],
  ['newline inside the scheme', `java${LF}script:alert(1)`],
  ['carriage return inside the scheme', `java${CR}script:alert(1)`],
  ['NUL inside the scheme', `java${NUL}script:alert(1)`],
  ['leading NUL', `${NUL}javascript:alert(1)`],
  ['C1 control', `java${C1_CONTROL}script:alert(1)`],
  ['zero-width space before the colon', `javascript${ZWSP}:alert(1)`],
  ['zero-width joiner', `java${ZWJ}script:alert(1)`],
  ['bidi override', `${RLO}javascript:alert(1)`],
  ['bidi isolate', `${LRI}javascript:alert(1)`],
  ['byte order mark', `${BOM}javascript:alert(1)`],
  ['fullwidth scheme', `${FULLWIDTH_JAVASCRIPT}:alert(1)`],
  ['entity-encoded scheme', '&#106;avascript:alert(1)'],
  ['entity-encoded colon', 'javascript&colon;alert(1)'],
  ['entity-encoded tab', 'jav&#x09;ascript:alert(1)'],
  ['percent-encoded scheme', '%6Aavascript:alert(1)'],
  ['data URL', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['data SVG', 'data:image/svg+xml,<svg onload=alert(1)>'],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['file', 'file:///etc/passwd'],
  ['blob', 'blob:https://example.com/0a1b'],
  ['about', 'about:blank'],
  ['tel', 'tel:+15555550100'],
  ['ftp', 'ftp://example.com/file'],
  ['scheme-relative', '//evil.example'],
  ['triple slash', '///evil.example'],
  ['slash backslash', `/${BACKSLASH}evil.example`],
  ['backslash slash', `${BACKSLASH}/evil.example`],
  ['https with backslashes', `https:${BACKSLASH}${BACKSLASH}evil.example`],
  ['backslash before the at sign', `https://evil.example${BACKSLASH}@good.example`],
  ['encoded leading slash', '/%2f/evil.example'],
  ['encoded leading slashes (upper case)', '/%2F%2Fevil.example'],
  ['encoded leading backslash', '/%5cevil.example'],
  ['dot segment to a scheme-relative path', '/.//evil.example'],
  ['dot-dot segment to a scheme-relative path', '/..//evil.example'],
  ['credentials', 'https://user:pass@evil.example/'],
  ['username only', 'https://user@evil.example/'],
  ['fragment only', '#reviews'],
  ['relative path', 'products/blue-shirt'],
  ['bare domain', 'evil.example'],
  ['mailto with a script', 'mailto:javascript:alert(1)'],
  ['mailto without an address', 'mailto:'],
  ['mailto with two addresses', 'mailto:a@example.com,b@example.com'],
  ['mailto with a fragment', 'mailto:a@example.com#x'],
  ['https without a host', 'https://'],
  ['malformed IPv6 host', 'http://[::1'],
  ['NBSP in the host', `https://exa${NBSP}mple.com/`],
  ['ideographic space', `https://example.com/${IDEOGRAPHIC_SPACE}x`],
  ['soft hyphen', `https://exam${SOFT_HYPHEN}ple.com/`],
  ['tag character', `https://example.com/${TAG_LATIN_A}`],
  ['lone surrogate', `https://example.com/${LONE_SURROGATE}`],
  ['over 2000 characters', `https://example.com/${'a'.repeat(2000)}`],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['null', null],
  ['undefined', undefined],
  ['number', 42],
  ['object', { href: 'https://example.com' }],
  ['array', ['https://example.com']],
];

describe('sanitizeStorefrontHref', () => {
  it.each(KEPT)('keeps %j as %j', (input, expected) => {
    expect(sanitizeStorefrontHref(input)).toBe(expected);
  });

  it.each(REJECTED)('rejects %s', (_label, input) => {
    expect(sanitizeStorefrontHref(input)).toBeNull();
  });

  it('keeps an internationalized domain in its punycode form', () => {
    expect(sanitizeStorefrontHref('https://bücher.example/')).toBe('https://xn--bcher-kva.example/');
  });

  it('is idempotent: a kept href normalizes to itself', () => {
    const corpus = [...KEPT.map(([input]) => input), ...REJECTED.map(([, input]) => input)];
    for (const input of corpus) {
      const once = sanitizeStorefrontHref(input);
      if (once !== null) expect(sanitizeStorefrontHref(once)).toBe(once);
    }
  });

  it('exports the default partner link rel', () => {
    expect(STOREFRONT_DEFAULT_LINK_REL).toBe('nofollow ugc noopener noreferrer');
  });
});

const ORIGINS = [
  'https://media.example-store.com',
  'https://images.pexels.com',
  'https://images.unsplash.com',
  'https://plus.unsplash.com',
];

describe('isAllowedStorefrontImageSrc', () => {
  it.each([
    'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb',
    'https://images.unsplash.com/photo-1?ixid=abc&w=1080',
    'https://media.example-store.com/images/abc.webp',
    '/images/abc.webp',
    '/images/2026/10/abc.webp?v=2',
  ])('allows %s', (src) => {
    expect(isAllowedStorefrontImageSrc(src, ORIGINS)).toBe(true);
  });

  it.each([
    ['another origin', 'https://evil.example/x.png'],
    ['a look-alike host', 'https://images.pexels.com.evil.example/x.png'],
    ['an allowed host in the query only', 'https://evil.example/?u=https://images.pexels.com/x.png'],
    ['http on an allowed host', 'http://images.pexels.com/x.png'],
    ['another port', 'https://images.pexels.com:8443/x.png'],
    ['credentials', 'https://user:pw@images.pexels.com/x.png'],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['an SVG data URL', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['javascript', 'javascript:alert(1)'],
    ['a scheme-relative URL', '//images.pexels.com/x.png'],
    ['a dot-dot escape from /images/', '/images/../cms/secret.png'],
    ['an encoded dot-dot escape', '/images/%2e%2e/cms/x.png'],
    ['a path outside /images/', '/uploads/x.png'],
    ['a double slash inside /images/', '/images//evil.example/x.png'],
    ['a relative path', 'images/x.png'],
    ['a backslash', `https://images.pexels.com/${BACKSLASH}x.png`],
    ['whitespace', 'https://images.pexels.com/a b.png'],
    ['a zero-width space', `https://images.pexels.com/${ZWSP}x.png`],
    ['a non-string', 42],
    ['null', null],
  ])('rejects %s', (_label, src) => {
    expect(isAllowedStorefrontImageSrc(src, ORIGINS)).toBe(false);
  });

  it('rejects everything when the allowlist is empty (except /images/ paths)', () => {
    expect(isAllowedStorefrontImageSrc('https://images.pexels.com/x.png', [])).toBe(false);
    expect(isAllowedStorefrontImageSrc('/images/x.png', [])).toBe(true);
  });

  it('normalizes the allowlist to lowercase origins', () => {
    expect([...normalizeStorefrontImageOrigins(['HTTPS://Images.Pexels.com/', 'https://cdn.example.com/bucket/'])]).toEqual([
      'https://images.pexels.com',
      'https://cdn.example.com',
    ]);
    expect(isAllowedStorefrontImageSrc('https://images.pexels.com/x.png', ['HTTPS://Images.Pexels.com/'])).toBe(true);
  });

  it('accepts http origins only for loopback hosts the list names', () => {
    expect(isAllowedStorefrontImageSrc('http://localhost:4200/images/x.png', ['http://localhost:4200'])).toBe(true);
    expect(isAllowedStorefrontImageSrc('http://127.0.0.1:54321/storage/x.png', ['http://127.0.0.1:54321'])).toBe(true);
    expect(isAllowedStorefrontImageSrc('http://localhost:4200/images/x.png', ['https://localhost:4200'])).toBe(false);
    expect(normalizeStorefrontImageOrigins(['http://cdn.example.com', 'ftp://cdn.example.com', 'not a url', 7 as never]).size).toBe(0);
    expect(isAllowedStorefrontImageSrc('http://cdn.example.com/x.png', ['http://cdn.example.com'])).toBe(false);
  });

  it('returns a canonical src that normalizes to itself', () => {
    const src = normalizeStorefrontImageSrc('  HTTPS://IMAGES.PEXELS.COM/photos/1/x.jpeg  ', ORIGINS);
    expect(src).toBe('https://images.pexels.com/photos/1/x.jpeg');
    expect(normalizeStorefrontImageSrc(src, ORIGINS)).toBe(src);
    expect(normalizeStorefrontImageSrc('/images/a/./b.png', ORIGINS)).toBe('/images/a/b.png');
  });
});

describe('site origin helpers', () => {
  it('normalizes the site origin', () => {
    expect(normalizeStorefrontSiteOrigin('https://Shop.Example/path?x=1')).toBe('https://shop.example');
    expect(normalizeStorefrontSiteOrigin('http://localhost:4200/')).toBe('http://localhost:4200');
    expect(normalizeStorefrontSiteOrigin('ftp://shop.example')).toBeNull();
    expect(normalizeStorefrontSiteOrigin('not a url')).toBeNull();
    expect(normalizeStorefrontSiteOrigin(42)).toBeNull();
  });

  it('treats only absolute http(s) URLs to another origin as external', () => {
    expect(isExternalStorefrontHref('https://other.example/x', 'https://shop.example')).toBe(true);
    expect(isExternalStorefrontHref('https://shop.example/x', 'https://shop.example/')).toBe(false);
    expect(isExternalStorefrontHref('http://shop.example/x', 'https://shop.example')).toBe(true);
    expect(isExternalStorefrontHref('https://shop.example:8443/x', 'https://shop.example')).toBe(true);
    expect(isExternalStorefrontHref('/products/x', 'https://shop.example')).toBe(false);
    expect(isExternalStorefrontHref('mailto:a@example.com', 'https://shop.example')).toBe(false);
    expect(isExternalStorefrontHref('https://shop.example/x', null)).toBe(true);
    expect(isExternalStorefrontHref('https://shop.example/x', undefined)).toBe(true);
  });
});
