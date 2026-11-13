'use client';

import { useEffect } from 'react';
import { useCurrentContent } from '../context/CurrentContentContext';

interface CurrentContentSetterProps {
  id: string | number | null;
  type: 'page' | 'post' | 'product' | null;
  slug: string | null;
  translation_group_id?: string | null;
  /** See CurrentContent.localePaths: the route's own address per language code (and `x-default`). */
  localePaths?: Readonly<Partial<Record<string, string>>> | null;
}

export const CurrentContentSetter = ({ id, type, slug, translation_group_id, localePaths }: CurrentContentSetterProps) => {
  const { setCurrentContent } = useCurrentContent();
  // A stable dependency: the map is a fresh object whenever the server component re-renders.
  const localePathsKey = localePaths ? JSON.stringify(localePaths) : '';

  useEffect(() => {
    const paths = localePathsKey ? (JSON.parse(localePathsKey) as Record<string, string>) : null;
    // Only set if different to avoid potential loops if dependencies are unstable
    setCurrentContent({ id, type, slug, translation_group_id, ...(paths ? { localePaths: paths } : {}) });

    // Cleanup on unmount
    return () => setCurrentContent({ id: null, type: null, slug: null, translation_group_id: null });
  }, [id, type, slug, translation_group_id, localePathsKey, setCurrentContent]);

  return null;
};
