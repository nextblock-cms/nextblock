// app/cms/blocks/editors/SectionBlockEditor.tsx
"use client";

import React, { useState, useMemo } from "react";
import ColumnEditor from "../components/ColumnEditor";
import { SectionBlockContent } from '../../../../lib/blocks/blockRegistry';
import { getBlockDefinition } from '../../../../lib/blocks/blockRegistry';
import SectionConfigPanel from "../components/SectionConfigPanel";
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import { sanitizeAuthoredBlockHtml } from '../../../../lib/blocks/inlineScriptNonce';
import { Button, Label } from "@nextblock-cms/ui";
import BackgroundSelector from "../components/BackgroundSelector";



// DND Kit imports for column block reordering
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  defaultDropAnimationSideEffects,
  DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

interface SectionBlockEditorProps {
  content: Partial<SectionBlockContent>;
  onChange: (newContent: SectionBlockContent) => void;
  isConfigPanelOpen: boolean;
  blockType: 'section';
}

function formatMinHeight(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return `${trimmed}px`;
  }
  return trimmed;
}

// Background style generator (Mirrors SectionBlockRenderer logic)
function generateBackgroundStyles(background: SectionBlockContent['background']) {
  const styles: React.CSSProperties = {};
  let className = '';

  switch (background?.type) {
    case 'theme': {
      // Theme-based backgrounds using CSS classes
      const themeClasses: Record<string, string> = {
        primary: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        muted: 'bg-muted text-muted-foreground',
        accent: 'bg-accent text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground'
      };
      className = background.theme ? themeClasses[background.theme] || '' : '';
      break;
    }
    
    case 'solid':
      if (background.solid_color) {
          styles.backgroundColor = background.solid_color;
      }
      break;
    
    case 'gradient':
      if (background.gradient) {
        const { type, direction, stops } = background.gradient;
        const gradientStops = stops.map(stop => `${stop.color} ${stop.position}%`).join(', ');
        styles.background = `${type}-gradient(${direction || 'to right'}, ${gradientStops})`;
      }
      break;
    
    case 'image':
      if (background.image) {
        // Prefer an external stock-photo URL (external_url) before the stored R2
        // object key, so AI-inserted hero backgrounds paint in the editor too.
        const externalBgUrl =
          typeof background.image.external_url === 'string' &&
          /^https?:\/\//i.test(background.image.external_url.trim())
            ? background.image.external_url.trim()
            : null;
        const imageUrl = externalBgUrl || resolveMediaUrl(background.image.object_key);
        if (!imageUrl) {
          break;
        }
        styles.backgroundSize = background.image.size || 'cover';
        styles.backgroundPosition = background.image.position || 'center';

        let finalBackgroundImage = `url(${imageUrl})`;

        if (background.image.overlay && background.image.overlay.gradient) {
          const { type, direction, stops } = background.image.overlay.gradient;
          const gradientStops = stops.map(stop => `${stop.color} ${stop.position}%`).join(', ');
          const gradient = `${type}-gradient(${direction || 'to right'}, ${gradientStops})`;
          finalBackgroundImage = `${gradient}, ${finalBackgroundImage}`;
        }
        
        styles.backgroundImage = finalBackgroundImage;
      }
      break;
    
    default:
      // No background
      break;
  }

  return { styles, className };
}

export default function SectionBlockEditor({
  content,
  onChange,
  isConfigPanelOpen,
  blockType,
}: SectionBlockEditorProps) {

  const [activeSlideIndex, setActiveSlideIndex] = useState(0);

  const processedContent = useMemo((): SectionBlockContent => {
    const defaults: SectionBlockContent = {
      container_type: "container",
      background: { type: "none" },
      responsive_columns: { mobile: 1, tablet: 2, desktop: 3 },
      column_gap: "md",
      padding: { top: "md", bottom: "md" },
      vertical_alignment: "start",
      column_blocks: [],
      is_hero: false,
      slider: false,
      autoplay: false,
      timeframe: 5,
      slides: [],
    };

    const merged = {
      container_type: content.container_type ?? defaults.container_type,
      background: content.background ?? defaults.background,
      responsive_columns:
        content.responsive_columns ?? defaults.responsive_columns,
      column_gap: content.column_gap ?? defaults.column_gap,
      padding: content.padding ?? defaults.padding,
      vertical_alignment: content.vertical_alignment ?? defaults.vertical_alignment,
      column_blocks: content.column_blocks ?? defaults.column_blocks,
      is_hero: content.is_hero ?? defaults.is_hero,
      slider: content.slider ?? defaults.slider,
      autoplay: content.autoplay ?? defaults.autoplay,
      timeframe: content.timeframe ?? defaults.timeframe,
      slides: content.slides ?? defaults.slides,
    };

    // Auto-initialize first slide if slider is true but slides is empty
    if (merged.slider && (!merged.slides || merged.slides.length === 0)) {
      merged.slides = [
        {
          background: merged.background,
          column_blocks: merged.column_blocks,
        }
      ];
    }

    return merged;
  }, [content]);

  // Helper to resize columns
  const resizeColumns = (
    columns: SectionBlockContent['column_blocks'],
    targetCount: number
  ): SectionBlockContent['column_blocks'] => {
    let newColumns = [...columns];
    if (targetCount < newColumns.length) {
      newColumns = newColumns.slice(0, targetCount);
    } else if (targetCount > newColumns.length) {
      const columnsToAdd = targetCount - newColumns.length;
      for (let i = 0; i < columnsToAdd; i++) {
        newColumns.push([{
          block_type: "text",
          content: { html_content: `<p>New Column ${columns.length + i + 1}</p>` },
          temp_id: `new-${Date.now()}-${i}`
        }]);
      }
    }
    return newColumns;
  };

  const handleContentChange = (newPartialContent: Partial<SectionBlockContent>) => {
    const updated = { ...processedContent, ...newPartialContent } as SectionBlockContent;

    // Check if slider mode was toggled
    if (updated.slider && !processedContent.slider) {
      // Toggled ON: initialize slides
      updated.slides = [
        {
          background: updated.background || { type: 'none' },
          column_blocks: updated.column_blocks || []
        }
      ];
    } else if (!updated.slider && processedContent.slider) {
      // Toggled OFF: restore root content from first slide
      const firstSlide = updated.slides?.[0];
      if (firstSlide) {
        updated.background = firstSlide.background;
        updated.column_blocks = firstSlide.column_blocks;
      }
    }

    // Sync columns count with all slides if responsive_columns changed
    const oldDesktop = processedContent.responsive_columns?.desktop;
    const newDesktop = updated.responsive_columns?.desktop;
    if (newDesktop !== undefined && oldDesktop !== newDesktop && updated.slider && updated.slides) {
      updated.slides = updated.slides.map(slide => ({
        ...slide,
        column_blocks: resizeColumns(slide.column_blocks, newDesktop)
      }));
    }

    onChange(updated);
  };

  const activeSlide = useMemo(() => {
    if (processedContent.slider && processedContent.slides && processedContent.slides.length > 0) {
      const idx = activeSlideIndex < processedContent.slides.length ? activeSlideIndex : 0;
      return processedContent.slides[idx];
    }
    return null;
  }, [processedContent, activeSlideIndex]);

  const activeColumnBlocks = useMemo(() => {
    if (activeSlide) {
      return activeSlide.column_blocks;
    }
    return processedContent.column_blocks || [];
  }, [activeSlide, processedContent.column_blocks]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draggedBlock, setDraggedBlock] = useState<any>(null);

  // Generate background styles (based on active slide or root)
  const activeBackground = activeSlide ? activeSlide.background : processedContent.background;
  const { styles: backgroundStyles, className: backgroundClassName } = generateBackgroundStyles(activeBackground);
  
  // DND sensors for cross-column dragging
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleColumnBlocksChange = (
    columnIndex: number,
    newBlocks: SectionBlockContent["column_blocks"][0]
  ) => {
    if (processedContent.slider && processedContent.slides) {
      const newSlides = [...processedContent.slides];
      const slideIdx = activeSlideIndex < newSlides.length ? activeSlideIndex : 0;
      const slideColumnBlocks = [...newSlides[slideIdx].column_blocks];
      slideColumnBlocks[columnIndex] = newBlocks;
      newSlides[slideIdx] = {
        ...newSlides[slideIdx],
        column_blocks: slideColumnBlocks
      };
      handleContentChange({ slides: newSlides });
    } else {
      const newColumns = [...(processedContent.column_blocks || [])];
      newColumns[columnIndex] = newBlocks;
      handleContentChange({ column_blocks: newColumns });
    }
  };

  // Get blocks for a specific column
  const getColumnBlocks = (columnIndex: number) => {
    return activeColumnBlocks[columnIndex] || [];
  };

  // Parse drag item ID to get column and block indices
  const parseDragId = (id: string) => {
    if (!id) return null;
    const blockMatch = id.match(/^(section)-column-(\d+)-block-(\d+)$/);
    if (blockMatch) {
      return {
        type: "block",
        blockType: blockMatch[1],
        columnIndex: parseInt(blockMatch[2], 10),
        blockIndex: parseInt(blockMatch[3], 10),
      };
    }
    const droppableMatch = id.match(/^(section)-column-droppable-(\d+)$/);
    if (droppableMatch) {
      return {
        type: "column",
        blockType: droppableMatch[1],
        columnIndex: parseInt(droppableMatch[2], 10),
      };
    }
    return null;
  };

  // Handle drag start - store the dragged block for overlay
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id.toString());

    const parsed = parseDragId(active.id.toString());
    if (
      parsed &&
      parsed.type === "block" &&
      parsed.columnIndex !== undefined &&
      parsed.blockIndex !== undefined
    ) {
      const block = activeColumnBlocks[parsed.columnIndex]?.[parsed.blockIndex];
      setDraggedBlock(block);
    }
  };

  // Handle drag end - move blocks between columns
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setDraggedBlock(null);

    if (!over || active.id === over.id) {
      return;
    }

    const activeData = parseDragId(active.id.toString());
    const overData = parseDragId(over.id.toString());

    if (!activeData) {
      return;
    }

    const newColumnBlocks = [...activeColumnBlocks];
    const sourceColumnIndex = activeData.columnIndex;
    const sourceBlockIndex = activeData.blockIndex;

    // Guard against invalid source data
    if (sourceColumnIndex === undefined || sourceBlockIndex === undefined)
      return;

    const sourceColumn = newColumnBlocks[sourceColumnIndex];
    if (!sourceColumn) return;

    // Remove the block from the source column
    const [movedBlock] = sourceColumn.splice(sourceBlockIndex, 1);
    if (!movedBlock) return;

    // Determine the target and insert the block
    if (overData?.type === "block") {
      // Scenario 1: Dropped onto another block
      const targetColumnIndex = overData.columnIndex;
      const targetBlockIndex = overData.blockIndex;
      if (
        newColumnBlocks[targetColumnIndex] &&
        targetBlockIndex !== undefined
      ) {
        newColumnBlocks[targetColumnIndex].splice(
          targetBlockIndex,
          0,
          movedBlock
        );
      }
    } else if (overData?.type === "column") {
      // Scenario 2: Dropped on an empty column's droppable area
      const targetColumnIndex = overData.columnIndex;
      if (newColumnBlocks[targetColumnIndex]) {
        newColumnBlocks[targetColumnIndex].push(movedBlock);
      }
    } else {
      // Scenario 3: Invalid drop, return block to original position
      sourceColumn.splice(sourceBlockIndex, 0, movedBlock);
      return; // Exit without calling onChange
    }

    // Final state update
    if (processedContent.slider && processedContent.slides) {
      const newSlides = [...processedContent.slides];
      const slideIdx = activeSlideIndex < newSlides.length ? activeSlideIndex : 0;
      newSlides[slideIdx] = {
        ...newSlides[slideIdx],
        column_blocks: newColumnBlocks
      };
      handleContentChange({ slides: newSlides });
    } else {
      handleContentChange({ column_blocks: newColumnBlocks });
    }
  };

  // Custom drop animation for better visual feedback
  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: "0.5",
        },
      },
    }),
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-6 p-4 border-t mt-2">
        {isConfigPanelOpen && (
          <SectionConfigPanel
            content={processedContent}
            onChange={handleContentChange}
          />
        )}

        {/* Slide navigation & background settings if slider mode is active */}
        {processedContent.slider && (
          <div className="space-y-4 p-4 bg-gray-50 dark:bg-gray-800/40 rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="flex flex-wrap items-center gap-2 justify-between border-b pb-3 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-2">
                {(processedContent.slides || []).map((_, index) => (
                  <div key={index} className="flex items-center gap-1 group">
                    <Button
                      variant={activeSlideIndex === index ? "default" : "outline"}
                      size="sm"
                      onClick={() => setActiveSlideIndex(index)}
                      className="font-medium"
                    >
                      Slide {index + 1}
                    </Button>
                    {(processedContent.slides || []).length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          const newSlides = (processedContent.slides || []).filter((_, i) => i !== index);
                          let nextIdx = activeSlideIndex;
                          if (activeSlideIndex >= newSlides.length) {
                            nextIdx = Math.max(0, newSlides.length - 1);
                          }
                          setActiveSlideIndex(nextIdx);
                          handleContentChange({ slides: newSlides });
                        }}
                        className="px-1.5 h-8 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        &times;
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const columnsCount = processedContent.responsive_columns?.desktop || 3;
                    const newSlide = {
                      background: { type: 'none' as const },
                      column_blocks: Array.from({ length: columnsCount }, () => []),
                    };
                    const newSlides = [...(processedContent.slides || []), newSlide];
                    handleContentChange({ slides: newSlides });
                    setActiveSlideIndex(newSlides.length - 1);
                  }}
                  className="border-dashed border-primary/40 text-primary hover:bg-primary/5"
                >
                  + Add Slide
                </Button>
              </div>
            </div>

            {/* Slide Background Editor */}
            {activeSlide && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Slide {activeSlideIndex + 1} Background
                </Label>
                <BackgroundSelector
                  background={activeSlide.background || { type: "none" }}
                  onChange={(newBackground) => {
                    const newSlides = [...(processedContent.slides || [])];
                    if (newSlides[activeSlideIndex]) {
                      newSlides[activeSlideIndex] = {
                        ...newSlides[activeSlideIndex],
                        background: newBackground,
                      };
                      handleContentChange({ slides: newSlides });
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Column Content Management */}
        <SortableContext
          items={activeColumnBlocks
            .flatMap((columnBlocks, columnIndex) =>
              columnBlocks.map(
                (_, blockIndex) =>
                  `${blockType}-column-${columnIndex}-block-${blockIndex}`
              )
            )
            .concat(
              Array.from(
                { length: activeColumnBlocks.length },
                (_, i) => `${blockType}-column-droppable-${i}`
              )
            )}
          strategy={verticalListSortingStrategy}
        >
          <div
            className={`grid gap-4 rounded-lg border transition-colors ${backgroundClassName} ${
               activeColumnBlocks.length === 1
                 ? "grid-cols-1"
                 : `grid-cols-${processedContent.responsive_columns.mobile} md:grid-cols-${processedContent.responsive_columns.tablet} lg:grid-cols-${processedContent.responsive_columns.desktop}`
            }`}
            style={{
              ...backgroundStyles,
              minHeight: formatMinHeight(activeBackground?.min_height) || '200px'
            }}
          >
            {Array.from({ length: activeColumnBlocks.length }, (_, columnIndex) => (
              <ColumnEditor
                key={`${blockType}-column-${columnIndex}`}
                columnIndex={columnIndex}
                blocks={getColumnBlocks(columnIndex)}
                onBlocksChange={(newBlocks) =>
                  handleColumnBlocksChange(columnIndex, newBlocks)
                }
                blockType={blockType}
                sectionBackground={activeSlide ? activeSlide.background : processedContent.background}
              />
            ))}
          </div>
        </SortableContext>

        {/* Drag overlay for visual feedback during cross-column dragging */}
        <DragOverlay dropAnimation={dropAnimation}>
          {activeId && draggedBlock ? (
            <div className="p-2 border border-blue-300 dark:border-blue-600 rounded bg-blue-50 dark:bg-blue-900/50 shadow-lg opacity-90">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-blue-700 dark:text-blue-300 capitalize">
                  {getBlockDefinition(draggedBlock.block_type)?.label ||
                    draggedBlock.block_type}
                </span>
              </div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                {draggedBlock.block_type === "text" && (
                  <div
                    dangerouslySetInnerHTML={{
                      // Block HTML is WRITER-authored: sanitized like every other render of it,
                      // then cut. The cut only shortens safe markup, and a tag it leaves open is
                      // dropped by the parser (this overlay only renders in the browser, mid-drag).
                      __html:
                        sanitizeAuthoredBlockHtml(
                          draggedBlock.content.html_content || "Empty text"
                        ).substring(0, 30) + "...",
                    }}
                  />
                )}
                {draggedBlock.block_type === "heading" && (
                  <div>
                    H{draggedBlock.content.level || 1}:{" "}
                    {(
                      draggedBlock.content.text_content || "Empty heading"
                    ).substring(0, 20) + "..."}
                  </div>
                )}
                {draggedBlock.block_type === "image" && (
                  <div>
                    Image: {draggedBlock.content.alt_text || "No alt text"}
                  </div>
                )}
                {draggedBlock.block_type === "button" && (
                  <div>Button: {draggedBlock.content.text || "No text"}</div>
                )}
                {draggedBlock.block_type === "video_embed" && (
                  <div>Video: {draggedBlock.content.title || "No title"}</div>
                )}
                {draggedBlock.block_type === "posts_grid" && (
                  <div>
                    Posts Grid: {draggedBlock.content.columns || 3} cols
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
