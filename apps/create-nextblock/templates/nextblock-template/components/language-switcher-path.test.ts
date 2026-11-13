import { describe, expect, it } from 'vitest';
import { contentLookupForPath, resolveLocalePathTarget } from './language-switcher-path';

describe('contentLookupForPath', () => {
  it('looks up only the three CMS document shapes', () => {
    expect(contentLookupForPath('/about')).toEqual({ slug: 'about', type: 'pages' });
    expect(contentLookupForPath('/about/')).toEqual({ slug: 'about', type: 'pages' });
    expect(contentLookupForPath('/article/hello-world')).toEqual({ slug: 'hello-world', type: 'posts' });
    expect(contentLookupForPath('/product/chef-knife')).toEqual({ slug: 'chef-knife', type: 'products' });
  });

  it('never treats a code route as a document (storefront handles, portal, checkout, orders)', () => {
    for (const path of [
      '/partners/home',
      '/partners/contact',
      '/portal/retailer/storefront',
      '/portal/retailer/payouts',
      '/checkout/success',
      '/profile/orders/42',
      '/article/a/b',
      '/product/a/b',
      '/',
      '',
    ]) {
      expect(contentLookupForPath(path)).toBeNull();
    }
    expect(contentLookupForPath(undefined)).toBeNull();
  });
});

describe('resolveLocalePathTarget', () => {
  const paths = { en: '/partners', fr: '/partenaires', 'x-default': '/partners' };

  it('takes the exact language, then its base language, then x-default', () => {
    expect(resolveLocalePathTarget(paths, 'fr')).toBe('/partenaires');
    expect(resolveLocalePathTarget(paths, 'fr-CA')).toBe('/partenaires');
    expect(resolveLocalePathTarget(paths, 'en')).toBe('/partners');
    expect(resolveLocalePathTarget(paths, 'es')).toBe('/partners');
  });

  it('answers null without a map or a usable target, and never an off-site address', () => {
    expect(resolveLocalePathTarget(null, 'fr')).toBeNull();
    expect(resolveLocalePathTarget({ en: '/partners' }, 'es')).toBeNull();
    expect(resolveLocalePathTarget({ fr: '//evil.example', 'x-default': 'https://evil.example' }, 'fr')).toBeNull();
    expect(resolveLocalePathTarget({ fr: '/\\evil.example' }, 'fr')).toBeNull();
  });
});
