'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';

export interface CurrentContent {
  id: string | number | null;
  type: 'page' | 'post' | 'product' | null;
  slug: string | null;
  translation_group_id?: string | null;
  /**
   * A code route with its own address per language (e.g. the partner program's `/partners` and
   * `/partenaires`): language code (or `x-default`) -> site-relative path. When set, the language
   * switcher navigates there instead of looking the path up as a CMS document.
   */
  localePaths?: Readonly<Partial<Record<string, string>>> | null;
}

interface CurrentContentContextType {
  currentContent: CurrentContent;
  setCurrentContent: (content: CurrentContent) => void;
}

const CurrentContentContext = createContext<CurrentContentContextType | undefined>(undefined);

export const CurrentContentProvider = ({ children }: { children: ReactNode }) => {
  const [currentContent, setCurrentContentState] = useState<CurrentContent>({
    id: null,
    type: null,
    slug: null,
  });

  const setCurrentContent = React.useCallback((content: CurrentContent) => {
    setCurrentContentState(content);
  }, []);

  const value = React.useMemo(() => ({
    currentContent,
    setCurrentContent
  }), [currentContent, setCurrentContent]);

  return (
    <CurrentContentContext.Provider value={value}>
      {children}
    </CurrentContentContext.Provider>
  );
};

export const useCurrentContent = () => {
  const context = useContext(CurrentContentContext);
  if (context === undefined) {
    throw new Error('useCurrentContent must be used within a CurrentContentProvider');
  }
  return context;
};