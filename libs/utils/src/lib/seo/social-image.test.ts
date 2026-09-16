import { describe, expect, it } from 'vitest';

import { parseSiteSocialImageSetting } from './social-image';

describe('parseSiteSocialImageSetting', () => {
  it('returns null for anything that is not an image reference', () => {
    expect(parseSiteSocialImageSetting(null)).toBeNull();
    expect(parseSiteSocialImageSetting('images/banner.jpg')).toBeNull();
    expect(parseSiteSocialImageSetting({ alt: 'no image' })).toBeNull();
    expect(parseSiteSocialImageSetting({ url: 'javascript:alert(1)' })).toBeNull();
    expect(parseSiteSocialImageSetting([{ url: 'https://cdn.test/a.jpg' }])).toBeNull();
  });

  it('keeps a media library reference with its dimensions', () => {
    expect(
      parseSiteSocialImageSetting({
        alt: 'Acme',
        height: 630,
        media_id: 'm1',
        object_key: 'uploads/share.jpg',
        width: 1200,
      })
    ).toEqual({ alt: 'Acme', height: 630, media_id: 'm1', object_key: 'uploads/share.jpg', url: null, width: 1200 });
  });

  it('keeps a hotlinked https URL and drops unusable dimensions', () => {
    expect(parseSiteSocialImageSetting({ height: -1, url: 'https://images.example.com/share.jpg', width: 'wide' })).toEqual({
      alt: null,
      height: null,
      media_id: null,
      object_key: null,
      url: 'https://images.example.com/share.jpg',
      width: null,
    });
  });
});
