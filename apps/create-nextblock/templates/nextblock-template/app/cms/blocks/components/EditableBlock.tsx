// app/cms/blocks/components/EditableBlock.tsx
"use client";

import React, { useState, useEffect, useRef, Suspense, useMemo, lazy, LazyExoticComponent, ComponentType } from 'react';
import type { Database } from "@nextblock-cms/db";
import PostsGridBlockEditor from '../editors/PostsGridBlockEditor';

type Block = Database['public']['Tables']['blocks']['Row'];
import { Button, Card, CardContent, Avatar, AvatarImage, AvatarFallback } from "@nextblock-cms/ui";
import { GripVertical, Edit2, Image as ImageIcon, MessageSquareQuote } from "lucide-react";
import { blockHasEditableContent, getBlockDefinition, blockRegistry, BlockType } from '../../../../lib/blocks/blockRegistry';
import { resolveTextAlign, resolveTextColor } from '../../../../lib/blocks/blockColors';
import { BlockEditorModal } from './BlockEditorModal';
import { DeleteBlockButtonClient } from './DeleteBlockButtonClient';
import { cn } from '@nextblock-cms/utils';
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import { SimpleTiptapRenderer } from '@nextblock-cms/ecommerce';
import { CustomBlockEditorPreview } from './CustomBlockEditorPreview';
import { sanitizeAuthoredBlockHtml } from '../../../../lib/blocks/inlineScriptNonce';

export interface EditableBlockProps {
  block: Block;
  onDelete: (blockId: number) => void;
  onContentChange: (blockId: number, newContent: Record<string, any>) => void;
  dragHandleProps?: Record<string, any>;
  onEditNestedBlock?: (parentBlockId: string, columnIndex: number, blockIndexInColumn: number) => void;
  className?: string;
  /** Open this block's editor as soon as it mounts — set for a just-added block. */
  autoOpenEditor?: boolean;
  /** Called once the auto-open has fired, so the parent can clear the flag. */
  onAutoOpenHandled?: () => void;
}

export default function EditableBlock({
  block,
  onDelete,
  onContentChange,
  dragHandleProps,
  onEditNestedBlock,
  className,
  autoOpenEditor,
  onAutoOpenHandled,
}: EditableBlockProps) {
  void onEditNestedBlock;
  // Move all hooks to the top before any conditional returns
  const [isConfigPanelOpen, setIsConfigPanelOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<Block | null>(null);
  const [LazyEditor, setLazyEditor] = useState<LazyExoticComponent<ComponentType<any>> | ComponentType<any> | null>(null);
  const autoOpenedRef = useRef<number | null>(null);

  const SectionEditor = useMemo(() => {
    if (block?.block_type === 'section') {
      const editorFilename = blockRegistry[block.block_type as BlockType]?.editorComponentFilename;
      if (editorFilename) {
        return lazy(() => import(`../editors/${editorFilename}`));
      }
    }
    return null;
  }, [block?.block_type]);

  const handleEditClick = () => {
    // cart / checkout / product_details are context-driven: empty schema, and the
    // editor file their registry entry names does not exist. Opening one throws.
    if (!blockHasEditableContent(block.block_type)) {
      return;
    }
    if (block.block_type === 'section') {
      setIsConfigPanelOpen(prev => !prev);
    } else {
      const blockDef = getBlockDefinition(block.block_type as BlockType);
      
      if (block.block_type === 'posts_grid') {
        const LazifiedPostsGridEditor = lazy(() => Promise.resolve({ default: PostsGridBlockEditor }));
        setLazyEditor(LazifiedPostsGridEditor);
        setEditingBlock(block);
      }
      else if (blockDef?.EditorComponent) {
        const Component = blockDef.EditorComponent;
        setLazyEditor(() => Component);
        setEditingBlock(block);
      }
      else if (blockDef?.editorComponentFilename) {
        const filename = blockDef.editorComponentFilename;
        const Editor = lazy(() => import(`../editors/${filename.replace(/\.tsx$/, '')}`));
        setLazyEditor(Editor);
        setEditingBlock(block);
      }
      else {
        const Editor = lazy(() => import(`../editors/DynamicCustomBlockEditor`));
        setLazyEditor(Editor);
        setEditingBlock(block);
      }
    }
  };

  // A block the author just added opens straight into its editor — adding a
  // heading is always followed by wanting to type one. The ref keeps it to once
  // per block, so closing the editor (or a router refresh) does not reopen it.
  useEffect(() => {
    if (!autoOpenEditor || !block || autoOpenedRef.current === block.id) return;
    autoOpenedRef.current = block.id;
    handleEditClick();
    onAutoOpenHandled?.();
  }, [autoOpenEditor, block, handleEditClick, onAutoOpenHandled]);

  // Add a guard for undefined block prop after hooks
  if (!block) {
    // Or some other placeholder/error display
    return <div className="p-4 border rounded-lg bg-card shadow text-red-500">Error: Block data is missing in EditableBlock.</div>;
  }

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // If the element that was clicked, or any of its parents up to the card, is a button,
    // then we should ignore the click on the card. This lets the button's own onClick handle the event.
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }

    // If the click was on the card's background (not a button), and it's an editable block type,
    // then trigger the edit handler.
    if (block.block_type !== 'section') {
      handleEditClick();
    }
  };

  const renderPreview = () => {
    // Safe access to block_type for preview
    const currentBlockType = block && block.block_type;
    if (!currentBlockType) {
      return <div className="text-red-500">Error: Block type missing for preview.</div>;
    }

    switch (currentBlockType) {
       case 'text': {
         const content = (block.content || {}) as any;
         const htmlContent = String(content.html_content || '');
         const isCentered = htmlContent.includes('text-align: center') || htmlContent.includes('class="text-center"');
         const isRight = htmlContent.includes('text-align: right') || htmlContent.includes('class="text-right"');
         const alignmentClass = isCentered ? 'text-center' : isRight ? 'text-right' : 'text-left';
         const isJson = htmlContent.trim().startsWith('{') || htmlContent.trim().startsWith('[');

         return (
             <div className="py-2">
                 <div className={cn("text-xs w-full", alignmentClass)}>
                     {htmlContent ? (
                       isJson ? (
                         <SimpleTiptapRenderer content={htmlContent} className="prose prose-sm max-w-none [&>p]:my-0 [&>h1]:my-0 [&>h2]:my-0 [&>h3]:my-0 dark:prose-invert" />
                       ) : (
                         <div 
                           dangerouslySetInnerHTML={{ __html: sanitizeAuthoredBlockHtml(htmlContent) }} 
                           className={cn(
                             "prose prose-sm max-w-none [&>p]:my-0 [&>h1]:my-0 [&>h2]:my-0 [&>h3]:my-0 dark:prose-invert",
                             isCentered && "[&_*]:text-center",
                             isRight && "[&_*]:text-right"
                           )} 
                         />
                       )
                     ) : <span className="text-muted-foreground italic">Empty text block</span>}
                 </div>
             </div>
         );
       }
       case 'heading': {
          const content = (block.content || {}) as any;
          const level = content.level || 1;

          const sizeClasses: Record<number, string> = {
            1: "text-4xl font-extrabold",
            2: "text-3xl font-bold",
            3: "text-2xl font-semibold",
            4: "text-xl font-semibold",
            5: "text-lg font-semibold",
            6: "text-base font-semibold",
          };

          // Shared with HeadingBlockRenderer so the preview cannot drift.
          const { className: colorClass, style: colorStyle } = resolveTextColor(content.textColor);

          return (
             <div className="py-2">
                  <div
                     style={colorStyle}
                     className={cn(
                        "w-full leading-tight",
                        sizeClasses[level] || sizeClasses[1],
                        colorClass ?? (colorStyle ? undefined : "text-foreground"),
                        resolveTextAlign(content.textAlign)
                     )}
                  >
                     {content.text_content || <span className="text-muted-foreground italic text-sm font-normal">Empty heading</span>}
                  </div>
             </div>
          );
       }
       case 'image': {
         const content = (block.content || {}) as any;
         const externalUrl =
           typeof content.external_url === 'string' && /^https?:\/\//i.test(content.external_url.trim())
             ? content.external_url.trim()
             : null;
         const imageUrl = externalUrl || resolveMediaUrl(content.object_key) || content.src;
         if (!imageUrl) {
           return (
             <div className="flex h-28 w-full items-center justify-center gap-2 rounded border border-dashed py-2 text-muted-foreground">
               <ImageIcon className="h-6 w-6" />
               <span className="text-sm">No image selected</span>
             </div>
           );
         }
         return (
           <figure className="w-full py-1">
             {/* eslint-disable-next-line @next/next/no-img-element */}
             <img
               src={imageUrl}
               alt={content.alt_text || 'Block image'}
               className="h-auto w-full rounded border"
             />
             {(content.caption || content.alt_text) && (
               <figcaption className="mt-1 truncate text-xs text-muted-foreground">
                 {content.caption || content.alt_text}
               </figcaption>
             )}
           </figure>
         );
       }
       case 'button': {
           const content = (block.content || {}) as any;
           return (
               <div className={cn("py-2 flex", 
                   content.position === 'center' ? 'justify-center' : 
                   content.position === 'right' ? 'justify-end' : 'justify-start'
               )}>
                   <Button 
                     variant={content.variant || 'default'} 
                     size={content.size || 'default'}
                     className={cn("pointer-events-none", content.variant === 'outline' && "text-foreground")}
                     tabIndex={-1}
                   >
                       {content.text || 'Button'}
                   </Button>
               </div>
           );
       }
       case 'video_embed': {
            const content = (block.content || {}) as any;
            return (
                <div className="py-2">
                    <div className="text-sm text-muted-foreground truncate">
                        📹 {content.title || content.url || 'No Video configured'}
                    </div>
                </div>
            );
       }
       case 'posts_grid': {
             const content = (block.content || {}) as any;
             return (
                 <div className="py-2">
                     <div className="text-sm text-muted-foreground">
                         Posts Grid: {content.columns || 3} cols, {content.postsPerPage || 12} items
                     </div>
                 </div>
             );
       }
       case 'testimonial': {
            const content = (block.content || {}) as any;
            return (
                <div className="py-2">
                    <Card className="h-full border-none shadow-none bg-transparent">
                      <CardContent className="pt-2 flex flex-col gap-4 h-full p-4">
                        <MessageSquareQuote className="w-8 h-8 text-primary/40" />
                        
                        <blockquote className="flex-grow text-lg italic text-muted-foreground leading-relaxed">
                          "{content.quote || 'No quote provided'}"
                        </blockquote>

                        <div className="flex items-center gap-3 mt-2">
                          <Avatar>
                            {content.image_url && <AvatarImage src={content.image_url} alt={content.author_name} />}
                            <AvatarFallback>{(content.author_name || 'A').slice(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          
                          <div>
                            <div className="font-semibold">{content.author_name || 'Author Name'}</div>
                            {content.author_title && (
                              <div className="text-sm text-muted-foreground">{content.author_title}</div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                </div>
            );
       }
       default: {
        const blockDefinition = getBlockDefinition(currentBlockType as BlockType);
        const blockLabel = blockDefinition?.label || currentBlockType;
        const hasEditableContent = blockHasEditableContent(currentBlockType);
        const placeholder = (
          <div
            className={cn(
              "py-4 flex flex-col items-center justify-center space-y-2 min-h-[80px] border border-dashed rounded-md bg-muted/20",
              hasEditableContent && "cursor-pointer hover:border-primary"
            )}
            onClick={handleCardClick}
          >
            <div className="text-center">
              <p className="text-sm font-medium text-muted-foreground">{blockLabel}</p>
              <p className="text-xs text-muted-foreground">
                {hasEditableContent
                  ? 'Click edit to modify content'
                  : 'Renders from the current page context — nothing to configure'}
              </p>
            </div>
          </div>
        );
        // Custom blocks (block_type === definition slug) render their real layout.
        return (
          <CustomBlockEditorPreview
            blockType={currentBlockType}
            content={(block.content || {}) as Record<string, any>}
            fallback={placeholder}
          />
        );
       }
    }
  };

  const isSection = block?.block_type === 'section';
  const blockDefinition = getBlockDefinition(block.block_type as BlockType);
  const isEditable = blockHasEditableContent(block.block_type);

  return (
    <div
      onClick={handleCardClick}
      className={cn(
        "p-4 border rounded-lg bg-card shadow",
        !isSection && isEditable && "cursor-pointer hover:border-primary transition-colors",
        className
      )}
    >
      <div className="flex justify-between items-center mb-2 pb-2 border-b">
        <div className="flex items-center gap-2">
          <button {...dragHandleProps} className="p-1 rounded-md hover:bg-muted cursor-grab" aria-label="Drag to reorder">
            <GripVertical className="h-5 w-5" />
          </button>
          <h4 className="font-semibold p-0 m-0 mb-1">{blockDefinition?.label || block.block_type}</h4>
        </div>
        <div className="flex items-center gap-1">
            {isEditable && (
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditClick();
                }}
                aria-label={isSection ? "Toggle Section Config" : "Edit block"}
              >
                <Edit2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            )}
          <DeleteBlockButtonClient
            blockId={block.id}
            blockTitle={blockDefinition?.label || block.block_type}
            onDelete={() => onDelete(block.id)}
          />
        </div>
      </div>
      {isSection ? (
        <div className="mt-2 min-h-[200px]">
          <Suspense fallback={<div className="flex justify-center items-center h-full"><p>Loading Editor...</p></div>}>
            {SectionEditor && <SectionEditor block={block} content={block.content || {}} onChange={(newContent: Record<string, any>) => onContentChange(block.id, newContent)} blockType={block.block_type as 'section'} isConfigPanelOpen={isConfigPanelOpen} />}
          </Suspense>
        </div>
      ) : renderPreview()}

      {editingBlock && LazyEditor && (
        <BlockEditorModal
          isOpen={!!editingBlock}
          block={{...editingBlock, type: editingBlock.block_type as BlockType}}
          EditorComponent={LazyEditor}
          onClose={() => {
            setEditingBlock(null);
            setLazyEditor(null);
          }}
          onSave={(newContent: any) => {
            onContentChange(block.id, newContent);
            setEditingBlock(null);
            setLazyEditor(null);
          }}
        />
      )}
    </div>
  );
}
