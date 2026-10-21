"use client";

import React, { useState, lazy } from 'react';
import { cn } from '@nextblock-cms/utils';
import { Button } from '@nextblock-cms/ui';
import { PlusCircle, Trash2, Edit2, GripVertical, Image as ImageIcon } from "lucide-react";
import { SectionBlockContent } from '../../../../lib/blocks/blockRegistry';
import { availableBlockTypes, blockHasEditableContent, getBlockDefinition, getInitialContent, BlockType } from '../../../../lib/blocks/blockRegistry';
import { resolveTextAlign, resolveTextColor } from '../../../../lib/blocks/blockColors';
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BlockEditorModal } from './BlockEditorModal';
import { ConfirmationDialog } from '@nextblock-cms/ui';
import BlockTypeSelector from './BlockTypeSelector';
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import { CustomBlockEditorPreview } from './CustomBlockEditorPreview';
import { sanitizeAuthoredBlockHtml } from '../../../../lib/blocks/inlineScriptNonce';

type ColumnBlock = SectionBlockContent['column_blocks'][0][0];

// Sortable block item component for column blocks
interface SortableColumnBlockProps {
  block: ColumnBlock;
  index: number;
  columnIndex: number;
  onEdit: () => void;
  onDelete: () => void;
  blockType: 'section';
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  sectionBackground?: SectionBlockContent['background'];
}

function SortableColumnBlock({ block, index, columnIndex, onEdit, onDelete, blockType, onClick, sectionBackground }: SortableColumnBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${blockType}-column-${columnIndex}-block-${index}`,
    data: {
      type: 'block',
      blockType,
      columnIndex,
      blockIndex: index,
      block
    }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  // Helper to check for dark background
  const isDarkBackground = React.useMemo(() => {
    if (!sectionBackground) return false;
    
    // Theme checks
    if (sectionBackground.type === 'theme') {
       return ['primary', 'secondary', 'destructive', 'accent', 'dark'].includes(sectionBackground.theme || '');
    }

    // Image & Gradient - Assume Dark (safe default for overlays)
    if (sectionBackground.type === 'image' || sectionBackground.type === 'gradient') {
        return true; 
    }
    
    // Solid Color checks
    if (sectionBackground.type === 'solid' && sectionBackground.solid_color) {
      const str = sectionBackground.solid_color.trim();
      let r = 0, g = 0, b = 0;
      
      if (str.startsWith('#')) {
        const hex = str.replace('#', '');
        if (hex.length === 3) {
          r = parseInt(hex[0] + hex[0], 16);
          g = parseInt(hex[1] + hex[1], 16);
          b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
          r = parseInt(hex.substring(0, 2), 16);
          g = parseInt(hex.substring(2, 4), 16);
          b = parseInt(hex.substring(4, 6), 16);
        } else {
           return ['black', 'navy', 'darkblue', 'darkgray'].includes(str.toLowerCase());
        }
      } else if (str.startsWith('rgb')) {
        const matches = str.match(/\d+/g);
        if (matches && matches.length >= 3) {
          r = parseInt(matches[0]);
          g = parseInt(matches[1]);
          b = parseInt(matches[2]);
        } else {
           return false;
        }
      } else {
        return ['black', 'navy', 'darkblue', 'darkgray'].includes(str.toLowerCase());
      }
      
      // Calculate luminance (YIQ)
      const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
      return yiq < 128; // Strict threshold for white text
    }
    return false;
  }, [sectionBackground]);

  // Helper to render content preview
  const renderContentPreview = () => {
    switch (block.block_type) {
      case 'text': {
        // Basic detection of alignment from HTML content to mirror frontend
        const isCentered = block.content.html_content?.includes('text-align: center') || block.content.html_content?.includes('class="text-center"');
        const isRight = block.content.html_content?.includes('text-align: right') || block.content.html_content?.includes('class="text-right"');
        const alignmentClass = isCentered ? 'text-center' : isRight ? 'text-right' : 'text-left';

        return (
            <div className="flex gap-3">
                <div className={cn("text-xs w-full", alignmentClass)}>
                    {block.content.html_content ? (
                         <div 
                           dangerouslySetInnerHTML={{ __html: sanitizeAuthoredBlockHtml(block.content.html_content) }} 
                           className={cn(
                             "prose prose-xs max-w-none [&>p]:my-0 [&>h1]:my-0 [&>h2]:my-0 [&>h3]:my-0",
                             isDarkBackground ? "prose-invert text-white/90 drop-shadow-sm" : "dark:prose-invert",
                             // Ensure the inner prose content also respects the alignment if not explicitly set on children
                             isCentered && "[&_*]:text-center",
                             isRight && "[&_*]:text-right"
                           )} 
                         />
                    ) : <span className={cn("text-muted-foreground", isDarkBackground && "text-white/50")}>Empty text block</span>}
                </div>
            </div>
        );
      }
      case 'heading': {
         const content = block.content as any;
         const level = content.level || 1;
         const textColor = content.textColor || 'foreground';

         const sizeClasses: Record<number, string> = {
           1: "text-4xl font-extrabold",
           2: "text-3xl font-bold",
           3: "text-2xl font-semibold",
           4: "text-xl font-semibold",
           5: "text-lg font-semibold",
           6: "text-base font-semibold",
         };

         // Shared with HeadingBlockRenderer so the preview cannot drift.
         const { className: resolvedColorClass, style: colorStyle } = resolveTextColor(textColor);
         let appliedColorClass = resolvedColorClass ?? (colorStyle ? undefined : "text-foreground");
         // A custom colour is literal — only the theme tokens get the dark-surface
         // legibility override, since only they are ambiguous against it.
         if (isDarkBackground && !colorStyle) {
            if (textColor === 'foreground') appliedColorClass = 'text-white/90';
            if (textColor === 'muted') appliedColorClass = 'text-white/70';
         }

         return (
            <div className="flex gap-3">
                 <div
                    style={colorStyle}
                    className={cn(
                       "w-full leading-tight",
                       sizeClasses[level] || sizeClasses[1],
                       appliedColorClass,
                       resolveTextAlign(content.textAlign)
                    )}
                 >
                    {content.text_content || <span className={cn("text-muted-foreground font-normal text-sm italic", isDarkBackground && "text-white/50")}>Empty heading</span>}
                 </div>
            </div>
         );
      }
      case 'image': {
        const externalUrl =
          typeof block.content.external_url === 'string' &&
          /^https?:\/\//i.test(block.content.external_url.trim())
            ? block.content.external_url.trim()
            : null;
        const imageUrl = externalUrl || resolveMediaUrl(block.content.object_key) || block.content.src;
        if (!imageUrl) {
          return (
            <div
              className={cn(
                "flex h-20 w-full items-center justify-center gap-2 rounded border border-dashed",
                isDarkBackground ? "border-white/20 text-white/50" : "border-muted-foreground/30 text-muted-foreground"
              )}
            >
              <ImageIcon className="h-5 w-5" />
              <span className="text-[10px]">No image selected</span>
            </div>
          );
        }
        return (
          <figure className="w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={block.content.alt_text || 'Block image'}
              className="h-auto w-full rounded border border-white/10"
            />
            {(block.content.caption || block.content.alt_text) && (
              <figcaption
                className={cn(
                  "mt-1 truncate text-[10px]",
                  isDarkBackground ? "text-white/60" : "text-muted-foreground"
                )}
              >
                {block.content.caption || block.content.alt_text}
              </figcaption>
            )}
          </figure>
        );
      }
      case 'button': {
          const content = block.content as any;
          return (
              <div className={cn("flex gap-3", 
                  content.position === 'center' ? 'justify-center' : 
                  content.position === 'right' ? 'justify-end' : 'justify-start'
              )}>
                  <Button 
                    variant={content.variant || 'default'} 
                    size={content.size || 'default'}
                    className={cn("pointer-events-none", block.content.variant === 'outline' && "text-foreground")}
                    tabIndex={-1}
                  >
                      {content.text || 'Button'}
                  </Button>
              </div>
          );
      }
       case 'video_embed':
           return (
               <div className="flex gap-3 items-center">
                   <div className="text-xs truncate max-w-[200px]">
                       {block.content.title || block.content.url || 'No Video URL'}
                   </div>
               </div>
           );
       case 'posts_grid':
            return (
                <div className="flex gap-3 items-center">
                    <div className={cn("text-xs", isDarkBackground ? "text-white/70" : "text-muted-foreground")}>
                        Posts Grid: {block.content.columns || 3} cols, {block.content.postsPerPage || 12} items
                    </div>
                </div>
            );
       case 'testimonial':
           return (
               <div className="flex flex-col gap-2">
                   <div className={cn("italic text-xs line-clamp-2", isDarkBackground ? "text-white/80" : "text-muted-foreground")}>
                       "{block.content.quote || 'No quote'}"
                   </div>
                   <div className="flex items-center gap-2">
                       {block.content.image_url ? (
                           /* eslint-disable-next-line @next/next/no-img-element */
                           <img src={block.content.image_url} alt={block.content.author_name} className="w-5 h-5 rounded-full object-cover border border-white/10" />
                       ) : (
                           <div className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold border border-white/10", isDarkBackground ? "bg-white/20 text-white" : "bg-muted text-foreground")}>
                               {(block.content.author_name || 'A').charAt(0)}
                           </div>
                       )}
                       <div className="flex flex-col leading-none">
                           <span className={cn("text-[10px] font-semibold", isDarkBackground ? "text-white" : "text-foreground")}>{block.content.author_name || 'Author Name'}</span>
                           {block.content.author_title && <span className={cn("text-[9px]", isDarkBackground ? "text-white/60" : "text-muted-foreground")}>{block.content.author_title}</span>}
                       </div>
                   </div>
               </div>
           );
      default: {
        const formattedLabel = block.block_type
          .split(/[-_]/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        const placeholder = (
          <div className={cn("text-xs flex flex-col gap-0.5", isDarkBackground ? "text-white/70" : "text-muted-foreground")}>
            <span className="font-medium">{formattedLabel}</span>
            <span className="text-[10px] opacity-70">Click edit to configure</span>
          </div>
        );
        // Custom blocks (block_type === definition slug) render their real layout.
        return (
          <CustomBlockEditorPreview
            blockType={block.block_type}
            content={(block.content || {}) as Record<string, any>}
            fallback={placeholder}
          />
        );
      }
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onClick}
     {...attributes}
     {...listeners}
     className={cn(
       "group relative p-3 border border-transparent hover:border-dashed hover:border-primary/50 rounded-lg bg-transparent transition-all",
       "cursor-pointer",
       isDarkBackground ? "text-white border-white/20 hover:border-white/50" : "text-foreground border-transparent"
     )}
   >
      {/* Absolute positioning for actions */}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 p-1 py-2 hover:bg-gray-500 rounded-lg">
          <div className="cursor-grab active:cursor-grabbing p-1">
             <GripVertical className={cn("h-3 w-3", isDarkBackground ? "text-white drop-shadow-md" : "text-foreground/70")} />
          </div>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onEdit(); }} className="h-6 w-6 p-0 hover:bg-transparent" title="Edit block">
            <Edit2 className={cn("h-3 w-3", isDarkBackground ? "text-white drop-shadow-md" : "text-foreground/70")} />
          </Button>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(); }} className="h-6 w-6 p-0 text-red-600 hover:text-red-700 hover:bg-transparent" title="Delete block">
            <Trash2 className="h-3 w-3" />
          </Button>
      </div>

      {/* Live Preview Area - No headers, just content */}
      <div className={cn("min-h-[20px]", isDarkBackground ? "text-white drop-shadow-sm" : "text-foreground")}>
          {renderContentPreview()}
      </div>
    </div>
  );
}

// Column editor component
export interface ColumnEditorProps {
  columnIndex: number;
  blocks: ColumnBlock[];
  onBlocksChange: (newBlocks: ColumnBlock[]) => void;
  blockType: 'section';
  sectionBackground?: SectionBlockContent['background'];
}

type EditingBlock = ColumnBlock & { index: number };

export default function ColumnEditor({ columnIndex, blocks, onBlocksChange, blockType, sectionBackground }: ColumnEditorProps) {
  const [editingBlock, setEditingBlock] = useState<EditingBlock | null>(null);
  const [isBlockSelectorOpen, setIsBlockSelectorOpen] = useState(false);
  const [LazyEditor, setLazyEditor] = useState<React.LazyExoticComponent<React.ComponentType<any>> | React.ComponentType<any> | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [blockToDeleteIndex, setBlockToDeleteIndex] = useState<number | null>(null);

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: `${blockType}-column-droppable-${columnIndex}`,
  });

  // Duplicate isDark logic (should ideally be shared utils but inline to avoid import cycles)
  const isDarkBackground = React.useMemo(() => {
    if (!sectionBackground) return false;
    
    // Theme checks
    if (sectionBackground.type === 'theme') {
       return ['primary', 'secondary', 'destructive', 'accent', 'dark'].includes(sectionBackground.theme || '');
    }

    // Image & Gradient - Assume Dark (safe default for overlays)
    if (sectionBackground.type === 'image' || sectionBackground.type === 'gradient') {
        return true; 
    }
    
    // Solid Color checks
    if (sectionBackground.type === 'solid' && sectionBackground.solid_color) {
      const str = sectionBackground.solid_color.trim();
      let r = 0, g = 0, b = 0;
      
      if (str.startsWith('#')) {
        const hex = str.replace('#', '');
        if (hex.length === 3) {
          r = parseInt(hex[0] + hex[0], 16);
          g = parseInt(hex[1] + hex[1], 16);
          b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
          r = parseInt(hex.substring(0, 2), 16);
          g = parseInt(hex.substring(2, 4), 16);
          b = parseInt(hex.substring(4, 6), 16);
        } else {
           return ['black', 'navy', 'darkblue', 'darkgray'].includes(str.toLowerCase());
        }
      } else if (str.startsWith('rgb')) {
        const matches = str.match(/\d+/g);
        if (matches && matches.length >= 3) {
          r = parseInt(matches[0]);
          g = parseInt(matches[1]);
          b = parseInt(matches[2]);
        } else {
           return false;
        }
      } else {
        return ['black', 'navy', 'darkblue', 'darkgray'].includes(str.toLowerCase());
      }
      
      const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
      return yiq < 128;
    }
    return false;
  }, [sectionBackground]);

  const handleAddBlock = (selectedBlockType: BlockType) => {
    if (!selectedBlockType) return;
    const initialContent = getInitialContent(selectedBlockType);
    const newBlock: ColumnBlock = {
      block_type: selectedBlockType,
      content: (initialContent || {}) as Record<string, any>,
      temp_id: `temp-${Date.now()}-${Math.random()}`
    };
    onBlocksChange([...blocks, newBlock]);
    // Open the new block's editor straight away, matching the top-level editor.
    if (blockHasEditableContent(selectedBlockType)) {
      handleStartEdit(newBlock, blocks.length);
    }
  };

  const handleSelectBlockType = (selectedBlockType: BlockType) => {
    handleAddBlock(selectedBlockType);
    setIsBlockSelectorOpen(false);
  };

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>, block: ColumnBlock, index: number) => {
    if ((e.target as HTMLElement).closest('button')) return;
    handleStartEdit(block, index);
  };

  const handleDeleteBlock = (index: number) => {
    setBlockToDeleteIndex(index);
    setIsConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (blockToDeleteIndex === null) return;
    const newBlocks = blocks.filter((_, i) => i !== blockToDeleteIndex);
    onBlocksChange(newBlocks);
    setIsConfirmOpen(false);
    setBlockToDeleteIndex(null);
  };

  const handleStartEdit = (block: ColumnBlock, index: number) => {
    const blockDef = getBlockDefinition(block.block_type);
    if (!blockDef) {
      const Editor = lazy(() => import(`../editors/DynamicCustomBlockEditor`));
      setLazyEditor(Editor);
      setEditingBlock({ ...block, index });
      return;
    }

    if (blockDef.EditorComponent) {
      const Component = blockDef.EditorComponent;
      setLazyEditor(() => Component);
      setEditingBlock({ ...block, index });
    } else if (blockDef.editorComponentFilename) {
      const filename = blockDef.editorComponentFilename;
      const Editor = lazy(() => import(`../editors/${filename.replace(/\.tsx$/, '')}`));
      setLazyEditor(Editor);
      setEditingBlock({ ...block, index });
    } else {
      console.error(`No editor component found for block type: ${block.block_type}`);
    }
  };

  const handleSave = (newContent: any) => {
    if (editingBlock === null) return;

    const updatedBlocks = [...blocks];
    updatedBlocks[editingBlock.index] = {
      ...updatedBlocks[editingBlock.index],
      content: newContent,
    };
    onBlocksChange(updatedBlocks);
    setEditingBlock(null);
    setLazyEditor(null);
  };

  return (
    <div className={cn(
        "border border-dashed rounded-lg bg-transparent flex flex-col transition-colors",
        isDarkBackground ? "border-white/30" : "border-gray-300 dark:border-gray-700/50"
    )}>
      <div className={cn(
          "p-3 border-b",
          isDarkBackground ? "border-white/20" : "border-gray-200 dark:border-gray-700"
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h4 className={cn(
                "text-sm font-medium",
                isDarkBackground ? "text-white" : "text-gray-700 dark:text-gray-300"
            )}>
              Column {columnIndex + 1}
            </h4>
            <span className={cn(
                "text-xs px-2 py-1 rounded",
                isDarkBackground ? "bg-white/20 text-white" : "text-gray-500 bg-gray-200 dark:bg-gray-700"
            )}>
              {blocks.length}
            </span>
          </div>
        </div>
        <div className="mt-2">
          <Button 
            onClick={() => setIsBlockSelectorOpen(true)} 
            size="sm" 
            variant={isDarkBackground ? "secondary" : "default"}
            className="w-full h-8"
          >
            <PlusCircle className="h-3 w-3 mr-2" />
            Add Block
          </Button>
        </div>
      </div>
      <div className="p-3 flex-grow">
        {blocks.length === 0 ? (
          <div
            ref={setDroppableNodeRef}
            className={`h-full flex items-center justify-center text-xs text-muted-foreground border-2 border-dashed rounded-lg transition-colors p-4 ${
              isOver ? 'border-primary bg-primary/5' : 'border-gray-300 dark:border-gray-600'
            }`}
          >
            Drag block here
          </div>
        ) : (
          <div className="space-y-2">
            {blocks.map((block, index) => (
              <div key={`${blockType}-column-${columnIndex}-block-${index}`}>
                <SortableColumnBlock
                  block={block}
                  index={index}
                  columnIndex={columnIndex}
                  blockType={blockType}
                  onEdit={() => handleStartEdit(block, index)}
                  onDelete={() => handleDeleteBlock(index)}
                  onClick={(e) => handleCardClick(e, block, index)}
                  sectionBackground={sectionBackground}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {editingBlock && LazyEditor && (
        <BlockEditorModal
          isOpen={!!editingBlock}
          onClose={() => {
            setEditingBlock(null);
            setLazyEditor(null);
          }}
          onSave={handleSave}
          block={{
            type: editingBlock.block_type,
            content: editingBlock.content,
          }}
          EditorComponent={LazyEditor}
          // Pass the section background to the modal
          sectionBackground={sectionBackground}
        />
      )}
      <ConfirmationDialog
        isOpen={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
        onConfirm={confirmDelete}
        title="Are you sure?"
        description="This action cannot be undone. This will permanently delete the block."
        confirmText="Delete"
        isDestructive={true}
      />
      <BlockTypeSelector
        isOpen={isBlockSelectorOpen}
        onOpenChange={setIsBlockSelectorOpen}
        onSelectBlockType={handleSelectBlockType}
        allowedBlockTypes={availableBlockTypes.filter(
          (type) => type !== 'section'
        )}
      />
    </div>
  );
}
