'use client';

/**
 * The restricted storefront editor of a partner (`/portal/retailer/storefront`).
 *
 * - The document is loaded sanitized and every change is emitted sanitized:
 *   `onChange(sanitizeStorefrontDoc(editor.getJSON(), { allowedImageOrigins }).doc)`, and only
 *   when the sanitized document actually differs from the last one emitted.
 * - `enableContentCheck`: when the stored document does not fit the schema, the editor shows a
 *   localized error, turns read-only and never calls `onChange` again, so a broken load can never
 *   overwrite the saved draft with an empty page.
 * - SSR safe (`immediatelyRender: false`); import it statically from a client component.
 */
import { cn } from '@nextblock-cms/utils';
import type { Editor, JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorProps as ProseMirrorEditorProps } from '@tiptap/pm/view';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import { useAffiliatesCopy } from '../i18n/use-affiliates-copy';
import { STOREFRONT_LIMITS } from '../storefront/limits';
import { sanitizeStorefrontBlocks, sanitizeStorefrontDoc, sanitizeStorefrontImageAttrs } from '../storefront/sanitize';
import type {
  StorefrontDoc,
  StorefrontEditorApi,
  StorefrontEditorProduct,
  StorefrontEditorProps,
} from '../storefront/types';
import {
  applyStorefrontLink,
  canReplaceStorefrontSelection,
  collectStorefrontEditorProductIds,
  getSelectedStorefrontImage,
  getStorefrontProductGridAt,
  getStorefrontSelectedText,
  insertStorefrontBlocks,
  insertStorefrontProductGrid,
  removeStorefrontLink,
  replaceStorefrontSelection,
  updateStorefrontImageAlt,
  updateStorefrontProductGrid,
} from './commands';
import { StorefrontEditorContext, type StorefrontEditorContextValue } from './editor-context';
import { StorefrontImageAltDialog, StorefrontLinkDialog } from './editor-dialogs';
import { readStorefrontCalloutTone } from './extensions/callout';
import { readStorefrontGridProductIds } from './extensions/product-grid';
import { createStorefrontEditorExtensions } from './kit';
import { StorefrontProductPickerDialog } from './ProductPickerDialog';
import { createAffiliateProductGridNodeView } from './ProductGridView';
import { createStorefrontProductStore } from './product-store';
import { createStorefrontSlashMenuRender } from './SlashMenu';
import { StorefrontEditorToolbar, type StorefrontEditorToolbarState } from './StorefrontEditorToolbar';

/** Image types the editor uploads (the upload route decodes and re-encodes them; never SVG). */
export const STOREFRONT_EDITOR_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/**
 * Typography of the editing surface. Rules target the document's own elements (direct children
 * of the editing root, list items, quotes) so they never restyle the product grid's controls.
 */
const EDITOR_CONTENT_CLASS =
  'min-h-[320px] px-4 py-4 text-base leading-relaxed text-foreground outline-none sm:px-6 ' +
  '[&>p]:my-3 [&>blockquote>p]:my-1 [&_li>p]:my-0 ' +
  '[&>h2]:mb-3 [&>h2]:mt-8 [&>h2]:text-2xl [&>h2]:font-bold [&>h2]:tracking-tight ' +
  '[&>h3]:mb-2 [&>h3]:mt-6 [&>h3]:text-xl [&>h3]:font-semibold ' +
  '[&>ul]:my-3 [&>ul]:list-disc [&>ul]:pl-6 [&>ol]:my-3 [&>ol]:list-decimal [&>ol]:pl-6 ' +
  '[&_li>ul]:list-disc [&_li>ul]:pl-6 [&_li>ol]:list-decimal [&_li>ol]:pl-6 [&>ul>li]:my-1 [&>ol>li]:my-1 ' +
  '[&>blockquote]:my-4 [&>blockquote]:border-l-4 [&>blockquote]:border-border [&>blockquote]:pl-4 [&>blockquote]:italic [&>blockquote]:text-muted-foreground ' +
  '[&>hr]:my-8 [&>hr]:border-border [&>hr.ProseMirror-selectednode]:ring-2 [&>hr.ProseMirror-selectednode]:ring-ring ' +
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 ' +
  '[&>img]:mx-auto [&>img]:my-6 [&>img]:h-auto [&>img]:max-w-full [&>img]:rounded-lg ' +
  '[&>img.ProseMirror-selectednode]:ring-2 [&>img.ProseMirror-selectednode]:ring-ring [&>img.ProseMirror-selectednode]:ring-offset-2 ' +
  '[&_.storefront-slash-query]:rounded [&_.storefront-slash-query]:bg-accent [&_.storefront-slash-query]:px-0.5 ' +
  '[&_.is-empty]:before:pointer-events-none [&_.is-empty]:before:float-left [&_.is-empty]:before:h-0 ' +
  '[&_.is-empty]:before:text-muted-foreground [&_.is-empty]:before:content-[attr(data-placeholder)]';

type Notice = { tone: 'info' | 'error'; text: string } | null;

/** A document position kept valid while the document changes (dialogs, uploads in flight). */
interface TrackedPosition {
  pos: number;
}

function clampProductsPerGrid(value: number | undefined): number {
  const max = STOREFRONT_LIMITS.maxProductsPerGrid;
  if (typeof value !== 'number' || !Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function firstImageFile(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

function hasFiles(data: DataTransfer | null | undefined): boolean {
  return Boolean(data && data.files && data.files.length > 0);
}

function isProduct(value: StorefrontEditorProduct | null | undefined): value is StorefrontEditorProduct {
  return Boolean(value);
}

export function StorefrontEditor(props: StorefrontEditorProps) {
  const {
    initialContent,
    allowedImageOrigins,
    searchProducts,
    uploadImage,
    editable = true,
    className,
    maxProductsPerGrid,
    ariaLabel,
  } = props;
  const { t } = useAffiliatesCopy(AFFILIATES_EDITOR_COPY);

  // The latest props and copy, for callbacks that outlive a render (extensions, editor props, api).
  const latest = useRef(props);
  latest.current = props;
  const tRef = useRef(t);
  tRef.current = t;

  const maxPerGrid = clampProductsPerGrid(maxProductsPerGrid);

  const [initialDoc] = useState<StorefrontDoc>(() => sanitizeStorefrontDoc(initialContent, { allowedImageOrigins }).doc);
  const lastEmitted = useRef<string>(JSON.stringify(initialDoc));
  const contentErrorRef = useRef(false);
  const [contentError, setContentError] = useState(false);
  const [editableOverride, setEditableOverride] = useState<boolean | null>(null);
  const hasFocusedRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const tracked = useRef(new Set<TrackedPosition>());

  const [linkDialog, setLinkDialog] = useState<{ href: string; editing: boolean } | null>(null);
  const [altDialog, setAltDialog] = useState<{ alt: string } | null>(null);
  const altTarget = useRef<TrackedPosition | null>(null);
  const [picker, setPicker] = useState<{ ids: string[]; otherIds: string[]; known: StorefrontEditorProduct[] } | null>(null);
  const pickerTarget = useRef<TrackedPosition | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [productStore] = useState(() => createStorefrontProductStore(() => latest.current.resolveProducts));

  const track = (pos: number): TrackedPosition => {
    const position = { pos };
    tracked.current.add(position);
    return position;
  };
  const untrack = (position: TrackedPosition | null | undefined) => {
    if (position) tracked.current.delete(position);
  };

  const effectiveEditable = (editableOverride ?? editable) && !contentError;
  const editableRef = useRef(effectiveEditable);
  editableRef.current = effectiveEditable;

  // ---- actions (refreshed every render; extensions and editor props call them through the ref) ----

  const openProductPicker = (pos: number) => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed || !editableRef.current) return;
    const node = getStorefrontProductGridAt(instance.state.doc, pos);
    if (!node) return;
    const ids = readStorefrontGridProductIds(node.attrs['productIds']);
    untrack(pickerTarget.current);
    pickerTarget.current = track(pos);
    setPicker({
      ids,
      otherIds: collectStorefrontEditorProductIds(instance.state.doc, { excludePos: pos }),
      known: ids.map((id) => productStore.get(id)).filter(isProduct),
    });
  };

  const closeProductPicker = () => {
    untrack(pickerTarget.current);
    pickerTarget.current = null;
    setPicker(null);
  };

  const openAltDialogAt = (pos: number, alt: string) => {
    untrack(altTarget.current);
    altTarget.current = track(pos);
    setAltDialog({ alt });
  };

  const closeAltDialog = () => {
    untrack(altTarget.current);
    altTarget.current = null;
    setAltDialog(null);
  };

  const openImagePicker = () => {
    if (!editableRef.current || typeof latest.current.uploadImage !== 'function') return;
    fileInputRef.current?.click();
  };

  const openLinkDialog = () => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed || !editableRef.current) return;
    const href = instance.getAttributes('link')['href'];
    setLinkDialog({ href: typeof href === 'string' ? href : '', editing: instance.isActive('link') });
  };

  const openAltDialog = () => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed || !editableRef.current) return;
    const image = getSelectedStorefrontImage(instance.state);
    if (image) openAltDialogAt(image.pos, image.alt);
  };

  const uploadFile = async (file: File, at?: number) => {
    const upload = latest.current.uploadImage;
    const instance = editorRef.current;
    const translate = tRef.current;
    if (typeof upload !== 'function' || !instance || instance.isDestroyed || !editableRef.current) return;
    if (!(STOREFRONT_EDITOR_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setNotice({ tone: 'error', text: translate('affiliates.editor.image_type_invalid') });
      return;
    }

    const target = typeof at === 'number' ? track(at) : null;
    setUploading(true);
    setNotice({ tone: 'info', text: translate('affiliates.editor.image_uploading') });
    let result: Awaited<ReturnType<typeof upload>> = null;
    try {
      result = await upload(file);
    } catch {
      result = null;
    }
    setUploading(false);
    const position = target?.pos;
    untrack(target);

    if (!result) {
      setNotice({ tone: 'error', text: translate('affiliates.editor.image_upload_failed') });
      return;
    }
    const attrs = sanitizeStorefrontImageAttrs(
      {
        src: result.src,
        alt: result.alt ?? '',
        title: null,
        width: result.width ?? null,
        height: result.height ?? null,
        credit: null,
      },
      latest.current.allowedImageOrigins
    );
    if (!attrs) {
      setNotice({ tone: 'error', text: translate('affiliates.editor.image_not_allowed') });
      return;
    }
    const current = editorRef.current;
    if (!current || current.isDestroyed || !editableRef.current) return;
    const range = insertStorefrontBlocks(current, [{ type: 'image', attrs: { ...attrs } }], {
      at: position ?? 'selection',
    });
    if (!range) {
      setNotice({ tone: 'error', text: translate('affiliates.editor.insert_failed') });
      return;
    }
    setNotice({ tone: 'info', text: translate('affiliates.editor.image_uploaded') });
    if (!attrs.alt) openAltDialogAt(range.from, '');
  };

  const addProductGrid = () => {
    const instance = editorRef.current;
    if (!instance || instance.isDestroyed || !editableRef.current) return;
    const pos = insertStorefrontProductGrid(instance);
    if (pos === null) {
      setNotice({ tone: 'error', text: tRef.current('affiliates.editor.insert_failed') });
      return;
    }
    openProductPicker(pos);
  };

  const actions = useRef({ openProductPicker, openImagePicker, openLinkDialog, uploadFile });
  actions.current = { openProductPicker, openImagePicker, openLinkDialog, uploadFile };

  // ---- editor ----

  const [extensions] = useState(() =>
    createStorefrontEditorExtensions({
      allowedImageOrigins: () => latest.current.allowedImageOrigins,
      translate: (key, values) => tRef.current(key, values),
      isImageUploadEnabled: () => typeof latest.current.uploadImage === 'function' && editableRef.current,
      onImageRequest: () => actions.current.openImagePicker(),
      onProductGridInserted: (_editor, pos) => actions.current.openProductPicker(pos),
      slashMenuRender: createStorefrontSlashMenuRender(),
      productGridNodeView: createAffiliateProductGridNodeView(),
    })
  );

  const [editorProps] = useState<ProseMirrorEditorProps>(() => ({
    attributes: () => ({
      'aria-label': tRef.current('affiliates.editor.content_label'),
      'aria-multiline': 'true',
      class: EDITOR_CONTENT_CLASS,
      spellcheck: 'true',
    }),
    handleKeyDown: (_view, event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        actions.current.openLinkDialog();
        return true;
      }
      return false;
    },
    handlePaste: (_view, event) => {
      const file = firstImageFile(event.clipboardData);
      if (!file || typeof latest.current.uploadImage !== 'function') return false;
      event.preventDefault();
      void actions.current.uploadFile(file);
      return true;
    },
    handleDrop: (view, event, _slice, moved) => {
      if (moved || !hasFiles(event.dataTransfer)) return false;
      // Never let the browser open a dropped file (it would leave the page and its unsaved edits).
      event.preventDefault();
      const file = firstImageFile(event.dataTransfer);
      if (file && typeof latest.current.uploadImage === 'function') {
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void actions.current.uploadFile(file, coords?.pos);
      }
      return true;
    },
  }));

  const emitChange = (instance: Editor) => {
    if (contentErrorRef.current || instance.isDestroyed) return;
    const doc = sanitizeStorefrontDoc(instance.getJSON(), {
      allowedImageOrigins: latest.current.allowedImageOrigins,
    }).doc;
    const serialized = JSON.stringify(doc);
    if (serialized === lastEmitted.current) return;
    lastEmitted.current = serialized;
    latest.current.onChange(doc);
  };

  const editor = useEditor({
    extensions,
    content: initialDoc as JSONContent,
    editable: effectiveEditable,
    editorProps,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    enableContentCheck: true,
    onContentError: ({ editor: instance }) => {
      if (instance.isInitialized) {
        // An insert was refused (the stored document is fine): say so, keep editing.
        setNotice({ tone: 'error', text: tRef.current('affiliates.editor.insert_failed') });
        return;
      }
      // The stored document does not fit the schema. Tiptap fell back to an empty document;
      // emitting it would wipe the draft, so the editor goes read-only and stays silent.
      contentErrorRef.current = true;
      setContentError(true);
    },
    onFocus: () => {
      hasFocusedRef.current = true;
    },
    onUpdate: ({ editor: instance }) => emitChange(instance),
    onTransaction: ({ transaction, appendedTransactions }) => {
      if (tracked.current.size === 0 || !transaction.docChanged) return;
      const transactions = [transaction, ...(appendedTransactions ?? [])];
      for (const position of tracked.current) {
        for (const tr of transactions) position.pos = tr.mapping.map(position.pos);
      }
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== effectiveEditable) editor.setEditable(effectiveEditable, false);
  }, [editor, effectiveEditable]);

  useEffect(() => {
    setEditableOverride(null);
  }, [editable]);

  useEffect(() => {
    if (notice?.tone !== 'info') return undefined;
    const handle = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(handle);
  }, [notice]);

  // ---- imperative api ----

  const [api] = useState<StorefrontEditorApi>(() => ({
    insertBlocks: (blocks) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || contentErrorRef.current || !editableRef.current) return;
      const { blocks: clean } = sanitizeStorefrontBlocks(blocks, {
        allowedImageOrigins: latest.current.allowedImageOrigins,
      });
      if (clean.length === 0) return;
      insertStorefrontBlocks(instance, clean as unknown as JSONContent[], {
        at: hasFocusedRef.current ? 'selection' : 'end',
      });
    },
    getSelectedText: () => {
      const instance = editorRef.current;
      return instance && !instance.isDestroyed ? getStorefrontSelectedText(instance) : '';
    },
    canReplaceSelection: () => {
      const instance = editorRef.current;
      return Boolean(instance && !instance.isDestroyed && canReplaceStorefrontSelection(instance));
    },
    replaceSelection: (text) => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || contentErrorRef.current || !editableRef.current) return false;
      return replaceStorefrontSelection(instance, text);
    },
    getDoc: () => {
      const instance = editorRef.current;
      if (!instance || instance.isDestroyed || contentErrorRef.current) {
        return JSON.parse(lastEmitted.current) as StorefrontDoc;
      }
      return sanitizeStorefrontDoc(instance.getJSON(), { allowedImageOrigins: latest.current.allowedImageOrigins }).doc;
    },
    focus: () => {
      const instance = editorRef.current;
      if (instance && !instance.isDestroyed) instance.commands.focus();
    },
    setEditable: (value) => {
      setEditableOverride(Boolean(value));
    },
  }));

  useEffect(() => {
    if (!editor) return undefined;
    latest.current.onEditorReady?.(api);
    return () => {
      latest.current.onEditorReady?.(null);
    };
  }, [editor, api]);

  // ---- state for the toolbar ----

  const toolbarState = useEditorState({
    editor,
    // Reads the editor from this render, not from the snapshot: with `immediatelyRender: false` the
    // snapshot still holds `null` until the first transaction, which would hide the toolbar.
    selector: (): StorefrontEditorToolbarState | null => {
      const current = editor;
      if (!current || current.isDestroyed) return null;
      const { selection } = current.state;
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        underline: current.isActive('underline'),
        strike: current.isActive('strike'),
        link: current.isActive('link'),
        heading2: current.isActive('heading', { level: 2 }),
        heading3: current.isActive('heading', { level: 3 }),
        bulletList: current.isActive('bulletList'),
        orderedList: current.isActive('orderedList'),
        blockquote: current.isActive('blockquote'),
        callout: current.isActive('storefrontCallout'),
        calloutTone: readStorefrontCalloutTone(current.getAttributes('storefrontCallout')['tone']),
        imageSelected: selection instanceof NodeSelection && selection.node.type.name === 'image',
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      };
    },
  });

  const contextValue = useMemo<StorefrontEditorContextValue>(
    () => ({
      openProductPicker: (pos: number) => actions.current.openProductPicker(pos),
      productStore,
      maxProductsPerGrid: maxPerGrid,
      editable: effectiveEditable,
    }),
    [productStore, maxPerGrid, effectiveEditable]
  );

  const focusEditor = () => {
    const instance = editorRef.current;
    if (instance && !instance.isDestroyed) instance.commands.focus();
  };

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void actions.current.uploadFile(file);
  };

  return (
    <StorefrontEditorContext.Provider value={contextValue}>
      <section
        aria-label={ariaLabel ?? t('affiliates.editor.region_label')}
        data-storefront-editor=""
        className={cn('flex flex-col rounded-lg border border-border bg-card text-card-foreground', className)}
      >
        {contentError ? (
          <div role="alert" className="flex items-start gap-2 rounded-t-lg border-b border-border bg-destructive/10 px-4 py-3 text-sm text-foreground">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p>{t('affiliates.editor.content_error')}</p>
          </div>
        ) : null}

        {editor && toolbarState && effectiveEditable ? (
          <StorefrontEditorToolbar
            editor={editor}
            state={toolbarState}
            t={t}
            onLink={openLinkDialog}
            onAddProducts={addProductGrid}
            onAddImage={typeof uploadImage === 'function' ? openImagePicker : undefined}
            onImageDescription={openAltDialog}
            uploading={uploading}
          />
        ) : null}

        {/* Hidden (not unmounted) after a content error: the fallback document is empty. */}
        <div
          hidden={contentError}
          className="relative rounded-b-lg focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
        >
          {editor ? null : (
            <p aria-busy="true" className="min-h-[320px] px-4 py-4 text-sm text-muted-foreground sm:px-6">
              {t('affiliates.editor.loading')}
            </p>
          )}
          <EditorContent editor={editor} />
        </div>

        <p
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            notice ? 'border-t border-border px-4 py-2 text-sm' : 'sr-only',
            notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {notice?.text ?? ''}
        </p>

        {typeof uploadImage === 'function' ? (
          <input
            ref={fileInputRef}
            type="file"
            accept={STOREFRONT_EDITOR_IMAGE_TYPES.join(',')}
            hidden
            tabIndex={-1}
            aria-label={t('affiliates.editor.image_file_label')}
            onChange={onFileChosen}
          />
        ) : null}
      </section>

      <StorefrontLinkDialog
        open={linkDialog !== null}
        onOpenChange={(open) => {
          if (!open) setLinkDialog(null);
        }}
        t={t}
        initialHref={linkDialog?.href ?? ''}
        editing={linkDialog?.editing ?? false}
        returnFocus={focusEditor}
        onApply={(href) => {
          const instance = editorRef.current;
          if (instance && !instance.isDestroyed) applyStorefrontLink(instance, href);
        }}
        onRemove={() => {
          const instance = editorRef.current;
          if (instance && !instance.isDestroyed) removeStorefrontLink(instance);
        }}
      />

      <StorefrontImageAltDialog
        open={altDialog !== null}
        onOpenChange={(open) => {
          if (!open) closeAltDialog();
        }}
        t={t}
        initialAlt={altDialog?.alt ?? ''}
        returnFocus={focusEditor}
        onSave={(alt) => {
          const instance = editorRef.current;
          const target = altTarget.current;
          if (instance && !instance.isDestroyed && target) updateStorefrontImageAlt(instance, target.pos, alt);
        }}
      />

      <StorefrontProductPickerDialog
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) closeProductPicker();
        }}
        searchProducts={searchProducts}
        initialSelectedIds={picker?.ids ?? []}
        knownProducts={picker?.known ?? []}
        otherProductIds={picker?.otherIds ?? []}
        maxProducts={maxPerGrid}
        onConfirm={(ids, products) => {
          productStore.prime(products);
          const instance = editorRef.current;
          const target = pickerTarget.current;
          if (instance && !instance.isDestroyed && target) updateStorefrontProductGrid(instance, target.pos, { productIds: ids });
        }}
      />
    </StorefrontEditorContext.Provider>
  );
}
