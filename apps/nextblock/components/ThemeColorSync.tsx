'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { tripletToThemeColor } from '../lib/themes/buildThemeCss';

/**
 * Keeps `<meta name="theme-color">` equal to the painted `--background`.
 *
 * The server can only emit the operator's default theme (`generateViewport` in
 * `app/layout.tsx`). A visitor's own choice lives in localStorage (next-themes), so without
 * this the mobile address bar keeps the default theme's colour under a different palette.
 *
 * It watches the `<html>` class instead of reading `useTheme()`: next-themes applies the class
 * in its own effect, which runs after a child's effect in the same commit, so a child reading
 * the computed style on `resolvedTheme` change would still see the previous palette.
 */
export function ThemeColorSync() {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;

    const sync = () => {
      const color = tripletToThemeColor(getComputedStyle(root).getPropertyValue('--background'));
      if (!color) return;

      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }

      if (meta.content !== color) meta.content = color;
    };

    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributeFilter: ['class', 'style'], attributes: true });

    return () => observer.disconnect();
    // A client navigation can re-render the tag with the server value; sync again after it.
  }, [pathname]);

  return null;
}
