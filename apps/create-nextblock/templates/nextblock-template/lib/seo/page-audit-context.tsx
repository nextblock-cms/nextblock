'use client';

/**
 * Shared live state for the page-level SEO audit.
 *
 * WHY THIS EXISTS. The pieces an SEO audit needs are spread across three sibling
 * components that have no relationship to each other: `BlockEditorArea` owns the
 * live `blocks` array (it is the only client component that holds all of them),
 * `PageForm` / `PostForm` own the meta title and description as local form state,
 * and the panel that has to grade all of it renders next to both. Lifting any one
 * of those into another would mean restructuring an edit screen that works; a small
 * context is the cheaper and less invasive answer.
 *
 * WHY THE AUDIT IS PAGE-LEVEL AND NOT PER-BLOCK. The first version of this feature
 * mounted the panel inside the rich-text editor, where it could only ever see one
 * block. That produced confidently wrong results: a single paragraph block was told
 * it had no H1 and fewer than 300 words, neither of which is a property a block can
 * have. Headings in NextBlock live in two places — standalone `heading` blocks and
 * h1–h6 nodes inside a `text` block's HTML — and blocks nested in a `section` live
 * in `content.column_blocks[column][index]` rather than in the top-level array. Only
 * something walking the whole tree can answer "does this page have exactly one H1".
 * So the page-level panel is the real audit, and the in-editor panel is narrowed to
 * the handful of checks a single block genuinely owns.
 *
 * PUBLISHING IS EFFECT-DRIVEN, deliberately. Both producers call their setter from a
 * `useEffect` keyed on the value they publish, never during render — a child calling
 * a parent's setState while rendering is the classic "Cannot update a component
 * while rendering a different component" warning, and with the blocks array it would
 * be an update loop rather than just a warning.
 *
 * `usePageSeo()` RETURNS NULL OUTSIDE A PROVIDER on purpose. `PageForm`,
 * `BlockEditorArea` and `TextBlockEditor` are all reachable from surfaces that have
 * no page-level audit — the product editor is the live example — and none of them
 * should crash or need a second code path just because the panel is absent.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** Everything the page-level audit grades, as it currently stands in the editor. */
export interface PageSeoSnapshot {
  /**
   * The live blocks array, exactly as `BlockEditorArea` holds it. Typed as
   * `unknown[]` because this module has no business knowing the block union — the
   * walker in `page-document.ts` is defensive about shape anyway, since block
   * content is `Json` and a custom block can carry anything.
   */
  blocks: unknown[];
  /** Document title for articles / posts where the template renders an H1. */
  documentTitle: string | null;
  /** Whether this is a standalone 'page', an editorial 'post', or a store 'product'. */
  documentType: 'page' | 'post' | 'product';
  metaDescription: string | null;
  metaTitle: string | null;
}

export interface PageSeoContextValue {
  /** The focus keyphrase, held here so it survives switching between blocks. */
  keyword: string;
  setBlocks: (blocks: unknown[]) => void;
  setDocumentTitle: (title: string | null) => void;
  setKeyword: (keyword: string) => void;
  setMeta: (meta: { metaDescription: string | null; metaTitle: string | null }) => void;
  snapshot: PageSeoSnapshot;
}

const PageSeoContext = createContext<PageSeoContextValue | null>(null);

export interface PageSeoProviderProps {
  children: ReactNode;
  documentTitle?: string | null;
  documentType?: 'page' | 'post' | 'product';
  initialBlocks?: unknown[];
  initialMetaDescription?: string | null;
  initialMetaTitle?: string | null;
}

export function PageSeoProvider({
  children,
  documentTitle: initialDocumentTitle = null,
  documentType = 'page',
  initialBlocks = [],
  initialMetaDescription = null,
  initialMetaTitle = null,
}: PageSeoProviderProps) {
  const [blocks, setBlocksState] = useState<unknown[]>(initialBlocks);
  const [documentTitle, setDocumentTitleState] = useState<string | null>(initialDocumentTitle);
  const [keyword, setKeyword] = useState('');
  const [meta, setMetaState] = useState<{
    metaDescription: string | null;
    metaTitle: string | null;
  }>({ metaDescription: initialMetaDescription, metaTitle: initialMetaTitle });

  const setDocumentTitle = useCallback((next: string | null) => {
    setDocumentTitleState((previous) => (previous === next ? previous : next));
  }, []);

  // Both setters bail when nothing actually changed. The blocks array is rebuilt on
  // every keystroke in a block editor, so without the length-and-identity check
  // below every character typed would re-render the provider and every consumer of
  // this context, not just the panel that debounces its own work.
  const setBlocks = useCallback((next: unknown[]) => {
    setBlocksState((previous) =>
      previous.length === next.length && previous.every((block, index) => block === next[index])
        ? previous
        : next,
    );
  }, []);

  const setMeta = useCallback(
    (next: { metaDescription: string | null; metaTitle: string | null }) => {
      setMetaState((previous) =>
        previous.metaDescription === next.metaDescription && previous.metaTitle === next.metaTitle
          ? previous
          : next,
      );
    },
    [],
  );

  const value = useMemo<PageSeoContextValue>(
    () => ({
      keyword,
      setBlocks,
      setDocumentTitle,
      setKeyword,
      setMeta,
      snapshot: {
        blocks,
        documentTitle,
        documentType,
        metaDescription: meta.metaDescription,
        metaTitle: meta.metaTitle,
      },
    }),
    [blocks, documentTitle, documentType, keyword, meta.metaDescription, meta.metaTitle, setBlocks, setDocumentTitle, setMeta],
  );

  return <PageSeoContext.Provider value={value}>{children}</PageSeoContext.Provider>;
}

/**
 * The page-level audit state, or `null` when there is no provider above.
 *
 * Callers must handle the null case rather than asserting — see the module docblock
 * for why an edit surface without a page-level panel is a supported configuration
 * and not a mistake.
 */
export function usePageSeo(): PageSeoContextValue | null {
  return useContext(PageSeoContext);
}
