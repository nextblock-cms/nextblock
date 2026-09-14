import { useState, useEffect, type ComponentType, Suspense, LazyExoticComponent, useCallback, type CSSProperties } from "react";
import { cn } from "@nextblock-cms/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogDescription,
} from "@nextblock-cms/ui";
import { Button } from "@nextblock-cms/ui";
import { blockRegistry, BlockType } from '../../../../lib/blocks/blockRegistry';

// A generic representation of a block object.
// The modal primarily needs `type` to get the label and `content` for editing.
export type Block<T = unknown> = {
  // A built-in block type, or a custom block definition slug (custom instances are
  // edited through this modal too; they have no registry entry, so `blockInfo` is
  // optional below).
  type: BlockType | string;
  content: T;
  [key: string]: unknown; // Allow other properties from the DB
};

// Props that every block editor component must accept.
export type BlockEditorProps<T = unknown> = {
  block: Block<T>;
  content: T;
  onChange: (newContent: T) => void;
  className?: string; // Added for editor component styling
  sectionBackground?: import("@/lib/blocks/blockRegistry").SectionBlockContent['background'];
};

export type EditorSurfaceContext = {
  isDark: boolean;
  style: CSSProperties;
};

export type BlockEditorSaveMode = "manual" | "autosave";
export type BlockEditorSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

type BlockEditorModalProps = {
  block: Block;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updatedContent: unknown) => void;
  EditorComponent: LazyExoticComponent<ComponentType<BlockEditorProps<unknown>>> | ComponentType<BlockEditorProps<unknown>>;
  sectionBackground?: import("@/lib/blocks/blockRegistry").SectionBlockContent['background'];
  editorSurfaceContext?: EditorSurfaceContext | null;
  titleOverride?: string;
  useContextualSurface?: boolean;
  saveMode?: BlockEditorSaveMode;
  saveStatus?: BlockEditorSaveStatus;
  saveStatusText?: string;
  onAutoChange?: (content: unknown) => void;
  onFlushBeforeClose?: () => Promise<boolean>;
};

const autosaveStatusLabels: Record<BlockEditorSaveStatus, string> = {
  idle: "Saved",
  dirty: "Unsaved",
  saving: "Saving...",
  saved: "Saved",
  error: "Save failed",
};

export function BlockEditorModal({
  block,
  isOpen,
  onClose,
  onSave,
  EditorComponent,
  sectionBackground,
  editorSurfaceContext,
  titleOverride,
  useContextualSurface,
  saveMode = "manual",
  saveStatus = "idle",
  saveStatusText,
  onAutoChange,
  onFlushBeforeClose,
}: BlockEditorModalProps) {
  const [tempContent, setTempContent] = useState(block.content);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  const [isFlushingBeforeClose, setIsFlushingBeforeClose] = useState(false);
  const isValid = true; // Placeholder for future validation logic
  const isAutosaveMode = saveMode === "autosave";
  const [saveShortcutLabel, setSaveShortcutLabel] = useState("CMD+S");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isMac = navigator.userAgent.indexOf("Mac") !== -1;
      setSaveShortcutLabel(isMac ? "CMD+S" : "Ctrl+S");
    }
  }, []);

  useEffect(() => {
    // When the modal is opened with a new block, reset the temp content
    if (isOpen) {
      setTempContent(block.content);
      setShowConfirmClose(false);
      setIsFlushingBeforeClose(false);
    }
  }, [isOpen, block.content]);

  const handleSave = useCallback(() => {
    onSave(tempContent);
  }, [onSave, tempContent]);

  const hasUnsavedChanges = useCallback(() => {
    return JSON.stringify(block.content) !== JSON.stringify(tempContent);
  }, [block.content, tempContent]);

  const flushAutosave = useCallback(async () => {
    if (!onFlushBeforeClose) {
      return true;
    }

    setIsFlushingBeforeClose(true);
    try {
      return await onFlushBeforeClose();
    } finally {
      setIsFlushingBeforeClose(false);
    }
  }, [onFlushBeforeClose]);

  const handleCloseAttempt = useCallback(() => {
    if (isAutosaveMode) {
      void (async () => {
        const didFlush = await flushAutosave();
        if (didFlush) {
          onClose();
        }
      })();
      return;
    }

    if (hasUnsavedChanges()) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  }, [flushAutosave, hasUnsavedChanges, isAutosaveMode, onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      if (isAutosaveMode) {
        handleCloseAttempt();
      } else {
        handleSave();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleCloseAttempt, handleSave, isAutosaveMode, isOpen]);

  const handleContentChange = (newContent: unknown) => {
    setTempContent(newContent);
    if (isAutosaveMode) {
      onAutoChange?.(newContent);
    }
    // Potentially add validation here and set isValid
  };

  const blockInfo = blockRegistry[block.type as BlockType] as (typeof blockRegistry)[BlockType] | undefined;
  const displayText = blockInfo?.label || "Block";
  const shouldUseContextualSurface =
    (useContextualSurface ?? true) && block.type === 'text';
  const contextualSurfaceStyle = shouldUseContextualSurface ? editorSurfaceContext?.style : undefined;
  const editorClassName = cn(
    "bg-transparent text-foreground border-none shadow-none focus-within:ring-0 min-h-[60vh]",
    shouldUseContextualSurface &&
      editorSurfaceContext?.isDark &&
      "[&_.ProseMirror]:text-white [&_.ProseMirror.prose]:prose-invert"
  );
  const resolvedSaveStatusText = saveStatusText ?? autosaveStatusLabels[saveStatus];

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => {
        if (!open) {
          handleCloseAttempt();
        }
      }}>
        <DialogContent 
          className="max-w-6xl h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
          onInteractOutside={(e) => {
            e.preventDefault();
            handleCloseAttempt();
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            handleCloseAttempt();
          }}
        >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b bg-background/95 text-foreground backdrop-blur z-10">
                <div className="flex items-center gap-2">
                   <DialogTitle className="text-lg font-semibold">
                    {titleOverride ?? `Edit ${displayText}`}
                   </DialogTitle>
                </div>
                 <div className="flex items-center gap-2">
                    {isAutosaveMode && (
                      <span
                        aria-live="polite"
                        className={cn(
                          "rounded-md px-2 py-1 text-xs font-medium",
                          saveStatus === "error"
                            ? "bg-destructive/10 text-destructive"
                            : saveStatus === "dirty"
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "bg-muted text-muted-foreground",
                          "max-w-[360px] truncate"
                        )}
                        title={resolvedSaveStatusText}
                      >
                        {resolvedSaveStatusText}
                      </span>
                    )}
                    <Button
                      variant={isAutosaveMode ? "default" : "ghost"}
                      size="sm"
                      onClick={handleCloseAttempt}
                      disabled={isAutosaveMode && isFlushingBeforeClose}
                    >
                      {isAutosaveMode ? "Done" : "Cancel"}
                    </Button>
                    {!isAutosaveMode && (
                      <Button onClick={handleSave} disabled={!isValid} size="sm">
                        Save ({saveShortcutLabel})
                      </Button>
                    )}
                 </div>
            </div>

            {/* Editor Area with Contextual Background */}
            <div 
              onClick={(e) => e.stopPropagation()}
              className={cn(
                  "flex-1 overflow-y-auto p-6",
                  // Conditional Background Logic:
                  // Only apply specific section background to 'text' and 'heading' blocks to allow "Live Preview" of copy.
                  // For complex blocks like Forms, Buttons, etc., keep a neutral background to ensure input field contrast.
                  shouldUseContextualSurface ? (
                     // If no specific background, use white/dark default
                     (!sectionBackground || sectionBackground.type === 'none') && "bg-muted/10"
                  ) : "bg-muted/10", // Default for non-text blocks

                  // Apply theme classes if present (ONLY for text/heading)
                  shouldUseContextualSurface && sectionBackground?.type === 'theme' && sectionBackground.theme === 'primary' && 'bg-primary text-primary-foreground',
                  shouldUseContextualSurface && sectionBackground?.type === 'theme' && sectionBackground.theme === 'secondary' && 'bg-secondary text-secondary-foreground',
                  shouldUseContextualSurface && sectionBackground?.type === 'theme' && sectionBackground.theme === 'muted' && 'bg-muted text-muted-foreground',
                  
                   // Dark mode prose invert if dark background (approximate check for solid color)
                  shouldUseContextualSurface && (sectionBackground?.type === 'solid' && sectionBackground.solid_color && ['#000', '#111', '#0f172a', 'black'].some(c => sectionBackground.solid_color?.includes(c))) && "[&_.prose]:prose-invert",
                  shouldUseContextualSurface && editorSurfaceContext?.isDark && "[&_.prose]:prose-invert [&_.ProseMirror]:text-white"
              )}
              style={{
                  // Only apply custom color/gradient styles for text/heading
                  backgroundColor: shouldUseContextualSurface && sectionBackground?.type === 'solid' ? sectionBackground.solid_color : undefined,
                  backgroundImage: shouldUseContextualSurface && sectionBackground?.type === 'gradient' && sectionBackground.gradient ? 
                    `${sectionBackground.gradient.type}-gradient(${sectionBackground.gradient.direction}, ${sectionBackground.gradient.stops.map(s => `${s.color} ${s.position}%`).join(', ')})` 
                    : undefined,
                  ...contextualSurfaceStyle,
              }}
            >
               <div className="max-w-6xl mx-auto">
                  <Suspense fallback={<div className="flex justify-center items-center h-32">Loading editor...</div>}>
                    <EditorComponent 
                        block={block}
                        content={tempContent} 
                        onChange={handleContentChange} 
                        className={editorClassName}
                        sectionBackground={sectionBackground} // Pass down if editor supports it
                    />
                  </Suspense>
               </div>
            </div>
            
        </DialogContent>
      </Dialog>

      <Dialog open={showConfirmClose} onOpenChange={setShowConfirmClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Save Changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Do you want to save them before closing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setShowConfirmClose(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => {
              setShowConfirmClose(false);
              onClose();
            }}>
              Discard
            </Button>
             <Button onClick={() => {
              setShowConfirmClose(false);
              handleSave();
            }}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
