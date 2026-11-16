"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type { Json } from "@nextblock-cms/db";
import { Button, Input, Label, Textarea } from "@nextblock-cms/ui";
import { Loader2, Pencil, Trash2, CloudLightning } from "lucide-react";
import {
  discardVisualEditingDraft,
  discardVisualEditingProductDraft,
  loadVisualEditingBlockContent,
  loadVisualEditingProductField,
  publishVisualEditingDraft,
  publishVisualEditingProductDraft,
} from "../../app/actions/visualEditingActions";
import {
  BlockEditorModal,
  type Block,
  type BlockEditorProps,
  type BlockEditorSaveStatus,
  type EditorSurfaceContext,
} from "../../app/cms/blocks/components/BlockEditorModal";
import type {
  NextblockDocumentType,
  NextblockVisualDocumentType,
  NextblockVisualEditInfo,
  VisualEditingBlockRequest,
  VisualEditingProductFieldRequest,
  VisualEditingProductFieldTarget,
} from "../../lib/visual-editing/types";
import type { BlockType } from "../../lib/blocks/blockRegistry";
import { PRODUCT_PUBLISH_ADMIN_ONLY_NOTE } from "../../lib/visual-editing/product-draft-meta";

type EditorComponent = ComponentType<BlockEditorProps<unknown>>;
type HoverTarget = {
  element: HTMLElement;
  info: NextblockVisualEditInfo;
  rect: DOMRect;
};
type ActiveDocument = {
  parentType: NextblockVisualDocumentType;
  parentId: number | string;
};
type ProductFieldVisualEditInfo = NextblockVisualEditInfo & {
  data: Omit<NextblockVisualEditInfo["data"], "parentType" | "target"> & {
    parentType: "product";
    target: VisualEditingProductFieldTarget;
  };
};
type ParsedCssColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

const VISUAL_DRAFT_AUTOSAVE_DELAY_MS = 900;

const TextBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/TextBlockEditor"),
  { ssr: false }
) as EditorComponent;
const HeadingBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/HeadingBlockEditor"),
  { ssr: false }
) as EditorComponent;
const ImageBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/ImageBlockEditor"),
  { ssr: false }
) as EditorComponent;
const ButtonBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/ButtonBlockEditor"),
  { ssr: false }
) as EditorComponent;
const PostsGridBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/PostsGridBlockEditor"),
  { ssr: false }
) as EditorComponent;
const VideoEmbedBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/VideoEmbedBlockEditor"),
  { ssr: false }
) as EditorComponent;
const FormBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/FormBlockEditor"),
  { ssr: false }
) as EditorComponent;
const ProductGridBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/ProductGridBlockEditor"),
  { ssr: false }
) as EditorComponent;

const FeaturedProductBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/FeaturedProductBlockEditor"),
  { ssr: false }
) as EditorComponent;

// Used for any non-core block type, i.e. user-defined custom blocks. Renders
// the field-based config form (with a JSON fallback for unknown types).
const DynamicCustomBlockEditor = dynamic(
  () => import("../../app/cms/blocks/editors/DynamicCustomBlockEditor"),
  { ssr: false }
) as EditorComponent;
const TestimonialBlockEditor = dynamic(
  () =>
    import("../blocks/TestimonialBlock").then(
      (module) => module.TestimonialBlockConfig.EditorComponent as EditorComponent
    ),
  { ssr: false }
) as EditorComponent;
const SectionBlockEditor = dynamic(
  () =>
    import("../../app/cms/blocks/editors/SectionBlockEditor").then((module) => {
      const Editor = module.default;
      return function VisualSectionBlockEditor(props: BlockEditorProps<unknown>) {
        return (
          <Editor
            content={props.content as any}
            onChange={props.onChange as any}
            isConfigPanelOpen={true}
            blockType="section"
          />
        );
      };
    }),
  { ssr: false }
) as EditorComponent;

const editorComponents: Partial<Record<BlockType, EditorComponent>> = {
  text: TextBlockEditor,
  heading: HeadingBlockEditor,
  image: ImageBlockEditor,
  button: ButtonBlockEditor,
  posts_grid: PostsGridBlockEditor,
  video_embed: VideoEmbedBlockEditor,
  section: SectionBlockEditor,

  form: FormBlockEditor,
  testimonial: TestimonialBlockEditor,
  product_grid: ProductGridBlockEditor,
  featured_product: FeaturedProductBlockEditor,
};

function parseEditInfo(element: Element | null): NextblockVisualEditInfo | null {
  const raw = element?.getAttribute("data-vercel-edit-info");
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as NextblockVisualEditInfo;
    const isNextblock = 
      parsed?.origin === "nextblock" || 
      parsed?.origin === "https://nextblock-editor" || 
      parsed?.origin === "https://nextblock-editor.com" || 
      parsed?.origin === "https://nextblock.dev" || 
      (parsed && typeof parsed === "object" && parsed.data && "parentType" in parsed.data);
    return isNextblock ? parsed : null;
  } catch {
    return null;
  }
}

function isProductFieldTarget(target: unknown): target is VisualEditingProductFieldTarget {
  return Boolean(
    target &&
      typeof target === "object" &&
      "kind" in target &&
      (target as { kind?: unknown }).kind === "product-field"
  );
}

function isProductFieldInfo(info: NextblockVisualEditInfo): info is ProductFieldVisualEditInfo {
  return info.data.parentType === "product" && isProductFieldTarget(info.data.target);
}

function blockRequestFromInfo(info: NextblockVisualEditInfo): VisualEditingBlockRequest {
  if (info.data.parentType !== "page" && info.data.parentType !== "post" && info.data.parentType !== "product") {
    throw new Error("Invalid block draft document.");
  }

  if (isProductFieldTarget(info.data.target)) {
    throw new Error("Invalid block draft target.");
  }

  return {
    parentType: info.data.parentType,
    parentId: info.data.parentType === "product" ? String(info.data.parentId) : Number(info.data.parentId),
    target: info.data.target as VisualEditingBlockRequest["target"],
  };
}

function productFieldRequestFromInfo(info: NextblockVisualEditInfo): VisualEditingProductFieldRequest {
  if (!isProductFieldInfo(info)) {
    throw new Error("Invalid product draft target.");
  }

  return {
    parentType: "product",
    parentId: String(info.data.parentId),
    target: info.data.target,
  };
}

function documentFromInfo(info: NextblockVisualEditInfo): ActiveDocument {
  return {
    parentType: info.data.parentType,
    parentId: info.data.parentId,
  };
}

function serializeDraftContent(content: unknown) {
  try {
    return JSON.stringify(content ?? null);
  } catch {
    return String(content);
  }
}

function getActionError(result: unknown) {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return "";
  }

  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : "";
}

async function saveVisualEditingBlockDraftViaApi(
  request: VisualEditingBlockRequest,
  content: Json
) {
  const response = await fetch("/api/visual-editing/block-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, content }),
    cache: "no-store",
  });

  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    // Keep the UI error concise if the route fails before returning JSON.
  }

  const actionError = getActionError(result);
  if (actionError) {
    return { error: actionError };
  }

  if (!response.ok) {
    return { error: "Failed to save draft." };
  }

  return { success: true };
}

async function saveVisualEditingProductDraftViaApi(
  request: VisualEditingProductFieldRequest,
  content: Json
) {
  const response = await fetch("/api/visual-editing/product-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, content }),
    cache: "no-store",
  });

  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    // Keep the UI error concise if the route fails before returning JSON.
  }

  const actionError = getActionError(result);
  if (actionError) {
    return { error: actionError };
  }

  if (!response.ok) {
    return { error: "Failed to save product draft." };
  }

  return { success: true };
}

function createInfoKey(info: NextblockVisualEditInfo) {
  return JSON.stringify({
    parentType: info.data.parentType,
    parentId: info.data.parentId,
    target: info.data.target,
  });
}

function findElementForInfo(info: NextblockVisualEditInfo) {
  const expectedKey = createInfoKey(info);
  const elements = document.querySelectorAll<HTMLElement>("[data-vercel-edit-info]");

  for (const element of elements) {
    const parsed = parseEditInfo(element);
    if (parsed && createInfoKey(parsed) === expectedKey) {
      return element;
    }
  }

  return null;
}

function parseCssColor(value: string): ParsedCssColor | null {
  const normalized = value.trim().toLowerCase();

  if (!normalized || normalized === "transparent") {
    return null;
  }

  const rgbMatch = normalized.match(/^rgba?\((.+)\)$/);
  if (!rgbMatch) {
    return null;
  }

  const parts = rgbMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return null;
  }

  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);

  if (![r, g, b, a].every(Number.isFinite)) {
    return null;
  }

  return { r, g, b, a };
}

function isDarkColor(value: string) {
  const color = parseCssColor(value);
  if (!color || color.a <= 0) {
    return false;
  }

  const r = color.r * color.a + 255 * (1 - color.a);
  const g = color.g * color.a + 255 * (1 - color.a);
  const b = color.b * color.a + 255 * (1 - color.a);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;

  return yiq < 140;
}

function isLightColor(value: string) {
  const color = parseCssColor(value);
  if (!color || color.a <= 0) {
    return false;
  }

  const yiq = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
  return yiq > 180;
}

function getVisualEditorSurfaceContext(element: HTMLElement | null): EditorSurfaceContext | null {
  if (!element || typeof window === "undefined") {
    return null;
  }

  let current: HTMLElement | null = element;

  while (current && current !== document.body && current !== document.documentElement) {
    const computed = window.getComputedStyle(current);
    const backgroundImage = computed.backgroundImage;
    const hasBackgroundImage = Boolean(backgroundImage && backgroundImage !== "none");
    const backgroundColor = parseCssColor(computed.backgroundColor);
    const hasSolidBackground = Boolean(backgroundColor && backgroundColor.a > 0.55);

    if (hasBackgroundImage || hasSolidBackground) {
      const style: EditorSurfaceContext["style"] = {
        backgroundColor: backgroundColor && backgroundColor.a > 0 ? computed.backgroundColor : undefined,
        backgroundImage: hasBackgroundImage ? backgroundImage : undefined,
        backgroundPosition: computed.backgroundPosition,
        backgroundRepeat: computed.backgroundRepeat,
        backgroundSize: computed.backgroundSize,
      };

      return {
        isDark: hasBackgroundImage || isDarkColor(computed.backgroundColor),
        style,
      };
    }

    current = current.parentElement;
  }

  const textColor = window.getComputedStyle(element).color;
  if (isLightColor(textColor)) {
    return {
      isDark: true,
      style: {
        backgroundColor: "#0f172a",
      },
    };
  }

  return null;
}

function JsonBlockEditor({ content, onChange }: BlockEditorProps<unknown>) {
  const [value, setValue] = useState(() => JSON.stringify(content ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(JSON.stringify(content ?? {}, null, 2));
    setError(null);
  }, [content]);

  return (
    <div className="space-y-3 p-3 border-t mt-2">
      <Label htmlFor="nextblock-visual-json-editor">JSON Content</Label>
      <Textarea
        id="nextblock-visual-json-editor"
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);

          try {
            onChange(JSON.parse(nextValue));
            setError(null);
          } catch (parseError) {
            setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
          }
        }}
        className="min-h-[360px] font-mono text-sm"
        spellCheck={false}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function ProductPlainTextFieldEditor({ block, content, onChange }: BlockEditorProps<unknown>) {
  const value = typeof content === "string" ? content : "";
  const field = typeof block.productField === "string" ? block.productField : "title";

  if (field === "short_description") {
    return (
      <div className="space-y-2 p-3 border-t mt-2">
        <Label htmlFor="nextblock-visual-product-short-description">Short Description</Label>
        <Textarea
          id="nextblock-visual-product-short-description"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[140px] text-sm"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3 border-t mt-2">
      <Label htmlFor="nextblock-visual-product-title">Product Title</Label>
      <Input
        id="nextblock-visual-product-title"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-base"
      />
    </div>
  );
}

function getEditorComponent(blockType: string) {
  // Core blocks have dedicated editors; everything else is treated as a custom
  // block and gets the dynamic field-config editor (not the raw JSON editor).
  return editorComponents[blockType as BlockType] ?? DynamicCustomBlockEditor;
}

function getProductFieldEditorComponent(target: VisualEditingProductFieldTarget) {
  return ProductPlainTextFieldEditor;
}

export interface NextblockVisualEditingProps {
  /**
   * Server-derived (the root layout's currentUserCanPublishProductDrafts(), through
   * DeferredVisualEditing): the caller is an ADMIN past the second factor, the only caller
   * publishProductVisualEditingDraft lets through. For anyone else the toolbar disables Publish on a
   * product with a note (Discard stays); publish checks again on the server, so this only spares a
   * refused round trip. Pages and posts are unaffected.
   */
  canPublishProducts?: boolean;
  /**
   * Server-derived too (the root layout): the caller's profile says ADMIN but the check behind
   * `canPublishProducts` said no, so their second factor is pending (or the check failed). Only the
   * note beside the disabled Publish changes, to PRODUCT_PUBLISH_SECOND_FACTOR_NOTE.
   */
  secondFactorPending?: boolean;
}

/** The note beside a disabled product Publish for an ADMIN whose second factor is pending. */
export const PRODUCT_PUBLISH_SECOND_FACTOR_NOTE = "Complete two-factor verification to publish product changes.";

export function NextblockVisualEditing({
  canPublishProducts = false,
  secondFactorPending = false,
}: NextblockVisualEditingProps = {}) {
  const pathname = usePathname();

  // Hide the frontend toolbar on CMS/admin routes. This MUST stay a thin wrapper
  // that renders the real toolbar as a child rather than early-returning after the
  // toolbar's hooks: this component is mounted in the root layout and persists
  // across client navigations, so if the ~25 hooks below lived here, navigating
  // from a public page (where they all run while editing a draft) into /cms would
  // drop every hook at once — a rules-of-hooks violation that throws mid-navigation
  // and forces a full page reload. Mounting/unmounting a child is safe; changing a
  // component's own hook count between renders is not.
  if (pathname?.startsWith("/cms")) {
    return null;
  }

  return <VisualEditingToolbar canPublishProducts={canPublishProducts} secondFactorPending={secondFactorPending} />;
}

const PRODUCT_PUBLISH_NOTE_ID = "nextblock-visual-product-publish-note";

function VisualEditingToolbar({
  canPublishProducts,
  secondFactorPending,
}: {
  canPublishProducts: boolean;
  secondFactorPending: boolean;
}) {
  const router = useRouter();

  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null);
  const [activeInfo, setActiveInfo] = useState<NextblockVisualEditInfo | null>(null);
  const [activeDocument, setActiveDocument] = useState<ActiveDocument | null>(null);
  const [activeBlock, setActiveBlock] = useState<Block | null>(null);
  const [activeSurfaceContext, setActiveSurfaceContext] = useState<EditorSurfaceContext | null>(null);
  const [activeModalTitle, setActiveModalTitle] = useState<string | undefined>(undefined);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isLoadingBlock, setIsLoadingBlock] = useState(false);
  const [isSavingBlock, setIsSavingBlock] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<BlockEditorSaveStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeInfoRef = useRef<NextblockVisualEditInfo | null>(null);
  const activeDocumentRef = useRef<ActiveDocument | null>(null);
  const latestContentRef = useRef<unknown>(null);
  const lastSavedContentRef = useRef<string>("");
  const lastFailedContentRef = useRef<string>("");
  const isAutosaveInFlightRef = useRef(false);
  const activeAutosavePromiseRef = useRef<Promise<boolean> | null>(null);
  const hasQueuedAutosaveRef = useRef(false);
  const hasSavedSinceOpenRef = useRef(false);
  const skipSaveOnBlurRef = useRef(false);

  useEffect(() => {
    activeInfoRef.current = activeInfo;
  }, [activeInfo]);

  useEffect(() => {
    activeDocumentRef.current = activeDocument;
  }, [activeDocument]);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const performAutosave = useCallback(async (): Promise<boolean> => {
    const info = activeInfoRef.current;
    if (!info) {
      return true;
    }

    clearAutosaveTimer();

    const nextContent = latestContentRef.current;
    const nextSerialized = serializeDraftContent(nextContent);
    if (nextSerialized === lastSavedContentRef.current) {
      setAutosaveStatus("saved");
      return true;
    }

    if (nextSerialized === lastFailedContentRef.current && autosaveStatus === "error") {
      return false;
    }

    if (isAutosaveInFlightRef.current) {
      hasQueuedAutosaveRef.current = true;
      setAutosaveStatus("dirty");
      return activeAutosavePromiseRef.current ?? false;
    }

    const autosaveOperation = (async () => {
      isAutosaveInFlightRef.current = true;
      hasQueuedAutosaveRef.current = false;
      setIsSavingBlock(true);
      setAutosaveStatus("saving");
      setMessage(null);

      try {
        const result = isProductFieldInfo(info)
          ? await saveVisualEditingProductDraftViaApi(
              productFieldRequestFromInfo(info),
              nextContent as Json
            )
          : await saveVisualEditingBlockDraftViaApi(
              blockRequestFromInfo(info),
              nextContent as Json
            );
        const actionError = getActionError(result);

        if (actionError) {
          lastFailedContentRef.current = nextSerialized;
          setAutosaveStatus("error");
          setMessage(actionError);
          return false;
        }
      } catch (error) {
        lastFailedContentRef.current = nextSerialized;
        setAutosaveStatus("error");
        setMessage(error instanceof Error ? error.message : "Failed to save draft.");
        return false;
      } finally {
        isAutosaveInFlightRef.current = false;
        setIsSavingBlock(false);
      }

      lastSavedContentRef.current = nextSerialized;
      lastFailedContentRef.current = "";
      hasSavedSinceOpenRef.current = true;
      setAutosaveStatus("saved");
      setMessage(null);

      if (hasQueuedAutosaveRef.current) {
        hasQueuedAutosaveRef.current = false;
        return performAutosave();
      }

      return true;
    })();

    activeAutosavePromiseRef.current = autosaveOperation;

    try {
      return await autosaveOperation;
    } finally {
      if (activeAutosavePromiseRef.current === autosaveOperation) {
        activeAutosavePromiseRef.current = null;
      }
    }
  }, [autosaveStatus, clearAutosaveTimer]);

  const scheduleAutosave = useCallback(
    (content: unknown) => {
      latestContentRef.current = content;

      const nextSerialized = serializeDraftContent(content);
      if (nextSerialized === lastSavedContentRef.current) {
        clearAutosaveTimer();
        setAutosaveStatus("saved");
        return;
      }

      if (nextSerialized === lastFailedContentRef.current && autosaveStatus === "error") {
        return;
      }

      lastFailedContentRef.current = "";
      setAutosaveStatus("dirty");

      if (isAutosaveInFlightRef.current) {
        hasQueuedAutosaveRef.current = true;
        return;
      }

      clearAutosaveTimer();
      autosaveTimerRef.current = setTimeout(() => {
        void performAutosave();
      }, VISUAL_DRAFT_AUTOSAVE_DELAY_MS);
    },
    [autosaveStatus, clearAutosaveTimer, performAutosave]
  );

  useEffect(() => {
    return () => {
      clearAutosaveTimer();
    };
  }, [clearAutosaveTimer]);

  const openEditor = useCallback(async (
    info: NextblockVisualEditInfo,
    sourceElement?: HTMLElement | null
  ) => {
    const editorElement = sourceElement ?? findElementForInfo(info);
    const document = documentFromInfo(info);
    activeInfoRef.current = info;
    activeDocumentRef.current = document;
    setActiveInfo(info);
    setActiveDocument(document);
    setActiveBlock(null);
    setActiveSurfaceContext(getVisualEditorSurfaceContext(editorElement));
    setActiveModalTitle(
      isProductFieldInfo(info) ? `Edit ${info.data.target.label}` : undefined
    );
    setIsEditorOpen(true);
    setIsLoadingBlock(true);
    clearAutosaveTimer();
    skipSaveOnBlurRef.current = false;
    latestContentRef.current = null;
    lastSavedContentRef.current = "";
    lastFailedContentRef.current = "";
    isAutosaveInFlightRef.current = false;
    activeAutosavePromiseRef.current = null;
    hasQueuedAutosaveRef.current = false;
    hasSavedSinceOpenRef.current = false;
    setAutosaveStatus("idle");
    setMessage(null);

    const result = isProductFieldInfo(info)
      ? await loadVisualEditingProductField(productFieldRequestFromInfo(info))
      : await loadVisualEditingBlockContent(blockRequestFromInfo(info));
    setIsLoadingBlock(false);
    const actionError = getActionError(result);

    if (actionError) {
      setMessage(actionError);
      return;
    }

    const blockType = isProductFieldInfo(info)
      ? "text"
      : (blockRequestFromInfo(info).target.blockType as BlockType);
    const content = "content" in result ? result.content : null;
    latestContentRef.current = content;
    lastSavedContentRef.current = serializeDraftContent(content);
    setActiveBlock({
      type: blockType,
      content,
      productField: isProductFieldInfo(info) ? info.data.target.field : undefined,
    });
  }, [clearAutosaveTimer]);

  const flushAutosaveBeforeClose = useCallback(async () => {
    clearAutosaveTimer();
    if (autosaveStatus === "error") {
      return true;
    }

    const didSave = await performAutosave();

    if (didSave && hasSavedSinceOpenRef.current) {
      hasSavedSinceOpenRef.current = false;
      router.refresh();
    }

    return didSave;
  }, [autosaveStatus, clearAutosaveTimer, performAutosave, router]);

  const startInlineEditing = useCallback(async (
    target: HTMLElement,
    info: NextblockVisualEditInfo
  ) => {
    // Prevent multiple inline edits at the same time
    if (target.contentEditable === "true") {
      return;
    }

    const document = documentFromInfo(info);
    activeInfoRef.current = info;
    activeDocumentRef.current = document;
    setActiveInfo(info);
    setActiveDocument(document);
    clearAutosaveTimer();
    skipSaveOnBlurRef.current = false;
    latestContentRef.current = null;
    lastSavedContentRef.current = "";
    lastFailedContentRef.current = "";
    isAutosaveInFlightRef.current = false;
    activeAutosavePromiseRef.current = null;
    hasQueuedAutosaveRef.current = false;
    hasSavedSinceOpenRef.current = false;
    setAutosaveStatus("idle");
    setMessage(null);

    // Add visual loading state
    target.style.opacity = "0.7";
    const result = isProductFieldInfo(info)
      ? await loadVisualEditingProductField(productFieldRequestFromInfo(info))
      : await loadVisualEditingBlockContent(blockRequestFromInfo(info));
    target.style.opacity = "";

    const actionError = getActionError(result);
    if (actionError) {
      setMessage(actionError);
      return;
    }

    const content = "content" in result ? result.content : null;
    if (!content || typeof content !== "object") {
      return;
    }

    latestContentRef.current = content;
    lastSavedContentRef.current = serializeDraftContent(content);

    const blockType = "blockType" in info.data.target ? info.data.target.blockType : null;

    // Enable contentEditable
    target.contentEditable = "true";
    target.focus();

    // Add visual indicators for active editing
    target.style.outline = "2px solid rgb(37 99 235 / 0.72)";
    target.style.outlineOffset = "4px";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        target.blur();
      }
      if (blockType === "heading" && event.key === "Enter") {
        event.preventDefault();
        target.blur();
      }
    };

    const handleInput = () => {
      const updatedContent = { ...content } as any;
      if (blockType === "heading") {
        updatedContent.text_content = target.innerText;
      } else if (blockType === "text") {
        updatedContent.html_content = target.innerHTML;
      }
      scheduleAutosave(updatedContent);
    };

    const handleBlur = async () => {
      target.contentEditable = "false";
      target.style.outline = "";
      target.style.outlineOffset = "";

      target.removeEventListener("keydown", handleKeyDown);
      target.removeEventListener("input", handleInput);
      target.removeEventListener("blur", handleBlur);

      if (skipSaveOnBlurRef.current) {
        clearAutosaveTimer();
        return;
      }

      // Flush autosave and refresh page
      await flushAutosaveBeforeClose();
    };

    target.addEventListener("keydown", handleKeyDown);
    target.addEventListener("input", handleInput);
    target.addEventListener("blur", handleBlur);
  }, [clearAutosaveTimer, flushAutosaveBeforeClose, scheduleAutosave]);

  useEffect(() => {
    const firstEditable = document.querySelector("[data-vercel-edit-info]");
    const firstInfo = parseEditInfo(firstEditable);
    if (firstInfo) {
      const document = documentFromInfo(firstInfo);
      activeDocumentRef.current = document;
      setActiveDocument(document);
    }

    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-vercel-edit-info]")
        : null;
      const info = parseEditInfo(target);

      if (target instanceof HTMLElement && info) {
        setHoverTarget({
          element: target,
          info,
          rect: target.getBoundingClientRect(),
        });
      }
    };

    const handleEditTargetClick = (event: MouseEvent) => {
      if (isEditorOpen || event.button !== 0) {
        return;
      }

      const target = event.target instanceof Element
        ? event.target.closest("[data-vercel-edit-info]")
        : null;
      const info = parseEditInfo(target);

      if (!(target instanceof HTMLElement) || !info) {
        return;
      }

      const blockType = "blockType" in info.data.target ? info.data.target.blockType : null;
      const canEditInline = (blockType === "text" || blockType === "heading") && !isProductFieldInfo(info);

      if (canEditInline) {
        event.preventDefault();
        event.stopPropagation();
        void startInlineEditing(target, info);
        return;
      }

      // Any other block (custom blocks, images, buttons, etc.): a single click
      // anywhere on the block opens its config editor. The isEditorOpen guard
      // above plus the modal overlay prevent clicks from opening another block.
      event.preventDefault();
      event.stopPropagation();
      void openEditor(info, target);
    };

    const handleToolbarEdit = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            element?: HTMLElement;
            target?: string;
            editInfo?: NextblockVisualEditInfo;
          }
        | undefined;

      const editInfo = detail?.editInfo;
      const isNextblockEditInfo =
        editInfo &&
        typeof editInfo === "object" &&
        editInfo.data &&
        "parentType" in editInfo.data;

      if (
        editInfo?.origin === "nextblock" ||
        editInfo?.origin === "https://nextblock-editor" ||
        editInfo?.origin === "https://nextblock-editor.com" ||
        editInfo?.origin === "https://nextblock.dev" ||
        isNextblockEditInfo
      ) {
        if (editInfo) {
          void openEditor(editInfo, detail?.element);
          return;
        }
      }

      const element =
        detail?.element ??
        (detail?.target ? document.querySelector(detail.target) : null) ??
        document.querySelector("[data-vercel-edit-info]");
      const info = parseEditInfo(element);

      if (info) {
        void openEditor(info, element instanceof HTMLElement ? element : null);
      }
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("click", handleEditTargetClick, true);
    window.addEventListener("edit:open", handleToolbarEdit);
    window.addEventListener("vercel-toolbar:edit", handleToolbarEdit);
    window.addEventListener("vercel-toolbar:visual-edit", handleToolbarEdit);
    window.addEventListener("visual-editing:edit", handleToolbarEdit);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("click", handleEditTargetClick, true);
      window.removeEventListener("edit:open", handleToolbarEdit);
      window.removeEventListener("vercel-toolbar:edit", handleToolbarEdit);
      window.removeEventListener("vercel-toolbar:visual-edit", handleToolbarEdit);
      window.removeEventListener("visual-editing:edit", handleToolbarEdit);
    };
  }, [isEditorOpen, openEditor, startInlineEditing]);

  const overlayPosition = useMemo(() => {
    if (!hoverTarget) {
      return null;
    }

    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const top = Math.max(12, hoverTarget.rect.top + 8);
    const left = Math.min(viewportWidth - 52, Math.max(12, hoverTarget.rect.right - 44));
    return { top, left };
  }, [hoverTarget]);

  const closeVisualEditor = useCallback(() => {
    clearAutosaveTimer();
    activeInfoRef.current = null;
    setIsEditorOpen(false);
    setActiveInfo(null);
    setActiveBlock(null);
    setActiveSurfaceContext(null);
    setActiveModalTitle(undefined);
  }, [clearAutosaveTimer]);

  const flushPendingEditorChanges = useCallback(async () => {
    clearAutosaveTimer();

    if (!activeInfoRef.current) {
      return true;
    }

    if (autosaveStatus === "error") {
      return false;
    }

    return performAutosave();
  }, [autosaveStatus, clearAutosaveTimer, performAutosave]);

  const publishDraft = useCallback(async () => {
    const document = activeDocumentRef.current ?? activeDocument;
    if (!document) {
      return;
    }

    // Only an ADMIN publishes a product draft (the button is disabled for anyone else).
    if (document.parentType === "product" && !canPublishProducts) {
      return;
    }

    const didFlush = await flushPendingEditorChanges();
    if (!didFlush) {
      return;
    }

    setIsPublishing(true);
    setMessage(null);
    const result =
      document.parentType === "product"
        ? await publishVisualEditingProductDraft(String(document.parentId))
        : await publishVisualEditingDraft(
            document.parentType as NextblockDocumentType,
            Number(document.parentId)
          );
    setIsPublishing(false);
    const actionError = getActionError(result);

    if (actionError) {
      setMessage(actionError);
      return;
    }

    // A warning means the content is live but the revision didn't record — still a
    // publish, so the editor closes, but don't report it as a clean one.
    const warning = result && "success" in result ? result.warning : undefined;
    setMessage(warning ?? "Draft published.");
    hasSavedSinceOpenRef.current = false;
    closeVisualEditor();
    router.refresh();
  }, [activeDocument, canPublishProducts, closeVisualEditor, flushPendingEditorChanges, router]);

  const discardDraft = useCallback(async () => {
    const document = activeDocumentRef.current ?? activeDocument;
    if (!document) {
      return;
    }

    skipSaveOnBlurRef.current = true;
    clearAutosaveTimer();
    setIsDiscarding(true);
    setMessage(null);
    const result =
      document.parentType === "product"
        ? await discardVisualEditingProductDraft(String(document.parentId))
        : await discardVisualEditingDraft(
            document.parentType as NextblockDocumentType,
            Number(document.parentId)
          );
    setIsDiscarding(false);
    const actionError = getActionError(result);

    if (actionError) {
      setMessage(actionError);
      return;
    }

    setMessage("Draft discarded.");
    hasSavedSinceOpenRef.current = false;
    closeVisualEditor();
    window.location.reload();
  }, [activeDocument, clearAutosaveTimer, closeVisualEditor]);

  const EditorComponent =
    activeBlock && activeInfo && isProductFieldInfo(activeInfo)
      ? getProductFieldEditorComponent(activeInfo.data.target)
      : activeBlock
        ? getEditorComponent(activeBlock.type)
        : JsonBlockEditor;

  const isProductPublishBlocked = activeDocument?.parentType === "product" && !canPublishProducts;

  const draftActions = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 rounded-full border-amber-500/20 text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 hover:text-amber-900 dark:hover:text-amber-200 px-3.5 text-xs"
        onClick={discardDraft}
        onMouseDown={() => {
          skipSaveOnBlurRef.current = true;
        }}
        disabled={!activeDocument || isPublishing || isDiscarding}
      >
        {isDiscarding ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        )}
        Discard
      </Button>
      <Button
        type="button"
        variant="default"
        size="sm"
        className="h-8 rounded-full bg-amber-600 hover:bg-amber-500 text-white border-0 shadow-md shadow-amber-600/10 px-4 text-xs font-medium"
        onClick={publishDraft}
        disabled={!activeDocument || isProductPublishBlocked || isPublishing || isDiscarding || isSavingBlock}
        aria-describedby={isProductPublishBlocked ? PRODUCT_PUBLISH_NOTE_ID : undefined}
      >
        {isPublishing ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <CloudLightning className="mr-1.5 h-3.5 w-3.5" />
        )}
        Publish
      </Button>
      {isProductPublishBlocked ? (
        <span
          id={PRODUCT_PUBLISH_NOTE_ID}
          className="max-w-[16rem] text-[11px] leading-tight text-muted-foreground"
        >
          {secondFactorPending ? PRODUCT_PUBLISH_SECOND_FACTOR_NOTE : PRODUCT_PUBLISH_ADMIN_ONLY_NOTE}
        </span>
      ) : null}
    </>
  );

  return (
    <>
      <style jsx global>{`
        [data-nextblock-visual-edit] {
          cursor: pointer;
          outline-offset: 3px;
          transition: outline-color 120ms ease, box-shadow 120ms ease;
        }

        [data-nextblock-visual-edit]:hover {
          outline: 2px solid rgb(37 99 235 / 0.72);
        }
      `}</style>

      {!isEditorOpen && overlayPosition && hoverTarget && (
        <button
          type="button"
          aria-label="Edit block"
          title="Edit block"
          className="fixed z-[1000] inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-lg transition hover:bg-muted"
          style={overlayPosition}
          onClick={() => void openEditor(hoverTarget.info, hoverTarget.element)}
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}

      {!isEditorOpen && (
        <div
          data-nextblock-draft-toolbar
          className="fixed bottom-4 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-3.5 rounded-full border border-amber-500/30 bg-background/95 px-4 py-2 text-sm shadow-xl backdrop-blur-md transition-all duration-300 ease-in-out"
        >
          <div className="flex items-center gap-2 px-1">
            <div className="relative flex h-2.5 w-2.5">
              {isLoadingBlock || isSavingBlock ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500 -ml-0.5 -mt-0.5" />
              ) : (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                </>
              )}
            </div>
            <span className="font-semibold text-amber-800 dark:text-amber-300 text-[11px] uppercase tracking-wider select-none min-w-[110px]">
              {isLoadingBlock
                ? "Loading block..."
                : isSavingBlock
                  ? "Saving..."
                  : message
                    ? message
                    : "Unpublished Draft"}
            </span>
          </div>
          <div className="h-4 w-[1px] bg-border" />
          <div className="flex items-center gap-2">
            {draftActions}
          </div>
        </div>
      )}

      {activeBlock && (
        <BlockEditorModal
          block={activeBlock}
          isOpen={isEditorOpen}
          onClose={closeVisualEditor}
          onSave={() => {
            void performAutosave();
          }}
          EditorComponent={EditorComponent}
          editorSurfaceContext={activeSurfaceContext}
          titleOverride={activeModalTitle}
          useContextualSurface={!activeInfo || !isProductFieldInfo(activeInfo)}
          saveMode="autosave"
          saveStatus={autosaveStatus}
          saveStatusText={message && autosaveStatus === "error" ? message : undefined}
          onAutoChange={scheduleAutosave}
          onFlushBeforeClose={flushAutosaveBeforeClose}
        />
      )}
    </>
  );
}
